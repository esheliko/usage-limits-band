import type { EngineInterface, Register } from 'claude-code'

import type { AttentionKind, AttentionSession, Limit } from '../types'

const limits = { plugin: 'usage-limits-band', key: 'limits' } as const
const now = { plugin: 'usage-limits-band', key: 'now' } as const
const sessions = { plugin: 'usage-limits-band', key: 'sessions' } as const
const isSessionsOpen = { plugin: 'usage-limits-band', key: 'isSessionsOpen' } as const
const lastReplyMs = { plugin: 'usage-limits-band', key: 'lastReplyMs' } as const

const DOT_COLOR: Record<AttentionKind, string> = {
  waiting: '#E8A23B',
  unread: '#D97757',
  running: '#8A8A8A',
}

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Weekly',
}

type Level = 'good' | 'warn' | 'bad'

type Pace = {
  // Share of the window already gone.
  elapsed: number
  // Where usage "should" be right now: elapsed, or for the weekly bar the share
  // you usually have used by this hour of the week.
  expected: number
  isLearned: boolean
  // Points ahead (+) or behind (-) of that line.
  diff: number
  level: Level
  label: string
  // When usage reaches 100% at the current burn rate, if that is before the reset.
  runOutMs: number | null
  runOutAt: number | null
}

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
}

const LEVEL_FILL: Record<Level, string> = { good: '#3FB27F', warn: '#E8A23B', bad: '#E5484D' }
const LEVEL_TERMINAL: Record<Level, string> = { good: 'green', warn: 'yellow', bad: 'red' }

// Within this many points of the line counts as on pace.
const ON_PACE = 5
const TOO_FAST = 15

// The first few minutes of a window say nothing about your rate.
const MIN_ELAPSED = 3

const HOUR_MS = 60 * 60 * 1000
const BUCKETS = 168

type Sample = { t: number; used: number }
type Reading = Sample & { resetsAt: string }

// What the mod learns about your week, kept in a small JSON file you can read
// or delete: delete it and the line goes back to plain elapsed time.
type Habits = {
  v: 1
  // Points burned in each hour of the week (Sunday 00:00 first), older weeks faded.
  buckets: number[]
  // The latest reading per window, to tell what is new since last time.
  last: Record<string, Reading | undefined>
  // Recent changes of percent used per window, for the current burn rate.
  samples: Record<string, Sample[]>
}

let habits: Habits | null = null

// Each new weekly window fades what was learned before it by this much.
const WEEK_DECAY = 0.85
// About two full weeks of readings make the learned profile fully trusted.
const FULL_MASS = 150
// Share of the learned profile kept as an even spread, so an hour you never
// worked in so far is not treated as impossible.
const PRIOR = 0.25
// The learned line never strays further than this from plain elapsed time.
const MAX_SHIFT = 18
// A rise is credited to the last stretch before it was seen, not to the idle
// time since the previous reading.
const CREDIT_MS = 30 * 60 * 1000
const SAMPLE_KEEP_MS = 26 * HOUR_MS

// How far back the burn rate looks, and the least history it needs.
const LOOKBACK: Record<string, { ms: number; minSpan: number }> = {
  five_hour: { ms: HOUR_MS, minSpan: 10 * 60 * 1000 },
  seven_day: { ms: 24 * HOUR_MS, minSpan: 2 * HOUR_MS },
}

const FIVE_WEIGHTS = Array.from({ length: BUCKETS }, () => 1 / 5)
const UNIFORM_WEIGHTS = Array.from({ length: BUCKETS }, () => 1 / BUCKETS)

function emptyHabits(): Habits {
  return { v: 1, buckets: Array.from({ length: BUCKETS }, () => 0), last: {}, samples: {} }
}

function bucketOf(t: number) {
  const d = new Date(t)
  return d.getDay() * 24 + d.getHours()
}

function nextHour(t: number) {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  const next = d.getTime() + HOUR_MS
  // The repeated hour when clocks go back must still move time forward.
  return next > t ? next : t + HOUR_MS
}

function eachHour(t0: number, t1: number, fn: (bucket: number, ms: number) => void) {
  let t = t0
  while (t < t1) {
    const end = Math.min(nextHour(t), t1)
    fn(bucketOf(t), end - t)
    t = end
  }
}

// Weight of each hour of the week: how much of a week's usage tends to land in
// it. Even until enough has been learned.
function weekWeights(h: Habits | null) {
  const mass = h ? h.buckets.reduce((a, b) => a + b, 0) : 0
  if (!h || !(mass > 0)) return { weights: UNIFORM_WEIGHTS, confidence: 0 }
  const confidence = Math.min(1, mass / FULL_MASS)
  const weights = h.buckets.map(
    b => confidence * ((1 - PRIOR) * (b / mass) + PRIOR / BUCKETS) + (1 - confidence) / BUCKETS,
  )
  return { weights, confidence }
}

// Share of a window's usage expected between two moments, 0..1.
function share(weights: number[], t0: number, t1: number) {
  let s = 0
  eachHour(t0, t1, (i, ms) => {
    s += (weights[i] * ms) / HOUR_MS
  })
  return s
}

// The moment by which `need` more of the window's usage is expected, from `from`.
function whenShare(weights: number[], from: number, need: number, until: number) {
  let t = from
  let remaining = need
  while (t < until) {
    const end = Math.min(nextHour(t), until)
    const ms = end - t
    const seg = (weights[bucketOf(t)] * ms) / HOUR_MS
    if (seg > 0 && remaining <= seg) return t + (ms * remaining) / seg
    remaining -= seg
    t = end
  }
  return null
}

// Percent used a while ago, from the recorded changes.
function baseline(samples: Sample[], kind: string, at: number): Sample | null {
  const { ms, minSpan } = LOOKBACK[kind]
  let found: Sample | undefined
  for (const s of samples) {
    if (s.t <= at - ms) found = s
    else break
  }
  if (found) return { t: at - ms, used: found.used }
  const first = samples[0]
  return first && at - first.t >= minSpan ? first : null
}

// When usage reaches 100%. The recent burn is compared with what the same
// hours normally take (so a night off does not count as a slow stretch) and
// carried forward over the hours still to come.
function projectRunOut(limit: Limit, weights: number[], start: number, end: number, at: number) {
  const used = limit.percentUsed
  const progress = share(weights, start, at) * 100
  const base = baseline(habits?.samples[limit.kind] ?? [], limit.kind, at)
  let ratio: number | null = null
  if (base) {
    const normal = share(weights, base.t, at) * 100
    if (used > base.used && normal > 0.1) ratio = (used - base.used) / normal
  } else if (progress >= MIN_ELAPSED) {
    ratio = used / progress
  }
  if (ratio === null || ratio <= 0) return null
  const target = progress + (100 - used) / ratio
  if (target >= 100) return null
  return whenShare(weights, at, (target - progress) / 100, end)
}

// Compare usage with where it should be by now. The marker sits at that point:
// fill past it means you are burning faster than the window allows. For the
// weekly bar the point follows the hours you tend to work, once it has learned
// them; otherwise it is simply the share of the window gone.
function pace(limit: Limit, at: number): Pace | null {
  const window = WINDOW_MS[limit.kind]
  if (!window || !limit.resetsAt) return null
  const end = Date.parse(limit.resetsAt)
  const left = end - at
  if (!Number.isFinite(left) || left <= 0) return null
  const start = end - window
  const elapsedMs = Math.max(0, Math.min(window, window - left))
  const elapsed = Math.round((elapsedMs / window) * 1000) / 10
  const used = Math.max(0, Math.min(100, limit.percentUsed))

  const week = limit.kind === 'seven_day' ? weekWeights(habits) : null
  const weights = week ? week.weights : FIVE_WEIGHTS
  let expected = elapsed
  if (week && week.confidence > 0) {
    const learned = share(weights, start, at) * 100
    expected = Math.round(Math.max(elapsed - MAX_SHIFT, Math.min(elapsed + MAX_SHIFT, learned, 100)) * 10) / 10
    expected = Math.max(0, expected)
  }
  const isLearned = week !== null && week.confidence >= 0.5

  const diff = Math.round((used - expected) * 10) / 10
  let level: Level = diff > TOO_FAST ? 'bad' : diff > ON_PACE ? 'warn' : 'good'
  if (used >= 90) level = 'bad'
  else if (used >= 80 && level === 'good') level = 'warn'
  const label =
    elapsed < MIN_ELAPSED
      ? 'just started'
      : diff < -ON_PACE
        ? '▼ under pace'
        : diff <= ON_PACE
          ? '● on pace'
          : diff > TOO_FAST
            ? '▲ too fast'
            : '▲ a bit fast'
  let runOutMs: number | null = null
  let runOutAt: number | null = null
  if (elapsed >= MIN_ELAPSED && used > 0 && used < 100 && diff > ON_PACE) {
    const when = projectRunOut({ ...limit, percentUsed: used }, weights, start, end, at)
    if (when !== null && when < end) {
      runOutMs = when - at
      runOutAt = when
    }
  }
  return { elapsed, expected, isLearned, diff, level, label, runOutMs, runOutAt }
}

async function habitsPath($: EngineInterface) {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home}/.claude/mods-state/usage-limits-band/habits.json` : null
}

function readHabits(raw: unknown): Habits {
  const h = emptyHabits()
  const r = raw as Partial<Habits> | null
  if (r && Array.isArray(r.buckets) && r.buckets.length === BUCKETS) {
    h.buckets = r.buckets.map(n => (Number.isFinite(n) && n > 0 ? n : 0))
  }
  for (const kind of Object.keys(WINDOW_MS)) {
    const last = r?.last?.[kind]
    if (last && Number.isFinite(last.t) && Number.isFinite(last.used) && typeof last.resetsAt === 'string') {
      h.last[kind] = { t: last.t, used: last.used, resetsAt: last.resetsAt }
    }
    const samples = r?.samples?.[kind]
    h.samples[kind] = Array.isArray(samples)
      ? samples.filter(s => s && Number.isFinite(s.t) && Number.isFinite(s.used))
      : []
  }
  return h
}

// Note the latest readings: credit weekly gains to the hours they landed in,
// and keep the recent changes the burn rate is read from. The file is shared by
// every open session, so a gain one of them recorded is not credited twice.
async function recordReadings($: EngineInterface, list: Limit[], t = Date.now()) {
  try {
    const path = await habitsPath($)
    if (!path) return
    let h = emptyHabits()
    try {
      h = readHabits(JSON.parse(await $.fs.read(path)))
    } catch {
      // No file yet, or a half-written one: start from nothing.
    }
    for (const l of list) {
      if (!WINDOW_MS[l.kind] || !l.resetsAt || !Number.isFinite(l.percentUsed)) continue
      const prev = h.last[l.kind]
      const isSameWindow = prev !== undefined && Math.abs(Date.parse(prev.resetsAt) - Date.parse(l.resetsAt)) < 5 * 60 * 1000
      let samples = h.samples[l.kind] ?? []
      if (!isSameWindow) {
        samples = []
        if (prev !== undefined && l.kind === 'seven_day') h.buckets = h.buckets.map(b => b * WEEK_DECAY)
      } else if (l.kind === 'seven_day' && prev !== undefined && l.percentUsed > prev.used) {
        const gain = l.percentUsed - prev.used
        const from = Math.min(Math.max(prev.t, t - CREDIT_MS), t - 60_000)
        eachHour(from, t, (i, ms) => {
          h.buckets[i] += (gain * ms) / (t - from)
        })
      }
      const lastSample = samples[samples.length - 1]
      if (!lastSample || lastSample.used !== l.percentUsed) samples.push({ t, used: l.percentUsed })
      while (samples.length > 1 && t - samples[1].t > SAMPLE_KEEP_MS) samples.shift()
      h.samples[l.kind] = samples.slice(-300)
      h.last[l.kind] = { t, used: l.percentUsed, resetsAt: l.resetsAt }
    }
    habits = h
    await $.fs.write(path, JSON.stringify(h))
  } catch {
    // Learning is a bonus; the band works without it.
  }
}

function meterSvg(percent: number, p: Pace | null, width: number, title: string) {
  const height = 12
  const barHeight = 4
  const y = (height - barHeight) / 2
  const r = barHeight / 2
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = (clamped / 100) * width
  const markX = p === null ? null : Math.max(1, Math.min(width - 1, (p.expected / 100) * width))
  // The plain share of the window gone, drawn as a faint short tick when the
  // learned line has moved away from it.
  const timeX =
    p === null || Math.abs(p.expected - p.elapsed) < 1.5
      ? null
      : Math.max(1, Math.min(width - 1, (p.elapsed / 100) * width))
  const fill = LEVEL_FILL[p?.level ?? (clamped >= 90 ? 'bad' : clamped >= 70 ? 'warn' : 'good')]
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<title>${title}</title>` +
    `<rect y="${y}" width="${width}" height="${barHeight}" rx="${r}" fill="rgba(128,128,128,0.25)"/>` +
    (filled > 0
      ? `<rect y="${y}" width="${filled.toFixed(1)}" height="${barHeight}" rx="${r}" fill="${fill}"/>`
      : '') +
    (timeX !== null
      ? `<rect x="${(timeX - 0.5).toFixed(1)}" y="3" width="1" height="${height - 6}" fill="rgba(170,170,170,0.55)"/>`
      : '') +
    (markX !== null
      ? `<rect x="${(markX - 1).toFixed(1)}" y="0" width="2" height="${height}" rx="1" fill="rgba(170,170,170,0.95)"/>`
      : '') +
    `</svg>`
  )
}

function terminalBar(percent: number, p: Pace | null, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  const cells = Array.from({ length: width }, (_, i) => (i < filled ? '━' : '─'))
  if (p !== null) {
    const at = Math.max(0, Math.min(width - 1, Math.round((p.expected / 100) * width) - 1))
    const timeAt = Math.max(0, Math.min(width - 1, Math.round((p.elapsed / 100) * width) - 1))
    if (timeAt !== at) cells[timeAt] = '┊'
    cells[at] = '│'
  }
  return cells.join('')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The clock time usage runs out, with the weekday when it is not today.
function runOut(p: Pace | null) {
  if (!p || p.runOutAt === null) return ''
  const d = new Date(p.runOutAt)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const isToday = d.toDateString() === new Date().toDateString()
  return `out at ${isToday ? '' : `${DAYS[d.getDay()]} `}${time}`
}

function paceTitle(kind: string, percent: number, p: Pace | null) {
  const base = `${LABELS[kind]}: ${percent}% used`
  if (p === null) return base
  const status = p.label.replace(/^[▼●▲] /, '')
  const tail = p.runOutMs === null ? '' : `. Runs ${runOut(p)}`
  const hasTick = Math.abs(p.expected - p.elapsed) >= 1.5
  const where = p.isLearned
    ? `usually ${Math.round(p.expected)}% by now${hasTick ? `, ${Math.round(p.elapsed)}% of the time gone` : ''}`
    : `${Math.round(p.elapsed)}% of the time gone`
  return `${base}, ${where}. ${status[0].toUpperCase()}${status.slice(1)}${tail}`
}

function untilReset(resetsAt: string | undefined, at: number) {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - at
  if (!Number.isFinite(ms) || ms <= 0) return 'resetting'
  const minutes = Math.round(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `resets in ${hours}h ${mins}m`
  return `resets in ${mins}m`
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// The folders where the desktop app keeps its session records
// (lastFocusedAt, lastActivityAt), one per account and workspace.
let appSessionsDirs: string[] | null = null

// Set from the home folder's shape on the first refresh.
let isWindows = false

const ATTENTION_ORDER: Record<AttentionKind, number> = { waiting: 0, unread: 1, running: 2 }

// A finished reply counts as unseen when it landed after the session was last
// on screen; this much slack absorbs the gap between the reply and the record.
const SEEN_SLACK_MS = 3000

// Sessions on this machine that need attention: waiting for your input,
// finished with a reply you have not opened yet, or working on a reply now.
async function refreshSessions($: EngineInterface) {
  try {
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (!home) return
    isWindows = /^[A-Za-z]:|\\/.test(home)
    const dir = `${home}/.claude/sessions`
    const seenDir = `${home}/.claude/mods-state/usage-limits-band/seen`
    const currentId = await $.session.id()

    type Raw = {
      pid: number
      sessionId?: string
      name: string
      status: string
      waitingFor?: string
      hostSessionId?: string
    }
    const found: Raw[] = []
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
        if (typeof raw.pid !== 'number') continue
        found.push({
          pid: raw.pid,
          sessionId: raw.sessionId,
          name: raw.name || raw.cwd?.split('/').pop() || `Session ${raw.pid}`,
          status: raw.status || 'idle',
          waitingFor: typeof raw.waitingFor === 'string' ? raw.waitingFor : undefined,
          hostSessionId: typeof raw.hostSessionId === 'string' ? raw.hostSessionId : undefined,
        })
      } catch {
        // A half-written record; the next refresh picks it up.
      }
    }

    let alive = new Set<number>()
    if (found.length > 0) {
      if (isWindows) {
        // tasklist CSV rows: "image name","pid",...
        const { stdout } = await $.process.run(['tasklist', '/NH', '/FO', 'CSV'])
        alive = new Set(
          stdout.split('\n').map(l => Number(/^"[^"]*","(\d+)"/.exec(l)?.[1])).filter(n => n > 0),
        )
      } else {
        const { stdout } = await $.process.run(['ps', '-o', 'pid=', '-p', found.map(s => s.pid).join(',')])
        alive = new Set(stdout.split('\n').map(l => Number(l.trim())).filter(n => n > 0))
      }
    }
    const live = found.filter(s => alive.has(s.pid))

    // The desktop app's own record of each session: when you last had it on
    // screen and when it last did something.
    const current = live.find(s => s.sessionId === currentId)
    if (appSessionsDirs === null) {
      const appData = isWindows ? await $.env.get('APPDATA') : null
      const base = appData
        ? `${appData.replace(/\\/g, '/')}/Claude/claude-code-sessions`
        : `${home}/Library/Application Support/Claude/claude-code-sessions`
      const dirs: string[] = []
      for (const a of await $.fs.list(base).catch(() => [])) {
        if (a.kind !== 'dir') continue
        for (const b of await $.fs.list(`${base}/${a.name}`).catch(() => [])) {
          if (b.kind === 'dir') dirs.push(`${base}/${a.name}/${b.name}`)
        }
      }
      appSessionsDirs = dirs
    }
    const app = new Map<string, { lastFocusedAt: number; lastActivityAt: number }>()
    for (const s of live) {
      if (!s.hostSessionId) continue
      for (const d of appSessionsDirs) {
        const path = `${d}/${s.hostSessionId}.json`
        if (!(await $.fs.exists(path))) continue
        try {
          const rec = JSON.parse(await $.fs.read(path))
          app.set(s.hostSessionId, {
            lastFocusedAt: Number(rec.lastFocusedAt) || 0,
            lastActivityAt: Number(rec.lastActivityAt) || 0,
          })
        } catch {
          // A half-written record; the next refresh picks it up.
        }
        break
      }
    }

    // The session on screen is the one focused last.
    let focusedHost: string | undefined
    let focusedAt = -1
    for (const [host, rec] of app) {
      if (rec.lastFocusedAt > focusedAt) {
        focusedAt = rec.lastFocusedAt
        focusedHost = host
      }
    }

    // While this session is the one on screen, note that you have seen it, so a
    // reply that lands while you watch never counts as unseen.
    if (current?.sessionId && current.hostSessionId && current.hostSessionId === focusedHost) {
      await $.fs.write(`${seenDir}/${current.sessionId}`, String(Date.now())).catch(() => undefined)
    }

    const result: AttentionSession[] = []
    for (const s of live) {
      const isCurrent = s.sessionId === currentId
      // This session is already in front of you; the band is for the others.
      if (isCurrent) continue
      let kind: AttentionKind | null = null
      let detail: string | undefined
      if (s.status === 'waiting') {
        kind = 'waiting'
        detail = s.waitingFor === 'permission prompt' ? 'needs permission' : 'needs your input'
      } else if (s.status === 'busy') {
        kind = 'running'
        detail = 'working'
      } else if (s.hostSessionId && s.hostSessionId !== focusedHost && !isCurrent) {
        const rec = app.get(s.hostSessionId)
        if (rec && rec.lastActivityAt > 0) {
          let seenAt = rec.lastFocusedAt
          if (s.sessionId) {
            const marked = Number(await $.fs.read(`${seenDir}/${s.sessionId}`).catch(() => '0'))
            if (marked > seenAt) seenAt = marked
          }
          if (rec.lastActivityAt > seenAt + SEEN_SLACK_MS) {
            kind = 'unread'
            detail = 'new reply'
          }
        }
      }
      if (kind === null) continue
      result.push({ pid: s.pid, sessionId: s.sessionId, name: s.name, kind, detail, hostSessionId: s.hostSessionId, isCurrent })
    }
    result.sort((x, y) => ATTENTION_ORDER[x.kind] - ATTENTION_ORDER[y.kind] || x.name.localeCompare(y.name))
    await $.state.set(sessions, result)
  } catch {
    // Leave the last known list in place.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await recordReadings($, usage.rateLimits as Limit[])
    await $.state.set(limits, usage.rateLimits as Limit[])
    await $.state.set(now, Date.now())
    await refreshSessions($)
    // Refresh the countdowns once a minute and the sessions needing attention every 5s.
    $.clock.every(60_000, () => {
      void $.state.set(now, Date.now())
    })
    $.clock.every(5_000, () => {
      void refreshSessions($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await recordReadings($, e.rateLimits as Limit[])
      await $.state.set(limits, e.rateLimits as Limit[])
      await $.state.set(now, Date.now())
    }
    return next(e)
  })

  // Time each of Claude's replies and note it beneath the answer.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted || e.reason !== 'answer') {
      return result
    }
    await $.state.set(lastReplyMs, e.durationMs)
    await refreshSessions($)
    return { ...result, text: `⏱ Responded in ${formatDuration(e.durationMs)}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { value: current = [] } = await $.state.get(limits)
    const { value: stamp } = await $.state.get(now)
    const { value: running = [] } = await $.state.get(sessions)
    const { value: isOpen = false } = await $.state.get(isSessionsOpen)
    const { value: lastMs = null } = await $.state.get(lastReplyMs)
    const at = stamp || Date.now()

    const shown = ['five_hour', 'seven_day'].map(kind => {
      const limit = current.find(l => l.kind === kind)
      return { kind, limit, p: limit ? pace(limit, at) : null }
    })

    const toggleSessions = () => {
      void $.state.set(isSessionsOpen, !isOpen)
      if (!isOpen) void refreshSessions($)
    }

    const openSession = (s: AttentionSession) => {
      void $.state.set(isSessionsOpen, false)
      if (s.isCurrent || !s.hostSessionId) return
      if (s.kind === 'unread') void $.state.set(sessions, running.filter(r => r.pid !== s.pid))
      const url = `claude://code/continue?session=${s.hostSessionId}`
      void $.process.run(isWindows ? ['cmd', '/c', 'start', '', url] : ['open', url])
    }

    const counts = { waiting: 0, unread: 0, running: 0 }
    for (const s of running) counts[s.kind] += 1
    const parts = [
      counts.waiting > 0 ? `${counts.waiting} waiting` : null,
      counts.unread > 0 ? `${counts.unread} unread` : null,
      counts.running > 0 ? `${counts.running} running` : null,
    ].filter(Boolean)
    const sessionsLabel =
      running.length === 0 ? '' : `${parts.join(' · ')} ${isOpen ? '▴' : '▾'}`

    if (e.surface === 'desktop') {
      const { Box, Text, Svg, Select } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {lastMs !== null ? (
            <Box flexDirection="row" marginBottom={1}>
              <Text dimColor>{`Last reply ${formatDuration(lastMs)}`}</Text>
            </Box>
          ) : null}
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={3}>
            <Box flexDirection="row" alignItems="center" gap={3} flexShrink={1}>
              {shown.map(({ kind, limit, p }) => (
                <Box
                  key={kind}
                  flexDirection="row"
                  alignItems="center"
                  gap={1}
                  flexShrink={0}
                >
                  <Text dimColor wrap="truncate">{LABELS[kind]}</Text>
                  {limit ? (
                    <Svg
                      source={meterSvg(limit.percentUsed, p, 80, paceTitle(kind, limit.percentUsed, p))}
                      alt={paceTitle(kind, limit.percentUsed, p)}
                      isInteractive
                      width={80}
                      height={12}
                    />
                  ) : null}
                  <Text wrap="truncate">
                    <Text color={p ? LEVEL_FILL[p.level] : undefined}>{limit ? `${limit.percentUsed}%` : '—'}</Text>
                    {limit?.resetsAt ? <Text dimColor>{`  ${untilReset(limit.resetsAt, at)}`}</Text> : null}
                  </Text>
                </Box>
              ))}
            </Box>
            {running.length > 0 ? (
              <Box flexShrink={0}>
                <Select
                  key="sessions"
                  value=""
                  options={[
                    { value: '', label: sessionsLabel },
                    ...running.map(s => ({
                      value: String(s.pid),
                      label: `${s.kind === 'running' ? '◌' : '●'} ${s.name} · ${s.detail ?? ''}`,
                    })),
                  ]}
                  onSelect={value => {
                    const picked = running.find(r => String(r.pid) === value)
                    if (picked) openSession(picked)
                  }}
                />
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lastMs !== null ? <Text dimColor>Last reply {formatDuration(lastMs)}</Text> : null}
        <Box flexDirection="row" justifyContent="space-between" gap={3}>
          <Box flexDirection="row" gap={3}>
            {shown.map(({ kind, limit, p }) => (
              <Text key={kind}>
                <Text dimColor>{LABELS[kind]} </Text>
                {limit ? (
                  <Text>
                    <Text color={p ? LEVEL_TERMINAL[p.level] : undefined}>{terminalBar(limit.percentUsed, p)}</Text>
                    <Text> {limit.percentUsed}%</Text>
                    <Text dimColor>  {untilReset(limit.resetsAt, at)}</Text>
                    {p ? <Text color={LEVEL_TERMINAL[p.level]}>  {runOut(p) ? `${p.label} · ${runOut(p)}` : p.label}</Text> : null}
                  </Text>
                ) : (
                  <Text dimColor>—</Text>
                )}
              </Text>
            ))}
          </Box>
          {running.length > 0 ? (
            <Button key="sessions" label={sessionsLabel} plain dimColor onPress={toggleSessions} />
          ) : null}
        </Box>
        {isOpen && running.length > 0 ? (
          <Box flexDirection="column">
            {running.map(s => (
              <Text key={`row-${s.pid}`} dimColor={!s.isCurrent}>
                {s.kind === 'running' ? '◌ ' : '● '}
                {s.isCurrent ? `${s.name} (this session)` : s.name}
                {`  ${s.detail ?? ''}`}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}

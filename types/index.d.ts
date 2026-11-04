export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type AttentionKind = 'waiting' | 'unread' | 'running'

export type AttentionSession = {
  pid: number
  sessionId?: string
  name: string
  kind: AttentionKind
  detail?: string
  hostSessionId?: string
  isCurrent: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-limits-band': {
      limits: Limit[]
      now: number
      sessions: AttentionSession[]
      isSessionsOpen: boolean
      lastReplyMs: number | null
    }
  }
}

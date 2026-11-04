# usage-limits-band

A Claude Code mod that adds a band above the prompt showing:

- **Session (5-hour) and Weekly usage** with a bar, percent used and time to reset
  (orange, then amber at 70%, red at 90%)
- **A pace line** on each bar: how much of the window has passed. Fill past the
  line means you are burning faster than time. The bar and a label beside it
  (`▼ under pace`, `● on pace`, `▲ a bit fast`, `▲ too fast`) go green, amber
  or red, and when you will run out before the reset the hover says when. The
  run-out time follows your recent burn rate, not the average since the reset
- **Learns your week**: the weekly line moves to where you usually are by this
  hour of the week (no Saturdays, short Fridays...), after about two weeks of
  data and never more than 18 points from plain elapsed time. What it learns
  is in `~/.claude/mods-state/usage-limits-band/habits.json`; delete the file
  to start over
- **Running sessions**: a button listing Claude Code sessions on this machine that
  are mid-reply; in the desktop app, click one to jump to it
- **Reply timing**: how long Claude's last reply took

## Install

At the prompt of a terminal session:

```
/plugin install usage-limits-band --marketplace esheliko/usage-limits-band
```

From a shell:

```
claude plugin install usage-limits-band --marketplace esheliko/usage-limits-band
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `esheliko/usage-limits-band`, then Add plugin.

The repository is private: the install works only for people who can read it
on GitHub and whose machine already has a git credential for github.com.

### In cloud sessions

Cloud sessions only see the repository they open, so turn the mod on in that
repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "usage-limits-band": {
      "source": { "source": "github", "repo": "esheliko/usage-limits-band" }
    }
  },
  "enabledPlugins": {
    "usage-limits-band@usage-limits-band": true
  }
}
```

In a cloud session the band shows your usage limits and pace. The running-sessions
button stays empty there, and the learned weekly line starts fresh each session.

### From a folder

1. Unzip so the folder ends up at `~/.claude/mods/usage-limits-band`.
2. Add it to the `env` block of `~/.claude/settings.json` (create the file if needed):

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/usage-limits-band"
     }
   }
   ```

   If you already have a `CLAUDE_CODE_PLUGIN_DIRS` value, append this path
   separated by `:` (`;` on Windows).
3. Start a new Claude Code session (terminal or the desktop app's Code tab).

To try it once without changing settings, run it from a terminal:
`claude --plugin-dir ~/.claude/mods/usage-limits-band`

Notes: the "jump to session" click and the running-sessions check use macOS
`open` and `ps`, so those parts work best on a Mac.

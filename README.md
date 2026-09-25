# pi-notify-local

Local Pi extension. When the agent finishes a turn, it raises a desktop
notification titled `Pi · <project>` with a compact summary of the final
assistant response. `Ready for input` is used only when no final text exists.

## Why local

The third-party notifier wrote Kitty OSC notification bytes into the same
stdout used by Pi's renderer. A corrupted body was observed as
`Ready \e[49m\e[0m8;;`. The exact interleaving mechanism was not proven, so
this version avoids that transport entirely: Pi sends completion events to a
local dispatcher, which uses `notify-send` without touching TUI stdout.

## Behavior

- Notification text is useful and bounded: project basename in the title, final
  assistant text normalized to one line and capped at 240 Unicode characters.
  Markdown/control syntax is stripped; errors and empty responses have safe
  fallbacks.
- Handoff-flow turns never notify. Old-Pi drain/launch state and exact Step 0–3
  `HANDOFF-FLOW-OLD/NEW` markers cover both sides of the transfer; ordinary
  post-handoff work resumes notifications.
- Every desktop event is handed to detached `notify.py`, the notification-side
  dispatcher. It maps `KITTY_WINDOW_ID` to the stable Kitty tab ID and checks a
  mute marker under `$XDG_RUNTIME_DIR/pi-notify-muted-tabs/` before invoking
  `notify-send`. Dispatchers serialize through a lock and replace the previous
  Pi notification ID, so only the latest completion remains in GNOME history.
  Clicking that card runs its default action and focuses the exact source Kitty
  window. Toggle confirmations are separate short-lived transient banners.
- Press `Ctrl+Shift+Alt+M` to toggle the current Kitty tab. The dispatcher shows
  a small confirmation. State is tab-owned, independent of Pi and its splits.
- Optional `PI_NOTIFY_SOUND_CMD` runs only after an unmuted notification is
  accepted by `notify-send`; muted tabs are silent.
- Without `notify-send`, sanitized iTerm2 OSC 9 or generic OSC 777 is retained
  as a last fallback, with tmux passthrough wrapping when needed.
- This machine's `kitty.conf` also filters the exact legacy OSC payload
  (`Pi` / `Ready for input`) so old already-running Pi processes cannot bypass
  coalescing while they wait for reload/restart.

## Install

Add this directory to `packages` in `~/.pi/agent/settings.json`:

```json
"/home/sr/dev/pi/pi-notify"
```

Restart or reload Pi for extension changes. Reload `kitty.conf` once to install
the shortcut; no full Kitty restart is required.

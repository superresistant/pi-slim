terminal (ex pi-slim) — terminal UX for Pi on this desktop (Kitty, GNOME X11). Loaded as a Pi package from `~/.pi/agent/settings.json` `packages`; `/slim` toggles chrome

`index.ts` slim chrome: existing editor border becomes status row (cwd OSC 8 copy link via `copy-path.py`, stop time, bus wait, context, model)
`notify/` desktop notifications: extension hands every event to detached `notify.py` (never writes TUI stdout); title `Pi · <project>`, body final assistant text ≤240 chars; completion suppressed when source pane focused; `Ctrl+Shift+Alt+M` mutes tab; card click focuses source window; bus handoff/autopilot pulses silent, autopilot off/waiting notify. Publishes Kitty vars `pi_state`/`pi_session` (TUI only) for `~/.config/kitty/tab_bar.py`; restart reloads kitty.conf. `gnome-notification-limit/` GNOME46 extension caps history at 10 with compact Pi cards
`notify/bin/kitty-save-session` Kitty autosave (timer) and Ctrl+Shift+S: verified Pi panes restore as `pi --session FILE`
`clip/` `clipclean --watch` service unwraps padded TUI copies; `kitty-paste` (Ctrl+V/right-click) cleans then sends one bracketed paste, images forward Ctrl+V to Pi
`note/` notes scratchpad: real Pi editor, no agent; Ctrl+Shift+N `kitty-notes` opens split beside pane; autosave `~/.local/share/pi-notes/`
`ppp/ppp` fzf picker over session text; `pp` in `~/.bash_aliases`; both open via `bus open` (focus live Pi, else start here); `pp update` asks pi-local via `bus ask --wait`

Tests: `npm test` (unit); `npm run test:helper` (isolated Kitty/Xvfb PTYs)

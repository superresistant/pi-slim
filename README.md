terminal (ex pi-slim) — terminal UX for Pi on this desktop (Kitty, GNOME X11). Loaded as a Pi package from `~/.pi/agent/settings.json` `packages`; `/slim` toggles chrome

`index.ts` slim chrome: existing editor border becomes status row (cwd OSC 8 copy link via `copy-path.py`, stop time, bus wait, context, model)
`notify/` `gnome-notification-limit/` GNOME46 extension caps notification history at 10 with compact cards (Pi-window notifications and Kitty `pi_state`/`pi_session` vars retired 2026-11-01: agents run in aa, aa has its own feed)
`notify/bin/kitty-save-session` Kitty session save on change (`notify/bin/kitty_session_watcher.py`, kitty.conf `watcher`) and Ctrl+Shift+S: verified Pi panes restore as `pi --session FILE`
`clip/` `clipclean --watch` service unwraps padded TUI copies; `kitty-paste` (Ctrl+V/right-click) cleans then sends one bracketed paste, images forward Ctrl+V to Pi
`note/` notes scratchpad: real Pi editor, no agent; autosave `~/.local/share/pi-notes/`
`open/kitty-open-file [--elsewhere] [--window ID] REF` opens path[:line[:col]] / file:// refs: text → editor split (`$VISUAL`/`$EDITOR`/micro) next to window, images → `kitten icat` split, else or `--elsewhere` → xdg-open; Kitty `detect_url_regex` + `open-actions.conf` `protocol file` make paths clickable in shell windows; aa calls it for its file links
`ppp/ppp` fzf picker over session text; `pp` in `~/.bash_aliases`; both open via `bus open` (focus live Pi, else start here); `pp update` asks pi-local via `bus ask --wait`

Tests: `npm test` (unit); `npm run test:helper` (isolated Kitty/Xvfb PTYs)

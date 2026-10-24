#!/usr/bin/env python3
"""Pi notification dispatcher: Kitty-tab mute, focus suppression, aa feed (notify-send fallback), Kitty user vars."""

import fcntl
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys

TIMEOUT = 3
QUIET = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
ERRORS = (KeyError, ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError)


def runtime_dir() -> Path:
    root = Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/pi-notify-{os.getuid()}")) / "pi-notify-muted-tabs"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root


def kitten(*args: str, check: bool = False) -> None:
    socket = os.environ.get("KITTY_LISTEN_ON", "")
    window_id = os.environ.get("KITTY_WINDOW_ID", "")
    if not socket or not window_id.isdecimal():
        return
    subprocess.run(["kitten", "@", "--to", socket, args[0], "--match", f"id:{window_id}", *args[1:]],
                   timeout=TIMEOUT, check=check, **QUIET)


def kitty_state() -> list[dict]:
    socket = os.environ.get("KITTY_LISTEN_ON", "")
    if not socket:
        return []
    result = subprocess.run(["kitten", "@", "--to", socket, "ls"], check=True, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, timeout=TIMEOUT)
    state = json.loads(result.stdout)
    return state if isinstance(state, list) else []


def windows(state: list[dict]):
    for os_window in state:
        for tab in os_window.get("tabs", []):
            for window in tab.get("windows", []):
                yield os_window, tab, window


def kitty_instance_id(pid: int) -> str:
    # PID plus process start tick: unique per Kitty run even after PID reuse.
    start_tick = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
    return f"{pid}-{start_tick}"


def current_tab(state: list[dict] | None = None) -> tuple[str, int] | None:
    window_id, kitty_pid = os.environ.get("KITTY_WINDOW_ID", ""), os.environ.get("KITTY_PID", "")
    if not window_id or not kitty_pid:
        return None
    for _, tab, window in windows(kitty_state() if state is None else state):
        if window.get("id") == int(window_id):
            return kitty_instance_id(int(kitty_pid)), int(tab["id"])
    return None


def marker_for(tab: tuple[str, int]) -> Path:
    return runtime_dir() / f"{tab[0]}-{tab[1]}"


def source_is_focused(state: list[dict]) -> bool:
    window_id = int(os.environ.get("KITTY_WINDOW_ID", ""))
    for os_window, tab, window in windows(state):
        if window.get("id") == window_id:
            return (os_window.get("is_focused") is True and tab.get("is_active") is True
                    and window.get("is_active") is True and window.get("is_focused") is True)
    return False


def send_feedback(body: str) -> None:
    if binary := shutil.which("notify-send"):
        try:
            subprocess.run([binary, "--app-name", "Pi", "--transient", "--expire-time", "2000", "--",
                            "Pi notifications", body], timeout=TIMEOUT, check=False, **QUIET)
        except (OSError, subprocess.SubprocessError):
            pass


def send_desktop(title: str, body: str) -> bool:
    binary = shutil.which("notify-send")
    if not binary:
        return False
    # Serialize and replace the previous Pi card; clicking it focuses the source window.
    root = runtime_dir()
    id_path = root / ".desktop-notification-id"
    process: subprocess.Popen[str] | None = None
    try:
        with (root / ".desktop-notification.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            previous = id_path.read_text().strip() if id_path.exists() else ""
            args = [binary, "--app-name", "Pi", "--print-id", "--action", "default=Focus Kitty tab"]
            if previous.isdecimal():
                args += ["--replace-id", previous]
            process = subprocess.Popen([*args, "--", title, body], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            ready = selectors.DefaultSelector()
            ready.register(process.stdout, selectors.EVENT_READ)
            returned = process.stdout.readline().strip() if ready.select(TIMEOUT) else ""
            if not returned.isdecimal():
                process.kill()
                process.wait()
                return False
            id_path.write_text(returned + "\n")
        remaining, _ = process.communicate()
        if "default" in remaining.splitlines():
            try:
                kitten("focus-window")
            except (OSError, subprocess.SubprocessError):
                pass
        return True
    except (OSError, subprocess.SubprocessError):
        if process is not None and process.poll() is None:
            process.kill()
        return False


PRIOS = {"need", "problem", "done", "info"}


def send_feed(title: str, body: str, prio: str) -> bool:
    binary = shutil.which("aa") or str(Path.home() / ".local/bin/aa")
    text = " ".join(body.split())[:160] or "Ready for input"
    try:
        return subprocess.run([binary, "notify", "--prio", prio, "--from", title, text],
                              timeout=TIMEOUT, check=False, **QUIET).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def send(title: str, body: str, completion: bool = False, prio: str = "") -> int:
    try:
        state = kitty_state()
        if completion and source_is_focused(state):
            return 0
        tab = current_tab(state)
        if tab and marker_for(tab).exists():
            return 0
    except ERRORS:
        pass
    prio = prio if prio in PRIOS else ("done" if completion else "problem")
    return 0 if send_feed(title, body, prio) or send_desktop(title, body) else 1


def toggle() -> int:
    try:
        tab = current_tab()
        if tab is None:
            send_feedback("Could not identify the current Kitty tab")
            return 1
        marker = marker_for(tab)
        if marker.exists():
            marker.unlink()
            send_feedback("Enabled for this Kitty tab")
        else:
            marker.touch(mode=0o600)
            send_feedback("Muted for this Kitty tab")
        return 0
    except ERRORS:
        send_feedback("Could not toggle this Kitty tab")
        return 1


def set_user_var(name: str, value: str) -> int:
    try:
        kitten("set-user-vars", f"{name}={value}" if value else name, check=True)
        return 0
    except (OSError, subprocess.SubprocessError):
        return 1


def main(argv: list[str]) -> int:
    command, args = (argv[1] if len(argv) > 1 else "send"), argv[2:]
    if command == "send":
        rest = args[2:]
        prio = rest[rest.index("--prio") + 1] if "--prio" in rest[:-1] else ""
        return send(args[0] if args else "Pi", args[1] if len(args) > 1 else "Ready for input",
                    completion="--completion" in rest, prio=prio)
    if command == "toggle":
        return toggle()
    value = args[0] if args else ""
    if command == "agent-status" and value in {"busy", "done", "clear"}:
        return set_user_var("pi_state", "" if value == "clear" else value)
    if command == "session-file" and (not value or value.startswith("/")):
        return set_user_var("pi_session", value)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

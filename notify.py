#!/usr/bin/env python3
"""Notification-side dispatcher and Kitty-tab mute toggle for pi-notify-local."""

import fcntl
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys

APP_NAME = "Pi"
DEFAULT_TITLE = "Pi"
DEFAULT_BODY = "Ready for input"
TIMEOUT = 3


def runtime_dir() -> Path:
    base = Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/pi-notify-{os.getuid()}"))
    root = base / "pi-notify-muted-tabs"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root


def kitty_state() -> list[dict]:
    socket = os.environ.get("KITTY_LISTEN_ON", "")
    if not socket:
        return []
    result = subprocess.run(
        ["kitten", "@", "--to", socket, "ls"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=TIMEOUT,
    )
    state = json.loads(result.stdout)
    return state if isinstance(state, list) else []


def kitty_instance_id(pid: int) -> str:
    # PID alone can be reused before the runtime directory is cleared. Linux's
    # process start tick makes the marker namespace unique to this Kitty run.
    fields_after_comm = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    start_tick = int(fields_after_comm[19])  # /proc field 22 (starttime)
    return f"{pid}-{start_tick}"


def current_tab(state: list[dict] | None = None) -> tuple[str, int] | None:
    raw_window_id = os.environ.get("KITTY_WINDOW_ID", "")
    raw_kitty_pid = os.environ.get("KITTY_PID", "")
    if not raw_window_id or not raw_kitty_pid:
        return None
    window_id = int(raw_window_id)
    instance = kitty_instance_id(int(raw_kitty_pid))
    for os_window in kitty_state() if state is None else state:
        for tab in os_window.get("tabs", []):
            if any(window.get("id") == window_id for window in tab.get("windows", [])):
                return instance, int(tab["id"])
    return None


def marker_for(tab: tuple[str, int]) -> Path:
    kitty_instance, tab_id = tab
    return runtime_dir() / f"{kitty_instance}-{tab_id}"


def is_muted(state: list[dict] | None = None) -> bool:
    tab = current_tab(state)
    return bool(tab and marker_for(tab).exists())


def source_is_focused(state: list[dict]) -> bool:
    window_id = int(os.environ.get("KITTY_WINDOW_ID", ""))
    for os_window in state:
        for tab in os_window.get("tabs", []):
            for window in tab.get("windows", []):
                if window.get("id") == window_id:
                    return (os_window.get("is_focused") is True
                            and tab.get("is_active") is True
                            and window.get("is_active") is True
                            and window.get("is_focused") is True)
    return False


def focus_source() -> None:
    socket = os.environ.get("KITTY_LISTEN_ON", "")
    raw_window_id = os.environ.get("KITTY_WINDOW_ID", "")
    if not socket or not raw_window_id:
        return
    try:
        window_id = int(raw_window_id)
        subprocess.run(
            [
                "kitten",
                "@",
                "--to",
                socket,
                "focus-window",
                "--match",
                f"id:{window_id}",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=TIMEOUT,
            check=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        pass


def send_feedback(body: str) -> None:
    binary = shutil.which("notify-send")
    if not binary:
        return
    try:
        subprocess.run(
            [
                binary,
                "--app-name",
                APP_NAME,
                "--transient",
                "--expire-time",
                "2000",
                "--",
                "Pi notifications",
                body,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def send_desktop(title: str, body: str) -> bool:
    binary = shutil.which("notify-send")
    if not binary:
        return False

    # Serialize dispatchers and replace the previous Pi notification globally.
    # The default action is emitted when the card is clicked; this detached
    # helper then focuses the exact Kitty source window.
    root = runtime_dir()
    lock_path = root / ".desktop-notification.lock"
    id_path = root / ".desktop-notification-id"
    process: subprocess.Popen[str] | None = None
    try:
        with lock_path.open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            previous_id = ""
            try:
                candidate = id_path.read_text().strip()
                if candidate.isdecimal():
                    previous_id = candidate
            except FileNotFoundError:
                pass

            args = [
                binary,
                "--app-name",
                APP_NAME,
                "--print-id",
                "--action",
                "default=Focus Kitty tab",
            ]
            if previous_id:
                args.extend(["--replace-id", previous_id])
            args.extend(["--", title, body])
            process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            if process.stdout is None:
                process.kill()
                return False
            ready = selectors.DefaultSelector()
            ready.register(process.stdout, selectors.EVENT_READ)
            if not ready.select(TIMEOUT):
                process.kill()
                process.wait()
                return False
            returned_id = process.stdout.readline().strip()
            if not returned_id.isdecimal():
                process.kill()
                process.wait()
                return False
            id_path.write_text(returned_id + "\n")

        run_sound()
        remaining, _ = process.communicate()
        if "default" in remaining.splitlines():
            focus_source()
        return True
    except (OSError, subprocess.SubprocessError):
        if process is not None and process.poll() is None:
            process.kill()
        return False


def run_sound() -> None:
    command = os.environ.get("PI_NOTIFY_SOUND_CMD", "").strip()
    if not command:
        return
    try:
        subprocess.Popen(
            command,
            shell=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass


def send(title: str, body: str, completion: bool = False) -> int:
    try:
        state = kitty_state()
        if completion and source_is_focused(state):
            return 0
        if is_muted(state):
            return 0
    except (KeyError, ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError):
        pass
    return 0 if send_desktop(title, body) else 1


def toggle() -> int:
    try:
        tab = current_tab()
        if tab is None:
            send_feedback("Could not identify the current Kitty tab")
            return 1
        marker = marker_for(tab)
        if marker.exists():
            marker.unlink()
            state = "enabled"
        else:
            marker.touch(mode=0o600)
            state = "muted"
        if os.environ.get("PI_NOTIFY_TOGGLE_QUIET") != "1":
            send_feedback(f"{state.capitalize()} for this Kitty tab")
        return 0
    except (KeyError, ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError):
        send_feedback("Could not toggle this Kitty tab")
        return 1


def status() -> int:
    try:
        print("muted" if is_muted() else "enabled")
        return 0
    except (KeyError, ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError):
        print("unknown")
        return 1


def set_user_var(variable: str) -> int:
    socket = os.environ.get("KITTY_LISTEN_ON", "")
    raw_window_id = os.environ.get("KITTY_WINDOW_ID", "")
    if not socket or not raw_window_id:
        return 0
    try:
        window_id = int(raw_window_id)
        subprocess.run(
            [
                "kitten",
                "@",
                "--to",
                socket,
                "set-user-vars",
                "--match",
                f"id:{window_id}",
                variable,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=TIMEOUT,
            check=True,
        )
        return 0
    except (OSError, ValueError, subprocess.SubprocessError):
        return 1


def set_agent_status(value: str) -> int:
    if value not in {"busy", "done", "clear"}:
        return 2
    return set_user_var("pi_state" if value == "clear" else f"pi_state={value}")


def set_session_file(value: str) -> int:
    if value and not value.startswith("/"):
        return 2
    return set_user_var("pi_session" if not value else f"pi_session={value}")


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "send"
    if command == "send":
        title = argv[2] if len(argv) > 2 else DEFAULT_TITLE
        body = argv[3] if len(argv) > 3 else DEFAULT_BODY
        return send(title, body, completion="--completion" in argv[4:])
    if command == "toggle":
        return toggle()
    if command == "status":
        return status()
    if command == "agent-status":
        value = argv[2] if len(argv) > 2 else ""
        return set_agent_status(value)
    if command == "session-file":
        return set_session_file(argv[2] if len(argv) > 2 else "")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

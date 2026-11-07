"""Kitty global watcher: run kitty-save-session after real session changes; reopen aa clients killed by a signal."""
import os
import signal
import subprocess
import time

from kitty.fast_data_types import add_timer, get_boss, remove_timer
from kitty.session import default_save_as_session_opts

SAVER = os.path.join(os.path.dirname(os.path.realpath(__file__)), "kitty-save-session")
DELAY = float(os.environ.get("KITTY_SESSION_SAVE_DELAY", "2"))
RETRY = 30.0

state = {"timer": None, "last": None, "proc": None, "quitting": False}


def snapshot(boss):
    opts = default_save_as_session_opts()
    opts.use_foreground_process = True
    return "".join(boss.serialize_state_as_session("", opts))


def schedule(delay=DELAY):
    if state["quitting"]:
        return
    if state["timer"] is not None:
        remove_timer(state["timer"])
    state["timer"] = add_timer(fire, delay, False)


def fire(timer_id):
    state["timer"] = None
    if state["quitting"]:
        return
    proc = state["proc"]
    if proc is not None:
        if proc.poll() is None:
            schedule()
            return
        state["proc"] = None
        if proc.returncode != 0:
            state["last"] = None
    boss = get_boss()
    current = snapshot(boss)
    if current == state["last"]:
        return
    env = dict(os.environ, KITTY_LISTEN_ON=boss.listening_on)
    env.pop("KITTY_WINDOW_ID", None)
    state["proc"] = subprocess.Popen([SAVER, "--auto"], env=env, stdin=subprocess.DEVNULL, start_new_session=True)
    state["last"] = current
    schedule(RETRY)


def changed(boss, window, data):
    schedule()


on_tab_bar_dirty = on_cmd_startstop = on_resize = changed

RESPAWN_SIGNALS = {signal.SIGKILL, signal.SIGSEGV, signal.SIGABRT, signal.SIGBUS, signal.SIGILL, signal.SIGFPE}
respawns = []
watched = {}


def on_set_user_var(boss, window, data):
    schedule()
    pid = window.child.pid
    argv = list(window.child.argv or [])
    if data.get("key") != "aa" or not pid or pid in watched or not argv or os.path.basename(argv[0]) != "aa":
        return
    watched[pid] = {"argv": argv, "cwd": window.child.cwd or os.path.expanduser("~"), "tab": None, "title": "", "index": None}
    boss.monitor_pid(pid, lambda status, error, pid=pid: add_timer(lambda timer_id: child_died(pid, status), 0.5, False))


def on_close(boss, window, data):
    schedule()
    info = watched.get(window.child.pid)
    tab = window.tabref()
    manager = tab.tab_manager_ref() if tab is not None else None
    if info is not None and manager is not None and tab in manager.tabs:
        info.update(tab=tab.id, title=tab.name, index=manager.tabs.index(tab))


def child_died(pid, status):
    info = watched.pop(pid, None)
    if info is None or state["quitting"] or not os.WIFSIGNALED(status) or os.WTERMSIG(status) not in RESPAWN_SIGNALS:
        return
    now = time.monotonic()
    respawns[:] = [t for t in respawns if now - t < 60] + [now]
    if len(respawns) > 3:
        return
    boss = get_boss()
    tab = boss.tab_for_id(info["tab"]) if info["tab"] is not None else None
    if tab is not None and tab.windows:
        boss.call_remote_control(None, ("launch", "--type=window", "--match", f"id:{tab.id}", "--cwd", info["cwd"], *info["argv"]))
        return
    args = ["launch", "--type=tab", "--cwd", info["cwd"]]
    if info["title"]:
        args += ["--tab-title", info["title"]]
    boss.call_remote_control(None, tuple(args + info["argv"]))
    manager = boss.active_tab_manager
    if manager is not None and info["index"] is not None:
        while manager.active_tab_idx > info["index"]:
            manager.move_tab(-1)


def on_quit(boss, window, data):
    if not data.get("confirmed"):
        return
    state["quitting"] = True
    if state["timer"] is not None:
        remove_timer(state["timer"])
        state["timer"] = None
    if state["proc"] is not None and state["proc"].poll() is None:
        state["proc"].terminate()

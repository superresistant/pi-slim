"""Kitty global watcher: run kitty-save-session after real session changes."""
import os
import subprocess

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


on_close = on_tab_bar_dirty = on_set_user_var = on_cmd_startstop = on_resize = changed


def on_quit(boss, window, data):
    if not data.get("confirmed"):
        return
    state["quitting"] = True
    if state["timer"] is not None:
        remove_timer(state["timer"])
        state["timer"] = None
    if state["proc"] is not None and state["proc"].poll() is None:
        state["proc"].terminate()

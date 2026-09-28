"""Pi-written registry of open TUI sessions: one <pid>.json per Pi inside Kitty (notify/index.ts)."""
import json
import os
import time
from pathlib import Path

CLOSE_GRACE = 30
MAX_AGE = 14 * 86400


def directory():
    explicit = os.environ.get("PI_SESSION_REGISTRY")
    if explicit:
        return Path(explicit)
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(state) / "pi-terminal/sessions"


def process_start(pid):
    try:
        stat = Path(f"/proc/{int(pid)}/stat").read_text()
        return stat[stat.rindex(")") + 2:].split(" ")[19]
    except (OSError, ValueError, TypeError, IndexError):
        return None


def read():
    entries = []
    for file in directory().glob("*.json"):
        try:
            entry = json.loads(file.read_text())
        except (OSError, ValueError):
            continue
        if (isinstance(entry, dict) and type(entry.get("pid")) is int
                and isinstance(entry.get("session"), str) and isinstance(entry.get("cwd"), str)):
            entry["file"] = file
            entry["alive"] = entry.get("start") is not None and process_start(entry["pid"]) == entry.get("start")
            entry["kittyAlive"] = entry.get("kittyStart") is not None and process_start(entry.get("kittyPid")) == entry.get("kittyStart")
            entries.append(entry)
    return entries


def write(entry):
    data = {k: v for k, v in entry.items() if k not in ("file", "alive", "kittyAlive")}
    tmp = entry["file"].with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data) + "\n")
    tmp.replace(entry["file"])


def prune(entries, live_sessions=()):
    """Drop entries closed while their Kitty lived on; keep those that died with Kitty for restore.

    A dead Pi under a live Kitty is first marked, then dropped on a later run if that Kitty
    still lives: Pis die before Kitty during a Kitty exit, so one observation is not enough."""
    now = time.time()
    live = {e["session"] for e in entries if e["alive"]} | set(live_sessions)
    kept = []
    for entry in entries:
        try:
            if entry["alive"]:
                kept.append(entry)
            elif entry["session"] in live or now - entry.get("updated", 0) / 1000 > MAX_AGE:
                entry["file"].unlink(missing_ok=True)
            elif entry["kittyAlive"]:
                if "deadSeen" not in entry:
                    entry["deadSeen"] = now
                    write(entry)
                    kept.append(entry)
                elif now - entry["deadSeen"] >= CLOSE_GRACE:
                    entry["file"].unlink(missing_ok=True)
                else:
                    kept.append(entry)
            else:
                kept.append(entry)
        except OSError:
            kept.append(entry)
    return kept


def casualties(entries, live_sessions=()):
    """Sessions whose Pi died with its Kitty and are not open anywhere now; newest entry per session."""
    live = {e["session"] for e in entries if e["alive"]} | set(live_sessions)
    found = {}
    for entry in entries:
        if (entry["alive"] or entry["kittyAlive"] or entry["session"] in live
                or not os.path.isabs(entry["session"]) or not Path(entry["session"]).is_file()):
            continue
        if entry["session"] not in found or entry.get("updated", 0) > found[entry["session"]].get("updated", 0):
            found[entry["session"]] = entry
    return sorted(found.values(), key=lambda e: e.get("updated", 0))

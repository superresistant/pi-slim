import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

root = Path(tempfile.mkdtemp(prefix="kitty-inbox-restore-"))
project = root / "project"
project.mkdir()
agent = root / ".pi/agent"
(agent / "extensions").mkdir(parents=True)
(agent / "settings.json").write_text(json.dumps({"packages": ["/home/sr/dev/pi/pi-handoff-queue", "/home/sr/dev/pi/parley"], "compaction": {"enabled": False}}))
session = project / "conversation.jsonl"
session.write_text(json.dumps({"type": "session", "version": 3, "id": str(uuid.uuid4()), "timestamp": "2026-09-10T08:00:00.000Z", "cwd": str(project)}) + "\n")
env = dict(os.environ, HOME=str(root), PI_CODING_AGENT_DIR=str(agent), PI_HANDOFF_INBOX_DB=str(root / "inbox.sqlite"), PI_OFFLINE="1", KITTY_CONFIG_DIRECTORY=str(root / ".config/kitty"))
for name in ("KITTY_LISTEN_ON", "KITTY_WINDOW_ID", "PI_HANDOFF_INBOX_ONBOARDING", "WAYLAND_DISPLAY"):
    env.pop(name, None)
processes = []
log = (root / "log").open("w+")
ctl = "/home/sr/.local/bin/pi-ctl"
kitty = "/home/sr/.local/bin/kitty"
kitten = "/home/sr/.local/bin/kitten"
request = root / "request.json"

def run(command, **kwargs):
    return subprocess.run(command, env=env, text=True, capture_output=True, check=True, timeout=15, **kwargs).stdout.strip()

def wait(check, message):
    until = time.monotonic() + 25
    while time.monotonic() < until:
        try:
            value = check()
            if value:
                return value
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass
        time.sleep(0.1)
    raise AssertionError(message)

def state():
    for socket in Path(f"/tmp/pi-ctl-{os.getuid()}").glob("*.sock"):
        pid = socket.stem
        try:
            if Path(f"/proc/{pid}/cwd").resolve() != project:
                continue
            status = json.loads(run([ctl, "status", str(socket)]))
            if status.get("session") == str(session):
                return status
        except (OSError, subprocess.SubprocessError):
            continue
    return None

def launch(saved, name):
    socket = f"unix:{root}/{name}.sock"
    p = subprocess.Popen([kitty, "--config", "/home/sr/.config/kitty/kitty.conf", "--override", "startup_session=none", "--override", "update_check_interval=0", "--override", "linux_display_server=x11", "--listen-on", socket, "--session", str(saved)], env=env, stdout=log, stderr=log)
    processes.append(p)
    return p, socket

try:
    original = root / "original.kitty"
    original.write_text("new_tab\nlayout splits\n" + shlex.join(["launch", "--hold", "--env=PI_HANDOFF_INBOX_ONBOARDING=1", f"--var=pi_session={session}", f"--cwd={project}", "/usr/bin/pi", "--session", str(session), "--offline", "-ns", "-nc"]) + "\n")
    first, socket = launch(original, "original")
    try:
        initial = wait(state, "Original Pi endpoint unavailable")
    except AssertionError:
        print(run([kitten, "@", "--to", socket, "get-text", "--extent", "all"])[-2500:], file=sys.stderr)
        raise
    assert initial["idle"] and initial["inbox"]["phase"] == "onboarding" and initial["inbox"]["frozen"]
    target = {key: initial[key] for key in ("pid", "cwd", "session")}
    inbox = "/home/sr/dev/pi/pi-handoff-queue/inbox.mjs"
    request.write_text(json.dumps({"items": [{"id": "restore-smoke:cancel", "origin": target, "kind": "user", "text": "Never run this fixture message."}]}))
    run(["node", inbox, "admit", str(request)])
    request.write_text(json.dumps({"expected": target, "ids": ["restore-smoke:cancel"]}))
    receipt = json.loads(run(["node", inbox, "cancel", str(request)]))
    assert receipt["receipts"][0]["status"] == "cancelled"
    assert json.loads(run(["node", inbox, "cancel", str(request)])) == receipt
    status = state()
    assert status["inbox"]["frozen"] and status["inbox"]["pending"] == 0
    print("PASS exact CLI cancellation while held, duplicate cancellation, freeze preserved", flush=True)
    token = str(uuid.uuid4())
    for action in ("freeze", "abort"):
        request.write_text(json.dumps({"action": action, "from": target, "token": token}))
        run([ctl, "inbox-control", f'/tmp/pi-ctl-{os.getuid()}/{target["pid"]}.sock', str(request)])
    assert not state()["inbox"]["frozen"]
    subprocess.run(["/home/sr/.local/bin/kitty-save-session", "--auto"], env=dict(env, KITTY_LISTEN_ON=socket), check=True, timeout=15)
    saved = root / ".config/kitty/last-session.kitty"
    text = saved.read_text()
    assert "PI_HANDOFF_INBOX_ONBOARDING" not in text and str(session) in text
    assert b"PI_HANDOFF_INBOX_ONBOARDING=1" in Path(f'/proc/{target["pid"]}/environ').read_bytes()
    first.terminate()
    first.wait(timeout=10)
    wait(lambda: not Path(f'/proc/{target["pid"]}').exists(), "Original Pi did not exit")
    second, restored_socket = launch(saved, "restored")
    restored = wait(state, "Restored Pi endpoint unavailable")
    assert restored["pid"] != target["pid"] and restored["session"] == target["session"]
    assert restored["idle"] and restored["inbox"]["phase"] == "ready" and not restored["inbox"]["frozen"]
    assert restored["inbox"]["editAvailable"] and restored["inbox"]["pending"] == 0
    assert b"PI_HANDOFF_INBOX_ONBOARDING=1" not in Path(f'/proc/{restored["pid"]}/environ').read_bytes()
    assert "Never run this fixture message." not in session.read_text()
    print("PASS actual Kitty close/reopen: exact conversation, fresh Pi, ready editable inbox, no message replay", flush=True)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    log.close()
    if sys.exc_info()[0]:
        print((root / "log").read_text()[-2500:], file=sys.stderr)
    shutil.rmtree(root)

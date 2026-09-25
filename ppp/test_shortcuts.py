import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ALIASES = Path.home() / ".bash_aliases"
PPP = Path(__file__).with_name("ppp")
RG = Path.home() / ".pi/agent/bin/rg"
UPDATE_AIM = "Check for a new Pi update. If available, proceed with the guarded update and reapply all our patches. Run the required verification."
STUB = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
record = {"name": name, "args": args, "cwd": os.getcwd()}
if name == "fzf" or args == ["--serve"]:
    record["input"] = sys.stdin.read()
with open(os.environ["CALLS"], "a") as f:
    f.write(json.dumps(record) + "\\n")
if name == "zoxide":
    print(os.environ.get("DEST", ""))
    sys.exit(int(os.environ.get("ZOXIDE_STATUS", "0")))
if name == "fzf":
    rows = record["input"].splitlines()
    chosen = os.environ.get("PICK")
    print(next(row for row in rows if row.split("\\t", 1)[0] == chosen) if chosen else rows[0])
    sys.exit(int(os.environ.get("FZF_STATUS", "0")))
sys.exit(int(os.environ.get("OPEN_STATUS", "0")))
'''


class Shortcuts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.bin = self.root / "bin"
        self.folder = self.root / "project with spaces"
        for path in (self.home, self.bin, self.folder):
            path.mkdir()
        for name in ("parley-remote", "zoxide", "fzf", "pi"):
            executable = self.bin / name
            executable.write_text(STUB)
            executable.chmod(0o755)
        self.log = self.root / "calls"
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{self.bin}:{os.environ['PATH']}", CALLS=str(self.log), DEST=str(self.folder))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def pp(self, *args):
        return subprocess.run(["bash", "--noprofile", "--norc", "-c", '. "$1"; shift; pp "$@"; status=$?; pwd -P; exit "$status"', "test", str(ALIASES), *map(str, args)], cwd=self.root, env=self.env, text=True, capture_output=True)

    def assert_open(self, result, folder, *options):
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.calls()[-1]
        self.assertEqual(call, {"name": "parley-remote", "args": ["--open-local", str(folder), *map(str, options)], "cwd": str(folder)})
        self.assertNotIn("pi", [call["name"] for call in self.calls()])

    def test_noargs(self):
        self.assert_open(self.pp(), self.root)

    def test_path_keeps_parent_shell_cd(self):
        result = self.pp(self.folder)
        self.assert_open(result, self.folder)
        self.assertEqual(result.stdout.strip(), str(self.folder))

    def test_zoxide_keeps_arguments_and_cd(self):
        result = self.pp("gmail", "other token")
        self.assert_open(result, self.folder)
        self.assertEqual(self.calls()[0]["args"], ["query", "--", "gmail", "other token"])
        self.assertEqual(result.stdout.strip(), str(self.folder))

    def test_zoxide_failure_never_opens(self):
        self.env["ZOXIDE_STATUS"] = "7"
        self.assertEqual(self.pp("missing").returncode, 7)
        self.assertEqual([call["name"] for call in self.calls()], ["zoxide"])

    def test_missing_resolved_directory_never_opens(self):
        self.env["DEST"] = str(self.root / "missing")
        self.assertNotEqual(self.pp("missing").returncode, 0)
        self.assertEqual([call["name"] for call in self.calls()], ["zoxide"])

    def test_symlink_uses_physical_folder(self):
        link = self.root / "link"
        link.symlink_to(self.folder)
        self.assert_open(self.pp(link), self.folder)

    def test_new_noargs_path_and_query(self):
        for args, folder in (((), self.root), ((self.folder,), self.folder), (("gmail",), self.folder)):
            with self.subTest(args=args):
                self.assert_open(self.pp("--new", *args), folder, "--new")

    def test_opener_refusal_propagates_without_fallback(self):
        self.env["OPEN_STATUS"] = "9"
        result = self.pp(self.folder)
        self.assertEqual(result.returncode, 9)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(result.stdout.strip(), str(self.folder))

    def test_exact_update(self):
        (self.root / "update").mkdir()
        result = self.pp("update")
        self.assertEqual(result.returncode, 0, result.stderr)
        call, = self.calls()
        self.assertEqual(call["args"], ["--serve"])
        payload = json.loads(call["input"])
        self.assertRegex(payload.pop("id"), r"^pp-update-\d+-\d+$")
        self.assertEqual(payload, {"folder": str(self.home / "dev/pi/pi-local"), "aim": UPDATE_AIM, "sender": "pp update", "timeout": 7200, "startup_timeout": 45})

    def test_update_with_extra_args_still_zoxide(self):
        self.assert_open(self.pp("update", "other"), self.folder)
        self.assertEqual(self.calls()[0]["args"], ["query", "--", "update", "other"])

    def picker_fixture(self):
        sessions = self.home / ".pi/agent/sessions/bucket"
        sessions.mkdir(parents=True)
        bundled = self.home / ".pi/agent/bin/rg"
        bundled.parent.mkdir()
        bundled.symlink_to(RG if RG.exists() else shutil.which("rg"))
        paths = [sessions / "older selected.jsonl", sessions / "newer.jsonl"]
        for index, path in enumerate(paths):
            path.write_text(json.dumps({"type": "session", "cwd": str(self.folder), "timestamp": "2026-09-09T12:00:00Z"}) + "\n" + json.dumps({"type": "message", "message": {"role": "user", "content": "literal [needle]"}}) + "\n")
            os.utime(path, (100 + index, 100 + index))
        self.env["PICK"] = str(paths[0])
        return paths

    def ppp(self, query="literal [needle]"):
        return subprocess.run([str(PPP), query], cwd=self.root, env=self.env, text=True, capture_output=True)

    def test_picker_preserves_exact_selection_and_literal_search(self):
        paths = self.picker_fixture()
        self.assert_open(self.ppp(), self.folder, "--session", paths[0])
        picker = self.calls()[0]
        self.assertEqual(picker["name"], "fzf")
        self.assertTrue(picker["input"].startswith(str(paths[1]) + "\t"))
        self.assertIn("--with-nth=2..", picker["args"])
        self.assertIn("--preview-window=down,60%,wrap,border-none", picker["args"])

    def test_picker_symlink_session_root_passed_exactly(self):
        paths = self.picker_fixture()
        sessions = paths[0].parent.parent
        target = self.root / "actual sessions"
        sessions.rename(target)
        sessions.symlink_to(target)
        self.assert_open(self.ppp(), self.folder, "--session", paths[0])

    def test_picker_cancel_and_no_match_never_open(self):
        self.picker_fixture()
        self.env["FZF_STATUS"] = "130"
        self.assertEqual(self.ppp().returncode, 130)
        self.assertEqual([call["name"] for call in self.calls()], ["fzf"])
        self.log.unlink()
        self.assertEqual(self.ppp("not present").returncode, 1)
        self.assertEqual(self.calls(), [])

    def test_picker_opener_refusal_propagates_without_fallback(self):
        self.picker_fixture()
        self.env["OPEN_STATUS"] = "8"
        self.assertEqual(self.ppp().returncode, 8)
        self.assertEqual([call["name"] for call in self.calls()], ["fzf", "parley-remote"])


if __name__ == "__main__":
    unittest.main()

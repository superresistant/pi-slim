import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("dispatcher", Path(__file__).resolve().parents[1] / "notify.py")
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)
REAL_SEND_FEED = dispatcher.send_feed


class VisibilityTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        env = patch.dict(os.environ, {
            "KITTY_LISTEN_ON": "unix:/tmp/exact kitty.sock", "KITTY_WINDOW_ID": "7",
            "KITTY_PID": str(os.getpid()), "XDG_RUNTIME_DIR": temp.name,
        }, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.state = [{"id": 1, "is_focused": True, "tabs": [
            {"id": 2, "is_active": True, "windows": [
                {"id": 7, "is_active": True, "is_focused": True},
            ]},
        ]}]
        run = patch.object(dispatcher.subprocess, "run", side_effect=self.kitty_ls)
        self.run = run.start()
        self.addCleanup(run.stop)
        feed = patch.object(dispatcher, "send_feed", return_value=False)
        self.feed = feed.start()
        self.addCleanup(feed.stop)
        desktop = patch.object(dispatcher, "send_desktop", return_value=True)
        self.desktop = desktop.start()
        self.addCleanup(desktop.stop)

    def kitty_ls(self, args, **kwargs):
        self.assertEqual(args, ["kitten", "@", "--to", "unix:/tmp/exact kitty.sock", "ls"])
        self.assertEqual(kwargs["timeout"], dispatcher.TIMEOUT)
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps(self.state))

    def send(self, delivered, completion=True):
        self.desktop.reset_mock()
        self.assertEqual(dispatcher.send("Pi", "Done", completion=completion), 0)
        self.assertEqual(self.desktop.call_count, int(delivered))

    def test_focused_completion_suppressed_but_error_and_legacy_send_retained(self):
        self.send(False)
        self.run.assert_called_once()
        self.send(True, completion=False)
        self.assertEqual(dispatcher.main(["notify.py", "send", "Pi", "Done", "--completion"]), 0)
        self.desktop.assert_called_once()

    def test_background_other_tab_other_pane_and_unknown_focus_notify(self):
        focused = copy.deepcopy(self.state)
        for level, flag, value in [
            ("os", "is_focused", False), ("tab", "is_active", False),
            ("pane", "is_active", False), ("pane", "is_focused", False),
            ("os", "is_focused", None), ("pane", "is_focused", "true"),
        ]:
            with self.subTest(level=level, flag=flag, value=value):
                self.state = copy.deepcopy(focused)
                objects = {"os": self.state[0], "tab": self.state[0]["tabs"][0],
                           "pane": self.state[0]["tabs"][0]["windows"][0]}
                if value is None:
                    del objects[level][flag]
                else:
                    objects[level][flag] = value
                self.send(True)
        self.state = copy.deepcopy(focused)
        self.state[0]["tabs"][0]["windows"][0].update(is_active=False, is_focused=False)
        self.state[0]["tabs"][0]["windows"].append({"id": 8, "is_active": True, "is_focused": True})
        self.send(True)
        self.state = copy.deepcopy(focused)
        self.state[0]["is_focused"] = False
        other = copy.deepcopy(focused[0])
        other["id"] = 3
        other["tabs"][0]["windows"][0]["id"] = 8
        self.state.insert(0, other)
        self.send(True)
        self.state = []
        self.send(True)

    def test_missing_identity_or_failed_lookup_fails_open(self):
        for name in ("KITTY_WINDOW_ID", "KITTY_LISTEN_ON"):
            with self.subTest(name=name), patch.dict(os.environ):
                del os.environ[name]
                self.send(True)
        with patch.dict(os.environ, {"KITTY_WINDOW_ID": "invalid"}):
            self.send(True)
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("kitten", 3),
                      subprocess.CalledProcessError(1, "kitten"), json.JSONDecodeError("bad", "", 0)):
            with self.subTest(error=type(error).__name__):
                self.run.side_effect = error
                self.send(True)

    def test_focus_does_not_require_mute_namespace(self):
        del os.environ["KITTY_PID"]
        self.send(False)

    def test_muted_tab_still_suppresses_background_and_attention(self):
        dispatcher.marker_for(dispatcher.current_tab(self.state)).touch()
        self.state[0]["is_focused"] = False
        self.send(False)
        self.send(False, completion=False)


    def test_feed_first_desktop_only_as_fallback(self):
        self.state[0]["is_focused"] = False
        self.feed.return_value = True
        self.assertEqual(dispatcher.send("Pi · x", "Done", completion=True), 0)
        self.feed.assert_called_once_with("Pi · x", "Done", "done")
        self.desktop.assert_not_called()
        self.feed.reset_mock()
        self.assertEqual(dispatcher.main(["notify.py", "send", "Pi · x", "Waiting", "--prio", "need"]), 0)
        self.feed.assert_called_once_with("Pi · x", "Waiting", "need")
        self.feed.return_value = False
        self.assertEqual(dispatcher.send("Pi · x", "Failed"), 0)
        self.assertEqual(self.feed.call_args.args[2], "problem")
        self.desktop.assert_called_once_with("Pi · x", "Failed")

    def test_send_feed_runs_aa_notify_one_line(self):
        with patch.object(dispatcher.shutil, "which", return_value="/x/aa"), \
                patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertTrue(REAL_SEND_FEED("Pi · x", "a\n\n b " + "c" * 300, "done"))
        args = run.call_args.args[0]
        self.assertEqual(args[:6], ["/x/aa", "notify", "--prio", "done", "--from", "Pi · x"])
        self.assertEqual(len(args[6]), 160)
        self.assertTrue(args[6].startswith("a b ccc"))


if __name__ == "__main__":
    unittest.main()

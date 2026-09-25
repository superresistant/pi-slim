import os
import runpy
import subprocess
import tempfile
import unittest
from pathlib import Path


module = runpy.run_path(Path(__file__).with_name("clipclean"), run_name="clipclean_test")
detect_tui_paste = module["detect_tui_paste"]
clean_tui_paste = module["clean_tui_paste"]
get_clipboard = module["get_clipboard"]


class ClipcleanTest(unittest.TestCase):
    def test_two_line_wrap_with_unpadded_final_line(self):
        text = (
            " Done. kitty-paste is now project-owned with its runtime path symlinked; behavior and Kitty mappings are unchanged. Docs and HANDOFF now correctly distinguish synchronous Ctrl+V, asynchronous CLIPBOARD cleanup, and unsupported PRIMARY/middle-click         \n"
            " cleanup."
        )
        expected = (
            "Done. kitty-paste is now project-owned with its runtime path symlinked; behavior and Kitty mappings are unchanged. Docs and HANDOFF now correctly distinguish synchronous Ctrl+V, asynchronous CLIPBOARD cleanup, and unsupported PRIMARY/middle-click cleanup."
        )

        is_tui, width = detect_tui_paste(text)

        self.assertTrue(is_tui)
        self.assertEqual(width, 256)
        self.assertEqual(clean_tui_paste(text, width), expected)

    def test_markdown_hard_break_is_not_tui_padding(self):
        text = "A normal Markdown line ending in two spaces.  \nNext line"
        self.assertEqual(detect_tui_paste(text), (False, 46))

    def test_short_padded_line_is_not_soft_wrap(self):
        text = " Short line".ljust(80) + "\n continuation"
        self.assertEqual(detect_tui_paste(text), (False, 80))

    def test_existing_uniform_padding_detection(self):
        text = " First line".ljust(80) + "\n" + " Second line".ljust(80)
        self.assertEqual(detect_tui_paste(text), (True, 80))

    def test_image_clipboard_decode_failure_is_ignored(self):
        original_run = module["subprocess"].run
        module["subprocess"].run = lambda *args, **kwargs: (_ for _ in ()).throw(
            UnicodeDecodeError("utf-8", b"\x89PNG", 0, 1, "invalid start byte")
        )
        try:
            self.assertIsNone(get_clipboard())
        finally:
            module["subprocess"].run = original_run

    def test_long_paste_uses_one_bracketed_paste(self):
        helper = Path(__file__).with_name("kitty-paste")
        text = "x" * 9000
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            capture = tmp_path / "capture"
            args_capture = tmp_path / "args"
            (tmp_path / "xclip").write_text(
                "#!/bin/sh\n"
                "case \" $* \" in *\" -t TARGETS \"*) printf 'UTF8_STRING\\ntext/plain\\n' ;; *) printf '%s' \"$PASTE_TEXT\" ;; esac\n"
            )
            (tmp_path / "clipclean").write_text("#!/bin/sh\nexit 0\n")
            (tmp_path / "kitten").write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$ARGS_CAPTURE\"\ncat > \"$CAPTURE\"\n"
            )
            for executable in ("xclip", "clipclean", "kitten"):
                (tmp_path / executable).chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{tmp}:{os.environ['PATH']}",
                "KITTY_LISTEN_ON": "unix:/tmp/test-kitty",
                "KITTY_WINDOW_ID": "123",
                "PASTE_TEXT": text,
                "CAPTURE": str(capture),
                "ARGS_CAPTURE": str(args_capture),
            }
            subprocess.run([helper], env=env, check=True)
            payload = capture.read_bytes()
            self.assertEqual(payload, b"\x1b[200~" + text.encode() + b"\x1b[201~")
            args = args_capture.read_text()
            self.assertIn("--match id:123", args)
            self.assertIn("--bracketed-paste disable", args)


if __name__ == "__main__":
    unittest.main()

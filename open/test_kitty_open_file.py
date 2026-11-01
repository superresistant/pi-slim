import os
import subprocess
import tempfile
import unittest
from pathlib import Path

OPENER = Path(__file__).with_name("kitty-open-file")


class OpenFileTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.log = self.root / "calls"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name in ("kitten", "xdg-open"):
            stub = bin_dir / name
            stub.write_text(f'#!/bin/sh\nprintf "%s\\n" "{name} $*" >> {self.log}\n')
            stub.chmod(0o755)
        self.project = self.root / "my project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "src/app.ts").write_text("a\nb\n")
        (self.project / "notes.md").write_text("# n\n")
        (self.project / "shot.png").write_bytes(bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"))
        (self.project / "doc.pdf").write_bytes(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        self.env = {k: v for k, v in os.environ.items() if k not in ("VISUAL", "EDITOR")}
        self.env.update(PATH=f"{bin_dir}:{os.environ['PATH']}", KITTY_LISTEN_ON="unix:/test", KITTY_WINDOW_ID="7")

    def run_opener(self, *args, **env):
        self.log.unlink(missing_ok=True)
        result = subprocess.run([str(OPENER), *args], cwd=self.project, env={**self.env, **env}, capture_output=True, text=True)
        return result.returncode, self.log.read_text().splitlines() if self.log.exists() else []

    def launch(self, *command, cwd=None):
        path = command[-1]
        return [f"kitten @ --to unix:/test launch --next-to id:7 --location=vsplit --cwd {cwd or os.path.dirname(path)} "
                f"--title {os.path.basename(path)} {' '.join(command)}"]

    def test_text_opens_editor_split_at_line(self):
        app = str(self.project / "src/app.ts")
        self.assertEqual(self.run_opener("src/app.ts:2"), (0, self.launch("micro", "+2", app)))
        self.assertEqual(self.run_opener("src/app.ts:2:5"), (0, self.launch("micro", "+2:5", app)))
        self.assertEqual(self.run_opener("src/app.ts#L9"), (0, self.launch("micro", "+9", app)))
        self.assertEqual(self.run_opener("notes.md", EDITOR="nvim"), (0, self.launch("nvim", str(self.project / "notes.md"))))
        self.assertEqual(self.run_opener("src/app.ts:4", EDITOR="nvim"), (0, self.launch("nvim", "+4", app)))

    def test_file_url_from_aa_hyperlink(self):
        url = "file://" + str(self.project).replace(" ", "%20") + "/src/app.ts#L3"
        self.assertEqual(self.run_opener(url), (0, self.launch("micro", "+3", str(self.project / "src/app.ts"))))

    def test_image_split_and_other_files_elsewhere(self):
        code, calls = self.run_opener("shot.png")
        self.assertEqual(code, 0)
        self.assertRegex(calls[0], r"launch .* --location=vsplit .*kitten icat --hold .*/shot\.png$")
        self.assertEqual(self.run_opener("doc.pdf"), (0, [f"xdg-open {self.project}/doc.pdf"]))
        self.assertEqual(self.run_opener("src"), (0, [f"xdg-open {self.project}/src"]))

    def test_elsewhere_and_outside_kitty_use_default_app(self):
        self.assertEqual(self.run_opener("--elsewhere", "notes.md:1"), (0, [f"xdg-open {self.project}/notes.md"]))
        self.assertEqual(self.run_opener("notes.md", KITTY_WINDOW_ID=""), (0, [f"xdg-open {self.project}/notes.md"]))

    def test_missing_file_does_nothing(self):
        self.assertEqual(self.run_opener("e.g"), (1, []))
        self.assertEqual(self.run_opener("nope.md:3"), (1, []))


if __name__ == "__main__":
    unittest.main()

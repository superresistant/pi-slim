import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import unittest


SAVER = Path(__file__).resolve().parents[1] / "bin/kitty-save-session"
FLAG = "PI_HANDOFF_INBOX_ONBOARDING"
ANCHOR_ENV = {
    "PI_ANCHOR_GUIDE": '{"pid":123,"cwd":"/guide cwd","session":"/guide session.jsonl"}',
    "PI_ANCHOR_GUIDE_PID": "123",
    "PI_ANCHOR_GUIDE_CWD": "/guide cwd",
    "PI_ANCHOR_GUIDE_SESSION": "/guide session.jsonl",
    "PI_ANCHOR_HANDOFF": "1",
    "PI_ANCHOR_CONTINUE_SHA256": "old-continuation",
    "PI_ANCHOR_FEEDBACK_SESSION": "/feedback session.jsonl",
    "PI_ANCHOR_ACTIVE": "1",
    "PI_ANCHOR_RUNNER_PID": "456",
}


def launch(*tokens):
    return shlex.join(("launch", *tokens))


class SaveSessionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.fixture = self.home / "input.kitty"
        self.saved = self.home / ".config/kitty/last-session.kitty"
        self.session = self.home / "session with spaces.jsonl"
        self.session.write_text('{"type":"session","id":"exact-session"}\n')
        self.pid = os.getpid() + 1_000_000_000
        self.add_control_socket(self.pid)
        self.live = [{"id": 1, "tabs": [{"id": 1, "windows": [
            {"id": 7, "foreground_processes": [{"pid": self.pid, "cwd": str(self.home), "cmdline": ["pi"]}]},
        ]}]}]
        self.controls = {str(self.pid): {"pid": self.pid, "cwd": str(self.home), "session": str(self.session)}}
        self.serialized = 'kitty-unserialize-data=' + json.dumps({"id": 7})
        binary = self.home / "bin"
        binary.mkdir()
        kitty = binary / "kitty"
        kitty.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys\n"
            f"assert os.environ[{FLAG!r}] == '1'\n"
            f"assert all(os.environ[k] == v for k, v in {ANCHOR_ENV!r}.items())\n"
            "if sys.argv[1:] == ['@', '--to', 'unix:/test-kitty', 'ls']:\n"
            "    print(pathlib.Path(os.environ['SAVE_STATE']).read_text())\n"
            "else:\n"
            "    assert sys.argv[1:-1] == ['@', '--to', 'unix:/test-kitty', "
            "'action', 'save_as_session', '--save-only', '--use-foreground-process']\n"
            "    pathlib.Path(sys.argv[-1]).write_text(pathlib.Path(os.environ['SAVE_FIXTURE']).read_text())\n"
        )
        kitty.chmod(0o700)
        ctl = binary / "pi-ctl"
        ctl.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys, time\n"
            "assert sys.argv[1] == 'status'\n"
            "data = json.loads(pathlib.Path(os.environ['SAVE_CONTROLS']).read_text()).get(pathlib.Path(sys.argv[2]).stem)\n"
            "if data is None: sys.exit(1)\n"
            "if isinstance(data, dict): time.sleep(data.pop('_delay', 0))\n"
            "print(json.dumps(data))\n"
        )
        ctl.chmod(0o700)
        self.env = dict(os.environ, HOME=str(self.home),
                        PATH=f"{binary}:{os.environ['PATH']}",
                        KITTY_LISTEN_ON="unix:/test-kitty",
                        SAVE_FIXTURE=str(self.fixture), SAVE_STATE=str(self.home / 'live.json'),
                        SAVE_CONTROLS=str(self.home / 'controls.json'), **{FLAG: "1", **ANCHOR_ENV})

    def add_control_socket(self, pid):
        path = Path(f'/tmp/pi-ctl-{os.getuid()}/{pid}.sock')
        path.parent.mkdir(mode=0o700, exist_ok=True)
        control = socket.socket(socket.AF_UNIX)
        control.bind(str(path))
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        self.addCleanup(control.close)

    def save(self, text):
        self.fixture.write_text(text)
        Path(self.env['SAVE_STATE']).write_text(json.dumps(self.live))
        Path(self.env['SAVE_CONTROLS']).write_text(json.dumps(self.controls))
        subprocess.run([str(SAVER), "--auto"], env=self.env, check=True,
                       capture_output=True, text=True, timeout=10)
        return self.saved.read_text()

    def test_contaminated_pi_launch_preserves_identity_and_layout_defers_model(self):
        data = json.dumps({"id": 7, "cmd_at_shell_startup": "old-command", "other": "retained"})
        text = "set_layout_state {\"enabled\": true, \"other\": false}\n" + launch(
            f"--env={FLAG}=1", "--env=LEGITIMATE=value with spaces",
            "--env=PI_ANCHOR_GUIDE=1", f"--var=pi_session={self.session}",
            "--var=pi_state=busy", "--cwd=/work with spaces", "--bias=37",
            f"kitty-unserialize-data={data}", "/old/pi", "--model", "provider/model") + "\n"
        result = self.save(text)
        self.assertNotIn(FLAG, result)
        tokens = shlex.split(result.splitlines()[1])
        self.assertEqual(tokens[-3:], ["/usr/bin/pi", "--session", str(self.session)])
        self.assertNotIn('--model', tokens)
        for token in ("--env=LEGITIMATE=value with spaces", "--cwd=/work with spaces", "--bias=37"):
            self.assertIn(token, tokens)
        self.assertNotIn("--env=PI_ANCHOR_GUIDE=1", tokens)
        self.assertFalse(any(t.startswith("--var=pi_") for t in tokens))
        serialized = next(t for t in tokens if t.startswith("kitty-unserialize-data="))
        self.assertEqual(json.loads(serialized.split("=", 1)[1]), {"id": 7, "other": "retained"})
        self.assertEqual(result.splitlines()[0], 'set_layout_state {"enabled": true, "other": false}')

    def test_untagged_missing_session_and_non_pi_launches(self):
        for value in ("1", "0", "_delete_this_env_var_", None):
            flag = f"--env={FLAG}" + (f"={value}" if value is not None else "")
            for identity, command in (([], ["/usr/bin/pi", "--session", str(self.session)]),
                                      ([f"--var=pi_session={self.home / 'missing.jsonl'}"], ["/old/pi"]),
                                      ([], ["/usr/bin/node", "note with spaces.js"])):
                with self.subTest(value=value, command=command):
                    kept = ["--cwd=/exact cwd", *identity, f"--env={FLAG}_OTHER=1", *command]
                    result = self.save(launch(flag, *kept) + "\n")
                    self.assertEqual(shlex.split(result), ["launch", *(t for t in kept if not t.startswith('--var=pi_session='))])

    def test_future_saves_from_flagged_process_stay_clean(self):
        contaminated = launch(f"--env={FLAG}=1", *(f"--env={k}={v}" for k, v in ANCHOR_ENV.items()),
                              "/usr/bin/pi", "--session", str(self.session)) + "\n"
        first = self.save(contaminated)
        second = self.save(contaminated)
        self.assertEqual(first, second)
        self.assertNotIn(FLAG, second)
        self.assertNotIn("--env=PI_ANCHOR_", second)
        self.assertEqual(self.saved.with_suffix(".kitty.bak").read_text(), first)
        self.assertTrue(all(self.env[k] == v for k, v in ANCHOR_ENV.items()))
        self.assertEqual(self.env[FLAG], "1")
        self.assertEqual(self.fixture.read_text(), contaminated)
        self.assertEqual(self.session.read_text(), '{"type":"session","id":"exact-session"}\n')

    def test_anchor_env_stripped_with_or_without_roles_and_session_metadata(self):
        transient = [f"--env={k}={v}" for k, v in ANCHOR_ENV.items()]
        kept = ["--cwd=/exact cwd", "--env=PI_ANCHOR_DELAY_MS=5000", "--env=PI_ANCHOR_CONTEXT_PERCENT=70",
                "--env=PI_ANCHOR_GUIDE_OTHER=keep", "--env=UNRELATED=value with spaces", "--bias=37"]
        for role in (False, True):
            if role:
                self.session.write_text('{"type":"custom","customType":"pi-anchor-role:v1","data":{"version":1,"role":"runner"}}\n')
            original = self.session.read_text()
            for identity, command, expected in (
                ([f"--var=pi_session={self.session}", self.serialized], ["/old/pi", "--model", "provider/model"],
                 [self.serialized, "/usr/bin/pi", "--session", str(self.session)]),
                ([], ["/usr/bin/pi", "--session", str(self.session)], ["/usr/bin/pi", "--session", str(self.session)]),
                ([f"--var=pi_session={self.home / 'missing.jsonl'}"], ["/old/pi", "--model", "provider/model"],
                 ["/old/pi", "--model", "provider/model"]),
                ([], ["/usr/bin/node", "note with spaces.js"], ["/usr/bin/node", "note with spaces.js"]),
            ):
                with self.subTest(role=role, identity=identity, command=command):
                    result = self.save(launch(*transient, *kept, *identity, *command) + "\n")
                    self.assertEqual(shlex.split(result), ["launch", *kept, *expected])
                    self.assertEqual(self.session.read_text(), original)

    def test_anchor_unset_stopped_and_deletion_values_are_transient(self):
        for value in (None, "0", "_delete_this_env_var_"):
            with self.subTest(value=value):
                transient = [f"--env={name}" + (f"={value}" if value is not None else "") for name in ANCHOR_ENV]
                self.assertEqual(self.save(launch(*transient, "/usr/bin/pi") + "\n"), "launch /usr/bin/pi\n")

    def test_exact_foreground_identity_overrides_existing_child_tag(self):
        child = self.home / 'transport-fixture' / 'session.jsonl'
        child.parent.mkdir()
        child.write_text('{"type":"session","id":"child"}\n')
        self.add_control_socket(self.pid + 1)
        self.controls[str(self.pid + 1)] = {"pid": self.pid + 1, "cwd": str(self.home), "session": str(child)}
        self.live[0]['tabs'][0]['windows'].append({
            'id': 8, 'foreground_processes': [{'pid': self.pid + 1, 'cwd': str(self.home), 'cmdline': ['pi']}],
        })
        original = launch('--cwd=' + str(self.home), '--env=UNRELATED=keep', '--var=custom=keep',
                          '--var=pi_session=' + str(child), '--var=pi_state=busy', self.serialized,
                          '/original/pi', '--model', 'provider/model') + '\n'
        first = self.save(original)
        self.assertEqual(shlex.split(first), ['launch', '--cwd=' + str(self.home), '--env=UNRELATED=keep',
                         '--var=custom=keep', self.serialized, '/usr/bin/pi', '--session', str(self.session)])
        self.assertEqual(self.save(original), first)
        self.assertNotIn(str(child), first)
        self.assertEqual(self.fixture.read_text(), original)
        self.assertEqual(child.read_text(), '{"type":"session","id":"child"}\n')

    def test_verified_foreground_does_not_need_a_tag_or_idle_state(self):
        self.controls[str(self.pid)]['idle'] = False
        for tag in ([], ['--var=pi_session=' + str(self.home / 'missing.jsonl')]):
            with self.subTest(tag=tag):
                result = self.save(launch(*tag, self.serialized, '/original/pi') + '\n')
                self.assertEqual(shlex.split(result), ['launch', self.serialized, '/usr/bin/pi', '--session', str(self.session)])

    def test_bad_or_unavailable_control_preserves_foreground_command(self):
        valid = dict(self.controls[str(self.pid)])
        command = [self.serialized, '/original/pi', '--session', '/explicit/session.jsonl', '--model', 'provider/model']
        for response in (None, [], {**valid, 'pid': self.pid + 1}, {**valid, 'cwd': '/other/project'},
                         {**valid, 'session': 'relative.jsonl'}, {**valid, 'session': str(self.home / 'missing.jsonl')},
                         {**valid, '_delay': 2}):
            with self.subTest(response=response):
                self.controls[str(self.pid)] = response
                result = self.save(launch('--var=pi_session=' + str(self.session), '--var=pi_state=busy', *command) + '\n')
                self.assertEqual(shlex.split(result), ['launch', *command])

    def test_missing_ambiguous_and_unknown_window_identity_never_uses_tag(self):
        self.add_control_socket(self.pid + 1)
        foreground = {'pid': self.pid, 'cwd': str(self.home), 'cmdline': ['pi']}
        another = {'pid': self.pid + 1, 'cwd': str(self.home), 'cmdline': ['pi']}
        for windows in ([], [{'id': 7, 'foreground_processes': []}],
                        [{'id': 8, 'foreground_processes': [foreground]}],
                        [{'id': 7, 'foreground_processes': [foreground, another]}],
                        [{'id': 7, 'foreground_processes': [foreground]}, {'id': 7, 'foreground_processes': [foreground]}]):
            with self.subTest(windows=windows):
                self.live = [{'tabs': [{'windows': windows}]}]
                result = self.save(launch('--var=pi_session=' + str(self.session), self.serialized, '/original/pi') + '\n')
                self.assertEqual(shlex.split(result), ['launch', self.serialized, '/original/pi'])

    def test_missing_socket_or_invalid_snapshot_never_uses_tag(self):
        Path(f'/tmp/pi-ctl-{os.getuid()}/{self.pid}.sock').unlink()
        for live in (self.live, None, 'unavailable'):
            with self.subTest(live=live):
                self.live = live
                result = self.save(launch('--var=pi_session=' + str(self.session), self.serialized, '/original/pi') + '\n')
                self.assertEqual(shlex.split(result), ['launch', self.serialized, '/original/pi'])

    def test_non_pi_foreground_keeps_command_despite_polluted_tag(self):
        self.live[0]['tabs'][0]['windows'][0]['foreground_processes'] = [
            {'pid': self.pid + 2, 'cwd': str(self.home), 'cmdline': ['node', 'notes.js']},
        ]
        command = [self.serialized, '/usr/bin/node', 'notes with spaces.js']
        result = self.save(launch('--var=pi_session=' + str(self.session), *command) + '\n')
        self.assertEqual(shlex.split(result), ['launch', *command])

    def test_missing_or_invalid_serialized_id_never_guesses_by_cwd(self):
        for metadata in ([], ['kitty-unserialize-data={}'], ['kitty-unserialize-data={"id":"7"}'],
                         ['kitty-unserialize-data=invalid'], [self.serialized, self.serialized]):
            with self.subTest(metadata=metadata):
                result = self.save(launch('--var=pi_session=' + str(self.session), *metadata, '/original/pi') + '\n')
                self.assertEqual(shlex.split(result), ['launch', *metadata, '/original/pi'])

    def test_mixed_layout_preserved_verbatim_across_saves(self):
        state = {
            'pairs': {'horizontal': False, 'bias': 0.37,
                      'one': {'one': 7, 'two': 8, 'bias': 0.61},
                      'two': {'horizontal': False, 'one': 9, 'two': 10}},
            'opts': {'split_axis': 'horizontal', 'equalize_on_window_close': 'n'},
            'class': 'Splits',
            'maximized': [{'window_id': 7, 'is_horizontal': False,
                           'saved_biases': [{'path': ['one'], 'bias': 0.61}]}],
        }
        text = 'set_layout_state ' + json.dumps(state) + '\nlaunch /bin/sleep 3600\n'
        first = self.save(text)
        self.assertEqual(first, text)
        self.assertEqual(self.save(first), text)
        restored = json.loads(first.splitlines()[0].partition(' ')[2])
        self.assertIs(restored['pairs']['horizontal'], False)
        self.assertIs(restored['maximized'][0]['is_horizontal'], False)

    def test_bus_and_legacy_handoff_env_stripped_without_policy_database(self):
        stale = ('PI_BUS_HANDOFF=old-turn', 'PI_BUS_CWD=/wrong/folder',
                 'PI_BUS_SESSION=/wrong/session.jsonl', 'HANDOFF_PI_MODEL=old/model',
                 'HANDOFF_CHAIN_MODEL=old/model')
        text = 'set_layout_state {"pairs": {"one": 7}}\n' + launch(
            self.serialized, *(f'--env={item}' for item in stale), '--env=OTHER=keep',
            '/usr/bin/pi', '--session', str(self.session)) + '\n'
        result = self.save(text)
        self.assertEqual(result.splitlines()[0], text.splitlines()[0])
        self.assertEqual(shlex.split(result.splitlines()[1]), ['launch', self.serialized,
                         '--env=OTHER=keep', '/usr/bin/pi', '--session', str(self.session)])
        self.assertEqual(self.save(text), result)
        self.assertEqual(self.session.read_text(), '{"type":"session","id":"exact-session"}\n')

    def test_legacy_handoff_env_dropped_but_native_session_kept(self):
        old = launch(self.serialized, '--env=HANDOFF_CHAIN_MODEL=openai-codex/gpt-6-astra',
                     '--env=HANDOFF_PI_MODEL=openai-codex/gpt-6-astra', '--env=OTHER=keep',
                     '/usr/bin/pi', '--session', str(self.session)) + '\n'
        self.assertEqual(shlex.split(self.save(old)), ['launch', self.serialized,
                         '--env=OTHER=keep', '/usr/bin/pi', '--session', str(self.session)])

    def test_verified_resume_never_pins_launch_model(self):
        for model in (['--model', 'openai-codex/gpt-6-astra'],
                      ['--model=openai-codex/gpt-6-astra'],
                      ['--provider', 'openai-codex', '--model', 'gpt-5.6-luna']):
            with self.subTest(model=model):
                text = launch('--cwd=' + str(self.home), self.serialized,
                              '/usr/bin/pi', '--session', str(self.session), *model) + '\n'
                expected = ['launch', '--cwd=' + str(self.home), self.serialized,
                            '/usr/bin/pi', '--session', str(self.session)]
                original = self.session.read_bytes()
                self.assertEqual(shlex.split(self.save(text)), expected)
                self.assertEqual(shlex.split(self.save(text)), expected)
                self.assertEqual(self.session.read_bytes(), original)

    def test_clean_launch_and_command_argument_unchanged(self):
        text = f'launch --cwd="/work with spaces" /usr/bin/node script.js --env={FLAG}=1 --env=PI_ANCHOR_ACTIVE=1\n'
        self.assertEqual(self.save(text), text)


if __name__ == "__main__":
    unittest.main()

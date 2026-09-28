import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('kitty_notes', str(Path(__file__).with_name('kitty-notes')))
spec = importlib.util.spec_from_loader(loader.name, loader)
notes = importlib.util.module_from_spec(spec)
loader.exec_module(notes)


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='notes é space ')
        self.addCleanup(self.temp.cleanup)
        self.cwd = self.temp.name
        self.session = '/sessions/with space é.jsonl'
        self.source = {'id': 42, 'cwd': self.cwd, 'user_vars': {'pi_session': self.session, 'pi_state': 'busy'}}
        self.tabs = [{'tabs': [{'id': 5, 'windows': [self.source]}, {'id': 6, 'windows': [{'id': 99, 'cwd': '/', 'user_vars': {}}]}]}]
        self.calls = []

    def remote(self, command, **kwargs):
        self.calls.append(command)
        return json.dumps(self.tabs) if command[-1] == 'ls' else '100\n'

    def run_launch(self, keep_focus=False):
        with patch.dict(os.environ, {'KITTY_LISTEN_ON': 'unix:/tmp/exact-kitty', 'KITTY_WINDOW_ID': '42', 'PI_SESSION_FILE': 'wrong ambient session'}), patch.object(notes.subprocess, 'check_output', side_effect=self.remote):
            return notes.launch(keep_focus)

    def test_exact_origin_launch_and_no_agent_restore_marker(self):
        self.assertEqual(self.run_launch(True), 100)
        command = self.calls[-1]
        self.assertEqual(command[command.index('--match') + 1], 'id:5')
        self.assertEqual(command[command.index('--next-to') + 1], 'id:42')
        self.assertEqual(command[command.index('--cwd') + 1], self.cwd)
        self.assertEqual(command[command.index('--session') + 1], self.session)
        self.assertIn('--keep-focus', command)
        self.assertIn('--location=vsplit', command)
        self.assertNotIn('--copy-env', command)
        self.assertFalse(any(item.startswith(('pi_session=', 'pi_state=')) for item in command))
        self.assertNotIn('wrong ambient session', command)

    def test_repeat_focus_and_notes_pane_reuse(self):
        existing = {'id': 100, 'cwd': self.cwd, 'user_vars': {'notes_cwd': self.cwd, 'notes_session': 'other session'}}
        self.tabs[0]['tabs'][1]['windows'].append(existing)
        self.assertEqual(self.run_launch(), 100)
        self.assertEqual(self.calls[-1][-3:], ['focus-window', '--match', 'id:100'])
        self.calls.clear()
        self.source['user_vars'] = existing['user_vars']
        self.assertEqual(self.run_launch(True), 42)
        self.assertEqual(len(self.calls), 1)

    def test_gone_origin_never_falls_back_to_active_window(self):
        self.source['id'] = 43
        with self.assertRaisesRegex(RuntimeError, 'no longer exists'):
            self.run_launch()
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()

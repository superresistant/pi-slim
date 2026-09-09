import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { configureEditor, NotesEditor } from './note.mjs';
import { openNote, timestamp } from './store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-notes-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'projet é spaces');
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q', cwd]);
  return { root: join(root, 'notes'), cwd };
}

test('Markdown bytes, provenance, reopening, isolation and exclusive writer', t => {
  const options = { ...fixture(t), session: '/sessions/one.jsonl', originWindow: '42' };
  const note = openNote(options);
  t.after(note.close);
  const text = '\n# Pensées\n  café 👩🏽‍💻 漢字\t\n[paste #1 +20 lines]\r\n  ';
  note.save(text);
  assert.equal(readFileSync(note.path, 'utf8'), text);
  assert.equal(note.metadata.repository, options.cwd);
  assert.equal(note.metadata.session, options.session);
  assert.equal(note.metadata.originWindow, '42');
  assert.match(note.metadata.created, /T.*[+-]\d\d:\d\d$/);
  assert.ok(note.metadata.timezone);
  assert.throws(() => openNote(options), /already open/);
  note.close();
  const reopened = openNote(options);
  t.after(reopened.close);
  assert.equal(reopened.text, text);
  assert.equal(reopened.metadata.created, note.metadata.created);
  note.close();
  assert.throws(() => openNote(options), /already open/);
  const other = openNote({ ...options, session: '/sessions/two.jsonl' });
  t.after(other.close);
  assert.notEqual(other.path, note.path);
  assert.equal(other.text, '');
});

test('stale lock recovery and visible persistence errors', t => {
  const options = fixture(t);
  const note = openNote(options);
  note.close();
  writeFileSync(join(dirname(note.path), '.lock'), '2147483647');
  const reopened = openNote(options);
  t.after(reopened.close);
  mkdirSync(`${reopened.path}.${process.pid}.tmp`);
  assert.throws(() => reopened.save('must not report saved'));
  assert.equal(readFileSync(reopened.path, 'utf8'), '');
});

test('timezone offsets include negative and half-hour zones', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    assert.match(timestamp(new Date('2026-01-01T00:00:00Z')), /05:30:00\.000\+05:30$/);
    process.env.TZ = 'America/St_Johns';
    assert.match(timestamp(new Date('2026-01-01T00:00:00Z')), /20:30:00\.000-03:30$/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('actual Pi editor: Enter, configured undo, Unicode, large paste, render and autosave', t => {
  const options = fixture(t);
  const configDir = join(options.cwd, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'keybindings.json'), JSON.stringify({ 'tui.editor.undo': ['ctrl+z'], 'tui.input.submit': ['shift+enter'] }));
  const { theme } = configureEditor(configDir, options.cwd);
  const terminal = { rows: 24, columns: 80 };
  const screen = { terminal, requestRender() {} };
  const editor = new NotesEditor(screen, theme, { paddingX: 1 });
  editor.disableSubmit = true;
  editor.focused = true;
  editor.onSubmit = () => assert.fail('Notes must never submit');
  const note = openNote(options);
  t.after(note.close);
  editor.onChange = () => note.save(editor.getExpandedText());
  editor.handleInput('café 👩🏽‍💻 漢字\\');
  editor.handleInput('\r');
  assert.equal(editor.getExpandedText(), 'café 👩🏽‍💻 漢字\\\n');
  editor.handleInput('\x1a');
  assert.equal(editor.getExpandedText(), 'café 👩🏽‍💻 漢字\\');
  editor.handleInput('\x1b[13;2u');
  assert.equal(editor.getExpandedText(), 'café 👩🏽‍💻 漢字\\\n');
  const paste = Array.from({ length: 100 }, (_, i) => `line ${i} é`).join('\n');
  editor.handleInput('\x1b[200~' + paste.slice(0, 100));
  editor.handleInput(paste.slice(100) + '\x1b[201~');
  assert.match(editor.getText(), /\[paste #/);
  assert.equal(readFileSync(note.path, 'utf8'), 'café 👩🏽‍💻 漢字\\\n' + paste);
  for (const width of [12, 24, 40, 80]) {
    const lines = editor.render(width);
    assert.ok(lines[0].includes('Notes'));
    assert.equal(terminal.rows, 24);
  }
  editor.handleInput('\x1a');
  assert.equal(editor.getExpandedText(), 'café 👩🏽‍💻 漢字\\\n');
  editor.setText(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(editor.render(80).length, 16);
});

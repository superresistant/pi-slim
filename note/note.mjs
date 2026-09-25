#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openNote } from './store.mjs';

const runtime = process.env.PI_NOTES_RUNTIME || resolve(dirname(fileURLToPath(import.meta.url)), '../pi-local');
const load = relative => import(pathToFileURL(join(runtime, 'packages', relative)));
const tui = await load('tui/dist/index.js');
const { KeybindingsManager } = await load('coding-agent/dist/core/keybindings.js');
const themes = await load('coding-agent/dist/modes/interactive/theme/theme.js');

export function configureEditor(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), cwd = process.cwd()) {
  let settings = {};
  for (const path of [join(agentDir, 'settings.json'), join(cwd, '.pi/settings.json')]) {
    if (existsSync(path)) settings = { ...settings, ...JSON.parse(readFileSync(path, 'utf8')) };
  }
  const keys = KeybindingsManager.create(agentDir);
  keys.setUserBindings({
    ...keys.getUserBindings(),
    'tui.input.newLine': [...new Set([...keys.getKeys('tui.input.newLine'), ...keys.getKeys('tui.input.submit'), 'enter'])],
    'tui.input.submit': [],
  });
  tui.setKeybindings(keys);
  themes.initTheme(settings.theme || 'dark', false);
  return { keys, settings, theme: themes.getEditorTheme() };
}

export async function pasteClipboard(editor, note) {
  const { readClipboardImage, extensionForImageMimeType } = await load('coding-agent/dist/utils/clipboard-image.js');
  const image = await readClipboardImage();
  if (image) {
    const extension = extensionForImageMimeType(image.mimeType);
    if (!extension) throw new Error(`Unsupported clipboard image: ${image.mimeType}`);
    editor.insertTextAtCursor(note.saveImage(Buffer.from(image.bytes), extension));
    return;
  }
  const { readClipboardText } = await load('coding-agent/dist/utils/clipboard.js');
  spawnSync('clipclean', ['-q'], { stdio: 'ignore', timeout: 2000 });
  const text = await readClipboardText();
  if (text) editor.insertTextAtCursor(text);
}

export class NotesEditor extends tui.Editor {
  status = 'Saved';
  origin = '';
  constructor(screen, theme, options) {
    super(screen, theme, { ...options, collapsePastes: false });
  }
  render(width) {
    const terminal = this.tui.terminal;
    const descriptor = Object.getOwnPropertyDescriptor(terminal, 'rows');
    const rows = terminal.rows;
    Object.defineProperty(terminal, 'rows', { configurable: true, value: Math.ceil(rows * 0.66 / 0.3) });
    let lines;
    try { lines = super.render(width); }
    finally {
      if (descriptor) Object.defineProperty(terminal, 'rows', descriptor);
      else delete terminal.rows;
    }
    const label = tui.truncateToWidth(` Notes · ${this.status} · ${this.origin} · Ctrl+Q close `, width, '');
    lines[0] = this.borderColor(label + '─'.repeat(Math.max(0, width - tui.visibleWidth(label))));
    return this.isShowingAutocomplete() ? lines : lines.slice(0, -1);
  }
}

export async function main() {
  const { values } = parseArgs({ options: {
    cwd: { type: 'string', default: process.cwd() },
    session: { type: 'string', default: '' },
    'origin-window': { type: 'string', default: '' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('pi-note [--cwd PATH] [--session SESSION_FILE]\nStandalone Pi editor. Enter: newline. Ctrl+Q: save and close. Autosaves to ~/.local/share/pi-notes.');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Notes requires a terminal');
  const config = configureEditor(undefined, values.cwd);
  const note = openNote({ cwd: values.cwd, session: values.session, originWindow: values['origin-window'] });
  const terminal = new tui.ProcessTerminal();
  const screen = new tui.TuiMainScreen(terminal, config.settings.showHardwareCursor ?? true);
  const editor = new NotesEditor(screen, config.theme, { paddingX: 1 });
  editor.disableSubmit = true;
  editor.origin = note.metadata.cwd.replace(homedir(), '~');
  editor.setText(note.text);
  let savedText = editor.getExpandedText();
  function save() {
    try {
      const text = editor.getExpandedText();
      if (text === savedText) return true;
      const updated = note.save(text);
      savedText = text;
      editor.status = `Saved ${updated.slice(11, 19)}`;
      return true;
    } catch (error) {
      editor.status = `SAVE FAILED: ${error.message}`;
      return false;
    } finally { screen.requestRender(); }
  }
  editor.onChange = save;
  let closing = false;
  async function close(signal = false) {
    if (closing) return;
    const saved = save();
    if (!saved && !signal) return;
    closing = true;
    screen.stop();
    note.close();
    if (!signal) await terminal.drainInput();
    if (!saved) console.error(editor.status);
    process.exit(saved ? 0 : 1);
  }
  screen.addInputListener(data => {
    if (tui.isKeyRelease(data)) return;
    if (tui.matchesKey(data, 'ctrl+q')) { void close(); return { consume: true }; }
    if (config.keys.matches(data, 'app.clipboard.pasteImage')) {
      void pasteClipboard(editor, note).catch(error => {
        editor.status = `PASTE FAILED: ${error.message}`;
        screen.requestRender();
      });
      return { consume: true };
    }
    if (config.keys.matches(data, 'app.editor.external')) {
      const dir = mkdtempSync(join(tmpdir(), 'pi-notes-'));
      const path = join(dir, 'scratch.md');
      writeFileSync(path, editor.getExpandedText(), { mode: 0o600 });
      screen.stop();
      try {
        const result = spawnSync('/bin/sh', ['-c', `${process.env.VISUAL || process.env.EDITOR || 'vi'} "$1"`, 'pi-notes', path], { stdio: 'inherit' });
        if (result.status === 0) editor.setText(readFileSync(path, 'utf8'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
        screen.start();
        screen.requestRender(true);
      }
      return { consume: true };
    }
  });
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => { void close(true); });
  process.on('exit', note.close);
  screen.addChild(editor);
  screen.setFocus(editor);
  screen.start();
  if (process.env.KITTY_WINDOW_ID) {
    for (const [key, value] of Object.entries({ notes_cwd: note.metadata.cwd, notes_session: values.session })) {
      terminal.write(`\x1b]1337;SetUserVar=${key}=${Buffer.from(value).toString('base64')}\x07`);
    }
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`pi-note: ${error.message}`); process.exitCode = 1; });
}

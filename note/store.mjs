import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export function timestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, -1);
  const pad = n => String(Math.abs(n)).padStart(2, '0');
  return `${local}${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

function atomicWrite(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function checkLock(lock, path) {
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid notes lock: ${lock}`);
  try {
    process.kill(pid, 0);
    throw new Error(`Notes already open (PID ${pid}): ${path}`);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    unlinkSync(lock);
  }
}

function legacyNotes(root, dir, cwd) {
  if (!existsSync(root)) return [];
  const notes = [];
  for (const name of readdirSync(root)) {
    const old = join(root, name);
    const originPath = join(old, 'origin.json');
    if (old === dir || !existsSync(originPath)) continue;
    const origin = JSON.parse(readFileSync(originPath, 'utf8'));
    if (origin.cwd !== cwd) continue;
    const scratch = join(old, 'scratch.md');
    const text = existsSync(scratch) ? readFileSync(scratch, 'utf8') : '';
    notes.push({ dir: old, text, created: origin.created || '' });
  }
  return notes.sort((a, b) => a.created.localeCompare(b.created));
}

export function openNote({ cwd, session = '', originWindow = '', root = process.env.PI_NOTES_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'pi-notes') }) {
  cwd = realpathSync(cwd);
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 24);
  const dir = join(root, `${basename(cwd).replace(/[^\p{L}\p{N}_.-]/gu, '_') || 'root'}-${key}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'scratch.md');
  const metadataPath = join(dir, 'origin.json');
  const lock = join(dir, '.lock');
  let legacy = existsSync(path) ? [] : legacyNotes(root, dir, cwd);
  for (const old of legacy) checkLock(join(old.dir, '.lock'), join(old.dir, 'scratch.md'));
  legacy = legacy.filter(old => old.text.trim());
  checkLock(lock, path);
  const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (existsSync(lock)) unlinkSync(lock);
  };
  try {
    let repository = null;
    try { repository = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : {
      cwd, repository, session: session || null, originWindow: originWindow || null,
      created: timestamp(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    let text = existsSync(path) ? readFileSync(path, 'utf8') : legacy.map(old => old.text.trimEnd()).join('\n\n');
    if (legacy.length) metadata.mergedFrom = legacy.map(old => old.dir);
    function save(next) {
      if (next !== text || !existsSync(path)) atomicWrite(path, next);
      text = next;
      metadata.updated = timestamp();
      atomicWrite(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
      return metadata.updated;
    }
    function saveImage(bytes, extension) {
      const images = resolve(dir, 'images');
      mkdirSync(images, { recursive: true, mode: 0o700 });
      const imagePath = join(images, `${randomUUID()}.${extension}`);
      writeFileSync(imagePath, bytes, { mode: 0o600, flag: 'wx' });
      return imagePath;
    }
    save(text);
    return { path, metadata, text, save, saveImage, close };
  } catch (error) {
    close();
    throw error;
  }
}

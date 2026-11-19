// Bounded local observations. No model calls, repair commands, or permission changes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { pathKey } from './store.mjs';

const inside = (file, scope) => file === scope || file.startsWith(`${scope}/`);
const digest = value => createHash('sha256').update(value).digest('hex');
function hasGitContext(root) {
  if(process.env.GIT_DIR || process.env.GIT_WORK_TREE)return true;
  for(let dir=root;;dir=path.dirname(dir)) {
    try {lstatSync(path.join(dir,'.git'));return true;} catch(error) {if(error.code!=='ENOENT')throw error;}
    if(path.dirname(dir)===dir)return false;
  }
}
// Size of a file's content; lines are null for binary content, where they mean nothing.
const measure = buffer => ({ bytes: buffer.length, lines: buffer.subarray(0, 8000).includes(0) ? null
  : buffer.reduce((n, byte) => n + (byte === 10), 0) + (buffer.length && buffer.at(-1) !== 10 ? 1 : 0) });

export function observeWorkspace(task, { exclusions = [], maxFiles = 10_000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const files = {}, root = path.resolve(task.cwd);
  const excluded = exclusions.map(file => pathKey(file, root));
  let bytes = 0, count = 0;
  const record = (file, state = '') => {
    // Resolve aliases for exclusion checks, but never follow a symlink while reading.
    if (excluded.some(scope => inside(pathKey(file, root), scope))) return;
    const full = path.resolve(root, file), relative = path.relative(root, full).replace(/\\/g, '/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return;
    let stat;
    try { stat = lstatSync(full); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isDirectory()) {
      for (const name of readdirSync(full).sort()) record(path.join(full, name), state);
      return;
    }
    if (++count > maxFiles) throw new Error('file limit exceeded');
    bytes += stat?.isFile() ? stat.size : 0;
    if (bytes > maxBytes) throw new Error('byte limit exceeded');
    const content = stat?.isFile() && !stat.isSymbolicLink() ? readFileSync(full) : null;
    files[relative] = { state, hash: !stat ? null : stat.isSymbolicLink()
      ? digest(`link:${readlinkSync(full)}`) : content ? digest(content) : 'special',
      ...(content ? measure(content) : { bytes: null, lines: null }) };
  };
  const git = args => spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  let mode = 'workspace-files', head = null;
  try {
    const top = git(['rev-parse', '--show-toplevel']);
    if (top.status === 0) {
      mode = 'git-visible-plus-declared';
      const repo = top.stdout.trim();
      const status = git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']);
      if (status.error || status.status !== 0) throw new Error('git status unavailable');
      const entries = status.stdout.split('\0');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry) continue;
        if (entry.startsWith('# branch.oid ')) { head = entry.slice(13); continue; }
        if (entry.startsWith('# ')) continue;
        const match = /^([12u]) ((?:\S+ ){7,9})(.*)$/s.exec(entry);
        if (entry.startsWith('? ')) record(path.join(repo, entry.slice(2)), '?');
        else if (match) {
          const fields = entry[0] === '1' ? 7 : entry[0] === '2' ? 8 : 9;
          const parsed = new RegExp(`^[12u] ((?:\\S+ ){${fields}})(.*)$`, 's').exec(entry);
          if (!parsed) throw new Error('unknown git status');
          record(path.join(repo, parsed[2]), parsed[1]);
          if (entry[0] === '2') record(path.join(repo, entries[++i]), 'rename-source');
        } else throw new Error('unknown git status');
      }
      if (head === null) throw new Error('git HEAD unavailable');
      // Ignored outputs explicitly authorized by the task are still observed.
      for (const file of task.write_files) record(file);
    } else {
      const plainFolderWithoutGit=top.error?.code==='ENOENT' && !hasGitContext(root);
      if (!plainFolderWithoutGit && (top.error || !/not a git repository/i.test(top.stderr ?? ''))) throw new Error('git discovery unavailable');
      record(root);
    }
    return { mode, complete: true, head, files, exclusions, files_hashed: count, bytes_hashed: bytes };
  } catch (error) {
    return { mode, complete: false, reason: error.code ?? error.message, head, files: {}, exclusions,
      files_hashed: count, bytes_hashed: bytes };
  }
}

function headFile(cwd, file) {
  const shown = spawnSync('git', ['--no-optional-locks', '-C', path.resolve(cwd), 'cat-file', 'blob', `HEAD:./${file}`], {
    windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  // An unreadable blob leaves the size unknown rather than claiming the file was absent.
  if (shown.error) return { hash: 'unknown', bytes: null, lines: null };
  return shown.status === 0 ? { hash: 'head', ...measure(shown.stdout) } : { hash: null, bytes: null, lines: null };
}

export function compareWorkspace(task, before, after) {
  const complete = before.complete && after.complete && before.mode === after.mode && before.head === after.head;
  const observed = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(file => JSON.stringify(before.files[file]) !== JSON.stringify(after.files[file])).sort();
  const writes = task.write_files.map(file => pathKey(file, task.cwd));
  const outside_scope = observed.filter(file => !writes.some(scope => inside(pathKey(file, task.cwd), scope)));
  // Git status lists only dirty files, so a file missing on one side was clean there and matches HEAD.
  const side = (snapshot, file) => snapshot.files[file]
    ?? (before.mode === 'git-visible-plus-declared' && complete ? headFile(task.cwd, file) : { hash: null, bytes: null, lines: null });
  const changes = observed.map(file => {
    const was = side(before, file), now = side(after, file);
    // Same content with a different git state (for example only staged) is not an edit.
    return { path: file, change: was.hash === now.hash ? 'state-only' : was.hash === null ? 'created' : now.hash === null ? 'deleted' : 'modified',
      bytes: { before: was.bytes, after: now.bytes }, lines: { before: was.lines, after: now.lines } };
  });
  return { mode: before.mode, complete, observed, outside_scope, changes,
    reason: complete ? null : before.reason ?? after.reason ?? 'workspace revision changed',
    exclusions: before.exclusions, files_hashed: before.files_hashed + after.files_hashed,
    bytes_hashed: before.bytes_hashed + after.bytes_hashed };
}

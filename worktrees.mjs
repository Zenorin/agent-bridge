import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function git(repo,args) {
  return execFileSync('git',['-c',`safe.directory=${path.resolve(repo).replace(/\\/g,'/')}`,'-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
}

export function listWorktrees(repo) {
  const blocks=git(repo,['worktree','list','--porcelain','-z']).split('\0\0').filter(Boolean);
  return blocks.map(block=>{
    const entry={};
    for(const line of block.split('\0').filter(Boolean)) { const i=line.indexOf(' '); entry[i<0?line:line.slice(0,i)]=i<0?true:line.slice(i+1); }
    const cwd=path.resolve(entry.worktree);
    let dirty=null,error=null;
    try { dirty=git(cwd,['status','--porcelain']).trim().length>0; } catch { error='worktree unavailable'; }
    return {path:cwd,branch:entry.branch?.replace(/^refs\/heads\//,'' ) ?? null,head:entry.HEAD,locked:!!entry.locked,lock_reason:typeof entry.locked==='string'?entry.locked:null,dirty,error};
  });
}

export function verifyWorktree(repo, target) {
  const absolute=path.resolve(target);
  const key=p=>process.platform==='win32'?p.toLowerCase():p;
  const found=listWorktrees(repo).find(w=>key(w.path)===key(absolute));
  if (!found || !existsSync(found.path)) throw new Error('unknown worktree');
  return realpathSync.native(found.path);
}

// Accepts the worktree root or any folder inside a registered worktree; nothing outside the repo's worktrees.
export function resolveInsideWorktree(repo, target) {
  if (typeof target!=='string' || !target) throw new Error('cwd must be inside a registered worktree');
  let real;
  try { real=realpathSync.native(path.resolve(target)); } catch { throw new Error('cwd must be inside a registered worktree'); }
  if(!statSync(real).isDirectory()) throw new Error('cwd must be a directory inside a registered worktree');
  const key=p=>process.platform==='win32'?p.toLowerCase():p;
  const inside=listWorktrees(repo).some(w=>{
    if(!existsSync(w.path)) return false;
    const rel=path.relative(key(realpathSync.native(w.path)),key(real));
    return rel==='' || (rel!=='..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  });
  if(!inside) throw new Error('cwd must be inside a registered worktree');
  return real;
}

export function createWorktree(repo,{name,base='HEAD'}) {
  if (typeof name!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('invalid worktree name');
  if (typeof base!=='string' || !base || base.startsWith('-') || /[\r\n\0]/.test(base)) throw new Error('invalid base ref');
  const commit=git(repo,['rev-parse','--verify',`${base}^{commit}`]).trim();
  const common=path.resolve(repo,git(repo,['rev-parse','--git-common-dir']).trim());
  const root=path.join(path.dirname(common),'.agent-bridge-worktrees');
  mkdirSync(root,{recursive:true});
  const target=path.join(root,name);
  if(existsSync(target)) throw new Error('worktree path already exists');
  git(repo,['worktree','add','-b',`bridge/${name}`,target,commit]);
  return listWorktrees(repo).find(w=>w.path===target);
}

export function setWorktreeLocked(repo,target,locked) {
  const cwd=verifyWorktree(repo,target);
  git(repo,['worktree',locked?'lock':'unlock',...(locked?['--reason','agent-bridge']:[]),cwd]);
  return listWorktrees(repo).find(w=>w.path===cwd);
}

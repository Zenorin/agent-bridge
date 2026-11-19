// Starts the Windows tray icon (tray.ps1) next to the dashboard. Windows PowerShell 5.1 ships with Windows.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRAY_SCRIPT = fileURLToPath(new URL('./tray.ps1', import.meta.url));
const powershell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function trayArgs(url, parentPid = process.pid) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-STA',
    '-File', TRAY_SCRIPT, '-Url', url, '-ParentPid', String(parentPid)];
}

/** Resolves `exited` (with the exit code) when the user chooses Quit or the script ends. Exit code 3 = already running. */
export function startTray(url, { platform = process.platform, command = powershell(), args = trayArgs(url) } = {}) {
  if (platform !== 'win32') throw new Error('The tray icon is available on Windows only');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('The tray icon only connects to the local dashboard');
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => { child.once('error', () => resolve(-1)); child.once('close', (code) => resolve(code ?? 0)); });
  return { child, exited, close() { if (child.exitCode === null) child.kill(); } };
}

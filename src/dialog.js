// Native "open file" dialog and "reveal in file manager", per platform.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { onPath } from './ffmpeg.js';

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts', 'mts', 'wmv', 'flv', 'mpg', 'mpeg'];

// Runs a command to completion. `missing` is true when the executable does not exist.
function exec(cmd, args) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr, missing: e.code === 'ENOENT' }));
    proc.on('close', (code) => resolve({ code, stdout, stderr, missing: false }));
  });
}

function fireAndForget(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    proc.on('error', () => resolve(false));
    proc.on('spawn', () => { proc.unref(); resolve(true); });
  });
}

export function dialogAvailable() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return Boolean(onPath('zenity') || onPath('kdialog'));
}

export async function openFileDialog() {
  const globs = VIDEO_EXTS.map((e) => `*.${e}`).join(' ');
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Filter = 'Video files|${VIDEO_EXTS.map((e) => `*.${e}`).join(';')}|All files|*.*'`,
      "$d.Title = 'Open video'",
      '$top = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      'if ($d.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName } else { exit 1 }',
    ].join('; ');
    const r = await exec('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
    if (r.missing) return { unsupported: true };
    return r.code === 0 && r.stdout.trim() ? { path: r.stdout.trim() } : { cancelled: true };
  }
  if (process.platform === 'darwin') {
    const r = await exec('osascript', ['-e', 'POSIX path of (choose file of type {"public.movie"} with prompt "Open video")']);
    if (r.missing) return { unsupported: true };
    return r.code === 0 && r.stdout.trim() ? { path: r.stdout.trim() } : { cancelled: true };
  }
  const zenity = await exec('zenity', ['--file-selection', '--title=Open video', `--file-filter=Video files | ${globs}`, '--file-filter=All files | *']);
  if (!zenity.missing) return zenity.code === 0 && zenity.stdout.trim() ? { path: zenity.stdout.trim() } : { cancelled: true };
  const kdialog = await exec('kdialog', ['--title', 'Open video', '--getopenfilename', '.', `Video files (${globs})`]);
  if (!kdialog.missing) return kdialog.code === 0 && kdialog.stdout.trim() ? { path: kdialog.stdout.trim() } : { cancelled: true };
  return { unsupported: true };
}

// Opens the file's folder in the OS file manager, selecting the file where the platform allows it.
export async function reveal(file) {
  if (process.platform === 'win32') return fireAndForget('explorer', [`/select,${file}`]);
  if (process.platform === 'darwin') return fireAndForget('open', ['-R', file]);
  const r = await exec('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
    '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems',
    `array:string:file://${file}`, 'string:']);
  if (r.code === 0) return true;
  return fireAndForget('xdg-open', [path.dirname(file)]);
}

// Native "open file" dialog and "reveal in file manager", per platform.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { onPath } from './ffmpeg.js';

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts', 'mts', 'wmv', 'flv', 'mpg', 'mpeg'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus'];
const MEDIA_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS];

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

function fireAndForget(cmd, args, extra = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...extra });
    proc.on('error', () => resolve(false));
    proc.on('spawn', () => { proc.unref(); resolve(true); });
  });
}

export function dialogAvailable() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return Boolean(onPath('zenity') || onPath('kdialog'));
}

// One path per output line -> { paths } (or { cancelled } when nothing was picked).
function picked(r) {
  const paths = r.code === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  return paths.length ? { paths } : { cancelled: true };
}

// Resolves to { paths: [...] }, { cancelled: true } or { unsupported: true }.
export async function openFileDialog({ multiple = false } = {}) {
  const globs = MEDIA_EXTS.map((e) => `*.${e}`).join(' ');
  const win = (exts) => exts.map((e) => `*.${e}`).join(';');
  if (process.platform === 'win32') {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', // else non-ASCII paths arrive in the OEM code page
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Filter = 'Media files|${win(MEDIA_EXTS)}|Video|${win(VIDEO_EXTS)}|Images|${win(IMAGE_EXTS)}|Audio|${win(AUDIO_EXTS)}|All files|*.*'`,
      "$d.Title = 'Open media'",
      `$d.Multiselect = $${multiple}`,
      '$top = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      'if ($d.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } } else { exit 2 }',
    ].join('; ');
    const r = await exec('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
    if (r.code === 0 && r.stdout.trim()) return picked(r);
    // exit 2 is our own "cancelled"; anything else (missing, Constrained Language Mode, ...) means no dialog.
    return r.code === 2 ? { cancelled: true } : { unsupported: true };
  }
  if (process.platform === 'darwin') {
    const choose = `choose file of type {"public.movie", "public.image", "public.audio"} with prompt "Open media"${multiple ? ' with multiple selections allowed' : ''}`;
    const r = await exec('osascript', ['-e', `set picked to ${choose}`, '-e', 'set out to ""',
      '-e', 'repeat with f in (picked as list)', '-e', 'set out to out & POSIX path of f & linefeed', '-e', 'end repeat', '-e', 'out']);
    return r.missing ? { unsupported: true } : picked(r);
  }
  const zenity = await exec('zenity', ['--file-selection', '--title=Open media', ...(multiple ? ['--multiple', '--separator=\n'] : []),
    `--file-filter=Media files | ${globs}`, '--file-filter=All files | *']);
  if (!zenity.missing) return picked(zenity);
  const kdialog = await exec('kdialog', ['--title', 'Open media', ...(multiple ? ['--multiple', '--separate-output'] : []), '--getopenfilename', '.', `Media files (${globs})`]);
  if (!kdialog.missing) return picked(kdialog);
  return { unsupported: true };
}

// Opens the file's folder in the OS file manager, selecting the file where the platform allows it.
export async function reveal(file) {
  // Explorer wants /select,"path" verbatim; Node's default quoting would wrap the whole token instead.
  if (process.platform === 'win32') return fireAndForget('explorer', [`/select,"${file}"`], { windowsVerbatimArguments: true });
  if (process.platform === 'darwin') return fireAndForget('open', ['-R', file]);
  const r = await exec('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
    '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems',
    `array:string:file://${file}`, 'string:']);
  if (r.code === 0) return true;
  return fireAndForget('xdg-open', [path.dirname(file)]);
}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const unpacked = (p) => p.replace('app.asar', 'app.asar.unpacked');
const ffmpegPath = unpacked(require('ffmpeg-static'));
const ffprobePath = unpacked(require('ffprobe-static').path);

let win;
let current = null; // { proc, cancelled, group }

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 760,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// "1:02:03.5" | "2:03" | "93" -> seconds, or null if invalid
function parseTime(str) {
  const parts = String(str).trim().split(':');
  if (parts.length < 1 || parts.length > 3) return null;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    total = total * 60 + parseFloat(p);
  }
  return total;
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(sec) {
  const s = Math.floor(sec);
  return `${pad(Math.floor(s / 3600))}${pad(Math.floor((s % 3600) / 60))}${pad(s % 60)}`;
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${base}_${i}${ext}`);
  }
  return candidate;
}

function killCurrent() {
  if (!current) return;
  current.cancelled = true;
  try {
    // yt-dlp runs ffmpeg as a child; kill the whole process group so nothing keeps downloading.
    if (current.group) process.kill(-current.proc.pid, 'SIGKILL');
    else current.proc.kill('SIGKILL');
  } catch {
    current.proc.kill('SIGKILL');
  }
}

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('choose-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'mpg', 'mpeg', 'wmv', 'flv'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('default-dir', () => app.getPath('downloads'));

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('cancel', () => killCurrent());

// ---------- Cut a local file ----------

ipcMain.handle('cut', (_e, { input, outDir, start, end, precise }) => {
  return new Promise((resolve) => {
    if (current) return resolve({ ok: false, error: 'Another job is running.' });
    if (!input || !fs.existsSync(input)) return resolve({ ok: false, error: 'Input file not found.' });
    if (!outDir || !fs.existsSync(outDir)) return resolve({ ok: false, error: 'Choose an output folder.' });
    const s = parseTime(start);
    const e = parseTime(end);
    if (s === null) return resolve({ ok: false, error: 'Invalid start time. Use HH:MM:SS, MM:SS or seconds.' });
    if (e === null) return resolve({ ok: false, error: 'Invalid end time. Use HH:MM:SS, MM:SS or seconds.' });
    if (e <= s) return resolve({ ok: false, error: 'End time must be after start time.' });

    const ext = path.extname(input) || '.mp4';
    const base = `${path.basename(input, ext)}_clip_${stamp(s)}-${stamp(e)}`;
    const output = uniquePath(outDir, base, ext);
    const duration = e - s;

    // -ss before -i seeks fast; input is opened read-only, original is never touched.
    const args = ['-hide_banner', '-nostdin', '-n', '-ss', String(s), '-i', input, '-t', String(duration)];
    if (precise) {
      args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k');
      if (/\.(mp4|m4v|mov)$/i.test(ext)) args.push('-movflags', '+faststart');
    } else {
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    }
    args.push('-progress', 'pipe:1', '-nostats', output);

    const proc = spawn(ffmpegPath, args);
    current = { proc, cancelled: false, group: false };
    let stderr = '';
    let buf = '';

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m) {
          const t = parseInt(m[1], 10) / 1e6;
          win.webContents.send('progress', Math.min(1, t / duration));
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on('error', (err) => {
      current = null;
      resolve({ ok: false, error: `Could not start ffmpeg: ${err.message}` });
    });
    proc.on('close', (code) => {
      const cancelled = current && current.cancelled;
      current = null;
      if (cancelled) {
        fs.rmSync(output, { force: true });
        return resolve({ ok: false, error: 'Cancelled.' });
      }
      if (code === 0) return resolve({ ok: true, output });
      fs.rmSync(output, { force: true });
      resolve({ ok: false, error: stderr.trim().split('\n').slice(-4).join('\n') || `ffmpeg exited with code ${code}` });
    });
  });
});

// ---------- Download from a link (yt-dlp) ----------

// yt-dlp is bundled read-only inside the app. On first use it is copied to the user data folder,
// where it can update itself (YouTube changes often, so yt-dlp needs updates every few weeks).
// ffmpeg and ffprobe are symlinked next to it so yt-dlp can merge video + audio and cut sections.
function bundledYtdlp() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'yt-dlp')
    : path.join(__dirname, 'bin', 'yt-dlp_macos');
}

function linkTo(target, linkPath) {
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() && fs.readlinkSync(linkPath) === target) return;
    fs.rmSync(linkPath, { force: true });
  } catch { /* does not exist yet */ }
  fs.symlinkSync(target, linkPath);
}

function ensureTools() {
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const ytdlp = path.join(dir, 'yt-dlp');
  if (!fs.existsSync(ytdlp)) {
    const src = bundledYtdlp();
    if (!fs.existsSync(src)) throw new Error('yt-dlp is missing from the app bundle.');
    fs.copyFileSync(src, ytdlp);
    // The app came from a downloaded .dmg; drop the quarantine flag so Gatekeeper lets the helper run.
    try { execFileSync('xattr', ['-d', 'com.apple.quarantine', ytdlp], { stdio: 'ignore' }); } catch { /* not set */ }
  }
  fs.chmodSync(ytdlp, 0o755);
  linkTo(ffmpegPath, path.join(dir, 'ffmpeg'));
  linkTo(ffprobePath, path.join(dir, 'ffprobe'));
  return { ytdlp, dir };
}

function runYtdlp(args) {
  return new Promise((resolve) => {
    let tools;
    try { tools = ensureTools(); } catch (err) { return resolve({ ok: false, out: err.message }); }
    execFile(tools.ytdlp, args, { timeout: 180000 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`.trim();
      resolve({ ok: !err, out });
    });
  });
}

ipcMain.handle('ytdlp-version', async () => {
  const r = await runYtdlp(['--version']);
  return r.ok ? r.out.split('\n')[0] : null;
});

ipcMain.handle('ytdlp-update', async () => {
  if (current) return { ok: false, message: 'Wait for the current job to finish.' };
  const r = await runYtdlp(['-U']);
  const tail = r.out.split('\n').filter(Boolean).slice(-2).join('\n');
  return { ok: r.ok, message: tail || (r.ok ? 'Done.' : 'Update failed.') };
});

const FORMATS = {
  // H.264 + AAC in MP4 (usually up to 1080p): opens in DaVinci Resolve, Premiere, QuickTime.
  edit: ['-f', 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*[height<=1080]+ba/b',
    '--merge-output-format', 'mp4'],
  // Best available (VP9/AV1, up to 4K) in MKV.
  best: ['-f', 'bv*+ba/b', '--merge-output-format', 'mkv'],
  // Audio only.
  audio: ['-f', 'ba/b', '-x', '--audio-format', 'm4a'],
};

ipcMain.handle('download', (_e, { url, outDir, start, end, quality, precise }) => {
  return new Promise((resolve) => {
    if (current) return resolve({ ok: false, error: 'Another job is running.' });
    if (!/^https?:\/\/\S+$/i.test(String(url || '').trim())) return resolve({ ok: false, error: 'Paste a video link (https://…).' });
    if (!outDir || !fs.existsSync(outDir)) return resolve({ ok: false, error: 'Choose an output folder.' });
    if (!FORMATS[quality]) return resolve({ ok: false, error: 'Choose a quality.' });

    // Start empty or 0 and End empty = whole video.
    const s = String(start || '').trim() ? parseTime(start) : 0;
    const e = String(end || '').trim() ? parseTime(end) : null;
    if (s === null) return resolve({ ok: false, error: 'Invalid start time. Use HH:MM:SS, MM:SS or seconds.' });
    if (String(end || '').trim() && e === null) return resolve({ ok: false, error: 'Invalid end time. Use HH:MM:SS, MM:SS or seconds.' });
    if (e !== null && e <= s) return resolve({ ok: false, error: 'End time must be after start time.' });
    const section = s > 0 || e !== null;

    let tools;
    try { tools = ensureTools(); } catch (err) { return resolve({ ok: false, error: err.message }); }

    const suffix = section ? `_clip_${stamp(s)}-${e === null ? 'end' : stamp(e)}` : '';
    const args = [
      '--newline', '--no-playlist', '--no-mtime', '--quiet', '--progress', '--no-simulate',
      '--ffmpeg-location', tools.dir,
      '-P', outDir,
      '-o', `%(title).80B [%(id)s]${suffix}.%(ext)s`,
      '--progress-template', 'download:PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
      '--print', 'after_move:FILE|%(filepath)s',
      ...FORMATS[quality],
    ];
    if (section) {
      args.push('--download-sections', `*${s}-${e === null ? 'inf' : e}`);
      if (precise) args.push('--force-keyframes-at-cuts');
    }
    args.push('--', url.trim());

    // detached: own process group, so Cancel also stops the ffmpeg that yt-dlp starts.
    const proc = spawn(tools.ytdlp, args, { detached: true });
    current = { proc, cancelled: false, group: true };
    let stderr = '';
    let buf = '';
    let output = null;
    win.webContents.send('progress', -1); // indeterminate until sizes are known

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('FILE|')) { output = line.slice(5).trim(); continue; }
        if (!line.startsWith('PROG|')) continue;
        const [, done, total, estimate] = line.split('|');
        const t = parseFloat(total) || parseFloat(estimate);
        const dn = parseFloat(done);
        win.webContents.send('progress', t > 0 && dn >= 0 ? Math.min(1, dn / t) : -1);
      }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on('error', (err) => {
      current = null;
      resolve({ ok: false, error: `Could not start yt-dlp: ${err.message}` });
    });
    proc.on('close', (code) => {
      const cancelled = current && current.cancelled;
      current = null;
      if (cancelled) return resolve({ ok: false, error: 'Cancelled. Partial files (.part) may remain in the output folder.' });
      if (code === 0) return resolve({ ok: true, output: output || outDir });
      const errLines = stderr.split('\n').filter((l) => /ERROR/.test(l));
      resolve({
        ok: false,
        error: (errLines.slice(-2).join('\n') || stderr.trim().split('\n').slice(-4).join('\n') || `yt-dlp exited with code ${code}`)
          + '\nIf YouTube downloads stopped working, try “Update yt-dlp”.',
      });
    });
  });
});

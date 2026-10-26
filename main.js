const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let win;
let current = null;

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 640,
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

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('cancel', () => {
  if (current) current.cancelled = true, current.proc.kill('SIGKILL');
});

ipcMain.handle('cut', (_e, { input, outDir, start, end, precise }) => {
  return new Promise((resolve) => {
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
    current = { proc, cancelled: false };
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

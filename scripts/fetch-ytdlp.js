// Downloads the standalone macOS build of yt-dlp into bin/ so it can be bundled with the app.
// Runs before `npm start` and `npm run dist`; skips the download if the file is already there.
const fs = require('fs');
const path = require('path');

const URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
const dest = path.join(__dirname, '..', 'bin', 'yt-dlp_macos');

async function main() {
  if (fs.existsSync(dest) && !process.argv.includes('--force')) {
    console.log('yt-dlp already present:', dest);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log('Downloading yt-dlp from', URL);
  const res = await fetch(URL); // follows GitHub's redirect to the release asset
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf, { mode: 0o755 });
  console.log(`Saved ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

# ffmpeg-macos-cut

Two tabs:

- **File** – drag & drop a video, set start/end times, choose an output folder, and save the clip. The original file is never modified (ffmpeg only reads it).
- **Link** – paste a YouTube (or other site supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp)) link. Set Start/End to download only that part, or leave End empty (Start at 0) to download the whole video. Video and audio are merged automatically.

Cut modes (both tabs):
- **Fast**: no re-encode, original quality, start snaps to a keyframe.
- **Precise**: re-encodes around the cut, frame-accurate.

Link quality:
- **For editing**: H.264/AAC in MP4, usually up to 1080p. Opens in DaVinci Resolve, Premiere, QuickTime.
- **Best quality**: up to 4K, VP9/AV1 in MKV.
- **Audio only**: M4A.

**If YouTube downloads stop working**, click **Update yt-dlp** on the Link tab. YouTube changes often and yt-dlp needs updates every few weeks. The app keeps its own copy of yt-dlp in `~/Library/Application Support/Video Cutter/bin`, so updates survive app restarts.

Only download videos you have the right to use; check YouTube's Terms of Service.

## Install (Apple Silicon Mac)
1. Go to **Actions → Build macOS app → latest run** and download the `Video-Cutter-dmg` artifact (or the Releases page for tagged builds).
2. Unzip, open the `.dmg`, drag **Video Cutter** into Applications.
3. The app is not notarized. First launch: right-click the app → **Open** → **Open**.
   If macOS says it's "damaged", run: `xattr -cr "/Applications/Video Cutter.app"`

## Develop
```
npm install
npm start
```
`npm start` and `npm run dist` download the standalone macOS yt-dlp into `bin/` first (`npm run fetch-ytdlp -- --force` to refresh it).

# ffmpeg-macos-cut

Drag & drop a video, set start/end times, choose an output folder, and save the clip. The original file is never modified (ffmpeg only reads it).

- **Fast** mode: stream copy, instant, original quality, start snaps to a keyframe.
- **Precise** mode: re-encodes (H.264/AAC), frame-accurate.

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

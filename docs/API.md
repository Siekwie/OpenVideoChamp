# OpenVideoChamp local API (v1)

The UI is just a client of this API. Everything runs on `http://127.0.0.1:4455`
(override with `--port` / `OVC_PORT`). Only loopback is bound; no auth.

All JSON. Errors: `{ "error": "message" }` with 4xx/5xx.

## Sources (input videos)

### `POST /api/open`  body `{ "path": "/abs/or/relative/file.mp4" }`
Registers a file that already exists on disk. Returns a **Source**:
```json
{
  "id": "s_ab12",
  "name": "clip.mp4",
  "path": "/home/me/Videos/clip.mp4",
  "uploaded": false,
  "size": 123456789,
  "duration": 83.42,
  "width": 1920, "height": 1080, "fps": 60,
  "videoCodec": "h264", "audioCodec": "aac", "hasAudio": true,
  "bitrate": 11800,
  "container": "mov,mp4,m4a,3gp,3g2,mj2"
}
```
`fps` is a number (r_frame_rate evaluated). `bitrate` in kbps. 404 if missing, 400 if ffprobe finds no video stream.

### `POST /api/open/dialog`
Opens the OS native file picker (PowerShell on Windows, osascript on macOS,
zenity/kdialog on Linux). Returns a Source, `{ "cancelled": true }`, or
`{ "unsupported": true }` when no dialog backend exists (UI then falls back
to `<input type=file>` + upload).

### `PUT /api/upload?name=<urlencoded filename>`  (raw body = file bytes)
Streams the body into the temp dir and returns a Source with `"uploaded": true`.
No multipart. Content-Length may be absent (chunked).

### `GET /api/sources/:id`  → Source
### `GET /api/sources/:id/stream`
Serves the file bytes with HTTP Range support and a video content-type so a
`<video src>` can scrub it. `Accept-Ranges: bytes`, 206 on ranges.
### `GET /api/sources/:id/keyframes`  → `{ "times": [0, 2.0, 4.0, ...] }`
Keyframe timestamps (seconds, ascending), computed once with ffprobe and cached.
Used by the UI to show where a fast (stream-copy) cut will actually start.

## Planning + export

### `POST /api/plan`  body = ExportRequest  → Plan
Pure computation, no ffmpeg run. The UI calls this (debounced) whenever a
setting changes to show the estimate line.

**ExportRequest**
```json
{
  "sourceId": "s_ab12",
  "start": 12.5,            // seconds
  "end": 40.0,              // seconds, > start
  "preset": "discord",      // "cut" | "discord" | "discord50" | "discord500" | "steam" | "custom"
  "targetMB": 10,           // only for "custom" (decimal MB, 1 MB = 1,000,000 bytes)
  "cut": "fast",            // "fast" (stream copy, keyframe-snapped) | "precise" (re-encode). Only matters for preset "cut".
  "resolution": "auto",     // "auto" | "source" | 1080 | 720 | 480 | 360   (height; width scales, even numbers)
  "fps": "auto",            // "auto" | "source" | 60 | 30
  "audio": "keep",          // "keep" | "mute"
  "speed": "balanced",      // "fast" | "balanced" | "best"  → x264 preset veryfast | medium | slow
  "encoder": "auto",        // "auto" | any name from /api/info encoders
  "outputPath": null        // optional explicit output file path
}
```
Preset targets (decimal, deliberately under the service limits):
`discord` 10 MB, `discord50` 50 MB, `discord500` 500 MB. `steam` = no size
target, 1080p max, CRF 18, AAC 192k, fps capped at 60, h264 yuv420p + faststart.
`cut` = no size target; `cut:"fast"` → `-c copy`, `cut:"precise"` → CRF 20 re-encode.

**Plan**
```json
{
  "mode": "encode",              // "copy" | "encode"
  "twoPass": true,
  "encoder": "libx264",
  "videoKbps": 1850,             // null in copy mode / CRF mode
  "crf": null,                   // set in CRF mode
  "audioKbps": 96,               // 0 when muted / no audio
  "width": 1280, "height": 720,
  "fps": 60,
  "duration": 27.5,
  "targetBytes": 10000000,       // null when no size target
  "estimatedBytes": 9600000,     // best guess of output size
  "outputPath": "/home/me/Videos/clip_10MB.mp4",   // what export would write (non-clobbering name)
  "warnings": ["Very low bitrate for this length; expect heavy quality loss."],
  "summary": "~9.6 MB · 1280×720 · 60 fps · 1.85 Mbps video + 96 kbps audio · 2-pass"
}
```

### `POST /api/export`  body = ExportRequest  → `{ "jobId": "j_x1" }`
Runs ffmpeg in the background. Only one job runs at a time; more are queued.

### `GET /api/jobs/:id`  → Job
```json
{
  "id": "j_x1",
  "status": "running",           // "queued" | "running" | "done" | "error" | "cancelled"
  "pass": 1, "passes": 2,
  "progress": 0.42,              // 0..1 overall (both passes combined)
  "fps": 213, "speed": 3.5,      // from ffmpeg progress, may be null
  "etaSeconds": 11,
  "plan": { ...Plan },
  "outputPath": "/home/me/Videos/clip_10MB.mp4",
  "outputBytes": 9550123,        // when done
  "error": null,                 // message when status=error
  "log": "last ~40 lines of ffmpeg stderr"
}
```
### `GET /api/jobs/:id/events`  — Server-Sent Events
Emits `data: <Job JSON>` on every change (throttled ~5/s) and a final one with
a terminal status, then closes.
### `POST /api/jobs/:id/cancel`
### `GET /api/jobs/:id/download`  — output file as attachment (only when done)
### `POST /api/jobs/:id/reveal`  — open the output's folder in the OS file manager (selects the file where possible)

## Misc
### `GET /api/info`
```json
{
  "version": "0.1.0",
  "platform": "win32",
  "ffmpeg": { "path": "C:\\...\\ffmpeg.exe", "version": "6.1.1" },
  "encoders": ["libx264", "h264_nvenc"],   // only encoders verified to actually work on this machine
  "dialog": true,                          // native file dialog available
  "defaultOutputDir": "C:\\Users\\me\\Videos\\OpenVideoChamp"
}
```
### `GET /api/docs`  — this document, as text/markdown (what the "copy agent instructions" button copies)
### `GET /`  — the UI. `GET /?path=<urlencoded>` opens that file on load (used by the CLI).

## Export rules (what the planner does)
- `duration = end - start`. Reject if < 0.1 s or outside the source.
- No size target + fast cut: stream copy. `-ss` before `-i`, `-t duration`,
  `-c copy -avoid_negative_ts make_zero -movflags +faststart`. Output container
  mp4 (mkv if source codecs can't go in mp4). The start snaps to the previous keyframe.
- Any re-encode: h264 (libx264 unless encoder says otherwise), `-pix_fmt yuv420p`,
  `-movflags +faststart`, AAC audio, `-ss` before `-i` (frame accurate when re-encoding).
- Size target: `budget = targetBytes * 0.96` (mux overhead + safety).
  `totalKbps = budget*8/duration/1000`. audioKbps = 128 if totalKbps ≥ 1200,
  96 if ≥ 600, else 64 (0 if muted / no audio). `videoKbps = totalKbps - audioKbps`.
  libx264 two-pass with `-b:v videoKbps -maxrate videoKbps*1.5 -bufsize videoKbps*3`.
  Hardware encoders: single pass, `-b:v -maxrate -bufsize`, extra 4 % margin.
- `resolution:"auto"` with a size target: candidates = source height, 1080, 720, 480, 360
  (only those ≤ source). Pick the largest where bits-per-pixel
  `videoKbps*1000 / (w*h*fps) ≥ 0.05`; else 360. `fps:"auto"`: keep source fps,
  but if source fps > 30 and even the chosen resolution gives bpp < 0.05, use 30.
  Without a size target, auto = source (steam caps at 1080p/60).
- Warnings: videoKbps < 150 → heavy quality loss; start snapped by more than 0.5 s in copy mode → say how far.
- Output name: `<name>_cut.mp4`, `<name>_10MB.mp4`, `<name>_steam.mp4`; never
  overwrite — append `-2`, `-3`, ….  Directory: next to the source when the source
  is a real file; `defaultOutputDir` for uploads. `outputPath` in the request overrides.

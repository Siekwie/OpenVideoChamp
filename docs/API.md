# OpenVideoChamp local API (v1)

The UI is just a client of this API. Everything runs on `http://127.0.0.1:4455`
(override with `--port` / `OVC_PORT`). Only loopback is bound; no auth.

All JSON. Errors: `{ "error": "message" }` with 4xx/5xx.

An export is a **sequence**: one or more *clips* (ranges of video sources, or
still images shown for a while) joined by *transitions*, with optional fade
in/out, per-clip volume, a *music* track and loudness normalisation. The
original single-range request (`sourceId`/`start`/`end`) still works and is
treated as a one-clip sequence.

## Sources (input media)

### `POST /api/open`  body `{ "path": "/abs/or/relative/file.mp4" }`
Registers a file that already exists on disk. Returns a **Source**:
```json
{
  "id": "s_ab12",
  "name": "clip.mp4",
  "path": "/home/me/Videos/clip.mp4",
  "uploaded": false,
  "kind": "video",                      // "video" | "image" | "audio"
  "size": 123456789,
  "duration": 83.42,                    // 0 for images
  "width": 1920, "height": 1080, "fps": 60,   // 0/0/0 for audio; fps 0 for images
  "videoCodec": "h264", "audioCodec": "aac", "hasAudio": true,
  "bitrate": 11800,
  "container": "mov,mp4,m4a,3gp,3g2,mj2"
}
```
`fps` is a number (r_frame_rate evaluated). `bitrate` in kbps. 404 if missing,
400 if ffprobe finds neither video nor audio. Images (png, jpeg, webp, bmp, …)
come back as `kind: "image"`; music files (mp3, wav, flac, ogg, m4a, …) as
`kind: "audio"`. A video file with an audio track can also serve as music.

### `POST /api/open/dialog`
Opens the OS native file picker (PowerShell on Windows, osascript on macOS,
zenity/kdialog on Linux). Returns a Source, `{ "cancelled": true }`, or
`{ "unsupported": true }` when no dialog backend exists (UI then falls back
to `<input type=file>` + upload).

### `PUT /api/upload?name=<urlencoded filename>`  (raw body = file bytes)
Streams the body into the temp dir and returns a Source with `"uploaded": true`.
No multipart. Content-Length may be absent (chunked). The UI uses this for
dropped files and for title cards it renders to PNG in the browser.

### `GET /api/sources`  → `[Source, ...]` (everything registered in this run)
### `GET /api/sources/:id`  → Source
### `GET /api/sources/:id/stream`
Serves the file bytes with HTTP Range support and a matching content-type
(video, image or audio) so a `<video src>` / `<img src>` can use it.
`Accept-Ranges: bytes`, 206 on ranges.
### `GET /api/sources/:id/keyframes`  → `{ "times": [0, 2.0, 4.0, ...] }`
Keyframe timestamps (seconds, ascending), computed once with ffprobe and cached
(`[]` for images and audio). Used by the UI to show where a fast (stream-copy)
cut will actually start.

## Planning + export

### `POST /api/plan`  body = ExportRequest  → Plan
Pure computation, no ffmpeg run. The UI calls this (debounced) whenever
anything changes to show the estimate line.

**ExportRequest**
```json
{
  "clips": [                                   // 1..100 clips, in order
    { "sourceId": "s_ab12", "start": 12.5, "end": 40.0, "volume": 1.0, "mute": false },
    { "sourceId": "s_cd34", "start": 3.0,  "end": 9.0,  "volume": 0.5 },
    { "sourceId": "s_img1", "end": 4.0 }         // image: shown for `end` seconds (start is ignored)
  ],
  "transitions": [                             // clips.length - 1 entries; missing ones are cuts
    { "type": "fade", "duration": 0.5 },         // any xfade name from /api/info "transitions", or "cut"
    { "type": "cut" }
  ],
  "fadeIn": 0.5,            // seconds of fade from black / silence at the start (0 = none)
  "fadeOut": 1.0,           // ... and to black at the end
  "music": {                // optional background track
    "sourceId": "s_mp3",    // any source with audio
    "start": 0,             // seconds into the track to start from
    "volume": 0.5,          // linear gain 0..4
    "fadeIn": 1, "fadeOut": 2,
    "loop": true,           // repeat the track if the video is longer
    "mode": "mix"           // "mix" (under the clip audio) | "replace" (drop the clip audio)
  },
  "normalize": false,       // loudnorm to -14 LUFS / -1.5 dBTP
  "preview": false,         // draft render: 480p, CRF 28, ultrafast, written to the temp dir

  "preset": "discord",      // "cut" | "discord" | "discord50" | "discord500" | "steam" | "custom"
  "targetMB": 10,           // only for "custom" (decimal MB, 1 MB = 1,000,000 bytes)
  "cut": "fast",            // "fast" (stream copy, keyframe-snapped) | "precise" (re-encode). Only matters for a plain single clip with preset "cut".
  "resolution": "auto",     // "auto" | "source" | 1080 | 720 | 480 | 360   (height; width scales, even numbers)
  "fps": "auto",            // "auto" | "source" | 60 | 30
  "audio": "keep",          // "keep" | "mute"  (mute = no audio track at all, music included)
  "speed": "balanced",      // "fast" | "balanced" | "best"  → x264 preset veryfast | medium | slow
  "encoder": "auto",        // "auto" | any name from /api/info encoders
  "outputPath": null        // optional explicit output file path
}
```
Legacy shape: `{ "sourceId", "start", "end", ...options }` = one clip, no
transitions, no music.

Preset targets (decimal, deliberately under the service limits):
`discord` 10 MB, `discord50` 50 MB, `discord500` 500 MB. `steam` = no size
target, 1080p max, CRF 18, AAC 192k, fps capped at 60, h264 yuv420p + faststart.
`cut` = no size target; a plain single clip with `cut:"fast"` → `-c copy`,
anything else → CRF 20 re-encode.

**Plan**
```json
{
  "mode": "encode",              // "copy" | "encode"
  "twoPass": true,
  "encoder": "libx264",
  "videoKbps": 1850,             // null in copy mode / CRF mode
  "crf": null,                   // set in CRF mode
  "audioKbps": 96,               // 0 when muted / no audio anywhere
  "width": 1280, "height": 720,
  "fps": 60,
  "duration": 27.5,              // total length of the output (transitions overlap, so < sum of clips)
  "clips": 3, "transitions": 1, "music": true, "preview": false,
  "targetBytes": 10000000,       // null when no size target
  "estimatedBytes": 9600000,     // best guess of output size
  "outputPath": "/home/me/Videos/clip_edit_10MB.mp4",   // what export would write (non-clobbering name)
  "warnings": ["Very low bitrate for this length; expect heavy quality loss."],
  "summary": "~9.6 MB · 1280×720 · 60 fps · 1.85 Mbps video + 96 kbps audio · 2-pass"
}
```

### `POST /api/export`  body = ExportRequest  → `{ "jobId": "j_x1" }`
Runs ffmpeg in the background. Only one job runs at a time; more are queued.
With `"preview": true` the output goes to the temp dir and is meant to be
played back through `GET /api/jobs/:id/stream`.

### `GET /api/jobs/:id`  → Job
```json
{
  "id": "j_x1",
  "status": "running",           // "queued" | "running" | "done" | "error" | "cancelled"
  "preview": false,
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
### `GET /api/jobs/:id/stream`  — output file with Range support (only when done); what the UI plays for previews
### `POST /api/jobs/:id/reveal`  — open the output's folder in the OS file manager (selects the file where possible)

## Misc
### `GET /api/info`
```json
{
  "version": "0.2.0",
  "platform": "win32",
  "ffmpeg": { "path": "C:\\...\\ffmpeg.exe", "version": "6.1.1" },
  "encoders": ["libx264", "h264_nvenc"],   // only encoders verified to actually work on this machine
  "transitions": ["fade", "wipeleft", "fadeblack", "..."],   // xfade transitions this ffmpeg supports
  "dialog": true,                          // native file dialog available
  "defaultOutputDir": "C:\\Users\\me\\Videos\\OpenVideoChamp"
}
```
### `GET /api/docs`  — this document, as text/markdown (what the "copy agent instructions" button copies)
### `GET /`  — the UI. `GET /?path=<urlencoded>` opens that file on load (used by the CLI).

## Export rules (what the planner does)
- Each clip's `duration = end - start`; reject if < 0.1 s or outside the source
  (images: 0.1–600 s). Audio-only sources cannot be clips.
- Transitions eat into both neighbours: `total = Σ clip − Σ transition`. The two
  transitions touching a clip may not add up to more than that clip, and fades
  may not exceed the total. Violations are 400s with a message naming the clip.
- **Copy mode** (`-c copy`, instant, keyframe-snapped) only for a single video
  clip with volume 1, no fades, no music, no normalisation, preset `cut`,
  `cut:"fast"`, not a preview. `-ss` before `-i`, `-t duration`,
  `-avoid_negative_ts make_zero -movflags +faststart`. Output container mp4
  (mkv if the source codecs can't go in mp4). The start snaps to the previous
  keyframe.
- **Everything else is one `-filter_complex` graph**: every clip is seeked with
  `-ss`/`-t` input options (frame accurate on re-encode), conformed with
  `setpts=PTS-STARTPTS,fps=F,scale…,setsar=1,format=yuv420p` and padded/trimmed
  to its exact length; images are `-loop 1` inputs. Clips with a different
  aspect ratio than the output canvas are letter/pillarboxed. Audio is resampled
  to 48 kHz stereo, scaled by `volume`, padded to the clip length and given 5 ms
  edge fades (no clicks at cuts); silent clips get `anullsrc`. A `cut` is a
  `concat`; any other transition is `xfade=transition=T:duration=D:offset=…` plus
  `acrossfade`. Then `fade`/`afade` for fadeIn/fadeOut, the music (`volume`,
  `afade`, `apad`/`atrim` to the total, `-stream_loop -1` when looping,
  `-ss` for `start`) mixed in with `amix=normalize=0` or used alone, and
  `loudnorm=I=-14:TP=-1.5:LRA=11` when `normalize` is set.
- The output **canvas** follows the orientation that is on screen longest
  (landscape unless portrait clips dominate) and, within it, the sharpest video
  source; `fps` is the highest source fps. Images alone give 30 fps.
- Re-encodes are h264 (libx264 unless encoder says otherwise), `-pix_fmt yuv420p`,
  `-movflags +faststart`, AAC 48 kHz audio.
- Size target: `budget = targetBytes * 0.96` (mux overhead + safety).
  `totalKbps = budget*8/duration/1000`. audioKbps = 128 if totalKbps ≥ 1200,
  96 if ≥ 600, else 64 (0 if muted / no audio). `videoKbps = totalKbps - audioKbps`.
  If that is more than 1.5× the (duration-weighted) source bitrate, `videoKbps` is
  capped there (more bits than the source has buy nothing; the output then lands
  well under the target) and auto resolution/fps stay at the source values.
  libx264 two-pass with `-b:v videoKbps -maxrate videoKbps*1.5 -bufsize videoKbps*3`;
  pass 1 runs the video-only graph. Hardware encoders: single pass, extra 4 % margin.
- `resolution:"auto"` with a size target: candidates = source height, 1080, 720, 480, 360
  (only those ≤ source). Pick the largest where bits-per-pixel
  `videoKbps*1000 / (w*h*fps) ≥ 0.05`; else 360. `fps:"auto"`: keep source fps,
  but if source fps > 30 and even the chosen resolution gives bpp < 0.05, use 30.
  Without a size target, auto = source (steam caps at 1080p/60).
- Preview: no size target, height capped at 480, fps at 60, CRF 28, x264
  `ultrafast`, 96 kbps audio, output `preview-*.mp4` in the temp dir (deleted
  when the server exits).
- Warnings: videoKbps < 150 → heavy quality loss; start snapped by more than 0.5 s in copy mode → say how far;
  mixed-fps sequences → "conformed to N fps".
- Output name: `<name>_cut.mp4`, `<name>_10MB.mp4`, `<name>_steam.mp4` (with `_edit_`
  inserted for multi-clip sequences, after the first clip's name); never
  overwrite — append `-2`, `-3`, ….  Directory: next to the first clip's source when it
  is a real file; `defaultOutputDir` for uploads. `outputPath` in the request overrides
  the name, but is subject to the same no-overwrite rule and must not be a source file.
- ffmpeg writes to `<name>.part<ext>` and the file is renamed on success, so a failed
  or cancelled job never leaves a half-written file under the final name.
- In copy mode `videoKbps` is `null` and `audioKbps` is `null` (audio copied) or `0` (muted).
- `resolution` accepts any integer height 144–4320 (clamped to the source, never
  upscaled); `fps` any value 1–240 (never above the source).
- Non-GET requests carrying an `Origin` header from a different origin get 403.
  Scripts and curl send no `Origin` and are unaffected.

## Project files

The UI's *Project → Save* writes a JSON file that `ovc render` can also run
headlessly. Sources are referenced by path (relative paths resolve against the
project file):
```json
{
  "app": "OpenVideoChamp", "version": 1, "name": "trailer",
  "sources": [ { "id": "s_1", "path": "/home/me/Videos/gameplay.mkv", "name": "gameplay.mkv", "kind": "video" },
               { "id": "s_2", "path": "/home/me/Music/theme.mp3", "kind": "audio" } ],
  "clips": [ { "sourceId": "s_1", "start": 12.5, "end": 20, "volume": 1, "mute": false } ],
  "transitions": [],
  "fadeIn": 0.5, "fadeOut": 1, "normalize": true,
  "music": { "sourceId": "s_2", "start": 0, "volume": 0.5, "fadeIn": 1, "fadeOut": 2, "loop": true, "mode": "mix" },
  "output": { "preset": "steam", "targetMB": 10, "cut": "fast", "resolution": "auto", "fps": "auto", "audio": "keep", "speed": "balanced", "encoder": "auto" }
}
```
The `clips`, `transitions`, `fadeIn`, `fadeOut`, `music`, `normalize` and
`output` fields are exactly the ExportRequest fields; the ids only have to be
consistent inside the file.

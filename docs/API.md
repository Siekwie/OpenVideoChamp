# OpenVideoChamp local API (v1)

The UI is just a client of this API. Everything runs on `http://127.0.0.1:4455`
(override with `--port` / `OVC_PORT`). Only loopback is bound; no auth.

All JSON. Errors: `{ "error": "message" }` with 4xx/5xx.

An export is a **sequence**: one or more *clips* (ranges of video sources, or
still images shown for a while) joined by *transitions*, with optional fade
in/out, per-clip volume, a *music* track and loudness normalisation. Each clip
can also be reframed (crop to fill a vertical 9:16 canvas, zoom, a keyframed
pan), played faster or slower, colour graded, turned grey except for one colour,
and given a *hit* (the goal of a highlight) with a white flash and sound effects
on it. The original single-range request (`sourceId`/`start`/`end`) still works
and is treated as a one-clip sequence.

A typical run, start to finish:

1. `POST /api/open` for every video, image and music file → their source ids.
   (Optional: `POST /api/titlecard` for a text card; `POST /api/project` to start
   from a project the user saved in the UI.)
2. `POST /api/plan` with the ExportRequest → size estimate, output path,
   warnings; a 400 says exactly what is wrong.
3. `POST /api/export` with the same body → `jobId`; follow
   `GET /api/jobs/:id/events` (or poll `GET /api/jobs/:id`) until `status` is
   `done`, then read `outputPath`.

A highlight montage (setup → trick → goal → hard cut, faster towards the end,
on the beat of a song), start to finish:

1. `POST /api/open` for every gameplay clip and the song.
2. `POST /api/montage` with `{ clips: [{ sourceId }, ...], music: { sourceId } }`
   → every clip trimmed around its detected goal, the goals and cuts on beats.
3. `POST /api/export` with those clips and transitions plus
   `aspect: "9:16", fit: "fill", look: {...}, music: {...}, preset: "tiktok"`.
   (`ovc montage <clips> --music <song> --render` does all of this from the
   command line and writes a project the UI can open.)

The UI keeps its own sequence in the browser, so what a script does through
the API does not show up in an open UI window. To hand a sequence to the user,
write it as a project file (see the end) and open
`/?project=<path>`.

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
`fps` is a number (r_frame_rate evaluated). `bitrate` in kbps. `uploaded` is
true for files the app stores itself (uploads, title cards); their exports go
to `defaultOutputDir` instead of next to the file. 404 if missing,
400 if ffprobe finds neither video nor audio. Images (png, jpeg, webp, bmp, …)
come back as `kind: "image"`; music files (mp3, wav, flac, ogg, m4a, …) as
`kind: "audio"`. A video file with an audio track can also serve as music.

### `POST /api/open/dialog`  body `{ "multiple": false }` (optional)
Opens the OS native file picker (PowerShell on Windows, osascript on macOS,
zenity/kdialog on Linux). Returns a Source, `{ "cancelled": true }`, or
`{ "unsupported": true }` when no dialog backend exists (UI then falls back
to `<input type=file>` + upload). With `"multiple": true` several files can
be picked and the answer is `{ "sources": [Source, ...], "failed": [{ "path", "error" }] }`.

### `PUT /api/upload?name=<urlencoded filename>`  (raw body = file bytes)
Streams the body into the temp dir and returns a Source with `"uploaded": true`.
No multipart. Content-Length may be absent (chunked). The UI uses this for
dropped files. Temp files are deleted when the server exits; add `&card=1` to
keep the file in `<defaultOutputDir>/title-cards/` instead (what the UI does
with the title cards it draws, so that saved projects still find them).

### `POST /api/titlecard`  → Source (an image)
Renders a title card with ffmpeg's `drawtext` and registers it:
```json
{
  "title": "Coming soon",          // up to 80 characters
  "subtitle": "Wishlist now on Steam",   // up to 120; title, subtitle or logo is required
  "background": "#101418", "color": "#f4f4f6", "accent": "#5a9bff",   // "#rrggbb"
  "style": "center",               // "center" | "left" | "bar" (left aligned with an accent bar)
  "width": 1920, "height": 1080,   // 64..4096, default 1920x1080
  "logoSourceId": "s_img1"         // optional image source drawn above the text
}
```
The PNG is written to `<defaultOutputDir>/title-cards/<title>.png` (never
overwriting). Use the returned id as a clip: `{ "sourceId": "...", "end": 3 }`
shows it for 3 s. 501 if this ffmpeg build has no `drawtext`. The text is sized
to fit the width by an estimate, so check very long titles.

### `POST /api/project`  body `{ "path": "trailer.ovc.json" }` or `{ "project": { ... } }`
Opens a project file (format at the end of this document): registers every
source it names (relative paths resolve against the project file, or against
`"baseDir"` for an inline project; a file that is already registered keeps its
id) and returns the project with ids the server knows:
```json
{
  "app": "OpenVideoChamp", "version": 1, "name": "trailer",
  "sources": [Source, ...],
  "clips": [...], "transitions": [...], "fadeIn": 0.5, "fadeOut": 1, "normalize": true, "music": { ... },
  "aspect": "9:16", "fit": "fill", "look": { ... },
  "output": { "preset": "steam", ... },
  "missing": ["deleted.mp4"],      // sources that could not be opened
  "dropped": 1                     // clips left out because their source is missing
}
```
`{ clips, transitions, fadeIn, fadeOut, music, normalize, aspect, fit, look, ...output }` of the
answer is a complete ExportRequest for `/api/plan` and `/api/export`. 404 if
the file does not exist, 400 if it is not a project.

### `GET /api/sources`  → `[Source, ...]` (everything registered in this run)
### `GET /api/sources/:id`  → Source
### `GET /api/sources/:id/stream`
Serves the file bytes with HTTP Range support and a matching content-type
(video, image or audio) so a `<video src>` / `<img src>` can use it.
`Accept-Ranges: bytes`, 206 on ranges.
### `GET /api/sources/:id/beats`  → beats of a track
```json
{ "bpm": 128, "beats": [0.186, 0.655, 1.124, ...], "downbeats": [0.186, 2.061, ...], "duration": 40.0 }
```
Seconds from the start of the file, for any source with audio (400 otherwise).
Onset detection (spectral flux) → tempo (autocorrelation, weighted towards
100–170 BPM) → dynamic-programming beat tracking; beats sit on the bass drum,
`downbeats` is every fourth beat where the bass hits hardest (bar starts, 4/4
assumed). `bpm` is `null` and the lists are empty when there is no clear beat.
Computed once per source (a few hundred ms per minute of audio) and cached.

### `GET /api/sources/:id/highlights[?start=s&end=s]`  → hit moments of a video
```json
{
  "step": 0.05,
  "hits": [ { "t": 8.3, "score": 1.21 }, { "t": 3.9, "score": 0.34 } ],   // best first, at least 2 s apart, at most 5
  "loudness": [-48.6, -48.7, ...],     // dB per step (null without audio)
  "brightness": [0.503, 0.503, ...],   // 0..1 average picture brightness per step
  "best": 8.3                          // only with ?start/&end: the best hit inside that range, or null
}
```
A hit is a sudden jump in loudness and brightness at the same moment: a goal
explosion, a big impact. `t` is where the jump starts. Video sources only;
computed once per source (decoding the whole file, about 1 s per 10 s of
1080p60) and cached.

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
    { "sourceId": "s_img1", "end": 4.0 },        // image: shown for `end` seconds (start is ignored)
    {                                            // everything a clip can have (all optional):
      "sourceId": "s_rl01", "start": 3.4, "end": 9.2,
      "rate": 1,                // playback speed 0.1..4 (0.5 = slow motion); its length in the video is (end - start) / rate
      "fit": "fill",            // "fill" | "fit" | "blur" (default: the request's `fit`), see "Framing"
      "zoom": 1.2,              // 1..4, crops further in
      "pan": [ { "t": 3.4, "x": 0.3, "y": 0.5 }, { "t": 8.3, "x": 0.7 } ],   // where the frame sits, see "Framing"
      "look": { "saturation": 1.5, "tint": { "color": "#ff3cc8", "amount": 0.3 } },   // this clip's grade, on top of the request's `look`
      "keepColor": { "color": "#e0501e", "range": 0.3, "softness": 0.1, "from": null, "until": 8.3 },
      "hit": 8.3,               // source time of the payoff (the goal); used by flash, sounds and POST /api/montage
      "flash": 0.8,             // 0..1: a white flash on the hit, fading over 0.35 s (needs `hit`)
      "sounds": [ { "sourceId": "s_boom", "at": null, "volume": 1 } ]   // sound effects, see below
    }
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

  "aspect": "auto",         // canvas shape: "auto" (follow the clips) | "16:9" | "9:16" | "1:1" | "4:5"
  "fit": "fit",             // how clips fill the canvas unless they say otherwise: "fit" | "fill" | "blur"
  "look": null,             // colour grade of the whole video (every clip), see "Looks"

  "preset": "discord",      // "cut" | "discord" | "discord50" | "discord500" | "steam" | "tiktok" | "custom"
  "targetMB": 10,           // only for "custom" (decimal MB, 1 MB = 1,000,000 bytes)
  "cut": "fast",            // "fast" (stream copy, keyframe-snapped) | "precise" (re-encode). Only matters for a plain single clip with preset "cut".
  "resolution": "auto",     // "auto" | "source" | 1080 | 720 | 480 | 360   (height; with a fixed aspect the short side)
  "fps": "auto",            // "auto" | "source" | 60 | 30
  "audio": "keep",          // "keep" | "mute"  (mute = no audio track at all, music included)
  "speed": "balanced",      // "fast" | "balanced" | "best"  → x264 preset veryfast | medium | slow
  "encoder": "auto",        // "auto" | any name from /api/info encoders
  "outputPath": null        // optional explicit output file path
}
```
Single-range shape: `{ "sourceId", "start", "end", "volume", "mute", ...everything else }`
is the same as one entry in `clips`. A transition may also be written as just
its name (`"fadeblack"` = 0.5 s) and `duration` defaults to 0.5.

**Framing.** Every clip is fitted into the canvas. `fit` shows the whole
picture with black bars where the shapes differ; `fill` crops it to the canvas
shape (a 16:9 clip in a 9:16 video keeps a vertical slice, 606×1080 of a 1080p
frame, scaled to 1080×1920); `blur` shows the whole picture over a blurred,
slightly darkened copy of itself that fills the canvas. `zoom` crops further in
(keeping the shape). `pan` places the crop window: `x`/`y` 0..1 is its position
in the room it has to move (0 = left/top edge, 0.5 = centred, 1 = right/bottom),
`t` a source time. One entry (or a plain `{ "x", "y" }`) is a fixed position;
several are keyframes the window moves between linearly (held before the first
and after the last), to follow the action. Stills can be zoomed and panned too.

**Looks** (`look`, and per clip): `brightness` -1..1 (0), `contrast` 0..3 (1),
`saturation` 0..3 (1; 0 is black and white), `gamma` 0.1..10 (1), `hue` -180..180
degrees (0), `tint: { "color": "#rrggbb", "amount": 0..1 }` (pushes shadows,
midtones and highlights towards the colour, keeping the lightness), `sharpen`
0..2 (0), `motionBlur` 0..1 (0; blends 2..5 frames). Missing keys keep their
default; a look that changes nothing is `null`. The clip's look is applied
first, then the whole video's.

**Selective colour** (`keepColor`): everything except colours near `color`
turns grey. `range` 0.01..1 is how near (0.3 keeps reds and oranges for an
orange key), `softness` 0..1 the blend at the edge. `from`/`until` are source
times between which it applies (null = from the clip's start / to its end), so
`"until": <hit>` brings the full colour back on the goal.

**Sounds** (per clip, up to 20): each plays `sourceId` (any source with audio)
at source time `at` of the clip, by default the clip's `hit`, or its start
without one. They move with the clip, are mixed over everything else (clip
audio, music; also in "music only" mode) and cut off at the end of the video.
A sound placed outside the trimmed clip is left out with a warning.

Preset targets (decimal, deliberately under the service limits):
`discord` 10 MB, `discord50` 50 MB, `discord500` 500 MB. `steam` = no size
target, 1080p max, CRF 18, AAC 192k, fps capped at 60, h264 yuv420p + faststart.
`tiktok` = the same for TikTok / YouTube Shorts / Instagram Reels, and with
`aspect: "auto"` the canvas is 9:16 (1080×1920 from 1080p clips).
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
  "duration": 27.5,              // length of the output: transitions overlap (so < sum of clips) and every clip is rounded to whole frames
  "clips": 3, "transitions": 1, "music": true, "preview": false,
  "aspect": "auto",              // the canvas shape used ("9:16" for tiktok with aspect auto)
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

### `GET /api/jobs`  → `[Job, ...]` (every job of this run, oldest first)
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

## Montage

### `POST /api/montage`  → an auto-edited sequence
```json
{
  "clips": [ { "sourceId": "s_rl01" }, { "sourceId": "s_rl02", "hit": 9.1 }, { "sourceId": "s_card", "end": 2 } ],
  "music": { "sourceId": "s_song", "start": 12.0, "loop": true },   // optional: whose beats to cut to
  "setup": [5, 2.5],      // seconds of build-up before the hit: first clip → last clip (or one number)
  "hold": 0.8,            // seconds after the hit before the cut
  "sync": "beat",         // "beat" (hits and cuts on beats) | "bar" (hits on downbeats, cuts on beats) | "off"
  "detect": true          // find the hit of clips that have none (see highlights)
}
```
Answer:
```json
{
  "clips": [ { "sourceId": "s_rl01", "start": 3.424, "end": 9.241, "hit": 8.3 }, ... ],   // your clips, other fields kept
  "transitions": [ { "type": "cut", "duration": 0 }, ... ],
  "timeline": [ { "start": 0, "hit": 4.876, "end": 5.817, "onBeat": true }, ... ],   // where each clip lands in the video
  "sync": "beat", "bpm": 128,
  "notes": [ "Clip 3: no hit found, left as it was." ]
}
```
Each clip with a hit is re-trimmed around it: `start = hit - setup`, `end = hit +
hold` (both in output seconds, so a slowed clip uses less footage), with the
setup going linearly from `setup[0]` on the first clip to `setup[1]` on the
last, so the montage speeds up. With music, the hit moves to the beat (or bar)
nearest that build-up and the cut to the beat nearest the hold; beats are
counted from the music's `start`, repeated when it loops. Less footage than
asked for shortens the build-up or hold (and may miss a beat: see `notes`).
Stills and clips without a hit keep their range. A hit given outside the
clip's range is looked for again inside it. The clips are meant to be joined
with hard cuts; the planner keeps every cut within half a frame of the
timeline, so a beat-synced montage stays on the beat.

## Misc
### `GET /api/info`
```json
{
  "version": "0.3.0",
  "platform": "win32",
  "ffmpeg": { "path": "C:\\...\\ffmpeg.exe", "version": "6.1.1" },
  "encoders": ["libx264", "h264_nvenc"],   // only encoders verified to actually work on this machine
  "transitions": ["fade", "wipeleft", "fadeblack", "..."],   // xfade transitions this ffmpeg supports
  "dialog": true,                          // native file dialog available
  "defaultOutputDir": "C:\\Users\\me\\Videos\\OpenVideoChamp"
}
```
### `GET /api/docs`  — this document, as text/markdown (what the "copy agent instructions" button copies)
### `GET /`  — the UI. `GET /?path=<urlencoded>` opens that media file on load, `GET /?project=<urlencoded>` that project file (used by the CLI: `ovc clip.mp4`, `ovc trailer.ovc.json`).

## Export rules (what the planner does)
- Each clip's `duration = end - start`; reject if < 0.1 s or outside the source
  (images: 0.1–600 s). Audio-only sources cannot be clips.
- Transitions eat into both neighbours: `total = Σ clip − Σ transition`. The two
  transitions touching a clip may not add up to more than that clip, and fades
  may not exceed the total. Violations are 400s with a message naming the clip.
- **Copy mode** (`-c copy`, instant, keyframe-snapped) only for a single video
  clip with volume 1 and nothing else applied (rate 1, zoom 1, no look,
  keepColor, flash or sounds), aspect auto, no whole-video look, no fades, no
  music, no normalisation, preset `cut`, `cut:"fast"`, not a preview. `-ss` before `-i`, `-t duration`,
  `-avoid_negative_ts make_zero -movflags +faststart`. Output container mp4
  (mkv if the source codecs can't go in mp4). The start snaps to the previous
  keyframe.
- **Everything else is one `-filter_complex` graph**: every clip is seeked with
  `-ss`/`-t` input options (frame accurate on re-encode), conformed with
  `setpts=PTS-STARTPTS,fps=F,scale…,setsar=1,format=yuv420p` and padded/trimmed
  to its length; images are `-loop 1` inputs. Clips with a different
  aspect ratio than the output canvas are letter/pillarboxed. Audio is resampled
  to 48 kHz stereo, scaled by `volume`, padded to the clip length and given 5 ms
  edge fades (no clicks at cuts); silent clips get `anullsrc`. A `cut` is a
  `concat`; any other transition is `xfade=transition=T:duration=D:offset=…` plus
  `acrossfade`.
- **The timeline is counted in whole output frames.** The clip boundaries are
  rounded to frames (a clip runs from `round(start × fps)` to `round(end × fps)`
  of the nominal timeline, so no cut is ever more than half a frame off and
  many clips never drift), each clip is that many frames (`trim=end_frame=N`)
  and its audio is cut to exactly the same length in samples
  (`apad=whole_len`/`atrim=end_sample`), transitions likewise; otherwise the
  audio, which can be cut anywhere, would run a little further ahead of the
  picture at every clip boundary. All clips
  are put on one timebase (`settb=AVTB`) so that a transition can follow a cut.
  `Plan.duration` is this frame-exact length. Then `fade`/`afade` for fadeIn/fadeOut, the music (`volume`,
  `afade`, `apad`/`atrim` to the total, `-stream_loop -1` when looping,
  `-ss` for `start`) mixed in with `amix=normalize=0` or used alone, and
  `loudnorm=I=-14:TP=-1.5:LRA=11` when `normalize` is set.
- The output **canvas** follows the orientation that is on screen longest
  (landscape unless portrait clips dominate) and, within it, the sharpest video
  source; `fps` is the highest source fps. Images alone give 30 fps. With an
  `aspect` (or the tiktok preset) the canvas has that shape and its short side is
  the largest short side among the video clips (1080 for 1080p clips → 1080×1920
  in 9:16), capped at 1080 for steam/tiktok and at 480 for previews; size targets
  pick the short side by the same bits-per-pixel rule.
- Per clip, in this order: `setpts=(PTS-STARTPTS)/rate`, `fps`, the crop of
  `fit`/`zoom`/`pan` (`crop=w:h:x:y`, keyframes as an expression of `t`), the
  effects (clip look, whole-video look as `eq`/`hue`/`colorbalance`/`unsharp`,
  `colorhold` for keepColor with `enable` for from/until, `tmix` for motion blur,
  the flash as `eq` with per-frame brightness/saturation on the hit), then the
  scale/pad (or for `blur`, a `split` into a small blurred, darkened, re-scaled
  background and the letterboxed picture, `overlay`ed). Effects run before the
  scale so the bars of a letterboxed clip stay black. Clip audio gets `atempo`
  (chained for rates beyond 0.5..2). Sounds are extra inputs after the music,
  `adelay`ed to their place and mixed in with the same `amix`.
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
  mixed-fps sequences → "conformed to N fps"; a flash whose hit is outside the trimmed clip; a sound placed
  outside its clip. A flash without any `hit` is a 400.
- Output name: `<name>_cut.mp4`, `<name>_10MB.mp4`, `<name>_steam.mp4`, `<name>_tiktok.mp4` (with `_edit_`
  inserted for multi-clip sequences, after the first clip's name); never
  overwrite — append `-2`, `-3`, ….  Directory: next to the first clip's source when it
  is the user's own file; `defaultOutputDir` for uploads and title cards
  (`OVC_OUTPUT_DIR` moves that directory). `outputPath` in the request overrides
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
headlessly, `POST /api/project` opens for a script and `/?project=<path>` (or
`ovc trailer.ovc.json`) opens in the UI. Sources are referenced by path
(relative paths resolve against the project file):
```json
{
  "app": "OpenVideoChamp", "version": 1, "name": "trailer",
  "sources": [ { "id": "s_1", "path": "/home/me/Videos/gameplay.mkv", "name": "gameplay.mkv", "kind": "video" },
               { "id": "s_2", "path": "/home/me/Music/theme.mp3", "kind": "audio" } ],
  "clips": [ { "sourceId": "s_1", "start": 12.5, "end": 20, "volume": 1, "mute": false } ],
  "transitions": [],
  "fadeIn": 0.5, "fadeOut": 1, "normalize": true,
  "aspect": "9:16", "fit": "fill", "look": { "contrast": 1.12, "saturation": 1.35, "sharpen": 0.35 },
  "music": { "sourceId": "s_2", "start": 0, "volume": 0.5, "fadeIn": 1, "fadeOut": 2, "loop": true, "mode": "mix" },
  "output": { "preset": "steam", "targetMB": 10, "cut": "fast", "resolution": "auto", "fps": "auto", "audio": "keep", "speed": "balanced", "encoder": "auto" }
}
```
The `clips`, `transitions`, `fadeIn`, `fadeOut`, `music`, `normalize`,
`aspect`, `fit`, `look` and `output` fields are exactly the ExportRequest
fields; the ids only have to be consistent inside the file (clip `sounds` refer
to sources too, and are dropped when their file is missing).

# OpenVideoChamp

A small local video editor for the things game developers actually need to
ship: cut the good 20 seconds out of a recording and shrink it under a size
limit (Discord 10/50/500 MB), or assemble a store trailer from several clips
with transitions, title cards, music and fades and export it for Steam. It runs
a tiny server on 127.0.0.1 that drives ffmpeg, with a browser UI on top and a
plain JSON API underneath. No accounts, no uploads to anyone's cloud; the files
never leave your machine.

What it does:

- **Clips**: add any number of videos (and still images: screenshots, a logo,
  title cards made in the app), trim each one on a filmstrip, split a long
  recording at the playhead, drag to reorder.
- **Transitions**: crossfade, dip to black/white, wipes, slides, shapes and
  effects between clips (everything ffmpeg's `xfade` offers), with a duration
  that is clamped to what fits.
- **Audio**: per-clip volume and mute, fade in/out of the whole video, a music
  track laid under the clips (or replacing their audio) with its own volume,
  start offset, fades and looping, and optional loudness normalisation to
  −14 LUFS so it sounds like other store videos.
- **Preview**: a quick 480p draft render of the whole sequence plays in the
  monitor, so you can check transitions and the music mix before the real export.
- **Export**: Steam (1080p/60 max, high quality), Discord 10/50/500 MB, any
  custom size, or no limit. A single untouched clip is copied without
  re-encoding; everything else is re-encoded frame accurately with two-pass
  rate control when a size target is set.
- **Projects**: save/open `.ovc.json` files, automatic session restore, undo/redo,
  and a CLI that renders a project headlessly.

## Install and run

Requires Node 20+ and ffmpeg. If ffmpeg is not on your PATH, `npm install`
fetches the optional `ffmpeg-static` / `ffprobe-static` binaries; you can also
point `OVC_FFMPEG` / `OVC_FFPROBE` at your own.

    npm install
    npm start                 # http://127.0.0.1:4455, opens your browser

To open the UI with a file already loaded:

    npm start -- some-clip.mp4

Options: `--port 4455` (or `OVC_PORT`), `--no-open`. (`npx openvideochamp`
will work the same way once the package is published to npm.)

## Making a trailer

1. **Add** your recordings, screenshots and a music track: drop them on the
   window, or use *Add → Media file…*. Audio files become the music track;
   *Add → Title card…* renders a text card (title, subtitle, colours, optional
   logo) that you can place anywhere in the sequence.
2. Select a clip and drag the **in / out** handles on the filmstrip, or press
   `I` / `O` at the playhead. `S` splits a long recording so you can keep several
   moments from it and delete the rest.
3. Drag clips in the **sequence** strip to reorder them. Click the marker
   between two clips to choose a **transition** and its length; *Apply to all*
   makes the whole trailer consistent.
4. In the panel on the right, set the **fade in / out**, the **music** volume
   and mix mode, and tick **normalize loudness**. Press `P` for a draft preview.
5. Pick **Steam** (or a Discord size) at the bottom and press **Export**. The
   file lands next to your first clip (or in `~/Videos/OpenVideoChamp` for
   dropped files) and is never overwritten.

## CLI

    ovc cut gameplay.mkv --from 1:02.5 --to 1:30 --preset discord
    ovc cut talk.mp4 --from 12 --to 40 --size 25MB --res 720 --mute
    ovc cut raw.mov --from 0:05 --to 0:20                 # keyframe-snapped stream copy, no re-encode
    ovc cut raw.mov --from 0:05 --to 0:20 --precise       # frame-accurate, CRF 20 re-encode
    ovc cut raw.mov --preset steam --speed best --out ~/Videos/trailer.mp4
    ovc render trailer.ovc.json                           # a project saved by the UI (see docs/API.md)
    ovc render trailer.ovc.json --preset discord50 --out ~/Videos/trailer-50mb.mp4

Times are seconds or `mm:ss(.ms)` / `hh:mm:ss(.ms)`. Progress goes to stderr,
the output path to stdout, and the exit code is 1 on failure. Output files are
never overwritten; a `-2`, `-3`, ... suffix is added instead.

## Shortcuts

In the UI (`?` shows them all):

- Space: play / pause · I / O: set in / out point at the playhead
- Left / Right: step one frame; Shift+Left / Shift+Right: one second
- Home / End: jump to the in / out point
- S: split the clip at the playhead · D: duplicate · Delete: remove
- , / . : previous / next clip · Alt+Left / Alt+Right: move the clip
- Ctrl+Z / Ctrl+Shift+Z: undo / redo · Ctrl+S: save the project
- P: render a draft preview · Enter: export · Esc: cancel the running export

## Local API for agents

Everything the UI does goes through `http://127.0.0.1:4455/api/...`. The
contract is in [docs/API.md](docs/API.md) and is also served by the running
instance at `GET /api/docs` (text/markdown), so a script or an agent can open
files, describe a sequence (clips, transitions, music, fades), ask for a plan,
start an export or a preview and follow its progress over SSE.

# OpenVideoChamp

A small local tool for cutting a clip out of a video and shrinking it to a size
limit (Discord 10/50/500 MB, Steam) without guessing bitrates. It runs a tiny
server on 127.0.0.1 that drives ffmpeg, with a browser UI on top and a plain
JSON API underneath. No accounts, no uploads to anyone's cloud; the files never
leave your machine.

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

## CLI

    ovc cut gameplay.mkv --from 1:02.5 --to 1:30 --preset discord
    ovc cut talk.mp4 --from 12 --to 40 --size 25MB --res 720 --mute
    ovc cut raw.mov --from 0:05 --to 0:20                 # keyframe-snapped stream copy, no re-encode
    ovc cut raw.mov --from 0:05 --to 0:20 --precise       # frame-accurate, CRF 20 re-encode
    ovc cut raw.mov --preset steam --speed best --out ~/Videos/trailer.mp4

Times are seconds or `mm:ss(.ms)` / `hh:mm:ss(.ms)`. Progress goes to stderr,
the output path to stdout, and the exit code is 1 on failure. Output files are
never overwritten; a `-2`, `-3`, ... suffix is added instead.

## Shortcuts

In the UI:

- Space: play / pause
- I / O: set in / out point at the playhead
- Left / Right: step one frame; Shift+Left / Shift+Right: one second
- Home / End: jump to the in / out point
- Enter: export
- Esc: cancel the running export

## Local API for agents

Everything the UI does goes through `http://127.0.0.1:4455/api/...`. The
contract is in [docs/API.md](docs/API.md) and is also served by the running
instance at `GET /api/docs` (text/markdown), so a script or an agent can open a
file, ask for a plan, start an export and follow its progress over SSE.

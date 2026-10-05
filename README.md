# OpenVideoChamp

A small local video editor for the things game developers and players actually
need to ship: cut the good 20 seconds out of a recording and shrink it under a
size limit (Discord 10/50/500 MB), assemble a store trailer from several clips
with transitions, title cards, music and fades and export it for Steam, or turn
a folder of gameplay clips into a vertical highlight montage for TikTok, Shorts
and Reels, every goal landing on the beat. It runs
a tiny server on 127.0.0.1 that drives ffmpeg, with a browser UI on top and a
plain JSON API underneath. No accounts, no uploads to anyone's cloud; the files
never leave your machine.

What it does:

- **Clips**: add any number of videos (and still images: screenshots, a logo,
  title cards made in the app), trim each one on a filmstrip, split a long
  recording at the playhead, drag to reorder.
- **Vertical video**: a 9:16 (or 1:1, 4:5, 16:9) canvas; each clip fills it
  by cropping (drag the frame on the picture to keep the action in view, or
  keyframe it to follow the ball), fits it with black bars, or sits on a blurred
  copy of itself. Zoom per clip.
- **Montage tools**: a *hit* per clip (the goal, found automatically from the
  bang and the flash), a white flash and an impact sound on it, slow motion and
  speed-ups, looks (punchy, vivid, neon, …, or your own contrast / saturation /
  hue / tint / sharpening / motion blur) for the whole video and per clip, and
  *keep one colour*: the clip in grey except one colour, with the full colour
  coming back on the goal.
- **Auto-edit**: finds the goal in every clip, trims a build-up before it and a
  short hold after it (less build-up clip by clip, so the video speeds up) and
  lands every goal and every cut on a beat of the music.
- **Transitions**: crossfade, dip to black/white, wipes, slides, shapes and
  effects between clips (everything ffmpeg's `xfade` offers), with a duration
  that is clamped to what fits.
- **Audio**: per-clip volume and mute, fade in/out of the whole video, a music
  track laid under the clips (or replacing their audio) with its own volume,
  start offset, fades and looping, and optional loudness normalisation to
  −14 LUFS so it sounds like other store videos.
- **Preview**: a quick 480p draft render of the whole sequence plays in the
  monitor, so you can check transitions and the music mix before the real export.
- **Export**: TikTok / Shorts (1080×1920, 60 fps max, high quality), Steam (1080p/60 max), Discord 10/50/500 MB, any
  custom size, or no limit. A single untouched clip is copied without
  re-encoding; everything else is re-encoded frame accurately with two-pass
  rate control when a size target is set.
- **Projects**: save/open `.ovc.json` files, automatic session restore, undo/redo,
  and a CLI that renders a project headlessly.
- **Scriptable**: everything goes through a local JSON API, so a script or an
  AI agent can open files, make title cards, build the sequence and export.

## Install and run

Requires Node 20+ and ffmpeg. If ffmpeg is not on your PATH, `npm install`
fetches the optional `ffmpeg-static` / `ffprobe-static` binaries; you can also
point `OVC_FFMPEG` / `OVC_FFPROBE` at your own.

    npm install
    npm start                 # http://127.0.0.1:4455, opens your browser

To open the UI with a file or a saved project already loaded:

    npm start -- some-clip.mp4
    npm start -- trailer.ovc.json

Options: `--port 4455` (or `OVC_PORT`), `--no-open`. Exports of dropped files
and the title cards you make go to `~/Videos/OpenVideoChamp` (`OVC_OUTPUT_DIR`
changes that). (`npx openvideochamp`
will work the same way once the package is published to npm.)

## Making a trailer

1. **Add** your recordings, screenshots and a music track: drop them on the
   window, or use *Add → Media files…* (pick several at once). Audio files
   become the music track; *Add → Title card…* renders a text card (title,
   subtitle, colours, optional logo) that you can place anywhere in the sequence.
2. Select a clip and drag the **in / out** handles on the filmstrip, or press
   `I` / `O` at the playhead. `S` splits a long recording so you can keep several
   moments from it and delete the rest.
3. Drag clips in the **sequence** strip to reorder them. Click the marker
   between two clips to choose a **transition** and its length (double-click
   for a quick crossfade); *Apply to all* makes the whole trailer consistent.
4. Click the **music** bar under the clips for its volume, fades and mix mode.
   *Whole video* in the panel on the right has the **fade in / out** and
   **normalize loudness**. Press `P` for a draft preview.
5. Pick **Steam** (or a Discord size) at the bottom and press **Export**. The
   line under the estimate says where the file will be saved: next to your
   first clip (or in `~/Videos/OpenVideoChamp` for dropped files and title
   cards). Nothing is ever overwritten.

## Making a vertical highlight montage

The editing recipe of a good highlight montage: start right before the action,
keep the trick readable, hold the goal for a moment, hard cut to the next clip,
and shorten the build-ups towards the end. OpenVideoChamp does that part for you:

1. **Add** your clips (each one with a goal in it) and a song. Select the music
   bar and set *Start in track* to the drop.
2. Press **✦ Auto-edit**. It finds the goal explosion in every clip, trims each
   one to a build-up (5 s on the first clip down to 2.5 s on the last, adjustable)
   plus a short hold, and moves the goals and cuts onto beats (or bars). With
   *Vertical montage style* ticked the video also becomes 9:16 with filled frames,
   punchy colours, hard cuts, the game audio under the music and the TikTok preset.
3. Polish per clip in the right-hand panel:
   - **Framing**: drag the frame on the picture so the car and the ball stay in
     view; *Animate…* and drag at a few moments to follow them. *Blur* instead of
     *Fill* keeps the whole picture.
   - **Colour**: a look, or *Keep one colour* (orange / blue / any) with *Colour
     returns at* set to the goal for a grey build-up that bursts into colour.
   - **Goal / hit**: the goal moment (`H` sets it at the playhead, *Find* detects
     it), a white **flash** and a **sound** (an impact, a whoosh) on it.
   - **Speed**: ½× for slow motion on a trick, 2× to rush a setup.
4. `P` for a draft, then **Export** with *TikTok / Shorts*.

From the command line, the same in one go (writes a project you can open in
the UI to fine-tune):

    ovc montage clips/ --music song.mp3 --render
    ovc montage a.mp4 b.mp4 c.mp4 --music song.mp3 --music-start 0:42 --setup 4,2 --hold 0.6 --sync bar --look neon
    ovc beats song.mp3          # tempo and beat times (JSON)
    ovc hits clip.mp4           # detected goal moments (JSON)

## CLI

    ovc cut gameplay.mkv --from 1:02.5 --to 1:30 --preset discord
    ovc cut talk.mp4 --from 12 --to 40 --size 25MB --res 720 --mute
    ovc cut raw.mov --from 0:05 --to 0:20                 # keyframe-snapped stream copy, no re-encode
    ovc cut raw.mov --from 0:05 --to 0:20 --precise       # frame-accurate, CRF 20 re-encode
    ovc cut raw.mov --preset steam --speed best --out ~/Videos/trailer.mp4
    ovc render trailer.ovc.json                           # a project saved by the UI (see docs/API.md)
    ovc render trailer.ovc.json --preset discord50 --out ~/Videos/trailer-50mb.mp4
    ovc montage clips/ --music song.mp3 --render         # see "Making a vertical highlight montage"

Times are seconds or `mm:ss(.ms)` / `hh:mm:ss(.ms)`. Progress goes to stderr,
the output path to stdout, and the exit code is 1 on failure. Output files are
never overwritten; a `-2`, `-3`, ... suffix is added instead.

## Shortcuts

In the UI (`?` shows them all):

- Space: play / pause · I / O: set in / out point at the playhead
- Left / Right: step one frame; Shift+Left / Shift+Right: one second
- Home / End: jump to the in / out point
- S: split the clip at the playhead · H: set the clip's hit (goal) at the playhead
- D: duplicate · Delete: remove the selected clip, transition or music
- , / . : previous / next clip · Alt+Left / Alt+Right: move the clip
- Ctrl+Z / Ctrl+Shift+Z: undo / redo · Ctrl+S: save the project
- P: render and play a draft preview · Enter: export · Esc: cancel the running export

## Local API for agents

Everything the UI does goes through `http://127.0.0.1:4455/api/...`. The
contract is in [docs/API.md](docs/API.md) and is also served by the running
instance at `GET /api/docs` (text/markdown; *Project → Copy agent
instructions* puts it on the clipboard), so a script or an agent can open
files, render title cards, open a saved project, find the beats of a song and
the goals of a clip, auto-edit a montage, describe a sequence (clips,
transitions, framing, looks, music, fades), ask for a plan, start an export or
a preview and follow its progress over SSE.

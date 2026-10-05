// Auto-edit dialog (POST /api/montage) and the one-click vertical montage style.
import { $ } from './util.js';
import { api } from './api.js';
import { state, edit, clipRequest, clipSource, isImage, setOutput, totalDuration } from './state.js';
import { MONTAGE_STYLE } from './looks.js';

const el = {};
for (const id of ['montageDialog', 'montageForm', 'mSetupA', 'mSetupB', 'mHold', 'mSync', 'mMusicNote', 'mStyle', 'mRedetect', 'mStatus', 'mCancel', 'mGo']) el[id] = $(id);
let toast = () => {};
let busy = false;

// 9:16, filled frame, punchy colours, hard cuts, the game audio under the music, exported for TikTok.
// Called inside an edit() (or wraps itself in one).
function styleSequence() {
  state.aspect = MONTAGE_STYLE.aspect;
  state.fit = MONTAGE_STYLE.fit;
  state.look = structuredClone(MONTAGE_STYLE.look);
  for (const t of state.transitions) { t.type = 'cut'; t.duration = 0; }
  for (const c of state.clips) if (!isImage(c) && c.volume === 1) c.volume = MONTAGE_STYLE.clipVolume;
  if (state.music) Object.assign(state.music, { ...MONTAGE_STYLE.music, start: state.music.start });
  state.normalize = Boolean(state.music);
  if (!state.fadeOut) state.fadeOut = MONTAGE_STYLE.fadeOut;
}

export function applyMontageStyle() {
  if (!state.clips.length) return;
  edit(styleSequence, { structural: true });
  setOutput({ preset: MONTAGE_STYLE.preset });
  toast('Vertical montage style: 9:16, filled, punchy colours, hard cuts, TikTok export');
}

export function openMontage() {
  if (!state.clips.length) return toast('Add your clips first');
  const m = state.music;
  el.mSync.disabled = !m;
  el.mMusicNote.textContent = m
    ? `Cut to ${clipSource({ sourceId: m.sourceId })?.name || 'the music'}${state.beats?.bpm ? ` (${state.beats.bpm} BPM)` : ''}, from ${m.start ? `${m.start.toFixed(1)} s into the track` : 'its start'}.`
    : 'Add a music track first to cut on its beats (the clips are still trimmed around their goals).';
  el.mStatus.textContent = '';
  el.mStatus.className = 'montagestatus';
  el.montageDialog.showModal();
}

async function run(e) {
  e.preventDefault();
  if (busy) return;
  const setup = [Number(el.mSetupA.value) || 5, Number(el.mSetupB.value) || 2.5];
  const hold = Number(el.mHold.value);
  const redetect = el.mRedetect.checked;
  const clips = state.clips.slice();
  const videos = clips.filter((c) => !isImage(c));
  const unknown = videos.filter((c) => redetect || c.hit == null).length;
  busy = true;
  el.mGo.disabled = true;
  el.mStatus.className = 'montagestatus';
  el.mStatus.textContent = [unknown ? `Finding the goal in ${unknown} clip${unknown === 1 ? '' : 's'}` : null,
    state.music && el.mSync.value !== 'off' ? 'reading the beat of the music' : null].filter(Boolean).join(' and ') + '… (a few seconds per clip, the first time)';
  try {
    const r = await api.montage({
      clips: clips.map((c) => ({ ...clipRequest(c), hit: redetect ? null : c.hit })),
      music: state.music ? { sourceId: state.music.sourceId, start: state.music.start, loop: state.music.loop } : null,
      setup, hold: Number.isFinite(hold) ? hold : 0.8, sync: state.music ? el.mSync.value : 'off',
    });
    if (state.clips.length !== clips.length || state.clips.some((c, i) => c !== clips[i])) throw new Error('The sequence changed while it was being analysed; run it again.');
    edit(() => {
      r.clips.forEach((rc, i) => {
        const c = state.clips[i];
        c.start = rc.start; c.end = rc.end; c.hit = rc.hit ?? null;
        if (c.hit == null) c.flash = 0;
      });
      for (const t of state.transitions) { t.type = 'cut'; t.duration = 0; }
      if (el.mStyle.checked) styleSequence();
    }, { structural: true });
    if (el.mStyle.checked) setOutput({ preset: MONTAGE_STYLE.preset });
    el.montageDialog.close();
    const found = r.clips.filter((c) => c.hit != null).length;
    const summary = [`${found} of ${videos.length} goals found`, `${totalDuration().toFixed(1)} s`, r.sync !== 'off' && r.bpm ? `cut to ${r.bpm} BPM` : null].filter(Boolean).join(' · ');
    toast(`Auto-edit: ${summary}${r.notes.length ? `. ${r.notes.join(' ')}` : ''}`, r.notes.length ? 'info' : 'ok');
  } catch (err) {
    el.mStatus.className = 'montagestatus err';
    el.mStatus.textContent = err.message;
  } finally {
    busy = false;
    el.mGo.disabled = false;
  }
}

export function initMontage({ notify }) {
  toast = notify;
  el.montageForm.addEventListener('submit', run);
  el.mCancel.addEventListener('click', () => el.montageDialog.close());
  el.montageDialog.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
}

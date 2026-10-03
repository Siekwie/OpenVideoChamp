// Project files (.ovc.json) and the autosaved session in localStorage.
// Sources are stored by path; loading re-registers them with the server. Uploaded files live in the
// server's temp dir and are gone after a restart, so they may fail to restore.
import { api } from './api.js';
import { state, on, addSource, afterEdit, select, emit, totalDuration } from './state.js';

const AUTOSAVE_KEY = 'ovc.project';
export const PROJECT_VERSION = 1;

export function projectName() {
  const first = state.clips.map((c) => state.sources.get(c.sourceId)).find((s) => s);
  return state.projectName || (first ? first.name.replace(/\.[^.]+$/, '') : 'Untitled');
}

export function serializeProject() {
  const used = new Set([...state.clips.map((c) => c.sourceId), state.music?.sourceId].filter(Boolean));
  return {
    app: 'OpenVideoChamp', version: PROJECT_VERSION, name: projectName(), savedAt: new Date().toISOString(),
    sources: [...used].map((id) => state.sources.get(id)).filter(Boolean).map((s) => ({ id: s.id, path: s.path, name: s.name, kind: s.kind, uploaded: s.uploaded })),
    clips: state.clips.map((c) => ({ id: c.id, sourceId: c.sourceId, start: c.start, end: c.end, volume: c.volume, mute: c.mute })),
    transitions: state.transitions.map((t) => ({ type: t.type, duration: t.duration })),
    fadeIn: state.fadeIn, fadeOut: state.fadeOut, normalize: state.normalize,
    music: state.music ? { ...state.music } : null,
    output: { ...state.output },
  };
}

export function downloadProject() {
  const data = serializeProject();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${data.name.replace(/[\\/:*?"<>|]+/g, '_')}.ovc.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Re-registers each source path; returns { map: oldId -> Source, missing: [name] }.
async function reopenSources(list) {
  const map = new Map();
  const missing = [];
  await Promise.all(list.map(async (s) => {
    if (!s?.path) { missing.push(s?.name || '?'); return; }
    // reuse an already registered source with the same path
    const existing = [...state.sources.values()].find((x) => x.path === s.path);
    if (existing) { map.set(s.id, existing); return; }
    try { map.set(s.id, addSource(await api.open(s.path))); } catch { missing.push(s.name || s.path); }
  }));
  return { map, missing };
}

// Loads a project object into the state. Returns { missing: [names], dropped: n }.
export async function loadProject(data) {
  if (!data || data.app !== 'OpenVideoChamp' || !Array.isArray(data.clips)) throw new Error('Not an OpenVideoChamp project file');
  const { map, missing } = await reopenSources(data.sources || []);
  const clips = [];
  const transitions = [];
  let dropped = 0;
  data.clips.forEach((c, i) => {
    const src = map.get(c.sourceId);
    if (!src || src.kind === 'audio') { dropped++; return; }
    clips.push({ id: c.id || `c${i}`, sourceId: src.id, start: Number(c.start) || 0, end: Number(c.end) || src.duration, volume: Number(c.volume ?? 1), mute: !!c.mute });
    if (clips.length > 1) {
      const t = (data.transitions || [])[i - 1];
      transitions.push(t && t.type ? { type: t.type, duration: Number(t.duration) || 0 } : { type: 'cut', duration: 0 });
    }
  });
  const musicSrc = data.music ? map.get(data.music.sourceId) : null;
  state.clips = clips;
  state.transitions = transitions;
  state.fadeIn = Number(data.fadeIn) || 0;
  state.fadeOut = Number(data.fadeOut) || 0;
  state.normalize = !!data.normalize;
  state.music = musicSrc && musicSrc.hasAudio ? { ...data.music, sourceId: musicSrc.id } : null;
  state.projectName = data.name || null;
  if (data.output && typeof data.output === 'object') Object.assign(state.output, data.output);
  afterEdit({ structural: true });
  emit('output');
  select(clips.length ? { kind: 'clip', index: 0 } : null);
  return { missing, dropped };
}

export async function loadProjectFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON'); }
  return loadProject(data);
}

// ---------- autosave ----------

export function autosave() {
  try {
    if (!state.clips.length) localStorage.removeItem(AUTOSAVE_KEY);
    else localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeProject()));
  } catch { /* storage full or unavailable */ }
}

export function autosaved() {
  try {
    const data = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
    return data && data.clips?.length ? data : null;
  } catch { return null; }
}

export function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}

export function initProject() {
  on('sequence', autosave);
  on('output', autosave);
  window.addEventListener('beforeunload', autosave);
}

export { totalDuration };

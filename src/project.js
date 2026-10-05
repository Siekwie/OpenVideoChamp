// Project files (.ovc.json): a sequence plus the paths of its media. Shared by `ovc render` and POST /api/project.
import path from 'node:path';

const PROJECT_APP = 'OpenVideoChamp';
const OUTPUT_KEYS = ['preset', 'targetMB', 'cut', 'resolution', 'fps', 'audio', 'speed', 'encoder'];

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// Opens every source of a project through `open(absPath, entry)` (resolves to a Source, or throws when the
// file is gone) and rewrites the source ids in clips/music to the opened ones. A clip whose source is
// missing is dropped. Returns the project with `sources` as full Source objects, plus `missing`/`dropped`.
export async function resolveProject(data, { baseDir = process.cwd(), open }) {
  if (!data || typeof data !== 'object' || data.app !== PROJECT_APP || !Array.isArray(data.clips)) throw bad('Not an OpenVideoChamp project file');
  const byId = new Map(), byPath = new Map(), missing = [];
  for (const s of Array.isArray(data.sources) ? data.sources : []) {
    if (!s || typeof s.id !== 'string') continue;
    if (typeof s.path !== 'string' || !s.path) { missing.push(s.name || s.id); continue; }
    const file = path.resolve(baseDir, s.path);
    try {
      if (!byPath.has(file)) byPath.set(file, await open(file, s));
      byId.set(s.id, byPath.get(file));
    } catch { missing.push(s.name || path.basename(file)); }
  }
  const clips = [], transitions = [];
  let dropped = 0;
  data.clips.forEach((c, i) => {
    const src = c && typeof c === 'object' ? byId.get(c.sourceId) : null;
    if (!src || src.kind === 'audio') { dropped++; return; }
    const clip = { ...c, sourceId: src.id };
    // Clip sounds point at sources too; one whose file is gone is left out.
    if (Array.isArray(c.sounds)) {
      clip.sounds = c.sounds.flatMap((snd) => {
        const s = snd && typeof snd === 'object' ? byId.get(snd.sourceId) : null;
        return s?.hasAudio ? [{ ...snd, sourceId: s.id }] : [];
      });
    }
    clips.push(clip);
    if (clips.length > 1) transitions.push(data.transitions?.[i - 1] ?? { type: 'cut', duration: 0 });
  });
  const musicSource = data.music && typeof data.music === 'object' ? byId.get(data.music.sourceId) : null;
  const output = {};
  for (const key of OUTPUT_KEYS) if (data.output?.[key] != null) output[key] = data.output[key];
  return {
    app: PROJECT_APP, version: 1, name: typeof data.name === 'string' ? data.name : null,
    sources: [...byPath.values()],
    clips, transitions,
    fadeIn: Number(data.fadeIn) || 0, fadeOut: Number(data.fadeOut) || 0, normalize: Boolean(data.normalize),
    aspect: typeof data.aspect === 'string' ? data.aspect : 'auto',
    fit: typeof data.fit === 'string' ? data.fit : 'fit',
    look: data.look && typeof data.look === 'object' ? data.look : null,
    music: musicSource?.hasAudio ? { ...data.music, sourceId: musicSource.id } : null,
    output, missing, dropped,
  };
}

// The ExportRequest a resolved project describes; `overrides` win over the project's output options.
export function projectRequest(project, overrides = {}) {
  const { clips, transitions, fadeIn, fadeOut, music, normalize, aspect, fit, look, output } = project;
  return { clips, transitions, fadeIn, fadeOut, music, normalize, aspect, fit, look, ...output, ...overrides };
}

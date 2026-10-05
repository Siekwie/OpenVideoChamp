// Colour looks and the montage style, shared by the UI and the server/CLI (plain data, no DOM).

// Grades for `look` (whole video) and `clips[].look`. Values as in docs/API.md.
export const LOOKS = {
  none: { label: 'None', look: null },
  punchy: { label: 'Punchy', look: { contrast: 1.12, saturation: 1.35, sharpen: 0.35 } },
  vivid: { label: 'Vivid', look: { contrast: 1.2, saturation: 1.6, brightness: 0.02, sharpen: 0.4 } },
  neon: { label: 'Neon', look: { contrast: 1.18, saturation: 1.55, sharpen: 0.3, tint: { color: '#ff3cc8', amount: 0.35 } } },
  cool: { label: 'Cool', look: { contrast: 1.1, saturation: 1.25, tint: { color: '#3c8cff', amount: 0.3 } } },
  warm: { label: 'Warm', look: { contrast: 1.08, saturation: 1.2, tint: { color: '#ff9a3c', amount: 0.3 } } },
  mono: { label: 'Black & white', look: { contrast: 1.2, saturation: 0 } },
};

// The look name whose values match `look` exactly, or null for a custom grade.
export function lookName(look) {
  const key = (l) => JSON.stringify(l ?? null);
  return Object.keys(LOOKS).find((name) => key(LOOKS[name].look) === key(look ?? null)) ?? null;
}

// Selective colour presets ("keep only this colour"): Rocket League's orange team, the blue team, red.
export const KEEP_COLORS = [
  { label: 'Orange / red', color: '#e0501e' },
  { label: 'Blue', color: '#2a6cf0' },
  { label: 'Red', color: '#d81e1e' },
  { label: 'Green', color: '#2ec850' },
];

// The vertical highlight-montage style: 9:16 filled frame, punchy colours, hard cuts, the game audio
// under the music, exported for TikTok / Shorts / Reels.
export const MONTAGE_STYLE = {
  aspect: '9:16',
  fit: 'fill',
  look: LOOKS.punchy.look,
  clipVolume: 0.6,
  music: { volume: 0.9, fadeIn: 0, fadeOut: 1.5, loop: true, mode: 'mix' },
  fadeOut: 0.3,
  preset: 'tiktok',
  montage: { setup: [5, 2.5], hold: 0.8, sync: 'beat' },
};

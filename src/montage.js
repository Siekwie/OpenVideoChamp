// Auto-edit for highlight montages, the "setup → trick → goal → hard cut" rhythm: every clip is trimmed
// around its hit (the goal), the setup before it shrinking from the first clip to the last so the video
// speeds up, a short hold after it, and with music the hits and the cuts land on beats.
// Pure functions; the server finds the hits and beats (analysis.js) and calls arrangeMontage.

export const MONTAGE_DEFAULTS = { setup: [5, 2.5], hold: 0.8, sync: 'beat', minSetup: 0.6 };
const SYNCS = ['beat', 'bar', 'off'];
const MIN_HOLD = 0.15;

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function seconds(value, name, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be between ${min} and ${max} seconds`);
  return n;
}

// { setup: [first, last] | n, hold, sync, minSetup } with defaults.
export function normalizeMontage(input = {}) {
  if (!input || typeof input !== 'object') throw bad('Expected a JSON object');
  const d = MONTAGE_DEFAULTS;
  const raw = input.setup == null ? d.setup : Array.isArray(input.setup) ? input.setup : [input.setup, input.setup];
  if (raw.length < 1 || raw.length > 2) throw bad('setup must be a number or [first, last]');
  const setup = [seconds(raw[0], 'setup', 0.2, 30), seconds(raw[1] ?? raw[0], 'setup', 0.2, 30)];
  const sync = input.sync ?? d.sync;
  if (!SYNCS.includes(sync)) throw bad(`Invalid sync: ${JSON.stringify(input.sync)} (beat, bar or off)`);
  return {
    setup,
    hold: seconds(input.hold, 'hold', 0, 10, d.hold),
    sync,
    minSetup: seconds(input.minSetup, 'minSetup', 0, 10, d.minSetup),
  };
}

const r3 = (t) => Math.round(t * 1000) / 1000;

// The grid value in [lo, hi] closest to `want`, or null.
function nearest(grid, lo, hi, want) {
  let best = null;
  for (const b of grid) {
    if (b < lo - 1e-6) continue;
    if (b > hi + 1e-6) break;
    if (best == null || Math.abs(b - want) < Math.abs(best - want)) best = b;
  }
  return best;
}

// Beats of a music track on the output timeline: shifted by where the track starts, repeated when it loops.
export function beatGrid({ beats = [], downbeats = [], duration = 0 } = {}, { start = 0, loop = false, until = 600 } = {}) {
  const shift = (list) => {
    const one = list.filter((b) => b >= start).map((b) => b - start);
    const period = duration - start;
    if (!loop || !(period > 1) || !one.length) return one.map(r3);
    const out = [];
    for (let k = 0; k * period < until; k++) for (const b of one) out.push(r3(b + k * period));
    return out;
  };
  return { beats: shift(beats), downbeats: shift(downbeats) };
}

// clips: [{ start, end, hit, rate?, image?, duration (of the source) , ... }]. Clips without a hit and
// stills keep their range. `grid` is { beats, downbeats } in output seconds (see beatGrid) or null.
// Returns { clips (same objects, new start/end), timeline: [{ start, hit, end, onBeat }], notes }.
export function arrangeMontage(clips, options = {}, grid = null) {
  const o = normalizeMontage(options);
  const sync = grid && grid.beats?.length ? o.sync : 'off';
  const hitGrid = sync === 'bar' && grid.downbeats?.length ? grid.downbeats : grid?.beats || [];
  const cutGrid = grid?.beats || [];
  const ranked = clips.filter((c) => !c.image && c.hit != null);
  const notes = [];
  const timeline = [];
  let cursor = 0;
  const out = clips.map((c, k) => {
    const rate = c.image ? 1 : c.rate || 1;
    if (c.image || c.hit == null) {
      if (!c.image) notes.push(`Clip ${k + 1}: no hit found, left as it was.`);
      const len = (c.end - c.start) / rate;
      timeline.push({ start: r3(cursor), hit: null, end: r3(cursor + len), onBeat: false });
      cursor += len;
      return { ...c };
    }
    const rank = ranked.length > 1 ? ranked.indexOf(c) / (ranked.length - 1) : 0;
    const want = o.setup[0] + (o.setup[1] - o.setup[0]) * rank;
    // Room on the output timeline before and after the hit, given the footage there is.
    const before = c.hit / rate, after = Math.max(0, (c.duration - c.hit) / rate);
    const minSetup = Math.min(o.minSetup, before);
    let setup = Math.min(Math.max(want, minSetup), before);
    let onBeat = false;
    if (sync !== 'off') {
      const b = nearest(hitGrid, cursor + minSetup, cursor + before, cursor + want);
      if (b != null) { setup = b - cursor; onBeat = true; } else notes.push(`Clip ${k + 1}: not enough footage before the hit to reach a ${sync}.`);
    }
    const hitAt = cursor + setup;
    const minHold = Math.min(MIN_HOLD, after);
    let hold = Math.min(Math.max(o.hold, minHold), after);
    if (sync !== 'off') {
      const b = nearest(cutGrid, hitAt + minHold, hitAt + after, hitAt + o.hold);
      if (b != null) hold = b - hitAt;
    }
    // Never shorter than the planner allows (0.1 s of source).
    if ((setup + hold) * rate < 0.12) hold = Math.min(after, 0.12 / rate - setup);
    const start = r3(Math.max(0, c.hit - setup * rate));
    const end = r3(Math.min(c.duration, c.hit + hold * rate));
    // Carry on from the rounded range, so a long montage does not drift off the grid by milliseconds.
    timeline.push({ start: r3(cursor), hit: r3(cursor + (c.hit - start) / rate), end: r3(cursor + (end - start) / rate), onBeat });
    cursor += (end - start) / rate;
    return { ...c, start, end };
  });
  return { clips: out, timeline, notes, sync };
}

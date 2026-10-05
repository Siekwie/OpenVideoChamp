import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeMontage, beatGrid, normalizeMontage } from '../src/montage.js';
import { planExport, resolveSequence, normalizeRequest, timeline } from '../src/plan.js';

const clip = (hit, duration = 20, over = {}) => ({ sourceId: 's_v', start: 0, end: duration, hit, duration, ...over });

test('without music: the setup shrinks from the first clip to the last, each clip holds after its hit', () => {
  const r = arrangeMontage([clip(10), clip(12), clip(8)], { setup: [5, 2], hold: 1, sync: 'off' });
  assert.deepEqual(r.clips.map((c) => [c.start, c.end]), [[5, 11], [8.5, 13], [6, 9]]);
  assert.deepEqual(r.timeline.map((t) => [t.start, t.hit, t.end]), [[0, 5, 6], [6, 9.5, 10.5], [10.5, 12.5, 13.5]]);
  assert.ok(r.timeline.every((t) => !t.onBeat));
  // other fields are kept
  assert.equal(r.clips[0].sourceId, 's_v');
});

test('the footage limits the setup and the hold; stills and clips without a hit are left alone', () => {
  const r = arrangeMontage([clip(1.5), { sourceId: 's_img', start: 0, end: 2, image: true }, clip(null), clip(19.5)], { setup: 4, hold: 1, sync: 'off' });
  assert.deepEqual(r.clips.map((c) => [c.start, c.end]), [[0, 2.5], [0, 2], [0, 20], [15.5, 20]]);
  assert.match(r.notes.join(' '), /Clip 3: no hit/);
});

test('playback rate: the setup is output time, so a slowed clip uses less footage', () => {
  const r = arrangeMontage([clip(10, 20, { rate: 0.5 })], { setup: 4, hold: 1, sync: 'off' });
  assert.deepEqual([r.clips[0].start, r.clips[0].end], [8, 10.5]);
  assert.deepEqual([r.timeline[0].hit, r.timeline[0].end], [4, 5]);
});

test('with music: every hit and every cut lands on a beat (or a bar), as near the wanted setup as the beats allow', () => {
  const beats = Array.from({ length: 200 }, (_, i) => 0.25 + i * 0.5); // 120 BPM from 0.25 s
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const grid = { beats, downbeats };
  const r = arrangeMontage([clip(10), clip(12), clip(8), clip(6)], { setup: [5, 2.5], hold: 0.8, sync: 'beat' }, grid);
  const onGrid = (t, g) => g.some((b) => Math.abs(b - t) < 0.002);
  for (const t of r.timeline) {
    assert.ok(t.onBeat);
    assert.ok(onGrid(t.hit, beats), `hit ${t.hit}`);
    assert.ok(onGrid(t.end, beats), `cut ${t.end}`);
  }
  // first setup: 4.75 and 5.25 are both 0.25 s from the wanted 5 s (the earlier wins); a 0.8 s hold
  // rounds to a whole beat (1 s)
  assert.deepEqual([r.timeline[0].hit, r.timeline[0].end], [4.75, 5.75]);
  assert.ok(r.timeline[3].hit - r.timeline[3].start < r.timeline[0].hit - r.timeline[0].start);
  const bars = arrangeMontage([clip(10), clip(12), clip(8)], { setup: [5, 2.5], sync: 'bar' }, grid);
  for (const t of bars.timeline) assert.ok(onGrid(t.hit, downbeats), `hit ${t.hit} not on a bar`);
  // a hit too early in its clip to reach any beat is placed as well as it can be
  const early = arrangeMontage([clip(5), clip(0.1)], { setup: 2, sync: 'beat' }, grid);
  assert.equal(early.timeline[1].onBeat, false);
  assert.match(early.notes.join(' '), /Clip 2: not enough footage/);
});

test('the planner keeps a beat-synced montage on the beats: no drift across many clips', () => {
  const beats = Array.from({ length: 400 }, (_, i) => 0.1 + i * (60 / 143)); // an awkward tempo
  const lib = { s_v: { id: 's_v', name: 'v.mp4', path: '/v.mp4', kind: 'video', duration: 20, width: 1920, height: 1080, fps: 60, hasAudio: true, bitrate: 8000 } };
  const clips = Array.from({ length: 16 }, (_, i) => clip(8 + (i % 5)));
  const r = arrangeMontage(clips, { setup: [4, 1.5], hold: 0.7, sync: 'beat' }, { beats, downbeats: [] });
  const request = { clips: r.clips.map(({ sourceId, start, end, hit }) => ({ sourceId, start, end, hit })), transitions: [], preset: 'tiktok' };
  const plan = planExport((id) => lib[id], request, { encoders: ['libx264'], exists: () => false });
  const tl = timeline(resolveSequence(normalizeRequest(request), (id) => lib[id]), plan.fps);
  let frame = 0;
  r.clips.forEach((c, k) => {
    const hitTime = (frame + Math.round((c.hit - c.start) * plan.fps)) / plan.fps;
    const nearestBeat = beats.reduce((b, x) => (Math.abs(x - hitTime) < Math.abs(b - hitTime) ? x : b));
    assert.ok(Math.abs(hitTime - nearestBeat) <= 1.5 / plan.fps, `clip ${k + 1}: hit at ${hitTime}, beat ${nearestBeat}`);
    frame += tl.frames[k];
  });
});

test('beatGrid: beats from where the track starts, repeated when it loops', () => {
  const g = beatGrid({ beats: [0.5, 1, 1.5, 2.5], downbeats: [0.5, 2.5], duration: 3 }, { start: 1 });
  assert.deepEqual(g, { beats: [0, 0.5, 1.5], downbeats: [1.5] });
  const l = beatGrid({ beats: [0.5, 1.5], downbeats: [0.5], duration: 2 }, { loop: true, until: 5 });
  assert.deepEqual(l.beats, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
});

test('normalizeMontage: defaults and validation', () => {
  assert.deepEqual(normalizeMontage({}), { setup: [5, 2.5], hold: 0.8, sync: 'beat', minSetup: 0.6 });
  assert.deepEqual(normalizeMontage({ setup: 3 }).setup, [3, 3]);
  assert.throws(() => normalizeMontage({ sync: 'drop' }), /Invalid sync/);
  assert.throws(() => normalizeMontage({ setup: [99, 1] }), /setup/);
  assert.throws(() => normalizeMontage({ hold: -1 }), /hold/);
});

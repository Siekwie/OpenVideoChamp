import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBeats, estimateTempo, onsetEnvelope, findHits, loudnessCurve } from '../src/analysis.js';

const RATE = 22050;

// A drum loop: kick on every beat (louder on the first of each bar), a hi-hat between beats, a pad underneath.
function drumLoop({ bpm, seconds, offset = 0.3, seed = 1 }) {
  const out = new Float32Array(Math.round(seconds * RATE));
  let s = seed;
  const noise = () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; };
  const beat = 60 / bpm;
  const truth = [];
  for (let k = 0; offset + k * beat < seconds - 0.2; k++) {
    const t0 = offset + k * beat;
    truth.push(t0);
    const accent = k % 4 === 0 ? 1 : 0.6;
    for (let i = 0; i < 0.15 * RATE; i++) {
      const t = i / RATE;
      const j = Math.round(t0 * RATE) + i;
      if (j < out.length) out[j] += accent * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 30)) * t) * Math.exp(-t * 18);
    }
    const hat = Math.round((t0 + beat / 2) * RATE);
    for (let i = 0; i < 0.04 * RATE && hat + i < out.length; i++) out[hat + i] += 0.15 * noise() * Math.exp(-i / RATE * 90);
  }
  for (let i = 0; i < out.length; i++) out[i] += 0.05 * Math.sin(2 * Math.PI * 220 * (i / RATE)) + 0.01 * noise();
  return { samples: out, truth, beat };
}

for (const bpm of [128, 95, 150]) {
  test(`beats: a ${bpm} BPM loop is found on the beat, with its bars`, () => {
    const { samples, truth, beat } = drumLoop({ bpm, seconds: 30 });
    const r = detectBeats(samples, RATE);
    assert.ok(Math.abs(r.bpm - bpm) < 1.5, `bpm ${r.bpm}`);
    // nearly every true beat has a detected beat within 25 ms
    const matched = truth.filter((t) => r.beats.some((b) => Math.abs(b - t) < 0.025));
    assert.ok(matched.length >= truth.length * 0.9, `${matched.length}/${truth.length} beats matched; first detected ${r.beats.slice(0, 4)} vs ${truth.slice(0, 4).map((t) => t.toFixed(3))}`);
    // beats come one period apart and in order
    for (let i = 1; i < r.beats.length; i++) assert.ok(Math.abs(r.beats[i] - r.beats[i - 1] - beat) < 0.03, `gap at ${i}`);
    // downbeats are the accented first beat of every bar
    const bars = truth.filter((_, k) => k % 4 === 0);
    const onBar = r.downbeats.filter((d) => bars.some((t) => Math.abs(d - t) < 0.025));
    assert.ok(onBar.length >= r.downbeats.length * 0.9, `downbeats ${r.downbeats.slice(0, 4)} vs bars ${bars.slice(0, 4)}`);
  });
}

// A rock/pop pattern: kick on 1 and 3, snare on 2 and 4, hi-hats on every eighth, a bass line, a pad.
function backbeat({ bpm, seconds, offset }) {
  const out = new Float32Array(Math.round(seconds * RATE));
  let s = bpm;
  const noise = () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; };
  const beat = 60 / bpm, truth = [];
  const add = (t0, fn, len) => { const a = Math.round(t0 * RATE); for (let i = 0; i < len * RATE && a + i < out.length; i++) out[a + i] += fn(i / RATE); };
  for (let k = 0; offset + k * beat < seconds - 0.3; k++) {
    const t0 = offset + k * beat;
    truth.push(t0);
    if (k % 2 === 0) add(t0, (t) => Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 25)) * t) * Math.exp(-t * 10), 0.3);
    else add(t0, (t) => (0.5 * noise() + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 20), 0.2);
    for (const h of [0, 0.5]) add(t0 + h * beat, (t) => 0.12 * noise() * Math.exp(-t * 60), 0.05);
    add(t0, (t) => 0.2 * Math.sin(2 * Math.PI * [55, 55, 65, 49][Math.floor(k / 4) % 4] * t), beat);
  }
  for (let i = 0; i < out.length; i++) out[i] += 0.08 * Math.sin((2 * Math.PI * 330 * i) / RATE) * (1 + 0.5 * Math.sin(i / RATE)) + 0.02 * noise();
  return { samples: out, truth };
}

for (const [bpm, offset] of [[160, 0.2], [140, 0.5], [87, 0.4]]) {
  test(`beats: kick and snare at ${bpm} BPM is not mistaken for half or double tempo`, () => {
    const { samples, truth } = backbeat({ bpm, seconds: 40, offset });
    const r = detectBeats(samples, RATE);
    assert.ok(Math.abs(r.bpm - bpm) < 1.5, `bpm ${r.bpm}`);
    const matched = truth.filter((t) => r.beats.some((b) => Math.abs(b - t) < 0.03));
    assert.ok(matched.length >= truth.length * 0.9, `${matched.length}/${truth.length}`);
  });
}

test('beats: silence and very short audio give no beats instead of failing', () => {
  assert.deepEqual(detectBeats(new Float32Array(RATE * 5), RATE), { bpm: null, beats: [], downbeats: [] });
  assert.deepEqual(detectBeats(new Float32Array(100), RATE), { bpm: null, beats: [], downbeats: [] });
  const { env, fps } = onsetEnvelope(new Float32Array(RATE), RATE);
  assert.equal(estimateTempo(env, fps), null);
});

test('hits: a sudden jump in loudness and brightness is found, best first, at its start', () => {
  const step = 0.1;
  const n = 150; // 15 s
  let s = 7;
  const jitter = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const loudness = Float32Array.from({ length: n }, (_, i) => -30 + 3 * jitter() + (i >= 112 && i < 125 ? 20 : 0) + (i >= 40 && i < 44 ? 7 : 0));
  const brightness = Float32Array.from({ length: n }, (_, i) => 0.35 + 0.02 * jitter() + (i >= 113 && i < 120 ? 0.4 : 0));
  const hits = findHits({ step, loudness, brightness });
  assert.ok(hits.length >= 1);
  assert.ok(Math.abs(hits[0].t - 11.2) <= 0.15, JSON.stringify(hits));
  assert.ok(hits[0].score > 0.8);
  // the smaller bump later in the list, never closer than 2 s to a better one
  assert.ok(hits.slice(1).some((h) => Math.abs(h.t - 4) <= 0.15), JSON.stringify(hits));
  for (const a of hits) for (const b of hits) if (a !== b) assert.ok(Math.abs(a.t - b.t) >= 2);
  // either signal alone works; neither gives nothing
  assert.ok(Math.abs(findHits({ step, loudness })[0].t - 11.2) <= 0.15);
  assert.ok(Math.abs(findHits({ step, brightness })[0].t - 11.3) <= 0.15);
  assert.deepEqual(findHits({ step }), []);
  // a flat recording has no hits
  assert.deepEqual(findHits({ step, loudness: new Float32Array(100).fill(-20), brightness: new Float32Array(100).fill(0.4) }), []);
});

test('loudnessCurve: dB per window', () => {
  const x = new Float32Array(8000).map((_, i) => (i < 4000 ? 0.1 : 1) * Math.sin(i));
  const c = loudnessCurve(x, 8000, 0.1);
  assert.equal(c.length, 10);
  assert.ok(Math.abs(c[9] - c[0] - 20) < 0.5, `${c[0]} → ${c[9]}`);
});

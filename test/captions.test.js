import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planExport, buildArgs, buildSubtitles, PlanError } from '../src/plan.js';
import { normalizeCaptions, normalizeCaptionStyle, normalizeTexts, groupWords, buildAss, filterPath, CAPTION_PRESETS } from '../src/captions.js';

const P = (p) => path.resolve(p);
const interview = {
  id: 's_iv', name: 'interview.mp4', path: P('/videos/interview.mp4'), uploaded: false, size: 300e6, kind: 'video',
  duration: 1800, width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, bitrate: 6000,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
};
const lib = (id) => (id === 's_iv' ? interview : null);
const words = (list, t0 = 100, step = 0.4) => list.split(' ').map((w, i) => ({ t: t0 + i * step, end: t0 + i * step + 0.35, text: w }));
const short = (over = {}) => ({
  clips: [{ sourceId: 's_iv', start: 100, end: 110, fit: 'fill', captions: words('Nobody expected this. The chips we build today will run the world tomorrow') }],
  preset: 'tiktok', ...over,
});
const opts = { defaultOutputDir: P('/out'), exists: () => false };

test('normalizeCaptions: sorted, empty entries dropped, end defaults to the next word', () => {
  const c = normalizeCaptions([{ t: 2, text: 'b' }, { t: 1, text: 'a' }, { t: 3, text: '  ' }], 'Clip 1 caption');
  assert.deepEqual(c, [{ t: 1, end: 2, text: 'a' }, { t: 2, end: 2.5, text: 'b' }]);
  assert.throws(() => normalizeCaptions([{ t: 2, end: 1, text: 'x' }], 'c'), /ends before it starts/);
  assert.throws(() => normalizeCaptions({}, 'c'), /must be an array/);
  // control characters and runs of spaces are cleaned
  assert.equal(normalizeCaptions([{ t: 0, text: 'a\n\tb' }], 'c')[0].text, 'a b');
});

test('normalizeCaptionStyle: presets by name, overrides, validation', () => {
  assert.deepEqual(normalizeCaptionStyle(null), CAPTION_PRESETS.bold);
  assert.equal(normalizeCaptionStyle('clean').background, '#000000');
  const s = normalizeCaptionStyle({ preset: 'bold', words: 2, highlight: null, color: 'ff0000' });
  assert.equal(s.words, 2);
  assert.equal(s.highlight, null);
  assert.equal(s.color, '#ff0000');
  assert.throws(() => normalizeCaptionStyle('wobbly'), /Unknown captionStyle preset/);
  assert.throws(() => normalizeCaptionStyle({ y: 2 }), /between 0 and 1/);
  assert.throws(() => normalizeCaptionStyle({ font: 'x;y' }), /font family/);
});

test('normalizeTexts: defaults, box text is dark on light, validation', () => {
  const [t] = normalizeTexts([{ text: 'Hook', end: 3, background: '#ffffff' }]);
  assert.equal(t.start, 0);
  assert.equal(t.color, '#000000');
  assert.throws(() => normalizeTexts([{ text: 'x', start: 3, end: 2 }]), /end after it starts/);
  assert.throws(() => normalizeTexts([{ text: 'x'.repeat(301) }]), /longer than/);
});

test('groupWords: word and character limits, sentence ends and pauses start a new group, no flicker', () => {
  const style = { words: 3, maxChars: 18 };
  const g = groupWords(words('one two three four. five six', 0, 0.4), style);
  assert.deepEqual(g.map((x) => x.words.map((w) => w.text).join(' ')), ['one two three', 'four.', 'five six']);
  // each group runs until the next one starts (gap 0.05 s < 0.35 s)
  assert.equal(g[0].end, g[1].start);
  const paused = groupWords([{ t: 0, end: 0.3, text: 'a' }, { t: 2, end: 2.3, text: 'b' }], style);
  assert.equal(paused.length, 2);
  assert.equal(paused[0].end, 0.3);
  // a phrase entry is split into words sharing its time
  const phrase = groupWords([{ t: 0, end: 1, text: 'big news today' }], style);
  assert.deepEqual(phrase[0].words.map((w) => [w.text, Math.round(w.t * 100) / 100]), [['big', 0], ['news', 0.33], ['today', 0.67]]);
  const long = groupWords(words('extraordinarily unbelievable', 0), style);
  assert.equal(long.length, 2, 'over maxChars');
});

test('buildAss: canvas-sized script, a highlighted event per word, texts with a box, braces neutralised', () => {
  const ass = buildAss({
    width: 1080, height: 1920, duration: 10, style: CAPTION_PRESETS.bold, font: 'Arial Black',
    captions: [{ offset: 2, words: [{ t: 0, end: 0.4, text: 'hello' }, { t: 0.4, end: 0.8, text: '{world}' }] }],
    texts: normalizeTexts([{ text: 'The hook', end: 3, background: '#ffffff' }]),
  });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: cap,Arial Black,96,/);
  const caps = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1'));
  assert.equal(caps.length, 2);
  assert.match(caps[0], /^Dialogue: 1,0:00:02\.00,0:00:02\.40,cap,.*\{\\c&H1FD2FF&\}HELLO\{\\c&HFFFFFF&\} \(WORLD\)$/);
  assert.match(caps[1], /^Dialogue: 1,0:00:02\.40,0:00:02\.80,/);
  assert.match(ass, /Style: text0,Arial Black,69,&H00000000,&H00000000,&H20FFFFFF,&H20FFFFFF,-1,0,0,0,100,100,0,0,3,/);
  assert.match(ass, /Dialogue: 2,0:00:00\.00,0:00:03\.00,text0,,0,0,0,,\{\\pos\(540,269\)\}The hook/);
  assert.equal(buildAss({ width: 10, height: 10, duration: 1, captions: [], texts: [] }), null);
  // the bold style drops trailing commas and full stops, keeps question marks
  const punct = buildAss({ width: 1080, height: 1920, duration: 5, style: { ...CAPTION_PRESETS.bold, highlight: null },
    captions: [{ offset: 0, words: [{ t: 0, end: 0.3, text: 'well,' }, { t: 0.3, end: 0.6, text: 'really?' }, { t: 0.6, end: 0.9, text: 'yes.' }] }] });
  assert.match(punct, /WELL REALLY\?/);
  assert.match(punct, /\}YES$/m);
  assert.match(buildAss({ width: 1080, height: 1920, duration: 5, style: CAPTION_PRESETS.clean, captions: [{ offset: 0, words: [{ t: 0, end: 0.3, text: 'well,' }] }] }), /well,$/m);
});

test('filterPath: Windows paths survive the filter graph parser', () => {
  assert.equal(filterPath('C:\\Users\\me\\AppData\\Local\\Temp\\pass-j_1.ass'), "'C\\:/Users/me/AppData/Local/Temp/pass-j_1.ass'");
  assert.equal(filterPath('/tmp/x.ass'), "'/tmp/x.ass'");
});

test('plan + args: captions move with the clip, the ass filter sits before the fades, copy mode is off', () => {
  const r = short({ fadeOut: 0.5, texts: [{ text: 'Jensen Huang on the future of chips', end: 3 }] });
  const plan = planExport(lib, r, opts);
  assert.equal(plan.mode, 'encode');
  assert.equal(plan.captions, 13);
  assert.equal(plan.texts, 1);
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1920);
  const [args] = buildArgs(plan, lib, r, { subtitlesFile: '/tmp/pass-j.ass', fontsDir: 'C:\\Windows\\Fonts' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /ass=filename='\/tmp\/pass-j\.ass':fontsdir='C\\:\/Windows\/Fonts',fade=t=out/);
  const ass = buildSubtitles(plan, lib, r, { font: 'Arial' });
  // source 100.0 s is 0:00 in the video
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:00\.40,cap,.*NOBODY/);
  assert.match(ass, /Dialogue: 2,0:00:00\.00,0:00:03\.00,text0/);
  // a plain cut with captions cannot be a stream copy
  const cut = planExport(lib, { sourceId: 's_iv', start: 100, end: 110, preset: 'cut', captions: words('a b') }, opts);
  assert.equal(cut.mode, 'encode');
});

test('captions of a sped-up second clip land after the first clip, outside words are dropped', () => {
  const r = {
    clips: [
      { sourceId: 's_iv', start: 10, end: 14 },
      { sourceId: 's_iv', start: 200, end: 204, rate: 2, captions: [{ t: 199, end: 199.5, text: 'before' }, { t: 202, end: 202.4, text: 'mid' }] },
    ],
    preset: 'tiktok',
  };
  const plan = planExport(lib, r, opts);
  assert.equal(plan.captions, 1);
  const ass = buildSubtitles(plan, lib, r);
  // clip 2 starts at 4 s; source 202 is 1 s into it at 2x (a group stays up at least 0.3 s)
  assert.match(ass, /Dialogue: 1,0:00:05\.00,0:00:05\.30,cap,.*MID/); // a group stays up at least 0.3 s
  assert.doesNotMatch(ass, /BEFORE/);
});

test('captions need libass', () => {
  assert.throws(() => planExport(lib, short(), { ...opts, subtitles: false }), (e) => e instanceof PlanError && /libass/.test(e.message));
});

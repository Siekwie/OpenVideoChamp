// Burned-in captions and text overlays: validation, and the ASS subtitle file the export renders
// with ffmpeg's `ass` filter (libass). Pure functions, except `defaultCaptionFont`, which looks at the
// fonts installed on this machine.
//
// Captions belong to a clip and are timed in *source* seconds (words or phrases of a transcript), so
// they move with the clip when it is trimmed, sped up or reordered. Texts (a hook headline, a credit)
// belong to the whole video and are timed in *output* seconds.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_CAPTIONS = 5000; // per clip
export const MAX_TEXTS = 20;
const MAX_TEXT = 300;
const WIN_FONTS = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');

export class CaptionError extends Error {
  status = 400;
}
const fail = (message) => { throw new CaptionError(message); };

function num(value, name, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback;
    fail(`${name} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${name} must be a number`);
  if (n < min || n > max) fail(`${name} must be between ${min} and ${max}`);
  return n;
}

function colour(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === null || value === false) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value));
  if (!m) fail(`${name} must be a colour like "#ffd21f"`);
  return `#${m[1].toLowerCase()}`;
}

function text(value, name) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  // No control characters; ASS override blocks start with "{", so braces become brackets.
  const t = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TEXT) fail(`${name} is longer than ${MAX_TEXT} characters`);
  return t;
}

const fontName = (value, name) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[\w .\-]{1,60}$/.test(value)) fail(`${name} must be a font family name`);
  return value.trim();
};

// Caption looks. Sizes are fractions of the canvas height so a 480p draft looks like the 1080p export.
export const CAPTION_PRESETS = {
  // Big uppercase words with a thick outline, the word being spoken in yellow: the talking-head short look.
  bold: { words: 3, maxChars: 18, uppercase: true, size: 0.05, color: '#ffffff', highlight: '#ffd21f', outline: 0.0045, background: null, y: 0.68, font: null },
  // Sentence case on a dark box, no highlight: calmer, for explainers and long quotes.
  clean: { words: 7, maxChars: 34, uppercase: false, size: 0.034, color: '#ffffff', highlight: null, outline: 0.006, background: '#000000', y: 0.74, font: null },
};

export function normalizeCaptionStyle(input) {
  if (input == null || input === false) return { ...CAPTION_PRESETS.bold };
  const o = typeof input === 'string' ? { preset: input } : input;
  if (typeof o !== 'object') fail('captionStyle must be a preset name or an object');
  const presetName = o.preset ?? 'bold';
  if (!Object.hasOwn(CAPTION_PRESETS, presetName)) fail(`Unknown captionStyle preset: ${JSON.stringify(presetName)} (one of ${Object.keys(CAPTION_PRESETS).join(', ')})`);
  const p = CAPTION_PRESETS[presetName];
  return {
    words: Math.round(num(o.words, 'captionStyle words', { min: 1, max: 12, fallback: p.words })),
    maxChars: Math.round(num(o.maxChars, 'captionStyle maxChars', { min: 4, max: 80, fallback: p.maxChars })),
    uppercase: o.uppercase == null ? p.uppercase : Boolean(o.uppercase),
    size: num(o.size, 'captionStyle size', { min: 0.01, max: 0.2, fallback: p.size }),
    color: colour(o.color, 'captionStyle color', p.color) ?? p.color,
    highlight: colour(o.highlight, 'captionStyle highlight', p.highlight),
    outline: num(o.outline, 'captionStyle outline', { min: 0, max: 0.03, fallback: p.outline }),
    background: colour(o.background, 'captionStyle background', p.background),
    y: num(o.y, 'captionStyle y', { min: 0, max: 1, fallback: p.y }),
    font: fontName(o.font, 'captionStyle font') ?? p.font,
  };
}

// A clip's captions: [{ t, end?, text }] in source seconds, sorted. `end` defaults to the next entry's `t`.
export function normalizeCaptions(input, name) {
  if (input == null || input === false) return [];
  if (!Array.isArray(input)) fail(`${name} must be an array`);
  if (input.length > MAX_CAPTIONS) fail(`${name}: at most ${MAX_CAPTIONS} entries per clip`);
  const list = input.map((w, i) => {
    if (!w || typeof w !== 'object') fail(`${name} ${i + 1} must be an object`);
    const t = num(w.t ?? w.start, `${name} ${i + 1} t`, { min: 0 });
    const end = w.end == null ? null : num(w.end, `${name} ${i + 1} end`, { min: 0 });
    if (end != null && end < t) fail(`${name} ${i + 1} ends before it starts`);
    return { t, end, text: text(w.text ?? w.word ?? '', `${name} ${i + 1} text`) };
  }).filter((w) => w.text).sort((a, b) => a.t - b.t);
  list.forEach((w, i) => { if (w.end == null) w.end = list[i + 1] ? Math.min(list[i + 1].t, w.t + 1.5) : w.t + 0.5; });
  return list;
}

// Whole-video texts: [{ text, start, end, y, size, color, background, uppercase, font }] in output seconds.
export function normalizeTexts(input) {
  if (input == null || input === false) return [];
  if (!Array.isArray(input)) fail('texts must be an array');
  if (input.length > MAX_TEXTS) fail(`At most ${MAX_TEXTS} texts`);
  return input.map((o, i) => {
    const name = `Text ${i + 1}`;
    if (!o || typeof o !== 'object') fail(`${name} must be an object`);
    const start = num(o.start, `${name} start`, { min: 0, fallback: 0 });
    const end = o.end == null ? null : num(o.end, `${name} end`, { min: 0 });
    if (end != null && end <= start) fail(`${name} must end after it starts`);
    const background = colour(o.background, `${name} background`, null);
    return {
      text: text(o.text ?? '', `${name} text`),
      start, end,
      y: num(o.y, `${name} y`, { min: 0, max: 1, fallback: 0.14 }),
      size: num(o.size, `${name} size`, { min: 0.01, max: 0.2, fallback: 0.036 }),
      color: colour(o.color, `${name} color`, background ? '#000000' : '#ffffff') ?? '#ffffff',
      background,
      outline: num(o.outline, `${name} outline`, { min: 0, max: 0.03, fallback: background ? 0.006 : 0.0035 }),
      uppercase: Boolean(o.uppercase),
      font: fontName(o.font, `${name} font`),
    };
  }).filter((o) => o.text);
}

// A clip's captions on its own output timeline: clip time = (source time - start) / rate, clipped to the clip.
export function clipCaptions(captions, { start, rate, duration }) {
  const out = [];
  for (const w of captions) {
    const t = (w.t - start) / rate, end = (w.end - start) / rate;
    if (end <= 0.01 || t >= duration - 0.01) continue;
    out.push({ t: Math.max(0, t), end: Math.min(duration, end), text: w.text });
  }
  return out;
}

// Words → what is on screen together: at most `words` words / `maxChars` characters, a new group after a
// sentence ends or a pause. Each group stays up until the next one starts when the gap is short (no flicker).
export function groupWords(words, style) {
  const groups = [];
  let cur = null;
  for (const w of words) {
    const pieces = w.text.split(' ');
    // A phrase entry ("this is huge") is split into words that share its time evenly.
    pieces.forEach((p, j) => {
      const span = (w.end - w.t) / pieces.length;
      const word = { t: w.t + j * span, end: w.t + (j + 1) * span, text: p };
      const chars = cur ? cur.words.reduce((s, x) => s + x.text.length + 1, 0) + word.text.length : 0;
      const gap = cur ? word.t - cur.words.at(-1).end : 0;
      if (!cur || cur.words.length >= style.words || chars > style.maxChars || gap > 0.6 || cur.closed) {
        cur = { words: [], closed: false };
        groups.push(cur);
      }
      cur.words.push(word);
      if (/[.!?…]["')\]]*$/.test(word.text)) cur.closed = true;
    });
  }
  return groups.map((g, i) => {
    const start = g.words[0].t;
    let end = Math.max(g.words.at(-1).end, start + 0.3);
    const next = groups[i + 1]?.words[0].t;
    if (next != null && next - end < 0.35) end = next;
    if (next != null) end = Math.min(end, next);
    return { start, end, words: g.words };
  }).filter((g) => g.end - g.start > 0.01);
}

// ---------------------------------------------------------------------------------------------------
// ASS file

const assColour = (hex, alpha = 0) => {
  const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2).toUpperCase());
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`;
};
const inline = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2).toUpperCase()); return `&H${b}${g}${r}&`; };
const assText = (s) => s.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')');
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function styleLine(name, s, { W, H, font }) {
  const size = Math.round(s.size * H);
  const box = Boolean(s.background);
  const outline = Math.max(0, Math.round(s.outline * H));
  // BorderStyle 3 is an opaque box in the outline colour; 1 is an outline (+ shadow).
  const outlineColour = box ? assColour(s.background, 0x20) : assColour('#000000');
  return `Style: ${name},${s.font || font},${size},${assColour(s.color)},${assColour(s.color)},${outlineColour},${box ? assColour(s.background, 0x20) : assColour('#000000', 0x80)},-1,0,0,0,100,100,0,0,${box ? 3 : 1},${outline},0,5,${Math.round(W * 0.07)},${Math.round(W * 0.07)},0,1`;
}

// `captions`: [{ offset, words }] per clip (clip time + where the clip starts in the video, seconds);
// `texts` in output seconds; `duration` the video's length. Returns the ASS file, or null when empty.
export function buildAss({ width: W, height: H, duration, captions = [], texts = [], style, font = 'Arial' }) {
  const events = [];
  const capStyle = style || CAPTION_PRESETS.bold;
  const x = Math.round(W / 2);
  for (const { offset, words } of captions) {
    const pos = `\\pos(${x},${Math.round(capStyle.y * H)})`;
    for (const g of groupWords(words, capStyle)) {
      const shown = g.words.map((w) => assText(capStyle.uppercase ? w.text.toUpperCase() : w.text));
      const at = (t) => Math.min(duration, offset + t);
      if (!capStyle.highlight) {
        events.push(`Dialogue: 1,${assTime(at(g.start))},${assTime(at(g.end))},cap,,0,0,0,,{${pos}}${shown.join(' ')}`);
        continue;
      }
      // One event per spoken word: the whole group, with that word in the highlight colour.
      g.words.forEach((w, i) => {
        const from = i === 0 ? g.start : w.t;
        const to = i + 1 < g.words.length ? g.words[i + 1].t : g.end;
        if (to - from < 0.005) return;
        const line = shown.map((s, j) => (j === i ? `{\\c${inline(capStyle.highlight)}}${s}{\\c${inline(capStyle.color)}}` : s)).join(' ');
        events.push(`Dialogue: 1,${assTime(at(from))},${assTime(at(to))},cap,,0,0,0,,{${pos}}${line}`);
      });
    }
  }
  const textStyles = [];
  texts.forEach((o, i) => {
    textStyles.push(styleLine(`text${i}`, o, { W, H, font }));
    const end = o.end == null ? duration : Math.min(o.end, duration);
    if (o.start >= end) return;
    const body = assText(o.uppercase ? o.text.toUpperCase() : o.text);
    events.push(`Dialogue: 2,${assTime(o.start)},${assTime(end)},text${i},,0,0,0,,{\\pos(${x},${Math.round(o.y * H)})}${body}`);
  });
  if (!events.length) return null;
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine('cap', capStyle, { W, H, font }),
    ...textStyles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

// A heavy sans-serif this machine has, and the folder to hand libass (Windows builds often have no
// fontconfig setup that would find C:\Windows\Fonts by themselves).
export function defaultCaptionFont(platform = process.platform, exists = fs.existsSync) {
  if (platform === 'win32') {
    if (exists(path.join(WIN_FONTS, 'ariblk.ttf'))) return { family: 'Arial Black', dir: WIN_FONTS };
    return { family: 'Arial', dir: WIN_FONTS };
  }
  if (platform === 'darwin') {
    if (exists('/System/Library/Fonts/Supplemental/Arial Black.ttf')) return { family: 'Arial Black', dir: null };
    return { family: 'Helvetica', dir: null };
  }
  for (const [file, family] of [
    ['/usr/share/fonts/truetype/msttcorefonts/Arial_Black.ttf', 'Arial Black'],
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
    ['/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
    ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', 'Liberation Sans'],
  ]) if (exists(file)) return { family, dir: null };
  return { family: 'Sans', dir: null };
}

// A path as a filter option value inside -filter_complex: forward slashes, the drive colon escaped
// for the option parser, quoted for the graph parser ("C\:/Users/me/x.ass").
export function filterPath(p) {
  return `'${String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")}'`;
}

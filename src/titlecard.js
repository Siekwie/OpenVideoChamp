// Renders a title card (text on a coloured background, optional logo) to a PNG with ffmpeg's drawtext,
// so a script or an agent can make the kind of card the UI draws on a canvas.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './ffmpeg.js';

const WIN_FONTS = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
// [bold, regular] pairs, first existing pair wins; without one drawtext falls back to fontconfig.
const FONT_PAIRS = {
  win32: [['segoeuib.ttf', 'segoeui.ttf'], ['arialbd.ttf', 'arial.ttf']].map((pair) => pair.map((f) => path.join(WIN_FONTS, f))),
  darwin: [
    ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'],
    ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Helvetica.ttc'],
  ],
  linux: [
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
    ['/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'],
    ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'],
    ['/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf', '/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf'],
  ],
};
const CARD_STYLES = ['center', 'left', 'bar'];

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function colour(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value));
  if (!m) throw bad(`${name} must be a colour like "#1a2b3c"`);
  return `0x${m[1]}`;
}

function size(value, fallback, name) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 64 || n > 4096) throw bad(`${name} must be a whole number between 64 and 4096`);
  return n & ~1;
}

// Validates the request body of POST /api/titlecard.
export function normalizeCard(input = {}) {
  if (!input || typeof input !== 'object') throw bad('Expected a JSON object');
  const text = (v, max, name) => {
    if (v != null && typeof v !== 'string') throw bad(`${name} must be a string`);
    return (v || '').replace(/\s+/g, ' ').trim().slice(0, max);
  };
  const card = {
    title: text(input.title, 80, 'title'),
    subtitle: text(input.subtitle, 120, 'subtitle'),
    background: colour(input.background, '0x101418', 'background'),
    color: colour(input.color, '0xf4f4f6', 'color'),
    accent: colour(input.accent, '0x5a9bff', 'accent'),
    style: input.style ?? 'center',
    width: size(input.width, 1920, 'width'),
    height: size(input.height, 1080, 'height'),
  };
  if (!CARD_STYLES.includes(card.style)) throw bad(`Invalid style: ${JSON.stringify(input.style)}`);
  if (!card.title && !card.subtitle && !input.logoSourceId) throw bad('A title card needs a title, a subtitle or a logo');
  return card;
}

function fonts() {
  const pair = (FONT_PAIRS[process.platform] || FONT_PAIRS.linux).find((p) => p.every((f) => fs.existsSync(f)));
  // Inside a filter graph a path is quoted and its drive colon escaped.
  const arg = (file) => `fontfile='${file.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
  return pair ? { bold: arg(pair[0]), regular: arg(pair[1]) } : { bold: 'font=Sans', regular: 'font=Sans' };
}

// Writes the card to `file` (a .png path). `logo` is an image Source or null; `workDir` holds the text files.
export async function renderTitleCard(ffmpeg, card, file, { logo = null, workDir }) {
  const { width: W, height: H } = card;
  const k = Math.min(W / 1920, H / 1080);
  const px = (n) => Math.round(n * k);
  const margin = px(160), gap = px(36), maxWidth = W - margin * 2;
  // drawtext cannot measure before drawing, so the font size is fitted with an average glyph width.
  const fit = (text, ratio, max, min) => (text ? Math.round(Math.min(max * k, Math.max(min * k, maxWidth / (text.length * ratio)))) : 0);
  const titlePx = fit(card.title, 0.6, 150, 28);
  const subPx = fit(card.subtitle, 0.52, 56, 20);
  let logoW = 0, logoH = 0;
  if (logo) {
    logoH = Math.min(px(300), logo.height);
    logoW = logo.width * (logoH / logo.height);
    if (logoW > maxWidth) { logoW = maxWidth; logoH = logo.height * (logoW / logo.width); }
    logoW = Math.max(2, Math.round(logoW)); logoH = Math.max(2, Math.round(logoH));
  }
  const textH = titlePx + (titlePx && subPx ? gap : 0) + subPx;
  let y = Math.round((H - (logoH ? logoH + (textH ? gap : 0) : 0) - textH) / 2);
  const left = card.style !== 'center';
  const font = fonts();

  const chain = ['vignette=angle=PI/5'];
  let graph = '';
  if (logo) {
    graph = `[1:v]scale=${logoW}:${logoH}[logo];[0:v]${chain.join(',')}[bg];[bg][logo]overlay=${left ? margin : Math.round((W - logoW) / 2)}:${y}`;
    y += logoH + gap;
    chain.length = 0;
  }
  if (card.style === 'bar' && textH) chain.push(`drawbox=x=${margin - px(48)}:y=${y - px(10)}:w=${px(14)}:h=${textH + px(20)}:color=${card.accent}:t=fill`);
  const x = left ? String(margin) : '(w-text_w)/2';
  if (card.title) {
    fs.writeFileSync(path.join(workDir, 'title.txt'), card.title);
    chain.push(`drawtext=textfile=title.txt:expansion=none:${font.bold}:fontsize=${titlePx}:fontcolor=${card.color}:x=${x}:y=${y}`);
    y += titlePx + gap;
  }
  if (card.subtitle) {
    fs.writeFileSync(path.join(workDir, 'subtitle.txt'), card.subtitle);
    const fill = card.style === 'bar' ? `${card.color}@0.8` : card.accent;
    chain.push(`drawtext=textfile=subtitle.txt:expansion=none:${font.regular}:fontsize=${subPx}:fontcolor=${fill}:x=${x}:y=${y}`);
  }
  graph = logo ? [graph, ...chain].join(',') : `[0:v]${chain.join(',')}`;

  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${card.background}:size=${W}x${H}:rate=1`];
  if (logo) args.push('-i', logo.path);
  args.push('-filter_complex', `${graph}[out]`, '-map', '[out]', '-frames:v', '1', '-update', '1', file);
  try {
    // cwd: the text files are named relative to it, so their paths need no filter-graph escaping.
    await run(ffmpeg, args, { timeout: 30_000, cwd: workDir });
  } catch (e) {
    const missing = /No such filter: 'drawtext'/.test(e.message);
    throw Object.assign(new Error(missing ? 'This ffmpeg build cannot draw text (no drawtext filter)' : `Could not render the title card: ${e.message}`), { status: missing ? 501 : 500 });
  }
}

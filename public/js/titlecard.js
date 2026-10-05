// Title card dialog: renders text on a canvas the shape of the video (1920x1080, 1080x1920, ...) in the
// browser and uploads it as a PNG source.
import { $ } from './util.js';
import { upload } from './api.js';
import { canvasRatio } from './state.js';

const el = {};
for (const id of ['cardDialog', 'cardForm', 'cardCanvas', 'cardTitle', 'cardSubtitle', 'cardBg', 'cardFg', 'cardAccent', 'cardStyle', 'cardSeconds', 'cardLogo', 'cardLogoFile', 'cardCancelBtn', 'cardAddBtn']) el[id] = $(id);

let W = 1920, H = 1080;
let logo = null; // HTMLImageElement

// The card size for the video's shape: 1080 on the short side.
function cardSize() {
  const r = canvasRatio() || 16 / 9;
  return r >= 1 ? { w: Math.round((1080 * r) / 2) * 2, h: 1080 } : { w: 1080, h: Math.round(1080 / r / 2) * 2 };
}
let onAdd = () => {}, onError = () => {};

function fitFont(ctx, text, weight, maxWidth, maxPx, minPx) {
  let px = maxPx;
  for (; px > minPx; px -= 4) {
    ctx.font = `${weight} ${px}px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  return px;
}

// Draws the card into any canvas (the dialog preview or the full-size export canvas).
export function drawCard(canvas, opts) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width / W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, W, H);
  // a soft vignette so flat colours look less like a slide
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H);
  g.addColorStop(0, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const left = opts.style === 'left' || opts.style === 'bar';
  const margin = W < H ? 110 : 160;
  const maxWidth = W - margin * 2;
  ctx.textAlign = left ? 'left' : 'center';
  ctx.textBaseline = 'alphabetic';
  const x = left ? margin : W / 2;

  const title = (opts.title || '').trim();
  const subtitle = (opts.subtitle || '').trim();
  const titlePx = title ? fitFont(ctx, title, '800', maxWidth, 150, 48) : 0;
  const subPx = subtitle ? fitFont(ctx, subtitle, '500', maxWidth, 56, 28) : 0;
  let logoH = 0, logoW = 0;
  if (opts.useLogo && logo?.naturalWidth) {
    logoH = Math.min(300, H * 0.28, W * 0.4);
    logoW = logo.naturalWidth * (logoH / logo.naturalHeight);
    if (logoW > maxWidth) { logoW = maxWidth; logoH = logo.naturalHeight * (logoW / logo.naturalWidth); }
  }
  const gap = 36;
  const blockH = (logoH ? logoH + gap : 0) + (titlePx ? titlePx : 0) + (subPx ? gap + subPx : 0);
  let y = (H - blockH) / 2;
  if (logoH) {
    ctx.drawImage(logo, left ? margin : (W - logoW) / 2, y, logoW, logoH);
    y += logoH + gap;
  }
  if (opts.style === 'bar') {
    ctx.fillStyle = opts.accent;
    ctx.fillRect(margin - 48, y - 10, 14, (titlePx || 0) + (subPx ? gap + subPx : 0) + 20);
  }
  if (title) {
    y += titlePx * 0.82;
    ctx.font = `800 ${titlePx}px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    ctx.fillStyle = opts.fg;
    ctx.fillText(title, x, y);
  }
  if (subtitle) {
    y += (title ? gap : 0) + subPx * 0.82;
    ctx.font = `500 ${subPx}px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    ctx.fillStyle = opts.style === 'bar' ? opts.fg : opts.accent;
    ctx.globalAlpha = opts.style === 'bar' ? 0.8 : 1;
    ctx.fillText(subtitle, x, y);
    ctx.globalAlpha = 1;
  }
}

function options() {
  return {
    title: el.cardTitle.value, subtitle: el.cardSubtitle.value, bg: el.cardBg.value, fg: el.cardFg.value, accent: el.cardAccent.value,
    style: el.cardStyle.value, seconds: Math.max(0.5, Number(el.cardSeconds.value) || 3), useLogo: el.cardLogo.checked,
  };
}

function preview() { drawCard(el.cardCanvas, options()); }

export function openTitleCard() {
  ({ w: W, h: H } = cardSize());
  el.cardCanvas.width = Math.round(W / 3);
  el.cardCanvas.height = Math.round(H / 3);
  el.cardCanvas.classList.toggle('tall', H > W);
  preview();
  el.cardDialog.showModal();
  el.cardTitle.focus();
  el.cardTitle.select();
}

async function submit(e) {
  e.preventDefault();
  const o = options();
  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  drawCard(full, o);
  const blob = await new Promise((r) => full.toBlob(r, 'image/png'));
  const stem = (o.title || 'title card').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'title card';
  el.cardAddBtn.disabled = true;
  try {
    // card: the server keeps the image, so a saved project still finds it after a restart
    const src = await upload(blob, `${stem}.png`, { card: true });
    el.cardDialog.close();
    onAdd(src, o.seconds);
  } catch (err) {
    onError(err.message);
  } finally {
    el.cardAddBtn.disabled = false;
  }
}

export function initTitleCard({ add, error }) {
  onAdd = add;
  onError = error;
  for (const id of ['cardTitle', 'cardSubtitle', 'cardBg', 'cardFg', 'cardAccent', 'cardStyle']) el[id].addEventListener('input', preview);
  el.cardLogo.addEventListener('change', () => {
    if (el.cardLogo.checked && !logo) el.cardLogoFile.click();
    preview();
  });
  el.cardLogoFile.addEventListener('change', () => {
    const f = el.cardLogoFile.files[0];
    if (!f) { el.cardLogo.checked = false; preview(); return; }
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); logo = img; el.cardLogo.checked = true; preview(); };
    img.onerror = () => { URL.revokeObjectURL(img.src); el.cardLogo.checked = false; preview(); };
    img.src = URL.createObjectURL(f);
    el.cardLogoFile.value = '';
  });
  el.cardCancelBtn.addEventListener('click', () => el.cardDialog.close());
  el.cardForm.addEventListener('submit', submit);
}

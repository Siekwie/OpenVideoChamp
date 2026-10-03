// Small shared helpers: DOM, numbers, time formatting.

export const $ = (id) => document.getElementById(id);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const round3 = (t) => Math.round(t * 1000) / 1000;
export const MIN_LEN = 0.101; // backend rejects < 0.1 s; the extra ms keeps float subtraction on the safe side

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function fmtTime(t) {
  t = Math.max(0, t || 0);
  const hrs = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000 + 1e-6);
  const body = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  return hrs ? `${hrs}:${body}` : body;
}

export function fmtShort(t) {
  t = Math.max(0, t || 0);
  const hrs = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.round(t % 60);
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtSec(t, digits = 2) {
  return `${(t || 0).toFixed(digits)} s`;
}

export function fmtMB(bytes) {
  const mb = bytes / 1e6;
  return mb >= 100 ? `${Math.round(mb)} MB` : mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
}

export function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `~${sec} s` : `~${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function fmtFps(fps) {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}

// "12.5", "01:05.25" or "1:02:03" -> seconds, or null.
export function parseTime(str) {
  const parts = String(str).trim().replace(/,/g, '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d*\.?\d*$/.test(p) || p === '')) return null;
  let t = 0;
  for (const p of parts) t = t * 60 + parseFloat(p);
  return isFinite(t) ? t : null;
}

export const basename = (p) => String(p || '').split(/[\\/]/).pop();

export function once(target, ev, ms) {
  return new Promise((resolve) => {
    const done = () => { target.removeEventListener(ev, done); clearTimeout(tm); resolve(); };
    const tm = setTimeout(done, ms);
    target.addEventListener(ev, done);
  });
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Sizes a canvas to its CSS box (device-pixel aware) and returns a cleared context.
export function sizeCanvas(c, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// Draws `img` covering the box (like object-fit: cover).
export function drawCover(ctx, img, x, y, w, hgt) {
  const iw = img.width || img.videoWidth, ih = img.height || img.videoHeight;
  if (!iw || !ih || w <= 0 || hgt <= 0) return;
  const da = w / hgt, sa = iw / ih;
  let sx = 0, sy = 0, cw = iw, ch = ih;
  if (sa > da) { cw = ih * da; sx = (iw - cw) / 2; } else { ch = iw / da; sy = (ih - ch) / 2; }
  ctx.drawImage(img, sx, sy, cw, ch, x, y, w, hgt);
}

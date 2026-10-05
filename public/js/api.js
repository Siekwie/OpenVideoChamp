// Thin client for the local JSON API (docs/API.md).

async function json(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const post = (route, body) => fetch(route, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

export const api = {
  info: () => fetch('/api/info').then(json),
  docs: () => fetch('/api/docs').then((r) => { if (!r.ok) throw new Error('docs'); return r.text(); }),
  open: (path) => post('/api/open', { path }).then(json),
  openDialog: (multiple) => post('/api/open/dialog', { multiple }).then(json),
  project: (body) => post('/api/project', body).then(json),
  keyframes: (id) => fetch(`/api/sources/${id}/keyframes`).then(json),
  beats: (id) => fetch(`/api/sources/${id}/beats`).then(json),
  highlights: (id, range) => fetch(`/api/sources/${id}/highlights${range ? `?start=${range.start}&end=${range.end}` : ''}`).then(json),
  montage: (body) => post('/api/montage', body).then(json),
  plan: (body, signal) => fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }).then(json),
  export: (body) => post('/api/export', body).then(json),
  cancel: (id) => post(`/api/jobs/${id}/cancel`).then(json),
  reveal: (id) => post(`/api/jobs/${id}/reveal`).then(json),
  streamUrl: (sourceId) => `/api/sources/${sourceId}/stream`,
  jobStreamUrl: (jobId) => `/api/jobs/${jobId}/stream`,
  downloadUrl: (jobId) => `/api/jobs/${jobId}/download`,
};

// PUT /api/upload with progress; resolves to the Source. `onProgress(0..1)`; `card` keeps the file as a title card.
export function upload(file, name, { onProgress, card = false } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload?name=${encodeURIComponent(name || file.name || 'upload')}${card ? '&card=1' : ''}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status < 200 || xhr.status >= 300) reject(new Error(data.error || `Upload failed (${xhr.status})`));
      else resolve(data);
    };
    xhr.onerror = () => reject(new Error('Upload failed: cannot reach the server'));
    xhr.send(file);
  });
}

// Follows a job over SSE (falls back to polling) and calls onUpdate with every Job JSON.
// Returns a stop() function.
export function followJob(id, onUpdate) {
  let es = null, timer = 0, stopped = false;
  const stop = () => { stopped = true; if (es) { es.close(); es = null; } if (timer) { clearInterval(timer); timer = 0; } };
  const terminal = (j) => ['done', 'error', 'cancelled'].includes(j.status);
  const handle = (j) => { onUpdate(j); if (terminal(j)) stop(); };
  const poll = () => {
    if (timer || stopped) return;
    timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${id}`);
        if (res.ok) handle(await res.json());
        else if (res.status === 404) { stop(); onUpdate({ id, status: 'error', error: 'Job disappeared' }); }
      } catch { /* retry next tick */ }
    }, 500);
  };
  try {
    es = new EventSource(`/api/jobs/${id}/events`);
    es.onmessage = (ev) => { try { handle(JSON.parse(ev.data)); } catch { /* ignore malformed */ } };
    es.onerror = () => { if (stopped) return; es?.close(); es = null; poll(); };
  } catch { poll(); }
  return stop;
}

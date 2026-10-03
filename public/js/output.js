// Output bar: preset/options, the live plan estimate, preview and export jobs, the result row.
import { $, fmtMB, fmtEta, basename } from './util.js';
import { api, followJob } from './api.js';
import { state, on, emit, setOutput, exportRequest, copyCandidate, jobActive, anyJobActive, setMonitorMode } from './state.js';

const el = {};
for (const id of ['presets', 'customWrap', 'targetMB', 'cutWrap', 'optCut', 'optResolution', 'optFps', 'optAudio', 'speedWrap', 'optSpeed', 'encoderWrap', 'optEncoder',
  'estimate', 'previewBtn', 'previewProgress', 'previewFill', 'previewText', 'exportBtn', 'progress', 'progressFill', 'progressText', 'cancelBtn',
  'resultRow', 'resultText', 'revealBtn', 'downloadBtn', 'dismissResultBtn', 'logDetails', 'logPre']) el[id] = $(id);

let planTimer = 0, planAbort = null, exportWhenPlanned = false;
let stopExport = null, stopPreview = null;

// ---------- options ----------

export function renderOptions() {
  const o = state.output;
  for (const b of el.presets.children) b.setAttribute('aria-checked', String(b.dataset.preset === o.preset));
  el.customWrap.hidden = o.preset !== 'custom';
  if (document.activeElement !== el.targetMB) el.targetMB.value = o.targetMB;
  const copyPossible = copyCandidate() && o.preset === 'cut';
  el.cutWrap.hidden = !copyPossible;
  const copyMode = state.plan ? state.plan.mode === 'copy' : copyPossible && o.cut === 'fast';
  el.speedWrap.hidden = copyMode;
  const encoders = state.info?.encoders || [];
  el.encoderWrap.hidden = encoders.length <= 1;
  el.optCut.value = o.cut;
  el.optResolution.value = o.resolution;
  el.optFps.value = o.fps;
  el.optAudio.value = o.audio;
  el.optSpeed.value = o.speed;
  el.optEncoder.value = o.encoder;
}

// ---------- plan ----------

export function renderEstimate() {
  const box = el.estimate;
  box.textContent = '';
  const add = (text, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; box.appendChild(s); };
  if (!state.clips.length) { add('Add a clip to see the export estimate.', 'muted'); return; }
  if (state.planPending && !state.plan) return add('…');
  if (state.planError) return add(state.planError, 'err');
  if (!state.plan) return;
  add(state.plan.summary + (state.planPending ? ' …' : ''));
  for (const w of state.plan.warnings || []) add(w, 'warn');
}

export function requestPlan() {
  clearTimeout(planTimer);
  if (planAbort) { planAbort.abort(); planAbort = null; }
  if (!state.clips.length) { state.plan = null; state.planError = null; state.planPending = false; renderEstimate(); renderJobs(); return; }
  state.planPending = true;
  renderEstimate();
  renderJobs();
  planTimer = setTimeout(async () => {
    const ac = planAbort = new AbortController();
    try {
      const plan = await api.plan(exportRequest(), ac.signal);
      if (ac !== planAbort) return;
      state.plan = plan; state.planError = null;
    } catch (err) {
      if (ac.signal.aborted) return;
      state.plan = null;
      state.planError = err.message === 'Failed to fetch' ? 'Cannot reach the server' : err.message;
    }
    planAbort = null;
    state.planPending = false;
    renderEstimate();
    renderOptions();
    renderJobs();
    emit('plan');
    if (exportWhenPlanned) { exportWhenPlanned = false; startExport(); }
  }, 150);
}

// ---------- jobs ----------

export function exportEnabled() {
  return !!(state.clips.length && state.plan && !state.planPending && !state.planError && !anyJobActive());
}

function progressInto(fill, text, job, label) {
  const p = job.progress || 0;
  fill.style.width = `${Math.round(p * 100)}%`;
  if (job.status === 'queued') text.textContent = `${label} queued…`;
  else {
    const bits = [`${label} ${Math.round(p * 100)}%`];
    if (job.passes > 1) bits.push(`pass ${job.pass || 1}/${job.passes}`);
    const eta = fmtEta(job.etaSeconds);
    if (eta) bits.push(eta);
    text.textContent = bits.join(' · ');
  }
}

export function renderJobs() {
  const exp = state.job, pre = state.previewJob;
  const exporting = jobActive(exp), previewing = jobActive(pre);
  el.exportBtn.hidden = exporting;
  el.exportBtn.disabled = !exportEnabled();
  el.progress.hidden = !exporting;
  el.previewBtn.hidden = previewing;
  el.previewBtn.disabled = !exportEnabled() || !!(state.preview && !state.preview.stale && state.monitorMode === 'preview');
  el.previewBtn.textContent = state.preview?.stale ? 'Re-render preview' : 'Preview';
  el.previewProgress.hidden = !previewing;
  el.cancelBtn.hidden = !exporting && !previewing;
  if (exporting) progressInto(el.progressFill, el.progressText, exp, 'Exporting');
  if (previewing) progressInto(el.previewFill, el.previewText, pre, 'Preview');

  const job = exp && !exporting ? exp : pre && !previewing && pre.status === 'error' ? pre : null;
  el.resultRow.hidden = !job;
  if (!job) return;
  el.resultRow.className = `row result-row ${job.status}`;
  const done = job.status === 'done';
  el.revealBtn.hidden = !done;
  el.downloadBtn.hidden = !done;
  el.logDetails.hidden = !(job.status === 'error' && job.log);
  if (done) {
    el.resultText.textContent = ['Exported', job.outputBytes != null ? fmtMB(job.outputBytes) : null, basename(job.outputPath), job.outputPath !== basename(job.outputPath) ? `in ${job.outputPath.slice(0, -basename(job.outputPath).length)}` : null].filter(Boolean).join(' · ');
    el.downloadBtn.href = api.downloadUrl(job.id);
    el.downloadBtn.setAttribute('download', basename(job.outputPath) || 'export.mp4');
  } else if (job.status === 'error') {
    el.resultText.textContent = `${job.preview ? 'Preview' : 'Export'} failed: ${job.error || 'unknown error'}`;
    el.logPre.textContent = job.log || '';
  } else {
    el.resultText.textContent = 'Export cancelled';
  }
}

async function runJob(request, assign) {
  let data;
  try {
    data = await api.export(request);
  } catch (err) {
    assign({ id: null, status: 'error', error: err.message, preview: !!request.preview });
    renderJobs();
    return null;
  }
  assign({ id: data.jobId, status: 'queued', progress: 0, preview: !!request.preview });
  renderJobs();
  return data.jobId;
}

export async function startExport() {
  // Enter right after an edit lands inside the plan debounce: export as soon as the plan is back.
  if (state.clips.length && state.planPending && !anyJobActive()) { exportWhenPlanned = true; return; }
  if (!exportEnabled()) return;
  if (stopExport) stopExport();
  state.job = { id: null, status: 'queued', progress: 0 };
  renderJobs();
  const id = await runJob(exportRequest(), (j) => { state.job = j; });
  if (!id) return;
  stopExport = followJob(id, (job) => {
    if (!state.job || state.job.id !== id) return;
    state.job = job;
    renderJobs();
    if (!jobActive(job)) emit('job-done', job);
  });
}

export async function startPreview() {
  if (!exportEnabled()) return;
  if (stopPreview) stopPreview();
  state.previewJob = { id: null, status: 'queued', progress: 0, preview: true };
  renderJobs();
  const id = await runJob(exportRequest({ preview: true }), (j) => { state.previewJob = j; });
  if (!id) return;
  stopPreview = followJob(id, (job) => {
    if (!state.previewJob || state.previewJob.id !== id) return;
    state.previewJob = job;
    if (job.status === 'done') {
      state.preview = { jobId: job.id, url: api.jobStreamUrl(job.id), duration: job.plan?.duration || 0, stale: false };
      setMonitorMode('preview');
      emit('monitor');
    }
    renderJobs();
  });
}

export function cancelJobs() {
  for (const j of [state.job, state.previewJob]) if (jobActive(j) && j.id) api.cancel(j.id).catch(() => {});
}

export function anyRunning() { return anyJobActive(); }

// ---------- wiring ----------

function bindOption(select, key) {
  select.addEventListener('change', () => { setOutput({ [key]: select.value }); });
}

export function initOutput() {
  el.presets.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (b) setOutput({ preset: b.dataset.preset });
  });
  el.targetMB.addEventListener('input', () => {
    const v = Number(el.targetMB.value);
    if (v >= 1) setOutput({ targetMB: v });
  });
  bindOption(el.optCut, 'cut');
  bindOption(el.optResolution, 'resolution');
  bindOption(el.optFps, 'fps');
  bindOption(el.optAudio, 'audio');
  bindOption(el.optSpeed, 'speed');
  bindOption(el.optEncoder, 'encoder');

  el.exportBtn.addEventListener('click', startExport);
  el.previewBtn.addEventListener('click', startPreview);
  el.cancelBtn.addEventListener('click', cancelJobs);
  el.revealBtn.addEventListener('click', () => { if (state.job?.id) api.reveal(state.job.id).catch(() => {}); });
  el.dismissResultBtn.addEventListener('click', () => { if (!jobActive(state.job)) state.job = null; if (!jobActive(state.previewJob)) state.previewJob = null; renderJobs(); });
  el.logDetails.addEventListener('toggle', () => { el.logDetails.querySelector('summary').textContent = el.logDetails.open ? 'Hide log' : 'Show log'; });

  on('output', () => { renderOptions(); requestPlan(); });
  on('sequence', () => { renderOptions(); requestPlan(); });
  on('sources', renderOptions);
  on('monitor', renderJobs);
  on('info', () => {
    const encoders = state.info?.encoders || [];
    el.optEncoder.replaceChildren(...['auto', ...encoders].map((name) => { const o = document.createElement('option'); o.value = name; o.textContent = name === 'auto' ? 'Auto' : name; return o; }));
    if (!encoders.includes(state.output.encoder)) state.output.encoder = 'auto';
    renderOptions();
  });
  renderOptions();
  renderEstimate();
  renderJobs();
}

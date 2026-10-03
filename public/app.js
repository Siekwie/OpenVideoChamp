// Entry point: wires the modules together, handles media import, menus, keyboard shortcuts.
import { $, h, fmtShort } from './js/util.js';
import { api, upload } from './js/api.js';
import { state, on, emit, addSource, addClip, removeClip, duplicateClip, moveClip, selectClip, selectedIndex, selectedClip, setMusic, undo, redo, clearSequence,
  loadOutputOptions, isImage, jobActive } from './js/state.js';
import { initMonitor, togglePlay, stepFrames, jumpTo, setIn, setOut, splitAtPlayhead, renderMonitor } from './js/monitor.js';
import { initSequence, setSequenceHandlers, renderSequence } from './js/sequence.js';
import { initInspector, setInspectorHandlers, renderInspector } from './js/inspector.js';
import { initOutput, startExport, startPreview, cancelJobs, requestPlan, renderOptions } from './js/output.js';
import { initTitleCard, openTitleCard } from './js/titlecard.js';
import { initProject, downloadProject, loadProjectFile, loadProject, autosaved, clearAutosave, projectName } from './js/project.js';

const el = {};
for (const id of ['app', 'projectName', 'addMenu', 'addBtn', 'addFileBtn', 'addCardBtn', 'addFromSep', 'addFromLabel', 'addFromList', 'projectMenu', 'projectBtn',
  'saveProjectBtn', 'openProjectBtn', 'newProjectBtn', 'copyDocsBtn', 'helpBtn', 'fileInput', 'projectInput', 'openBtn2', 'cardBtn2', 'dropError', 'toasts',
  'restoreBar', 'restoreText', 'restoreBtn', 'restoreDismissBtn', 'helpDialog', 'helpCloseBtn', 'version', 'video']) el[id] = $(id);

// ---------- toasts ----------

export function toast(message, { kind = 'info', ttl = 4000, progress } = {}) {
  const t = h('div', { class: `toast ${kind}` }, h('span', { class: 'toasttext', text: message }), progress != null ? h('div', { class: 'toastbar' }, h('div', { class: 'toastfill' })) : null);
  el.toasts.append(t);
  const api2 = {
    update(msg, frac) {
      if (msg != null) t.querySelector('.toasttext').textContent = msg;
      const fill = t.querySelector('.toastfill');
      if (fill && frac != null) fill.style.width = `${Math.round(frac * 100)}%`;
    },
    close(after = 0) { setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, after); },
  };
  if (ttl) api2.close(ttl);
  return api2;
}

// ---------- adding media ----------

let musicPending = false; // the next audio file becomes the music track

function placeSource(src, { seconds } = {}) {
  addSource(src);
  if (src.kind === 'audio') {
    if (!state.music || musicPending) {
      setMusic({ sourceId: src.id, start: 0, volume: 0.5, fadeIn: 1, fadeOut: 2, loop: true, mode: 'mix' });
      toast(`Music: ${src.name}`);
    } else toast(`${src.name} is loaded; pick it in the Music panel.`);
    musicPending = false;
    return;
  }
  if (musicPending && src.hasAudio) {
    setMusic({ sourceId: src.id, start: 0, volume: 0.5, fadeIn: 1, fadeOut: 2, loop: true, mode: 'mix' });
    musicPending = false;
    toast(`Music: ${src.name}`);
    return;
  }
  musicPending = false;
  addClip(src, seconds ? { end: seconds } : {});
}

async function openPath(path) {
  try { placeSource(await api.open(path)); } catch (err) { showError(err.message); }
}

async function openDialog() {
  if (state.info && state.info.dialog === false) return el.fileInput.click();
  try {
    const data = await api.openDialog();
    if (data.unsupported) return el.fileInput.click();
    if (data.cancelled) { musicPending = false; return; }
    placeSource(data);
  } catch (err) {
    if (err.message === 'Failed to fetch') el.fileInput.click(); else showError(err.message);
  }
}

async function uploadFiles(files) {
  const list = [...files].filter((f) => f && f.size);
  if (!list.length) return;
  if (list.length === 1 && /\.(json)$/i.test(list[0].name)) return openProjectFile(list[0]);
  for (const file of list) {
    const t = toast(`Importing ${file.name}…`, { ttl: 0, progress: 0 });
    try {
      const src = await upload(file, file.name, (f) => t.update(`Importing ${file.name} · ${Math.round(f * 100)}%`, f));
      t.close();
      placeSource(src);
    } catch (err) {
      t.close();
      showError(`${file.name}: ${err.message}`);
    }
  }
}

function showError(msg) {
  if (!state.clips.length) { el.dropError.textContent = msg; setTimeout(() => { if (el.dropError.textContent === msg) el.dropError.textContent = ''; }, 8000); }
  toast(msg, { kind: 'error', ttl: 7000 });
}

// ---------- menus ----------

function closeMenus() {
  for (const m of [el.addMenu, el.projectMenu]) {
    m.querySelector('.menupanel').hidden = true;
    m.querySelector('button').setAttribute('aria-expanded', 'false');
  }
}

function toggleMenu(menu) {
  const panel = menu.querySelector('.menupanel');
  const open = panel.hidden;
  closeMenus();
  if (open) {
    if (menu === el.addMenu) renderAddFrom();
    panel.hidden = false;
    menu.querySelector('button').setAttribute('aria-expanded', 'true');
  }
}

function renderAddFrom() {
  const sources = [...state.sources.values()].filter((s) => s.kind !== 'audio');
  el.addFromSep.hidden = el.addFromLabel.hidden = !sources.length;
  el.addFromList.replaceChildren(...sources.map((s) => h('button', {
    type: 'button', role: 'menuitem', onclick: () => { closeMenus(); addClip(s); },
  }, s.name, h('kbd', { text: s.kind === 'image' ? 'image' : fmtShort(s.duration) }))));
  el.addFromList.append(h('div', { class: 'menusep' }), h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenus(); musicPending = true; openDialog(); } }, 'Music track…', h('kbd', { text: 'audio' })));
}

// ---------- project ----------

async function openProjectFile(file) {
  const t = toast('Opening project…', { ttl: 0 });
  try {
    const { missing, dropped } = await loadProjectFile(file);
    t.close();
    report(missing, dropped);
  } catch (err) { t.close(); showError(err.message); }
}

function report(missing, dropped) {
  if (missing.length) toast(`Could not find: ${missing.join(', ')}${dropped ? ` (${dropped} clip${dropped === 1 ? '' : 's'} dropped)` : ''}`, { kind: 'error', ttl: 9000 });
  else toast('Project loaded');
}

async function restoreSession(data) {
  el.restoreBar.hidden = true;
  const t = toast('Restoring…', { ttl: 0 });
  try {
    const { missing, dropped } = await loadProject(data);
    t.close();
    if (missing.length) report(missing, dropped);
  } catch (err) { t.close(); showError(err.message); }
}

function renderTitle() {
  const name = projectName();
  el.projectName.textContent = name;
  document.title = state.clips.length ? `${name} · OpenVideoChamp` : 'OpenVideoChamp';
  el.app.classList.toggle('empty', !state.clips.length);
}

// ---------- keyboard ----------

function onKey(e) {
  const t = e.target;
  const inField = t.matches && t.matches('input, select, textarea');
  const dialogOpen = document.querySelector('dialog[open]');
  if (e.key === 'Escape') {
    if (dialogOpen) return;
    if (inField) t.blur(); else { closeMenus(); cancelJobs(); }
    return;
  }
  if (dialogOpen) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !inField) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (k === 'y' && !inField) { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); if (state.clips.length) downloadProject(); }
    return;
  }
  if (inField) return;
  const onButton = t.matches && t.matches('button, a, summary');
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); el.helpDialog.showModal(); return; }
  if (!state.clips.length) return;
  const i = selectedIndex();
  if (e.altKey) {
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); moveClip(i, i - 1); }
    else if (e.key === 'ArrowRight' && i >= 0 && i < state.clips.length - 1) { e.preventDefault(); moveClip(i, i + 1); }
    return;
  }
  switch (e.key) {
    case ' ': if (onButton) return; e.preventDefault(); togglePlay(); break;
    case 'i': case 'I': setIn(el.video.currentTime); break;
    case 'o': case 'O': setOut(el.video.currentTime); break;
    case 's': case 'S': splitAtPlayhead(); break;
    case 'd': case 'D': if (i >= 0) duplicateClip(i); break;
    case 'p': case 'P': startPreview(); break;
    case 'ArrowLeft': e.preventDefault(); stepFrames(-1, e.shiftKey); break;
    case 'ArrowRight': e.preventDefault(); stepFrames(1, e.shiftKey); break;
    case 'Home': e.preventDefault(); jumpTo('in'); break;
    case 'End': e.preventDefault(); jumpTo('out'); break;
    case ',': case '<': if (i > 0) selectClip(i - 1); else if (i < 0) selectClip(0); break;
    case '.': case '>': if (i >= 0 && i < state.clips.length - 1) selectClip(i + 1); else if (i < 0) selectClip(0); break;
    case 'Delete': case 'Backspace': if (i >= 0 && !onButton) { e.preventDefault(); removeClip(i); } break;
    case 'Enter': if (onButton) return; startExport(); break;
    default: return;
  }
}

// ---------- init ----------

async function init() {
  loadOutputOptions();
  initMonitor();
  initSequence();
  initInspector();
  initOutput();
  initTitleCard((src, seconds) => placeSource(src, { seconds }));
  initProject();
  setSequenceHandlers({ add: () => toggleMenu(el.addMenu), transitionDblClick: (i) => { const t = state.transitions[i]; if (t.type === 'cut') emit('transition-quick', i); } });
  setInspectorHandlers({ addMusic: () => { musicPending = true; openDialog(); } });

  el.addBtn.addEventListener('click', () => toggleMenu(el.addMenu));
  el.projectBtn.addEventListener('click', () => toggleMenu(el.projectMenu));
  el.addFileBtn.addEventListener('click', () => { closeMenus(); openDialog(); });
  el.addCardBtn.addEventListener('click', () => { closeMenus(); openTitleCard(); });
  el.openBtn2.addEventListener('click', openDialog);
  el.cardBtn2.addEventListener('click', openTitleCard);
  el.fileInput.addEventListener('change', () => { uploadFiles(el.fileInput.files); el.fileInput.value = ''; });
  el.saveProjectBtn.addEventListener('click', () => { closeMenus(); downloadProject(); });
  el.openProjectBtn.addEventListener('click', () => { closeMenus(); el.projectInput.click(); });
  el.projectInput.addEventListener('change', () => { if (el.projectInput.files[0]) openProjectFile(el.projectInput.files[0]); el.projectInput.value = ''; });
  el.newProjectBtn.addEventListener('click', () => {
    closeMenus();
    if (!state.clips.length || confirm('Clear the sequence? Loaded media stays available under Add.')) { clearSequence(); state.projectName = null; clearAutosave(); }
  });
  el.copyDocsBtn.addEventListener('click', async () => {
    closeMenus();
    try { await navigator.clipboard.writeText(await api.docs()); toast('API instructions copied'); } catch { toast('Copy failed', { kind: 'error' }); }
  });
  el.helpBtn.addEventListener('click', () => el.helpDialog.showModal());
  el.helpCloseBtn.addEventListener('click', () => el.helpDialog.close());
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
  for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) el.app.classList.add('dragging'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.app.classList.remove('dragging'); } });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.app.classList.remove('dragging');
    uploadFiles(e.dataTransfer.files);
  });

  // Mouse clicks must not leave buttons focused, or Space would re-trigger them instead of toggling playback.
  document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && e.detail > 0 && !b.closest('dialog')) b.blur(); });
  window.addEventListener('keydown', onKey);

  on('sequence', renderTitle);
  on('sources', renderTitle);
  on('job-done', (job) => { if (job.status === 'done') toast(`Exported ${job.outputPath.split(/[\\/]/).pop()}`, { kind: 'ok' }); });
  on('transition-quick', (i) => { import('./js/state.js').then((m) => m.setTransition(i, { type: 'fade', duration: 0.5 })); });

  renderTitle();
  renderMonitor();
  renderSequence();
  renderInspector();
  requestPlan();

  api.info().then((info) => {
    state.info = info;
    el.version.textContent = info.version ? `v${info.version} · ffmpeg ${info.ffmpeg?.version || ''}` : '';
    emit('info');
    renderOptions();
  }).catch(() => toast('Cannot reach the local server', { kind: 'error', ttl: 0 }));

  const path = new URLSearchParams(location.search).get('path');
  if (path) {
    history.replaceState(null, '', location.pathname);
    openPath(path);
  } else {
    const saved = autosaved();
    if (saved) {
      el.restoreText.textContent = `Restore your last session? ${saved.name || 'Untitled'} · ${saved.clips.length} clip${saved.clips.length === 1 ? '' : 's'}`;
      el.restoreBar.hidden = false;
      el.restoreBtn.onclick = () => restoreSession(saved);
      el.restoreDismissBtn.onclick = () => { el.restoreBar.hidden = true; clearAutosave(); };
    }
  }
}

init();

// exposed for debugging in the console
window.ovc = { state, selectedClip, isImage, jobActive };

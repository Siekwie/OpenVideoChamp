// Entry point: wires the modules together, handles media import, menus, keyboard shortcuts.
import { $, h, clamp, fmtShort } from './js/util.js';
import { api, upload } from './js/api.js';
import { state, on, emit, addSource, addClip, removeClip, duplicateClip, moveClip, select, selectClip, selectedIndex, setMusic, setTransition, undo, redo, clearSequence,
  loadOutputOptions, DEFAULT_MUSIC } from './js/state.js';
import { initMonitor, togglePlay, stepFrames, jumpTo, setInAtPlayhead, setOutAtPlayhead, splitAtPlayhead, renderMonitor, renderCrop } from './js/monitor.js';
import { initSequence, setSequenceHandlers, renderSequence } from './js/sequence.js';
import { initInspector, setInspectorHandlers, renderInspector, setHitAtPlayhead, onInspectorLive } from './js/inspector.js';
import { initMontage, openMontage, applyMontageStyle } from './js/montage.js';
import { initOutput, startExport, startPreview, cancelJobs, requestPlan, renderOptions } from './js/output.js';
import { initTitleCard, openTitleCard } from './js/titlecard.js';
import { initProject, downloadProject, loadProjectFile, loadProject, autosaved, clearAutosave, projectName } from './js/project.js';

const el = {};
for (const id of ['app', 'projectName', 'montageBtn', 'addMenu', 'addBtn', 'addFileBtn', 'addCardBtn', 'addMusicBtn', 'addFromSep', 'addFromLabel', 'addFromList', 'projectMenu', 'projectBtn',
  'saveProjectBtn', 'openProjectBtn', 'newProjectBtn', 'copyDocsBtn', 'helpBtn', 'fileInput', 'projectInput', 'openBtn2', 'cardBtn2', 'dropError', 'toasts',
  'restoreBar', 'restoreText', 'restoreBtn', 'restoreDismissBtn', 'helpDialog', 'helpCloseBtn', 'version']) el[id] = $(id);

// ---------- toasts ----------

function toast(message, { kind = 'info', ttl = 4000, progress = false } = {}) {
  const text = h('span', { class: 'toasttext', text: message });
  const fill = progress ? h('div', { class: 'toastfill' }) : null;
  const t = h('div', { class: `toast ${kind}` }, text, fill ? h('div', { class: 'toastbar' }, fill) : null);
  el.toasts.append(t);
  const handle = {
    update(msg, frac) {
      text.textContent = msg;
      if (fill) fill.style.width = `${Math.round(frac * 100)}%`;
    },
    close(after = 0) { setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, after); },
  };
  if (ttl) handle.close(ttl);
  return handle;
}

function showError(msg) {
  if (!state.clips.length) { el.dropError.textContent = msg; setTimeout(() => { if (el.dropError.textContent === msg) el.dropError.textContent = ''; }, 8000); }
  toast(msg, { kind: 'error', ttl: 7000 });
}

// ---------- adding media ----------

function useAsMusic(src) {
  setMusic({ ...DEFAULT_MUSIC, sourceId: src.id });
  select({ kind: 'music' });
}

// Puts a freshly opened source where it belongs: videos and images become clips, audio becomes the
// music track (unless there already is one). `music` forces "use this as the music"; `onPick` hands a
// sound to whoever asked for one (a clip's sound on hit).
function placeSource(src, { seconds, music = false, onPick = null } = {}) {
  addSource(src);
  if (onPick) {
    if (src.hasAudio) onPick(src); else showError(`${src.name} has no sound.`);
  } else if (music) {
    if (src.hasAudio) useAsMusic(src); else showError(`${src.name} has no sound to use as music.`);
  } else if (src.kind !== 'audio') addClip(src, { seconds });
  else if (!state.music) useAsMusic(src);
  else toast(`${src.name} is loaded. Pick it in the music panel to replace the current track.`, { ttl: 6000 });
}

async function openPath(path) {
  try { placeSource(await api.open(path)); } catch (err) { showError(err.message); }
}

// Without a native dialog the browser's own file picker is used; it has to remember what the pick is for.
let pickFor = null;
function pickInBrowser(music, onPick) {
  pickFor = { music, onPick };
  el.fileInput.multiple = !music && !onPick;
  el.fileInput.click();
}

async function openDialog({ music = false, onPick = null } = {}) {
  const one = music || !!onPick;
  if (state.info?.dialog === false) return pickInBrowser(music, onPick);
  try {
    const data = await api.openDialog(!one);
    if (data.unsupported) return pickInBrowser(music, onPick);
    if (data.cancelled) return;
    for (const src of data.sources || [data]) placeSource(src, { music, onPick });
    for (const f of data.failed || []) showError(`${f.path.split(/[\\/]/).pop()}: ${f.error}`);
  } catch (err) {
    if (err.message === 'Failed to fetch') pickInBrowser(music, onPick); else showError(err.message);
  }
}

async function uploadFiles(files, { music = false, onPick = null } = {}) {
  const list = [...files].filter((f) => f && f.size);
  const project = list.find((f) => /\.json$/i.test(f.name));
  if (project) return openProjectFile(project);
  for (const file of list) {
    const t = toast(`Importing ${file.name}…`, { ttl: 0, progress: true });
    try {
      const src = await upload(file, file.name, { onProgress: (f) => t.update(`Importing ${file.name} · ${Math.round(f * 100)}%`, f) });
      placeSource(src, { music, onPick });
    } catch (err) {
      showError(`${file.name}: ${err.message}`);
    }
    t.close();
  }
}

// ---------- menus ----------

const menus = () => [el.addMenu, el.projectMenu];
let menuAnchor = null;

function closeMenus() {
  for (const m of menus()) m.querySelector('.menupanel').hidden = true;
  if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
}

// Opens `menu` next to the button that asked for it (the Add menu has two: top bar and sequence strip).
function toggleMenu(menu, anchor) {
  const wasOpen = menuAnchor === anchor;
  closeMenus();
  if (wasOpen) return;
  if (menu === el.addMenu) renderAddFrom();
  const panel = menu.querySelector('.menupanel');
  panel.hidden = false;
  const a = anchor.getBoundingClientRect(), p = panel.getBoundingClientRect();
  const below = a.bottom + 6 + p.height <= window.innerHeight - 8;
  panel.style.left = `${clamp(a.right - p.width, 8, window.innerWidth - p.width - 8)}px`;
  panel.style.top = `${below ? a.bottom + 6 : Math.max(8, a.top - 6 - p.height)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  menuAnchor = anchor;
}

// Media that is already loaded can be added again without going through the file dialog.
function renderAddFrom() {
  const sources = [...state.sources.values()].filter((s) => s.kind !== 'audio');
  el.addFromSep.hidden = el.addFromLabel.hidden = !sources.length;
  el.addFromList.replaceChildren(...sources.map((s) => h('button', {
    type: 'button', role: 'menuitem', onclick: () => { closeMenus(); addClip(s); },
  }, h('span', { class: 'menutext', text: s.name }), h('kbd', { text: s.kind === 'image' ? 'image' : fmtShort(s.duration) }))));
}

// ---------- project ----------

function report({ missing, dropped }, quiet) {
  if (missing.length) toast(`Could not find: ${missing.join(', ')}${dropped ? ` (${dropped} clip${dropped === 1 ? '' : 's'} dropped)` : ''}`, { kind: 'error', ttl: 9000 });
  else if (!quiet) toast('Project loaded');
}

async function openProject(load, { label = 'Opening project…', quiet = false } = {}) {
  const t = toast(label, { ttl: 0 });
  try { report(await load(), quiet); } catch (err) { showError(err.message); }
  t.close();
}

const openProjectFile = (file) => openProject(() => loadProjectFile(file));

function renderTitle() {
  const name = projectName();
  el.projectName.textContent = name;
  document.title = state.clips.length ? `${name} · OpenVideoChamp` : 'OpenVideoChamp';
  el.app.classList.toggle('empty', !state.clips.length);
}

// ---------- keyboard ----------

function removeSelected() {
  const s = state.selection;
  if (s?.kind === 'clip') removeClip(s.index);
  else if (s?.kind === 'transition') setTransition(s.index, { type: 'cut', duration: 0 });
  else if (s?.kind === 'music' && state.music) setMusic(null);
}

function onKey(e) {
  const t = e.target;
  const inField = t.matches && t.matches('input, select, textarea');
  const dialogOpen = document.querySelector('dialog[open]');
  if (e.key === 'Escape') {
    if (dialogOpen) return;
    if (inField) t.blur(); else if (menuAnchor) closeMenus(); else cancelJobs();
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
  if (e.key === '?') { e.preventDefault(); el.helpDialog.showModal(); return; }
  if (!state.clips.length) return;
  const i = selectedIndex();
  if (e.altKey) {
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); moveClip(i, i - 1); }
    else if (e.key === 'ArrowRight' && i >= 0 && i < state.clips.length - 1) { e.preventDefault(); moveClip(i, i + 1); }
    return;
  }
  switch (e.key) {
    case ' ': if (onButton) return; e.preventDefault(); togglePlay(); break;
    case 'i': case 'I': setInAtPlayhead(); break;
    case 'o': case 'O': setOutAtPlayhead(); break;
    case 's': case 'S': splitAtPlayhead(); break;
    case 'h': case 'H': setHitAtPlayhead(); break;
    case 'd': case 'D': if (i >= 0) duplicateClip(i); break;
    case 'p': case 'P': startPreview(); break;
    case 'ArrowLeft': e.preventDefault(); stepFrames(-1, e.shiftKey); break;
    case 'ArrowRight': e.preventDefault(); stepFrames(1, e.shiftKey); break;
    case 'Home': e.preventDefault(); jumpTo('in'); break;
    case 'End': e.preventDefault(); jumpTo('out'); break;
    case ',': case '<': selectClip(Math.max(0, i - 1)); break;
    case '.': case '>': selectClip(i < 0 ? 0 : Math.min(state.clips.length - 1, i + 1)); break;
    case 'Delete': case 'Backspace': if (!onButton) { e.preventDefault(); removeSelected(); } break;
    case 'Enter': if (onButton) return; startExport(); break;
    default: return;
  }
}

// ---------- init ----------

function init() {
  loadOutputOptions();
  initMonitor();
  initSequence();
  initInspector();
  initOutput();
  initTitleCard({ add: (src, seconds) => placeSource(src, { seconds }), error: showError });
  initProject();
  const addMusic = () => openDialog({ music: true });
  setSequenceHandlers({ add: (anchor) => toggleMenu(el.addMenu, anchor), addMusic });
  setInspectorHandlers({
    addMusic, addSound: (onPick) => openDialog({ onPick }), montage: openMontage, montageStyle: applyMontageStyle,
    toast: (message, kind = 'info') => toast(message, { kind, ttl: 6000 }),
  });
  onInspectorLive(renderCrop);
  initMontage({ notify: (message, kind = 'ok') => toast(message, { kind, ttl: 9000 }) });
  el.montageBtn.addEventListener('click', openMontage);

  el.addBtn.addEventListener('click', () => toggleMenu(el.addMenu, el.addBtn));
  el.projectBtn.addEventListener('click', () => toggleMenu(el.projectMenu, el.projectBtn));
  el.addFileBtn.addEventListener('click', () => { closeMenus(); pickFor = null; openDialog(); });
  el.addCardBtn.addEventListener('click', () => { closeMenus(); openTitleCard(); });
  el.addMusicBtn.addEventListener('click', () => { closeMenus(); addMusic(); });
  el.openBtn2.addEventListener('click', () => openDialog());
  el.cardBtn2.addEventListener('click', openTitleCard);
  el.fileInput.addEventListener('change', () => { uploadFiles(el.fileInput.files, pickFor || {}); pickFor = null; el.fileInput.value = ''; });
  el.saveProjectBtn.addEventListener('click', () => { closeMenus(); if (state.clips.length) downloadProject(); else toast('Nothing to save yet'); });
  el.openProjectBtn.addEventListener('click', () => { closeMenus(); el.projectInput.click(); });
  el.projectInput.addEventListener('change', () => { if (el.projectInput.files[0]) openProjectFile(el.projectInput.files[0]); el.projectInput.value = ''; });
  el.newProjectBtn.addEventListener('click', () => {
    closeMenus();
    if (!state.clips.length || confirm('Clear the sequence? Loaded media stays available under Add.')) { clearSequence(); state.projectName = null; clearAutosave(); renderTitle(); }
  });
  el.copyDocsBtn.addEventListener('click', async () => {
    closeMenus();
    try { await navigator.clipboard.writeText(await api.docs()); toast('API instructions copied'); } catch { toast('Copy failed', { kind: 'error' }); }
  });
  el.helpBtn.addEventListener('click', () => el.helpDialog.showModal());
  el.helpCloseBtn.addEventListener('click', () => el.helpDialog.close());
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu, [data-menu]')) closeMenus(); });
  window.addEventListener('resize', closeMenus);
  for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (++dragDepth === 1) el.app.classList.add('dragging'); });
  document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; el.app.classList.remove('dragging'); } });
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
  on('sequence', () => { el.restoreBar.hidden = true; }); // the autosave now holds the new work, not the old session
  on('sources', renderTitle);
  on('job-done', (job) => { if (job.status === 'done') toast(`Exported ${job.outputPath.split(/[\\/]/).pop()}`, { kind: 'ok' }); });

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

  // `ovc <file>` opens the UI with ?path= (a media file) or ?project= (a saved project).
  const query = new URLSearchParams(location.search);
  if (query.has('path') || query.has('project')) {
    history.replaceState(null, '', location.pathname);
    if (query.has('project')) openProject(() => loadProject({ path: query.get('project') }));
    else openPath(query.get('path'));
    return;
  }
  const saved = autosaved();
  if (!saved) return;
  el.restoreText.textContent = `Restore your last session? ${saved.name || 'Untitled'} · ${saved.clips.length} clip${saved.clips.length === 1 ? '' : 's'}`;
  el.restoreBar.hidden = false;
  el.restoreBtn.onclick = () => { el.restoreBar.hidden = true; openProject(() => loadProject({ project: saved }), { label: 'Restoring…', quiet: true }); };
  el.restoreDismissBtn.onclick = () => { el.restoreBar.hidden = true; clearAutosave(); };
}

init();

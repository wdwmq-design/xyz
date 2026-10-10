'use strict';
/* Debris Tracker front end.
   DEMO mode : reads the saved files from ../data/results (works on GitHub Pages)
   LIVE mode : talks to server/server.py on your PC through a tunnel, which runs MATLAB */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const toArr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);   // MATLAB jsonencode turns 1-element arrays into scalars
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(v, d = 2) {
  if (v == null || (typeof v === 'number' && !isFinite(v))) return 'n/a';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(d);
  return String(v);
}

const state = { mode: 'demo', api: '', token: '', det: null, trk: null, trkRows: [], info: null, k: 1, stamp: 0 };
const imgCache = new Map();
let blobUrls = [];

/* ------------------------------------------------------------------ windows */
let zTop = 10;
function focusWin(w) {
  $$('.window').forEach(x => x.classList.remove('active'));
  w.classList.add('active');
  w.style.zIndex = ++zTop;
  updateTask();
}
function updateTask() {
  $$('#taskbtns .task').forEach(b => {
    const w = $('#' + b.dataset.win);
    b.classList.toggle('pressed', !w.classList.contains('hidden') && w.classList.contains('active'));
  });
}
function initWindows() {
  const bar = $('#taskbtns');
  $$('.window').forEach(w => {
    const b = document.createElement('button');
    b.className = 'btn task'; b.dataset.win = w.id; b.textContent = $('.ttl', w).textContent;
    bar.appendChild(b);
    b.onclick = () => {
      if (w.classList.contains('hidden') || !w.classList.contains('active')) { w.classList.remove('hidden'); focusWin(w); }
      else { w.classList.add('hidden'); updateTask(); }
    };
    $('.min', w).onclick = () => w.classList.toggle('shaded');
    $('.close', w).onclick = () => { w.classList.add('hidden'); updateTask(); };
    w.addEventListener('pointerdown', () => focusWin(w));
    const tb = $('.titlebar', w);
    tb.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || innerWidth <= 900) return;
      const d = $('#desktop'), dr = d.getBoundingClientRect(), r = w.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      tb.setPointerCapture(e.pointerId);
      const mv = ev => {
        w.style.left = Math.max(0, ev.clientX - dx - dr.left + d.scrollLeft) + 'px';
        w.style.top = Math.max(0, ev.clientY - dy - dr.top + d.scrollTop) + 'px';
      };
      const up = () => { tb.removeEventListener('pointermove', mv); tb.removeEventListener('pointerup', up); };
      tb.addEventListener('pointermove', mv); tb.addEventListener('pointerup', up);
    });
  });
  $('#btnStart').onclick = () => { $$('.window').forEach(w => w.classList.remove('hidden')); focusWin($('#w-conn')); };
  focusWin($('#w-detect'));
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 1000);
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ network */
const hdr = () => ({ 'X-Token': state.token, 'ngrok-skip-browser-warning': '1' });

async function apiFetch(path, opts = {}) {
  const r = await fetch(state.api + path, { ...opts, headers: { ...hdr(), ...(opts.headers || {}) }, cache: 'no-store' });
  if (!r.ok) {
    let msg = r.status + ' ' + r.statusText;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) { /* not json */ }
    throw new Error(msg);
  }
  return r;
}
async function getRes(name, type = 'json') {
  const r = state.mode === 'live'
    ? await apiFetch('/api/results/' + name)
    : await fetch('../data/results/' + name, { cache: 'no-store' });
  if (!r.ok) throw new Error(name + ': ' + r.status);
  return type === 'json' ? r.json() : type === 'text' ? r.text() : r.blob();
}
async function setImgFromRes(img, name) {
  try {
    if (state.mode === 'live') {
      const u = URL.createObjectURL(await getRes(name, 'blob')); blobUrls.push(u); img.src = u;
    } else img.src = '../data/results/' + name + '?t=' + state.stamp;
    return true;
  } catch (_) { img.removeAttribute('src'); return false; }
}
async function loadFrame(k) {
  const key = state.mode + '|' + state.stamp + '|' + k;
  if (imgCache.has(key)) return imgCache.get(key);
  let src;
  if (state.mode === 'live') {
    const u = URL.createObjectURL(await (await apiFetch('/api/frame/' + k)).blob()); blobUrls.push(u); src = u;
  } else src = '../data/frames_bmp_debris/debris_' + String(k).padStart(2, '0') + '.bmp';
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('frame ' + k + ' failed to load')); img.src = src; });
  imgCache.set(key, img);
  return img;
}

/* ------------------------------------------------------------------ mode / connection */
function setMode(mode, msg) {
  state.mode = mode;
  const live = mode === 'live';
  $('#led').className = 'led ' + (live ? 'live' : 'demo');
  $('#trayLed').className = 'led ' + (live ? 'live' : 'demo');
  $('#modeText').textContent = live ? 'LIVE: connected to your MATLAB PC' : 'DEMO MODE: cached results';
  $('#trayMode').textContent = live ? 'LIVE' : 'DEMO';
  $('#modeHelp').textContent = live
    ? 'Run buttons trigger MATLAB on the host PC. Results below come from the latest run.'
    : 'Showing saved files from the repository. MATLAB is not running. Connect to your PC to run it live.';
  $('#btnSample').disabled = !live;
  $('#btnUpload').disabled = !live;
  const m = $('#connMsg');
  m.hidden = !msg; m.textContent = msg || '';
}

async function connect() {
  state.api = $('#apiUrl').value.trim().replace(/\/+$/, '');
  state.token = $('#apiToken').value.trim();
  if (!/^https?:\/\//i.test(state.api)) { setMode('demo', 'Enter the full server URL, starting with https://'); return; }
  try {
    const h = await (await fetch(state.api + '/api/health', { headers: { 'ngrok-skip-browser-warning': '1' } })).json();
    await apiFetch('/api/status');                         // validates the token
    localStorage.setItem('dt_api', state.api);
    sessionStorage.setItem('dt_token', state.token);
    const warn = [];
    if (!h.matlabFound) warn.push('MATLAB was not found on the host (set MATLAB_EXE).');
    if (h.blinkOff === false) warn.push('debris_defaults.m has blink = true; runs will be refused until it is false.');
    setMode('live', warn.join(' '));
    await loadAll();
  } catch (e) {
    setMode('demo', 'Could not connect: ' + e.message + '. Check the URL, the token, that server.py is running, and ALLOWED_ORIGINS.');
  }
}

/* ------------------------------------------------------------------ loading + rendering */
function parseCsv(t) {
  const L = t.trim().split(/\r?\n/);
  const h = L[0].split(',');
  return L.slice(1).map(l => {
    const c = l.split(','), o = {};
    h.forEach((k, i) => { o[k] = (c[i] === '' || c[i] === 'NaN') ? NaN : +c[i]; });
    return o;
  });
}
function nFrames() {
  const d = state.det || {};
  const a = toArr(d.thresholds).length;
  const b = Math.max(0, ...toArr(d.detections).map(x => x.frame));
  const c = (state.info && state.info.nFrames) || 0;
  return Math.max(a, b, c, 1);
}

async function loadAll() {
  state.stamp = Date.now();
  imgCache.clear(); blobUrls.forEach(URL.revokeObjectURL); blobUrls = [];
  const [det, trk, csv, info] = await Promise.allSettled([
    getRes('detections.json'), getRes('tracks.json'), getRes('tracks.csv', 'text'), getRes('run_info.json')]);
  state.det = det.status === 'fulfilled' ? det.value : null;
  state.trk = trk.status === 'fulfilled' ? trk.value : null;
  state.trkRows = csv.status === 'fulfilled' ? parseCsv(csv.value) : [];
  state.info = info.status === 'fulfilled' ? info.value : null;
  state.k = Math.min(Math.max(state.k, 1), nFrames());
  renderAll();
}
function renderAll() {
  renderDetections(); renderTracks(); renderParams(); renderBlink();
}

const CLS = { 'streak-like': '#33ff33', 'artifact-like': '#ff4dff', 'compact': '#33e6ff', 'unknown': '#ffcc33' };

function placeholder(cv, text) {
  const c = cv.getContext('2d');
  cv.width = 646; cv.height = 486;
  c.fillStyle = '#202020'; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#c0c0c0'; c.font = '16px Tahoma, Arial'; c.textAlign = 'center';
  c.fillText(text, cv.width / 2, cv.height / 2);
}

async function renderDetections() {
  const n = nFrames(), k = state.k;
  $('#frameLbl').textContent = `Frame ${k} / ${n}`;
  const cv = $('#cvDet'), ctx = cv.getContext('2d');
  const all = toArr(state.det && state.det.detections);
  const rows = all.filter(d => d.frame === k);
  $('#detSummary').textContent = state.det
    ? `${all.length} regions, ${all.filter(d => d.isCandidate).length} candidates (all frames)` : '';
  try {
    const img = await loadFrame(k);
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
  } catch (e) { placeholder(cv, 'frame image not available'); }
  if (!state.det) { placeholder(cv, 'no detections.json found'); }
  rows.forEach(d => {
    const cand = d.isCandidate === true;
    ctx.lineWidth = cand ? 3 : 1.5;
    ctx.strokeStyle = cand ? '#ff2020' : (CLS[d['class']] || '#ffffff');
    ctx.strokeRect(d.bboxX - 0.5, d.bboxY - 0.5, d.bboxW, d.bboxH);          // MATLAB coords are 1-based
    const x = d.cx - 0.5, y = d.cy - 0.5;
    ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
  });
  const head = '<tr><th>#</th><th>class</th><th>subtype</th><th>cx</th><th>cy</th><th>len</th><th>elong</th><th>meanZ</th><th>cand</th></tr>';
  $('#tblDet').innerHTML = head + (rows.length ? rows.map(d =>
    `<tr><td>${d.id}</td><td>${esc(d['class'])}</td><td>${esc(d.subtype || '')}</td><td>${fmt(d.cx, 1)}</td><td>${fmt(d.cy, 1)}</td>` +
    `<td>${fmt(d.length, 1)}</td><td>${fmt(d.elongation)}</td><td>${fmt(d.meanZ, 1)}</td><td>${d.isCandidate ? 'yes' : ''}</td></tr>`).join('')
    : '<tr><td colspan="9">no regions in this frame</td></tr>');
}

function frameColor(f, n) { const t = (f - 1) / Math.max(n - 1, 1); return `hsl(${240 - 180 * t},100%,${45 + 10 * t}%)`; }

function drawEllipse(ctx, cx, cy, C, k) {
  const a = C[0][0], b = C[0][1], d = C[1][1];
  const m = (a + d) / 2, r = Math.sqrt(((a - d) / 2) ** 2 + b * b);
  const l1 = m + r, l2 = Math.max(m - r, 0);
  if (!(l1 > 0)) return;
  ctx.beginPath();
  ctx.ellipse(cx, cy, k * Math.sqrt(l1), k * Math.sqrt(l2), 0.5 * Math.atan2(2 * b, a - d), 0, 2 * Math.PI);
  ctx.stroke();
}

async function renderTracks() {
  const cv = $('#cvTrk'), ctx = cv.getContext('2d'), n = nFrames();
  try { const img = await loadFrame(1); cv.width = img.naturalWidth; cv.height = img.naturalHeight; ctx.drawImage(img, 0, 0); }
  catch (e) { placeholder(cv, 'frame image not available'); }
  const rows = state.trkRows;
  if (!rows.length) {
    ctx.fillStyle = '#ffffe1'; ctx.font = '15px Tahoma, Arial'; ctx.textAlign = 'center';
    ctx.fillText('no tracks.csv found: run track_debris', cv.width / 2, 30);
    $('#tblTrk').innerHTML = ''; return;
  }
  const ids = [...new Set(rows.map(r => r.track))];
  const jt = toArr(state.trk && state.trk.tracks);
  const tableRows = [];
  ids.forEach((id, idx) => {
    const R = rows.filter(r => r.track === id).sort((a, b) => a.frame - b.frame);
    const J = jt.find(t => t && t.id === id) || jt[idx] || {};
    // measured / coasted path
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.beginPath();
    R.forEach((r, i) => (i ? ctx.lineTo(r.x - 0.5, r.y - 0.5) : ctx.moveTo(r.x - 0.5, r.y - 0.5))); ctx.stroke();
    R.forEach(r => {
      ctx.fillStyle = frameColor(r.frame, n); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      const x = r.x - 0.5, y = r.y - 0.5;
      ctx.beginPath();
      if (r.measured === 1) ctx.arc(x, y, 6, 0, 2 * Math.PI); else ctx.rect(x - 6, y - 6, 12, 12);
      ctx.fill(); ctx.stroke();
    });
    // Kalman prediction + 3-sigma ellipses
    const fut = toArr(J.future).filter(Array.isArray);
    const last = R[R.length - 1];
    if (fut.length) {
      ctx.setLineDash([7, 5]); ctx.lineWidth = 2; ctx.strokeStyle = '#ffd800';
      ctx.beginPath(); ctx.moveTo(last.x - 0.5, last.y - 0.5);
      fut.forEach(p => ctx.lineTo(p[0] - 0.5, p[1] - 0.5)); ctx.stroke(); ctx.setLineDash([]);
      const cov = J.futureCov;   // expected [2][2][steps]; skipped if the shape is not what we expect
      if (Array.isArray(cov) && cov.length === 2 && Array.isArray(cov[0]) && cov[0].length === 2 && Array.isArray(cov[0][0])) {
        ctx.lineWidth = 1.5;
        fut.forEach((p, s) => {
          try { drawEllipse(ctx, p[0] - 0.5, p[1] - 0.5, [[cov[0][0][s], cov[0][1][s]], [cov[1][0][s], cov[1][1][s]]], 3); } catch (_) { /* skip */ }
        });
      }
    }
    // PINN future
    const pp = J.pinn && toArr(J.pinn.pred).filter(Array.isArray);
    if (pp && pp.length > R.length) {
      const pf = pp.slice(R.length);
      ctx.setLineDash([2, 4, 8, 4]); ctx.strokeStyle = '#ff40ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(last.x - 0.5, last.y - 0.5); pf.forEach(p => ctx.lineTo(p[0] - 0.5, p[1] - 0.5)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ff40ff';
      pf.forEach(p => { ctx.beginPath(); ctx.moveTo(p[0] - 0.5, p[1] - 5.5); ctx.lineTo(p[0] + 4.5, p[1] + 3.5); ctx.lineTo(p[0] - 5.5, p[1] + 3.5); ctx.closePath(); ctx.fill(); });
    }
    tableRows.push(`<tr><td>${id}</td><td>${R.filter(r => r.measured === 1).length}</td><td>${R.filter(r => r.measured !== 1).length}</td>` +
      `<td>${fmt(J.speed, 1)}</td><td>${fmt(J.heading, 1)}</td><td>${J.pinn ? fmt(J.pinn.dataRmse) : 'n/a'}</td><td>${J.pinn ? fmt(J.pinn.accRms, 3) : 'n/a'}</td></tr>`);
  });
  $('#tblTrk').innerHTML = '<tr><th>track</th><th>hits</th><th>coasted</th><th>speed px/fr</th><th>heading deg</th><th>PINN fit rmse px</th><th>PINN rms accel</th></tr>' + tableRows.join('');
}

function kv(table, obj) {
  const o = obj || {};
  const keys = Object.keys(o);
  $(table).innerHTML = keys.length
    ? keys.map(k => `<tr><td class="k">${esc(k)}</td><td>${o[k] == null ? 'n/a (off / Inf)' : esc(typeof o[k] === 'object' ? JSON.stringify(o[k]) : fmt(o[k], 4))}</td></tr>`).join('')
    : '<tr><td>not available</td></tr>';
}
function renderParams() {
  const d = state.det || {}, info = state.info;
  $('#runInfo').innerHTML = info
    ? `Last run: <b>${esc(info.mode)}</b> at ${esc(info.finished)}, ${info.nFrames} frames, ` +
      (info.ok ? 'finished OK' : '<b>FAILED</b>') + '. Ground truth used for scoring: <b>' + (info.groundTruthUsed ? 'yes (simulated data)' : 'no') + '</b>.' +
      (toArr(info.stale).length ? ` <b>Stale files (not written by this run):</b> ${esc(info.stale.join(', '))}` : '')
    : (state.mode === 'demo' ? 'Demo: saved results from the repository. Accuracy numbers are in-sample on simulated debris.' : '');
  const m = d.metrics;
  $('#tblMetrics').innerHTML = m && m.TP != null
    ? `<tr><th>TP</th><th>FP</th><th>FN</th><th>precision</th><th>recall</th><th>F1</th></tr><tr><td>${m.TP}</td><td>${m.FP}</td><td>${m.FN}</td><td>${fmt(m.precision)}</td><td>${fmt(m.recall)}</td><td>${fmt(m.F1)}</td></tr>`
    : '<tr><td>No score: no ground truth for this data.</td></tr>';
  const th = toArr(d.thresholds);
  $('#tblThr').innerHTML = th.length
    ? '<tr><th>frame</th><th>noise sigma0</th><th>Otsu T</th><th>final T</th></tr>' + th.map((t, i) => `<tr><td>${i + 1}</td><td>${fmt(t.sig0, 3)}</td><td>${fmt(t.otsuT)}</td><td>${fmt(t.T)}</td></tr>`).join('')
    : '<tr><td>not available</td></tr>';
  kv('#tblCfg', d.params);
  kv('#tblTc', state.trk && state.trk.params);
}

async function renderBlink() {
  const ok = await setImgFromRes($('#blinkImg'), 'blink.gif');
  $('#blinkNote').textContent = ok
    ? 'blink.gif comes from blink_frames.m (an interactive tool) and is not regenerated by web runs, so it may show earlier frames.'
    : 'blink.gif not found.';
}

/* ------------------------------------------------------------------ running MATLAB */
function setProgress(cls, text) {
  $('#progress').className = 'progress ' + (cls || '');
  $('#runState').textContent = text;
}
async function startRun(mode) {
  const fd = new FormData();
  fd.append('mode', mode);
  if (mode === 'upload') {
    const fl = [...$('#files').files];
    if (fl.length < 3) { setProgress('fail', 'Choose at least 3 BMP files first.'); return; }
    fl.forEach(f => fd.append('frames', f, f.name));
  }
  $('#btnSample').disabled = $('#btnUpload').disabled = true;
  $('#log').textContent = '';
  setProgress('run', 'Starting MATLAB ...');
  try {
    await apiFetch('/api/run', { method: 'POST', body: fd });
    let s;
    do {
      await sleep(1500);
      s = await (await apiFetch('/api/status')).json();
      const lg = $('#log'); lg.textContent = s.log.join('\n'); lg.scrollTop = lg.scrollHeight;
      setProgress('run', `MATLAB running ... ${s.elapsed}s`);
    } while (s.state === 'running');
    if (s.state === 'done') { setProgress('ok', `Finished in ${s.elapsed}s. Loading results ...`); await loadAll(); setProgress('ok', `Finished in ${s.elapsed}s. Results updated.`); }
    else setProgress('fail', 'Run failed: ' + s.message);
  } catch (e) {
    setProgress('fail', 'Error: ' + e.message);
  } finally {
    const live = state.mode === 'live';
    $('#btnSample').disabled = $('#btnUpload').disabled = !live;
  }
}

/* ------------------------------------------------------------------ init */
document.addEventListener('DOMContentLoaded', () => {
  initWindows();
  $('#apiUrl').value = localStorage.getItem('dt_api') || '';
  $('#apiToken').value = sessionStorage.getItem('dt_token') || '';
  $('#btnConnect').onclick = connect;
  $('#btnDemo').onclick = async () => { setMode('demo'); await loadAll(); };
  $('#btnSample').onclick = () => startRun('sample');
  $('#btnUpload').onclick = () => startRun('upload');
  $('#prevF').onclick = () => { state.k = state.k > 1 ? state.k - 1 : nFrames(); renderDetections(); };
  $('#nextF').onclick = () => { state.k = state.k < nFrames() ? state.k + 1 : 1; renderDetections(); };
  setMode('demo');
  loadAll();
});

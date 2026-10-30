'use strict';
// MEKONIQ Serve S1 — site config validation. The live site lives in Node-RED global context and is edited from
// setup.html; everything saved goes through normalize() so a bad save can never take Node-RED down.
// Also loaded by the browser (setup.html) the way map.html loads lib/route.js.

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;
const KINDS = ['table', 'station', 'dish', 'dock', 'entrance'];   // entrance = where guests wait to be guided
// Valetudo per-robot knobs: [default, min, max]. Hints shown by setup.html.
const KNOBS = {
  arriveCm: [40, 0, 300], nomoveSec: [10, 5, 300], tripSec: [180, 5, 300],
  retrySec: [15, 5, 300], retryMax: [4, 1, 20], stuckSec: [20, 5, 300], progressCm: [15, 0, 300], acceptCm: [80, 0, 300],
};
const RETRY_ERR = 'unreach|target|navigat|path';
const MAX_BYTES = 512 * 1024;
const FEATURES = ['call', 'guide', 'order', 'pay'];
const NOTES = ['Không hành', 'Ít cay', 'Món nóng', 'Thêm chén'];   // station quick-note chips
const TIMING = ['loadSec', 'handoffSec', 'remindSec', 'standbySec', 'lowBattery', 'chargedBattery'];

// Validates and cleans a site coming from the UI. Returns {site, errors}; errors non-empty = reject.
// Unknown fields are kept so an older UI never destroys newer config.
function normalize(input, seed) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { site: null, errors: ['Cấu hình không hợp lệ (không phải JSON object)'] };
  if (JSON.stringify(input).length > MAX_BYTES) return { site: null, errors: ['Cấu hình quá lớn (> 512 KB)'] };
  const site = JSON.parse(JSON.stringify(input));
  const num = (obj, key, min, max, where) => {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') { delete obj[key]; return; }
    const v = Number(obj[key]);
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${where}.${key}: phải là số từ ${min} đến ${max}`);
    else obj[key] = v;
  };

  site.name = String(site.name || seed.name || '').slice(0, 60);
  site.rev = Number(site.rev) || 0;
  num(site, 'trays', 1, 8, 'site'); if (site.trays === undefined) site.trays = seed.trays;
  site.timing = site.timing && typeof site.timing === 'object' ? site.timing : { ...seed.timing };
  for (const k of TIMING) { num(site.timing, k, 0, k.endsWith('Battery') ? 100 : 3600, 'timing'); if (site.timing[k] === undefined) site.timing[k] = seed.timing[k]; }
  if (site.timing.lowBattery >= site.timing.chargedBattery) errors.push(`timing: Pin yếu (${site.timing.lowBattery} %) phải thấp hơn Pin đủ (${site.timing.chargedBattery} %)`);

  const f = site.features && typeof site.features === 'object' ? site.features : {};
  site.features = Object.fromEntries(FEATURES.map(k => [k, !!f[k]]));
  const notes = (Array.isArray(site.notes) ? site.notes : []).map(n => String(n ?? '').trim().slice(0, 24)).filter(Boolean).slice(0, 8);
  site.notes = notes.length ? notes : [...NOTES];

  // points
  site.points = site.points && typeof site.points === 'object' ? site.points : {};
  const dishes = [];
  for (const [id, p] of Object.entries(site.points)) {
    if (!ID.test(id)) { errors.push(`Điểm "${id}": id phải bắt đầu bằng chữ, chỉ chữ/số/_/-, tối đa 16 ký tự`); continue; }
    if (!p || typeof p !== 'object') { errors.push(`Điểm "${id}": không hợp lệ`); continue; }
    if (!KINDS.includes(p.kind)) errors.push(`Điểm "${id}": loại "${p.kind}" không hợp lệ`);
    p.name = String(p.name || id).slice(0, 40);
    if (p.kind === 'dish') dishes.push(id);
    for (const k of ['x', 'y']) if (p[k] !== undefined) { const v = Number(p[k]); if (Number.isFinite(v)) p[k] = v; else delete p[k]; }
  }
  menu(site, errors);
  // Bank transfer details for the robot pay screen (features.pay); qr = static QR image uploaded in setup.
  const pay = site.payment && typeof site.payment === 'object' ? site.payment : {};
  site.payment = { ...pay, bank: String(pay.bank || '').trim().slice(0, 20), account: String(pay.account || '').replace(/[\s.-]/g, ''), name: String(pay.name || '').trim().slice(0, 60) };
  if (!/^\d*$/.test(site.payment.account)) errors.push('payment.account: chỉ gồm chữ số');
  if (pay.qr === undefined || pay.qr === '') delete site.payment.qr;
  else if (!/^data:image\/(png|jpeg|webp);base64,/.test(String(pay.qr)) || String(pay.qr).length > 200 * 1024) errors.push('payment.qr: phải là ảnh PNG/JPEG/WebP ≤ 200 KB');
  if (dishes.length !== 1) errors.push(`Phải có đúng một điểm loại dish (khu rửa chén), hiện có ${dishes.length}`);
  if (!site.points[site.dishPoint] || site.points[site.dishPoint].kind !== 'dish') errors.push(`dishPoint "${site.dishPoint}" phải là điểm loại dish`);

  // roles
  site.roles = Array.isArray(site.roles) && site.roles.length ? site.roles : JSON.parse(JSON.stringify(seed.roles));
  site.roles.forEach((r, i) => {
    if (!r || !ID.test(String(r.id))) errors.push(`Vai trò #${i + 1}: id không hợp lệ`);
    else { r.name = String(r.name || r.id).slice(0, 40); if (r.home && !site.points[r.home]) errors.push(`Vai trò "${r.id}": điểm nhà "${r.home}" không tồn tại`); if (!r.home) r.home = null;
      if (!['deliver', 'bus', 'summon'].includes(r.tab)) r.tab = 'deliver'; }
  });

  // robots. A site from the previous version kept the coordinates in site.valetudo.points: move them into the first robot.
  site.robots = Array.isArray(site.robots) ? site.robots : [];
  if (site.valetudo && site.valetudo.points) {
    const first = site.robots.find(r => r && r.driver === 'valetudo');
    if (first) { first.valetudo = first.valetudo || {}; first.valetudo.points = { ...site.valetudo.points, ...(first.valetudo.points || {}) }; }
    delete site.valetudo;
  }
  const seenR = new Set();
  site.robots.forEach((r, i) => {
    if (!r || !ID.test(String(r.id))) { errors.push(`Robot #${i + 1}: id không hợp lệ`); return; }
    if (seenR.has(r.id)) errors.push(`Robot "${r.id}" bị trùng`); seenR.add(r.id);
    if (!site.points[r.dock] || site.points[r.dock].kind !== 'dock') errors.push(`Robot "${r.id}": trạm sạc "${r.dock}" không phải điểm loại dock`);
    if (r.driver !== 'valetudo') { delete r.driver; delete r.valetudo; return; }
    const v = r.valetudo = r.valetudo && typeof r.valetudo === 'object' ? r.valetudo : {};
    v.topic = String(v.topic || '').trim().replace(/\/+$/, '');
    for (const k of Object.keys(KNOBS)) num(v, k, KNOBS[k][1], KNOBS[k][2], `${r.id}.valetudo`);
    if (v.retryErr !== undefined) { try { new RegExp(String(v.retryErr), 'i'); v.retryErr = String(v.retryErr); } catch (e) { errors.push(`${r.id}.valetudo.retryErr: biểu thức không hợp lệ`); } }
    const size = v.mapRef && v.mapRef.size;
    const pts = v.points && typeof v.points === 'object' ? v.points : {};
    v.points = {};
    for (const [id, p] of Object.entries(pts)) {
      if (!site.points[id]) continue;   // point was deleted: drop its coords
      const x = Math.round(Number(p && p.x)), y = Math.round(Number(p && p.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || (size && (x > size.x || y > size.y)))
        errors.push(`${r.id}: toạ độ điểm "${id}" nằm ngoài bản đồ`);
      else v.points[id] = { x, y };
    }
  });
  return { site, errors };
}

// Robot menu (features.order): cats [{id, vi, en, station}], items [{id, cat, vi, en, price}] in VND.
const firstStation = site => Object.keys(site.points || {}).find(k => site.points[k].kind === 'station');
function menu(site, errors) {
  const m = site.menu && typeof site.menu === 'object' ? site.menu : {};
  const cats = Array.isArray(m.cats) ? m.cats.filter(x => x && typeof x === 'object') : [];
  const items = Array.isArray(m.items) ? m.items.filter(x => x && typeof x === 'object') : [];
  const seen = new Set();
  const named = (x, what) => {
    x.id = String(x.id || '');
    if (!ID.test(x.id)) errors.push(`${what} "${x.id}": id không hợp lệ`);
    else if (seen.has(x.id)) errors.push(`${what} "${x.id}" bị trùng`);
    seen.add(x.id);
    x.vi = String(x.vi || x.id).slice(0, 40); x.en = String(x.en || x.vi).slice(0, 40);
  };
  for (const c of cats) {
    named(c, 'Danh mục');
    c.station = String(c.station || firstStation(site) || '');
    if (!site.points[c.station] || site.points[c.station].kind !== 'station') errors.push(`Danh mục "${c.id}": trạm "${c.station}" không phải điểm loại station`);
  }
  seen.clear();
  for (const it of items) {
    named(it, 'Món');
    if (!cats.some(c => c.id === it.cat)) errors.push(`Món "${it.id}": danh mục "${it.cat}" không tồn tại`);
    const p = Number(it.price);
    if (!Number.isInteger(p) || p < 0) errors.push(`Món "${it.id}": price phải là số nguyên ≥ 0 (VND)`);
    else it.price = p;
  }
  site.menu = { ...m, cats, items };
}

// Point ids and robot ids referenced by open missions — they cannot be deleted while in use.
function inUse(site, st) {
  const points = new Set(), robots = new Set();
  const open = s => s.status === 'pending' || s.status === 'active';
  for (const m of (st && st.missions) || []) {
    if (!['queued', 'active', 'pending'].includes(m.status)) continue;
    for (const s of m.stops || []) if (open(s)) points.add(s.p);
    if (m.robot) robots.add(m.robot);
  }
  for (const [id, r] of Object.entries((st && st.robots) || {})) if (r.mission) robots.add(id);
  return { points, robots };
}

// First free table id T01, T02, …
function nextTable(site) {
  for (let i = 1; i < 1000; i++) {
    const nn = String(i).padStart(2, '0');
    if (!site.points['T' + nn]) return { id: 'T' + nn, name: 'Bàn ' + nn };
  }
}

module.exports = { normalize, inUse, nextTable, KNOBS, RETRY_ERR, MAX_BYTES, ID, KINDS, NOTES, firstStation };

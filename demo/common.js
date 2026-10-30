// Shared by station / robot / table pages: messaging (via transport.js), MP3 cues, labels, small UI helpers.
const App = { site: null, state: null, map: null, skew: 0, migrated: false, lang: 'vi' };   // migrated: the live site is still in the pre-v2 format; lang: vi | en | both (robot)
// ?orient=portrait forces the portrait layout (screenshot aid); CSS mirrors the orientation media query under :root[data-orient=portrait].
if (new URLSearchParams(location.search).get('orient') === 'portrait') document.documentElement.dataset.orient = 'portrait';

function connect(onMsg) {
  const off = document.getElementById('offline'), dot = document.getElementById('conn');
  Transport.connect(raw => {
    let m;
    try { m = JSON.parse(raw); } catch (err) { return; }
    if (m.type === 'site') { App.site = m.site; App.migrated = !!m.migrated; }
    if (m.type === 'map') App.map = m.map;
    if (m.type === 'state') { App.state = m; App.skew = Date.now() - m.now; }
    if (m.type === 'event' && m.reply) m.settled = settle(m);
    if (App.site) onMsg(m);
  }, up => {
    if (off) off.hidden = up;
    if (dot) dot.classList.toggle('on', up);
    if (up) { send({ type: 'hello' }); for (const q of reqs.values()) if (q.retry) send(q.msg); }
  });
}
function send(obj) { Transport.send(JSON.stringify(obj)); }

// Guest requests (spec §6): pending until the server's reply event with the same requestId, so nothing is toasted as
// sent before the server took it. ok = [vi, en] success text; done(reply) runs on ok, refusal or timeout.
// retry: the server keeps receipts, so a reconnect sends the same request (same requestId) again; a new tap is a new request.
const REPLY_MS = 10000, reqs = new Map();
function request(msg, ok, done = () => {}, retry = false) {
  const id = msg.requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  reqs.set(id, { msg, ok, done, retry, timer: setTimeout(() => settle({ requestId: id, ok: false, code: 'timeout' }), REPLY_MS) });
  send(msg);
  return id;
}
function settle(m) {
  const q = reqs.get(m.requestId);
  if (!q) return false;
  clearTimeout(q.timer); reqs.delete(m.requestId);
  if (!m.ok) toast(refusal(m), 'warn');
  else if (q.ok) toast(say(...q.ok));   // duplicate = an earlier send of this request got through
  q.done(m);
  return true;
}
const forget = id => { const q = reqs.get(id); if (q) { clearTimeout(q.timer); reqs.delete(id); } };   // the state already shows the outcome
const sending = test => [...reqs.values()].some(q => test(q.msg));
const say = (vi, en) => App.lang === 'en' ? en : App.lang === 'both' ? vi + ' · ' + en : vi;
// Server refusals are Vietnamese; guests reading English get a line per code.
const REFUSED_EN = { disabled: 'This service is turned off', 'not-ready': 'This service is not set up yet', stale: 'This item has changed — please reload',
  policy: 'Please use “Wrong item / Need help”', billing: 'Your bill is being prepared — please ask staff', unreachable: 'The robot cannot reach that table yet',
  unsupported: 'This robot cannot change speed', invalid: 'Please check your choice and try again', reload: 'Please reload this page',
  status: 'This bill was already handled — please ask staff' };
const refusal = m => m.code === 'timeout' ? say('Chưa nhận được xác nhận — vui lòng thử lại', 'No confirmation yet — please try again')
  : say(m.text || 'Chưa gửi được', REFUSED_EN[m.code] || 'Not sent — please ask staff');

// Browsers block autoplay until a user tap, so audio is unlocked from a click handler.
const SOUNDS = ['excuse', 'arrived', 'remind', 'thanks', 'load', 'collect', 'unload', 'cancel', 'estop', 'blocked', 'standby', 'alert', 'cancelled', 'ding'];
const audio = {};
let soundOn = false;
function enableSound() {
  if (soundOn) return;
  for (const n of SOUNDS) { audio[n] = new Audio('audio/' + n + '.mp3'); audio[n].load(); }
  soundOn = true;
}
function play(name) {
  if (!soundOn || !audio[name]) return;
  audio[name].currentTime = 0;
  audio[name].play().catch(() => {});
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const pname = id => (App.site.points[id] || {}).name || id;
const short = id => pname(id).replace('Bàn ', '');
const serverNow = () => Date.now() - App.skew;
const ago = t => { const s = Math.max(0, Math.round((serverNow() - t) / 1000)); return s < 60 ? s + ' giây' : Math.floor(s / 60) + ' phút'; };
const clock = t => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ACTION_VI = { load: 'Xếp đồ lên khay', handoff: 'Giao cho khách', collect: 'Thu chén đĩa', unload: 'Dỡ chén đĩa', return: 'Trả đồ bị huỷ', standby: 'Chờ lệnh', guide: 'Dẫn khách' };

function missionOf(r) { return r && r.mission ? App.state.missions.find(m => m.id === r.mission) : null; }
const etaSec = r => Math.round((r.rem || 0) / ((App.site.sim || {}).speed || 1) / (r.slow || 1));   // remaining route length, not straight line
// Simulator robots drive on the hand-drawn floor plan (web demo); a Valetudo-only site shows the robot's own map instead.
const vnd = n => String(n).replace(/\B(?=(\d{3})+$)/g, '.') + 'đ';
const feat = f => !!App.site && FeaturePolicy.readiness(App.site, f).effective;   // flag on and config ready (lib/feature-policy.js, spec §5)
const hasSim = () => !!App.site && App.site.robots.some(r => !r.driver || r.driver === 'sim');
// [text, tone] for a robot's current status.
function robotStatus(r) {
  if (r.offline) return ['Mất kết nối', 'danger'];
  if (r.halt === 'estop') return ['Dừng khẩn cấp', 'danger'];
  if (r.halt === 'blocked') return ['Bị chặn đường', 'danger'];
  if (r.halt === 'paused') return ['Tạm dừng', 'warn'];
  const m = missionOf(r);
  if (r.nav === 'wait') return [r.why === 'person' ? 'Chờ người đi qua' : r.why === 'robot' ? 'Chờ robot phía trước' : 'Gặp vật cản · đang chờ', 'warn'];
  if (r.nav === 'yield') return ['Nhường lối ' + (r.why ? 'cho ' + r.why : 'hẹp'), 'warn'];
  if (r.nav === 'queue') return ['Chờ tới lượt · ' + pname(r.target), 'warn'];
  if (r.phase === 'toStop') return ['Đang tới ' + pname(r.target), 'go'];
  if (r.phase === 'atStop' && m) return [ACTION_VI[m.stops[m.cur].a] + ' · ' + pname(r.at), 'warn'];
  if (r.phase === 'toDock') return ['Về trạm sạc', 'go'];
  if (r.charging) return ['Đang sạc', 'warn'];
  return ['Sẵn sàng', 'ok'];
}

// Two-tap confirmation for destructive actions: first tap arms (3s), second tap runs.
let armedKey = null, armedTimer;
function armed(key, run, rerender) {
  if (armedKey === key) { armedKey = null; clearTimeout(armedTimer); run(); }
  else { armedKey = key; clearTimeout(armedTimer); armedTimer = setTimeout(() => { armedKey = null; rerender(); }, 3000); }
  rerender();
}
const isArmed = key => armedKey === key;

// Only touch the DOM when content changed, so clicks are not swallowed by re-renders.
function setHTML(el, html) { if (el.__html !== html) { el.__html = html; el.innerHTML = html; } }

// One pill at a time: a new toast replaces the previous one.
function toast(text, level = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + level; t.textContent = text;
  box.replaceChildren(t);
  setTimeout(() => t.remove(), 2400);
}

// Bilingual label, VI line + EN line. Arguments are trusted markup: esc() anything dynamic.
const L = (vi, en) => `<b>${vi}</b><small>${en}</small>`;
const TONE = { ok: '#b9fb75', go: '#63dcc5', warn: '#ff9f68', danger: '#d93d42' };

// Dark app bar for tablet pages. Returns a string; the caller wires clicks on [data-tab].
// tabs = [{id, label, on}]; right = raw HTML (links, buttons). Ends with the clock and connection dot.
function APPBAR({ title, sub, tabs = [], right = '', home = 'index.html' } = {}) {
  return `<header class="appbar"><a class="home" href="${esc(home)}"><img src="logo.svg" alt="MEKONIQ"></a>
    <div class="title"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    ${tabs.length ? `<div class="seg dark">${tabs.map(t => `<button data-tab="${esc(t.id)}" aria-pressed="${!!t.on}">${esc(t.label)}</button>`).join('')}</div>` : ''}
    <div class="right">${right}</div><span id="clock"></span><span class="dot" id="conn"></span></header>`;
}
function startClock() {
  const tick = () => { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); };
  tick(); setInterval(tick, 1000);
}
// Alert strip rows (one per alert). extra(a) may return more button HTML placed before "Đã biết".
function strip(alerts, extra) {
  return (alerts || []).map(a => `<div class="strip${a.level === 'error' ? ' error' : ''}"><span class="kind">${a.level === 'error' ? 'Lỗi' : 'Cảnh báo'}</span><span class="grow">${esc(a.text)}</span><span class="t">${clock(a.t)}</span>${extra ? extra(a) : ''}<button class="btn sm dark" data-act="ack" data-id="${esc(a.id)}">Đã biết</button></div>`).join('');   // ack only hides the alert: orders and bills stay (spec §6)
}
// What a table tile shows: robot standing there, robot on its way, queued, or free.
function tableState(t) {
  const r = App.state.robots.find(x => x.phase === 'atStop' && x.at === t);
  if (r) return [r.id + ' đang ở bàn', 'here'];
  for (const m of App.state.missions) for (const s of m.stops)
    if (s.p === t && (s.status === 'pending' || s.status === 'active')) return [s.status === 'active' && m.robot ? m.robot + ' đang tới' : m.status !== 'active' ? 'Trong hàng chờ' : m.loaded ? 'Sắp tới lượt' : 'Đang chuẩn bị', 'busy'];
  return ['Sẵn sàng', ''];
}

const BRAND = sub => `<a class="identity" href="index.html"><img src="logo.svg" alt="">
  <div><div class="wordmark">MEKONI<span>Q</span></div><small>${esc(sub)}</small></div></a>`;

// ---- Floor plan + route network (station map, map editor) ----
// Tables/zones are drawn where they are; the route network shows where robots may drive.
function floorSVG(click) {
  const S = App.site, P = S.points;
  let h = `<rect x="0" y="0" width="${S.floor.w}" height="${S.floor.h}" rx=".4" fill="var(--light)" stroke="var(--line)" stroke-width=".1"/>`;
  for (const [id, p] of Object.entries(P)) {
    const f = a => (click ? ` data-f="${a}"` : '');
    if (p.kind === 'table') h += `<g${f('t:' + id)}><rect class="tbl" id="pt-${id}" x="${p.x - .9}" y="${p.y - .65}" width="1.8" height="1.3" rx=".25"/><text x="${p.x}" y="${p.y}">${esc(short(id))}</text></g>`;
    else if (p.kind === 'dock') h += `<rect class="zone dock" x="${p.x - .6}" y="${p.y - .5}" width="1.2" height="1" rx=".2"/><text class="zl" x="${p.x}" y="${p.y - .1}">⚡${esc(p.name.replace(/\D/g, ''))}</text>`;
    else h += `<g${f((p.kind === 'station' ? 'from:' : 'to:') + id)}><rect class="zone ${p.kind}" x="${p.x - 2.4}" y="${p.y - 1.6}" width="4.8" height="3.2" rx=".4"/><text x="${p.x - .4}" y="${p.y}">${esc(p.name)}</text></g>`;
  }
  return h;
}
function netSVG(map, o = {}) {
  const N = map.nodes, P = App.site.points;
  let h = '', hits = '';
  map.edges.forEach((e, i) => {
    const a = N[e.a], b = N[e.b];
    if (!a || !b) return;
    const cls = ['lane', e.narrow && 'narrow', e.slow && 'slow', e.closed && 'closed', o.edge === i && 'sel'].filter(Boolean).join(' ');
    h += `<line class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    if (e.oneway && !e.closed) h += `<path class="arrow" d="M-.2,-.17 L.2,0 L-.2,.17 Z" transform="translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI})"/>`;
    if (o.edit) hits += `<line class="hit" data-edge="${i}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
  });
  h += hits;
  for (const [id, n] of Object.entries(N))
    h += `<circle class="node${P[id] ? ' stop' : ''}${o.node === id ? ' sel' : ''}${o.from === id ? ' from' : ''}" ${o.edit ? `data-node="${esc(id)}"` : ''} cx="${n.x}" cy="${n.y}" r="${o.edit ? (P[id] ? .24 : .2) : P[id] ? .12 : .07}"/>`;
  return h;
}
// Obstacle disc: N = người (person, passes by), G = ghế/vật (object, stays until removed).
const obstacleSVG = obs => obs.map(o => `<g class="ob ${o.kind}" data-ob="${o.id}" transform="translate(${o.x} ${o.y})"><circle r=".4"/><text>${o.kind === 'person' ? 'N' : 'G'}</text></g>`).join('');
const laneKey = ([c, t]) => `<span><svg viewBox="0 0 2 .4"><line class="lane ${c}" x1=".1" y1=".2" x2="1.9" y2=".2"/></svg>${t}</span>`;
const LEGEND = `<div class="legend">${[['', 'Lối đi'], ['narrow', 'Lối hẹp · 1 robot'], ['slow', 'Đi chậm'], ['closed', 'Đã đóng']].map(laneKey).join('')}
  <span><svg viewBox="0 0 2 .4"><line class="lane" x1=".1" y1=".2" x2="1.9" y2=".2"/><path class="arrow" d="M-.2,-.17 L.2,0 L-.2,.17 Z" transform="translate(1 .2)"/></svg>Một chiều</span>
  <span><svg viewBox="0 0 2 .4"><line class="path" x1=".1" y1=".2" x2="1.9" y2=".2"/></svg>Lộ trình robot</span></div>`;
// Screen click -> floor coordinates (metres).
function svgPoint(svg, e) {
  const p = svg.createSVGPoint();
  p.x = e.clientX; p.y = e.clientY;
  const q = p.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 };
}

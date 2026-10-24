// Shared by station / robot / table pages: messaging (via transport.js), MP3 cues, labels, small UI helpers.
const App = { site: null, state: null, skew: 0 };

function connect(onMsg) {
  const off = document.getElementById('offline'), dot = document.getElementById('conn');
  Transport.connect(raw => {
    let m;
    try { m = JSON.parse(raw); } catch (err) { return; }
    if (m.type === 'site') App.site = m.site;
    if (m.type === 'state') { App.state = m; App.skew = Date.now() - m.now; }
    if (App.site) onMsg(m);
  }, up => {
    if (off) off.hidden = up;
    if (dot) dot.classList.toggle('on', up);
    if (up) send({ type: 'hello' });
  });
}
function send(obj) { Transport.send(JSON.stringify(obj)); }

// Browsers block autoplay until a user tap, so audio is unlocked from a click handler.
const SOUNDS = ['arrived', 'remind', 'thanks', 'load', 'collect', 'unload', 'cancel', 'estop', 'blocked', 'standby', 'alert', 'cancelled', 'ding'];
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
const ACTION_VI = { load: 'Xếp đồ lên khay', handoff: 'Giao cho khách', collect: 'Thu chén đĩa', unload: 'Dỡ chén đĩa', return: 'Trả đồ bị huỷ', standby: 'Chờ lệnh' };

function missionOf(r) { return r && r.mission ? App.state.missions.find(m => m.id === r.mission) : null; }
function etaSec(r) {
  const p = App.site.points[r.target];
  return p ? Math.round(Math.hypot(p.x - r.x, p.y - r.y) / App.site.sim.speed) : 0;
}
// [text, tone] for a robot's current status.
function robotStatus(r) {
  if (r.offline) return ['Mất kết nối', 'danger'];
  if (r.halt === 'estop') return ['Dừng khẩn cấp', 'danger'];
  if (r.halt === 'blocked') return ['Bị chặn đường', 'danger'];
  if (r.halt === 'paused') return ['Tạm dừng', 'warn'];
  const m = missionOf(r);
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

function toast(text, level = 'info') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + level; t.textContent = text;
  box.prepend(t);
  setTimeout(() => t.remove(), 6000);
  while (box.children.length > 4) box.lastChild.remove();
}

const BRAND = sub => `<a class="identity" href="index.html"><img src="logo.svg" alt="">
  <div><div class="wordmark">MEKONI<span>Q</span></div><small>${esc(sub)}</small></div></a>`;

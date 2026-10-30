'use strict';
// MEKONIQ Serve S1 — Mission Orchestrator (CORE): queue, mission state machine, alerts, KPI.
// Pure logic: handle(st, site, input, now) -> { ui: [{payload, session?}], cmds: [adapter cmd] }.
// It only talks to robots through the adapter contract, so the simulator can be swapped for a
// vendor gateway without touching this file:
//   cmds   -> {cmd:'goto', robot, to, x, y, token} | {cmd:'stop'|'resume', robot} | {cmd:'map', map, v}
//             | {cmd:'obstacle', x, y, kind | remove} | {cmd:'sim', robot, fault} | {cmd:'reset'} | {cmd:'speed', robot, factor}
//   events <- {event:'telemetry', mapV, obstacles, robots:[{id, x, y, battery, moving, blocked, nav, why, path, rem}]}
//             | {event:'arrived', robot, token} | {event:'reroute', robot, why}
// The route network (st.map) lives here, like a fleet manager's map; robots get it via {cmd:'map'}.
// NOTE: this is not a safety system. Physical E-stop / collision safety must live on the robot.

const OFFLINE_SEC = 3;
const KEEP_LOG = 60, KEEP_HISTORY = 30;
const ACTION_VI = { load: 'Xếp đồ lên khay', handoff: 'Giao cho khách', collect: 'Thu chén đĩa', unload: 'Dỡ chén đĩa', return: 'Trả lại món bị huỷ', standby: 'Chờ lệnh', guide: 'Dẫn khách' };
const STATUS_VI = { done: 'hoàn thành', cancelled: 'đã huỷ', failed: 'chuyển xử lý thủ công', timeout: 'không ai xác nhận, robot tự về' };
const ARRIVE_SOUND = { load: 'load', handoff: 'arrived', collect: 'collect', unload: 'unload', return: 'unload', standby: 'standby', guide: 'arrived' };
const SIM_FAULTS = ['block', 'clear', 'offline', 'online', 'lowbat'];
const R = require('./route');
const Site = require('./site');
const Policy = require('./feature-policy');
const Billing = require('./billing');
const WHY_VI = { object: 'vật cản', person: 'người đi qua', robot: 'robot khác' };
const CALL_VI = { staff: 'gọi nhân viên', bill: 'yêu cầu tính tiền' };
const CALL_FLAG = { staff: 'callStaff', bill: 'requestBill' };
const RETURN_VI = { 'wrong-item': 'báo nhầm món', 'need-help': 'cần hỗ trợ' };
const FEATURE_VI = { callStaff: 'Gọi nhân viên', requestBill: 'Yêu cầu tính tiền', guide: 'Dẫn khách', order: 'Gọi món', busRobot: 'Thu dọn từ robot' };
const RECEIPT_MS = 24 * 3600 * 1000, KEEP_RECEIPTS = 1000;   // call/returnRequest receipts (bill receipts live in the bill)
const OPEN_BILL = ['prepared', 'claimed', 'settled'];
const BILL_VI = { billPrepare: 'đã chuẩn bị', billClaim: 'khách báo đã trả', billSettle: 'đã xác nhận thu', billClose: 'đã đóng', billVoid: 'đã vô hiệu hóa' };
const BILL_FIELDS = ['type', 'table', 'orderIds', 'total', 'note', 'bill', 'rev', 'method', 'reason', 'requestId'];   // whitelist, + server-side by

let lastSnap = '';

function init(site, now) {
  const st = { seq: 0, alertSeq: 0, orderSeq: 0, robots: {}, missions: [], history: [], log: [], alerts: [], orders: [],
    kpi: { delivered: 0, cancelledCustomer: 0, cancelledStaff: 0, timeout: 0, failed: 0, interventions: 0, deliverySecSum: 0, reroutes: 0, guides: 0 } };
  sync(st, site, now);
  return st;
}

// Adds robots that appear in site.json after state was persisted.
// Also drops robots removed from site.json (setup.html) once they have no mission.
function sync(st, site, now) {
  if (!st.orders) { st.orders = []; st.orderSeq = 0; }   // state saved before orders existed
  Billing.init(st);
  if (!Array.isArray(st.requests)) st.requests = [];
  if (!st.map) { st.map = { v: 1, nodes: {}, edges: [], ...JSON.parse(JSON.stringify(site.map || {})) }; st.obstacles = []; }
  for (const { id, dock } of site.robots) {
    if (st.robots[id]) { st.robots[id].dock = dock; continue; }
    const p = site.points[dock] || {};
    st.robots[id] = { id, dock, x: p.x || 0, y: p.y || 0, battery: 100, phase: 'idle', at: dock, target: null, token: 0,
      mission: null, halt: null, offline: false, charging: false, lastSeen: now, waitSince: 0, lastRemind: 0, waitAlerted: false,
      nav: 'idle', why: null, path: [], rem: 0, pos: null };
  }
  for (const id of Object.keys(st.robots)) if (!st.robots[id].mission && !site.robots.some(r => r.id === id)) delete st.robots[id];
}

const open = s => s.status === 'pending' || s.status === 'active';
const pname = (c, id) => (c.site.points[id] || {}).name || id;
const findM = (c, id) => c.st.missions.find(m => m.id === id);

function label(c, m) {
  const tables = m.stops.filter(s => s.a === 'handoff').map(s => pname(c, s.p).replace('Bàn ', '')).join(', ');
  if (m.kind === 'deliver') return `#${m.id} Giao ${pname(c, m.stops[0].p)} → Bàn ${tables}`;
  if (m.kind === 'guide') return `#${m.id} Dẫn khách tới ${pname(c, m.stops[0].p)}`;
  if (m.kind === 'bus') return `#${m.id} Thu dọn ${pname(c, m.stops.find(s => s.a === 'collect').p)}`;
  return `#${m.id} Gọi robot tới ${pname(c, m.stops[0].p)}`;
}

function log(c, level, text, robot) {
  c.st.log.unshift({ t: c.now, level, text, robot });
  c.st.log.length = Math.min(c.st.log.length, KEEP_LOG);
}
function alert(c, key, level, text, robot, extra) {
  if (c.st.alerts.some(a => a.key === key)) return;
  c.st.alerts.unshift({ id: ++c.st.alertSeq, key, t: c.now, level, text, robot, ...extra });
  // Full list: drop the oldest warning (possibly the one just added), so guest calls / orders never push out an
  // e-stop, offline or blocked alert. Only when all 20 are errors does the oldest error go.
  while (c.st.alerts.length > 20) {
    let i = c.st.alerts.length - 1;
    while (i >= 0 && c.st.alerts[i].level === 'error') i--;
    c.st.alerts.splice(i >= 0 ? i : c.st.alerts.length - 1, 1);
  }
}
const resolve = (c, key) => { c.st.alerts = c.st.alerts.filter(a => a.key !== key); };
// Client-side cues. robotSound -> robot screen, stationSound -> stations (filtered by point), table -> customer page.
const ev = (c, e) => c.ui.push({ payload: JSON.stringify({ type: 'event', t: c.now, ...e }) });
// Answer to one session's request {ok, code?, text, bill?, duplicate?}: the client leaves its "sending" state on it.
const reply = (c, session, requestId, r) => c.ui.push({ session, payload: JSON.stringify({ type: 'event', t: c.now, reply: true, requestId, ...r }) });
// Server-side gate for new business (spec §5, §9): flag on and config ready, else a refusal and nothing changes.
// Work already accepted (confirm, pause, cancel, release, unload, speed of a running guide) is never gated.
function allowed(c, key, session, requestId) {
  const p = Policy.readiness(c.site, key);
  if (!p.effective) reply(c, session, requestId, p.enabled ? { ok: false, code: 'not-ready', text: p.reasons.map(x => x.text).join('; ') }
    : { ok: false, code: 'disabled', text: `Tính năng "${FEATURE_VI[key]}" đang tắt` });
  return p.effective;
}
const reqStation = c => (c.site.service || {}).requestStation || null;   // a v2 site that skipped normalize may lack service
// Call / returnRequest receipts (spec §6), persisted in st for 24 h: a retry with the same requestId is answered, never
// re-alerted, even after ack. No requestId (old cached client): processed without a receipt.
const rid = d => (typeof d.requestId === 'string' ? d.requestId.trim().slice(0, 100) : '');
function seen(c, d, fp, session) {
  const q = rid(d) && c.st.requests.find(x => x.id === rid(d));
  if (q) reply(c, session, d.requestId, q.fp === fp ? { ok: true, duplicate: true, text: 'Yêu cầu đã được gửi' } : { ok: false, code: 'request-conflict', text: 'Mã yêu cầu đã dùng cho yêu cầu khác' });
  return !!q;
}
function accept(c, d, session, fp, text) {
  if (rid(d)) c.st.requests.push({ id: rid(d), fp, t: c.now });
  if (c.st.requests.length > KEEP_RECEIPTS) c.st.requests.shift();   // ponytail: flood guard drops the oldest; raise if a site ever nears it
  reply(c, session, d.requestId, { ok: true, text });
}

function goTo(c, r, point, phase) {
  r.target = point; r.at = null; r.phase = phase; r.token++; r.waitAlerted = false;
  gotoCmd(c, r);
}
function gotoCmd(c, r) {
  const p = c.st.map.nodes[r.target] || c.site.points[r.target] || {};   // Valetudo-only points have no route node
  c.cmds.push({ cmd: 'goto', robot: r.id, to: r.target, x: p.x || 0, y: p.y || 0, token: r.token });
}

// How far a free robot is from a mission's first stop. Simulator robots: along the route network.
// Valetudo robots: straight line in robot cm on their own map; a robot never taught one of the stops comes last —
// it still takes the job when no taught robot is free, and the adapter then reports noroute (an alert), never a silent wait.
function distanceTo(c, r, m) {
  const cfg = c.site.robots.find(x => x.id === r.id) || {};
  const first = m.stops.find(open).p;
  if (cfg.driver === 'valetudo') {
    const P = (cfg.valetudo && cfg.valetudo.points) || {};
    if (!m.stops.filter(open).every(s => P[s.p] || s.p === r.dock)) return 1e9;
    return r.pos && P[first] ? Math.hypot(r.pos.x - P[first].x, r.pos.y - P[first].y) : 0;
  }
  return c.st.map.nodes[first] ? Math.min(R.distance(c.st.map, r.x, r.y, first), 1e9) : 0;   // closed lanes: still assign, the robot reports noroute
}

// Moves a mission to its next open stop, or finishes it.
function advance(c, m) {
  // Nothing loaded and no table left to serve -> nothing to fetch either.
  if (m.kind === 'deliver' && !m.loaded && !m.stops.some(s => s.a === 'handoff' && open(s)))
    for (const s of m.stops) if (open(s)) s.status = 'skipped';
  const i = m.stops.findIndex(open);
  if (i < 0) return finish(c, m);
  if (m.status !== 'active') return;
  const s = m.stops[i];
  if (s.status === 'active' && m.cur === i) return;   // already serving this stop
  s.status = 'active'; m.cur = i;
  goTo(c, c.st.robots[m.robot], s.p, 'toStop');
}

function finish(c, m, status) {
  const key = { deliver: 'handoff', bus: 'collect', summon: 'standby', guide: 'guide' }[m.kind];
  m.status = status || (m.stops.some(s => s.a === key && s.status === 'done') ? 'done' : 'cancelled');
  m.endedAt = c.now;
  c.st.missions = c.st.missions.filter(x => x !== m);
  c.st.history.unshift(m);
  c.st.history.length = Math.min(c.st.history.length, KEEP_HISTORY);
  log(c, m.status === 'done' ? 'ok' : 'warn', `${m.label}: ${STATUS_VI[m.status]}`, m.robot);
  const r = c.st.robots[m.robot];
  if (r && r.mission === m.id) {
    if (r.slow) { r.slow = false; c.cmds.push({ cmd: 'speed', robot: r.id, factor: 1 }); }
    r.mission = null; r.homeDue = true;   // heads home after assign(): a queued mission takes it straight on, no detour via the dock
    resolve(c, 'wait-' + r.id);
  }
}

function assign(c) {
  const queue = c.st.missions.filter(m => m.status === 'queued').sort((a, b) => (b.urgent - a.urgent) || (a.createdAt - b.createdAt));
  for (const m of queue) {
    const free = Object.values(c.st.robots).filter(r => !r.mission && !r.halt && !r.offline && !r.charging &&
      (m.robotPref === 'any' || m.robotPref === r.id));
    if (!free.length) continue;
    const far = r => distanceTo(c, r, m);
    const r = free.reduce((a, b) => (far(a) <= far(b) ? a : b));
    m.status = 'active'; m.robot = r.id; m.startedAt = c.now; r.mission = m.id;
    log(c, 'info', `${r.id} nhận ${m.label}`, r.id);
    advance(c, m);
  }
}

function create(c, d, by, session) {
  const P = c.site.points;
  const isTable = id => P[id] && P[id].kind === 'table';
  const pref = d.robot === 'any' || c.st.robots[d.robot] ? d.robot : null;
  if (!pref) return;
  let stops;
  if (d.kind === 'deliver') {
    const tables = [...new Set(Array.isArray(d.tables) ? d.tables : [])].filter(isTable).slice(0, c.site.trays);
    if (!tables.length || !P[d.from] || P[d.from].kind !== 'station') return;
    stops = [{ p: d.from, a: 'load' }, ...tables.map((p, i) => ({ p, a: 'handoff', tray: i + 1 }))];
  } else if (d.kind === 'bus') {
    if (!isTable(d.table)) return;
    stops = [{ p: d.table, a: 'collect' }, { p: c.site.dishPoint, a: 'unload' }];
  } else if (d.kind === 'guide') return guide(c, d, by, session);
  else if (d.kind === 'summon') {
    if (!P[d.to] || P[d.to].kind === 'dock') return;
    stops = [{ p: d.to, a: 'standby' }];
  } else return;
  const m = { id: ++c.st.seq, kind: d.kind, by, urgent: !!d.urgent, robotPref: pref, createdAt: c.now, status: 'queued',
    robot: null, loaded: false, cur: -1, note: String(d.note || '').slice(0, 80), stops: stops.map(s => ({ ...s, status: 'pending' })) };
  m.label = label(c, m);
  c.st.missions.push(m);
  log(c, 'info', `${by} tạo ${m.label}${m.urgent ? ' (GẤP)' : ''}${pref !== 'any' ? ' cho ' + pref : ''}`);
}

// Guests waiting where the robot stands (a station or the entrance) ask it to lead them to a table.
// Only from the robot's own screen; the robot takes the job at once, handing over its standby job if it has one.
function guide(c, d, by, session) {
  const P = c.site.points, r = c.st.robots[d.robot], cur = r && findM(c, r.mission);
  if (!r || !P[d.to] || P[d.to].kind !== 'table' || r.halt || r.offline) return;
  const s = cur && r.phase === 'atStop' && cur.stops[cur.cur];
  // Robots only go idle at the dock, so "waiting at the entrance" always means a standby stop there.
  if (!s || s.a !== 'standby' || !['station', 'entrance'].includes(P[s.p].kind) || !allowed(c, 'guide', session, d.requestId)) return;
  const cfg = c.site.robots.find(x => x.id === r.id) || {};   // this robot must know the way: route node / taught point
  if (!(cfg.driver === 'valetudo' ? ((cfg.valetudo || {}).points || {})[d.to] : c.st.map.nodes[d.to]))
    return reply(c, session, d.requestId, { ok: false, code: 'unreachable', text: `${r.id} chưa đi được tới ${pname(c, d.to)}` });
  s.status = 'done'; s.by = by; finish(c, cur);
  const m = { id: ++c.st.seq, kind: 'guide', by, urgent: false, robotPref: r.id, createdAt: c.now, startedAt: c.now, status: 'active',
    robot: r.id, loaded: false, cur: -1, note: '', stops: [{ p: d.to, a: 'guide', status: 'pending' }] };
  m.label = label(c, m);
  c.st.missions.push(m);
  r.mission = m.id; r.homeDue = false;
  log(c, 'info', `${by}: ${r.id} ${m.label}`, r.id);
  advance(c, m);
}

// Drops one stop. Food already on a tray must go back to where it was loaded, never be abandoned.
function dropStop(c, m, i, by, why) {
  const s = m.stops[i];
  s.by = by; s.why = why;
  if (s.a === 'handoff') c.st.kpi[why === 'customer' ? 'cancelledCustomer' : why === 'timeout' ? 'timeout' : 'cancelledStaff']++;
  if (s.a === 'handoff' && m.loaded) {
    s.status = 'cancelled';
    let ret = m.stops.find(x => x.a === 'return' && open(x));
    if (!ret) m.stops.push(ret = { p: m.stops[0].p, a: 'return', status: 'pending', trays: [] });
    ret.trays.push({ tray: s.tray, table: s.p });
  } else s.status = 'skipped';
}

function cancelMission(c, m, by, why) {
  m.stops.forEach((s, i) => { if (open(s) && !['unload', 'return'].includes(s.a)) dropStop(c, m, i, by, why); });
  for (const s of m.stops) if (open(s) && s.a === 'unload' && !m.loaded) s.status = 'skipped';
  const back = m.stops.some(s => open(s));
  log(c, 'warn', `${by} huỷ ${m.label}${back ? ' — robot mang đồ về ' + pname(c, m.stops.find(open).p) : ''}`, m.robot);
  if (m.status === 'queued') return finish(c, m, 'cancelled');
  if (back) ev(c, { robot: m.robot, robotSound: 'cancel', text: `${m.robot} quay lại ${pname(c, m.stops.find(open).p)}` });
  advance(c, m);
}

function cancelStop(c, m, i, by, why, d = {}) {
  const s = m.stops[i];
  if (!s || s.a !== 'handoff' || !open(s) || (d.table && d.table !== s.p)) return;   // QR page: stop may have been moved to another table
  const here = m.status === 'active' && m.cur === i && c.st.robots[m.robot].phase === 'atStop';
  dropStop(c, m, i, by, why);
  const tail = m.loaded ? ` — ${m.robot} mang khay ${s.tray} về ${pname(c, m.stops[0].p)}` : ' (chưa xếp khay)';
  log(c, 'warn', `${by} huỷ món ${pname(c, s.p)} của ${m.label}${tail}`, m.robot);
  ev(c, { table: s.p, stationSound: 'cancelled', point: m.stops[0].p, robot: here ? m.robot : undefined, robotSound: here ? 'cancel' : undefined,
    text: `${pname(c, s.p)} huỷ món${tail}` });
  advance(c, m);
  return true;
}

function confirm(c, r, d, by) {
  const m = findM(c, r.mission);
  if (!m || r.phase !== 'atStop' || d.mission !== m.id || d.stop !== m.cur) return;   // stale / double tap
  const s = m.stops[m.cur];
  s.status = 'done'; s.doneAt = c.now; s.by = by;
  if (s.a === 'load' || s.a === 'collect') m.loaded = true;
  if (s.a === 'unload' || s.a === 'return') m.loaded = false;
  if (s.a === 'guide') c.st.kpi.guides = (c.st.kpi.guides || 0) + 1;
  if (s.a === 'handoff') {
    c.st.kpi.delivered++;
    c.st.kpi.deliverySecSum += (c.now - m.createdAt) / 1000;
    ev(c, { robot: r.id, robotSound: 'thanks', table: s.p, text: `${pname(c, s.p)} đã nhận món` });
  }
  resolve(c, 'wait-' + r.id);
  log(c, 'ok', `${r.id} · ${pname(c, s.p)}: ${ACTION_VI[s.a]} ✓`, r.id);
  advance(c, m);
}

// Wrong table noticed after the robot left: move one handoff stop to another table while it is still on its way.
function retarget(c, m, d, by, session) {
  const P = c.site.points, s = m.stops[d.stop], r = c.st.robots[m.robot];
  const no = t => c.ui.push({ session, payload: JSON.stringify({ type: 'event', t: c.now, reply: true, text: 'Không đổi được: ' + t }) });
  if (!s || s.a !== 'handoff' || !open(s) || !P[d.to] || P[d.to].kind !== 'table') return;
  if (s.status === 'active' && r.phase !== 'toStop') return no('robot đã tới bàn');
  if (m.stops.some(x => open(x) && x.p === d.to)) return no('bàn đã có trong chuyến');
  const old = s.p;
  s.p = d.to;
  m.label = label(c, m);
  if (s.status === 'active') goTo(c, r, d.to, 'toStop');
  const text = `${by} đổi ${pname(c, old)} → ${pname(c, d.to)} của ${m.label}`;
  log(c, 'info', text, m.robot);
  ev(c, { table: old, moved: d.to, text: `${pname(c, old)}: món chuyển sang ${pname(c, d.to)}` });
  ev(c, { table: d.to, text });
}

// A robot summoned to a spot gets its next job from the robot screen.
function dispatch(c, r, d, by, session) {
  const m = findM(c, r.mission);
  if (!m || m.kind !== 'summon' || r.phase !== 'atStop' || d.mission !== m.id) return;
  const P = c.site.points, s = m.stops[m.cur];
  if (d.release) { s.status = 'done'; log(c, 'info', `${by} cho ${r.id} về`, r.id); return advance(c, m); }
  if ((d.toDish || d.bus) && !allowed(c, 'busRobot', session, d.requestId)) return;   // new bus trip from the robot screen (F04)
  if (d.toDish) {
    if (s.p === c.site.dishPoint) return;
    Object.assign(s, { a: 'collect', status: 'done' });
    m.kind = 'bus'; m.loaded = true;
    m.stops.push({ p: c.site.dishPoint, a: 'unload', status: 'pending' });
  } else if (d.bus) {   // waiting at a station: go bus one table, then the dish area (like create kind:'bus')
    const t = Array.isArray(d.tables) && d.tables.length === 1 && d.tables[0];
    if (!P[t] || P[t].kind !== 'table' || P[s.p].kind !== 'station') return;
    s.status = 'done';
    m.kind = 'bus';
    m.stops.push({ p: t, a: 'collect', status: 'pending' }, { p: c.site.dishPoint, a: 'unload', status: 'pending' });
  } else {
    const tables = [...new Set(Array.isArray(d.tables) ? d.tables : [])].filter(t => P[t] && P[t].kind === 'table').slice(0, c.site.trays);
    if (!tables.length || P[s.p].kind !== 'station') return;
    Object.assign(s, { a: 'load', status: 'done' });
    m.kind = 'deliver'; m.loaded = true;
    tables.forEach((p, i) => m.stops.push({ p, a: 'handoff', tray: i + 1, status: 'pending' }));
  }
  m.label = label(c, m);
  log(c, 'info', `${by} giao việc cho ${r.id}: ${m.label}`, r.id);
  resolve(c, 'wait-' + r.id);
  advance(c, m);
}

// Guest at a table asks for staff / the bill (independent flags). One alert per table+what until a station acks it,
// rung at the request station.
function call(c, d, by, session) {
  // Pre-bill pay screens: a guest's "I paid" no longer touches orders, only billClaim on a staff-prepared bill does.
  if (d.what === 'paid') return reply(c, session, d.requestId, { ok: false, code: 'reload', text: 'Màn thanh toán đã cũ — vui lòng tải lại trang' });
  const P = c.site.points;
  if (!P[d.point] || P[d.point].kind !== 'table' || !CALL_VI[d.what]) return;
  const fp = JSON.stringify(['call', d.point, d.what]);
  if (seen(c, d, fp, session) || !allowed(c, CALL_FLAG[d.what], session, d.requestId)) return;
  const key = `call-${d.what}-${d.point}`, text = `${pname(c, d.point)} ${CALL_VI[d.what]}`, station = reqStation(c);
  if (!c.st.alerts.some(a => a.key === key)) {   // already open: staff were told, just confirm
    alert(c, key, 'warn', text, undefined, { station });
    ev(c, { stationSound: 'ding', point: station, text });
    log(c, 'info', `${by}: ${text}`);
  }
  accept(c, d, session, fp, text);
}

// Guest: "wrong item / need help" on one delivery (spec §6, policy request or direct). Never changes the mission and
// does not need callStaff: staff open the exact trip from alert.ref and recall it themselves.
function returnRequest(c, d, by, session) {
  const no = (code, text) => reply(c, session, d.requestId, { ok: false, code, text });
  if (!RETURN_VI[d.reason]) return no('invalid', 'Yêu cầu không hợp lệ');
  const fp = JSON.stringify(['returnRequest', d.mission, d.stop, d.table, d.reason]);
  if (seen(c, d, fp, session)) return;
  const m = typeof d.mission === 'number' && findM(c, d.mission), s = m && Number.isInteger(d.stop) && m.stops[d.stop];
  if (!s || s.a !== 'handoff' || !open(s)) return no('stale', 'Chuyến giao này đã kết thúc — vui lòng gọi nhân viên');
  if (s.p !== d.table) return no('stale', 'Món này đã được chuyển sang bàn khác — vui lòng tải lại trang');
  const P = c.site.points, load = m.stops.find(x => x.a === 'load');
  const station = [load && load.p, reqStation(c), Site.firstStation(c.site)].find(p => P[p] && P[p].kind === 'station');
  if (!station) return no('no-station', 'Chưa có trạm nhận yêu cầu — vui lòng gọi nhân viên');
  const key = `return-${m.id}-${d.stop}-${d.table}`, text = `${pname(c, d.table)} ${RETURN_VI[d.reason]} · ${m.label}`;
  if (!c.st.alerts.some(a => a.key === key)) {
    alert(c, key, 'warn', text, undefined, { ref: { mission: m.id, stop: d.stop, table: d.table, reason: d.reason }, station });
    ev(c, { stationSound: 'ding', point: station, text });
    log(c, 'info', `${by}: ${text}`, m.robot);
  }
  accept(c, d, session, fp, text);
}

const SLOW = 0.5;   // guide "Đi chậm hơn" speed factor
const vnd = n => String(n).replace(/\B(?=(\d{3})+$)/g, '.') + 'đ';
// Guest orders on the robot screen. One alert per preparing station listing only its items; the station then
// sends the delivery as usual (food must be cooked first, so no mission is created here).
function order(c, d, by, session) {
  const P = c.site.points, menu = c.site.menu || {}, items = menu.items || [], cats = menu.cats || [];
  if (!P[d.table] || P[d.table].kind !== 'table' || !allowed(c, 'order', session, d.requestId)) return;
  if (c.st.bills.some(b => b.table === d.table && OPEN_BILL.includes(b.status)))   // spec §7.2: never change a total already shown
    return reply(c, session, d.requestId, { ok: false, code: 'billing', text: `${pname(c, d.table)}: Bàn đang tính tiền — nhờ nhân viên vô hiệu hóa phiếu trước khi gọi thêm` });
  const lines = (Array.isArray(d.items) ? d.items : []).map(x => ({ x, it: x && items.find(i => i.id === x.id) }));
  if (!lines.length || lines.length > 30 || lines.some(({ x, it }) => !it || !Number.isInteger(x.qty) || x.qty < 1 || x.qty > 20))   // menu changed under an open cart
    return reply(c, session, d.requestId, { ok: false, code: 'invalid', text: 'Giỏ có món không còn trong thực đơn hoặc số lượng không hợp lệ' });
  const o = { id: ++c.st.orderSeq, table: d.table, items: lines.map(({ x, it }) => ({ id: it.id, qty: x.qty, price: it.price })), t: c.now, status: 'new', by };
  o.total = o.items.reduce((a, i) => a + i.qty * i.price, 0);
  c.st.orders.push(o);
  const byStation = {};
  for (const { x, it } of lines) {
    const station = (cats.find(k => k.id === it.cat) || {}).station || Site.firstStation(c.site);
    (byStation[station] = byStation[station] || []).push({ it, qty: x.qty });
  }
  for (const [station, list] of Object.entries(byStation)) {
    const text = `${pname(c, d.table)} gọi món: ${list.map(l => `${l.it.vi} ×${l.qty}`).join(', ')} · ${vnd(list.reduce((a, l) => a + l.qty * l.it.price, 0))}`;
    alert(c, `order-${o.id}-${station}`, 'warn', text);
    ev(c, { stationSound: 'ding', point: station, text });
  }
  log(c, 'info', `${by}: ${pname(c, d.table)} gọi ${o.items.length} món · ${vnd(o.total)} (đơn #${o.id})`);
  reply(c, session, d.requestId, { ok: true, text: `Đã gửi đơn #${o.id}` });   // the robot screen clears its cart only on this
}

// Staff-verified bills (lib/billing.js decides). Amounts in texts come from the bill, never from the client.
function bill(c, d, by, session) {
  const cmd = { by };
  for (const k of BILL_FIELDS) cmd[k] = d[k];
  const r = Billing.handle(c.st, c.site, cmd, c.now);
  if (!r.ok) return reply(c, session, d.requestId, { ok: false, code: r.code, text: r.text });
  const { receipts, ...b } = r.bill;   // copy: receipts stay server-side
  const text = `${pname(c, b.table)} · phiếu #${b.id} ${BILL_VI[d.type]} · ${vnd(b.total)}`;
  reply(c, session, d.requestId, { ok: true, duplicate: r.duplicate || undefined, text, bill: b });
  if (r.duplicate) return;   // retry of a done request: already logged / alerted
  log(c, d.type === 'billVoid' ? 'warn' : 'info', `${by}: ${text}${b.voidReason ? ' — ' + b.voidReason : ''}`);
  if (d.type === 'billClaim') {
    const t = `${pname(c, b.table)} báo đã trả phiếu #${b.id} · ${vnd(b.total)} — kiểm tra giao dịch rồi xác nhận`;
    alert(c, 'bill-claim-' + b.id, 'warn', t, undefined, { station: reqStation(c) });
    ev(c, { stationSound: 'ding', point: reqStation(c), text: t });
  } else if (d.type !== 'billPrepare') resolve(c, 'bill-claim-' + b.id);
  c.force = true;
}

function telemetry(c, d) {
  const { st, site, now } = c;
  const list = Array.isArray(d.robots) ? d.robots : [];
  if (Array.isArray(d.obstacles)) st.obstacles = d.obstacles;
  if (d.mapV !== undefined && d.mapV !== st.map.v) {   // robot runs an old map (restart / edit): resend map and goals
    c.cmds.push({ cmd: 'map', map: { nodes: st.map.nodes, edges: st.map.edges }, v: st.map.v });
    for (const r of Object.values(st.robots)) if (r.target) gotoCmd(c, r);
  }
  for (const t of list) {
    const r = st.robots[t.id];
    if (!r) continue;
    r.x = t.x; r.y = t.y; r.battery = t.battery; r.lastSeen = now; r.pos = t.pos || null;
    r.path = Array.isArray(t.path) ? t.path : []; r.rem = t.rem || 0;
    if (t.nav !== r.nav) navChanged(c, r, t);
    r.nav = t.nav || 'idle'; r.why = t.why || null;
    if (r.offline) { r.offline = false; resolve(c, 'off-' + r.id); log(c, 'ok', `${r.id} đã kết nối lại`, r.id); }
    if (t.blocked && !r.halt) {
      r.halt = 'blocked'; st.kpi.interventions++;
      alert(c, 'blk-' + r.id, 'error', t.why === 'noroute' ? `${r.id} không có lộ trình tới ${pname(c, r.target)} — mở lại lối đi hoặc xử lý thủ công`
        : `${r.id} bị chặn (${WHY_VI[t.why] || 'vật cản'}), không còn đường vòng — cần nhân viên dọn lối đi`, r.id);
      ev(c, { robot: r.id, robotSound: 'blocked', stationSound: 'alert', text: `${r.id} bị chặn đường` });
    }
    if (!t.blocked && r.halt === 'blocked') {
      r.halt = null; r.waitSince = now; resolve(c, 'blk-' + r.id); log(c, 'ok', `${r.id} đã thông đường, chạy tiếp`, r.id);
    }
    if (!r.charging && r.battery < site.timing.lowBattery) {
      r.charging = true;
      log(c, 'warn', `${r.id} pin yếu (${Math.round(r.battery)}%) — xong việc sẽ về sạc, tạm ngừng nhận nhiệm vụ`, r.id);
    }
    if (r.charging && r.battery >= site.timing.chargedBattery) { r.charging = false; log(c, 'ok', `${r.id} đã sạc đủ, sẵn sàng`, r.id); }
  }
  for (const r of Object.values(st.robots)) {
    if (!r.offline && now - r.lastSeen > OFFLINE_SEC * 1000) {
      r.offline = true;
      alert(c, 'off-' + r.id, 'error', `${r.id} mất kết nối — kiểm tra Wi-Fi / nguồn robot`, r.id);
      ev(c, { stationSound: 'alert', text: `${r.id} mất kết nối` });
    }
  }
}

// Navigation cues: ask people to make way, tell stations when a robot gives way in a narrow lane.
function navChanged(c, r, t) {
  if (t.nav === 'wait') {
    log(c, 'info', `${r.id} gặp ${WHY_VI[t.why] || 'vật cản'} trên lối đi — dừng chờ`, r.id);
    if (t.why !== 'robot') ev(c, { robot: r.id, robotSound: 'excuse', text: `${r.id}: xin nhường đường` });
  }
  if (t.nav === 'yield') log(c, 'info', `${r.id} chờ ${t.why || 'robot khác'} đi qua lối hẹp`, r.id);
  if (t.nav === 'queue') log(c, 'info', `${r.id} xếp hàng chờ tới lượt tại ${pname(c, r.target)}`, r.id);
}
function reroute(c, r, why) {
  if (why === 'reopened') return log(c, 'ok', `${r.id} đã có lộ trình mới, chạy tiếp`, r.id);
  c.st.kpi.reroutes++;
  log(c, 'warn', `${r.id} đổi lộ trình, đi vòng tránh ${WHY_VI[why] || 'vật cản'}`, r.id);
  ev(c, { robot: r.id, text: `${r.id} đi đường vòng` });
}

// Waiting-time rules while a robot stands at a stop.
function timers(c) {
  const T = c.site.timing;
  Billing.cleanup(c.st, c.now);   // open orders/bills stay however old; closed ones go after 30 days
  c.st.requests = c.st.requests.filter(q => c.now - q.t < RECEIPT_MS);
  for (const r of Object.values(c.st.robots)) {
    if (r.phase !== 'atStop' || r.halt || r.offline) continue;
    const m = findM(c, r.mission), s = m.stops[m.cur];
    const waited = (c.now - r.waitSince) / 1000;
    if (s.a === 'handoff') {
      if (waited >= T.handoffSec) {
        alert(c, `to-${m.id}-${m.cur}`, 'warn', `${pname(c, s.p)} không nhận món sau ${T.handoffSec}s — ${r.id} mang về`, r.id);
        cancelStop(c, m, m.cur, 'Hệ thống (quá giờ)', 'timeout');
      } else if ((c.now - r.lastRemind) / 1000 >= T.remindSec) {
        r.lastRemind = c.now;
        ev(c, { robot: r.id, robotSound: 'remind', table: s.p, text: `Nhắc ${pname(c, s.p)} nhận món` });
      }
    } else if (s.a === 'guide') {   // nobody tapped "Đã tới bàn": remind, then head back (not a delivery timeout)
      if (waited >= T.handoffSec) {
        s.status = 'skipped';
        log(c, 'warn', `${r.id} dẫn khách tới ${pname(c, s.p)}: không ai xác nhận sau ${T.handoffSec}s`, r.id);
        finish(c, m, 'timeout');
      } else if ((c.now - r.lastRemind) / 1000 >= T.remindSec) {
        r.lastRemind = c.now;
        ev(c, { robot: r.id, robotSound: 'remind', text: `Nhắc khách ${pname(c, s.p)}` });
      }
    } else if (s.a === 'standby') {
      if (waited >= T.standbySec) { s.status = 'done'; log(c, 'info', `${r.id} chờ quá lâu tại ${pname(c, s.p)}, tự về`, r.id); advance(c, m); }
    } else if (waited >= T.loadSec && !r.waitAlerted) {
      r.waitAlerted = true;
      if (s.a === 'load' || s.a === 'collect') {
        alert(c, `to-${m.id}-${m.cur}`, 'warn', `Không ai xếp đồ cho ${r.id} tại ${pname(c, s.p)} — đã huỷ ${m.label}`, r.id);
        cancelMission(c, m, 'Hệ thống (quá giờ)', 'timeout');
      } else {
        alert(c, 'wait-' + r.id, 'warn', `${r.id} đang chờ dỡ đồ tại ${pname(c, s.p)}`, r.id);
        ev(c, { stationSound: 'alert', point: s.p, text: `${r.id} chờ dỡ đồ tại ${pname(c, s.p)}` });
      }
    }
  }
}

// Config edits: validated by lib/site.js, refused while a removed point / robot still has a mission.
function saveSite(c, d, session, seed, by) {
  const fail = t => c.ui.push({ session, payload: JSON.stringify({ type: 'event', t: c.now, text: 'Không lưu: ' + t }) });
  if (!seed) return fail('thiếu dữ liệu mặc định');
  const reset = d.type === 'siteReset';
  if (!reset && (!d.site || Number(d.site.rev) !== (c.site.rev || 0))) return fail('máy khác vừa lưu cấu hình — tải lại trang');
  // A setup page cached before v2 would re-derive the split flags from the old shape: only allowed while the live site is pre-v2 too.
  if (!reset && !c.legacy && d.site.featurePolicyVersion !== 2) return fail('trang cấu hình đã cũ — tải lại trang rồi sửa lại');
  const { site, errors } = Site.normalize(reset ? seed : d.site, seed);
  if (errors.length) return fail(errors.join('; '));
  if (site.map) { site.map = site.floor && R.clean(site.map, site); if (!site.map) return fail('lộ trình không hợp lệ'); }   // same check as an edit from map.html
  const used = Site.inUse(c.site, c.st);
  const billed = [...used.tables].filter(p => (site.points[p] || {}).kind !== 'table').map(p => pname(c, p));
  if (billed.length) return fail(billed.join(', ') + ' đang có đơn hoặc phiếu tính tiền chưa đóng — không xoá hay đổi loại điểm được');
  const gone = [...used.points].filter(p => !site.points[p]).map(p => pname(c, p)).concat([...used.robots].filter(id => !site.robots.some(r => r.id === id)));
  if (gone.length) return fail(gone.join(', ') + ' đang có lệnh');
  // The guest sees the QR of a prepared/claimed bill: the receiving account must not change under it (spec §7.3).
  const payee = s => JSON.stringify(['bank', 'account', 'name', 'qr'].map(k => (s.payment || {})[k] || ''));
  const waiting = c.st.bills.filter(b => b.status === 'prepared' || b.status === 'claimed').map(b => pname(c, b.table));
  if (waiting.length && payee(site) !== payee(c.site)) return fail(`${waiting.join(', ')} đang chờ thanh toán — hoàn tất hoặc vô hiệu hóa phiếu trước khi đổi tài khoản nhận tiền`);
  site.rev = (c.site.rev || 0) + 1; site.by = by; site.savedAt = c.now; site.saveRequestId = String(d.requestId || '').slice(0, 100);   // setup.html Sao lưu: "Lưu lần cuối bởi … lúc …"
  c.site = c.newSite = site;
  sync(c.st, site, c.now);
  log(c, 'info', `${by} ${reset ? 'khôi phục cấu hình mặc định' : 'cập nhật cấu hình'} (bản ${site.rev})`);
  c.ui.push({ payload: JSON.stringify({ type: 'site', site }) });
  c.force = true;
}

function fromUI(c, d, session, seed) {
  const { st } = c;
  const by = String(d.by || 'Không rõ').slice(0, 40);
  const r = st.robots[d.robot];
  const m = typeof d.mission === 'number' ? findM(c, d.mission) : null;
  switch (d.type) {
    case 'hello':
      c.ui.push({ session, payload: JSON.stringify({ type: 'site', site: c.site, migrated: c.legacy || undefined }) });   // setup: "check the request station"
      c.ui.push({ session, payload: JSON.stringify({ type: 'map', map: st.map }) });
      c.force = true;
      return;
    case 'create': return create(c, d, by, session);
    case 'cancel':
      if (m && !(m.loaded && m.kind === 'bus')) cancelMission(c, m, by, 'staff');   // dirty dishes still go to the dish area
      return;
    case 'cancelStop': {
      if (d.why !== 'customer') { if (m) cancelStop(c, m, d.stop, by, 'staff', d); return; }   // staff recall: unchanged
      // Guests (QR / robot screen) must name their table: the stop may have moved to another one. Policy request
      // (also the default of a v2 site missing the field) refuses old clients too; they get returnRequest.
      const no = (code, text) => reply(c, session, d.requestId, { ok: false, code, text });
      if (!d.table) return no('invalid', 'Thiếu bàn — vui lòng tải lại trang');
      if (c.site.customerCancel !== 'direct') return no('policy', 'Nhà hàng nhận yêu cầu trả món qua nhân viên — dùng "Báo nhầm món / Cần hỗ trợ"');
      if (!m || !cancelStop(c, m, d.stop, by, 'customer', d)) return no('stale', 'Món này đã được giao, huỷ hoặc chuyển bàn');
      return reply(c, session, d.requestId, { ok: true, text: `${pname(c, d.table)} huỷ món` });
    }
    case 'confirm': if (r) confirm(c, r, d, by); return;
    case 'dispatch': if (r) dispatch(c, r, d, by, session); return;
    case 'call': return call(c, d, by, session);
    case 'returnRequest': return returnRequest(c, d, by, session);
    case 'order': return order(c, d, by, session);
    case 'billPrepare': case 'billClaim': case 'billSettle': case 'billClose': case 'billVoid': return bill(c, d, by, session);
    case 'speed':   // guide: "Đi chậm hơn" for guests who walk slowly; ends with the mission. Driver support only (spec §5).
      if (!r) return;
      if (!Policy.capabilities(c.site.robots.find(x => x.id === r.id)).speedControl)
        return reply(c, session, d.requestId, { ok: false, code: 'unsupported', text: `${r.id} không chỉnh được tốc độ` });
      if (!r.mission || r.offline || !!d.slow === !!r.slow) return;
      r.slow = !!d.slow;
      c.cmds.push({ cmd: 'speed', robot: r.id, factor: r.slow ? SLOW : 1 });
      log(c, 'info', `${by}: ${r.id} ${r.slow ? 'đi chậm' : 'đi bình thường'}`, r.id);
      return;
    case 'retarget': if (m) retarget(c, m, d, by, session); return;
    case 'estop':   // simulates the physical E-stop on the robot body
      if (!r || r.halt === 'estop') return;
      r.halt = 'estop'; st.kpi.interventions++;
      c.cmds.push({ cmd: 'stop', robot: r.id });
      alert(c, 'es-' + r.id, 'error', `${r.id} DỪNG KHẨN CẤP — kiểm tra tại robot rồi nhả dừng`, r.id);
      ev(c, { robot: r.id, robotSound: 'estop', stationSound: 'alert', text: `${r.id} dừng khẩn cấp` });
      log(c, 'error', `${by}: ${r.id} dừng khẩn cấp`, r.id);
      return;
    case 'pause':
      if (!r || r.halt) return;
      r.halt = 'paused'; c.cmds.push({ cmd: 'stop', robot: r.id });
      alert(c, 'pa-' + r.id, 'warn', `${r.id} đang tạm dừng (${by})`, r.id);
      log(c, 'warn', `${by} tạm dừng ${r.id}`, r.id);
      return;
    case 'resume':
      // E-stop may only be released at the robot itself.
      if (!r || !(r.halt === 'paused' || (r.halt === 'estop' && d.atRobot))) return;
      resolve(c, 'es-' + r.id); resolve(c, 'pa-' + r.id);
      r.halt = null; r.waitSince = r.lastRemind = c.now;
      c.cmds.push({ cmd: 'resume', robot: r.id });
      log(c, 'ok', `${by} cho ${r.id} chạy tiếp`, r.id);
      return;
    case 'clear':   // staff removed the obstacle (sim: removes obstacles around the robot)
      if (r && (r.halt === 'blocked' || ['wait', 'stuck'].includes(r.nav))) { c.cmds.push({ cmd: 'sim', robot: r.id, fault: 'clear' }); log(c, 'info', `${by} đã dọn lối cho ${r.id}`, r.id); }
      return;
    case 'map': {   // operator saved a new route network
      const map = R.clean(d.map, c.site);
      if (!map) return;
      st.map = { v: st.map.v + 1, ...map };
      c.cmds.push({ cmd: 'map', map, v: st.map.v });
      const bad = R.unreachable(st.map, c.site);
      log(c, bad.length ? 'warn' : 'info', `${by} cập nhật lộ trình (bản ${st.map.v})${bad.length ? ' — không tới được: ' + bad.map(p => pname(c, p)).join(', ') : ''}`);
      c.ui.push({ payload: JSON.stringify({ type: 'map', map: st.map }) });
      return;
    }
    case 'mapReset':
      st.map = { v: st.map.v + 1, ...JSON.parse(JSON.stringify(c.site.map)) };
      c.cmds.push({ cmd: 'map', map: { nodes: st.map.nodes, edges: st.map.edges }, v: st.map.v });
      log(c, 'info', `${by} khôi phục lộ trình mặc định (bản ${st.map.v})`);
      c.ui.push({ payload: JSON.stringify({ type: 'map', map: st.map }) });
      return;
    case 'obstacle':   // demo: drop / remove a chair or a passer-by on the floor plan
      if (d.remove === 'all' || typeof d.remove === 'number') c.cmds.push({ cmd: 'obstacle', remove: d.remove });
      else if (isFinite(d.x) && isFinite(d.y)) c.cmds.push({ cmd: 'obstacle', x: +d.x, y: +d.y, kind: d.kind === 'person' ? 'person' : 'object' });
      return;
    case 'manual': {   // manual fallback: staff finishes the job by hand
      const mm = r && findM(c, r.mission);
      if (!mm) return;
      for (const s of mm.stops) if (open(s)) s.status = 'manual';
      st.kpi.failed++; st.kpi.interventions++;
      log(c, 'error', `${by} chuyển ${mm.label} sang xử lý thủ công`, r.id);
      return finish(c, mm, 'failed');
    }
    case 'ack': st.alerts = st.alerts.filter(a => a.id !== d.alert); return;
    case 'siteSave': case 'siteReset': return saveSite(c, d, session, seed, by);
    case 'probe':   // setup.html: drive an idle robot to a spot to check a taught point
      if (r && !r.mission && r.phase === 'idle' && !r.halt && !r.offline && isFinite(d.x) && isFinite(d.y)) {
        c.cmds.push({ cmd: 'probe', robot: r.id, x: Math.round(+d.x), y: Math.round(+d.y) });
        log(c, 'info', `${by} cho ${r.id} chạy thử tới (${Math.round(+d.x)}, ${Math.round(+d.y)})`, r.id);
      }
      return;
    case 'sim': if (r && SIM_FAULTS.includes(d.fault)) c.cmds.push({ cmd: 'sim', robot: r.id, fault: d.fault }); return;
    case 'reset':
      for (const k of Object.keys(st)) delete st[k];
      Object.assign(st, init(c.site, c.now));
      c.cmds.push({ cmd: 'reset' });
      c.ui.push({ payload: JSON.stringify({ type: 'map', map: st.map }) });
      log(c, 'info', `${by} khởi động lại demo`);
      return;
  }
}

function snapshot(st) {
  return {
    robots: Object.values(st.robots).map(({ id, x, y, battery, phase, at, target, mission, halt, offline, charging, waitSince, nav, why, path, rem, pos, slow }) =>
      ({ id, x, y, battery, phase, at, target, mission, halt, offline, charging, waitSince, nav, why, path, rem, pos: pos || null, slow: slow ? SLOW : 0 })),   // slow = speed factor while guiding slowly, 0 = normal
    missions: st.missions, history: st.history.slice(0, 15), log: st.log.slice(0, 40), alerts: st.alerts, kpi: st.kpi,
    obstacles: st.obstacles, mapV: st.map.v, orders: st.orders.filter(o => o.status !== 'closed'),
    bills: st.bills.filter(b => OPEN_BILL.includes(b.status)).map(({ receipts, ...b }) => b)   // history stays in persisted st
  };
}

// input: {source:'ui', data, session, seed?} | {source:'adapter', data}. Returns {ui, cmds, site?} — site only when the config changed.
function handle(st, rawSite, input, now) {
  // Everything below reads the canonical v2 site; the live/persisted one changes only through saveSite.
  // ponytail: legacy sites are cloned per message until saved once as v2 (sub-ms); cache by object if that ever shows up.
  const legacy = rawSite.featurePolicyVersion !== 2, site = legacy ? Policy.migrate(rawSite) : rawSite;
  const c = { st, site, legacy, now, ui: [], cmds: [], force: false };
  sync(st, site, now);
  const d = input.data;
  if (d && typeof d === 'object') {
    if (input.source === 'adapter') {
      if (d.event === 'telemetry') { telemetry(c, d); timers(c); }
      else if (d.event === 'arrived' && st.robots[d.robot]) arrived(c, st.robots[d.robot], d.token);
      else if (d.event === 'reroute' && st.robots[d.robot]) reroute(c, st.robots[d.robot], d.why);
      else if (d.event === 'log' && st.robots[d.robot]) log(c, 'info', String(d.text).slice(0, 160), d.robot);
      else if (d.event === 'alert' && typeof d.key === 'string') alert(c, d.key, d.level === 'error' ? 'error' : 'warn', String(d.text).slice(0, 200));
      else if (d.event === 'resolve' && typeof d.key === 'string') resolve(c, d.key);
    } else fromUI(c, d, input.session, input.seed);
  }
  assign(c);
  for (const r of Object.values(st.robots)) if (r.homeDue) { r.homeDue = false; if (!r.mission) goTo(c, r, r.dock, 'toDock'); }
  const snap = JSON.stringify(snapshot(st));
  if (c.force || snap !== lastSnap) {
    lastSnap = snap;
    c.ui.push({ payload: `{"type":"state","now":${now},${snap.slice(1)}` });
  }
  return c.newSite ? { ui: c.ui, cmds: c.cmds, site: c.newSite } : { ui: c.ui, cmds: c.cmds };
}

function arrived(c, r, token) {
  if (token !== r.token || !r.target) return;
  r.at = r.target; r.target = null;
  if (r.phase === 'toDock') { r.phase = 'idle'; return; }
  if (r.phase !== 'toStop') return;
  r.phase = 'atStop'; r.waitSince = r.lastRemind = c.now;
  const m = findM(c, r.mission), s = m.stops[m.cur];
  ev(c, { robot: r.id, robotSound: ARRIVE_SOUND[s.a], point: s.p, table: s.p,
    stationSound: ['load', 'unload', 'return'].includes(s.a) ? 'ding' : undefined,
    text: `${r.id} đã đến ${pname(c, s.p)} — ${ACTION_VI[s.a]}` });
}

module.exports = { init, handle, ACTION_VI };

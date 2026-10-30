'use strict';
// MEKONIQ Serve S1 — Mission Orchestrator (CORE): queue, mission state machine, alerts, KPI.
// Pure logic: handle(st, site, input, now) -> { ui: [{payload, session?}], cmds: [adapter cmd] }.
// It only talks to robots through the adapter contract, so the simulator can be swapped for a
// vendor gateway without touching this file:
//   cmds   -> {cmd:'goto', robot, to, x, y, token} | {cmd:'stop'|'resume', robot} | {cmd:'map', map, v}
//             | {cmd:'obstacle', x, y, kind | remove} | {cmd:'sim', robot, fault} | {cmd:'reset'}
//   events <- {event:'telemetry', mapV, obstacles, robots:[{id, x, y, battery, moving, blocked, nav, why, path, rem}]}
//             | {event:'arrived', robot, token} | {event:'reroute', robot, why}
// The route network (st.map) lives here, like a fleet manager's map; robots get it via {cmd:'map'}.
// NOTE: this is not a safety system. Physical E-stop / collision safety must live on the robot.

const OFFLINE_SEC = 3;
const KEEP_LOG = 60, KEEP_HISTORY = 30;
const ACTION_VI = { load: 'Xếp đồ lên khay', handoff: 'Giao cho khách', collect: 'Thu chén đĩa', unload: 'Dỡ chén đĩa', return: 'Trả lại món bị huỷ', standby: 'Chờ lệnh' };
const STATUS_VI = { done: 'hoàn thành', cancelled: 'đã huỷ', failed: 'chuyển xử lý thủ công' };
const ARRIVE_SOUND = { load: 'load', handoff: 'arrived', collect: 'collect', unload: 'unload', return: 'unload', standby: 'standby' };
const SIM_FAULTS = ['block', 'clear', 'offline', 'online', 'lowbat'];
const R = require('./route');
const Site = require('./site');
const WHY_VI = { object: 'vật cản', person: 'người đi qua', robot: 'robot khác' };

let lastSnap = '';

function init(site, now) {
  const st = { seq: 0, alertSeq: 0, robots: {}, missions: [], history: [], log: [], alerts: [],
    kpi: { delivered: 0, cancelledCustomer: 0, cancelledStaff: 0, timeout: 0, failed: 0, interventions: 0, deliverySecSum: 0, reroutes: 0 } };
  sync(st, site, now);
  return st;
}

// Adds robots that appear in site.json after state was persisted.
// Also drops robots removed from site.json (setup.html) once they have no mission.
function sync(st, site, now) {
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
  if (m.kind === 'bus') return `#${m.id} Thu dọn ${pname(c, m.stops[0].p)}`;
  return `#${m.id} Gọi robot tới ${pname(c, m.stops[0].p)}`;
}

function log(c, level, text, robot) {
  c.st.log.unshift({ t: c.now, level, text, robot });
  c.st.log.length = Math.min(c.st.log.length, KEEP_LOG);
}
function alert(c, key, level, text, robot) {
  if (c.st.alerts.some(a => a.key === key)) return;
  c.st.alerts.unshift({ id: ++c.st.alertSeq, key, t: c.now, level, text, robot });
  c.st.alerts.length = Math.min(c.st.alerts.length, 20);
}
const resolve = (c, key) => { c.st.alerts = c.st.alerts.filter(a => a.key !== key); };
// Client-side cues. robotSound -> robot screen, stationSound -> stations (filtered by point), table -> customer page.
const ev = (c, e) => c.ui.push({ payload: JSON.stringify({ type: 'event', t: c.now, ...e }) });

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
  const key = { deliver: 'handoff', bus: 'collect', summon: 'standby' }[m.kind];
  m.status = status || (m.stops.some(s => s.a === key && s.status === 'done') ? 'done' : 'cancelled');
  m.endedAt = c.now;
  c.st.missions = c.st.missions.filter(x => x !== m);
  c.st.history.unshift(m);
  c.st.history.length = Math.min(c.st.history.length, KEEP_HISTORY);
  log(c, m.status === 'done' ? 'ok' : 'warn', `${m.label}: ${STATUS_VI[m.status]}`, m.robot);
  const r = c.st.robots[m.robot];
  if (r && r.mission === m.id) {
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

function create(c, d, by) {
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
  } else if (d.kind === 'summon') {
    if (!P[d.to] || P[d.to].kind === 'dock') return;
    stops = [{ p: d.to, a: 'standby' }];
  } else return;
  const m = { id: ++c.st.seq, kind: d.kind, by, urgent: !!d.urgent, robotPref: pref, createdAt: c.now, status: 'queued',
    robot: null, loaded: false, cur: -1, note: String(d.note || '').slice(0, 80), stops: stops.map(s => ({ ...s, status: 'pending' })) };
  m.label = label(c, m);
  c.st.missions.push(m);
  log(c, 'info', `${by} tạo ${m.label}${m.urgent ? ' (GẤP)' : ''}${pref !== 'any' ? ' cho ' + pref : ''}`);
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

function cancelStop(c, m, i, by, why) {
  const s = m.stops[i];
  if (!s || s.a !== 'handoff' || !open(s)) return;
  const here = m.status === 'active' && m.cur === i && c.st.robots[m.robot].phase === 'atStop';
  dropStop(c, m, i, by, why);
  const tail = m.loaded ? ` — ${m.robot} mang khay ${s.tray} về ${pname(c, m.stops[0].p)}` : ' (chưa xếp khay)';
  log(c, 'warn', `${by} huỷ món ${pname(c, s.p)} của ${m.label}${tail}`, m.robot);
  ev(c, { table: s.p, stationSound: 'cancelled', point: m.stops[0].p, robot: here ? m.robot : undefined, robotSound: here ? 'cancel' : undefined,
    text: `${pname(c, s.p)} huỷ món${tail}` });
  advance(c, m);
}

function confirm(c, r, d, by) {
  const m = findM(c, r.mission);
  if (!m || r.phase !== 'atStop' || d.mission !== m.id || d.stop !== m.cur) return;   // stale / double tap
  const s = m.stops[m.cur];
  s.status = 'done'; s.doneAt = c.now; s.by = by;
  if (s.a === 'load' || s.a === 'collect') m.loaded = true;
  if (s.a === 'unload' || s.a === 'return') m.loaded = false;
  if (s.a === 'handoff') {
    c.st.kpi.delivered++;
    c.st.kpi.deliverySecSum += (c.now - m.createdAt) / 1000;
    ev(c, { robot: r.id, robotSound: 'thanks', table: s.p, text: `${pname(c, s.p)} đã nhận món` });
  }
  resolve(c, 'wait-' + r.id);
  log(c, 'ok', `${r.id} · ${pname(c, s.p)}: ${ACTION_VI[s.a]} ✓`, r.id);
  advance(c, m);
}

// A robot summoned to a spot gets its next job from the robot screen.
function dispatch(c, r, d, by) {
  const m = findM(c, r.mission);
  if (!m || m.kind !== 'summon' || r.phase !== 'atStop' || d.mission !== m.id) return;
  const P = c.site.points, s = m.stops[m.cur];
  if (d.release) { s.status = 'done'; log(c, 'info', `${by} cho ${r.id} về`, r.id); return advance(c, m); }
  if (d.toDish) {
    if (s.p === c.site.dishPoint) return;
    Object.assign(s, { a: 'collect', status: 'done' });
    m.kind = 'bus'; m.loaded = true;
    m.stops.push({ p: c.site.dishPoint, a: 'unload', status: 'pending' });
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
  const { site, errors } = Site.normalize(reset ? seed : d.site, seed);
  if (errors.length) return fail(errors.join('; '));
  if (site.map) { site.map = site.floor && R.clean(site.map, site); if (!site.map) return fail('lộ trình không hợp lệ'); }   // same check as an edit from map.html
  const used = Site.inUse(c.site, c.st);
  const gone = [...used.points].filter(p => !site.points[p]).map(p => pname(c, p)).concat([...used.robots].filter(id => !site.robots.some(r => r.id === id)));
  if (gone.length) return fail(gone.join(', ') + ' đang có lệnh');
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
      c.ui.push({ session, payload: JSON.stringify({ type: 'site', site: c.site }) });
      c.ui.push({ session, payload: JSON.stringify({ type: 'map', map: st.map }) });
      c.force = true;
      return;
    case 'create': return create(c, d, by);
    case 'cancel':
      if (m && !(m.loaded && m.kind === 'bus')) cancelMission(c, m, by, 'staff');   // dirty dishes still go to the dish area
      return;
    case 'cancelStop': if (m) cancelStop(c, m, d.stop, by, d.why === 'customer' ? 'customer' : 'staff'); return;
    case 'confirm': if (r) confirm(c, r, d, by); return;
    case 'dispatch': if (r) dispatch(c, r, d, by); return;
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
    robots: Object.values(st.robots).map(({ id, x, y, battery, phase, at, target, mission, halt, offline, charging, waitSince, nav, why, path, rem, pos }) =>
      ({ id, x, y, battery, phase, at, target, mission, halt, offline, charging, waitSince, nav, why, path, rem, pos: pos || null })),
    missions: st.missions, history: st.history.slice(0, 15), log: st.log.slice(0, 40), alerts: st.alerts, kpi: st.kpi,
    obstacles: st.obstacles, mapV: st.map.v
  };
}

// input: {source:'ui', data, session, seed?} | {source:'adapter', data}. Returns {ui, cmds, site?} — site only when the config changed.
function handle(st, site, input, now) {
  const c = { st, site, now, ui: [], cmds: [], force: false };
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

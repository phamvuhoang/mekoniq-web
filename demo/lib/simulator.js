'use strict';
// MEKONIQ Serve S1 — Robot Adapter (SIMULATOR). Implements the same contract a vendor gateway would:
// takes orchestrator cmds, emits {event:'telemetry'} every tick, {event:'arrived'} on reaching a goal
// and {event:'reroute'} when it plans around an obstacle.
// Navigation mimics a restaurant robot in "fixed route" mode:
//   - drives only along the designed route network (lib/route.js), slower in slow zones;
//   - senses obstacles / stopped robots ahead on its lane: slows down, stops, asks people to make way;
//   - still blocked after waitSec -> replans around that lane; no detour left -> reports blocked;
//   - narrow lanes and the dead-end spur to each table/station/dock hold one robot at a time:
//     the others wait aside before the entrance (no queueing into a dead end);
//   - a robot already standing at my goal (e.g. at the kitchen) -> queue patiently, no alarm.
// ponytail: point-mass robots on a graph, moving robots pass each other on wide aisles; real robots
// do local avoidance with lidar/depth cameras and the physical E-stop/bumper is the safety layer.
const R = require('./route');

const SENSE = 1.6;   // m looked ahead along the path
const STOP = 0.55;   // stop this far before an obstacle
const YIELD = 0.8;   // wait this far before a narrow lane that is occupied
const LANE = { object: 0.5, person: 0.5, robot: 0.35 };   // lateral distance that still blocks the lane

function init(site) {
  const sim = { ver: 2, last: 0, robots: {}, map: site.map, mapV: 0, obstacles: [], obSeq: 0, locks: {} };
  for (const { id, dock, driver } of site.robots) {
    if (driver && driver !== 'sim') continue;   // driven by another adapter (lib/valetudo.js)
    const p = site.map && site.map.nodes[dock];
    if (!p) continue;   // dock not on the route network (Valetudo-only site)
    sim.robots[id] = { x: p.x, y: p.y, dock, battery: 100, goal: null, path: [], prev: dock, nav: 'idle', why: null,
      waitSince: 0, avoid: [], stopped: false, offline: false, mv: false };
  }
  return sim;
}

const round = (v, n) => Math.round(v * n) / n;
const node = (sim, id) => sim.map.nodes[id];
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function unlock(sim, id, keep) {
  for (const k of Object.keys(sim.locks)) if (sim.locks[k] === id && k !== keep) delete sim.locks[k];
}

// Plans from where the robot stands to its goal. Returns false when no route exists.
function replan(sim, id, b) {
  const nxt = b.path[0], prv = node(sim, b.prev) ? b.prev : null;
  let starts;
  if (nxt && prv && node(sim, nxt)) {   // between two nodes: go on, or turn back
    starts = [[prv, d2(b, node(sim, prv))]];
    if (!b.avoid.includes(R.key(prv, nxt)) && R.edgeOf(sim.map, prv, nxt)) starts.push([nxt, d2(b, node(sim, nxt))]);
  } else starts = [[R.nearestNode(sim.map, b.x, b.y)[0], 0]];
  const p = R.plan(sim.map, starts, b.goal.node, b.avoid);
  const mid = nxt && prv && d2(b, node(sim, prv)) > 0.05 ? R.key(prv, nxt) : null;
  unlock(sim, id, mid);
  if (!p) { b.path = []; b.nav = 'stuck'; b.why = 'noroute'; b.waitSince = sim.last; return false; }
  if (mid && p.nodes[0] === prv) b.prev = nxt;   // turning back: the edge is the same, the direction flips
  b.path = p.nodes; b.nav = 'go'; b.why = null;
  return true;
}

// Nearest thing blocking the lane ahead: {d, edge, kind, atGoal} or null.
function sense(sim, id, b) {
  const things = sim.obstacles.map(o => ({ x: o.x, y: o.y, kind: o.kind }));
  for (const [oid, o] of Object.entries(sim.robots)) if (oid !== id && !o.mv && !o.offline && o.nav !== 'yield') things.push({ x: o.x, y: o.y, kind: 'robot' });
  const goal = node(sim, b.goal.node);
  let best = null, from = { x: b.x, y: b.y }, prev = b.prev, walked = 0;
  for (const n of b.path) {
    const to = node(sim, n), L = d2(from, to);
    for (const t of things) {
      const u = L ? ((t.x - from.x) * (to.x - from.x) + (t.y - from.y) * (to.y - from.y)) / (L * L) : 0;
      if (u < 0 || u > 1) continue;
      const lat = Math.hypot(from.x + u * (to.x - from.x) - t.x, from.y + u * (to.y - from.y) - t.y);
      const d = walked + u * L;
      if (lat < LANE[t.kind] && d > 0.05 && d <= SENSE && (!best || d < best.d))
        best = { d, edge: R.key(prev, n), kind: t.kind, atGoal: d2(t, goal) < 0.6 };
    }
    walked += L;
    if (walked > SENSE) break;
    from = to; prev = n;
  }
  return best;
}

const single = (site, e) => e && (e.narrow || !!site.points[e.a] || !!site.points[e.b]);   // one robot at a time
// Someone else holds the lane, or stands at the stop at its end.
function busy(sim, site, id, e) {
  const k = R.key(e.a, e.b);
  if (sim.locks[k] && sim.locks[k] !== id) return true;
  const stop = site.points[e.a] ? e.a : site.points[e.b] ? e.b : null, n = stop && node(sim, stop);
  return !!n && Object.entries(sim.robots).some(([oid, o]) => oid !== id && d2(o, n) < 0.05);
}
// Consecutive single-robot edges starting at path[i-1] -> path[i]; true when this robot holds (or got) all of them.
function takeNarrow(sim, site, id, b, i) {
  const run = [];
  for (let k = i; k < b.path.length; k++) {
    const e = R.edgeOf(sim.map, k === 0 ? b.prev : b.path[k - 1], b.path[k]);
    if (!single(site, e)) break;
    run.push(e);
  }
  if (run.some(e => busy(sim, site, id, e))) return false;
  for (const e of run) sim.locks[R.key(e.a, e.b)] = id;
  return true;
}

function drive(sim, site, id, b, dt, events) {
  const S = site.sim, now = sim.last;
  if (b.nav === 'stuck' && b.why === 'noroute') {   // retry: staff may reopen a lane
    if (now - b.waitSince >= 3000 && replan(sim, id, b)) events.push({ event: 'reroute', robot: id, why: 'reopened' });
    if (b.nav === 'stuck') return false;
  }
  const ahead = sense(sim, id, b);
  if (ahead && ahead.d <= STOP) {
    if (!['wait', 'queue', 'stuck'].includes(b.nav)) { b.nav = ahead.atGoal && ahead.kind === 'robot' ? 'queue' : 'wait'; b.why = ahead.kind; b.waitSince = now; }
    else if (b.nav === 'wait' && now - b.waitSince >= S.waitSec * 1000 && ahead.atGoal) b.nav = 'stuck';   // no detour reaches a blocked goal
    else if (b.nav !== 'queue' && !ahead.atGoal && now - b.waitSince >= S.waitSec * 1000) {
      // Still blocked: plan around this lane. A robot standing at my goal is a queue, not a blockage.
      b.avoid.push(ahead.edge);
      if (replan(sim, id, b)) events.push({ event: 'reroute', robot: id, why: ahead.kind });
      else { b.avoid.pop(); if (replan(sim, id, b)) { b.nav = 'stuck'; b.why = ahead.kind; } }
      b.waitSince = now;
    }
    return false;
  }
  if (['wait', 'queue', 'stuck', 'yield'].includes(b.nav)) { b.nav = 'go'; b.why = null; }

  const slowAhead = ahead ? Math.max(0.35, (ahead.d - STOP) / (SENSE - STOP)) : 1;
  let step = S.speed * (b.factor || 1) * dt * slowAhead, moved = false;
  while (step > 1e-6 && b.path.length) {
    const nxt = b.path[0], to = node(sim, nxt), e = R.edgeOf(sim.map, b.prev, nxt);
    const left = d2(b, to);
    // Before a narrow lane: reserve the whole run or wait at the entrance.
    if (b.path.length > 1 && left <= YIELD + step) {
      const ne = R.edgeOf(sim.map, nxt, b.path[1]);
      if (single(site, ne) && !takeNarrow(sim, site, id, b, 1)) {
        if (left > YIELD) { const s = left - YIELD; b.x += (to.x - b.x) / left * s; b.y += (to.y - b.y) / left * s; moved = true; }
        b.nav = 'yield'; b.why = sim.locks[R.key(nxt, b.path[1])] || null;
        break;
      }
    }
    if (single(site, e)) takeNarrow(sim, site, id, b, 0);
    const s = Math.min(left, step * (e && e.slow ? 0.5 : 1));
    if (left > 1e-6) { b.x += (to.x - b.x) / left * s; b.y += (to.y - b.y) / left * s; moved = true; }
    step -= s / (e && e.slow ? 0.5 : 1);
    if (s >= left - 1e-6) {   // reached a node
      b.x = to.x; b.y = to.y;
      delete sim.locks[R.key(b.prev, nxt)];
      b.prev = nxt; b.path.shift();
    }
  }
  if (!b.path.length && b.goal && d2(b, node(sim, b.goal.node)) < 0.05) {
    events.push({ event: 'arrived', robot: id, token: b.goal.token });
    b.goal = null; b.nav = 'idle'; b.why = null; b.avoid = []; unlock(sim, id);
  }
  return moved;
}

// input: {cmd:'tick'} | orchestrator cmd. Returns adapter events.
function handle(sim, site, input, now) {
  // state saved by an older version, or before robots were added / moved to another driver
  const ids = site.robots.filter(r => !r.driver || r.driver === 'sim').map(r => r.id).join();
  if (sim.ver !== 2 || Object.keys(sim.robots).join() !== ids) Object.assign(sim, init(site));
  const b = sim.robots[input.robot];
  switch (input.cmd) {
    case 'goto':
      if (!b || !node(sim, input.to)) return [];
      b.goal = { node: input.to, token: input.token }; b.avoid = [];
      replan(sim, input.robot, b);
      return [];
    case 'speed': if (b) b.factor = Math.max(0.25, Math.min(1, +input.factor || 1)); return [];   // guide slow mode
    case 'stop': if (b) b.stopped = true; return [];
    case 'resume': if (b) b.stopped = false; return [];
    case 'map':   // new route network from the fleet manager: every moving robot replans
      sim.map = input.map; sim.mapV = input.v; sim.locks = {};
      for (const [id, r] of Object.entries(sim.robots)) {
        if (!node(sim, r.prev)) r.prev = R.nearestNode(sim.map, r.x, r.y)[0];
        if (r.path.some(n => !node(sim, n))) r.path = [];
        if (r.goal) { r.avoid = []; replan(sim, id, r); }
      }
      return [];
    case 'obstacle':
      if (input.remove === 'all') sim.obstacles = [];
      else if (input.remove) sim.obstacles = sim.obstacles.filter(o => o.id !== input.remove);
      else if (isFinite(input.x) && isFinite(input.y) && sim.obstacles.length < 30) {
        const kind = input.kind === 'person' ? 'person' : 'object';
        sim.obstacles.push({ id: ++sim.obSeq, x: round(+input.x, 100), y: round(+input.y, 100), kind,
          until: kind === 'person' ? now + site.sim.personSec * 1000 : 0 });
      }
      return [];
    case 'sim':
      if (!b) return [];
      if (input.fault === 'block') {   // drop a chair on the lane ~1.2 m ahead of the robot
        let from = b, rest = 1.2, at = null;
        for (const n of b.path) {
          const to = node(sim, n), L = d2(from, to);
          if (L >= rest) { at = { x: from.x + (to.x - from.x) * rest / L, y: from.y + (to.y - from.y) * rest / L }; break; }
          rest -= L; from = to;
        }
        if (at) sim.obstacles.push({ id: ++sim.obSeq, x: round(at.x, 100), y: round(at.y, 100), kind: 'object', until: 0 });
      }
      if (input.fault === 'clear') {   // staff cleared the lane around this robot
        sim.obstacles = sim.obstacles.filter(o => d2(o, b) > SENSE + 0.5);
        if (b.nav === 'stuck' && b.goal) { b.avoid = []; replan(sim, input.robot, b); }
      }
      if (input.fault === 'offline') b.offline = true;
      if (input.fault === 'online') b.offline = false;
      if (input.fault === 'lowbat') b.battery = Math.min(b.battery, site.timing.lowBattery - 5);
      return [];
    case 'reset':
      for (const k of Object.keys(sim)) delete sim[k];
      Object.assign(sim, init(site));
      return [];
    case 'tick': break;
    default: return [];
  }

  const S = site.sim;
  const dt = sim.last ? Math.min(2, (now - sim.last) / 1000) : 0;
  sim.last = now;
  sim.obstacles = sim.obstacles.filter(o => !o.until || o.until > now);   // people walk on
  const events = [], telemetry = [];
  for (const [id, r] of Object.entries(sim.robots)) {
    if (r.offline) continue;   // ponytail: frozen while offline; a real robot may keep driving
    const moving = !!r.goal && !r.stopped && drive(sim, site, id, r, dt, events);
    r.mv = moving;
    if (moving) r.battery -= S.drainMove * dt;
    else {
      const dock = node(sim, r.dock);
      r.battery += dock && d2(r, dock) < 0.2 ? S.charge * dt : -S.drainIdle * dt;
    }
    r.battery = Math.max(0, Math.min(100, r.battery));
    let rem = 0, from = r;
    const path = r.path.map(n => { const p = node(sim, n); rem += d2(from, p); from = p; return [p.x, p.y]; });
    telemetry.push({ id, x: round(r.x, 100), y: round(r.y, 100), battery: round(r.battery, 10), moving,
      blocked: r.nav === 'stuck', nav: r.goal ? r.nav : 'idle', why: r.why, path, rem: round(rem, 10) });
  }
  return [{ event: 'telemetry', robots: telemetry, mapV: sim.mapV,
    obstacles: sim.obstacles.map(({ id, x, y, kind }) => ({ id, x, y, kind })) }, ...events];
}

module.exports = { init, handle };

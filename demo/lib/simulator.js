'use strict';
// MEKONIQ Serve S1 — Robot Adapter (SIMULATOR). Implements the same contract a vendor gateway would:
// takes orchestrator cmds, emits {event:'telemetry'} every tick and {event:'arrived'} on reaching a goal.
// ponytail: straight-line motion, no path planning / collision model — a real robot's navigation does that.

function init(site) {
  const sim = { last: 0, robots: {} };
  for (const { id, dock } of site.robots) {
    const p = site.points[dock];
    sim.robots[id] = { x: p.x, y: p.y, dock, battery: 100, goal: null, stopped: false, blocked: false, offline: false };
  }
  return sim;
}

const round = (v, n) => Math.round(v * n) / n;

// input: {cmd:'tick'} | orchestrator cmd. Returns adapter events.
function handle(sim, site, input, now) {
  const r = sim.robots[input.robot];
  switch (input.cmd) {
    case 'goto': if (r) r.goal = { x: input.x, y: input.y, token: input.token }; return [];
    case 'stop': if (r) r.stopped = true; return [];
    case 'resume': if (r) r.stopped = false; return [];
    case 'sim':
      if (!r) return [];
      if (input.fault === 'block') r.blocked = true;
      if (input.fault === 'clear') r.blocked = false;
      if (input.fault === 'offline') r.offline = true;
      if (input.fault === 'online') r.offline = false;
      if (input.fault === 'lowbat') r.battery = Math.min(r.battery, site.timing.lowBattery - 5);
      return [];
    case 'reset':
      Object.assign(sim, init(site));
      return [];
    case 'tick': break;
    default: return [];
  }

  const S = site.sim;
  const dt = sim.last ? Math.min(2, (now - sim.last) / 1000) : 0;
  sim.last = now;
  const events = [], telemetry = [];
  for (const [id, b] of Object.entries(sim.robots)) {
    if (b.offline) continue;   // ponytail: frozen while offline; a real robot may keep driving
    const moving = !!b.goal && !b.stopped && !b.blocked;
    if (moving) {
      const dx = b.goal.x - b.x, dy = b.goal.y - b.y, d = Math.hypot(dx, dy), step = S.speed * dt;
      if (d <= step) {
        b.x = b.goal.x; b.y = b.goal.y;
        events.push({ event: 'arrived', robot: id, token: b.goal.token });
        b.goal = null;
      } else { b.x += dx / d * step; b.y += dy / d * step; }
      b.battery -= S.drainMove * dt;
    } else {
      const dock = site.points[b.dock];
      b.battery += Math.hypot(b.x - dock.x, b.y - dock.y) < 0.2 ? S.charge * dt : -S.drainIdle * dt;
    }
    b.battery = Math.max(0, Math.min(100, b.battery));
    telemetry.push({ id, x: round(b.x, 100), y: round(b.y, 100), battery: round(b.battery, 10), moving, blocked: b.blocked });
  }
  return [{ event: 'telemetry', robots: telemetry }, ...events];
}

module.exports = { init, handle };

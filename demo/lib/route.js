'use strict';
// MEKONIQ Serve S1 — route network ("virtual track"), shared by orchestrator, simulator and UI.
// Robots only drive along edges the operator designed: aisles, narrow lanes (one robot at a time),
// one-way lanes, slow zones and closed lanes. Point ids (tables, stations, docks) are nodes too:
// the node is where the robot stands to serve, not the table itself.
//   map = { v, nodes: {id: {x, y}}, edges: [{a, b, oneway?, narrow?, slow?, closed?}] }

const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const len = (map, a, b) => Math.hypot(map.nodes[a].x - map.nodes[b].x, map.nodes[a].y - map.nodes[b].y);
const edgeOf = (map, a, b) => map.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));

// Edges a robot may drive from -> to (closed, wrong-way and avoided edges excluded).
function neighbours(map, avoid) {
  const out = {};
  for (const id of Object.keys(map.nodes)) out[id] = [];
  for (const e of map.edges) {
    if (e.closed || !map.nodes[e.a] || !map.nodes[e.b] || (avoid && avoid.includes(key(e.a, e.b)))) continue;
    const w = len(map, e.a, e.b) * (e.slow ? 2 : 1) * (e.narrow ? 1.3 : 1);   // prefer wide, fast aisles
    out[e.a].push([e.b, w]);
    if (!e.oneway) out[e.b].push([e.a, w]);
  }
  return out;
}

// Dijkstra from several start nodes (each with an initial cost). Returns {nodes: [..], cost} or null.
// ponytail: O(n²) scan, fine for a restaurant-sized graph (< 200 nodes).
function plan(map, starts, goal, avoid) {
  if (!map.nodes[goal]) return null;
  const nb = neighbours(map, avoid), cost = {}, prev = {}, done = new Set();
  for (const [n, c] of starts) if (map.nodes[n] && !(cost[n] <= c)) cost[n] = c;
  for (;;) {
    let u = null;
    for (const n of Object.keys(cost)) if (!done.has(n) && (u === null || cost[n] < cost[u])) u = n;
    if (u === null) return null;
    if (u === goal) break;
    done.add(u);
    for (const [v, w] of nb[u]) if (!(cost[v] <= cost[u] + w)) { cost[v] = cost[u] + w; prev[v] = u; }
  }
  const nodes = [goal];
  while (prev[nodes[0]] !== undefined) nodes.unshift(prev[nodes[0]]);
  return { nodes, cost: cost[goal] };
}

function nearestNode(map, x, y) {
  let best = null, bd = Infinity;
  for (const [id, n] of Object.entries(map.nodes)) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) { bd = d; best = id; }
  }
  return [best, bd];
}

// Rough route length from a free position (used to pick the nearest robot).
function distance(map, x, y, goal) {
  const [n, d] = nearestNode(map, x, y);
  const p = n && plan(map, [[n, d]], goal);
  return p ? p.cost : Infinity;
}

// Point ids no robot can reach from its dock — shown as a warning in the map editor.
// Points without a node are Valetudo-only (placed on the robot's own map): not the route network's business.
function unreachable(map, site) {
  const docks = site.robots.map(r => r.dock).filter(d => map.nodes[d]);
  return Object.keys(site.points).filter(p => map.nodes[p] && !docks.some(d => d === p || plan(map, [[d, 0]], p)));
}

// Validates a map coming from the UI. Returns a clean copy or null.
function clean(map, site) {
  if (!map || typeof map !== 'object' || !map.nodes || !Array.isArray(map.edges)) return null;
  const nodes = {};
  for (const [id, n] of Object.entries(map.nodes)) {
    if (!/^[\w-]{1,20}$/.test(id) || !n || !isFinite(n.x) || !isFinite(n.y)) return null;
    nodes[id] = { x: Math.round(Math.max(0, Math.min(site.floor.w, +n.x)) * 100) / 100, y: Math.round(Math.max(0, Math.min(site.floor.h, +n.y)) * 100) / 100 };
  }
  const had = (site.map && site.map.nodes) || {};
  if (Object.keys(site.points).some(p => had[p] && !nodes[p])) return null;   // a stop that had a node keeps it
  const seen = new Set(), edges = [];
  for (const e of map.edges) {
    if (!e || !nodes[e.a] || !nodes[e.b] || e.a === e.b || seen.has(key(e.a, e.b))) continue;
    seen.add(key(e.a, e.b));
    edges.push({ a: e.a, b: e.b, ...(e.oneway && { oneway: true }), ...(e.narrow && { narrow: true }), ...(e.slow && { slow: true }), ...(e.closed && { closed: true }) });
  }
  return { nodes, edges };
}

module.exports = { key, len, edgeOf, plan, nearestNode, distance, unreachable, clean };

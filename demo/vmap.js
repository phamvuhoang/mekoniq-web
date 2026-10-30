// Valetudo map on a <canvas>: floor / walls / rooms from the compact map served at /api/map/:robot, plus the
// site's taught points (robot cm) and the robots themselves. Shared by station.html (view) and setup.html (place points).
//   const vm = VMap(canvas, { onTap(x, y, hitId), fit });   // x,y in robot cm; hitId = point under the finger or null
//   fit: true -> a ResizeObserver keeps the canvas pixels matched to its CSS box (window resize, alert strips, hidden -> shown)
//   vm.setMap(map | null); vm.setZoom(1|2, centre?); vm.draw({ points, robots, charger });
//   vm.toMap(clientX, clientY) -> {x, y};  vm.hit(clientX, clientY) -> id | null
//   vm.resize()   // match the canvas pixels to its CSS box (× devicePixelRatio) and redraw; no-op while hidden
// Drawing works in CSS px (canvas px / k); without resize() k = 1 and the canvas keeps its width/height attributes.
// Coordinates: Valetudo cm, origin top-left, y down — the same frame as GoToLocationCapability.
function VMap(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const COL = { floor: '#f3f7f4', wall: '#143034', bg: '#edf4f0', text: '#071d21', label: '#547078', mint: '#b9fb75', danger: '#d93d42',
    seg: ['#cfe8ff', '#d9f3dc', '#fde8c8', '#ead9ff', '#ffd9e1', '#dff5f3'], tone: TONE };
  let k = 1, W = canvas.width, H = canvas.height;   // device px per CSS px; drawing size in CSS px
  let map = null, img = null, segLabels = [], zoom = 1, centre = null, last = null, box = null;   // box: cm bbox of drawn pixels
  let tf = { s: 1, ox: 0, oy: 0 };   // cm -> canvas px: px = cm * s + ox
  const toPx = (x, y) => [x * tf.s + tf.ox, y * tf.s + tf.oy];

  // Rasterize layers once per map at 1 canvas px per map pixel (5 cm): cheap to redraw, cheap to scale.
  function setMap(m) {
    map = m; segLabels = [];
    if (!m) return;   // null: no map (another robot selected, or none received yet)
    const W = Math.ceil(m.size.x / m.pixelSize), H = Math.ceil(m.size.y / m.pixelSize);
    img = document.createElement('canvas'); img.width = W; img.height = H;
    const c = img.getContext('2d');
    const order = ['floor', 'segment', 'wall'];
    let si = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const type of order) for (const l of m.layers) {
      if (l.type !== type) continue;
      c.fillStyle = type === 'segment' ? COL.seg[si++ % COL.seg.length] : COL[type];
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let i = 0; i + 2 < l.px.length; i += 3) {
        const x = l.px[i], y = l.px[i + 1], n = l.px[i + 2];
        c.fillRect(x, y, n, 1);
        if (x < minx) minx = x; if (x + n - 1 > maxx) maxx = x + n - 1; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      if (type === 'segment' && l.name && maxx >= minx) segLabels.push({ name: l.name, x: (minx + maxx) / 2 * m.pixelSize, y: (miny + maxy) / 2 * m.pixelSize });
      if (maxx >= minx) { bx0 = Math.min(bx0, minx); by0 = Math.min(by0, miny); bx1 = Math.max(bx1, maxx + 1); by1 = Math.max(by1, maxy + 1); }
    }
    // Valetudo maps carry a wide empty margin: fit the drawn area (plus 1 m), not the nominal size.
    const pad = 100 / m.pixelSize;
    box = bx1 > bx0 ? { x: Math.max(0, bx0 - pad) * m.pixelSize, y: Math.max(0, by0 - pad) * m.pixelSize,
      w: (Math.min(W, bx1 + pad) - Math.max(0, bx0 - pad)) * m.pixelSize, h: (Math.min(H, by1 + pad) - Math.max(0, by0 - pad)) * m.pixelSize }
      : { x: 0, y: 0, w: m.size.x, h: m.size.y };
    fit();
  }
  function fit() {
    if (!map) return;
    const base = Math.min(W / box.w, H / box.h);
    const s = base * zoom;
    let ox = (W - box.w * s) / 2 - box.x * s, oy = (H - box.h * s) / 2 - box.y * s;
    if (zoom > 1 && centre) {   // keep the centre of interest in the middle, within the drawn area
      ox = W / 2 - centre.x * s; oy = H / 2 - centre.y * s;
      ox = Math.min(-box.x * s, Math.max(W - (box.x + box.w) * s, ox));
      oy = Math.min(-box.y * s, Math.max(H - (box.y + box.h) * s, oy));
    }
    tf = { s, ox, oy };
  }
  function setZoom(z, at) { zoom = z || 1; centre = at || centre; fit(); }
  function resize() {
    const b = canvas.getBoundingClientRect();
    if (!b.width || !b.height) return;   // hidden: keep the current size
    k = window.devicePixelRatio || 1; W = b.width; H = b.height;
    canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
    fit();
    if (last) draw(last);
  }

  function draw(d) {
    last = d;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
    if (!map) { ctx.fillStyle = COL.label; ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Chưa có bản đồ từ robot', W / 2, H / 2); return; }
    ctx.imageSmoothingEnabled = false;
    const sPx = tf.s * map.pixelSize;
    ctx.drawImage(img, tf.ox, tf.oy, img.width * sPx, img.height * sPx);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.label; ctx.font = '600 13px system-ui';
    for (const l of segLabels) { const [x, y] = toPx(l.x, l.y); ctx.fillText(l.name, x, y); }
    const ch = d.charger || map.charger;
    if (ch) { const [x, y] = toPx(ch.x, ch.y); ctx.font = '18px system-ui'; ctx.fillText('⚡', x, y); }
    for (const [id, p] of Object.entries(d.points || {})) {
      const [x, y] = toPx(p.x, p.y), label = p.kind === 'table' ? (p.name || id).replace('Bàn ', '') : (p.name || id);
      ctx.font = (p.kind === 'table' ? '800 13px' : '700 12px') + ' system-ui';
      const w = Math.max(28, ctx.measureText(label).width + 14), h = 22;
      const dark = p.sel || p.kind !== 'table';   // selected = deep with mint text, like the floor plan
      ctx.fillStyle = dark ? COL.text : '#ffffff';
      ctx.strokeStyle = p.sel ? COL.text : p.kind === 'table' ? '#a9bcb5' : COL.text; ctx.lineWidth = p.sel ? 3 : 1.5;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, p.kind === 'table' ? 11 : 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = p.sel ? COL.mint : dark ? '#ffffff' : COL.text; ctx.fillText(label, x, y + 1);
      ctx.fillStyle = p.sel ? COL.mint : COL.text; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();   // the exact stop
    }
    for (const r of d.robots || []) {
      const [x, y] = toPx(r.x, r.y);
      // 40px disc in the robot's tone, deep 3px outline, red ring when blocked / waiting; heading tick past the rim.
      if (r.ring) { ctx.strokeStyle = COL.danger; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 26, 0, 7); ctx.stroke(); }
      ctx.strokeStyle = COL.text; ctx.lineWidth = 3;
      if (Number.isFinite(r.angle)) { const a = r.angle * Math.PI / 180; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 28 * Math.cos(a), y + 28 * Math.sin(a)); ctx.stroke(); }
      ctx.fillStyle = COL.tone[r.tone] || COL.tone.ok;
      ctx.beginPath(); ctx.arc(x, y, 20, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = COL.text; ctx.font = '900 13px system-ui'; ctx.fillText(r.id, x, y + 1);
    }
  }

  function toMap(clientX, clientY) {
    const b = canvas.getBoundingClientRect();
    const px = (clientX - b.left) * W / b.width, py = (clientY - b.top) * H / b.height;
    return { x: Math.round((px - tf.ox) / tf.s), y: Math.round((py - tf.oy) / tf.s) };
  }
  function hit(clientX, clientY) {
    if (!last) return null;
    const b = canvas.getBoundingClientRect();
    const px = (clientX - b.left) * W / b.width, py = (clientY - b.top) * H / b.height;
    let best = null, bd = 25;
    for (const [id, p] of Object.entries(last.points || {})) { const [x, y] = toPx(p.x, p.y), d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; best = id; } }
    return best;
  }
  if (opts.fit) new ResizeObserver(resize).observe(canvas);   // setting canvas.width/height doesn't change the CSS box: no loop
  canvas.addEventListener('click', e => { if (opts.onTap) { const { x, y } = toMap(e.clientX, e.clientY); opts.onTap(x, y, hit(e.clientX, e.clientY)); } });
  return { setMap, setZoom, draw, toMap, hit, resize, get map() { return map; } };
}

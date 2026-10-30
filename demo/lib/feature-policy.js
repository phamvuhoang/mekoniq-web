'use strict';
// MEKONIQ Serve S1 — restaurant feature policy (featurePolicyVersion 2): legacy migration, presets, readiness, robot capabilities.
// Pure and shared: Node requires it, setup.html loads it as a script (window.FeaturePolicy). Must not require site.js.
(function () {
  const FLAGS = ['callStaff', 'requestBill', 'guide', 'order', 'pay', 'busRobot'];
  const CANCEL = ['request', 'direct'];
  const PRESETS = { 'table-service': ['callStaff', 'requestBill'], 'counter-prepaid': [], buffet: ['callStaff'], custom: [] };   // flags turned on
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  // Deep clone as canonical v2. Only a pre-v2 site is converted; v2 is returned as is (Site.normalize validates).
  function migrate(site) {
    const s = JSON.parse(JSON.stringify(obj(site)));
    if (s.featurePolicyVersion === 2) return s;
    const f = obj(s.features), call = f.call === true;
    const legacy = { callStaff: call, requestBill: call, busRobot: true };   // what a pre-v2 site already did
    const features = { ...f };
    delete features.call;
    for (const k of FLAGS) features[k] = typeof f[k] === 'boolean' ? f[k] : !!legacy[k];
    s.features = features;
    if (!CANCEL.includes(s.customerCancel)) s.customerCancel = 'direct';
    if (!has(PRESETS, s.serviceProfile)) s.serviceProfile = 'custom';
    const P = obj(s.points), station = id => !!P[id] && P[id].kind === 'station';
    s.service = obj(s.service);
    if (!station(s.service.requestStation)) s.service.requestStation = Object.keys(P).find(station) || null;
    s.payment = obj(s.payment);
    if (s.payment.verification === undefined) s.payment.verification = 'staff';
    s.featurePolicyVersion = 2;
    return s;
  }

  // Fresh {serviceProfile, features, customerCancel} for a deliberate "Áp dụng gợi ý"; null for an unknown name.
  function preset(name) {
    if (!has(PRESETS, name)) return null;
    return { serviceProfile: name, features: Object.fromEntries(FLAGS.map(k => [k, PRESETS[name].includes(k)])), customerCancel: 'request' };
  }

  // Speed control needs driver support; unknown drivers are assumed unable.
  function capabilities(r) {
    return { speedControl: !!r && typeof r === 'object' && (!r.driver || r.driver === 'sim') };
  }

  // Config-only conditions (spec §5); robot position/state is checked when the request arrives.
  function readiness(site, key, routeMap) {
    const s = site && site.featurePolicyVersion === 2 ? site : migrate(site);
    const P = obj(s.points), kind = (id, k) => !!P[id] && k.includes(P[id].kind);
    const tables = Object.keys(P).filter(id => kind(id, ['table']));
    const reasons = [], need = (ok, code, text) => { if (!ok) reasons.push({ code, text }); };
    const table = () => need(tables.length > 0, 'no-table', 'Chưa có bàn');
    const station = () => need(kind(obj(s.service).requestStation, ['station']), 'no-request-station', 'Chưa chọn trạm nhận yêu cầu hoặc trạm đó không còn');
    if (key === 'callStaff' || key === 'requestBill') { table(); station(); }
    else if (key === 'guide') {
      const map = obj(routeMap || s.map), nodes = obj(map.nodes), edges = Array.isArray(map.edges) ? map.edges : [];
      // Reachable from a guest pickup point along open lanes, respecting one-way directions.
      // No route-module dependency: this policy also runs directly in setup.html.
      const reached = new Set(Object.keys(P).filter(id => kind(id, ['station', 'entrance']) && nodes[id]));
      const queue = [...reached];
      for (let i = 0; i < queue.length; i++) for (const e of edges) {
        if (!e || e.closed) continue;
        const to = e.a === queue[i] ? e.b : !e.oneway && e.b === queue[i] ? e.a : null;
        if (to && nodes[to] && !reached.has(to)) { reached.add(to); queue.push(to); }
      }
      const reach = (r, p) => r.driver === 'valetudo' ? !!obj(obj(r.valetudo).points)[p]
        : (!r.driver || r.driver === 'sim') && reached.has(p);
      table();
      need(Object.keys(P).some(id => kind(id, ['station', 'entrance'])), 'no-start', 'Chưa có trạm hoặc lối vào để đón khách');
      need((Array.isArray(s.robots) ? s.robots : []).some(r => r && tables.some(t => reach(r, t))), 'no-robot-route', 'Chưa có robot đi được tới bàn');
    } else if (key === 'order') {
      const m = obj(s.menu), cats = Array.isArray(m.cats) ? m.cats : [], items = Array.isArray(m.items) ? m.items : [];
      need(items.length > 0, 'no-item', 'Thực đơn chưa có món');
      need(items.every(it => it && Number.isInteger(it.price) && it.price >= 0), 'bad-price', 'Có món giá không hợp lệ');
      need(items.every(it => it && cats.some(c => c && c.id === it.cat)), 'bad-category', 'Có món thuộc danh mục không tồn tại');
      need(cats.every(c => c && kind(c.station, ['station'])), 'bad-station', 'Có danh mục chưa có trạm làm hợp lệ');
    } else if (key === 'pay') {
      const pay = obj(s.payment);
      station();
      need(['bank', 'account', 'name'].every(k => String(pay[k] || '').trim()), 'no-bank', 'Thiếu ngân hàng, số tài khoản hoặc tên chủ tài khoản');
      need(pay.verification === 'staff', 'no-staff-verification', 'Thanh toán phải do nhân viên xác nhận');
    } else if (key === 'busRobot') {
      table();
      need(kind(s.dishPoint, ['dish']), 'no-dish', 'Chưa có khu rửa chén hợp lệ');
    } else need(false, 'unknown', 'Tính năng không xác định');
    const enabled = FLAGS.includes(key) && obj(s.features)[key] === true, ready = !reasons.length;
    return { enabled, ready, effective: enabled && ready, reasons };
  }

  const api = { migrate, preset, capabilities, readiness };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FeaturePolicy = api;
})();

'use strict';
// MEKONIQ Serve S1 — staff-verified bills (spec §7). Pure state logic: no MQTT, DOM or UI state; the orchestrator
// turns results into session events, alerts and logs. Also loaded by the web demo's CommonJS loader: no Node-only APIs.
//
//   prepared ── billClaim ──> claimed ── billSettle ──> settled ── billClose ──> closed
//       └──────────────── billSettle ────────────────┘
//   prepared/claimed ── billVoid (reason) ──> void

const KEEP = 30 * 24 * 3600 * 1000;   // closed/void bills and closed orders, counted from closedAt/voidAt
const OPEN = ['prepared', 'claimed', 'settled'];
const allowed = {
  billClaim: ['prepared'],
  billSettle: ['prepared', 'claimed'],
  billClose: ['settled'],
  billVoid: ['prepared', 'claimed'],
};
const METHODS = ['transfer', 'cash', 'card', 'zero'];
// Business fields only: a retry from another session/socket with the same requestId must match.
const FIELDS = ['type', 'table', 'orderIds', 'total', 'note', 'bill', 'rev', 'method', 'reason', 'by'];
const TEXT = {
  'not-found': 'Không tìm thấy phiếu', stale: 'Phiếu đã thay đổi, tải lại', status: 'Trạng thái phiếu không cho phép thao tác này',
  'orders-changed': 'Đơn của bàn đã thay đổi, kiểm tra lại', 'open-bill': 'Bàn đang có phiếu tính tiền chưa đóng',
  'note-required': 'Cần ghi chú khi tổng khác gợi ý hoặc không có đơn robot', method: 'Phương thức không khớp tổng tiền',
  zero: 'Phiếu 0 đ do nhân viên chốt tại trạm', busy: 'Bàn còn đơn mới hoặc món đang giao',
  'request-conflict': 'Mã yêu cầu đã dùng cho lệnh khác',
};
const fail = (code, text) => ({ ok: false, code, text: text || TEXT[code] });
const isOpen = o => o.status !== 'closed';   // legacy 'paid-claimed' stays open until a bill closes it
const str = v => String(v == null ? '' : v).trim();

// Adds billing state to a persisted st. Never touches orders (no auto-settle of legacy 'paid-claimed').
function init(st) {
  st.billingVersion = 1;
  if (!Array.isArray(st.bills)) st.bills = [];
  st.billSeq = Math.max(Number(st.billSeq) || 0, ...st.bills.map(b => Number(b.id) || 0));
}

// -> {ok:true, bill, duplicate} | {ok:false, code, text}. Everything is validated before st is touched.
function handle(st, site, cmd, now) {
  const requestId = cmd && typeof cmd.requestId === 'string' ? cmd.requestId.trim() : '';
  if (!requestId || requestId.length > 100) return fail('invalid', 'Mã yêu cầu không hợp lệ');
  const fp = JSON.stringify(FIELDS.map(k => cmd[k]));
  for (const b of st.bills) for (const r of b.receipts || []) if (r.requestId === requestId)
    return r.fp === fp ? { ok: true, bill: b, duplicate: true } : fail('request-conflict');
  const receipt = { requestId, fp, type: cmd.type, at: now };
  if (cmd.type === 'billPrepare') return prepare(st, site, cmd, now, receipt);
  if (!allowed[cmd.type]) return fail('invalid', 'Lệnh không hợp lệ');

  const bill = st.bills.find(b => b.id === cmd.bill);
  if (!bill) return fail('not-found');
  if (cmd.rev !== bill.rev) return fail('stale');
  if (!allowed[cmd.type].includes(bill.status)) return fail('status');
  const by = cmd.by;
  if (cmd.type === 'billClaim') {
    if (bill.total === 0) return fail('zero');
    Object.assign(bill, { status: 'claimed', claimedAt: now });
    if (by) bill.claimedBy = by;   // guest claims usually carry no name
  } else if (cmd.type === 'billSettle') {
    if (!METHODS.includes(cmd.method)) return fail('invalid', 'Phương thức không hợp lệ');
    if ((cmd.method === 'zero') !== (bill.total === 0)) return fail('method');
    Object.assign(bill, { status: 'settled', settledAt: now, settledBy: by, method: cmd.method });
  } else if (cmd.type === 'billVoid') {
    const reason = str(cmd.reason);
    if (!reason || reason.length > 200) return fail('invalid', 'Cần lý do vô hiệu hóa (tối đa 200 ký tự)');
    Object.assign(bill, { status: 'void', voidAt: now, voidBy: by, voidReason: reason });
  } else {   // billClose
    const late = st.orders.some(o => o.table === bill.table && isOpen(o) && !bill.orderIds.includes(o.id));
    // A robot parked on standby at the table (the guest's pay screen) carries nothing for it: only real stops block.
    const heading = st.missions.some(m => (m.status === 'queued' || m.status === 'active') &&
      (m.stops || []).some(s => s.p === bill.table && s.a !== 'standby' && (s.status === 'pending' || s.status === 'active')));
    if (late || heading) return fail('busy');
    for (const o of st.orders) if (bill.orderIds.includes(o.id)) Object.assign(o, { status: 'closed', closedAt: now, closedBy: by, bill: bill.id });
    Object.assign(bill, { status: 'closed', closedAt: now, closedBy: by });
  }
  bill.rev++;
  // ponytail: no 20-receipt trim — a bill takes at most 4 transitions, so spec §7.2's cap can't be reached.
  (bill.receipts ||= []).push(receipt);
  return { ok: true, bill, duplicate: false };
}

// Staff verified the amount at the restaurant's own source; robot order totals are only the suggestion.
function prepare(st, site, cmd, now, receipt) {
  const { table, orderIds, total } = cmd;
  const point = site.points && site.points[table];
  if (!point || point.kind !== 'table') return fail('invalid', 'Bàn không hợp lệ');
  if (!Number.isSafeInteger(total) || total < 0) return fail('invalid', 'Tổng tiền phải là số nguyên VND ≥ 0');
  if (!Array.isArray(orderIds)) return fail('invalid', 'Danh sách đơn không hợp lệ');
  const note = str(cmd.note);
  if (note.length > 200) return fail('invalid', 'Ghi chú tối đa 200 ký tự');
  if (st.bills.some(b => b.table === table && OPEN.includes(b.status))) return fail('open-bill');
  const open = st.orders.filter(o => o.table === table && isOpen(o));
  if (orderIds.length !== open.length || new Set(orderIds).size !== open.length || !open.every(o => orderIds.includes(o.id))) return fail('orders-changed');
  const menu = new Map(((site.menu && site.menu.items) || []).map(i => [i.id, i]));
  const orders = open.map(o => ({ id: o.id, total: Number(o.total) || 0, items: (o.items || []).map(x => {
    const it = menu.get(x.id) || { vi: x.id, en: x.id };   // removed from the menu since: label with the id
    return { id: x.id, vi: it.vi, en: it.en, qty: x.qty, price: x.price };
  }) }));
  const suggested = orders.reduce((a, o) => a + o.total, 0);
  if (!note && (total !== suggested || !orders.length)) return fail('note-required');
  const bill = { id: ++st.billSeq, table, rev: 1, status: 'prepared', source: 'staff-verified', total, suggested, note,
    orderIds: open.map(o => o.id), orders, preparedBy: cmd.by, preparedAt: now, requestId: receipt.requestId, receipts: [receipt] };
  st.bills.push(bill);
  return { ok: true, bill, duplicate: false };
}

// Drops closed/void bills and closed orders 30 days after closing. Open records stay regardless of age.
function cleanup(st, now) {
  const old = t => now - t >= KEEP;
  st.bills = st.bills.filter(b => !(b.status === 'closed' ? old(b.closedAt) : b.status === 'void' && old(b.voidAt)));
  st.orders = st.orders.filter(o => !(o.status === 'closed' && old(o.closedAt)));
}

module.exports = { init, handle, cleanup };

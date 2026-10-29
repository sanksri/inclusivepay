'use strict';

// ===========================================================================
// InclusivePay dashboard: AG Grid with custom widgets, live updates over SSE.
// Same origin as server.js: open http://localhost:3001/dashboard.html
// ===========================================================================

const $ = (id) => document.getElementById(id);
const srStatus = $('srStatus');

const state = { payments: [], invoices: [], balance: null, health: {}, feed: [] };
let payApi = null;
let invApi = null;

const money = (n) => `$${Number(n).toFixed(2)}`;
const amountValue = (s) => parseFloat(String(s).replace('$', '')) || 0;
const stamp = (r) => r.ts || Date.parse(r.date) || 0;
const shortDate = (s) => String(s || '').replace(/:\d\d(?=\s?[AaPp][Mm]|$)/, '');
const niceDate = (r) => {
  const t = stamp(r);
  return t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : shortDate(r.date);
};

// ---------------------------------------------------------------------------
// Status wording. Always an icon AND words, never colour alone.
// ---------------------------------------------------------------------------
const STATUS = {
  SUCCESS: { label: 'Completed', icon: '✓', tone: 'ok' },
  PAID: { label: 'Paid', icon: '✓', tone: 'ok' },
  MARKED_AS_PAID: { label: 'Paid', icon: '✓', tone: 'ok' },
  PENDING: { label: 'Pending', icon: '⏳', tone: 'warn' },
  PROCESSING: { label: 'Processing', icon: '⏳', tone: 'warn' },
  PAYMENT_PENDING: { label: 'Payment pending', icon: '⏳', tone: 'warn' },
  PARTIALLY_PAID: { label: 'Partly paid', icon: '◐', tone: 'warn' },
  SENT: { label: 'Awaiting payment', icon: '✉', tone: 'info' },
  UNPAID: { label: 'Awaiting payment', icon: '✉', tone: 'info' },
  SCHEDULED: { label: 'Scheduled', icon: '✉', tone: 'info' },
  ONHOLD: { label: 'On hold', icon: '!', tone: 'warn' },
  UNCLAIMED: { label: 'Unclaimed', icon: '!', tone: 'warn' },
  DENIED: { label: 'Denied', icon: '✕', tone: 'bad' },
  FAILED: { label: 'Failed', icon: '✕', tone: 'bad' },
  BLOCKED: { label: 'Blocked', icon: '✕', tone: 'bad' },
  RETURNED: { label: 'Returned', icon: '↩', tone: 'bad' },
  REFUNDED: { label: 'Refunded', icon: '↩', tone: 'bad' },
  CANCELED: { label: 'Cancelled', icon: '✕', tone: 'bad' },
  CANCELLED: { label: 'Cancelled', icon: '✕', tone: 'bad' },
};
const statusInfo = (s) => STATUS[String(s).toUpperCase()] || { label: String(s), icon: '•', tone: 'info' };
const PENDING_PAYOUT = ['PENDING', 'PROCESSING'];
const OPEN_INVOICE = ['SENT', 'UNPAID', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'SCHEDULED'];
const PAID_INVOICE = ['PAID', 'MARKED_AS_PAID'];
const FAILED_PAYOUT = ['DENIED', 'FAILED', 'BLOCKED', 'RETURNED', 'REFUNDED', 'CANCELED'];

// ---------------------------------------------------------------------------
// Speaking / announcing
// ---------------------------------------------------------------------------
function ttsOn() {
  try { return localStorage.getItem('ipay-tts') !== 'off'; } catch (_) { return true; }
}
function announce(text, { speak = false } = {}) {
  srStatus.textContent = '';
  setTimeout(() => { srStatus.textContent = text; }, 20);
  if (speak && ttsOn() && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}
function rowSummary(kind, d) {
  const st = statusInfo(d.status).label.toLowerCase();
  return kind === 'invoice'
    ? `Invoice to ${d.recipient}, ${d.amount}, ${st}, sent ${shortDate(d.date)}.`
    : `Payment to ${d.recipient}, ${d.amount}, ${st}, on ${shortDate(d.date)}.`;
}

// ---------------------------------------------------------------------------
// Custom AG Grid widgets
// ---------------------------------------------------------------------------

// 1. Status chip (cell renderer)
class StatusRenderer {
  init(p) { this.el = document.createElement('span'); this.set(p); }
  set(p) {
    this.el.textContent = '';
    if (!p.value) return;
    const info = statusInfo(p.value);
    this.el.className = `chip chip-${info.tone}`;
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = info.icon;
    this.el.append(icon, document.createTextNode(info.label));
  }
  getGui() { return this.el; }
  refresh(p) { this.set(p); return true; }
}

// 2. Amount with an explicit sign: "−$2.00" going out, "+$20.00" coming in
class AmountRenderer {
  init(p) { this.el = document.createElement('span'); this.set(p); }
  set(p) {
    this.el.className = 'amount';
    this.el.textContent = p.value ? `${p.sign === '+' ? '+' : '−'}${p.value}` : '';
  }
  getGui() { return this.el; }
  refresh(p) { this.set(p); return true; }
}

// 3. Row actions: read the row aloud, and open the invoice on PayPal
class ActionRenderer {
  init(p) {
    this.el = document.createElement('span');
    this.el.className = 'actions';
    if (p.node.rowPinned || !p.data) return;
    const summary = rowSummary(p.kind, p.data);
    const read = document.createElement('button');
    read.type = 'button';
    read.className = 'mini';
    read.textContent = '🔊 Read';
    read.setAttribute('aria-label', `Read aloud: ${summary}`);
    read.addEventListener('click', () => announce(summary, { speak: true }));
    this.el.appendChild(read);
    if (p.kind === 'invoice' && p.data.link) {
      const a = document.createElement('a');
      a.className = 'mini';
      a.href = p.data.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open ↗';
      a.setAttribute('aria-label', `Open the invoice for ${p.data.recipient} on PayPal (opens in a new tab)`);
      this.el.appendChild(a);
    }
  }
  getGui() { return this.el; }
  refresh() { return false; }
}

// 4. Status filter: a labelled checkbox group built from the statuses actually present
class StatusFilter {
  init(p) {
    this.p = p;
    this.selected = new Set();
    this.el = document.createElement('fieldset');
    this.el.className = 'status-filter';
    this.render();
  }
  values() {
    const seen = new Set();
    this.p.api.forEachNode((n) => { if (n.data && n.data.status) seen.add(n.data.status); });
    return [...seen].sort();
  }
  render() {
    this.el.textContent = '';
    const legend = document.createElement('legend');
    legend.textContent = 'Show statuses';
    this.el.appendChild(legend);
    const values = this.values();
    if (!values.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'Nothing to filter yet.';
      this.el.appendChild(none);
    }
    values.forEach((v) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = this.selected.has(v);
      box.addEventListener('change', () => {
        if (box.checked) this.selected.add(v); else this.selected.delete(v);
        this.p.filterChangedCallback();
      });
      label.append(box, document.createTextNode(statusInfo(v).label));
      this.el.appendChild(label);
    });
  }
  afterGuiAttached() { this.render(); const first = this.el.querySelector('input'); if (first) first.focus(); }
  getGui() { return this.el; }
  isFilterActive() { return this.selected.size > 0; }
  doesFilterPass(params) { return this.selected.has(params.data.status); }
  getModel() { return this.selected.size ? { values: [...this.selected] } : null; }
  setModel(m) { this.selected = new Set(m ? m.values : []); if (this.el) this.render(); }
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------
const SIZES = { normal: { row: 44, header: 46 }, large: { row: 54, header: 56 }, xlarge: { row: 64, header: 66 } };
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function gridOptions(kind) {
  const size = SIZES[document.body.dataset.size] || SIZES.normal;
  const sign = kind === 'invoice' ? '+' : '−';
  return {
    columnDefs: [
      { field: 'recipient', headerName: kind === 'invoice' ? 'From' : 'To', flex: 1, minWidth: 100, tooltipField: 'id' },
      {
        field: 'amount', headerName: 'Amount', width: 104, type: 'rightAligned',
        cellRenderer: AmountRenderer, cellRendererParams: { sign },
        comparator: (a, b) => amountValue(a) - amountValue(b),
      },
      {
        field: 'status', headerName: 'Status', width: kind === 'invoice' ? 168 : 138,
        cellRenderer: StatusRenderer, filter: StatusFilter,
        enableCellChangeFlash: !reducedMotion,
        comparator: (a, b) => statusInfo(a).label.localeCompare(statusInfo(b).label),
      },
      {
        headerName: 'Date', width: 134,
        valueGetter: (p) => (p.data ? stamp(p.data) : 0),
        valueFormatter: (p) => (p.data ? niceDate(p.data) : ''),
        filter: false,
      },
      {
        headerName: 'Listen', colId: 'actions', width: kind === 'invoice' ? 180 : 96, sortable: false, filter: false,
        cellRenderer: ActionRenderer, cellRendererParams: { kind },
      },
    ],
    defaultColDef: { sortable: true, filter: true, resizable: false },
    getRowId: (p) => p.data.id,
    rowData: [],
    rowHeight: size.row,
    headerHeight: size.header,
    rowSelection: 'single',
    pagination: true,
    paginationPageSize: 6,
    paginationPageSizeSelector: false,
    ensureDomOrder: true,                 // DOM order = visual order, for screen readers
    suppressColumnVirtualisation: true,
    tooltipShowDelay: 400,
    overlayNoRowsTemplate: kind === 'invoice'
      ? '<span>No invoices yet. Say “Request 20 dollars from John”.</span>'
      : '<span>No payments yet. Say “Send 5 dollars to John”.</span>',
    onCellKeyDown: (e) => {
      if (e.event && e.event.key && e.event.key.toLowerCase() === 'r' && e.data && !e.event.ctrlKey && !e.event.metaKey && !e.event.altKey) {
        announce(rowSummary(kind, e.data), { speak: true });
      }
    },
  };
}

function buildGrids() {
  if (payApi) payApi.destroy();
  if (invApi) invApi.destroy();
  $('payGrid').textContent = '';
  $('invGrid').textContent = '';
  if (typeof agGrid === 'undefined') {
    $('payGrid').textContent = 'The table library could not load. Check your internet connection.';
    return;
  }
  payApi = agGrid.createGrid($('payGrid'), gridOptions('payment'));
  invApi = agGrid.createGrid($('invGrid'), gridOptions('invoice'));
  payApi.setGridOption('quickFilterText', $('payFilter').value);
  invApi.setGridOption('quickFilterText', $('invFilter').value);
  renderGrids();
}

function renderGrids() {
  if (payApi) {
    payApi.setGridOption('rowData', state.payments);
    const total = state.payments.filter((t) => !FAILED_PAYOUT.includes(t.status)).reduce((s, t) => s + amountValue(t.amount), 0);
    payApi.setGridOption('pinnedBottomRowData', state.payments.length ? [{ id: 'total', recipient: 'Total', amount: money(total) }] : []);
  }
  if (invApi) {
    invApi.setGridOption('rowData', state.invoices);
    const total = state.invoices.filter((i) => !['CANCELLED', 'REFUNDED'].includes(i.status)).reduce((s, i) => s + amountValue(i.amount), 0);
    invApi.setGridOption('pinnedBottomRowData', state.invoices.length ? [{ id: 'total', recipient: 'Total', amount: money(total) }] : []);
  }
}

// ---------------------------------------------------------------------------
// KPIs, bars, feed
// ---------------------------------------------------------------------------
function renderKpis() {
  const ok = state.payments.filter((t) => !FAILED_PAYOUT.includes(t.status));
  const sent = ok.reduce((s, t) => s + amountValue(t.amount), 0);
  const pending = state.payments.filter((t) => PENDING_PAYOUT.includes(t.status)).length;
  const open = state.invoices.filter((i) => OPEN_INVOICE.includes(i.status));
  const openTotal = open.reduce((s, i) => s + amountValue(i.amount), 0);
  const collected = state.invoices.filter((i) => PAID_INVOICE.includes(i.status)).reduce((s, i) => s + amountValue(i.amount), 0);

  $('kpiBalance').textContent = state.balance ? state.balance.balance : '…';
  $('kpiBalanceSub').textContent = state.balance ? (state.balance.source === 'paypal' ? 'From PayPal sandbox' : 'Estimated (demo)') : '';
  $('kpiSent').textContent = money(sent);
  $('kpiSentSub').textContent = `${ok.length} payment${ok.length === 1 ? '' : 's'}`;
  $('kpiPending').textContent = String(pending);
  $('kpiPendingSub').textContent = pending ? 'Updating live' : 'Nothing waiting';
  $('kpiInvoices').textContent = money(openTotal);
  $('kpiInvoicesSub').textContent = `${open.length} open, ${money(collected)} collected`;
}

function renderBars() {
  const list = $('bars');
  list.textContent = '';
  const byWho = new Map();
  state.payments.filter((t) => !FAILED_PAYOUT.includes(t.status)).forEach((t) => {
    const cur = byWho.get(t.recipient) || { total: 0, n: 0 };
    cur.total += amountValue(t.amount); cur.n += 1;
    byWho.set(t.recipient, cur);
  });
  const rows = [...byWho.entries()].sort((a, b) => b[1].total - a[1].total);
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No spending yet.';
    list.appendChild(li);
    return;
  }
  const max = rows[0][1].total || 1;
  rows.forEach(([who, v]) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = who;
    const track = document.createElement('span'); track.className = 'track'; track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span'); fill.className = 'fill'; fill.style.width = `${Math.max(3, (v.total / max) * 100)}%`;
    track.appendChild(fill);
    const val = document.createElement('span'); val.className = 'val'; val.textContent = `${money(v.total)} (${v.n})`;
    li.append(name, track, val);
    list.appendChild(li);
  });
}

const SOURCE = { webhook: 'PayPal webhook', poll: 'Status check', app: 'App', simulated: 'Simulated' };
function feedItemEl(item) {
  const li = document.createElement('li');
  const src = document.createElement('span');
  src.className = `src src-${SOURCE[item.source] ? item.source : 'app'}`;
  src.textContent = SOURCE[item.source] || item.source;
  const text = document.createElement('span');
  text.textContent = item.text;
  const time = document.createElement('time');
  time.dateTime = item.at;
  time.textContent = new Date(item.at).toLocaleTimeString();
  li.append(src, text, time);
  return li;
}
function renderFeed() {
  const list = $('feed');
  list.textContent = '';
  if (!state.feed.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Send a payment or request money and updates appear here.';
    list.appendChild(li);
    return;
  }
  state.feed.forEach((item) => list.appendChild(feedItemEl(item)));
}

function renderAll() {
  renderKpis(); renderBars(); renderGrids(); renderFeed();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function getJson(path) {
  try { const r = await fetch(path); return r.ok ? await r.json() : null; } catch (_) { return null; }
}

let pollTimer = null;
async function load() {
  const [tx, inv, bal, fd] = await Promise.all([getJson('/transactions'), getJson('/invoices'), getJson('/balance'), getJson('/feed')]);
  if (tx) state.payments = tx.transactions || [];
  if (inv) state.invoices = inv.invoices || [];
  if (bal) state.balance = bal;
  if (fd) state.feed = fd.feed || [];
  renderAll();

  // Safety net: while something is unsettled, ask again (fast without webhooks, slow with them).
  clearTimeout(pollTimer);
  const waiting = state.payments.some((t) => PENDING_PAYOUT.includes(t.status)) || state.invoices.some((i) => OPEN_INVOICE.includes(i.status));
  if (waiting) pollTimer = setTimeout(() => { if (!document.hidden) load(); else pollTimer = setTimeout(load, 5000); }, state.health.webhooks ? 30000 : 5000);
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------
function setLive(on, text) {
  const b = $('liveBadge');
  b.textContent = text;
  b.className = `live ${on ? 'on' : 'off'}`;
}

let reloadSoon = null;
function connectLive() {
  if (typeof EventSource === 'undefined') { setLive(false, 'Live updates unavailable, refreshing every few seconds'); return; }
  const es = new EventSource('/events');
  es.onopen = () => setLive(true, '● Live');
  es.onerror = () => setLive(false, '○ Reconnecting…');
  es.addEventListener('update', (e) => {
    let msg = {};
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'feed' && msg.item) {
      state.feed = [msg.item, ...state.feed.filter((f) => f.id !== msg.item.id)].slice(0, 50);
      renderFeed();
      announce(msg.item.text);
    }
    clearTimeout(reloadSoon);
    reloadSoon = setTimeout(load, 150);
  });
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function applyPrefs(theme, size) {
  document.body.dataset.theme = theme;
  document.body.dataset.size = size;
  $('themeSel').value = theme;
  $('sizeSel').value = size;
}
function savedPref(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function savePref(key, v) { try { localStorage.setItem(key, v); } catch (_) { /* ignore */ } }

function initPrefs() {
  const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
  let theme = savedPref('ipay-dash-theme');
  if (!['midnight', 'daylight', 'contrast'].includes(theme)) theme = mq('(prefers-contrast: more)') ? 'contrast' : mq('(prefers-color-scheme: light)') ? 'daylight' : 'midnight';
  let size = savedPref('ipay-dash-size');
  if (!['normal', 'large', 'xlarge'].includes(size)) size = 'normal';
  applyPrefs(theme, size);
  $('themeSel').addEventListener('change', (e) => { document.body.dataset.theme = e.target.value; savePref('ipay-dash-theme', e.target.value); announce(`${e.target.selectedOptions[0].text} theme`); });
  $('sizeSel').addEventListener('change', (e) => { document.body.dataset.size = e.target.value; savePref('ipay-dash-size', e.target.value); buildGrids(); announce(`${e.target.selectedOptions[0].text} text size`); });
}

function wireToolbar(prefix, getApi, kind) {
  $(`${prefix}Filter`).addEventListener('input', (e) => { const api = getApi(); if (api) api.setGridOption('quickFilterText', e.target.value); });
  $(`${prefix}Csv`).addEventListener('click', () => {
    const api = getApi();
    if (api) api.exportDataAsCsv({ fileName: `inclusivepay-${kind}s.csv`, columnKeys: ['recipient', 'amount', 'status'] });
  });
  $(`${prefix}Read`).addEventListener('click', () => {
    const api = getApi();
    const row = api && api.getSelectedRows()[0];
    announce(row ? rowSummary(kind, row) : 'Select a row first, then press this button.', { speak: true });
  });
}

// PDF statement: built in the browser with jsPDF. Uses words, never colour or symbols alone.
function downloadStatement() {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDF) { announce('The PDF tool did not load. Check your connection and try again.', { speak: true }); return; }
  const doc = new jsPDF();
  const when = new Date();
  doc.setProperties({ title: 'InclusivePay statement', author: 'InclusivePay' });
  doc.setFontSize(18);
  doc.text('InclusivePay statement', 14, 18);
  doc.setFontSize(10);
  doc.text(`Created ${when.toLocaleString()}  |  PayPal sandbox (test money)`, 14, 25);
  if (state.balance && state.balance.balance) doc.text(`Balance: ${state.balance.balance} (${state.balance.source === 'paypal' ? 'from PayPal sandbox' : 'demo estimate'})`, 14, 31);

  const rows = (list) => list.map((r) => [r.recipient, money(amountValue(r.amount)), statusInfo(r.status).label, niceDate(r)]);
  const sum = (list) => list.reduce((t, r) => t + amountValue(r.amount), 0);
  let y = 38;
  const section = (title, head, list) => {
    doc.setFontSize(13);
    doc.text(title, 14, y);
    doc.autoTable({
      startY: y + 3,
      head: [head],
      body: list.length ? rows(list) : [['Nothing yet', '', '', '']],
      foot: list.length ? [['Total', money(sum(list)), '', '']] : undefined,
      styles: { fontSize: 10 },
      headStyles: { fillColor: [0, 103, 122] },
      footStyles: { fillColor: [232, 238, 245], textColor: 20 },
      columnStyles: { 1: { halign: 'right' } },
    });
    y = doc.lastAutoTable.finalY + 12;
  };
  section('Money out: payments', ['To', 'Amount', 'Status', 'Date'], state.payments);
  section('Money in: invoices', ['From', 'Amount', 'Status', 'Date'], state.invoices);
  doc.save(`inclusivepay-statement-${when.toISOString().slice(0, 10)}.pdf`);
  announce('Statement downloaded as a PDF.', { speak: true });
}

async function simulate(type) {
  try {
    const r = await fetch('/dev/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) announce(data.error || 'The simulation failed.');
  } catch (_) { announce('Cannot reach the server.'); }
}

document.addEventListener('DOMContentLoaded', async () => {
  initPrefs();
  buildGrids();
  $('pdfBtn').addEventListener('click', downloadStatement);
  wireToolbar('pay', () => payApi, 'payment');
  wireToolbar('inv', () => invApi, 'invoice');
  $('simPayout').addEventListener('click', () => simulate('payout_success'));
  $('simInvoice').addEventListener('click', () => simulate('invoice_paid'));

  state.health = (await getJson('/health')) || {};
  $('modeLine').textContent = state.health.webhooks
    ? 'Status changes arrive from PayPal webhooks (verified with PayPal).'
    : 'Webhooks are off, so statuses are checked with PayPal every few seconds.';
  if (state.health.simulator) $('demoBox').hidden = false;

  await load();
  connectLive();
});

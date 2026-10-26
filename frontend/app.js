'use strict';

// ===========================================================================
// InclusivePay front end
// Everything is same-origin: open http://localhost:3001 (served by server.js).
// ===========================================================================

const $ = (id) => document.getElementById(id);
const voiceBtn = $('voiceBtnModern');
const outputEl = $('outputModern');
const srStatus = $('srStatus');

let gridApi = null;
let busy = false;                       // one payment flow at a time
let aiEnabled = false;                  // set from /health
let chatHistory = [];                   // recent text turns sent to the AI agent
let lastChatAt = 0;
let directory = {                       // replaced by /directory on load
  contacts: ['john', 'steve'],
  bills: ['electricity', 'internet', 'water', 'gas', 'phone'].map((k) => ({ key: k, name: `${cap(k)} Bill`, due: null })),
};

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function fmt(n) { return `$${Number(n).toFixed(2)}`; }

// ---------------------------------------------------------------------------
// Spoken output (can be switched off for screen-reader users)
// ---------------------------------------------------------------------------
let ttsOn = true;
try { ttsOn = localStorage.getItem('ipay-tts') !== 'off'; } catch (_) { /* storage blocked */ }

function renderTtsToggle() {
  const btn = $('ttsToggle');
  btn.setAttribute('aria-pressed', String(ttsOn));
  btn.setAttribute('aria-label', ttsOn ? 'Spoken replies on' : 'Spoken replies off');
  btn.textContent = ttsOn ? '🔊' : '🔇';
}

function announceQuiet(message) {
  srStatus.textContent = '';
  setTimeout(() => { srStatus.textContent = message; }, 20);
}

// Speaks and resolves when finished, so we never listen to ourselves.
function speak(message) {
  if (!ttsOn) {
    srStatus.textContent = '';            // let a screen reader announce it instead
    setTimeout(() => { srStatus.textContent = message; }, 20);
    return Promise.resolve();
  }
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(message);
    u.rate = 1.0;
    const began = Date.now();
    let done = false;
    let started = false;
    let idle = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (Date.now() - began > 8000) console.warn(`[InclusivePay] speech took ${Date.now() - began} ms: "${message.slice(0, 40)}"`);
      resolve();
    };
    // Chrome sometimes never fires "end" (network voices especially). So also watch the synthesiser's
    // own state, and cap the wait by how long the sentence should take instead of a flat 15 seconds.
    const timer = setTimeout(finish, Math.min(15000, 2500 + message.split(/\s+/).length * 450));
    const poll = setInterval(() => {
      if (started && !synth.speaking && !synth.pending) { if (++idle >= 2) finish(); } else idle = 0;
    }, 200);
    u.onstart = () => { started = true; };
    u.onend = u.onerror = finish;
    synth.speak(u);
  });
}

// ---------------------------------------------------------------------------
// Accessible modal (focus trap, Enter/Escape, optional input)
// ---------------------------------------------------------------------------
let activeModal = null;

function openModal({ title, message, input = false, inputType = 'text', inputMode, defaultValue = '', okLabel = 'OK', cancelLabel = 'Cancel', cancellable = false }) {
  if (activeModal) activeModal.close(null);

  const modal = $('customModal');
  const okBtn = $('modalOkBtn');
  const cancelBtn = $('modalCancelBtn');
  const body = $('modalBody');
  const previouslyFocused = document.activeElement;

  $('modalTitle').textContent = title;
  body.textContent = '';
  const msg = document.createElement('div');
  msg.textContent = message;
  body.appendChild(msg);

  let inputEl = null;
  if (input) {
    inputEl = document.createElement('input');
    inputEl.type = inputType;
    if (inputMode) inputEl.inputMode = inputMode;
    inputEl.value = defaultValue;
    inputEl.autocomplete = 'off';
    inputEl.setAttribute('aria-label', message);
    body.appendChild(inputEl);
  }

  okBtn.textContent = okLabel;
  cancelBtn.textContent = cancelLabel;
  const showCancel = input || cancellable;
  cancelBtn.style.display = showCancel ? 'block' : 'none';
  modal.style.display = 'flex';

  let resolveFn;
  const promise = new Promise((res) => { resolveFn = res; });
  let closed = false;

  function close(result) {
    if (closed) return;
    closed = true;
    modal.style.display = 'none';
    okBtn.onclick = cancelBtn.onclick = null;
    document.removeEventListener('keydown', onKey, true);
    activeModal = null;
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    resolveFn(result);
  }

  const accept = () => close(input ? inputEl.value : true);
  const dismiss = () => close(input ? null : (cancellable ? false : true));

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
    else if (e.key === 'Enter' && document.activeElement === inputEl) { e.preventDefault(); accept(); }
    else if (e.key === 'Tab') {
      const focusables = [inputEl, okBtn, showCancel ? cancelBtn : null].filter(Boolean);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  okBtn.onclick = accept;
  cancelBtn.onclick = dismiss;

  (inputEl || okBtn).focus();                         // immediately, so a fast Enter works
  setTimeout(() => (inputEl || okBtn).focus(), 30);   // and again once the overlay has rendered
  activeModal = { close };
  return { promise, close };
}

// ---------------------------------------------------------------------------
// Voice input
// ---------------------------------------------------------------------------
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

// A short rising beep that means "the microphone is open now, speak". Without it people start talking
// while the browser is still opening the mic, and the first words are lost.
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch (_) { /* no audio available: the on-screen cue still shows */ }
}

// onReady runs when the microphone is really capturing. Resolves with the best transcript, or null for
// silence/errors; alts() gives the recogniser's other guesses (they often contain the right word).
function listenOnce(onReady) {
  if (!SpeechRecognitionAPI) return { promise: Promise.resolve(null), abort() {}, alts: () => [], unsupported: true };
  const rec = new SpeechRecognitionAPI();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  let done = false;
  let alternatives = [];
  let resolveFn;
  const finish = (v) => { if (!done) { done = true; resolveFn(v); } };
  const promise = new Promise((res) => { resolveFn = res; });
  rec.onaudiostart = () => { if (onReady) onReady(); };
  rec.onresult = (e) => {
    const r = e.results[0];
    alternatives = Array.from(r).slice(1).map((x) => String(x.transcript || '').trim()).filter(Boolean);
    finish(r[0].transcript.trim());
  };
  rec.onerror = () => finish(null);
  rec.onend = () => finish(null);
  try { rec.start(); } catch (_) { finish(null); }
  return { promise, alts: () => alternatives, abort() { try { rec.abort(); } catch (_) { /* ignore */ } finish(null); } };
}

// ---------------------------------------------------------------------------
// Parsing spoken text
// ---------------------------------------------------------------------------
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// "five" -> "5", "twenty five" -> "25", "one two three four" -> "1234"
function normalizeNumbers(text) {
  const tokens = text.toLowerCase().replace(/[$,]/g, '').replace(/[?!;:]/g, ' ').replace(/\.(?!\d)/g, ' ').split(/\s+/).filter(Boolean);
  const isDigit = (t) => /^\d$/.test(t) || (t in UNITS && UNITS[t] <= 9);
  const digitOf = (t) => (/^\d$/.test(t) ? t : String(UNITS[t]));
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isDigit(t) && tokens.slice(i, i + 4).length === 4 && tokens.slice(i, i + 4).every(isDigit)) {
      out.push(tokens.slice(i, i + 4).map(digitOf).join(''));
      i += 3;
    } else if (t in TENS) {
      let v = TENS[t];
      if (i + 1 < tokens.length && tokens[i + 1] in UNITS && UNITS[tokens[i + 1]] >= 1 && UNITS[tokens[i + 1]] <= 9) { v += UNITS[tokens[i + 1]]; i++; }
      out.push(String(v));
    } else if (t in UNITS) {
      let v = UNITS[t];
      if (tokens[i + 1] === 'hundred') { v *= 100; i++; }
      out.push(String(v));
    } else {
      out.push(t);
    }
  }
  return out.join(' ');
}

function parseCommand(rawText) {
  let text = normalizeNumbers(rawText);

  // PIN: "pin 1234" / "code 1234", else a bare 4-digit number
  let pin = null;
  let m = text.match(/\b(?:pin|code|password)\s*(?:is\s*)?(\d{4})\b/);
  if (!m) m = text.match(/(?:^|\s)(\d{4})(?=\s|$)/);
  if (m) { pin = m[1]; text = text.replace(m[0], ' '); }

  const tokens = text.split(/\s+/).filter(Boolean);
  const has = (re) => re.test(text);

  const bill = directory.bills.find((b) => tokens.includes(b.key));
  const amountTok = tokens.find((t) => /^\d+(\.\d{1,2})?$/.test(t));
  const amount = amountTok ? Number(amountTok) : null;

  if (has(/\bbalance\b/)) return { intent: 'balance' };
  if (has(/\b(history|recent|transactions?|activity)\b/)) return { intent: 'history' };
  if (has(/\bhelp\b/)) return { intent: 'help' };

  // "request 20 dollars from John", "invoice Steve for 15", "ask john for 5"
  if (has(/\b(request|invoice|charge|ask)\b/) && !bill) {
    const contact = tokens.find((t) => directory.contacts.includes(t)) || null;
    return { intent: 'request', contact, amount };
  }

  if (bill) return { intent: 'pay', kind: 'bill', bill, amount, pin };

  if (has(/\b(send|pay|transfer|give)\b/)) {
    let contact = tokens.find((t) => directory.contacts.includes(t)) || null;
    if (!contact) {
      let toIdx = tokens.indexOf('to');
      if (toIdx < 0) toIdx = tokens.indexOf('for');
      if (toIdx >= 0 && toIdx + 1 < tokens.length) contact = tokens[toIdx + 1];
    }
    if (has(/\b(bill|utility)\b/)) return { intent: 'pay', kind: 'bill', bill: null, amount, pin };
    return { intent: 'pay', kind: 'person', contact, amount, pin };
  }
  return { intent: 'unknown' };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function setOutput(...lines) {
  outputEl.textContent = '';
  lines.forEach(([text, cls]) => addOutput(text, cls));
}
function addOutput(text, cls) {
  const d = document.createElement('div');
  d.textContent = text;
  if (cls) d.className = cls;
  outputEl.appendChild(d);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, options) {
  try {
    const res = await fetch(path, options);
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'Cannot reach the InclusivePay server. Is it running?' } };
  }
}
const fetchTransactions = async () => (await api('/transactions')).data.transactions || [];
const sendMoney = (body) => api('/send-money', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function loadDirectory() {
  const r = await api('/directory');
  if (r.ok && r.data.contacts) directory = r.data;
  const h = await api('/health');
  aiEnabled = Boolean(h.ok && h.data.ai);
  const hint = $('askForm');
  if (hint) hint.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Ask / confirm: typed modal, optionally raced with a spoken answer
// ---------------------------------------------------------------------------
async function ask({ title, message, spoken, voice, input = true, inputType = 'text', inputMode, defaultValue = '', okLabel, cancelLabel, parseVoice, retry }) {
  const modal = openModal({ title, message, input, inputType, inputMode, defaultValue, okLabel, cancelLabel, cancellable: true });
  const hint = document.createElement('div');           // on-screen mic status (the beep is the audible one)
  hint.className = 'listen-hint';
  $('modalBody').appendChild(hint);
  await speak(spoken || message);
  if (!voice || !activeModal || !SpeechRecognitionAPI) return modal.promise;

  let open = true;
  let current = null;
  modal.promise.then(() => { open = false; if (current) current.abort(); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    await sleep(300);                                     // let the speaker's tail fade so we don't hear ourselves
    // Keep listening until the answer is understood. Silence = listen again (with a fresh beep).
    // Heard but not understood = say so briefly, then listen again.
    for (let tries = 0; open && tries < 4; tries++) {
      hint.textContent = '🎙 Getting the microphone ready…';
      current = listenOnce(() => { beep(); hint.textContent = '🎙 Listening… speak now'; });
      const said = await current.promise;
      hint.textContent = '';
      if (!open) return;
      if (said === null) continue;
      for (const heard of [said, ...current.alts()]) {   // the recogniser's runner-up guesses count too
        const parsed = parseVoice ? parseVoice(heard) : heard;
        if (parsed !== undefined) { modal.close(parsed); return; }
      }
      if (retry && open) { await speak(retry); await sleep(300); }
    }
    if (open) { hint.textContent = 'I could not understand. Please type your answer.'; speak('I could not understand that. You can type your answer instead.'); }
  })();
  return modal.promise;
}

const askText = (opts) => ask({ ...opts, input: true });

async function confirmPayment(summary, voice) {
  const answer = await ask({
    title: 'Confirm payment',
    message: summary,
    // The last words are neutral on purpose: if the microphone catches the tail of this sentence it must not look like an answer.
    spoken: voice ? `${summary} Say confirm or cancel when you're ready.` : `${summary} Choose Confirm or Cancel.`,
    voice,
    input: false,
    okLabel: 'Confirm',
    cancelLabel: 'Cancel',
    retry: "Sorry, I didn't catch that. Please try again.",
    parseVoice: (said) => {
      const s = said.toLowerCase();
      const no = /\b(no|cancel|stop|don't|do not|negative|never mind)\b/.test(s);
      const yes = /\b(yes|yeah|confirm|confirmed|ok|okay|go ahead|do it|correct|proceed|sure)\b/.test(s);
      if (no && yes) return undefined;    // contradictory (often our own prompt echoing back): not an answer
      if (no) return false;
      if (yes) return true;
      return undefined;                   // not understood: keep waiting
    },
  });
  return answer === true;
}

// "1234", "1,234", "1 2 3 4", "twelve thirty four", "one thousand two hundred thirty four" -> "1234"
function pinFromSpeech(said) {
  const t = normalizeNumbers(String(said).replace(/-/g, ' '));
  const exact = t.match(/\d{4}/);
  if (exact) return exact[0];
  const words = t.split(/\s+/);
  const ti = words.indexOf('thousand');
  if (ti > 0 && /^\d$/.test(words[ti - 1])) {                 // "one thousand two hundred thirty four"
    const rest = words.slice(ti + 1).filter((w) => /^\d+$/.test(w)).reduce((s, w) => s + Number(w), 0);
    const n = Number(words[ti - 1]) * 1000 + rest;
    return n >= 1000 && n <= 9999 ? String(n) : undefined;
  }
  const joined = words.filter((w) => /^\d+$/.test(w)).join('');   // "12 34"
  return /^\d{4}$/.test(joined) ? joined : undefined;
}

async function requestPin(voice) {
  const pin = await askText({
    title: 'Security PIN',
    message: 'Enter your 4-digit PIN.',
    spoken: 'Please say or type your 4 digit PIN.',
    voice,
    inputType: 'password',
    inputMode: 'numeric',
    parseVoice: pinFromSpeech,
    retry: "Sorry, I didn't catch that. Please say your PIN again, digit by digit.",
  });
  if (pin === null) return null;
  if (!/^\d{4}$/.test(pin.trim())) { await speak('A PIN has four digits.'); return null; }
  return pin.trim();
}

// ---------------------------------------------------------------------------
// The payment flow (used by voice, cards and bill buttons)
// target: { kind:'person', contact } | { kind:'bill', bill }
// ---------------------------------------------------------------------------
async function payFlow({ kind, contact, bill, amount, pin, voice }) {
  let label;
  let param;
  let effective = amount;

  if (kind === 'bill') {
    if (!bill) return fail('Which bill? Say electricity, internet, water, gas or phone.');
    label = bill.name;
    param = bill.key;
    if (effective == null) effective = bill.due;
  } else {
    if (!contact || !directory.contacts.includes(contact)) {
      const names = directory.contacts.map(cap).join(' and ');
      if (contact) await speak(`I don't have ${contact} in your contacts.`);
      const said = await askText({ title: 'Send Money', message: `Who do you want to pay? (${names})`, spoken: `Who do you want to pay? Your contacts are ${names}.`, voice, parseVoice: (s) => s.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).find((w) => directory.contacts.includes(w)) });
      if (!said) return fail('Cancelled.');
      contact = said.toLowerCase().trim();
      if (!directory.contacts.includes(contact)) return fail(`I don't have ${contact} in your contacts.`);
    }
    label = cap(contact);
    param = contact;
    if (effective == null) {
      const said = await askText({ title: 'Send Money', message: `How much do you want to send to ${label}? ($)`, spoken: `How much do you want to send to ${label}?`, voice, inputMode: 'decimal', parseVoice: (s) => { const t = normalizeNumbers(s).split(' ').find((w) => /^\d+(\.\d{1,2})?$/.test(w)); return t; } });
      if (!said) return fail('Cancelled.');
      effective = Number(said);
    }
  }

  if (!Number.isFinite(Number(effective)) || Number(effective) <= 0) return fail('That amount is not valid.');

  const summary = kind === 'bill' ? `Pay ${label}: ${fmt(effective)}.` : `Send ${fmt(effective)} to ${label}.`;
  if (!(await confirmPayment(summary, voice))) return fail('Cancelled. No money was sent.');

  if (!pin) {
    pin = await requestPin(voice);
    if (!pin) return fail('Cancelled. No money was sent.');
  }

  setOutput([summary, ''], ['Processing…', '']);
  await speak('Processing.');
  const result = await sendMoney({ contact: param, pin, amount: (kind === 'bill' && amount == null) ? undefined : effective });

  if (result.ok) {
    const msg = kind === 'bill' ? `Paid ${result.data.recipient}: ${fmt(result.data.amount)}.` : `Sent ${fmt(result.data.amount)} to ${result.data.recipient}.`;
    setOutput([msg, 'out-ok']);
    await speak(msg);
    refreshDashboardData();
  } else {
    await fail(result.data?.error || 'Payment failed.');
  }

  async function fail(message) {
    setOutput([message, 'out-err']);
    await speak(message);
  }
}

// Ask a contact to pay you (a PayPal invoice). No PIN: nothing leaves your account.
async function requestFlow({ contact, amount, voice }) {
  const fail = async (m) => { setOutput([m, 'out-err']); await speak(m); };
  if (!contact || !directory.contacts.includes(contact)) {
    const names = directory.contacts.map(cap).join(' and ');
    const said = await askText({ title: 'Request Money', message: `Who should pay you? (${names})`, spoken: `Who should pay you? Your contacts are ${names}.`, voice, parseVoice: (s) => s.toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).find((w) => directory.contacts.includes(w)) });
    if (!said) return fail('Cancelled.');
    contact = said.toLowerCase().trim();
    if (!directory.contacts.includes(contact)) return fail(`I don't have ${contact} in your contacts.`);
  }
  const label = cap(contact);
  if (amount == null) {
    const said = await askText({ title: 'Request Money', message: `How much should ${label} pay you? ($)`, spoken: `How much should ${label} pay you?`, voice, inputMode: 'decimal', parseVoice: (s) => normalizeNumbers(s).split(' ').find((w) => /^\d+(\.\d{1,2})?$/.test(w)) });
    if (!said) return fail('Cancelled.');
    amount = Number(said);
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return fail('That amount is not valid.');

  const summary = `Request ${fmt(amount)} from ${label}.`;
  if (!(await confirmPayment(summary, voice))) return fail('Cancelled. No invoice was sent.');
  setOutput([summary, ''], ['Sending invoice…', '']);
  await speak('Sending the invoice.');
  const r = await api('/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact, amount }) });
  if (!r.ok) return fail(r.data?.error || 'The invoice could not be sent.');
  const msg = `Invoice for ${fmt(r.data.amount)} sent to ${r.data.recipient}.`;
  setOutput([msg, 'out-ok']);
  await speak(msg);
  refreshDashboardData();
}

// Wrap flows so only one runs at a time
async function guarded(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { console.error(e); setOutput(['Something went wrong.', 'out-err']); speak('Something went wrong.'); } finally { busy = false; }
}

// ---------------------------------------------------------------------------
// AI assistant (Claude via the server). It prepares payments; we confirm + PIN here.
// ---------------------------------------------------------------------------

// Pull a spoken PIN out of the text so it never reaches the AI model.
function extractPin(raw) {
  let text = normalizeNumbers(raw);
  let pin = null;
  let m = text.match(/\b(?:pin|code|password)\s*(?:is\s*)?(\d{4})\b/);
  if (!m) m = text.match(/(?:^|\s)(\d{4})(?=\s|$)/);
  if (m) { pin = m[1]; text = text.replace(m[0], ' ').replace(/\s+/g, ' ').trim(); }
  return { pin, text };
}

async function runProposals(proposals, pin, voice) {
  const payments = proposals.filter((p) => p.type !== 'invoice');
  const total = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const parts = proposals.map((p) => `${p.label}: ${fmt(p.amount)}`);
  const summary = proposals.length === 1 ? `${parts[0]}.` : `${parts.join('; ')}.${payments.length > 1 ? ` Total to pay ${fmt(total)}.` : ''}`;
  const cancelMsg = payments.length ? 'Cancelled. No money was sent.' : 'Cancelled. No invoice was sent.';

  if (!(await confirmPayment(summary, voice))) {
    setOutput([cancelMsg, 'out-err']);
    return speak(cancelMsg);
  }
  if (payments.length && !pin) {                        // only moving money needs the PIN
    pin = await requestPin(voice);
    if (!pin) { setOutput([cancelMsg, 'out-err']); return speak(cancelMsg); }
  }

  setOutput([summary, ''], ['Processing…', '']);
  await speak('Processing.');
  const r = await api('/agent/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: proposals.map((p) => p.id), pin }) });
  if (!r.ok) {
    const msg = r.data?.error || 'Payment failed.';
    setOutput([msg, 'out-err']);
    return speak(msg);
  }
  const lines = r.data.results.map((x) => (x.ok
    ? (x.type === 'invoice' ? `Invoice for ${fmt(x.amount)} sent to ${x.recipient}.` : x.kind === 'bill' ? `Paid ${x.recipient}: ${fmt(x.amount)}.` : `Sent ${fmt(x.amount)} to ${x.recipient}.`)
    : `${x.recipient ? x.recipient + ': ' : ''}${x.error}`));
  const allOk = r.data.results.every((x) => x.ok);
  setOutput(...lines.map((l) => [l, allOk ? 'out-ok' : 'out-err']));
  await speak(lines.join(' '));
  refreshDashboardData();
}

// One request to the agent, then (for voice) keep the conversation going while it asks questions.
async function agentConversation(rawText, voice) {
  if (Date.now() - lastChatAt > 5 * 60 * 1000) chatHistory = [];
  let pin = null;
  let said = rawText;

  for (let turn = 0; turn < 4; turn++) {
    const parsed = extractPin(said);
    if (parsed.pin) pin = parsed.pin;
    const text = parsed.text || said;
    setOutput([`You said: "${text}"`, 'out-you'], ['Thinking…', '']);

    const t0 = performance.now();
    const r = await api('/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, history: chatHistory }) });
    console.info(`[InclusivePay] AI request: ${Math.round(performance.now() - t0)} ms (server reports ${r.data && r.data.ms != null ? r.data.ms + ' ms' : 'n/a'})`);
    lastChatAt = Date.now();

    if (!r.ok) {
      if (r.status === 502 || r.status === 503) return handleVoiceCommand(said, true, voice);   // AI down: basic parser
      const msg = r.data?.error || 'Something went wrong.';
      setOutput([msg, 'out-err']);
      return speak(msg);
    }

    const { reply, proposals } = r.data;

    if (proposals && proposals.length) {                // payments prepared: go straight to the read-back
      chatHistory = [];                                 // a finished request shouldn't colour the next one
      return runProposals(proposals, pin, voice);
    }

    chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    chatHistory = chatHistory.slice(-8);
    setOutput([`You said: "${text}"`, 'out-you'], [reply, 'out-ok']);
    await speak(reply);

    if (voice && reply.trim().endsWith('?')) {          // the assistant asked a question: listen for the answer
      const listener = listenOnce(beep);
      const next = await listener.promise;
      if (!next) { setOutput(["I didn't hear an answer. Press Space to continue.", 'out-err']); return speak("I didn't hear an answer. Press space to continue."); }
      said = next;
      continue;
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Voice commands
// ---------------------------------------------------------------------------
async function readBalance() {
  const data = (await api('/balance')).data;
  const msg = data.balance ? `Your balance is ${data.balance}.` : 'I could not get your balance.';
  setOutput([msg, data.balance ? 'out-ok' : 'out-err']);
  await speak(msg);
}

async function readHistory() {
  const tx = (await fetchTransactions()).slice(0, 3);
  const msg = tx.length
    ? 'Your last payments: ' + tx.map((t) => `${t.amount} to ${t.recipient}, ${String(t.status).toLowerCase()}`).join('. ') + '.'
    : 'You have no payments yet.';
  setOutput([msg, 'out-ok']);
  await speak(msg);
}

// Plain, unambiguous commands ("send 5 dollars to John", "pay electricity bill", "check balance") don't need
// a language model: the built-in parser handles them instantly. The AI takes everything else.
// Add ?ai=always to the page address to send everything to the AI (handy for demos).
const AI_ALWAYS = new URLSearchParams(location.search).get('ai') === 'always';
function isSimpleCommand(text) {
  if (/\b(and|then|also|plus|not|never|don't|cancel|stop)\b/i.test(text)) return false;
  const c = parseCommand(text);
  const namesAContact = directory.contacts.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(text));
  if (c.intent === 'balance') return true;
  if (c.intent === 'pay' && c.kind === 'bill') return Boolean(c.bill) && !namesAContact;
  if (c.intent === 'pay' || c.intent === 'request') return Boolean(c.contact && directory.contacts.includes(c.contact) && c.amount != null && c.amount > 0);
  return false;
}

async function handleVoiceCommand(text, skipAi = false, voice = true) {
  if (aiEnabled && !skipAi && (AI_ALWAYS || !isSimpleCommand(text))) return agentConversation(text, voice);
  setOutput([`You said: "${text}"`, 'out-you']);
  const cmd = parseCommand(text);

  if (cmd.intent === 'balance') return readBalance();
  if (cmd.intent === 'history') return readHistory();
  if (cmd.intent === 'help' || cmd.intent === 'unknown') {
    const msg = 'You can say: check balance. Send 5 dollars to John. Request 20 dollars from Steve. Pay electricity bill. Or read my recent payments.';
    setOutput([cmd.intent === 'unknown' ? `I didn't understand. ${msg}` : msg, cmd.intent === 'unknown' ? 'out-err' : '']);
    return speak(cmd.intent === 'unknown' ? `Sorry, I didn't understand. ${msg}` : msg);
  }
  if (cmd.intent === 'request') return requestFlow({ ...cmd, voice });
  return payFlow({ ...cmd, voice });
}

function startVoice() {
  guarded(async () => {
    if (!SpeechRecognitionAPI) {
      const msg = 'Voice recognition is not supported in this browser. Please use Chrome or Edge, or use the buttons.';
      setOutput([msg, 'out-err']);
      await openModal({ title: 'Voice not supported', message: msg }).promise;
      return;
    }
    // No spoken "Listening." (it delays the mic by about a second and people start talking too early):
    // the microphone opens at once and a beep says when to speak. Screen readers get a text cue.
    window.speechSynthesis && window.speechSynthesis.cancel();
    setOutput(['Listening…', '']);
    announceQuiet('Listening');
    const listener = listenOnce(beep);
    const said = await listener.promise;
    if (!said) {
      setOutput(["I didn't hear anything. Press Space and try again.", 'out-err']);
      return speak("I didn't hear anything. Press space and try again.");
    }
    await handleVoiceCommand(said);
  });
}

// ---------------------------------------------------------------------------
// Dashboard: AG Grid, recent activity, PDF statement
// ---------------------------------------------------------------------------
const amountValue = (s) => parseFloat(String(s).replace('$', '')) || 0;
const statusColor = (s) => (s === 'SUCCESS' ? '#00bcd4' : (s === 'PENDING' || s === 'PROCESSING') ? '#f5b942' : '#ff6b6b');

const gridOptions = {
  columnDefs: [
    { field: 'id', headerName: 'Payment ID', width: 112 },
    { field: 'recipient', headerName: 'Recipient', width: 104 },
    { field: 'amount', headerName: 'Amount', width: 80, comparator: (a, b) => amountValue(a) - amountValue(b) },
    { field: 'status', headerName: 'Status', width: 108, cellStyle: (p) => ({ color: statusColor(p.value), fontWeight: 600 }) },
    { field: 'date', headerName: 'Date', flex: 1, minWidth: 125, valueFormatter: (p) => String(p.value || '').replace(/:\d\d(?=\s?[AaPp][Mm]|$)/, '') },
  ],
  defaultColDef: { sortable: true, filter: true, resizable: true },
  rowData: [],
  overlayNoRowsTemplate: '<span>No payments yet. Try saying “Send 5 dollars to John”.</span>',
};

// PayPal settles payouts a few seconds after creating them (PENDING -> PROCESSING -> SUCCESS),
// so keep refreshing until nothing is unsettled (gives up after ~2 minutes).
let pollTimer = null;
let pollCount = 0;

async function refreshDashboardData(fromPoll = false) {
  const data = await fetchTransactions();
  if (gridApi) gridApi.setGridOption('rowData', data);

  clearTimeout(pollTimer);
  if (!fromPoll) pollCount = 0;
  if (data.some((t) => t.status === 'PENDING' || t.status === 'PROCESSING') && ++pollCount <= 30) {
    pollTimer = setTimeout(() => refreshDashboardData(true), 4000);
  }

  const list = document.querySelector('.file-list');
  if (!list) return;
  list.textContent = '';
  if (!data.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--text-muted); font-size:12px; text-align:center; padding:15px;';
    empty.textContent = 'No recent activity';
    list.appendChild(empty);
    return;
  }
  data.slice(0, 3).forEach((tx) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    const info = document.createElement('div');
    info.className = 'file-info';
    const icon = document.createElement('div');
    icon.className = 'file-type-icon';
    icon.textContent = '$';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.textContent = `Sent ${tx.amount} to ${tx.recipient}`;
    info.append(icon, text);
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.textContent = tx.status;
    badge.style.color = statusColor(tx.status);
    item.append(info, badge);
    list.appendChild(item);
  });
}

// Live updates from the server (webhooks, status changes). Polling above stays as the fallback.
let refreshSoon = null;
function connectLiveUpdates() {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/events');
  es.addEventListener('update', (e) => {
    let msg = {};
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    clearTimeout(refreshSoon);
    refreshSoon = setTimeout(() => refreshDashboardData(true), 150);
    // Tell the user about changes they did not just cause themselves
    // Say only the outcome (completed, paid, failed...), not every intermediate "processing" step
    const final = /is now (SUCCESS|PAID|DENIED|FAILED|BLOCKED|RETURNED|REFUNDED|CANCELED|CANCELLED|UNCLAIMED|ONHOLD)\b/;
    if (msg.kind === 'feed' && msg.item && msg.item.source !== 'app' && !busy && final.test(msg.item.text)) speak(msg.item.text);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('exportPdfBtn').addEventListener('click', async () => {
  const data = await fetchTransactions();
  const w = window.open('', '_blank');
  if (!w) { speak('Your browser blocked the statement window. Please allow pop-ups.'); return; }
  speak('Generating your accessible statement.');
  const rows = data.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.recipient)}</td><td>${esc(t.amount)}</td><td>${esc(t.status)}</td><td>${esc(t.date)}</td></tr>`).join('');
  w.document.write(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>InclusivePay Statement</title>
    <style>body{font-family:Arial,sans-serif;padding:40px;color:#222}h1{color:#006d7a}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #999;padding:12px;text-align:left}th{background:#eee}</style></head>
    <body><h1>InclusivePay Statement (Sandbox)</h1><p><strong>Generated:</strong> ${esc(new Date().toLocaleString())}</p>
    <table><caption class="sr-only">Payments</caption><thead><tr><th scope="col">Transaction ID</th><th scope="col">Recipient</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No transactions</td></tr>'}</tbody></table>
    <script>window.onload=function(){window.print()}<\/script></body></html>`);
  w.document.close();
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function makeKeyboardClickable(el, handler) {
  el.addEventListener('click', handler);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  renderTtsToggle();
  $('ttsToggle').addEventListener('click', () => {
    ttsOn = !ttsOn;
    try { localStorage.setItem('ipay-tts', ttsOn ? 'on' : 'off'); } catch (_) { /* ignore */ }
    if (!ttsOn && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    renderTtsToggle();
    speak(ttsOn ? 'Spoken replies on.' : 'Spoken replies off.');
  });

  const gridDiv = $('grid');
  if (gridDiv && typeof agGrid !== 'undefined') gridApi = agGrid.createGrid(gridDiv, gridOptions);
  await loadDirectory();
  refreshDashboardData();
  connectLiveUpdates();

  voiceBtn.addEventListener('click', startVoice);
  $('askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('askInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    voiceBtn.focus();                                   // so Space / Enter start voice next, not another typed space
    guarded(() => handleVoiceCommand(text, false, Boolean(SpeechRecognitionAPI) && ttsOn));
  });
  $('startJourneyBtn').addEventListener('click', () => { voiceBtn.focus(); startVoice(); });

  // Send Money card (typed, with optional confirm by voice not needed)
  makeKeyboardClickable($('sendMoneyCard'), () => guarded(() => payFlow({ kind: 'person', voice: false })));

  makeKeyboardClickable($('requestCard'), () => guarded(() => requestFlow({ voice: false })));
  makeKeyboardClickable($('balanceCard'), () => guarded(readBalance));

  document.querySelectorAll('.utility-btn').forEach((btn) => {
    btn.addEventListener('click', () => guarded(async () => {
      const bill = directory.bills.find((b) => b.key === btn.dataset.utility);
      if (!bill) return;
      const typed = await askText({
        title: bill.name,
        message: `Amount for ${bill.name} ($)`,
        spoken: `${bill.name}. ${bill.due != null ? `${fmt(bill.due)} is due.` : ''} Enter the amount.`,
        voice: false,
        inputMode: 'decimal',
        defaultValue: bill.due != null ? String(bill.due) : '',
      });
      if (typed === null) return;
      const amount = Number(typed);
      if (!Number.isFinite(amount) || amount <= 0) { setOutput(['That amount is not valid.', 'out-err']); speak('That amount is not valid.'); return; }
      await payFlow({ kind: 'bill', bill, amount, voice: false });
    }));
  });
});

// Spacebar = speak, but only when nothing else is focused/open
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || activeModal) return;
  const t = e.target;
  const interactive = t && t !== document.body && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || (t && (t.getAttribute?.('role') === 'button' || t.isContentEditable));
  if (interactive) return;                // let buttons keep their normal Space behaviour
  e.preventDefault();
  startVoice();
});

// Chrome blocks speech until the user has interacted with the page, so greet on first interaction.
let greeted = false;
function greetOnce(e) {
  if (greeted) return;
  greeted = true;
  if (e.type === 'keydown' && e.code === 'Space') return;   // they're already speaking a command
  speak('Welcome to InclusivePay. Press the Spacebar to speak a command, for example: send 5 dollars to John.');
}
window.addEventListener('keydown', greetOnce, { once: false });
window.addEventListener('pointerdown', greetOnce, { once: false });

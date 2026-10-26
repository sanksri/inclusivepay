// InclusivePay AI agent: an LLM with tools, wrapped in a human-in-the-loop gate.
//
// Works with any provider that offers the OpenAI-style /chat/completions API with tool calling
// (Google Gemini's free tier, Groq, OpenRouter, a local Ollama, ...). Configure it in .env.
//
// The model can READ (balance, payees, history) and PREPARE payments (propose_payment).
// It can never move money: proposals are stored server-side and only executed after the
// user confirms and enters their PIN, which the model never sees.

const axios = require('axios');

const SYSTEM_PROMPT = `You are InclusivePay's voice assistant for people who use voice and screen readers. Your replies are read aloud.

Style: plain spoken sentences, under 40 words, no markdown, lists, symbols or emoji. Money is in US dollars.

What you can do: check the balance, list payees and bills, review recent payments, PREPARE payments, and PREPARE requests for money.
- You can never send money yourself. propose_payment only prepares a payment; the app then reads it back and the user confirms with their PIN. Never say a payment was sent or completed.
- Call propose_payment once for each payment the user asks for. Several payments in one request are fine.
- When the user wants to be paid ("request", "invoice", "ask John for $20"), call request_payment with a contact and an amount. That prepares a PayPal invoice the user confirms; it does not move money. Bills cannot be requested.
- Use only payees from list_payees (call it if unsure). For a bill with no amount stated, the amount due is used.
- If the payee or amount is missing or unclear, ask ONE short question instead of guessing.
- Never invent contacts, amounts or balances: use the tools.
- Never ask for, repeat or discuss a PIN.
- After preparing payments, give a one-sentence summary and nothing else; the app handles confirmation.
- If asked about anything unrelated to payments, decline politely in one sentence.`;

// Tool definitions in the OpenAI function-calling format.
const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
const TOOLS = [
  fn('get_balance', "Get the user's current account balance.", { type: 'object', properties: {} }),
  fn('list_payees', "List the user's contacts and their bills, including the amount currently due on each bill.", {
    type: 'object',
    properties: {},
  }),
  fn('get_recent_payments', "Get the user's most recent payments, newest first.", {
    type: 'object',
    properties: { limit: { type: 'integer', description: 'How many payments to return, 1 to 10 (default 5).' } },
  }),
  fn(
    'propose_payment',
    'Prepare a payment to a contact or a bill for the user to confirm. This does NOT send money. For a bill, omit amount to use the amount due.',
    {
      type: 'object',
      properties: {
        payee: { type: 'string', description: 'A contact name (e.g. John) or a bill (e.g. electricity).' },
        amount: { type: 'number', description: 'Amount in US dollars. Optional for bills.' },
      },
      required: ['payee'],
    }
  ),
  fn(
    'request_payment',
    'Prepare a PayPal invoice asking a contact to pay the user. This does NOT send anything until the user confirms. Contacts only, never bills.',
    {
      type: 'object',
      properties: {
        payee: { type: 'string', description: 'The contact to request money from (e.g. John).' },
        amount: { type: 'number', description: 'Amount in US dollars.' },
        note: { type: 'string', description: 'Optional short reason, e.g. "dinner".' },
      },
      required: ['payee', 'amount'],
    }
  ),
];

// History comes from the browser, so treat it as untrusted: strings only, bounded, alternating roles.
function sanitizeHistory(history) {
  const out = [];
  for (const m of Array.isArray(history) ? history.slice(-8) : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.slice(0, 500);
    if (!content.trim()) continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += ' ' + content;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function chatCompletion(llm, messages) {
  const url = `${llm.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const send = (withReasoning) =>
    axios.post(
      url,
      { model: llm.model, messages, tools: TOOLS, tool_choice: 'auto', ...(withReasoning ? { reasoning_effort: llm.reasoningEffort } : {}) },
      { headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' }, timeout: llm.timeoutMs || 12000 }
    );
  const started = Date.now();
  let res;
  try {
    res = await send(Boolean(llm.reasoningEffort));
  } catch (err) {
    // Some models/providers reject the reasoning setting: drop it once and carry on.
    if (llm.reasoningEffort && err.response?.status === 400) {
      console.warn('AI provider rejected reasoning_effort; continuing without it.');
      llm.reasoningEffort = '';
      if (llm.onReasoningRejected) llm.onReasoningRejected();   // remember for later requests
      res = await send(false);
    } else {
      throw err;
    }
  }
  if (llm.onCall) llm.onCall(Date.now() - started);
  const choice = res.data?.choices?.[0];
  if (!choice?.message) throw new Error('Empty response from the AI provider');
  return choice.message;
}

// finishOnTool: if every tool call in a step is one of these and all succeeded, stop right there.
// (Saves a whole model round trip when the app writes its own read-back.)
async function runAgent({ llm, history, text, handlers, maxSteps = 6, finishOnTool = [] }) {
  const convo = sanitizeHistory(history);
  if (convo.length && convo[convo.length - 1].role === 'user') convo[convo.length - 1].content += ' ' + text;
  else convo.push({ role: 'user', content: text });
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...convo];

  for (let step = 0; step < maxSteps; step++) {
    const message = await chatCompletion(llm, messages);
    // Keep the provider's message exactly as returned (some providers attach extra fields that
    // must be echoed back on the next turn).
    messages.push(message);

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) return String(message.content || '').trim();

    let allOk = true;
    for (const call of calls) {
      let content;
      try {
        const handler = handlers[call.function?.name];
        if (!handler) throw new Error(`Unknown tool ${call.function?.name}`);
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { throw new Error('Invalid tool arguments'); }
        content = JSON.stringify(await handler(args || {}));
      } catch (err) {
        allOk = false;
        content = JSON.stringify({ error: String(err.message || err) });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
    if (allOk && calls.every((c) => finishOnTool.includes(c.function?.name))) return '';
  }
  return 'Sorry, that took too many steps. Please try again.';
}

module.exports = { runAgent, sanitizeHistory, TOOLS, SYSTEM_PROMPT };

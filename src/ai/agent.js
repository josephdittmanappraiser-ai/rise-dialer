// The AI phone agent. Twilio ConversationRelay turns the caller's speech into text and sends it
// over a WebSocket; Claude writes the reply; Twilio speaks it with an ElevenLabs voice.
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { get, getSetting } = require('../db');
const svc = require('../services');
const { prettyPhone, safeJson } = require('../util');

let _anthropic = null;
function anthropic() {
  if (!config.ai.anthropicKey) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: config.ai.anthropicKey });
  return _anthropic;
}

const TOOLS = [
  {
    name: 'end_call',
    description: 'Hang up the call. Say your goodbye in the same turn BEFORE calling this. Use when the conversation is finished, after leaving a voicemail, or if the person asks you to stop calling.',
    input_schema: { type: 'object', properties: { outcome: { type: 'string', description: 'Short result, e.g. "Payment promised Friday", "Left voicemail", "Wrong number"' } }, required: ['outcome'] },
  },
  {
    name: 'transfer_to_human',
    description: 'Transfer the caller to a person on the team. Tell the caller you are transferring them BEFORE calling this.',
    input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'Why they need a person, one sentence' } }, required: ['reason'] },
  },
  {
    name: 'take_message',
    description: 'Save a message for the team (it is posted for them right away). Use when someone wants a callback or leaves information.',
    input_schema: {
      type: 'object',
      properties: {
        caller_name: { type: 'string' },
        callback_number: { type: 'string', description: 'Leave blank to use the number they are calling from' },
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
  {
    name: 'send_text',
    description: 'Send a text message to the person you are talking to (to the number on this call). Only send information your instructions provide.',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
  {
    name: 'press_keys',
    description: 'Press phone keypad keys to navigate an automated phone menu (IVR). Digits 0-9, * and #; "w" waits half a second. After pressing, stay silent and wait for the next prompt.',
    input_schema: { type: 'object', properties: { digits: { type: 'string' } }, required: ['digits'] },
  },
];

function nowCentral() {
  return new Date().toLocaleString('en-US', { timeZone: config.timezone, dateStyle: 'full', timeStyle: 'short' });
}

function buildSystemPrompt(agent, call) {
  const business = getSetting('business_name') || config.businessName;
  const contact = svc.contactByPhone(call.other_number);
  const outbound = call.direction === 'outbound';
  return `You are ${agent.name}, an AI phone assistant for ${business}. You are on a LIVE PHONE CALL. Everything you write is spoken out loud by a text-to-speech voice.

# The call
- Direction: ${outbound ? `outbound — you called ${contact?.name || 'this person'} at ${prettyPhone(call.other_number)}` : `inbound — ${contact?.name || 'a caller'} called from ${prettyPhone(call.other_number)}`}
- Our phone number (for callbacks): ${prettyPhone(call.our_number)}
- Right now it is ${nowCentral()} (Central Time)
${contact ? `- Contact on file: ${contact.name || ''}${contact.company ? `, ${contact.company}` : ''}${contact.notes ? `. Notes: ${contact.notes}` : ''}` : ''}

# How to talk
- Sound like a friendly, competent person on the phone. Keep each turn to one to three short sentences, then let them talk.
- Plain spoken words only: no lists, bullet points, markdown, emojis or symbols. Say numbers the way people say them ("five hundred dollars", "Friday the fourteenth").
- Ask one question at a time. If the transcript of what they said looks garbled, ask them to repeat.
- Never make up facts, amounts, dates or promises that are not in your instructions. If you don't know, say a team member will follow up and take a message.
- If anyone asks whether you are an AI or a real person, say honestly that you are an AI assistant for ${business}.
- If they ask to be removed from calls or not to be contacted, apologize, confirm, and end the call.
${outbound ? `- If you reach voicemail or an answering machine (a greeting, "leave a message", a beep), leave one short message: who you are, why you called, and the callback number ${prettyPhone(call.our_number)}. Then use end_call.
- If you reach an automated phone menu, listen to the options and use press_keys to navigate toward a person or the right department. While waiting on hold, stay silent (reply with nothing).` : ''}
- Use transfer_to_human when they ask for a person or need something you can't handle.

# Instructions from ${business}
${agent.instructions}
${call.ai_context ? `\n# About this specific call\n${call.ai_context}` : ''}`;
}

const SUMMARY_PROMPT = `You summarize business phone calls for the owner. Read the transcript and reply with ONLY a JSON object:
{"summary": "2-3 plain sentences: who it was, what was discussed, what was agreed", "outcome": "a 2-6 word result label", "follow_up": "the next action the team must take, or empty string"}`;

async function summarizeCall(transcript, call) {
  const client = anthropic();
  if (!client || !transcript.length) return null;
  const text = transcript.map((t) => `${t.role === 'agent' ? 'AI agent' : 'Other person'}: ${t.text}`).join('\n');
  try {
    const res = await client.messages.create({
      model: config.ai.summaryModel,
      max_tokens: 400,
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: `Call direction: ${call.direction}. Number: ${call.other_number}.\n\nTranscript:\n${text}` }],
    });
    const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = out.match(/\{[\s\S]*\}/);
    return m ? safeJson(m[0], { summary: out }) : { summary: out };
  } catch (e) {
    console.warn('[ai] summary failed:', e.message);
    return null;
  }
}

// One instance per live call.
class RelaySession {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];        // Claude conversation history
    this.transcript = [];      // what was actually said, for the call log
    this.call = null;
    this.agent = null;
    this.turn = null;          // { stream, text, aborted }
    this.ending = false;
    this.textsSent = 0;
    this.outcome = null;
    this.handoff = null;
    this.queue = Promise.resolve();
  }

  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  say(token, last = false) { this.send({ type: 'text', token, last }); }

  async onMessage(raw) {
    const msg = safeJson(raw.toString(), null);
    if (!msg) return;
    switch (msg.type) {
      case 'setup': return this.onSetup(msg);
      case 'prompt': if (msg.last !== false) return this.onPrompt(msg.voicePrompt); return;
      case 'dtmf': return this.onPrompt(`(they pressed ${msg.digit} on their keypad)`);
      case 'interrupt': return this.onInterrupt(msg.utteranceUntilInterrupt);
      case 'error': console.warn('[relay] Twilio error:', msg.description); return;
      default: return;
    }
  }

  onSetup(msg) {
    const params = msg.customParameters || {};
    const relayKey = getSetting('relay_key');
    if (!relayKey || params.key !== relayKey) {
      console.warn('[relay] Rejected session with bad key');
      this.ws.close();
      return;
    }
    const callId = Number(params.callId);
    this.call = svc.getCall(callId) || svc.callBySid(msg.callSid);
    if (!this.call) { console.warn('[relay] Unknown call', callId); this.ws.close(); return; }
    this.agent = get('SELECT * FROM ai_agents WHERE id = ?', this.call.ai_agent_id) || svc.findAgent();
    if (!this.call.call_sid && msg.callSid) svc.updateCall(this.call.id, { call_sid: msg.callSid });
    svc.updateCall(this.call.id, { status: 'in-progress' });
    this.system = buildSystemPrompt(this.agent, this.call);

    if (!anthropic()) {
      this.say('Sorry, our assistant is not available right now. Please call back later. Goodbye.', true);
      this.scheduleEnd({ reason: 'hangup' }, 60);
      return;
    }

    if (params.greeted === '1' && this.agent.greeting) {
      // Twilio already spoke the welcome greeting.
      this.messages.push({ role: 'user', content: '(The call connected.)' });
      this.messages.push({ role: 'assistant', content: this.agent.greeting });
      this.transcript.push({ role: 'agent', text: this.agent.greeting, at: new Date().toISOString() });
    } else {
      // Claude opens the call itself (used for outbound calls so it can greet the person by name).
      this.enqueue(() => this.respond(
        this.call.direction === 'outbound'
          ? '(The call just connected — the other side picked up. Begin the conversation now. If it sounds like voicemail or a phone menu, handle that instead.)'
          : '(The call just connected. Greet the caller.)',
        { synthetic: true },
      ));
    }
  }

  enqueue(fn) { this.queue = this.queue.then(fn).catch((e) => console.error('[relay]', e)); return this.queue; }

  onPrompt(text) {
    if (!text || this.ending) return;
    if (this.turn) this.abortTurn(this.turn.text); // they started talking before we finished
    this.enqueue(() => this.respond(text));
  }

  onInterrupt(heard) {
    if (this.turn) this.abortTurn(heard);
    else {
      // The reply already finished streaming; trim history to what they actually heard.
      const last = this.messages[this.messages.length - 1];
      const textOnly = last && last.role === 'assistant' && (typeof last.content === 'string' || (Array.isArray(last.content) && last.content.every((b) => b.type === 'text')));
      if (textOnly && heard) last.content = heard + ' —';
      const t = this.transcript[this.transcript.length - 1];
      if (t && t.role === 'agent' && heard) t.text = heard + ' —';
    }
  }

  abortTurn(heard) {
    const turn = this.turn;
    if (!turn || turn.aborted) return;
    turn.aborted = true;
    turn.heard = heard;
    try { turn.stream && turn.stream.abort(); } catch {}
  }

  pushUser(text) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') last.content += `\n${text}`;
    else this.messages.push({ role: 'user', content: text });
  }

  async respond(userText, { synthetic = false } = {}) {
    if (this.ending) return;
    this.pushUser(userText);
    if (!synthetic) this.transcript.push({ role: 'caller', text: userText, at: new Date().toISOString() });

    let spokenChars = 0;
    for (let hop = 0; hop < 6; hop++) {
      const turn = { text: '', aborted: false, stream: null };
      this.turn = turn;
      let final;
      try {
        turn.stream = anthropic().messages.stream({
          model: config.ai.voiceModel,
          max_tokens: 400,
          system: this.system,
          tools: TOOLS,
          messages: this.messages,
        });
        turn.stream.on('text', (delta) => {
          if (turn.aborted) return;
          turn.text += delta;
          this.say(delta, false);
        });
        final = await turn.stream.finalMessage();
      } catch (e) {
        if (!turn.aborted) {
          console.error('[relay] Claude error:', e.message);
          this.say(" Sorry, I'm having trouble on my end. Someone from our team will follow up with you.", true);
          this.transcript.push({ role: 'agent', text: turn.text, at: new Date().toISOString() });
          this.outcome = this.outcome || 'AI error';
          this.scheduleEnd({ reason: 'hangup' }, 120);
          this.turn = null;
          return;
        }
      }
      this.turn = null;

      if (turn.aborted) {
        const heard = (turn.heard || turn.text || '').trim();
        if (heard) {
          this.messages.push({ role: 'assistant', content: heard + ' —' });
          this.transcript.push({ role: 'agent', text: heard + ' —', at: new Date().toISOString() });
        }
        return;
      }

      spokenChars += turn.text.length;
      if (turn.text.trim()) this.transcript.push({ role: 'agent', text: turn.text.trim(), at: new Date().toISOString() });
      this.messages.push({ role: 'assistant', content: final.content.length ? final.content : [{ type: 'text', text: '…' }] });

      const toolUses = final.content.filter((b) => b.type === 'tool_use');
      if (final.stop_reason !== 'tool_use' || !toolUses.length) {
        this.say('', true);
        return;
      }

      const results = [];
      let stop = false;
      for (const tu of toolUses) {
        const out = await this.runTool(tu.name, tu.input || {}, spokenChars);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.result });
        if (out.stop) stop = true;
      }
      this.messages.push({ role: 'user', content: results });
      if (stop) { this.say('', true); return; }
    }
    this.say('', true);
  }

  async runTool(name, input, spokenChars) {
    const call = this.call;
    try {
      switch (name) {
        case 'end_call':
          this.outcome = input.outcome || 'Completed';
          this.scheduleEnd({ reason: 'hangup', outcome: this.outcome }, spokenChars);
          return { result: 'Ending the call.', stop: true };
        case 'transfer_to_human':
          this.outcome = 'Transferred to team';
          this.scheduleEnd({ reason: 'transfer', note: input.reason }, spokenChars);
          return { result: 'Transferring now.', stop: true };
        case 'take_message': {
          const cb = input.callback_number || call.other_number;
          const note = `Message from ${input.caller_name || 'caller'} (${prettyPhone(cb)}): ${input.message}`;
          const existing = svc.getCall(call.id).notes;
          svc.updateCall(call.id, { notes: existing ? `${existing}\n${note}` : note });
          svc.notifySlack(`:telephone_receiver: *AI took a message* on ${prettyPhone(call.our_number)}\n${note}`);
          return { result: 'Message saved and sent to the team.' };
        }
        case 'send_text': {
          if (this.textsSent >= 3) return { result: 'Text limit reached for this call; do not send more.' };
          await svc.sendText({ to: call.other_number, from: call.our_number, body: input.message, sentBy: `AI agent (${this.agent.name})` });
          this.textsSent++;
          return { result: 'Text sent.' };
        }
        case 'press_keys': {
          const digits = String(input.digits || '').replace(/[^0-9w#*]/g, '');
          if (!digits) return { result: 'No valid digits.' };
          this.send({ type: 'sendDigits', digits });
          this.transcript.push({ role: 'agent', text: `[pressed ${digits}]`, at: new Date().toISOString() });
          return { result: `Pressed ${digits}. Now stay silent and wait for what the menu says next.`, stop: true };
        }
        default:
          return { result: `Unknown tool ${name}` };
      }
    } catch (e) {
      return { result: `Tool failed: ${e.message}` };
    }
  }

  // Let the voice finish the goodbye before hanging up.
  scheduleEnd(handoff, spokenChars) {
    if (this.ending) return;
    this.ending = true;
    this.handoff = handoff;
    const wait = Math.min(12000, 1200 + spokenChars * 65);
    setTimeout(() => this.send({ type: 'end', handoffData: JSON.stringify(handoff) }), wait);
  }

  async onClose() {
    if (!this.call) return;
    const callId = this.call.id;
    const transcript = this.transcript;
    const fields = { transcript: JSON.stringify(transcript) };
    if (this.outcome) fields.outcome = this.outcome;
    svc.updateCall(callId, fields);

    const s = await summarizeCall(transcript, this.call);
    if (s) {
      const summary = [s.summary, s.follow_up ? `Follow-up: ${s.follow_up}` : ''].filter(Boolean).join('\n');
      const row = svc.updateCall(callId, { summary, outcome: this.outcome || s.outcome || null });
      const who = row.contact_name || prettyPhone(row.other_number);
      svc.notifySlack(`:robot_face: *AI call ${row.direction === 'outbound' ? 'to' : 'from'} ${who}* — ${row.outcome || ''}\n${summary}`);
    }
  }
}

function attachRelay(wss) {
  wss.on('connection', (ws) => {
    const session = new RelaySession(ws);
    ws.on('message', (data) => session.onMessage(data).catch((e) => console.error('[relay]', e)));
    ws.on('close', () => session.onClose().catch((e) => console.error('[relay] close', e)));
    ws.on('error', (e) => console.warn('[relay] ws error', e.message));
  });
}

module.exports = { attachRelay, RelaySession, buildSystemPrompt, summarizeCall, TOOLS };

// End-to-end test with a fake Twilio and a fake Claude API. Run: node test/e2e.js
const http = require('http');
const assert = require('assert');
const fs = require('fs');

const DATA = '/tmp/rd-e2e-' + Date.now();
const PORT = 3222;
const FAKE_AI_PORT = 3223;
Object.assign(process.env, {
  PORT: String(PORT), DATA_DIR: DATA, PUBLIC_URL: `http://localhost:${PORT}`,
  TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_AUTH_TOKEN: 'testtoken',
  TWILIO_API_KEY_SID: 'SK' + '1'.repeat(32), TWILIO_API_KEY_SECRET: 'secret', TWILIO_TWIML_APP_SID: 'AP' + '2'.repeat(32),
  ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: `http://localhost:${FAKE_AI_PORT}`,
  ADMIN_EMAIL: 'joseph@test.com', ADMIN_PASSWORD: 'password123', ADMIN_NAME: 'Joseph Dittman',
});

// ---------- fake Claude (streams SSE like the real Messages API) ----------
const aiRequests = [];
let aiScript = []; // queue of responses: { text, tool }
function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body);
    aiRequests.push(j);
    if (!j.stream) { // summary call
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"summary":"Maria confirmed she got invoice 1042 and will pay Friday.","outcome":"Payment promised Friday","follow_up":"Check for payment Friday"}' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    const step = aiScript.shift() || { text: 'Okay.' };
    const content = [];
    const events = [['message_start', { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }]];
    let idx = 0;
    if (step.text) {
      events.push(['content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }]);
      for (const part of step.text.match(/.{1,8}/g)) events.push(['content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: part } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: idx }]);
      idx++;
      content.push('text');
    }
    if (step.tool) {
      events.push(['content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name: step.tool.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: idx }]);
    }
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }]);
    events.push(['message_stop', { type: 'message_stop' }]);
    const delay = step.delay || 0;
    setTimeout(() => sse(res, events), delay);
  });
}).listen(FAKE_AI_PORT);

// ---------- stub the Twilio REST calls ----------
const tw = require('../src/twilio');
const sent = { sms: [], calls: [] };
tw.ensureVoiceSetup = async () => {};
tw.syncNumbers = async () => [];
tw.sendSms = async (p) => { sent.sms.push(p); return { sid: 'SM' + sent.sms.length, status: 'queued' }; };
tw.startAiCall = async (p) => { sent.calls.push({ type: 'ai', ...p }); return { sid: 'CAai' + p.callId, status: 'queued' }; };
tw.startClickToCall = async (p) => { sent.calls.push({ type: 'c2c', ...p }); return { sid: 'CAc2c' + p.callId, status: 'queued' }; };
const { run } = require('../src/db');
run("INSERT INTO phone_numbers (number, friendly_name, twilio_sid, inbound_mode) VALUES ('+12545550100', 'Main line', 'PN1', 'ring_all')");
run("INSERT INTO phone_numbers (number, friendly_name, twilio_sid, inbound_mode) VALUES ('+12545550199', 'AI line', 'PN2', 'ai')");

require('../src/server');
const twilio = require('twilio');
const WebSocket = require('ws');
const base = `http://localhost:${PORT}`;

let cookie = '';
async function api(path, body, method) {
  const r = await fetch(base + '/api' + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
}
async function hook(path, params, { badSig = false } = {}) {
  const url = base + path;
  const sig = badSig ? 'nope' : twilio.getExpectedTwilioSignature('testtoken', url, params);
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
}
async function mcp(token, method, params, id = 1) {
  const r = await fetch(`${base}/mcp/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : null };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

(async () => {
  await sleep(500);
  console.log('Auth');
  assert.equal((await api('/me')).status, 401); ok('blocked when logged out');
  assert.equal((await api('/login', { email: 'joseph@test.com', password: 'wrong' })).status, 401); ok('wrong password rejected');
  const login = await api('/login', { email: 'JOSEPH@test.com', password: 'password123' });
  assert.equal(login.status, 200); ok('admin login (case-insensitive email)');
  const me = await api('/me');
  assert.equal(me.data.numbers.length, 2); assert.equal(me.data.user.role, 'admin'); ok('/me returns numbers');
  const tok = await api('/token');
  assert.ok(tok.data.token.split('.').length === 3); ok('browser phone access token issued');
  const jwt = JSON.parse(Buffer.from(tok.data.token.split('.')[1], 'base64url').toString());
  assert.equal(jwt.grants.identity, me.data.user.identity); assert.ok(jwt.grants.voice.incoming.allow); ok('token has voice grant + identity');

  console.log('Team');
  const u = await api('/admin/users', { name: 'Stephanie', email: 'steph@test.com', password: 'temppass123', cell_phone: '254-555-0111', default_number_id: 1 });
  assert.equal(u.status, 200); assert.equal(u.data.cell_phone, '+12545550111'); ok('admin adds teammate with E.164 cell');
  await api('/me', { cell_phone: '832-503-5866' }); ok('set own cell');

  console.log('Webhook security');
  assert.equal((await hook('/twilio/sms/incoming', { From: '+15125550000', To: '+12545550100', Body: 'x', MessageSid: 'SMbad' }, { badSig: true })).status, 403); ok('bad Twilio signature rejected');

  console.log('Texting');
  const inbound = await hook('/twilio/sms/incoming', { From: '+15125551234', To: '+12545550100', Body: 'Hi, did you get my photos?', MessageSid: 'SMin1', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME1' });
  assert.equal(inbound.status, 200); assert.ok(inbound.text.includes('<Response')); ok('inbound text accepted');
  await hook('/twilio/sms/incoming', { From: '+15125551234', To: '+12545550100', Body: 'dup', MessageSid: 'SMin1' }); // duplicate retry
  let threads = (await api('/threads')).data;
  assert.equal(threads.length, 1); assert.equal(threads[0].unread, 1); assert.equal(threads[0].total, 1); ok('thread listed with unread count, duplicates ignored');
  await api('/contacts', { name: 'Maria Lopez', phone: '(512) 555-1234', company: 'Homeowner', notes: 'Invoice 1042 outstanding' });
  threads = (await api('/threads')).data;
  assert.equal(threads[0].contact_name, 'Maria Lopez'); ok('contact name shown on thread');
  const sentMsg = await api('/messages', { to: '5125551234', body: 'Yes, got them — thanks!' });
  assert.equal(sentMsg.status, 200); assert.equal(sent.sms[0].from, '+12545550100'); assert.equal(sent.sms[0].to, '+15125551234'); ok('reply sends from default line');
  const thread = (await api('/threads/%2B15125551234')).data;
  assert.equal(thread.length, 2); assert.equal(thread[0].media.length, 1); ok('thread has both messages + MMS media');
  assert.equal((await api('/threads?unread=1')).data.length, 0); ok('opening thread marks read');
  await hook('/twilio/sms/status', { MessageSid: 'SM1', MessageStatus: 'delivered' });
  assert.equal((await api('/threads/%2B15125551234')).data[1].status, 'delivered'); ok('delivery status updates');

  console.log('Browser phone calls');
  let tw1 = await hook('/twilio/voice/client', { From: `client:${me.data.user.identity}`, To: '+15125551234', CallSid: 'CAout1', CallerId: '+12545550199' });
  assert.ok(tw1.text.includes('callerId="+12545550199"') && tw1.text.includes('<Number>+15125551234</Number>')); ok('outbound call dials with chosen caller ID');
  tw1 = await hook('/twilio/voice/client', { From: `client:${me.data.user.identity}`, To: '+15125551234', CallSid: 'CAout2', CallerId: '+19995550000' });
  assert.ok(tw1.text.includes('not one of your phone numbers')); ok('spoofed caller ID refused');
  await hook('/twilio/voice/status', { CallSid: 'CAout1', CallStatus: 'completed', CallDuration: '95' });
  let calls = (await api('/calls')).data;
  const c1 = calls.find((c) => c.call_sid === 'CAout1');
  assert.equal(c1.status, 'completed'); assert.equal(c1.duration, 95); assert.equal(c1.contact_name, 'Maria Lopez'); ok('call logged with status, duration, contact');

  console.log('Inbound calls');
  const inc = await hook('/twilio/voice/incoming', { From: '+15125559999', To: '+12545550100', CallSid: 'CAin1' });
  assert.ok(inc.text.includes('<Client') && inc.text.includes('stephanie') && inc.text.includes('joseph_dittman')); ok('ring_all rings every available teammate');
  const inCall = (await api('/calls')).data.find((c) => c.call_sid === 'CAin1');
  const missed = await hook(`/twilio/voice/dial-done?callId=${inCall.id}&stage=inbound`, { DialCallStatus: 'no-answer' });
  assert.ok(missed.text.includes('<Record')); ok('nobody answers → voicemail');
  await hook(`/twilio/voice/voicemail?callId=${inCall.id}`, { RecordingUrl: 'https://api.twilio.com/rec/RE1', RecordingSid: 'RE1', RecordingDuration: '12' });
  await hook(`/twilio/voice/voicemail-text?callId=${inCall.id}`, { TranscriptionText: 'Call me back about my roof' });
  await hook('/twilio/voice/status', { CallSid: 'CAin1', CallStatus: 'completed', CallDuration: '30' });
  const vm = (await api('/calls/' + inCall.id)).data;
  assert.equal(vm.voicemail, 1); assert.equal(vm.status, 'voicemail'); assert.ok(vm.summary.includes('roof')); ok('voicemail saved with transcription (status kept)');

  // AI backup when nobody answers
  await api('/admin/numbers/1', { ai_agent_id: 1, ai_on_no_answer: true });
  await hook('/twilio/voice/incoming', { From: '+15125558888', To: '+12545550100', CallSid: 'CAin2' });
  const in2 = (await api('/calls')).data.find((c) => c.call_sid === 'CAin2');
  const aiBackup = await hook(`/twilio/voice/dial-done?callId=${in2.id}&stage=inbound`, { DialCallStatus: 'no-answer' });
  assert.ok(aiBackup.text.includes('<ConversationRelay') && aiBackup.text.includes('ElevenLabs')); ok('nobody answers → AI agent picks up (ConversationRelay + ElevenLabs)');

  // Away teammate is skipped
  await api('/me', { status: 'away' });
  const inc3 = await hook('/twilio/voice/incoming', { From: '+15125557777', To: '+12545550100', CallSid: 'CAin3' });
  assert.ok(!inc3.text.includes('joseph_dittman') && inc3.text.includes('stephanie')); ok('"Away" teammate is skipped');
  await api('/me', { status: 'available' });

  console.log('AI agent — inbound AI line');
  const aiIn = await hook('/twilio/voice/incoming', { From: '+15125551234', To: '+12545550199', CallSid: 'CAai-in' });
  assert.ok(aiIn.text.includes('welcomeGreeting="Thanks for calling Rise Public Adjusting')); ok('AI line answers with greeting');
  const keyMatch = aiIn.text.match(/name="key" value="([^"]+)"/);
  const callIdMatch = aiIn.text.match(/name="callId" value="(\d+)"/);

  // Bad key is rejected
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ai/relay`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'setup', callSid: 'x', customParameters: { key: 'wrong', callId: callIdMatch[1] } })));
    ws.on('close', () => { ok('relay rejects bad key'); resolve(); });
  });

  // Real conversation: caller asks, agent takes a message, then ends call
  aiScript = [
    { text: 'Sure, I can take a message for Joseph. What is it about?', tool: null },
    { text: 'Got it, I will pass that along.', tool: { name: 'take_message', input: { caller_name: 'Maria Lopez', message: 'Wants to know when the appraisal award will be signed.' } } },
    { text: '' , tool: { name: 'end_call', input: { outcome: 'Message taken' } } },
  ];
  const frames = [];
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ai/relay`);
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'setup', callSid: 'CAai-in', from: '+15125551234', to: '+12545550199', customParameters: { key: keyMatch[1], callId: callIdMatch[1], greeted: '1' } }));
      await sleep(100);
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Hi, can I leave a message for Joseph?', last: true }));
      await sleep(400);
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Tell him Maria called about when the award gets signed. Thanks, bye.', last: true }));
    });
    const iv = setInterval(() => { if (frames.find((f) => f.type === 'end')) { clearInterval(iv); ws.close(); setTimeout(resolve, 300); } }, 100);
  });
  const spoken = frames.filter((f) => f.type === 'text').map((f) => f.token).join('');
  assert.ok(spoken.includes('take a message for Joseph')); ok('Claude reply streamed to Twilio as text tokens');
  assert.ok(frames.some((f) => f.type === 'text' && f.last === true)); ok('turns finished with last=true');
  const end = frames.find((f) => f.type === 'end');
  assert.equal(JSON.parse(end.handoffData).reason, 'hangup'); ok('end_call tool hangs up via ConversationRelay end');
  const sys = aiRequests.find((r) => r.stream).system;
  assert.ok(sys.includes('LIVE PHONE CALL') && sys.includes('Maria Lopez') && sys.includes('Invoice 1042')); ok('system prompt includes contact name + notes');
  const firstReq = aiRequests.find((r) => r.stream);
  assert.equal(firstReq.messages[1].content, 'Thanks for calling Rise Public Adjusting, this is the virtual assistant. How can I help you today?'); ok('greeting is in conversation history');
  const third = aiRequests.filter((r) => r.stream)[2];
  assert.ok(third.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))); ok('tool results sent back to Claude');
  await sleep(300);
  const aiCallRow = (await api('/calls/' + callIdMatch[1])).data;
  assert.ok(aiCallRow.notes.includes('award')); ok('take_message saved to call notes');
  assert.ok(aiCallRow.transcript.length >= 3); ok('transcript saved');
  assert.ok(aiCallRow.summary.includes('Friday')); assert.equal(aiCallRow.outcome, 'Message taken'); ok('AI summary + outcome saved after call');
  const doneTwiml = await hook(`/twilio/voice/ai-done?callId=${callIdMatch[1]}`, { SessionStatus: 'ended', HandoffData: end.handoffData });
  assert.ok(doneTwiml.text.includes('<Hangup')); ok('action URL hangs up');

  console.log('AI agent — outbound with interruption + transfer');
  const start = await api('/ai-calls', { agentId: 2, to: '512-555-1234', context: 'Calling Maria about invoice #1042 for $1,850, sent Oct 20.' });
  assert.equal(start.status, 200); assert.equal(sent.calls.at(-1).to, '+15125551234'); ok('AI call placed via Twilio');
  const outTw = await hook(`/twilio/voice/ai-outbound?callId=${start.data.id}`, { CallSid: start.data.call_sid });
  assert.ok(outTw.text.includes('<ConversationRelay') && !outTw.text.includes('welcomeGreeting')); ok('outbound AI: Claude opens (no canned greeting)');
  const key2 = outTw.text.match(/name="key" value="([^"]+)"/)[1];
  aiRequests.length = 0;
  aiScript = [
    { text: 'Hi, this is the virtual assistant calling from Rise Public Adjusting. Is this Maria?', delay: 0 },
    { text: 'Great. I am calling about invoice ten forty two for one thousand eight hundred fifty dollars and wanted to see', delay: 0 },
    { text: 'Of course, let me connect you with someone now.', tool: { name: 'transfer_to_human', input: { reason: 'Wants to talk to a person' } } },
  ];
  const f2 = [];
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ai/relay`);
    ws.on('message', (d) => f2.push(JSON.parse(d.toString())));
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'setup', callSid: start.data.call_sid, customParameters: { key: key2, callId: String(start.data.id), greeted: '0' } }));
      await sleep(300);
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Yes this is Maria.', last: true }));
      await sleep(300);
      ws.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: 'Great. I am calling about invoice ten forty two', durationUntilInterruptMs: 2000 }));
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Can I just talk to a real person?', last: true }));
    });
    const iv = setInterval(() => { if (f2.find((f) => f.type === 'end')) { clearInterval(iv); ws.close(); setTimeout(resolve, 300); } }, 100);
  });
  const streamed = aiRequests.filter((r) => r.stream);
  assert.ok(streamed[0].messages[0].content.includes('Begin the conversation')); ok('Claude speaks first on outbound');
  assert.ok(streamed[0].system.includes('invoice #1042')); ok('per-call context in prompt');
  const last = streamed.at(-1).messages;
  const interrupted = last.find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.endsWith('—'));
  assert.ok(interrupted && interrupted.content.startsWith('Great. I am calling about invoice ten forty two')); ok('interruption trims history to what caller actually heard');
  const roles = last.map((m) => m.role).join(',');
  assert.ok(!/user,user|assistant,assistant/.test(roles)); ok('message roles alternate correctly');
  const end2 = f2.find((f) => f.type === 'end');
  assert.equal(JSON.parse(end2.handoffData).reason, 'transfer'); ok('transfer_to_human hands off');
  const xfer = await hook(`/twilio/voice/ai-done?callId=${start.data.id}`, { SessionStatus: 'ended', HandoffData: end2.handoffData });
  assert.ok(xfer.text.includes('<Dial') && xfer.text.includes('<Client')); ok('transfer rings the team in the browser');

  console.log('Click-to-call');
  const c2c = await api('/click-to-call', { to: '5125551234' });
  assert.equal(c2c.status, 200); assert.equal(sent.calls.at(-1).userCell, '+18325035866'); ok('rings my cell first');
  const bridge = await hook(`/twilio/voice/bridge?callId=${c2c.data.id}`, {});
  assert.ok(bridge.text.includes('<Number>+15125551234</Number>') && bridge.text.includes('callerId="+12545550100"')); ok('then bridges to the other person from the business line');

  console.log('Claude connector (MCP)');
  const settings = (await api('/admin/settings')).data;
  const token = settings.mcp_url.split('/mcp/')[1];
  assert.equal((await mcp('wrong', 'tools/list', {})).status, 401); ok('bad connector token rejected');
  const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.data.result.serverInfo.name, 'rise-dialer'); ok('MCP initialize');
  const tools = (await mcp(token, 'tools/list', {})).data.result.tools.map((t) => t.name);
  for (const t of ['send_text', 'list_text_threads', 'get_text_thread', 'list_calls', 'get_call', 'start_ai_call', 'click_to_call', 'save_ai_agent']) assert.ok(tools.includes(t), t);
  ok(`MCP lists ${tools.length} tools`);
  const callTool = async (name, args) => { const r = await mcp(token, 'tools/call', { name, arguments: args }); return r.data.result; };
  let r = await callTool('send_text', { to: '(512) 555-1234', body: 'From Claude: your award is signed.' });
  assert.ok(!r.isError, JSON.stringify(r)); assert.equal(sent.sms.at(-1).body, 'From Claude: your award is signed.'); ok('Claude sends a text');
  r = await callTool('list_text_threads', {});
  assert.ok(JSON.parse(r.content[0].text)[0].contact_name === 'Maria Lopez'); ok('Claude reads threads');
  r = await callTool('list_calls', { kind: 'ai' });
  const aiCalls = JSON.parse(r.content[0].text);
  assert.ok(aiCalls.some((c) => c.summary && c.summary.includes('Friday'))); ok('Claude reads AI call summaries');
  r = await callTool('start_ai_call', { to: '5125551234', context: 'Ask whether she has the signed award.', agent: 'follow' });
  assert.ok(!r.isError, JSON.stringify(r)); assert.ok(JSON.parse(r.content[0].text).call_id); ok('Claude starts an AI call (agent matched by partial name)');
  r = await callTool('click_to_call', { to: '5125551234', user: 'Stephanie' });
  assert.ok(!r.isError); assert.equal(sent.calls.at(-1).userCell, '+12545550111'); ok('Claude connects a teammate via click-to-call');
  r = await callTool('send_text', { to: '5125551234', body: 'x', from: '+19998887777' });
  assert.ok(r.isError); ok('tool errors come back cleanly');

  console.log('Dashboard');
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('Rise Dialer')); ok('dashboard served');
  assert.equal((await fetch(base + '/vendor/twilio.min.js')).status, 200); ok('Twilio Voice SDK served');

  console.log(`\nAll ${passed} checks passed.`);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });

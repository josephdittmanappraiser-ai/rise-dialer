// Webhooks Twilio calls when phones ring, calls end, and texts arrive.
const express = require('express');
const config = require('../config');
const { get, all, getSetting } = require('../db');
const tw = require('../twilio');
const svc = require('../services');
const { broadcast } = require('../events');
const { e164, prettyPhone, safeJson } = require('../util');

const router = express.Router();
const { VoiceResponse, MessagingResponse } = tw.twilio.twiml;
router.use(express.urlencoded({ extended: false }));
router.use(tw.validateTwilio);

const TERMINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
const sendTwiml = (res, twiml) => res.type('text/xml').send(twiml.toString());

// ConversationRelay TwiML that hands the call to the AI agent.
function aiTwiml(twiml, agent, callRow) {
  const greetFirst = Boolean(agent.greeting) && !callRow.ai_context && callRow.direction === 'inbound';
  const connect = twiml.connect({ action: tw.url(`/twilio/voice/ai-done?callId=${callRow.id}`) });
  const relay = connect.conversationRelay({
    url: `${config.wsUrl}/ai/relay`,
    ttsProvider: 'ElevenLabs',
    voice: agent.voice || config.ai.defaultVoice,
    transcriptionProvider: 'Deepgram',
    language: 'en-US',
    interruptible: 'any',
    dtmfDetection: 'true',
    ...(greetFirst ? { welcomeGreeting: agent.greeting } : {}),
  });
  relay.parameter({ name: 'callId', value: String(callRow.id) });
  relay.parameter({ name: 'key', value: getSetting('relay_key') });
  relay.parameter({ name: 'greeted', value: greetFirst ? '1' : '0' });
  return twiml;
}

function voicemailTwiml(twiml, callRow) {
  twiml.say({ voice: 'Polly.Joanna-Neural' }, `Sorry we missed your call. Please leave your name, number and a short message after the tone.`);
  twiml.record({
    maxLength: 180, playBeep: true, trim: 'trim-silence',
    action: tw.url(`/twilio/voice/voicemail?callId=${callRow.id}`),
    transcribe: true, transcribeCallback: tw.url(`/twilio/voice/voicemail-text?callId=${callRow.id}`),
  });
  twiml.hangup();
  return twiml;
}

// Who rings when a call comes in (or the AI transfers). Twilio allows up to 10 at once;
// everyone rings together and the first to answer gets the caller.
const MAX_LEGS = 10;
function ringTargets(numberRow) {
  if (numberRow.ring_group_enabled) {
    const ids = safeJson(numberRow.ring_group_user_ids, []).map(Number).filter(Boolean);
    const users = ids.length
      ? all(`SELECT * FROM users WHERE active = 1 AND status = 'available' AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids)
      : [];
    const extra = safeJson(numberRow.ring_group_extra, []).map(e164).filter(Boolean);
    return { users, ringCells: Boolean(numberRow.ring_group_cells), extra };
  }
  let users = [];
  if (numberRow.inbound_mode === 'user' && numberRow.assigned_user_id) {
    users = all('SELECT * FROM users WHERE id = ? AND active = 1', numberRow.assigned_user_id);
  } else {
    users = all("SELECT * FROM users WHERE active = 1 AND status = 'available' ORDER BY id LIMIT 10");
  }
  return { users, ringCells: false, extra: [] };
}
const hasTargets = (t) => t.users.length > 0 || t.extra.length > 0;

function dialTeam(twiml, { callerId, targets, callRow, stage }) {
  const dial = twiml.dial({
    timeout: 30,
    answerOnBridge: true,
    action: tw.url(`/twilio/voice/dial-done?callId=${callRow.id}&stage=${stage}`),
    ...(callerId ? { callerId } : {}),
    ...(config.recordCalls ? { record: 'record-from-answer-dual', recordingStatusCallback: tw.url('/twilio/voice/recording') } : {}),
  });
  const seen = new Set();
  let legs = 0;
  const addCell = (num, userId) => {
    const n = e164(num);
    if (!n || seen.has(n) || legs >= MAX_LEGS) return;
    seen.add(n); legs++;
    // Cell phones must press 1 first, so a cell's own voicemail can't "answer" and grab the call.
    dial.number({
      url: tw.url(`/twilio/voice/screen?callId=${callRow.id}${userId ? `&userId=${userId}` : ''}`), method: 'POST',
    }, n);
  };
  for (const u of targets.users) {
    if (legs >= MAX_LEGS) break;
    dial.client({ statusCallback: tw.url('/twilio/voice/leg-status'), statusCallbackEvent: 'answered' }, u.identity);
    legs++;
    if ((targets.ringCells || u.ring_cell) && u.cell_phone) addCell(u.cell_phone, u.id);
  }
  for (const n of targets.extra) addCell(n, null);
  return twiml;
}

// ---- Browser phone: outbound calls -----------------------------------
router.post('/voice/client', (req, res) => {
  const twiml = new VoiceResponse();
  const identity = String(req.body.From || '').replace(/^client:/, '');
  const user = get('SELECT * FROM users WHERE identity = ? AND active = 1', identity);
  if (!user) { twiml.say('This phone is not linked to an active user.'); return sendTwiml(res, twiml); }

  const to = String(req.body.To || '').trim();
  const internal = get('SELECT * FROM users WHERE identity = ?', to.replace(/^client:/, ''));
  if (internal) {
    twiml.dial({ answerOnBridge: true }).client(internal.identity);
    return sendTwiml(res, twiml);
  }

  const toNum = e164(to);
  let fromNum;
  try { fromNum = svc.pickFromNumber(req.body.CallerId, user); } catch (e) { twiml.say(e.message); return sendTwiml(res, twiml); }
  const row = svc.createCallRow({
    call_sid: req.body.CallSid, direction: 'outbound', kind: 'human', from_number: fromNum, to_number: toNum,
    our_number: fromNum, other_number: toNum, user_id: user.id, status: 'ringing',
  });
  const dial = twiml.dial({
    callerId: fromNum, answerOnBridge: true, timeout: 45,
    action: tw.url(`/twilio/voice/dial-done?callId=${row.id}&stage=outbound`),
    ...(config.recordCalls ? { record: 'record-from-answer-dual', recordingStatusCallback: tw.url('/twilio/voice/recording') } : {}),
  });
  dial.number(toNum);
  sendTwiml(res, twiml);
});

// ---- Someone calls one of our numbers ---------------------------------
router.post('/voice/incoming', (req, res) => {
  const twiml = new VoiceResponse();
  const ourNum = e164(req.body.To);
  const caller = e164(req.body.From);
  const num = svc.numberRow(ourNum) || { inbound_mode: 'ring_all', number: ourNum };
  let agent = num.ai_agent_id ? get('SELECT * FROM ai_agents WHERE id = ? AND active = 1', num.ai_agent_id) : null;
  if (!agent && num.inbound_mode === 'ai') agent = svc.findAgent(); // AI line with no agent picked: use the first active one

  const row = svc.createCallRow({
    call_sid: req.body.CallSid, direction: 'inbound', kind: num.inbound_mode === 'ai' && agent ? 'ai' : 'human',
    from_number: caller, to_number: ourNum, our_number: ourNum, other_number: caller,
    ai_agent_id: agent?.id, status: 'ringing',
  });

  if (num.inbound_mode === 'ai' && agent) return sendTwiml(res, aiTwiml(twiml, agent, row));

  const targets = ringTargets(num);
  if (!hasTargets(targets)) {
    if (agent && num.ai_on_no_answer) { svc.updateCall(row.id, { kind: 'ai' }); return sendTwiml(res, aiTwiml(twiml, agent, svc.getCall(row.id))); }
    return sendTwiml(res, voicemailTwiml(twiml, row));
  }
  // Show the caller's number (not ours) on the team's screens.
  sendTwiml(res, dialTeam(twiml, { callerId: caller, targets, callRow: row, stage: 'inbound' }));
});

// Which teammate picked up an inbound call.
router.post('/voice/leg-status', (req, res) => {
  const parent = req.body.ParentCallSid && svc.callBySid(req.body.ParentCallSid);
  const identity = String(req.body.To || '').replace(/^client:/, '');
  if (parent && req.body.CallStatus === 'in-progress') {
    const u = get('SELECT id FROM users WHERE identity = ?', identity);
    if (u) svc.updateCall(parent.id, { user_id: u.id, status: 'in-progress' });
  }
  res.sendStatus(204);
});

// A cell phone in the ring group picked up: make sure a person (not voicemail) is there.
router.post('/voice/screen', (req, res) => {
  const twiml = new VoiceResponse();
  const row = svc.getCall(Number(req.query.callId));
  const who = row ? (row.contact_name || prettyPhone(row.other_number)).replace(/[()]/g, '') : 'a caller';
  const gather = twiml.gather({
    numDigits: 1, timeout: 8,
    action: tw.url(`/twilio/voice/screen-result?callId=${req.query.callId || ''}${req.query.userId ? `&userId=${req.query.userId}` : ''}`), method: 'POST',
  });
  gather.say({ voice: 'Polly.Joanna-Neural' }, `Business call from ${who}. Press 1 to take it.`);
  twiml.hangup(); // no key pressed (voicemail or ignored) → drop this leg; the others keep ringing
  sendTwiml(res, twiml);
});

router.post('/voice/screen-result', (req, res) => {
  const twiml = new VoiceResponse();
  if (req.body.Digits === '1') {
    const row = svc.getCall(Number(req.query.callId));
    if (row && req.query.userId) svc.updateCall(row.id, { user_id: Number(req.query.userId), status: 'in-progress' });
    return sendTwiml(res, twiml); // empty response = connect this person to the caller
  }
  twiml.hangup();
  sendTwiml(res, twiml);
});

// After a <Dial> finishes (answered, or nobody picked up).
router.post('/voice/dial-done', (req, res) => {
  const twiml = new VoiceResponse();
  const row = svc.getCall(Number(req.query.callId));
  const status = req.body.DialCallStatus;
  const stage = req.query.stage;
  if (!row) { twiml.hangup(); return sendTwiml(res, twiml); }

  if (status === 'completed' || status === 'answered') {
    svc.updateCall(row.id, { status: 'completed', duration: Number(req.body.DialCallDuration || 0) });
    twiml.hangup();
    return sendTwiml(res, twiml);
  }

  if (stage === 'inbound' || stage === 'transfer') {
    const num = svc.numberRow(row.our_number);
    const agent = num && num.ai_agent_id ? get('SELECT * FROM ai_agents WHERE id = ? AND active = 1', num.ai_agent_id) : null;
    if (stage === 'inbound' && agent && num.ai_on_no_answer) {
      svc.updateCall(row.id, { kind: 'ai', ai_agent_id: agent.id });
      return sendTwiml(res, aiTwiml(twiml, agent, svc.getCall(row.id)));
    }
    svc.updateCall(row.id, { status: 'missed' });
    return sendTwiml(res, voicemailTwiml(twiml, row));
  }

  svc.updateCall(row.id, { status: status || 'failed', ended_at: new Date().toISOString() });
  twiml.hangup();
  sendTwiml(res, twiml);
});

router.post('/voice/voicemail', (req, res) => {
  const row = svc.getCall(Number(req.query.callId));
  if (row && req.body.RecordingUrl && Number(req.body.RecordingDuration || 0) > 0) {
    svc.updateCall(row.id, { voicemail: 1, status: 'voicemail', recording_sid: req.body.RecordingSid, recording_url: req.body.RecordingUrl });
    svc.notifySlack(`:mailbox_with_mail: *New voicemail* from ${row.contact_name || prettyPhone(row.other_number)} on ${prettyPhone(row.our_number)}`);
  }
  const twiml = new VoiceResponse();
  twiml.hangup();
  sendTwiml(res, twiml);
});

router.post('/voice/voicemail-text', (req, res) => {
  const row = svc.getCall(Number(req.query.callId));
  if (row && req.body.TranscriptionText) {
    svc.updateCall(row.id, { summary: `Voicemail: ${req.body.TranscriptionText}` });
    svc.notifySlack(`:mailbox_with_mail: Voicemail from ${row.contact_name || prettyPhone(row.other_number)}: "${req.body.TranscriptionText}"`);
  }
  res.sendStatus(204);
});

// ---- AI calls -----------------------------------------------------------
router.post('/voice/ai-outbound', (req, res) => {
  const twiml = new VoiceResponse();
  const row = svc.getCall(Number(req.query.callId));
  const agent = row && get('SELECT * FROM ai_agents WHERE id = ?', row.ai_agent_id);
  if (!row || !agent) { twiml.hangup(); return sendTwiml(res, twiml); }
  sendTwiml(res, aiTwiml(twiml, agent, row));
});

// The AI session ended — hang up, or transfer to a person.
router.post('/voice/ai-done', (req, res) => {
  const twiml = new VoiceResponse();
  const row = svc.getCall(Number(req.query.callId));
  let handoff = {};
  try { handoff = JSON.parse(req.body.HandoffData || '{}'); } catch {}
  if (req.body.SessionStatus === 'failed') console.warn('[ai] session failed', req.body.ErrorCode, req.body.ErrorMessage);

  if (row && handoff.reason === 'transfer') {
    const agent = get('SELECT * FROM ai_agents WHERE id = ?', row.ai_agent_id);
    if (agent && agent.transfer_number) {
      twiml.dial({
        callerId: row.direction === 'inbound' ? row.other_number : row.our_number, answerOnBridge: true, timeout: 25,
        action: tw.url(`/twilio/voice/dial-done?callId=${row.id}&stage=transfer`),
      }).number(agent.transfer_number);
    } else {
      const num = svc.numberRow(row.our_number) || { inbound_mode: 'ring_all' };
      const targets = ringTargets(num);
      if (hasTargets(targets)) dialTeam(twiml, { callerId: row.direction === 'inbound' ? row.other_number : row.our_number, targets, callRow: row, stage: 'transfer' });
      else voicemailTwiml(twiml, row);
    }
    return sendTwiml(res, twiml);
  }
  twiml.hangup();
  sendTwiml(res, twiml);
});

// Click-to-call: the teammate answered their cell; now dial the other person.
router.post('/voice/bridge', (req, res) => {
  const twiml = new VoiceResponse();
  const row = svc.getCall(Number(req.query.callId));
  if (!row) { twiml.hangup(); return sendTwiml(res, twiml); }
  twiml.say({ voice: 'Polly.Joanna-Neural' }, `Connecting you to ${row.contact_name || 'your call'}.`);
  twiml.dial({
    callerId: row.our_number, answerOnBridge: true, timeout: 45,
    action: tw.url(`/twilio/voice/dial-done?callId=${row.id}&stage=outbound`),
    ...(config.recordCalls ? { record: 'record-from-answer-dual', recordingStatusCallback: tw.url('/twilio/voice/recording') } : {}),
  }).number(row.other_number);
  sendTwiml(res, twiml);
});

// ---- Call status + recordings -----------------------------------------
router.post('/voice/status', (req, res) => {
  const row = svc.callBySid(req.body.CallSid);
  if (row) {
    const status = req.body.CallStatus;
    const fields = {};
    const keep = ['missed', 'voicemail'].includes(row.status);
    if (!keep) fields.status = status;
    if (status === 'no-answer' && row.kind === 'ai') fields.outcome = row.outcome || 'No answer';
    if (status === 'busy' && row.kind === 'ai') fields.outcome = row.outcome || 'Busy';
    if (TERMINAL.includes(status)) {
      fields.ended_at = new Date().toISOString();
      if (req.body.CallDuration) fields.duration = Math.max(Number(req.body.CallDuration), row.duration || 0);
    }
    svc.updateCall(row.id, fields);
  }
  res.sendStatus(204);
});

router.post('/voice/recording', (req, res) => {
  const row = svc.callBySid(req.body.CallSid);
  if (row && req.body.RecordingStatus === 'completed' && !row.voicemail) {
    svc.updateCall(row.id, { recording_sid: req.body.RecordingSid, recording_url: req.body.RecordingUrl });
  }
  res.sendStatus(204);
});

// ---- Texting --------------------------------------------------------
router.post('/sms/incoming', (req, res) => {
  const b = req.body;
  const media = [];
  for (let i = 0; i < Number(b.NumMedia || 0); i++) if (b[`MediaUrl${i}`]) media.push(b[`MediaUrl${i}`]);
  const { run } = require('../db');
  const r = run(
    `INSERT OR IGNORE INTO messages (sid, direction, our_number, other_number, body, media, status, is_read)
     VALUES (?, 'inbound', ?, ?, ?, ?, 'received', 0)`,
    b.MessageSid, e164(b.To), e164(b.From), b.Body || '', JSON.stringify(media),
  );
  if (r.changes) {
    const row = get('SELECT * FROM messages WHERE id = ?', Number(r.lastInsertRowid));
    broadcast('message', svc.decorateMessage(row));
  }
  sendTwiml(res, new MessagingResponse());
});

router.post('/sms/status', (req, res) => {
  const { run } = require('../db');
  run('UPDATE messages SET status = ? WHERE sid = ?', req.body.MessageStatus || req.body.SmsStatus, req.body.MessageSid);
  const row = get('SELECT * FROM messages WHERE sid = ?', req.body.MessageSid);
  if (row) broadcast('message_status', { id: row.id, sid: row.sid, status: row.status, error: req.body.ErrorCode || null });
  res.sendStatus(204);
});

module.exports = router;

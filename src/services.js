// Shared actions used by the dashboard, the Claude connector, and the AI voice agent.
const { all, get, run, update } = require('./db');
const tw = require('./twilio');
const { broadcast } = require('./events');
const { e164, safeJson } = require('./util');
const config = require('./config');

// ---- numbers ------------------------------------------------------------
function listNumbers() {
  return all(`SELECT p.*, u.name AS assigned_user_name, a.name AS ai_agent_name
              FROM phone_numbers p
              LEFT JOIN users u ON u.id = p.assigned_user_id
              LEFT JOIN ai_agents a ON a.id = p.ai_agent_id
              ORDER BY p.id`);
}
function numberRow(number) { return get('SELECT * FROM phone_numbers WHERE number = ?', e164(number)); }

function pickFromNumber(requested, user) {
  if (requested) {
    const n = numberRow(requested);
    if (!n) throw new Error(`${requested} is not one of your phone numbers.`);
    return n.number;
  }
  if (user && user.default_number_id) {
    const n = get('SELECT number FROM phone_numbers WHERE id = ?', user.default_number_id);
    if (n) return n.number;
  }
  if (user) {
    const n = get('SELECT number FROM phone_numbers WHERE assigned_user_id = ? ORDER BY id LIMIT 1', user.id);
    if (n) return n.number;
  }
  const first = get('SELECT number FROM phone_numbers ORDER BY id LIMIT 1');
  if (!first) throw new Error('No phone numbers yet. Buy or sync one under Admin → Phone numbers.');
  return first.number;
}

// ---- contacts -----------------------------------------------------------
function contactByPhone(phone) { return get('SELECT * FROM contacts WHERE phone = ?', e164(phone)) || null; }
function searchContacts(q, limit = 25) {
  const like = `%${q || ''}%`;
  return all(`SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? OR company LIKE ? OR email LIKE ?
              ORDER BY name LIMIT ?`, like, like, like, like, limit);
}
function upsertContact({ id, name, phone, email, company, notes }) {
  const p = e164(phone);
  if (!p) throw new Error('A phone number is required.');
  const existing = id ? get('SELECT * FROM contacts WHERE id = ?', id) : contactByPhone(p);
  if (existing) {
    update('contacts', existing.id, { name, phone: p, email, company, notes }, ['name', 'phone', 'email', 'company', 'notes']);
    return get('SELECT * FROM contacts WHERE id = ?', existing.id);
  }
  const r = run('INSERT INTO contacts (name, phone, email, company, notes) VALUES (?, ?, ?, ?, ?)', name || null, p, email || null, company || null, notes || null);
  return get('SELECT * FROM contacts WHERE id = ?', Number(r.lastInsertRowid));
}

// ---- texting ------------------------------------------------------------
async function sendText({ to, body, from, user, sentBy, mediaUrl }) {
  const toNum = e164(to);
  if (!toNum) throw new Error('Missing "to" number.');
  if (!body && !(mediaUrl && mediaUrl.length)) throw new Error('Message is empty.');
  const fromNum = pickFromNumber(from, user);
  const msg = await tw.sendSms({ from: fromNum, to: toNum, body, mediaUrl });
  const r = run(
    `INSERT INTO messages (sid, direction, our_number, other_number, body, media, status, user_id, sent_by, is_read)
     VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, 1)`,
    msg.sid, fromNum, toNum, body || '', JSON.stringify(mediaUrl || []), msg.status, user ? user.id : null, sentBy || (user ? user.name : 'System'),
  );
  const row = get('SELECT * FROM messages WHERE id = ?', Number(r.lastInsertRowid));
  broadcast('message', decorateMessage(row));
  return row;
}

function decorateMessage(m) {
  const c = contactByPhone(m.other_number);
  return { ...m, media: safeJson(m.media, []), contact_name: c ? c.name : null };
}

function listThreads({ limit = 50, unreadOnly = false, ourNumber } = {}) {
  const rows = all(
    `SELECT m.other_number, m.our_number, MAX(m.created_at) AS last_at,
            SUM(CASE WHEN m.direction = 'inbound' AND m.is_read = 0 THEN 1 ELSE 0 END) AS unread,
            COUNT(*) AS total
     FROM messages m
     ${ourNumber ? 'WHERE m.our_number = ?' : ''}
     GROUP BY m.other_number, m.our_number
     ${unreadOnly ? 'HAVING unread > 0' : ''}
     ORDER BY last_at DESC LIMIT ?`,
    ...(ourNumber ? [e164(ourNumber)] : []), limit,
  );
  return rows.map((t) => {
    const last = get('SELECT body, direction, sent_by FROM messages WHERE other_number = ? AND our_number = ? ORDER BY created_at DESC, id DESC LIMIT 1', t.other_number, t.our_number);
    const c = contactByPhone(t.other_number);
    return { ...t, last_body: last?.body, last_direction: last?.direction, contact_name: c?.name || null, contact_company: c?.company || null };
  });
}

function getThread(other, our, { markRead = false, limit = 200 } = {}) {
  const o = e164(other);
  const params = [o];
  let where = 'other_number = ?';
  if (our) { where += ' AND our_number = ?'; params.push(e164(our)); }
  const rows = all(`SELECT * FROM (SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at, id`, ...params, limit);
  if (markRead) run(`UPDATE messages SET is_read = 1 WHERE ${where} AND direction = 'inbound'`, ...params);
  return rows.map(decorateMessage);
}

// ---- AI agents ----------------------------------------------------------
function listAgents() { return all('SELECT * FROM ai_agents ORDER BY name'); }
function findAgent(idOrName) {
  if (idOrName === undefined || idOrName === null || idOrName === '') return get('SELECT * FROM ai_agents WHERE active = 1 ORDER BY id LIMIT 1');
  if (/^\d+$/.test(String(idOrName))) return get('SELECT * FROM ai_agents WHERE id = ?', Number(idOrName));
  return get('SELECT * FROM ai_agents WHERE name = ? COLLATE NOCASE', String(idOrName))
      || get('SELECT * FROM ai_agents WHERE name LIKE ? COLLATE NOCASE', `%${idOrName}%`);
}
function upsertAgent({ id, name, greeting, instructions, voice, transfer_number, active }) {
  const fields = { name, greeting, instructions, voice: voice || null, transfer_number: transfer_number ? e164(transfer_number) : transfer_number, active: active === undefined ? undefined : (active ? 1 : 0) };
  const existing = id ? get('SELECT * FROM ai_agents WHERE id = ?', id) : (name ? get('SELECT * FROM ai_agents WHERE name = ? COLLATE NOCASE', name) : null);
  if (existing) {
    update('ai_agents', existing.id, fields, ['name', 'greeting', 'instructions', 'voice', 'transfer_number', 'active']);
    return get('SELECT * FROM ai_agents WHERE id = ?', existing.id);
  }
  if (!name || !instructions) throw new Error('An AI agent needs a name and instructions.');
  const r = run('INSERT INTO ai_agents (name, greeting, instructions, voice, transfer_number) VALUES (?, ?, ?, ?, ?)', name, greeting || null, instructions, fields.voice, fields.transfer_number || null);
  return get('SELECT * FROM ai_agents WHERE id = ?', Number(r.lastInsertRowid));
}

// ---- calls --------------------------------------------------------------
function createCallRow(fields) {
  const r = run(
    `INSERT INTO calls (call_sid, direction, kind, from_number, to_number, our_number, other_number, user_id, ai_agent_id, ai_context, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fields.call_sid || null, fields.direction, fields.kind || 'human', fields.from_number || null, fields.to_number || null,
    fields.our_number || null, fields.other_number || null, fields.user_id || null, fields.ai_agent_id || null, fields.ai_context || null, fields.status || 'initiated',
  );
  const row = getCall(Number(r.lastInsertRowid));
  broadcast('call', row);
  return row;
}

function updateCall(id, fields) {
  update('calls', id, fields, ['call_sid', 'status', 'duration', 'recording_sid', 'recording_url', 'voicemail', 'transcript', 'summary', 'outcome', 'notes', 'ended_at', 'user_id', 'ai_agent_id']);
  const row = getCall(id);
  broadcast('call', row);
  return row;
}

function getCall(id) {
  const c = get(`SELECT c.*, u.name AS user_name, a.name AS ai_agent_name
                 FROM calls c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN ai_agents a ON a.id = c.ai_agent_id
                 WHERE c.id = ?`, id);
  if (!c) return null;
  const contact = contactByPhone(c.other_number);
  return { ...c, transcript: safeJson(c.transcript, null), contact_name: contact?.name || null, has_recording: Boolean(c.recording_url) };
}
function callBySid(sid) { const r = get('SELECT id FROM calls WHERE call_sid = ?', sid); return r ? getCall(r.id) : null; }

function listCalls({ limit = 50, direction, kind, number, since, userId } = {}) {
  const where = []; const p = [];
  if (direction) { where.push('c.direction = ?'); p.push(direction); }
  if (kind) { where.push('c.kind = ?'); p.push(kind); }
  if (number) { where.push('c.other_number = ?'); p.push(e164(number)); }
  if (since) { where.push('c.started_at >= ?'); p.push(since); }
  if (userId) { where.push('c.user_id = ?'); p.push(userId); }
  const rows = all(`SELECT c.id FROM calls c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.started_at DESC, c.id DESC LIMIT ?`, ...p, limit);
  return rows.map((r) => {
    const c = getCall(r.id);
    delete c.transcript; // keep lists light
    return c;
  });
}

async function startAiCall({ agent: agentRef, to, from, context, user }) {
  const agent = findAgent(agentRef);
  if (!agent) throw new Error('No AI agent found. Create one under AI Agents first.');
  const toNum = e164(to);
  if (!toNum) throw new Error('Missing "to" number.');
  const fromNum = pickFromNumber(from, user);
  const row = createCallRow({
    direction: 'outbound', kind: 'ai', from_number: fromNum, to_number: toNum, our_number: fromNum, other_number: toNum,
    user_id: user?.id, ai_agent_id: agent.id, ai_context: context || null, status: 'queued',
  });
  try {
    const call = await tw.startAiCall({ from: fromNum, to: toNum, callId: row.id });
    return updateCall(row.id, { call_sid: call.sid, status: call.status });
  } catch (e) {
    updateCall(row.id, { status: 'failed', notes: e.message, ended_at: new Date().toISOString() });
    throw e;
  }
}

async function clickToCall({ user, to, from }) {
  if (!user?.cell_phone) throw new Error(`${user?.name || 'This user'} has no cell phone saved. Add it under Admin → Users.`);
  const toNum = e164(to);
  const fromNum = pickFromNumber(from, user);
  const row = createCallRow({ direction: 'outbound', kind: 'click_to_call', from_number: fromNum, to_number: toNum, our_number: fromNum, other_number: toNum, user_id: user.id, status: 'queued' });
  const call = await tw.startClickToCall({ from: fromNum, userCell: e164(user.cell_phone), to: toNum, callId: row.id });
  return updateCall(row.id, { call_sid: call.sid, status: call.status });
}

// ---- Slack --------------------------------------------------------------
async function notifySlack(text) {
  if (!config.slackWebhookUrl) return;
  try {
    await fetch(config.slackWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (e) { console.warn('[slack]', e.message); }
}

function findUser(ref) {
  if (!ref) return null;
  if (typeof ref === 'object') return ref;
  if (/^\d+$/.test(String(ref))) return get('SELECT * FROM users WHERE id = ?', Number(ref));
  return get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', ref) || get('SELECT * FROM users WHERE name LIKE ? COLLATE NOCASE', `%${ref}%`);
}

module.exports = {
  listNumbers, numberRow, pickFromNumber,
  contactByPhone, searchContacts, upsertContact,
  sendText, decorateMessage, listThreads, getThread,
  listAgents, findAgent, upsertAgent,
  createCallRow, updateCall, getCall, callBySid, listCalls, startAiCall, clickToCall,
  notifySlack, findUser,
};

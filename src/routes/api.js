// JSON API used by the web dashboard.
const express = require('express');
const config = require('../config');
const { all, get, run, update, getSetting, setSetting } = require('../db');
const auth = require('../auth');
const tw = require('../twilio');
const svc = require('../services');
const events = require('../events');
const { e164 } = require('../util');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[api]', req.method, req.path, e.message);
  res.status(e.status || 400).json({ error: e.message });
});

// ---- login --------------------------------------------------------------
const attempts = new Map();
router.post('/login', wrap((req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { email, password } = req.body || {};
  const user = get('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND active = 1', String(email || '').trim());
  if (!user || !auth.verifyPassword(String(password || ''), user.password_hash)) {
    a.n++; attempts.set(ip, a);
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  attempts.delete(ip);
  auth.setSessionCookie(res, auth.createSession(user.id));
  res.json({ user: auth.publicUser(user) });
}));

router.post('/logout', (req, res) => { auth.clearSessionCookie(req, res); res.json({ ok: true }); });

router.use(auth.requireUser);

router.get('/me', (req, res) => {
  res.json({
    user: auth.publicUser(req.user),
    numbers: svc.listNumbers(),
    twilioConfigured: tw.isConfigured(),
    aiConfigured: Boolean(config.ai.anthropicKey),
    businessName: getSetting('business_name') || config.businessName,
  });
});

router.post('/me', wrap((req, res) => {
  const { status, default_number_id, cell_phone, ring_cell, password } = req.body;
  update('users', req.user.id, {
    status: status && ['available', 'away'].includes(status) ? status : undefined,
    default_number_id: default_number_id === undefined ? undefined : (default_number_id || null),
    cell_phone: cell_phone === undefined ? undefined : e164(cell_phone) || null,
    ring_cell: ring_cell === undefined ? undefined : (ring_cell ? 1 : 0),
  }, ['status', 'default_number_id', 'cell_phone', 'ring_cell']);
  if (password) {
    if (String(password).length < 8) throw new Error('Password must be at least 8 characters.');
    run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), req.user.id);
  }
  res.json({ user: auth.publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id)) });
}));

router.get('/events', events.subscribe);

router.get('/token', wrap((req, res) => {
  res.json({ token: tw.accessToken(req.user.identity), identity: req.user.identity });
}));

// ---- texting ------------------------------------------------------------
router.get('/threads', (req, res) => {
  res.json(svc.listThreads({ limit: Number(req.query.limit || 100), unreadOnly: req.query.unread === '1', ourNumber: req.query.our || undefined }));
});
router.get('/threads/:other', (req, res) => {
  res.json(svc.getThread(req.params.other, req.query.our || undefined, { markRead: true }));
});
router.post('/messages', wrap(async (req, res) => {
  const { to, body, from } = req.body;
  res.json(await svc.sendText({ to, body, from, user: req.user }));
}));

// ---- calls --------------------------------------------------------------
router.get('/calls', (req, res) => {
  res.json(svc.listCalls({ limit: Number(req.query.limit || 100), direction: req.query.direction, kind: req.query.kind, number: req.query.number }));
});
router.get('/calls/:id', (req, res) => {
  const c = svc.getCall(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});
router.post('/calls/:id/notes', wrap((req, res) => {
  res.json(svc.updateCall(Number(req.params.id), { notes: String(req.body.notes || '') }));
}));

// Stream a call recording through the app (Twilio recordings need our credentials).
router.get('/calls/:id/recording', wrap(async (req, res) => {
  const c = svc.getCall(Number(req.params.id));
  if (!c || !c.recording_url) return res.status(404).json({ error: 'No recording' });
  const r = await fetch(`${c.recording_url}.mp3`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64') },
  });
  if (!r.ok) return res.status(502).json({ error: 'Could not load recording' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(Buffer.from(await r.arrayBuffer()));
}));

router.get('/media', wrap(async (req, res) => {
  const u = String(req.query.url || '');
  if (!/^https:\/\/api\.twilio\.com\//.test(u)) return res.status(400).json({ error: 'Bad media URL' });
  const r = await fetch(u, { headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64') } });
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  res.send(Buffer.from(await r.arrayBuffer()));
}));

router.post('/ai-calls', wrap(async (req, res) => {
  const { agentId, to, from, context } = req.body;
  res.json(await svc.startAiCall({ agent: agentId, to, from, context, user: req.user }));
}));

router.post('/click-to-call', wrap(async (req, res) => {
  const me = get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.json(await svc.clickToCall({ user: me, to: req.body.to, from: req.body.from }));
}));

// ---- contacts -----------------------------------------------------------
router.get('/contacts', (req, res) => res.json(svc.searchContacts(req.query.q || '', 500)));
router.post('/contacts', wrap((req, res) => res.json(svc.upsertContact(req.body))));
router.delete('/contacts/:id', (req, res) => { run('DELETE FROM contacts WHERE id = ?', Number(req.params.id)); res.json({ ok: true }); });

// ---- AI agents ----------------------------------------------------------
router.get('/agents', (req, res) => res.json(svc.listAgents()));
router.post('/agents', wrap((req, res) => res.json(svc.upsertAgent(req.body))));
router.delete('/agents/:id', auth.requireAdmin, (req, res) => {
  run('UPDATE phone_numbers SET ai_agent_id = NULL WHERE ai_agent_id = ?', Number(req.params.id));
  run('DELETE FROM ai_agents WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

router.get('/team', (req, res) => {
  res.json(all("SELECT id, name, identity, status FROM users WHERE active = 1 ORDER BY name"));
});

// ---- admin --------------------------------------------------------------
const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/users', (req, res) => res.json(auth.listUsers()));
admin.post('/users', wrap((req, res) => {
  const { id, name, email, password, role, cell_phone, default_number_id, active, ring_cell } = req.body;
  if (id) {
    update('users', id, {
      name, email, role, active: active === undefined ? undefined : (active ? 1 : 0),
      cell_phone: cell_phone === undefined ? undefined : (e164(cell_phone) || null),
      default_number_id: default_number_id === undefined ? undefined : (default_number_id || null),
      ring_cell: ring_cell === undefined ? undefined : (ring_cell ? 1 : 0),
    }, ['name', 'email', 'role', 'active', 'cell_phone', 'default_number_id', 'ring_cell']);
    if (password) run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), id);
    return res.json(auth.publicUser(get('SELECT * FROM users WHERE id = ?', id)));
  }
  if (!name || !email || !password) throw new Error('Name, email and a temporary password are required.');
  if (String(password).length < 8) throw new Error('Password must be at least 8 characters.');
  res.json(auth.publicUser(auth.createUser({ name, email, password, role: role === 'admin' ? 'admin' : 'agent', cell_phone: e164(cell_phone) || null, default_number_id: default_number_id || null })));
}));

admin.get('/numbers', (req, res) => res.json(svc.listNumbers()));
admin.post('/numbers/sync', wrap(async (req, res) => res.json(await tw.syncNumbers())));
admin.get('/numbers/search', wrap(async (req, res) => res.json(await tw.searchNumbers({ areaCode: req.query.areaCode, contains: req.query.contains, tollFree: req.query.tollFree === '1' }))));
admin.post('/numbers/buy', wrap(async (req, res) => res.json(await tw.buyNumber(req.body.number))));
admin.post('/numbers/:id', wrap((req, res) => {
  const { friendly_name, inbound_mode, assigned_user_id, ai_agent_id, ai_on_no_answer } = req.body;
  if (inbound_mode && !['user', 'ring_all', 'ai'].includes(inbound_mode)) throw new Error('Bad inbound mode');
  update('phone_numbers', Number(req.params.id), {
    friendly_name, inbound_mode,
    assigned_user_id: assigned_user_id === undefined ? undefined : (assigned_user_id || null),
    ai_agent_id: ai_agent_id === undefined ? undefined : (ai_agent_id || null),
    ai_on_no_answer: ai_on_no_answer === undefined ? undefined : (ai_on_no_answer ? 1 : 0),
  }, ['friendly_name', 'inbound_mode', 'assigned_user_id', 'ai_agent_id', 'ai_on_no_answer']);
  res.json(svc.listNumbers().find((n) => n.id === Number(req.params.id)));
}));

admin.get('/settings', (req, res) => {
  res.json({
    business_name: getSetting('business_name') || config.businessName,
    mcp_url: `${config.publicUrl}/mcp/${getSetting('mcp_token')}`,
    public_url: config.publicUrl,
    slack: Boolean(config.slackWebhookUrl),
    record_calls: config.recordCalls,
    voice_model: config.ai.voiceModel,
  });
});
admin.post('/settings', wrap((req, res) => {
  if (req.body.business_name) setSetting('business_name', String(req.body.business_name));
  res.json({ ok: true });
}));
admin.post('/settings/rotate-mcp', (req, res) => {
  const { randomToken } = require('../util');
  setSetting('mcp_token', randomToken(24));
  res.json({ mcp_url: `${config.publicUrl}/mcp/${getSetting('mcp_token')}` });
});

router.use('/admin', admin);

module.exports = router;

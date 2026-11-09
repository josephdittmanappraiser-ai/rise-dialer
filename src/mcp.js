// Claude connector (MCP). Add  https://YOUR-APP/mcp/<token>  as a custom connector in Claude
// and Claude can text, start AI calls, click-to-call, and read call logs, summaries and threads.
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const crypto = require('crypto');
const { getSetting, get, all } = require('./db');
const svc = require('./services');
const { prettyPhone } = require('./util');

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message || e}` }] });
const safe = (fn) => async (args) => { try { return ok(await fn(args || {})); } catch (e) { return fail(e); } };

function actingUser(ref) {
  const u = ref ? svc.findUser(ref) : get("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
  if (ref && !u) throw new Error(`No user matches "${ref}".`);
  return u;
}

function buildServer() {
  const server = new McpServer({ name: 'rise-dialer', version: '1.0.0' }, {
    instructions: 'Business phone system for calls and texts. Phone numbers can be given in any US format. ' +
      'Use list_text_threads / get_text_thread to read texts, send_text to reply, list_calls / get_call for call logs, AI summaries and transcripts, ' +
      'start_ai_call to have an AI agent phone someone with specific instructions, and click_to_call to ring a teammate\'s cell and connect them.',
  });

  server.registerTool('send_text', {
    title: 'Send a text message',
    description: 'Send an SMS from one of the business numbers. Defaults to the sending user\'s number.',
    inputSchema: {
      to: z.string().describe('Recipient phone number'),
      body: z.string().describe('Message text'),
      from: z.string().optional().describe('Which business number to send from (optional)'),
      as_user: z.string().optional().describe('Name or email of the teammate to send as (optional)'),
    },
  }, safe(async ({ to, body, from, as_user }) => {
    const user = actingUser(as_user);
    const m = await svc.sendText({ to, body, from, user, sentBy: `Claude (for ${user?.name || 'team'})` });
    return { sent: true, id: m.id, from: m.our_number, to: m.other_number, status: m.status };
  }));

  server.registerTool('list_text_threads', {
    title: 'List text conversations',
    description: 'Most recent text conversations with last message and unread count.',
    inputSchema: {
      unread_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  }, safe(({ unread_only, limit }) => svc.listThreads({ unreadOnly: !!unread_only, limit: limit || 30 })));

  server.registerTool('get_text_thread', {
    title: 'Read a text conversation',
    description: 'All texts with one phone number (newest last).',
    inputSchema: {
      phone: z.string(),
      mark_read: z.boolean().optional().describe('Mark inbound messages as read (default false)'),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  }, safe(({ phone, mark_read, limit }) => svc.getThread(phone, undefined, { markRead: !!mark_read, limit: limit || 100 })
    .map((m) => ({ at: m.created_at, direction: m.direction, from: m.direction === 'inbound' ? m.other_number : m.our_number, body: m.body, media: m.media, sent_by: m.sent_by, status: m.status }))));

  server.registerTool('list_calls', {
    title: 'List calls',
    description: 'Call log with status, duration, AI summary and outcome. Filter by direction, kind (human | ai | click_to_call), phone number, or since (ISO date).',
    inputSchema: {
      direction: z.enum(['inbound', 'outbound']).optional(),
      kind: z.enum(['human', 'ai', 'click_to_call']).optional(),
      phone: z.string().optional(),
      since: z.string().optional().describe('ISO date/time, e.g. 2026-11-01'),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  }, safe(({ direction, kind, phone, since, limit }) => svc.listCalls({ direction, kind, number: phone, since, limit: limit || 30 })
    .map((c) => ({ id: c.id, at: c.started_at, direction: c.direction, kind: c.kind, other: c.other_number, contact: c.contact_name, our_number: c.our_number, user: c.user_name, ai_agent: c.ai_agent_name, status: c.status, duration_sec: c.duration, voicemail: !!c.voicemail, outcome: c.outcome, summary: c.summary, notes: c.notes }))));

  server.registerTool('get_call', {
    title: 'Get call details',
    description: 'Full details of one call including the AI transcript, summary, notes and whether a recording exists.',
    inputSchema: { id: z.number().int() },
    annotations: { readOnlyHint: true },
  }, safe(({ id }) => {
    const c = svc.getCall(id);
    if (!c) throw new Error('Call not found');
    return c;
  }));

  server.registerTool('start_ai_call', {
    title: 'Have the AI agent call someone',
    description: 'Places an outbound phone call handled by an AI voice agent. Put everything the agent needs in "context": who they are calling, why, facts it may share (amounts, dates, claim numbers), and what a successful call looks like. The call summary appears in list_calls/get_call when it ends.',
    inputSchema: {
      to: z.string().describe('Number to call'),
      context: z.string().describe('Instructions and facts for this specific call'),
      agent: z.string().optional().describe('AI agent name or id (defaults to the first active agent)'),
      from: z.string().optional().describe('Business number to call from'),
    },
  }, safe(async ({ to, context, agent, from }) => {
    const c = await svc.startAiCall({ agent, to, from, context, user: actingUser() });
    return { started: true, call_id: c.id, to: c.other_number, from: c.our_number, agent: c.ai_agent_name, status: c.status, note: 'Use get_call with this call_id later for the transcript and summary.' };
  }));

  server.registerTool('click_to_call', {
    title: 'Connect a teammate to a call',
    description: 'Rings a teammate\'s cell phone; when they answer, it dials the other person from the business number (so the business number shows as caller ID).',
    inputSchema: {
      to: z.string().describe('Number to connect them to'),
      user: z.string().optional().describe('Teammate name or email (defaults to the admin)'),
      from: z.string().optional(),
    },
  }, safe(async ({ to, user, from }) => {
    const u = actingUser(user);
    const c = await svc.clickToCall({ user: u, to, from });
    return { started: true, call_id: c.id, ringing: `${u.name}'s cell ${prettyPhone(u.cell_phone)}`, then_dialing: c.other_number };
  }));

  server.registerTool('list_ai_agents', {
    title: 'List AI agents',
    description: 'The AI voice agents and their instructions.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, safe(() => svc.listAgents()));

  server.registerTool('save_ai_agent', {
    title: 'Create or update an AI agent',
    description: 'Create a new AI voice agent, or update one by id or exact name. Instructions are its standing job description (who it represents, what it may say, how to handle common situations).',
    inputSchema: {
      id: z.number().int().optional(),
      name: z.string().optional(),
      instructions: z.string().optional(),
      greeting: z.string().optional().describe('First line spoken on inbound calls'),
      voice: z.string().optional().describe('ElevenLabs voice ID (optional)'),
      transfer_number: z.string().optional().describe('Where to send calls that need a person; blank rings the team in the app'),
      active: z.boolean().optional(),
    },
  }, safe((args) => svc.upsertAgent(args)));

  server.registerTool('search_contacts', {
    title: 'Search contacts',
    inputSchema: { query: z.string() },
    annotations: { readOnlyHint: true },
  }, safe(({ query }) => svc.searchContacts(query)));

  server.registerTool('save_contact', {
    title: 'Create or update a contact',
    description: 'Matched by phone number.',
    inputSchema: {
      phone: z.string(), name: z.string().optional(), company: z.string().optional(), email: z.string().optional(), notes: z.string().optional(),
    },
  }, safe((args) => svc.upsertContact(args)));

  server.registerTool('list_team_and_numbers', {
    title: 'List team members and phone numbers',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, safe(() => ({
    users: all('SELECT id, name, email, role, status, cell_phone FROM users WHERE active = 1 ORDER BY name'),
    numbers: svc.listNumbers().map((n) => ({ number: n.number, name: n.friendly_name, inbound_mode: n.inbound_mode, assigned_to: n.assigned_user_name, ai_agent: n.ai_agent_name })),
  })));

  return server;
}

function tokenOk(given) {
  const real = getSetting('mcp_token') || '';
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(real);
  return real.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const router = express.Router();
router.use(express.json({ limit: '2mb' }));

async function handle(req, res) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tokenOk(req.params.token || bearer)) return res.status(401).json({ error: 'Bad connector token' });
  if (req.method !== 'POST') {
    return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

router.all('/:token', (req, res) => handle(req, res).catch((e) => {
  console.error('[mcp]', e);
  if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
}));
router.all('/', (req, res) => handle(req, res).catch(() => res.status(500).end()));

module.exports = router;

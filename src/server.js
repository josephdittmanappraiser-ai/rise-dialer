const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { getSetting, setSetting } = require('./db');
const { randomToken } = require('./util');
const auth = require('./auth');
const tw = require('./twilio');
const { attachRelay } = require('./ai/agent');

// One-time secrets kept in the database.
if (!getSetting('relay_key')) setSetting('relay_key', randomToken(24));
if (config.mcpToken) setSetting('mcp_token', config.mcpToken);
else if (!getSetting('mcp_token')) setSetting('mcp_token', randomToken(24));
auth.ensureAdmin();
require('./seed').seedAgents();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/twilio', require('./routes/twilio'));
app.use('/api', require('./routes/api'));
app.use('/mcp', require('./mcp'));

const voiceSdk = path.join(__dirname, '..', 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js');
app.get('/vendor/twilio.min.js', (req, res) => res.sendFile(voiceSdk));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*splat', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
attachRelay(wss);
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ai/relay')) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else socket.destroy();
});

server.listen(config.port, async () => {
  console.log(`Rise Dialer listening on ${config.port} — public URL ${config.publicUrl}`);
  if (!tw.isConfigured()) { console.warn('[twilio] Not configured yet — set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN'); return; }
  try {
    await tw.ensureVoiceSetup();
    await tw.syncNumbers();
    console.log('[twilio] Ready');
  } catch (e) {
    console.error('[twilio] Setup failed:', e.message);
  }
});

module.exports = { app, server };

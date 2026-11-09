// Everything that talks to Twilio's API lives here.
const twilio = require('twilio');
const config = require('./config');
const { getSetting, setSetting, get, all, run } = require('./db');

let _client = null;
function client() {
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    throw new Error('Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
  }
  if (!_client) _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return _client;
}
const isConfigured = () => Boolean(config.twilio.accountSid && config.twilio.authToken);

const url = (p) => `${config.publicUrl}${p}`;

// ---- Credentials for the browser phone ---------------------------------
// The browser softphone needs an API key + a "TwiML App". We create both on first start
// so you don't have to click around the Twilio console.
async function ensureVoiceSetup() {
  if (!isConfigured()) return;
  const c = client();

  let keySid = config.twilio.apiKeySid || getSetting('twilio_api_key_sid');
  let keySecret = config.twilio.apiKeySecret || getSetting('twilio_api_key_secret');
  if (!keySid || !keySecret) {
    const key = await c.newKeys.create({ friendlyName: 'Rise Dialer (browser phone)' });
    keySid = key.sid; keySecret = key.secret;
    setSetting('twilio_api_key_sid', keySid);
    setSetting('twilio_api_key_secret', keySecret);
    console.log('[twilio] Created API key for browser phone');
  }

  let appSid = config.twilio.twimlAppSid || getSetting('twilio_twiml_app_sid');
  const voiceUrl = url('/twilio/voice/client');
  if (!appSid) {
    const app = await c.applications.create({
      friendlyName: 'Rise Dialer',
      voiceUrl, voiceMethod: 'POST',
      statusCallback: url('/twilio/voice/status'), statusCallbackMethod: 'POST',
    });
    appSid = app.sid;
    setSetting('twilio_twiml_app_sid', appSid);
    console.log('[twilio] Created TwiML App', appSid);
  } else {
    // Keep the app pointed at the current public URL (e.g., after a domain change).
    try { await c.applications(appSid).update({ voiceUrl, voiceMethod: 'POST' }); } catch (e) { console.warn('[twilio] Could not update TwiML App:', e.message); }
  }
}

function voiceCreds() {
  return {
    keySid: config.twilio.apiKeySid || getSetting('twilio_api_key_sid'),
    keySecret: config.twilio.apiKeySecret || getSetting('twilio_api_key_secret'),
    appSid: config.twilio.twimlAppSid || getSetting('twilio_twiml_app_sid'),
  };
}

function accessToken(identity) {
  const { keySid, keySecret, appSid } = voiceCreds();
  if (!keySid || !keySecret || !appSid) throw new Error('Browser phone is not set up yet (Twilio credentials missing).');
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(config.twilio.accountSid, keySid, keySecret, { identity, ttl: 3600 });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: true }));
  return token.toJwt();
}

// ---- Webhook signature check -------------------------------------------
function validateTwilio(req, res, next) {
  if (!config.twilio.validateWebhooks) return next();
  const signature = req.headers['x-twilio-signature'];
  const fullUrl = url(req.originalUrl);
  const ok = signature && twilio.validateRequest(config.twilio.authToken, signature, fullUrl, req.body || {});
  if (!ok) {
    console.warn('[twilio] Rejected webhook with bad signature:', req.originalUrl);
    return res.status(403).send('Invalid Twilio signature');
  }
  next();
}

// ---- Phone numbers -------------------------------------------------------
async function configureNumberWebhooks(twilioSid) {
  await client().incomingPhoneNumbers(twilioSid).update({
    voiceUrl: url('/twilio/voice/incoming'), voiceMethod: 'POST',
    statusCallback: url('/twilio/voice/status'), statusCallbackMethod: 'POST',
    smsUrl: url('/twilio/sms/incoming'), smsMethod: 'POST',
  });
}

// Pull every number on the Twilio account into the app and point its webhooks here.
async function syncNumbers() {
  const nums = await client().incomingPhoneNumbers.list({ limit: 200 });
  for (const n of nums) {
    const existing = get('SELECT id FROM phone_numbers WHERE number = ?', n.phoneNumber);
    if (existing) run('UPDATE phone_numbers SET twilio_sid = ?, friendly_name = COALESCE(friendly_name, ?) WHERE id = ?', n.sid, n.friendlyName, existing.id);
    else run('INSERT INTO phone_numbers (number, friendly_name, twilio_sid) VALUES (?, ?, ?)', n.phoneNumber, n.friendlyName, n.sid);
    await configureNumberWebhooks(n.sid);
  }
  return all('SELECT * FROM phone_numbers ORDER BY id');
}

async function searchNumbers({ areaCode, contains, tollFree }) {
  const country = client().availablePhoneNumbers('US');
  const opts = { limit: 20, smsEnabled: true, voiceEnabled: true };
  if (areaCode) opts.areaCode = Number(areaCode);
  if (contains) opts.contains = contains;
  const list = tollFree ? await country.tollFree.list(opts) : await country.local.list(opts);
  return list.map((n) => ({ number: n.phoneNumber, friendlyName: n.friendlyName, locality: n.locality, region: n.region }));
}

async function buyNumber(number) {
  const n = await client().incomingPhoneNumbers.create({ phoneNumber: number, friendlyName: `Rise Dialer ${number}` });
  await configureNumberWebhooks(n.sid);
  run('INSERT OR IGNORE INTO phone_numbers (number, friendly_name, twilio_sid) VALUES (?, ?, ?)', n.phoneNumber, n.friendlyName, n.sid);
  return get('SELECT * FROM phone_numbers WHERE number = ?', n.phoneNumber);
}

// ---- Outbound actions ---------------------------------------------------
async function sendSms({ from, to, body, mediaUrl }) {
  const params = { from, to, body, statusCallback: url('/twilio/sms/status') };
  if (mediaUrl && mediaUrl.length) params.mediaUrl = mediaUrl;
  return client().messages.create(params);
}

async function startAiCall({ from, to, callId }) {
  return client().calls.create({
    from, to,
    url: url(`/twilio/voice/ai-outbound?callId=${callId}`), method: 'POST',
    statusCallback: url('/twilio/voice/status'), statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    ...(config.recordCalls ? { record: true, recordingChannels: 'dual', recordingStatusCallback: url('/twilio/voice/recording') } : {}),
  });
}

// Ring the user's cell first; when they pick up, connect them to the other person.
async function startClickToCall({ from, userCell, to, callId }) {
  return client().calls.create({
    from, to: userCell,
    url: url(`/twilio/voice/bridge?callId=${callId}`), method: 'POST',
    statusCallback: url('/twilio/voice/status'), statusCallbackMethod: 'POST',
  });
}

module.exports = {
  client, isConfigured, ensureVoiceSetup, accessToken, validateTwilio,
  syncNumbers, searchNumbers, buyNumber, configureNumberWebhooks,
  sendSms, startAiCall, startClickToCall, url, twilio,
};

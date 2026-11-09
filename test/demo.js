// Starts the app with sample data and a stubbed Twilio, for looking at the dashboard locally.
Object.assign(process.env, {
  PORT: '3333', DATA_DIR: '/tmp/rd-demo', PUBLIC_URL: 'http://localhost:3333',
  TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_AUTH_TOKEN: 'x',
  TWILIO_API_KEY_SID: 'SK' + '1'.repeat(32), TWILIO_API_KEY_SECRET: 's', TWILIO_TWIML_APP_SID: 'AP' + '2'.repeat(32),
  ANTHROPIC_API_KEY: 'sk-demo', ADMIN_EMAIL: 'joseph@demo.com', ADMIN_PASSWORD: 'password123', ADMIN_NAME: 'Joseph Dittman',
});
require('fs').rmSync('/tmp/rd-demo', { recursive: true, force: true });
const tw = require('../src/twilio');
tw.ensureVoiceSetup = async () => {}; tw.syncNumbers = async () => [];
const { run } = require('../src/db');
run("INSERT INTO phone_numbers (number, friendly_name, inbound_mode, ai_on_no_answer) VALUES ('+12545550100', 'Main line', 'ring_all', 1)");
run("INSERT INTO phone_numbers (number, friendly_name, inbound_mode) VALUES ('+17375550142', 'Appraisals', 'ai')");
require('../src/server');
const auth = require('../src/auth');
auth.createUser({ name: 'Stephanie', email: 'steph@demo.com', password: 'password123', cell_phone: '+12545550111' });
run("UPDATE phone_numbers SET ai_agent_id = 1 WHERE id = 1");
const c = (n, name, co, notes) => run('INSERT INTO contacts (phone, name, company, notes) VALUES (?, ?, ?, ?)', n, name, co, notes);
c('+15125551234', 'Maria Lopez', 'Homeowner — Round Rock', 'Hail claim, State Farm. Invoice 1042 outstanding.');
c('+12145550188', 'Jacob Diaz', 'Stronghouse Solutions', 'Referral partner');
c('+18175550123', 'Luis Toribio', 'Legacy Roofing', '');
const m = (dir, other, body, ago, by) => run(`INSERT INTO messages (sid, direction, our_number, other_number, body, status, sent_by, is_read, created_at) VALUES (?, ?, '+12545550100', ?, ?, ?, ?, ?, datetime('now', ?))`, 'SM' + Math.random(), dir, other, body, dir === 'inbound' ? 'received' : 'delivered', by || null, dir === 'inbound' && ago === '-3 minutes' ? 0 : 1, ago);
m('outbound', '+15125551234', 'Hi Maria, this is Joseph with Rise Public Adjusting. The appraisal award came in today.', '-2 hours', 'Joseph Dittman');
m('inbound', '+15125551234', 'That is great news! When do I get the check?', '-90 minutes');
m('outbound', '+15125551234', 'Carrier has 5 business days to pay after the award. I will text you as soon as it is issued.', '-80 minutes', 'Joseph Dittman');
m('inbound', '+15125551234', 'Thank you so much 🙏', '-3 minutes');
m('inbound', '+12145550188', 'Got a new one for you in Frisco — sending photos now', '-1 day');
m('outbound', '+12145550188', 'Send it over, we will get it set up today.', '-23 hours', 'Claude (for Joseph Dittman)');
m('inbound', '+18175550123', 'Any update on the Garland file?', '-2 days');
const k = (sid, dir, kind, other, status, dur, ago, extra = {}) => run(`INSERT INTO calls (call_sid, direction, kind, from_number, to_number, our_number, other_number, user_id, ai_agent_id, status, duration, summary, outcome, voicemail, transcript, started_at)
  VALUES (?, ?, ?, ?, ?, '+12545550100', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`, sid, dir, kind, dir === 'inbound' ? other : '+12545550100', dir === 'inbound' ? '+12545550100' : other, other,
  extra.user || null, extra.agent || null, status, dur, extra.summary || null, extra.outcome || null, extra.vm || 0, extra.transcript ? JSON.stringify(extra.transcript) : null, ago);
k('CA1', 'outbound', 'ai', '+15125551234', 'completed', 94, '-40 minutes', { agent: 2, outcome: 'Payment promised Friday', summary: 'Maria confirmed she received invoice #1042 for $1,850 and said she will mail the check Friday.\nFollow-up: Check for payment Monday.', transcript: [
  { role: 'agent', text: 'Hi, this is the virtual assistant calling from Rise Public Adjusting. Is this Maria?' },
  { role: 'caller', text: 'Yes, this is Maria.' },
  { role: 'agent', text: "Thanks Maria. I'm calling about invoice ten forty-two for eighteen hundred fifty dollars that we sent October twentieth. Did you get it?" },
  { role: 'caller', text: "I did, I'm going to mail the check on Friday." },
  { role: 'agent', text: "Perfect, so a check in the mail this Friday. Thank you, and have a great day!" },
] });
k('CA2', 'inbound', 'human', '+12145550188', 'completed', 312, '-3 hours', { user: 1 });
k('CA3', 'inbound', 'human', '+19725550177', 'voicemail', 22, '-5 hours', { vm: 1, summary: 'Voicemail: Hi this is Dana, I had hail damage last week and my neighbor said you could help. Please call me back.' });
k('CA4', 'inbound', 'ai', '+18175550123', 'completed', 61, '-1 day', { agent: 1, outcome: 'Message taken', summary: 'Luis from Legacy Roofing asked for an update on the Garland appraisal file and wants a call back today.\nFollow-up: Call Luis about Garland.' });
k('CA5', 'outbound', 'human', '+15125551234', 'no-answer', 0, '-2 days', { user: 2 });
console.log('demo ready');

// Central configuration — everything comes from environment variables (set them in Railway).
const env = process.env;

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const publicUrl = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/$/, '');

module.exports = {
  port: Number(env.PORT || 3000),
  publicUrl,
  wsUrl: publicUrl.replace(/^http/, 'ws'),
  dataDir: env.DATA_DIR || (env.RAILWAY_VOLUME_MOUNT_PATH || './data'),

  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    // Optional — created automatically on first start if blank.
    apiKeySid: env.TWILIO_API_KEY_SID || '',
    apiKeySecret: env.TWILIO_API_KEY_SECRET || '',
    twimlAppSid: env.TWILIO_TWIML_APP_SID || '',
    validateWebhooks: bool(env.TWILIO_VALIDATE_WEBHOOKS, true),
  },

  ai: {
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    voiceModel: env.AI_VOICE_MODEL || 'claude-haiku-5-5',
    summaryModel: env.AI_SUMMARY_MODEL || 'claude-haiku-5-5',
    defaultVoice: env.AI_DEFAULT_VOICE || 'UgBBYS2sOqTuMpoF3BR0', // ElevenLabs voice ID (Twilio default)
  },

  businessName: env.BUSINESS_NAME || 'Rise Public Adjusting',
  recordCalls: bool(env.RECORD_CALLS, true),
  slackWebhookUrl: env.SLACK_WEBHOOK_URL || '',
  timezone: env.TZ_DISPLAY || 'America/Chicago',

  admin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME || 'Admin',
  },

  sessionSecret: env.SESSION_SECRET || '',
  mcpToken: env.MCP_TOKEN || '',
};

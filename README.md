# Rise Dialer

Your own JustCall-style phone system, built on Twilio, with Claude running the AI calls.

**What it does**
- **Logins for each person.** Everyone on the team gets their own login, browser phone and caller ID. No more sharing one seat.
- **Browser softphone.** Call and answer from the dashboard, with mute, keypad, recording and a call log. There's also a **Ring my cell** button: it calls your cell first, then connects you to the other person, and the business number shows as the caller ID.
- **Shared text inbox.** Two-way SMS/MMS by conversation, with live updates, unread counts, delivery status and contacts.
- **AI voice agents.** Claude does the thinking and an ElevenLabs voice does the talking, through Twilio ConversationRelay. They can:
  - answer an "AI line", or pick up when nobody answers
  - make outbound calls you start (or Claude starts), with instructions for that one call
  - take messages, transfer to a person, send the caller a text, work through phone menus (IVR), and leave voicemails
  - write a transcript, a summary, an outcome and a follow-up for every AI call, and post it to Slack if you turn that on
- **Voicemail.** It's recorded and transcribed, and you get a Slack alert if you turn that on.
- **Claude connector (MCP).** Add one link in Claude and you can say things like *"text Maria that the award is signed"*, *"have the AI call these 5 insureds about unsigned iink requests"*, *"what did the AI calls today say?"* or *"ring my cell and connect me to Jacob"*.

---

## Setup (about 30–45 minutes the first time)

### 1. Twilio
1. Sign up at twilio.com and **upgrade the account** (add a card). Trial accounts can only call verified numbers.
2. From the Twilio Console home page, copy your **Account SID** and **Auth Token**.
3. **Texting registration (required for SMS to US phones).** Go to Messaging → Regulatory Compliance → A2P 10DLC. Register your business (Brand) and one Campaign ("Customer care / account notifications"). Approval usually takes a few days. Calls work while you wait. Toll-free numbers use Toll-Free Verification instead.
4. You don't need to buy numbers in Twilio. You can buy them inside the app (Admin → Buy a number). To keep your JustCall numbers, port them to Twilio (Phone Numbers → Port & Host). They show up after you click **Sync from Twilio**.

### 2. Anthropic (Claude) API key
Create a key at console.anthropic.com (API Keys) and add a few dollars of credit.

### 3. Deploy on Railway
1. Put this folder in a **private GitHub repo** (or run `railway up` from the folder with the Railway CLI).
2. In Railway, create a **New Project → Deploy from GitHub repo**.
3. **Add a Volume** to the service and mount it at `/data`. Your database lives there, and without a volume a redeploy wipes it.
4. Go to **Settings → Networking → Generate Domain** to get your public URL.
5. Under **Variables**, add:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from step 1 |
| `TWILIO_AUTH_TOKEN` | from step 1 |
| `ANTHROPIC_API_KEY` | from step 2 |
| `ADMIN_EMAIL` | your login email |
| `ADMIN_PASSWORD` | a strong password (only used to create the first login) |
| `ADMIN_NAME` | Joseph Dittman |
| `BUSINESS_NAME` | Rise Public Adjusting |
| `SLACK_WEBHOOK_URL` | *(optional)* a Slack incoming-webhook URL for AI call summaries and voicemails |

`PUBLIC_URL` and the data folder are detected automatically on Railway.

6. Deploy. On first start the app:
   - creates your admin login
   - creates the Twilio API key and "TwiML App" the browser phone needs
   - imports every number on your Twilio account and points its call and text webhooks at the app

### 4. First login
1. Open your Railway URL and log in.
2. **Admin → Phone numbers:** click Sync (or Buy a number), then click **Edit** on each number to choose who rings, or whether the AI answers.
3. **Admin → Team → Add teammate:** add each person with a temporary password. Each person sets their cell under **My settings**.
4. **AI Agents:** two starter agents ("Receptionist" and "Follow-up caller") are already there. Edit their instructions. There's also a "Carrier status caller" template.
5. Allow microphone access when the browser asks. The phone panel should say **Browser phone ready**.

### 5. Connect it to Claude
**Admin → Connect to Claude:** copy the link. In Claude, go to **Settings → Connectors → Add custom connector** and paste it. Treat the link like a password. **New link** turns off the old one.

---

## How calls route

| Number setting | What happens |
|---|---|
| Ring everyone available | Rings every teammate set to *Available* (in the browser, plus their cell if "ring my cell" is on) for 25 seconds. Then it goes to the AI backup or voicemail. |
| Ring one person | Same, but only rings the assigned person. |
| AI agent answers | The AI picks up every call. It can transfer to the team or to a set number. |

Click your status in the bottom-left corner to switch between Available and Away. Away skips you on team calls.

## Approximate costs (US, at Twilio's published rates)
- Phone number: about $1.15/month (local) or $2.15/month (toll-free)
- Human calls: about $0.014/min outbound and $0.0085/min inbound, plus about $0.004/min for the browser leg. Recording is $0.0025/min.
- AI calls: ConversationRelay is $0.07/min, which includes speech-to-text and the ElevenLabs voice. Add the phone minute and roughly $0.005–0.01/min for Claude Haiku, for about **$0.09–0.10 per AI minute** all in.
- Texts: about $0.0083 per segment plus carrier fees
- Railway: about $5–20/month

## Local testing
```
npm install
npm test        # 57 end-to-end checks with a fake Twilio + fake Claude
npm run demo    # dashboard with sample data at http://localhost:3333 (joseph@demo.com / password123)
```

## Files
- `src/routes/twilio.js`: call and text webhooks (routing, voicemail, transfers)
- `src/ai/agent.js`: the AI voice agent (prompt, tools, interruptions, summaries)
- `src/mcp.js`: the Claude connector tools
- `src/routes/api.js`: the dashboard API
- `public/`: the dashboard

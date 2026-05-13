const express = require('express');
const twilio = require('twilio');
const app = express();

// CORS — allow requests from any origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const callJobs = {};

// Health check — open in browser to confirm server is running
app.get('/', (req, res) => {
  res.json({
    status: 'SmileTrac AI Call Server running ✓',
    version: '3.0',
    time: new Date().toISOString(),
  });
});

// Ping — used by app to test connection
app.get('/ping', (req, res) => {
  res.json({ ok: true, message: 'SmileTrac server reachable' });
});

// Receive call job from scraper
app.post('/call-test', async (req, res) => {
  const { to, sid, token, from, leadId } = req.body;

  // Return success for connection test (no Twilio creds needed)
  if (!sid || !token) {
    return res.json({ success: true, test: true, message: 'Connection OK' });
  }
  if (!to || !from) {
    return res.status(400).json({ error: 'Missing: to, from' });
  }

  const digits = to.replace(/\D/g, '');
  const e164 = digits.length === 10 ? '+1' + digits : '+' + digits;

  try {
    const client = twilio(sid, token);
    const serverUrl = process.env.SERVER_URL || `https://${req.headers.host}`;

    const call = await client.calls.create({
      to: e164,
      from: from,
      twiml: '<Response><Pause length="30"/></Response>',
      machineDetection: 'DetectMessageEnd',
      asyncAmd: true,
      asyncAmdStatusCallback: `${serverUrl}/call-result`,
      asyncAmdStatusCallbackMethod: 'POST',
    });

    callJobs[call.sid] = {
      leadId,
      phone: e164,
      startTime: new Date().toISOString()
    };

    console.log(`✓ Call queued: ${e164} | Lead: ${leadId} | Sid: ${call.sid}`);
    res.json({ success: true, callSid: call.sid, to: e164 });

  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Twilio calls this when call completes
app.post('/call-result', (req, res) => {
  const { CallSid, AnsweredBy, To } = req.body;
  const job = callJobs[CallSid];
  const isVM = AnsweredBy && AnsweredBy.startsWith('machine');
  const isAnswered = AnsweredBy === 'human';
  const result = isVM ? 'VOICEMAIL' : isAnswered ? 'ANSWERED' : 'UNKNOWN';
  console.log(`Call result: ${To} → ${result} (${AnsweredBy}) | Lead: ${job?.leadId}`);
  if (job) delete callJobs[CallSid];
  res.sendStatus(200);
});

// See pending calls
app.get('/status', (req, res) => {
  res.json({
    pendingCalls: Object.keys(callJobs).length,
    calls: Object.entries(callJobs).map(([sid, job]) => ({
      callSid: sid,
      leadId: job.leadId,
      phone: job.phone,
      startTime: job.startTime
    }))
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SmileTrac AI Call Server running on port ${PORT}`));

const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── In-memory call queue ──────────────────────────────
let callQueue = [];
let callResults = {};

// ── Health check ──────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SmileTrac AI - VM Detection Server',
    queued: callQueue.length,
    results: Object.keys(callResults).length,
    time: new Date().toISOString()
  });
});

// ── Queue a call ──────────────────────────────────────
app.post('/queue', (req, res) => {
  const { phone, businessName, accountSid, authToken, fromNumber } = req.body;
  if (!phone || !accountSid || !authToken || !fromNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  callQueue.push({ id, phone, businessName, accountSid, authToken, fromNumber, queuedAt: new Date().toISOString() });
  res.json({ success: true, id, queued: callQueue.length });
});

// ── Fire all queued calls ─────────────────────────────
app.post('/fire', async (req, res) => {
  if (callQueue.length === 0) {
    return res.json({ success: true, fired: 0, message: 'No calls in queue' });
  }
  const fired = [];
  const serverUrl = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : req.protocol + '://' + req.get('host');

  for (const item of callQueue) {
    try {
      const client = twilio(item.accountSid, item.authToken);
      const call = await client.calls.create({
        to: item.phone,
        from: item.fromNumber,
        url: `${serverUrl}/twiml`,
        statusCallback: `${serverUrl}/result/${item.id}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['completed'],
        machineDetection: 'Enable',
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${serverUrl}/amd/${item.id}`,
        asyncAmdStatusCallbackMethod: 'POST',
        timeout: 20
      });
      callResults[item.id] = { status: 'calling', callSid: call.sid, businessName: item.businessName, phone: item.phone };
      fired.push({ id: item.id, businessName: item.businessName, callSid: call.sid });
    } catch (err) {
      callResults[item.id] = { status: 'error', error: err.message, businessName: item.businessName };
      fired.push({ id: item.id, businessName: item.businessName, error: err.message });
    }
  }
  callQueue = [];
  res.json({ success: true, fired: fired.length, results: fired });
});

// ── TwiML — what plays when answered ─────────────────
app.all('/twiml', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Hangup/>
</Response>`);
});

// ── AMD result (voicemail detection) ─────────────────
app.post('/amd/:id', (req, res) => {
  const { id } = req.params;
  const { AnsweredBy } = req.body;
  if (callResults[id]) {
    callResults[id].answeredBy = AnsweredBy;
    callResults[id].voicemail = AnsweredBy === 'machine_start' || AnsweredBy === 'machine_end_beep' || AnsweredBy === 'machine_end_silence' || AnsweredBy === 'machine_end_other';
  }
  res.sendStatus(200);
});

// ── Call completed callback ───────────────────────────
app.post('/result/:id', (req, res) => {
  const { id } = req.params;
  const { CallStatus, AnsweredBy, CallDuration } = req.body;
  if (callResults[id]) {
    callResults[id].callStatus = CallStatus;
    callResults[id].duration = CallDuration;
    if (AnsweredBy) {
      callResults[id].answeredBy = AnsweredBy;
      callResults[id].voicemail = AnsweredBy === 'machine_start' || AnsweredBy === 'machine_end_beep' || AnsweredBy === 'machine_end_silence' || AnsweredBy === 'machine_end_other';
    }
    callResults[id].completedAt = new Date().toISOString();
  }
  res.sendStatus(200);
});

// ── Get results ───────────────────────────────────────
app.get('/results', (req, res) => {
  res.json({ results: callResults, count: Object.keys(callResults).length });
});

app.get('/results/:id', (req, res) => {
  const result = callResults[req.params.id];
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

// ── Clear results ─────────────────────────────────────
app.post('/clear', (req, res) => {
  callQueue = [];
  callResults = {};
  res.json({ success: true, message: 'Queue and results cleared' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmileTrac AI VM Detection Server running on port ${PORT}`);
});

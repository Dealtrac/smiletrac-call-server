const express = require('express');
const twilio = require('twilio');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Call queue — holds calls until scheduled time
const callQueue = [];
const callResults = {};
let schedulerRunning = false;

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'SmileTrac AI Call Server running ✓',
    version: '4.0',
    queued: callQueue.length,
    time: new Date().toLocaleTimeString('en-US', {timeZone: 'America/Indiana/Indianapolis'}),
    timezone: 'America/Indiana/Indianapolis'
  });
});

// Ping
app.get('/ping', (req, res) => {
  res.json({ ok: true, message: 'SmileTrac server reachable' });
});

// Queue a call — fires at scheduled time (default 8pm Indianapolis time)
app.post('/call-test', async (req, res) => {
  const { to, sid, token, from, leadId, scheduleTime } = req.body;

  if (!sid || !token) {
    return res.json({ success: true, test: true, message: 'Connection OK — no credentials provided' });
  }
  if (!to || !from) {
    return res.status(400).json({ error: 'Missing: to, from' });
  }

  const digits = to.replace(/\D/g, '');
  const e164 = digits.length === 10 ? '+1' + digits : '+' + digits;

  // Calculate when to fire this call
  const now = new Date();
  const indy = new Date(now.toLocaleString('en-US', {timeZone: 'America/Indiana/Indianapolis'}));
  
  // Default: next 8pm Indianapolis time
  let fireAt = new Date(indy);
  fireAt.setHours(20, 0, 0, 0); // 8:00pm
  
  // If already past 8pm today, schedule for tomorrow
  if (indy >= fireAt) {
    fireAt.setDate(fireAt.getDate() + 1);
  }

  // Allow custom time override (format: "HH:MM" in 24hr)
  if (scheduleTime && /^\d{2}:\d{2}$/.test(scheduleTime)) {
    const [h, m] = scheduleTime.split(':').map(Number);
    fireAt = new Date(indy);
    fireAt.setHours(h, m, 0, 0);
    if (indy >= fireAt) fireAt.setDate(fireAt.getDate() + 1);
  }

  const job = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2,6),
    to: e164,
    from,
    sid,
    token,
    leadId: leadId || 'unknown',
    fireAt: fireAt.toISOString(),
    fireAtLocal: fireAt.toLocaleString('en-US', {timeZone: 'America/Indiana/Indianapolis'}),
    status: 'queued',
    queuedAt: new Date().toISOString()
  };

  callQueue.push(job);
  console.log(`✓ Queued: ${e164} | Lead: ${leadId} | Fire at: ${job.fireAtLocal}`);
  
  // Start scheduler if not running
  if (!schedulerRunning) startScheduler();

  res.json({ 
    success: true, 
    jobId: job.id,
    to: e164,
    scheduledFor: job.fireAtLocal,
    queueLength: callQueue.length
  });
});

// Scheduler — checks every minute for calls ready to fire
function startScheduler() {
  schedulerRunning = true;
  console.log('Scheduler started');
  
  setInterval(async () => {
    const now = new Date();
    const indyNow = new Date(now.toLocaleString('en-US', {timeZone: 'America/Indiana/Indianapolis'}));
    
    const ready = callQueue.filter(j => j.status === 'queued' && new Date(j.fireAt) <= indyNow);
    
    for (const job of ready) {
      job.status = 'calling';
      console.log(`Firing call: ${job.to} | Lead: ${job.leadId}`);
      
      try {
        const client = twilio(job.sid, job.token);
        const serverUrl = process.env.SERVER_URL || 'https://smiletrac-call-server-production.up.railway.app';
        
        const call = await client.calls.create({
          to: job.to,
          from: job.from,
          twiml: '<Response><Pause length="30"/></Response>',
          machineDetection: 'DetectMessageEnd',
          asyncAmd: true,
          asyncAmdStatusCallback: `${serverUrl}/call-result`,
          asyncAmdStatusCallbackMethod: 'POST',
        });
        
        job.status = 'called';
        job.callSid = call.sid;
        callResults[call.sid] = { leadId: job.leadId, phone: job.to, jobId: job.id };
        console.log(`✓ Called: ${job.to} | SID: ${call.sid}`);
        
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        console.error(`✗ Failed: ${job.to} | ${err.message}`);
      }
    }
  }, 60000); // Check every 60 seconds
}

// Twilio callback when call completes
app.post('/call-result', (req, res) => {
  const { CallSid, AnsweredBy, To } = req.body;
  const job = callResults[CallSid];
  const isVM = AnsweredBy && (AnsweredBy.startsWith('machine') || AnsweredBy === 'fax');
  const isHuman = AnsweredBy === 'human';
  const result = isVM ? 'VOICEMAIL' : isHuman ? 'ANSWERED' : 'UNKNOWN';
  
  console.log(`Result: ${To} → ${result} (${AnsweredBy}) | Lead: ${job?.leadId}`);
  
  // Find and update job
  const qJob = callQueue.find(j => j.callSid === CallSid);
  if (qJob) {
    qJob.vmResult = result;
    qJob.answeredBy = AnsweredBy;
  }
  
  res.sendStatus(200);
});

// Status — see queue
app.get('/status', (req, res) => {
  const indyTime = new Date().toLocaleString('en-US', {timeZone: 'America/Indiana/Indianapolis'});
  res.json({
    currentTime: indyTime,
    timezone: 'Indianapolis (Eastern)',
    queuedCalls: callQueue.filter(j => j.status === 'queued').length,
    calledToday: callQueue.filter(j => j.status === 'called').length,
    failedToday: callQueue.filter(j => j.status === 'failed').length,
    recentCalls: callQueue.slice(-10).map(j => ({
      lead: j.leadId,
      phone: j.to,
      status: j.status,
      scheduledFor: j.fireAtLocal,
      vmResult: j.vmResult || 'pending',
      error: j.error
    }))
  });
});

// Clear queue (for testing)
app.post('/clear', (req, res) => {
  const cleared = callQueue.length;
  callQueue.length = 0;
  res.json({ cleared, message: 'Queue cleared' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmileTrac AI Call Server v4.0 running on port ${PORT}`);
  console.log(`Timezone: America/Indiana/Indianapolis`);
  startScheduler();
});

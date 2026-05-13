# SmileTrac AI — Call Test Server

Auto-calls dental practices after hours, detects voicemail vs live answer.

## Deploy on Railway (free)
1. Upload these 4 files to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js
4. Settings → Networking → Generate Domain → copy URL
5. Paste URL into SmileTrac scraper → Twilio tab → Backend Server URL
6. Click Test Server — should show green checkmark

## Verify it's running
Open in browser: https://your-url.railway.app
Should show: {"status": "SmileTrac AI Call Server running ✓"}

## Endpoints
GET  /        Health check
GET  /ping    Connection test (used by scraper Test button)
POST /call-test    Queue a call test
POST /call-result  Twilio callback when call completes
GET  /status  See pending calls

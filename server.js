const express = require('express');
const https = require('https');
const app = express();

// ─── Keep-Alive agent for Google TTS ────────────────────────────────────────
const googleAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 4,
  keepAliveMsecs: 30000
});

// ─── Conversation History ────────────────────────────────────────────────────
// Maintains the last 6 messages (3 exchanges) so Claude has context.
// Single-student assumption — fine for current Vizi usage.
// Resets automatically after 10 minutes of inactivity.
const MAX_HISTORY     = 6;
const HISTORY_TTL_MS  = 10 * 60 * 1000; // 10 minutes idle reset

let conversationHistory = [];
let lastActivityTime    = Date.now();

function addToHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY);
  }
  lastActivityTime = Date.now();
}

function getHistory() {
  if (Date.now() - lastActivityTime > HISTORY_TTL_MS) {
    console.log('History TTL expired — resetting conversation');
    conversationHistory = [];
  }
  return conversationHistory;
}
// ────────────────────────────────────────────────────────────────────────────

// Raw body parser — handles App Inventor PostText quirks
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    console.log('RAW BODY:', JSON.stringify(data.slice(0, 300)));

    let cleaned = data.trim();

    if (cleaned.startsWith('text: ')) {
      cleaned = cleaned.slice(6);
    } else if (cleaned.startsWith('text=')) {
      cleaned = decodeURIComponent(cleaned.slice(5).replace(/\+/g, ' '));
    }

    cleaned = cleaned.replace(/[\r\n]+/g, ' ');

    try {
      req.body = JSON.parse(cleaned);
      return next();
    } catch(e) { /* fall through */ }

    req.body = { text: cleaned };
    next();
  });
});

const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VOICE_NAME        = process.env.VOICE_NAME || 'en-US-Neural2-F';
const LANGUAGE_CODE     = 'en-US';
const SYSTEM_PROMPT     = process.env.SYSTEM_PROMPT  || 'You are Vizi, an AI guitar tutor.';
const REMINDER_PROMPT   = process.env.REMINDER_PROMPT || '';

// Health check — now shows history state
app.get('/health', (req, res) => {
  res.json({
    status: 'Vizi TTS Proxy running',
    voice: VOICE_NAME,
    model: 'claude-haiku-4-5-20251001',
    claudeReady: !!ANTHROPIC_API_KEY,
    historyLength: conversationHistory.length,
    historyIdleSecs: Math.floor((Date.now() - lastActivityTime) / 1000)
  });
});

// ─── Reset endpoint ──────────────────────────────────────────────────────────
// POST or GET /reset — clears conversation history.
// Call this at the start of each new lesson session from App Inventor.
app.post('/reset', (req, res) => {
  conversationHistory = [];
  lastActivityTime = Date.now();
  console.log('Conversation history reset via POST');
  res.json({ status: 'ok', message: 'Conversation history cleared' });
});

app.get('/reset', (req, res) => {
  conversationHistory = [];
  lastActivityTime = Date.now();
  console.log('Conversation history reset via GET');
  res.json({ status: 'ok', message: 'Conversation history cleared' });
});
// ────────────────────────────────────────────────────────────────────────────

// Google TTS
function synthesize(text, res) {
  console.log('Synthesizing:', text.slice(0, 80));
  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });
  }

  const requestBody = JSON.stringify({
    input: { text },
    voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
    audioConfig: { audioEncoding: 'MP3' }
  });

  const options = {
    hostname: 'texttospeech.googleapis.com',
    path: '/v1/text:synthesize?key=' + encodeURIComponent(GOOGLE_API_KEY),
    method: 'POST',
    agent: googleAgent,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };

  const googleReq = https.request(options, (googleRes) => {
    let data = '';
    googleRes.on('data', chunk => { data += chunk; });
    googleRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (!parsed.audioContent) {
          console.error('TTS error response:', JSON.stringify(parsed));
          return res.status(500).json({ error: 'No audio returned', detail: parsed });
        }
        const audioBuffer = Buffer.from(parsed.audioContent, 'base64');
        res.set({
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuffer.length,
          'Cache-Control': 'no-cache'
        });
        res.send(audioBuffer);
      } catch (err) {
        res.status(500).json({ error: 'Parse error', detail: err.message });
      }
    });
  });

  googleReq.on('error', err => {
    res.status(500).json({ error: 'Google TTS request failed', detail: err.message });
  });

  googleReq.write(requestBody);
  googleReq.end();
}

// GET /tts — backward compatibility
app.get('/tts', (req, res) => {
  const text = req.query.text;
  console.log('GET /tts text length:', text && text.length);
  if (!text) return res.status(400).json({ error: 'Missing text parameter' });
  if (text.length > 500) {
    console.warn('WARNING: GET /tts text is very long (' + text.length + ' chars)');
  }
  synthesize(text, res);
});

// POST /tts — preferred
app.post('/tts', (req, res) => {
  let text;
  if (typeof req.body === 'string') {
    try { text = JSON.parse(req.body).text; } catch(e) { text = req.body; }
  } else {
    text = req.body && req.body.text;
  }
  console.log('POST /tts text length:', text && text.length);
  if (!text) return res.status(400).json({ error: 'Missing text parameter' });
  synthesize(text, res);
});

// ─── Claude API proxy with conversation history ──────────────────────────────
// POST /claude
// Request:  { "message": "<student text>", "mode": "lesson"|"talk" }
// Response: { "text": "<Vizi response>" }
app.post('/claude', (req, res) => {
  let message = req.body && req.body.message;
  const mode  = req.body && req.body.mode;

  console.log('POST /claude mode:', mode, 'message:', message && message.slice(0, 80));

  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }

  // Sanitize
  message = message.replace(/[\r\n]+/g, ' ').trim();

  // Build system string
  const systemText = (mode === 'talk' && REMINDER_PROMPT)
    ? SYSTEM_PROMPT + '\n\n' + REMINDER_PROMPT
    : SYSTEM_PROMPT;

  // Check TTL then append new user message to history
  getHistory();
  addToHistory('user', message);

  // Snapshot current history to send to Claude
  const messages = [...conversationHistory];

  console.log('Sending', messages.length, 'messages to Claude (history depth:', messages.length - 1, ')');

  const claudeBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: systemText,
    messages: messages
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(claudeBody)
    }
  };

  const claudeReq = https.request(options, (claudeRes) => {
    let data = '';
    claudeRes.on('data', chunk => { data += chunk; });
    claudeRes.on('end', () => {
      console.log('Claude status:', claudeRes.statusCode);
      try {
        const parsed = JSON.parse(data);
        if (claudeRes.statusCode !== 200) {
          console.error('Claude error:', data);
          // Remove the user message we just added so history stays clean
          conversationHistory.pop();
          return res.status(claudeRes.statusCode).json({
            error: 'Claude API error',
            detail: parsed
          });
        }
        const text = parsed.content && parsed.content[0] && parsed.content[0].text || '';

        // Add Claude's reply to history
        addToHistory('assistant', text);
        console.log('History now', conversationHistory.length, 'messages');

        res.json({ text });
      } catch (err) {
        conversationHistory.pop();
        res.status(500).json({ error: 'Parse error', detail: err.message });
      }
    });
  });

  claudeReq.on('error', err => {
    console.error('Claude request error:', err.message);
    conversationHistory.pop();
    res.status(500).json({ error: 'Claude request failed', detail: err.message });
  });

  claudeReq.write(claudeBody);
  claudeReq.end();
});
// ────────────────────────────────────────────────────────────────────────────

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Vizi TTS Proxy listening on port ' + PORT);
  console.log('Voice:', VOICE_NAME);
  console.log('Claude ready:', !!ANTHROPIC_API_KEY);
});

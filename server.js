const express = require('express');
const https = require('https');
const app = express();

// Raw body parser — tolerant of newlines injected by App Inventor
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    // First try parsing as-is
    try {
      req.body = JSON.parse(data);
      return next();
    } catch(e) { /* fall through */ }
    // Replace literal newlines inside JSON string values and retry
    try {
      const cleaned = data.replace(/[\r\n]+/g, ' ');
      req.body = JSON.parse(cleaned);
      return next();
    } catch(e) { /* fall through */ }
    // Last resort - treat entire body as text
    req.body = { text: data };
    next();
  });
});

const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VOICE_NAME        = process.env.VOICE_NAME || 'en-US-Neural2-F';
const LANGUAGE_CODE     = 'en-US';
const SYSTEM_PROMPT     = process.env.SYSTEM_PROMPT  || 'You are Vizi, an AI guitar tutor.';
const REMINDER_PROMPT   = process.env.REMINDER_PROMPT || '';

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'Vizi TTS Proxy running',
    voice: VOICE_NAME,
    claudeReady: !!ANTHROPIC_API_KEY
  });
});

// Google TTS
function synthesize(text, res) {
  console.log('Synthesizing:', text);
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

app.get('/tts', (req, res) => {
  const text = req.query.text;
  console.log('GET /tts text:', text);
  if (!text) return res.status(400).json({ error: 'Missing text parameter' });
  synthesize(text, res);
});

app.post('/tts', (req, res) => {
  let text;
  if (typeof req.body === 'string') {
    try { text = JSON.parse(req.body).text; } catch(e) { text = req.body; }
  } else {
    text = req.body && req.body.text;
  }
  console.log('POST /tts text:', text);
  if (!text) return res.status(400).json({ error: 'Missing text parameter' });
  synthesize(text, res);
});

// Claude API proxy
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

  // Sanitize - remove any stray newlines that survived body parsing
  message = message.replace(/[\r\n]+/g, ' ').trim();

  // Build system string
  const systemText = (mode === 'talk' && REMINDER_PROMPT)
    ? SYSTEM_PROMPT + '\n\n' + REMINDER_PROMPT
    : SYSTEM_PROMPT;

  const claudeBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: systemText,
    messages: [{ role: 'user', content: message }]
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
          return res.status(claudeRes.statusCode).json({
            error: 'Claude API error',
            detail: parsed
          });
        }
        const text = parsed.content && parsed.content[0] && parsed.content[0].text || '';
        res.json({ text });
      } catch (err) {
        res.status(500).json({ error: 'Parse error', detail: err.message });
      }
    });
  });

  claudeReq.on('error', err => {
    console.error('Claude request error:', err.message);
    res.status(500).json({ error: 'Claude request failed', detail: err.message });
  });

  claudeReq.write(claudeBody);
  claudeReq.end();
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Vizi TTS Proxy listening on port ' + PORT);
  console.log('Voice:', VOICE_NAME);
  console.log('Claude ready:', !!ANTHROPIC_API_KEY);
});

const express = require('express');
const https   = require('https');
const crypto  = require('crypto');
const app     = express();

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Vizi-Text, X-Vizi-Commands, X-Vizi-Transcript, X-Vizi-Timing');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── multer ──────────────────────────────────────────────────────────────────
let multer;
try { multer = require('multer'); } catch(e) { multer = null; }
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }) : null;

// ─── Keep-Alive agent for Google APIs ────────────────────────────────────────
const googleAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 4,
  keepAliveMsecs: 30000
});

// ─── Conversation History ────────────────────────────────────────────────────
const MAX_HISTORY    = 6;
const HISTORY_TTL_MS = 10 * 60 * 1000;

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

// ─── Song Sessions ────────────────────────────────────────────────────────────
const sessions = {};
const SESSION_TTL_MS = 30 * 60 * 1000;

function cleanOldSessions() {
  const now = Date.now();
  for (const id in sessions) {
    if (now - sessions[id].createdAt > SESSION_TTL_MS) delete sessions[id];
  }
}

function createSession(songTitle = '') {
  cleanOldSessions();
  const id = crypto.randomBytes(3).toString('hex').toUpperCase();
  sessions[id] = {
    status: 'waiting', createdAt: Date.now(), songTitle,
    type: null, chords: [], progression: '', tabTokens: [],
    rawText: '', capo: 0, key: '', timeSignature: '', strummingPattern: '', suggestedBpm: null, error: null
  };
  return id;
}

// ─── Raw body parser ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
    return next();
  }
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    console.log('RAW BODY:', JSON.stringify(data.slice(0, 300)));
    let cleaned = data.trim();
    if (cleaned.startsWith('text: '))       cleaned = cleaned.slice(6);
    else if (cleaned.startsWith('text='))   cleaned = decodeURIComponent(cleaned.slice(5).replace(/\+/g, ' '));
    cleaned = cleaned.replace(/[\r\n]+/g, ' ');
    try { req.body = JSON.parse(cleaned); return next(); } catch(e) {}
    req.body = { text: cleaned };
    next();
  });
});

// ─── Environment Variables ────────────────────────────────────────────────────
const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const YOUTUBE_API_KEY   = process.env.YOUTUBE_API_KEY;
const VOICE_NAME        = process.env.VOICE_NAME    || 'en-US-Neural2-F';
const LANGUAGE_CODE     = 'en-US';
const SYSTEM_PROMPT       = process.env.SYSTEM_PROMPT       || 'You are Vizi, an AI guitar tutor.';
const REMINDER_PROMPT     = process.env.REMINDER_PROMPT     || '';
const SONG_PROMPT         = process.env.SONG_PROMPT         || '';
const STRUMMING_PROMPT    = process.env.STRUMMING_PROMPT    || '';
const SOLOING_PROMPT      = process.env.SOLOING_PROMPT      || '';

// ─── Pipe response parser ─────────────────────────────────────────────────────
function parsePipeResponse(fullText) {
  const parts = fullText.split('|').map(p => p.trim());
  return { spoken: parts[0] || '', commands: parts.slice(1).join('|') };
}

// ─── Fretboard command relay (mailbox) ────────────────────────────────────────
// The fretboard can't be reached directly (it's plain-HTTP on the LAN and the
// app is HTTPS). Instead, commands are queued here and the fretboard polls for
// them over its own outbound internet connection.
let fretboardQueue = [];
const FRETBOARD_QUEUE_MAX = 50;

function enqueueFretboardCommands(commandsStr) {
  if (!commandsStr) return;
  commandsStr.split('|').forEach(c => {
    const cmd = c.trim();
    if (cmd) fretboardQueue.push(cmd);
  });
  if (fretboardQueue.length > FRETBOARD_QUEUE_MAX) {
    fretboardQueue = fretboardQueue.slice(-FRETBOARD_QUEUE_MAX);
  }
}

// Fretboard polls this a few times a second; returns the next command or null
app.get('/fretboard-poll', (req, res) => {
  const command = fretboardQueue.shift() || null;
  res.json({ command, remaining: fretboardQueue.length });
});

// Manual enqueue — handy for testing without the app
app.post('/fretboard-command', (req, res) => {
  const command = req.body && req.body.command;
  if (!command) return res.status(400).json({ error: 'Missing command' });
  enqueueFretboardCommands(command);
  res.json({ status: 'queued', command, queued: fretboardQueue.length });
});

// Clear the fretboard queue — called on boot or manually to flush stale commands
app.post('/fretboard-clear', (req, res) => {
  const cleared = fretboardQueue.length;
  fretboardQueue = [];
  console.log(`[fretboard-clear] Flushed ${cleared} queued command(s)`);
  res.json({ status: 'ok', cleared });
});

// Also allow GET so firmware can call it without a body
app.get('/fretboard-clear', (req, res) => {
  const cleared = fretboardQueue.length;
  fretboardQueue = [];
  console.log(`[fretboard-clear] Flushed ${cleared} queued command(s) via GET`);
  res.json({ status: 'ok', cleared });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'Vizi TTS Proxy running', voice: VOICE_NAME,
    model: 'claude-haiku-4-5-20251001',
    claudeReady: !!ANTHROPIC_API_KEY, youtubeReady: !!YOUTUBE_API_KEY,
    historyLength: conversationHistory.length,
    historyIdleSecs: Math.floor((Date.now() - lastActivityTime) / 1000),
    activeSessions: Object.keys(sessions).length,
    multerReady: !!multer, songPromptReady: !!SONG_PROMPT,
    fretboardQueued: fretboardQueue.length
  });
});

// ─── Reset ────────────────────────────────────────────────────────────────────
app.post('/reset', (req, res) => {
  conversationHistory = []; lastActivityTime = Date.now();
  console.log('Conversation history reset via POST');
  res.json({ status: 'ok', message: 'Conversation history cleared' });
});
app.get('/reset', (req, res) => {
  conversationHistory = []; lastActivityTime = Date.now();
  console.log('Conversation history reset via GET');
  res.json({ status: 'ok', message: 'Conversation history cleared' });
});

// ─── Google TTS helper ────────────────────────────────────────────────────────
function synthesize(text, res) {
  console.log('Synthesizing:', text.slice(0, 80));
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });

  const requestBody = JSON.stringify({
    input: { text },
    voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
    audioConfig: { audioEncoding: 'MP3' }
  });

  const options = {
    hostname: 'texttospeech.googleapis.com',
    path: '/v1/text:synthesize?key=' + encodeURIComponent(GOOGLE_API_KEY),
    method: 'POST', agent: googleAgent,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
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
        res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.length, 'Cache-Control': 'no-cache' });
        res.send(audioBuffer);
      } catch (err) { res.status(500).json({ error: 'Parse error', detail: err.message }); }
    });
  });
  googleReq.on('error', err => res.status(500).json({ error: 'Google TTS request failed', detail: err.message }));
  googleReq.write(requestBody);
  googleReq.end();
}

// ─── Promise-based TTS (for chained endpoints) ────────────────────────────────
function synthesizeToBuffer(text) {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_API_KEY) return reject(new Error('GOOGLE_API_KEY not set'));

    const requestBody = JSON.stringify({
      input: { text },
      voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
      audioConfig: { audioEncoding: 'MP3' }
    });

    const options = {
      hostname: 'texttospeech.googleapis.com',
      path: '/v1/text:synthesize?key=' + encodeURIComponent(GOOGLE_API_KEY),
      method: 'POST', agent: googleAgent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) }
    };

    const googleReq = https.request(options, (googleRes) => {
      let data = '';
      googleRes.on('data', chunk => { data += chunk; });
      googleRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.audioContent) return reject(new Error('No audio returned from TTS'));
          resolve(Buffer.from(parsed.audioContent, 'base64'));
        } catch (err) { reject(err); }
      });
    });
    googleReq.on('error', err => reject(err));
    googleReq.write(requestBody);
    googleReq.end();
  });
}

app.get('/tts', (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).json({ error: 'Missing text parameter' });
  synthesize(text, res);
});

app.post('/tts', (req, res) => {
  let text;
  if (typeof req.body === 'string') {
    try { text = JSON.parse(req.body).text; } catch(e) { text = req.body; }
  } else { text = req.body && req.body.text; }
  if (!text) return res.status(400).json({ error: 'Missing text parameter' });
  synthesize(text, res);
});

// ─── Claude + TTS combined ────────────────────────────────────────────────────
// POST /claude-tts
// Request:  { "message": "...", "mode": "general" }
// Response: MP3 bytes + X-Vizi-Text + X-Vizi-Commands headers
// ─────────────────────────────────────────────────────────────────────────────
app.post('/claude-tts', (req, res) => {
  let message = req.body && req.body.message;
  const mode  = req.body && req.body.mode;

  console.log('POST /claude-tts mode:', mode, 'message:', message && message.slice(0, 80));
  if (!message) return res.status(400).json({ error: 'Missing message' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });

  message = message.replace(/[\r\n]+/g, ' ').trim();

  let systemText = SYSTEM_PROMPT;
  if      (mode === 'song'       && SONG_PROMPT)       { systemText = SYSTEM_PROMPT + '\n\n' + SONG_PROMPT; }
  else if (mode === 'strumming'  && STRUMMING_PROMPT) { systemText = SYSTEM_PROMPT + '\n\n' + STRUMMING_PROMPT; }
  else if (mode === 'soloing'    && SOLOING_PROMPT)   { systemText = SYSTEM_PROMPT + '\n\n' + SOLOING_PROMPT; }
  else if (mode === 'talk'       && REMINDER_PROMPT)  { systemText = SYSTEM_PROMPT + '\n\n' + REMINDER_PROMPT; }

  getHistory();
  addToHistory('user', message);
  const messages = [...conversationHistory];

  const claudeBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
    system: systemText, messages
  });

  const claudeOptions = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(claudeBody)
    }
  };

  const claudeReq = https.request(claudeOptions, (claudeRes) => {
    let data = '';
    claudeRes.on('data', chunk => { data += chunk; });
    claudeRes.on('end', async () => {
      try {
        const parsed = JSON.parse(data);
        if (claudeRes.statusCode !== 200) {
          conversationHistory.pop();
          return res.status(claudeRes.statusCode).json({ error: 'Claude API error', detail: parsed });
        }
        const fullText = parsed.content && parsed.content[0] && parsed.content[0].text || '';
        addToHistory('assistant', fullText);
        console.log('claude-tts response:', fullText.slice(0, 80));

        const { spoken, commands } = parsePipeResponse(fullText);
        enqueueFretboardCommands(commands);
        if (!spoken) return res.status(500).json({ error: 'Empty spoken text' });

        try {
          const audioBuffer = await synthesizeToBuffer(spoken);
          res.set({
            'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.length,
            'X-Vizi-Text':     encodeURIComponent(spoken.substring(0, 500)),
            'X-Vizi-Commands': encodeURIComponent(commands.substring(0, 500)),
            'Cache-Control':   'no-cache'
          });
          res.send(audioBuffer);
        } catch (ttsErr) {
          res.status(500).json({ error: 'TTS failed', detail: ttsErr.message });
        }
      } catch (err) {
        conversationHistory.pop();
        res.status(500).json({ error: 'Parse error', detail: err.message });
      }
    });
  });
  claudeReq.on('error', err => {
    conversationHistory.pop();
    res.status(500).json({ error: 'Claude request failed', detail: err.message });
  });
  claudeReq.write(claudeBody);
  claudeReq.end();
});

// ─── STT + Claude + TTS combined — single round trip ─────────────────────────
// POST /stt-claude-tts
// Request:  { "audio": "<base64 LINEAR16>", "sampleRate": 17000, "mode": "general" }
// Response: MP3 bytes + X-Vizi-Text + X-Vizi-Commands + X-Vizi-Transcript headers
// ─────────────────────────────────────────────────────────────────────────────
app.post('/stt-claude-tts', async (req, res) => {
  const tHandlerStart = Date.now();
  const audioContent = req.body && req.body.audio;
  const sampleRate   = (req.body && req.body.sampleRate) || 17000;
  const mode         = (req.body && req.body.mode) || 'general';

  console.log('POST /stt-claude-tts sampleRate:', sampleRate, 'audioLen:', audioContent && audioContent.length);

  if (!audioContent) return res.status(400).json({ error: 'Missing audio content' });
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // ── Step 1: Google STT ────────────────────────────────────────────────────
  const tSttStart = Date.now();
  let transcript = '';
  let tSttEnd = null;
  try {
    const sttBody = JSON.stringify({
      config: { encoding: 'LINEAR16', sampleRateHertz: sampleRate, languageCode: 'en-US', model: 'default' },
      audio:  { content: audioContent }
    });

    transcript = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'speech.googleapis.com',
        path: '/v1/speech:recognize?key=' + encodeURIComponent(GOOGLE_API_KEY),
        method: 'POST', agent: googleAgent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sttBody) }
      };
      const sttReq = https.request(options, (sttRes) => {
        let data = '';
        sttRes.on('data', chunk => { data += chunk; });
        sttRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (sttRes.statusCode !== 200) return reject(new Error('STT error: ' + sttRes.statusCode));
            if (!parsed.results || parsed.results.length === 0) return resolve('');
            resolve(parsed.results[0].alternatives[0].transcript || '');
          } catch (err) { reject(err); }
        });
      });
      sttReq.on('error', err => reject(err));
      sttReq.write(sttBody);
      sttReq.end();
    });
  } catch (err) {
    console.error('STT error:', err.message);
    return res.status(500).json({ error: 'STT failed', detail: err.message });
  }
  tSttEnd = Date.now();

  console.log('STT transcript:', transcript, `(${tSttEnd - tSttStart}ms)`);

  if (!transcript || transcript.trim().length === 0) {
    return res.json({ transcript: '', empty: true });
  }

  // ── Step 2: Claude ────────────────────────────────────────────────────────
  const tClaudeStart = Date.now();
  let tClaudeEnd = null;
  let fullText = '';
  try {
    let systemText = SYSTEM_PROMPT;
    if      (mode === 'song'       && SONG_PROMPT)       systemText = SYSTEM_PROMPT + '\n\n' + SONG_PROMPT;
    else if (mode === 'strumming'  && STRUMMING_PROMPT) systemText = SYSTEM_PROMPT + '\n\n' + STRUMMING_PROMPT;
    else if (mode === 'soloing'    && SOLOING_PROMPT)   systemText = SYSTEM_PROMPT + '\n\n' + SOLOING_PROMPT;
    else if (mode === 'talk'       && REMINDER_PROMPT)  systemText = SYSTEM_PROMPT + '\n\n' + REMINDER_PROMPT;

    getHistory();
    addToHistory('user', transcript.trim());
    const messages = [...conversationHistory];

    const claudeBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
      system: systemText, messages
    });

    fullText = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(claudeBody)
        }
      };
      const claudeReq = https.request(options, (claudeRes) => {
        let data = '';
        claudeRes.on('data', chunk => { data += chunk; });
        claudeRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (claudeRes.statusCode !== 200) {
              conversationHistory.pop();
              return reject(new Error('Claude error: ' + claudeRes.statusCode));
            }
            const text = parsed.content && parsed.content[0] && parsed.content[0].text || '';
            addToHistory('assistant', text);
            console.log('stt-claude-tts Claude:', text.slice(0, 80));
            resolve(text);
          } catch (err) { conversationHistory.pop(); reject(err); }
        });
      });
      claudeReq.on('error', err => { conversationHistory.pop(); reject(err); });
      claudeReq.write(claudeBody);
      claudeReq.end();
    });
  } catch (err) {
    console.error('Claude error:', err.message);
    return res.status(500).json({ error: 'Claude failed', detail: err.message });
  }
  tClaudeEnd = Date.now();

  // ── Step 3: Google TTS ────────────────────────────────────────────────────
  const { spoken, commands } = parsePipeResponse(fullText);
  enqueueFretboardCommands(commands);
  if (!spoken) return res.status(500).json({ error: 'Empty spoken text from Claude' });

  const tTtsStart = Date.now();
  try {
    const audioBuffer = await synthesizeToBuffer(spoken);
    const tTtsEnd = Date.now();
    console.log('stt-claude-tts complete — transcript:', transcript, 'spoken:', spoken.slice(0, 60));

    const timing = {
      total:  tTtsEnd - tHandlerStart,
      stt:    tSttEnd - tSttStart,
      claude: tClaudeEnd - tClaudeStart,
      tts:    tTtsEnd - tTtsStart
    };
    console.log('stt-claude-tts timing:', timing);

    res.set({
      'Content-Type':      'audio/mpeg',
      'Content-Length':    audioBuffer.length,
      'X-Vizi-Transcript': encodeURIComponent(transcript.substring(0, 200)),
      'X-Vizi-Text':       encodeURIComponent(spoken.substring(0, 500)),
      'X-Vizi-Commands':   encodeURIComponent(commands.substring(0, 500)),
      'X-Vizi-Timing':     encodeURIComponent(JSON.stringify(timing)),
      'Cache-Control':     'no-cache'
    });
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: 'TTS failed', detail: err.message });
  }
});

// ─── Google STT standalone ────────────────────────────────────────────────────
app.post('/stt', (req, res) => {
  console.log('POST /stt received');
  if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });

  const audioContent = req.body && req.body.audio;
  const sampleRate   = (req.body && req.body.sampleRate) || 17000;
  if (!audioContent) return res.status(400).json({ error: 'Missing audio content' });

  const sttBody = JSON.stringify({
    config: { encoding: 'LINEAR16', sampleRateHertz: sampleRate, languageCode: 'en-US', model: 'default' },
    audio:  { content: audioContent }
  });

  const options = {
    hostname: 'speech.googleapis.com',
    path: '/v1/speech:recognize?key=' + encodeURIComponent(GOOGLE_API_KEY),
    method: 'POST', agent: googleAgent,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sttBody) }
  };

  const googleReq = https.request(options, (googleRes) => {
    let data = '';
    googleRes.on('data', chunk => { data += chunk; });
    googleRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (googleRes.statusCode !== 200) return res.status(googleRes.statusCode).json({ error: 'Google STT error', detail: parsed });
        if (!parsed.results || parsed.results.length === 0) return res.json({ transcript: '', confidence: 0 });
        const transcript = parsed.results[0].alternatives[0].transcript || '';
        const confidence = parsed.results[0].alternatives[0].confidence || 0;
        res.json({ transcript, confidence });
      } catch (err) { res.status(500).json({ error: 'STT parse error', detail: err.message }); }
    });
  });
  googleReq.on('error', err => res.status(500).json({ error: 'STT request failed', detail: err.message }));
  googleReq.write(sttBody);
  googleReq.end();
});

// ─── Song Preview ─────────────────────────────────────────────────────────────
app.post('/song-preview', async (req, res) => {
  const query = req.body && req.body.query;
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const fallbackUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
  if (!YOUTUBE_API_KEY) return res.json({ videoUrl: fallbackUrl, title: query, query, fallback: true });

  try {
    const searchPath = '/youtube/v3/search?part=snippet&type=video&maxResults=1'
      + '&q=' + encodeURIComponent(query) + '&key=' + encodeURIComponent(YOUTUBE_API_KEY);

    const result = await new Promise((resolve, reject) => {
      const options = { hostname: 'www.googleapis.com', path: searchPath, method: 'GET' };
      const ytReq = https.request(options, (ytRes) => {
        let data = '';
        ytRes.on('data', chunk => { data += chunk; });
        ytRes.on('end', () => { try { resolve({ status: ytRes.statusCode, data: JSON.parse(data) }); } catch (err) { reject(err); } });
      });
      ytReq.on('error', err => reject(err));
      ytReq.end();
    });

    const items = result.data.items;
    if (!items || items.length === 0) return res.json({ videoUrl: fallbackUrl, title: query, query, fallback: true });
    const videoId = items[0].id.videoId;
    const title   = items[0].snippet.title;
    res.json({ videoUrl: 'https://www.youtube.com/watch?v=' + videoId, title, query, fallback: false });
  } catch (err) {
    res.json({ videoUrl: fallbackUrl, title: query, query, fallback: true });
  }
});

// ─── Claude standalone ────────────────────────────────────────────────────────
app.post('/claude', (req, res) => {
  let message = req.body && req.body.message;
  const mode  = req.body && req.body.mode;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  message = message.replace(/[\r\n]+/g, ' ').trim();

  let systemText = SYSTEM_PROMPT;
  if      (mode === 'song'       && SONG_PROMPT)       systemText = SYSTEM_PROMPT + '\n\n' + SONG_PROMPT;
  else if (mode === 'strumming'  && STRUMMING_PROMPT) systemText = SYSTEM_PROMPT + '\n\n' + STRUMMING_PROMPT;
  else if (mode === 'soloing'    && SOLOING_PROMPT)   systemText = SYSTEM_PROMPT + '\n\n' + SOLOING_PROMPT;
  else if (mode === 'talk'       && REMINDER_PROMPT)  systemText = SYSTEM_PROMPT + '\n\n' + REMINDER_PROMPT;

  getHistory();
  addToHistory('user', message);
  const messages = [...conversationHistory];

  const claudeBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
    system: systemText, messages
  });

  const options = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(claudeBody)
    }
  };

  const claudeReq = https.request(options, (claudeRes) => {
    let data = '';
    claudeRes.on('data', chunk => { data += chunk; });
    claudeRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (claudeRes.statusCode !== 200) {
          conversationHistory.pop();
          return res.status(claudeRes.statusCode).json({ error: 'Claude API error', detail: parsed });
        }
        const text = parsed.content && parsed.content[0] && parsed.content[0].text || '';
        addToHistory('assistant', text);
        res.json({ text });
      } catch (err) { conversationHistory.pop(); res.status(500).json({ error: 'Parse error', detail: err.message }); }
    });
  });
  claudeReq.on('error', err => { conversationHistory.pop(); res.status(500).json({ error: 'Claude request failed', detail: err.message }); });
  claudeReq.write(claudeBody);
  claudeReq.end();
});

// ─── Session endpoints ────────────────────────────────────────────────────────
app.post('/session-create', (req, res) => {
  const songTitle = (req.body && req.body.songTitle) || '';
  const id = createSession(songTitle);
  res.json({ sessionId: id, uploadUrl: `https://aivisualguitar.com/upload?session=${id}`, qrContent: `https://aivisualguitar.com/upload?session=${id}` });
});
app.get('/session-create', (req, res) => {
  const songTitle = req.query.song || '';
  const id = createSession(songTitle);
  res.json({ sessionId: id, uploadUrl: `https://aivisualguitar.com/upload?session=${id}`, qrContent: `https://aivisualguitar.com/upload?session=${id}` });
});
app.get('/session-status/:id', (req, res) => {
  const id = req.params.id.trim().toUpperCase();
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found', id });
  res.json({ sessionId: id, status: session.status, songTitle: session.songTitle, type: session.type, chords: session.chords, progression: session.progression, tabTokens: session.tabTokens, error: session.error });
});
// Matches the pattern reference in the Strumming prompt exactly — used so Song Mode
// can both speak the down/up motion and render a visual arrow/count display,
// rather than relying on a bare pattern name the student may not have learned yet.
const STRUM_PATTERNS = {
  'Pattern 1 — All Down':        { name: 'All Down',        arrows: '↓ ↓ ↓ ↓',     counts: '1 2 3 4',           spoken: 'down, down, down, down' },
  'Pattern 2 — Down Up':         { name: 'Down Up',         arrows: '↓ ↑ ↓ ↑',     counts: '1 and 2 and',       spoken: 'down, up, down, up' },
  'Pattern 3 — Common Pop Rock': { name: 'Common Pop Rock', arrows: '↓ ↓ ↑ ↑ ↓ ↑', counts: '1 2 and and 4 and', spoken: 'down, down, up, up, down, up' },
  'Pattern 4 — Reggae Skank':    { name: 'Reggae Skank',    arrows: '✗ ↑ ✗ ↑',     counts: '1 and 2 and',       spoken: 'skip, up, skip, up' },
  'Pattern 5 — Ballad':          { name: 'Ballad',          arrows: '↓ ↓ ↑ ↓ ↑',   counts: '1 2 and 3 and',     spoken: 'down, down, up, down, up' },
};

app.get('/session-prompt/:id', (req, res) => {
  const id = req.params.id.trim().toUpperCase();
  const session = sessions[id];
  if (!session) return res.status(404).json({ ready: false, error: 'Session not found', id });
  if (session.status !== 'ready') return res.json({ ready: false, status: session.status, id });

  const songTitle        = session.songTitle        || 'this song';
  const progression      = session.progression      || '';
  const type             = session.type             || 'chords';
  const chords           = session.chords           || [];
  const capo             = session.capo             || 0;
  const key              = session.key              || '';
  const timeSignature    = session.timeSignature    || '';
  const strummingPattern = session.strummingPattern || '';
  const suggestedBpm     = session.suggestedBpm;
  const chordList        = chords.length > 0 ? chords.join(', ') : 'various chords';

  const patternInfo = STRUM_PATTERNS[strummingPattern] || null;

  let message = 'SONG RECEIVED: ' + songTitle + '. ';
  if (progression) message += 'Full progression data: ' + progression + '. ';
  message += 'Unique chords in this song: ' + chordList + '. ';
  if (key) message += 'Estimated key: ' + key + '. ';
  if (timeSignature) message += 'Time signature: ' + timeSignature + '. ';
  if (patternInfo) {
    message += 'Suggested strumming pattern: ' + patternInfo.name + ' — the motion is ' + patternInfo.spoken + '. ';
    message += 'This exact pattern is shown visually on screen, and the student can practice it on the Strumming stage before coming back if they want to. ';
  }
  if (suggestedBpm) message += 'Suggested metronome tempo: ' + suggestedBpm + ' BPM. ';
  if (capo > 0) message += 'Capo is on fret ' + capo + '. ';
  else          message += 'No capo for this song. ';
  if (type === 'tab' || type === 'mixed') message += 'This song also includes tab and melody sections. ';
  message += 'You now have this song loaded. Follow your Song Mode initial response rules exactly. Your spoken introduction must come first, then append the CAPO command as a pipe command at the very end of your response.';

  res.json({
    ready: true, sessionId: id, songTitle, message, mode: 'song',
    key: key || null,
    timeSignature: timeSignature || null,
    suggestedBpm: suggestedBpm || null,
    strumPattern: patternInfo ? { name: patternInfo.name, arrows: patternInfo.arrows, counts: patternInfo.counts } : null
  });
});

app.post('/song-upload', (req, res, next) => {
  if (!multer) return res.status(500).json({ error: 'File upload not available' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'File upload error', detail: err.message });
    handleSongUpload(req, res);
  });
});

async function handleSongUpload(req, res) {
  const sessionId  = (req.body && req.body.session) || (req.query && req.query.session);
  const pastedText = req.body && req.body.text;
  const file       = req.file;
  if (!sessionId) return res.status(400).json({ error: 'Missing session ID' });
  const id = sessionId.toUpperCase();
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found or expired', id });
  if (!file && !pastedText) return res.status(400).json({ error: 'No file or text provided' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  session.status = 'processing';

  try {
    let claudeContent = [];
    if (file) {
      const mimeType   = file.mimetype || 'image/jpeg';
      const base64Data = file.buffer.toString('base64');
      if (mimeType === 'application/pdf') {
        claudeContent = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }, { type: 'text', text: buildAnalysisPrompt(session.songTitle) }];
      } else {
        claudeContent = [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } }, { type: 'text', text: buildAnalysisPrompt(session.songTitle) }];
      }
    } else {
      claudeContent = [{ type: 'text', text: buildTextAnalysisPrompt(pastedText, session.songTitle) }];
    }

    const claudeBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1500,
      system: `You are a music analysis assistant for the Vizi AI guitar tutor system. Your job is to extract chord and tab information from uploaded music and return it as structured JSON. Always respond with ONLY valid JSON — no markdown, no explanation, no code fences.`,
      messages: [{ role: 'user', content: claudeContent }]
    });

    const result = await callClaudeAPI(claudeBody);
    const parsed = parseClaudeAnalysis(result);

    session.type = parsed.type; session.chords = parsed.chords || [];
    session.progression = parsed.progression || ''; session.tabTokens = parsed.tabTokens || [];
    session.rawText = parsed.rawText || ''; session.songTitle = parsed.songTitle || session.songTitle;
    session.capo = parsed.capo || 0;
    session.key = parsed.key || ''; session.timeSignature = parsed.timeSignature || '4/4'; session.strummingPattern = parsed.strummingPattern || ''; session.suggestedBpm = normalizeBpm(parsed.suggestedBpm);
    session.status = 'ready';

    res.json({ status: 'ready', sessionId: id, type: session.type, chords: session.chords, progression: session.progression, message: 'Song uploaded successfully. Vizi is ready!' });
  } catch (err) {
    session.status = 'error'; session.error = err.message;
    res.status(500).json({ error: 'Failed to process upload', detail: err.message });
  }
}

function buildAnalysisPrompt(songTitle) {
  return `Analyze this image of sheet music, a chord chart, or guitar tab.
${songTitle ? `The song is "${songTitle}".` : ''}
Return ONLY this JSON structure (no markdown, no explanation):
{"songTitle":"song name if visible or provided","type":"chords","capo":0,"key":"G major","timeSignature":"4/4","strummingPattern":"Pattern 3 — Common Pop Rock","suggestedBpm":90,"chords":["G","Em","C","D"],"progression":"[Verse] G Em C D | [Chorus] C G Am F","tabTokens":[],"rawText":"any text you extracted"}
RULES:
- "type" must be "chords", "tab", or "mixed"
- "capo" must be a number — 0 if no capo
- "key" is your best-guess overall key of the song (e.g. "G major", "A minor"), based on the chords and progression
- "timeSignature" is your best-guess time signature (e.g. "4/4", "3/4", "6/8") — default to "4/4" if you cannot determine it, since that's overwhelmingly the most common
- "strummingPattern" must be exactly one of these five, chosen for the best feel match: "Pattern 1 — All Down", "Pattern 2 — Down Up", "Pattern 3 — Common Pop Rock", "Pattern 4 — Reggae Skank", "Pattern 5 — Ballad"
- "suggestedBpm" is a single number — your best estimate of the song's tempo, typically between 60 and 140
- "chords" must use standard chord names
- "progression" should preserve section labels if visible
- "tabTokens" only for tab/mixed. String codes: He=high E, B, G, D, A, Le=low E
- If you cannot read clearly, return type:"chords" with empty chords array`;
}

function buildTextAnalysisPrompt(text, songTitle) {
  return `Analyze this guitar chord chart or tab text.
${songTitle ? `The song is "${songTitle}".` : ''}
TEXT:
${text}
Return ONLY this JSON structure (no markdown, no explanation):
{"songTitle":"song name if visible or provided","type":"chords","capo":0,"key":"G major","timeSignature":"4/4","strummingPattern":"Pattern 3 — Common Pop Rock","suggestedBpm":90,"chords":["G","Em","C","D"],"progression":"[Verse] G Em C D | [Chorus] C G Am F","tabTokens":[],"rawText":"${text.replace(/"/g, "'").slice(0, 200)}"}
RULES:
- "type" must be "chords", "tab", or "mixed"
- "chords" must list every unique chord used
- "capo" must be a number — 0 if no capo
- "key" is your best-guess overall key of the song (e.g. "G major", "A minor"), based on the chords and progression
- "timeSignature" is your best-guess time signature (e.g. "4/4", "3/4", "6/8") — default to "4/4" if you cannot determine it, since that's overwhelmingly the most common
- "strummingPattern" must be exactly one of these five, chosen for the best feel match: "Pattern 1 — All Down", "Pattern 2 — Down Up", "Pattern 3 — Common Pop Rock", "Pattern 4 — Reggae Skank", "Pattern 5 — Ballad"
- "suggestedBpm" is a single number — your best estimate of the song's tempo, typically between 60 and 140
- "tabTokens" only for tab sections. String codes: He=high E, B, G, D, A, Le=low E`;
}

function callClaudeAPI(claudeBody) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(claudeBody) }
    };
    const apiReq = https.request(options, (claudeRes) => {
      let data = '';
      claudeRes.on('data', chunk => { data += chunk; });
      claudeRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (claudeRes.statusCode !== 200) return reject(new Error(`Claude API ${claudeRes.statusCode}: ${JSON.stringify(parsed)}`));
          resolve(parsed.content && parsed.content[0] && parsed.content[0].text || '');
        } catch (err) { reject(err); }
      });
    });
    apiReq.on('error', err => reject(err));
    apiReq.write(claudeBody);
    apiReq.end();
  });
}

function parseClaudeAnalysis(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); }
  catch(e) { return { type: 'chords', chords: [], progression: '', tabTokens: [], rawText: text, key: '', timeSignature: '4/4', strummingPattern: '', suggestedBpm: null }; }
}

// Safely coerce whatever Claude returns for suggestedBpm into a clean integer, or null if invalid.
// Guards against strings ("90"), missing values, non-numeric junk, and unreasonable outliers.
function normalizeBpm(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return null;
  if (n < 40 || n > 220) return null;
  return n;
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Vizi TTS Proxy listening on port ' + PORT);
  console.log('Voice:', VOICE_NAME);
  console.log('Claude ready:', !!ANTHROPIC_API_KEY);
  console.log('YouTube ready:', !!YOUTUBE_API_KEY);
  console.log('Multer ready:', !!multer);
  console.log('Song prompt ready:', !!SONG_PROMPT);
});

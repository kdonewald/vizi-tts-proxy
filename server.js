const express = require('express');
const https   = require('https');
const crypto  = require('crypto');
const app     = express();

// ─── CORS — allow aivisualguitar.com to call this server ────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── multer for multipart file uploads (song upload endpoint) ───────────────
let multer;
try { multer = require('multer'); } catch(e) { multer = null; }
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }) : null;

// ─── Keep-Alive agent for Google TTS ────────────────────────────────────────
const googleAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 4,
  keepAliveMsecs: 30000
});

// ─── Conversation History ────────────────────────────────────────────────────
const MAX_HISTORY     = 6;
const HISTORY_TTL_MS  = 10 * 60 * 1000;

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

// ─── Song Sessions (in-memory) ───────────────────────────────────────────────
const sessions = {};
const SESSION_TTL_MS = 30 * 60 * 1000;

function cleanOldSessions() {
  const now = Date.now();
  for (const id in sessions) {
    if (now - sessions[id].createdAt > SESSION_TTL_MS) {
      delete sessions[id];
    }
  }
}

function createSession(songTitle = '') {
  cleanOldSessions();
  const id = crypto.randomBytes(3).toString('hex').toUpperCase();
  sessions[id] = {
    status: 'waiting',
    createdAt: Date.now(),
    songTitle,
    type: null,
    chords: [],
    progression: '',
    tabTokens: [],
    rawText: '',
    error: null
  };
  return id;
}

// ─── Raw body parser (handles App Inventor PostText quirks) ─────────────────
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

// ─── Environment Variables ───────────────────────────────────────────────────
const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VOICE_NAME        = process.env.VOICE_NAME      || 'en-US-Neural2-F';
const LANGUAGE_CODE     = 'en-US';
const SYSTEM_PROMPT     = process.env.SYSTEM_PROMPT   || 'You are Vizi, an AI guitar tutor.';
const REMINDER_PROMPT   = process.env.REMINDER_PROMPT || '';
const SONG_PROMPT       = process.env.SONG_PROMPT     || '';  // ← Song mode rules

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'Vizi TTS Proxy running',
    voice: VOICE_NAME,
    model: 'claude-haiku-4-5-20251001',
    claudeReady: !!ANTHROPIC_API_KEY,
    historyLength: conversationHistory.length,
    historyIdleSecs: Math.floor((Date.now() - lastActivityTime) / 1000),
    activeSessions: Object.keys(sessions).length,
    multerReady: !!multer,
    songPromptReady: !!SONG_PROMPT   // ← confirms SONG_PROMPT env var is set
  });
});

// ─── Reset ───────────────────────────────────────────────────────────────────
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

// ─── Google TTS ──────────────────────────────────────────────────────────────
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

app.get('/tts', (req, res) => {
  const text = req.query.text;
  console.log('GET /tts text length:', text && text.length);
  if (!text) return res.status(400).json({ error: 'Missing text parameter' });
  if (text.length > 500) {
    console.warn('WARNING: GET /tts text is very long (' + text.length + ' chars)');
  }
  synthesize(text, res);
});

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

// ─── Claude API proxy ────────────────────────────────────────────────────────
// Modes:
//   "lesson" — SYSTEM_PROMPT only (default for regular tutoring)
//   "talk"   — SYSTEM_PROMPT + REMINDER_PROMPT (for conversational mode)
//   "song"   — SYSTEM_PROMPT + SONG_PROMPT (for song learning mode)
// ─────────────────────────────────────────────────────────────────────────────
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

  message = message.replace(/[\r\n]+/g, ' ').trim();

  // ─── Select system prompt based on mode ──────────────────────────────────
  let systemText;
  if (mode === 'song' && SONG_PROMPT) {
    // Song mode: full song teaching rules appended
    systemText = SYSTEM_PROMPT + '\n\n' + SONG_PROMPT;
    console.log('Using SONG mode system prompt');
  } else if (mode === 'talk' && REMINDER_PROMPT) {
    // Talk mode: reminder prompt appended
    systemText = SYSTEM_PROMPT + '\n\n' + REMINDER_PROMPT;
    console.log('Using TALK mode system prompt');
  } else {
    // Default lesson mode: system prompt only
    systemText = SYSTEM_PROMPT;
    console.log('Using LESSON mode system prompt');
  }

  getHistory();
  addToHistory('user', message);

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
          conversationHistory.pop();
          return res.status(claudeRes.statusCode).json({
            error: 'Claude API error',
            detail: parsed
          });
        }
        const text = parsed.content && parsed.content[0] && parsed.content[0].text || '';
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

// ════════════════════════════════════════════════════════════════════════════
// ─── SONG SESSION ENDPOINTS ──────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

app.post('/session-create', (req, res) => {
  const songTitle = (req.body && req.body.songTitle) || '';
  const id = createSession(songTitle);
  console.log('Session created:', id, 'song:', songTitle);
  res.json({
    sessionId: id,
    uploadUrl: `https://aivisualguitar.com/upload?session=${id}`,
    qrContent: `https://aivisualguitar.com/upload?session=${id}`
  });
});

app.get('/session-create', (req, res) => {
  const songTitle = req.query.song || '';
  const id = createSession(songTitle);
  console.log('Session created (GET):', id, 'song:', songTitle);
  res.json({
    sessionId: id,
    uploadUrl: `https://aivisualguitar.com/upload?session=${id}`,
    qrContent: `https://aivisualguitar.com/upload?session=${id}`
  });
});

app.get('/session-status/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  const session = sessions[id];
  if (!session) {
    return res.status(404).json({ error: 'Session not found', id });
  }
  res.json({
    sessionId: id,
    status: session.status,
    songTitle: session.songTitle,
    type: session.type,
    chords: session.chords,
    progression: session.progression,
    tabTokens: session.tabTokens,
    error: session.error
  });
});

app.post('/song-upload', (req, res, next) => {
  if (!multer) {
    return res.status(500).json({ error: 'File upload not available — multer not installed' });
  }
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err.message);
      return res.status(400).json({ error: 'File upload error', detail: err.message });
    }
    handleSongUpload(req, res);
  });
});

async function handleSongUpload(req, res) {
  const sessionId  = (req.body && req.body.session) || (req.query && req.query.session);
  const pastedText = req.body && req.body.text;
  const file       = req.file;

  console.log('Song upload — session:', sessionId, 'hasFile:', !!file, 'hasText:', !!pastedText);

  if (!sessionId) return res.status(400).json({ error: 'Missing session ID' });

  const id = sessionId.toUpperCase();
  const session = sessions[id];
  if (!session) return res.status(404).json({ error: 'Session not found or expired', id });
  if (!file && !pastedText) return res.status(400).json({ error: 'No file or text provided' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  session.status = 'processing';

  try {
    let claudeContent = [];
    let contentDescription = '';

    if (file) {
      const mimeType   = file.mimetype || 'image/jpeg';
      const base64Data = file.buffer.toString('base64');

      if (mimeType === 'application/pdf') {
        claudeContent = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
          { type: 'text', text: buildAnalysisPrompt(session.songTitle) }
        ];
      } else {
        claudeContent = [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
          { type: 'text', text: buildAnalysisPrompt(session.songTitle) }
        ];
      }
      contentDescription = `${mimeType} file (${Math.round(file.size/1024)}KB)`;
    } else {
      claudeContent      = [{ type: 'text', text: buildTextAnalysisPrompt(pastedText, session.songTitle) }];
      contentDescription = `pasted text (${pastedText.length} chars)`;
    }

    console.log('Sending to Claude Vision:', contentDescription);

    const claudeBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `You are a music analysis assistant for the Vizi AI guitar tutor system.
Your job is to extract chord and tab information from uploaded music and return it as structured JSON.
Always respond with ONLY valid JSON — no markdown, no explanation, no code fences.`,
      messages: [{ role: 'user', content: claudeContent }]
    });

    const result = await callClaudeAPI(claudeBody);
    const parsed = parseClaudeAnalysis(result);

    session.type        = parsed.type;
    session.chords      = parsed.chords      || [];
    session.progression = parsed.progression || '';
    session.tabTokens   = parsed.tabTokens   || [];
    session.rawText     = parsed.rawText      || '';
    session.songTitle   = parsed.songTitle    || session.songTitle;
    session.status      = 'ready';

    console.log('Session', id, 'ready — type:', session.type, 'chords:', session.chords.join(','));

    res.json({
      status: 'ready',
      sessionId: id,
      type: session.type,
      chords: session.chords,
      progression: session.progression,
      message: 'Song uploaded successfully. Vizi is ready!'
    });

  } catch (err) {
    console.error('Song upload error:', err.message);
    session.status = 'error';
    session.error  = err.message;
    res.status(500).json({ error: 'Failed to process upload', detail: err.message });
  }
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildAnalysisPrompt(songTitle) {
  return `Analyze this image of sheet music, a chord chart, or guitar tab.
${songTitle ? `The song is "${songTitle}".` : ''}

Return ONLY this JSON structure (no markdown, no explanation):
{
  "songTitle": "song name if visible or provided",
  "type": "chords",
  "chords": ["G","Em","C","D"],
  "progression": "[Verse] G Em C D | [Chorus] C G Am F",
  "tabTokens": [],
  "rawText": "any text you extracted"
}

RULES:
- "type" must be "chords" if it is a chord chart/lead sheet, "tab" if it is guitar tablature with string/fret numbers, or "mixed" if both.
- "chords" must use standard chord names: G, Am, C7, F#m, Bm, D/F#, etc.
- "progression" should preserve section labels like [Verse], [Chorus] if visible.
- "tabTokens" should only be populated for "tab" or "mixed" type. Each entry is a group of string-fret tokens like ["SHe2","SB3"] for simultaneous notes or ["SHe2"] for single notes. Use string codes: He=high E, B, G, D, A, Le=low E.
- If you cannot read the image clearly, return type:"chords" with empty chords array and explain in rawText.`;
}

function buildTextAnalysisPrompt(text, songTitle) {
  return `Analyze this guitar chord chart or tab text.
${songTitle ? `The song is "${songTitle}".` : ''}

TEXT:
${text}

Return ONLY this JSON structure (no markdown, no explanation):
{
  "songTitle": "song name if visible or provided",
  "type": "chords",
  "chords": ["G","Em","C","D"],
  "progression": "[Verse] G Em C D | [Chorus] C G Am F",
  "tabTokens": [],
  "rawText": "${text.replace(/"/g, "'").slice(0, 200)}"
}

RULES:
- "type" must be "chords" if it is a chord chart, "tab" if it is guitar tablature, or "mixed" if both.
- "chords" must list every unique chord used, using standard names.
- "progression" should preserve the full chord sequence with section labels if present.
- "tabTokens" only for tab sections — each entry is an array of SF tokens like ["SHe2","SB3"].
- String codes: He=high E, B, G, D, A, Le=low E.`;
}

// ─── Claude API helper (Promise-based) ───────────────────────────────────────

function callClaudeAPI(claudeBody) {
  return new Promise((resolve, reject) => {
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

    const req = https.request(options, (claudeRes) => {
      let data = '';
      claudeRes.on('data', chunk => { data += chunk; });
      claudeRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (claudeRes.statusCode !== 200) {
            return reject(new Error(`Claude API ${claudeRes.statusCode}: ${JSON.stringify(parsed)}`));
          }
          const text = parsed.content && parsed.content[0] && parsed.content[0].text || '';
          resolve(text);
        } catch (err) {
          reject(new Error('Parse error: ' + err.message));
        }
      });
    });

    req.on('error', err => reject(err));
    req.write(claudeBody);
    req.end();
  });
}

// ─── Parse Claude's JSON response ────────────────────────────────────────────

function parseClaudeAnalysis(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    console.error('Failed to parse Claude analysis JSON:', clean.slice(0, 200));
    return { type: 'chords', chords: [], progression: '', tabTokens: [], rawText: text };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ─── Start ───────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Vizi TTS Proxy listening on port ' + PORT);
  console.log('Voice:', VOICE_NAME);
  console.log('Claude ready:', !!ANTHROPIC_API_KEY);
  console.log('Multer ready:', !!multer);
  console.log('Song prompt ready:', !!SONG_PROMPT);
});

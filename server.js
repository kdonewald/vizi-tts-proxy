// Vizi server v7.8.8: verified CAGED facts + Just Talk isolation + follow-up detection + grouped SF whitelist + 900-char display text.
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
    status: 'waiting',
    createdAt: Date.now(),
    songTitle,
    type: null,
    chords: [],
    progression: '',
    progressions: [],
    tabTokens: [],
    rawText: '',
    capo: 0,
    key: '',
    timeSignature: '',
    strummingPattern: '',
    suggestedBpm: null,
    error: null
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

    if (cleaned.startsWith('text: ')) {
      cleaned = cleaned.slice(6);
    } else if (cleaned.startsWith('text=')) {
      cleaned = decodeURIComponent(cleaned.slice(5).replace(/\+/g, ' '));
    }

    cleaned = cleaned.replace(/[\r\n]+/g, ' ');

    try {
      req.body = JSON.parse(cleaned);
      return next();
    } catch(e) {}

    req.body = { text: cleaned };
    next();
  });
});

// ─── Environment Variables ──────────────────────────────────────────────────
const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const YOUTUBE_API_KEY   = process.env.YOUTUBE_API_KEY;
const VOICE_NAME        = process.env.VOICE_NAME || 'en-US-Neural2-F';
const LANGUAGE_CODE     = 'en-US';

const SYSTEM_PROMPT     = process.env.SYSTEM_PROMPT     || 'You are Vizi, an AI guitar tutor.';
const REMINDER_PROMPT   = process.env.REMINDER_PROMPT   || '';
const SONG_PROMPT       = process.env.SONG_PROMPT       || '';
const STRUMMING_PROMPT  = process.env.STRUMMING_PROMPT  || '';
const SOLOING_PROMPT    = process.env.SOLOING_PROMPT    || '';
const CURRICULUM_PROMPT = process.env.CURRICULUM_PROMPT || '';

// ─── Anthropic prompt caching ────────────────────────────────────────────────
function buildSystemText(mode) {
  let systemText = SYSTEM_PROMPT;

  if (mode === 'song' && SONG_PROMPT) {
    systemText = SYSTEM_PROMPT + '\n\n' + SONG_PROMPT;
  } else if (mode === 'strumming' && STRUMMING_PROMPT) {
    systemText = SYSTEM_PROMPT + '\n\n' + STRUMMING_PROMPT;
  } else if (mode === 'soloing' && SOLOING_PROMPT) {
    systemText = SYSTEM_PROMPT + '\n\n' + SOLOING_PROMPT;
  } else if (mode === 'talk' || mode === 'general') {
    systemText =
      SYSTEM_PROMPT +
      (REMINDER_PROMPT ? '\n\n' + REMINDER_PROMPT : '') +
      (CURRICULUM_PROMPT ? '\n\n' + CURRICULUM_PROMPT : '');
  }

  return systemText;
}

// V7.8.5: Question-specific guitar facts and Just Talk isolation are current-turn only.
// This does not change the selected teaching mode, curriculum, progress, or history.
const CAGED_ROOT_REFERENCE = Object.freeze({
  E: { string: 'Low E', offset: 0 },
  A: { string: 'A', offset: 0 },
  C: { string: 'A', offset: 3 },
  G: { string: 'Low E', offset: 3 },
  D: { string: 'D', offset: 0 }
});

function addQuestionSpecificGuitarFacts(systemText, userMessage) {
  const text = String(userMessage || '');
  const asksAboutRoot =
    /\b(root|route|tonic)\b/i.test(text) ||
    /\b(?:same|that)\s+(?:exact\s+)?question\b/i.test(text);
  if (!asksAboutRoot) return systemText;

  const shapeMatch = text.match(/\b([EACGD])(?:[\s-]*shape(?:d)?)\b/i);
  if (!shapeMatch) return systemText;

  const shape = shapeMatch[1].toUpperCase();
  const fact = CAGED_ROOT_REFERENCE[shape];
  if (!fact) return systemText;

  const relation = fact.offset === 0
    ? `The chord root is on the ${fact.string} string at the same fret as the ${shape}-shape position.`
    : `The chord root is on the ${fact.string} string three frets ABOVE the ${shape}-shape position. Root fret = shape-position fret + 3.`;

  const examples = shape === 'C'
    ? 'Examples: C-shape F has shape position 5 and root F at A-string fret 8; C-shape C is open/position 0 and its root C is at A-string fret 3.'
    : shape === 'G'
      ? 'Examples: G-shape C has shape position 5 and root C at Low-E fret 8; G-shape G is open/position 0 and its root G is at Low-E fret 3. Never say G-shape C at position 5 has its root at Low-E fret 6.'
      : '';

  return systemText + '\n\n' +
    'QUESTION-SPECIFIC VERIFIED GUITAR FACTS — USE FOR THIS QUESTION\n' +
    `The student explicitly asked about the root in the ${shape}-shape form. ` +
    `${relation} ` +
    (examples ? `${examples} ` : '') +
    'The CAGED table number is the shape/command position; it is not automatically the root fret. ' +
    'The letter C in “C shape” names the form, not the chord root. If the student names only a shape and no chord/root or fret position, give only the root-string and relative-position rule; do not invent a chord name or absolute fret. ' +
    'For example, C-shape position 5 is F major, with root F at A-string fret 8; C major in C shape is open/position 0, with root C at A-string fret 3. Never call the root C at C-shape position 5. ' +
    'This verified fact overrides any earlier instruction that would prevent answering this explicitly asked root-location question. ' +
    'Do not claim the bar finger itself is the root. A root is a note/location, not a finger. ' +
    'Do not guess a finger assignment; use the active diagram for exact fingering. ' +
    'Use this only to answer the current question. Preserve the current teaching mode, CURRENT STEPS, progress, and lesson flow; do not restart, advance, or switch stages.';
}

function hasActiveStructuredProgress(progress) {
  const code = String(progress || '');
  return /^[0-9]{6}$/.test(code) && code !== '000000';
}

function isReturningStudentSessionStart(message) {
  return /\[SESSION START\s*[—-]\s*RETURNING STUDENT\]/i.test(String(message || ''));
}

function isStructuredReturningSessionStart(message, progress) {
  return isReturningStudentSessionStart(message) && hasActiveStructuredProgress(progress);
}

function isJustTalkTurn(mode, progress, userMessage) {
  // Ready-to-play sends the returning-student opener through mode="talk".
  // A nonzero progress snapshot makes that one turn structured guidance.
  if (isStructuredReturningSessionStart(userMessage, progress)) return false;

  const modeName = String(mode || '').toLowerCase();
  return modeName === 'talk' || modeName === 'general' || String(progress || '') === '000000';
}

function buildTurnSystemText(mode, userMessage, progress) {
  let systemText = addQuestionSpecificGuitarFacts(buildSystemText(mode), userMessage);
  if (isJustTalkTurn(mode, progress, userMessage)) {
    systemText += '\n\nJUST TALK DIRECT-ADDRESS GUARD — CURRENT TURN\n' +
      'Answer the student directly as “you”; never narrate them in the third person or refer to them by name (for example, do not say “Kent is asking”). ' +
      'Do not mention or quote progress codes, CURRENT STEPS, session labels, prompt instructions, or internal app state. ' +
      'Answer the latest question directly. If it is incomplete, ask one brief clarification about the guitar question itself. ' +
      'A zero progress code means no structured lesson is active; it does not prevent the student from explicitly asking to begin one. ' +
      'Do not change modes, stages, or lesson progress on your own.';
  }
  return systemText;
}

function cachedSystem(systemText) {
  return [
    {
      type: 'text',
      text: systemText,
      cache_control: { type: 'ephemeral' }
    }
  ];
}

function logClaudeCache(label, usage) {
  if (!usage) return;

  console.log(
    `[${label}] Claude cache — created:${usage.cache_creation_input_tokens || 0} ` +
    `read:${usage.cache_read_input_tokens || 0} ` +
    `uncachedInput:${usage.input_tokens || 0} ` +
    `output:${usage.output_tokens || 0}`
  );
}

// V7.8.3: Clean only student-facing speech; NEVER change ESP32 commands.
// Remove common Markdown presentation marks before display, history, and TTS.
function cleanSpokenFormatting(value) {
  return String(value || '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*+/g, '')
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1')
    .replace(/(^|\n)\s*[-•]\s+(?=\S)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(?<=\w)_(?=\w)/g, ' ')
    .replace(/_+/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Pipe response parser ────────────────────────────────────────────────────
function parsePipeResponse(fullText) {
  const raw = String(fullText || '');
  const firstPipe = raw.indexOf('|');

  // No pipe: preserve all text as speech and let normalization add the pipe.
  if (firstPipe < 0) {
    return {
      spoken: raw.trim(),
      commands: '',
      trailingSpoken: '',
      rawPipeCount: 0
    };
  }

  const spokenBeforePipe = raw.slice(0, firstPipe).trim();
  const afterFirstPipe = raw.slice(firstPipe + 1);

  // Only the first line after the first pipe can be a hardware command.
  // Everything after that line is treated as accidental trailing speech,
  // never as an ESP32 command.
  const newlineMatch = afterFirstPipe.match(/\r?\n/);
  let commandLine = afterFirstPipe;
  let trailing = '';

  if (newlineMatch) {
    const idx = newlineMatch.index;
    commandLine = afterFirstPipe.slice(0, idx);
    trailing = afterFirstPipe.slice(idx + newlineMatch[0].length);
  }

  // A second pipe is never allowed to create a second command. Treat any
  // material around later pipes as trailing speech.
  const secondPipeInCommand = commandLine.indexOf('|');
  if (secondPipeInCommand >= 0) {
    trailing =
      commandLine.slice(secondPipeInCommand + 1) +
      (trailing ? '\n' + trailing : '');
    commandLine = commandLine.slice(0, secondPipeInCommand);
  }

  trailing = trailing.replace(/\|/g, ' ').trim();

  const spoken = [spokenBeforePipe, trailing]
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return {
    spoken,
    commands: commandLine.trim(),
    trailingSpoken: trailing,
    rawPipeCount: (raw.match(/\|/g) || []).length
  };
}

function normalizedPipeResponse(spoken, commands) {
  const cleanSpoken = cleanSpokenFormatting(String(spoken || '').replace(/\|/g, ' '));
  const cleanCommands = String(commands || '').replace(/\|/g, ' ').trim();
  return cleanCommands ? `${cleanSpoken} | ${cleanCommands}` : `${cleanSpoken} |`;
}


// V5.2: Recover a valid hardware command that Claude accidentally placed on
// the spoken side of the pipe. Recovery is intentionally conservative: only
// the entire spoken field or its final physical line may be promoted, and the
// candidate must already pass the normal command whitelist below.
function recoverMisplacedViziCommand(parsedPipe) {
  const out = { ...parsedPipe, commandRecovered: false };
  if (String(out.commands || '').trim()) return out;

  const spoken = String(out.spoken || '').trim();
  if (!spoken) return out;

  const lines = spoken.split(/\r?\n/);
  const candidate = String(lines[lines.length - 1] || '').trim();
  if (!candidate || !isAllowedViziCommand(candidate)) return out;

  // If Claude returned only the command before the pipe, keep TTS usable with
  // a short neutral acknowledgement. Otherwise remove only the final command
  // line from speech.
  const remaining = lines.slice(0, -1).join('\n').trim();
  out.spoken = remaining || 'Here you go.';
  out.commands = candidate;
  out.commandRecovered = true;
  return out;
}

// ─── Vizi command validator ──────────────────────────────────────────────────
// Claude controls the conversation; this layer controls what is allowed to
// reach the ESP32. Invalid or stage-owned commands are converted to an empty
// command while preserving Vizi's spoken response.
function userExplicitlyAskedForDisplay(text) {
  const t = String(text || '').toLowerCase();
  return /\b(show|display|light|lights|led|l\.e\.d|fretboard|show me|light up|put .* on)\b/.test(t);
}

function structuredStageFromSteps(steps) {
  const s = String(steps || '').trim();
  if (!s) return '';

  // CURRENT STEPS is a semicolon-separated list in a fixed category order.
  // The active structured stage is the category whose value is NOT
  // "not started". Do not simply take the first category (usually Warm-up).
  const entries = s.split(';');
  for (const entry of entries) {
    const m = entry.trim().match(
      /^(Warm-up|Warmup|Strumming|Theory|Song|Chords|Soloing)\s*=\s*(.+)$/i
    );
    if (!m) continue;
    if (/^not started$/i.test(m[2].trim())) continue;
    return m[1].toLowerCase().replace('warmup', 'warm-up');
  }

  return '';
}

function isAllowedViziCommand(command) {
  const c = String(command || '').trim();
  if (!c) return true;

  // Curriculum/stage words are never ESP32 commands.
  if (/^(WARM-?UP|SONG|SOLOING|STRUMMING|THEORY|STAGE|OPEN|PROGRESS|LESSON|PRACTICE)\b/i.test(c)) {
    return false;
  }

  // System controls.
  if (/^(OFF|TEST|RESET|CANCEL|SLOWER|FASTER)$/i.test(c)) return true;
  if (/^HOLD\s+(ON|OFF)$/i.test(c)) return true;
  if (/^CAPO\s+(?:OFF|(?:[0-9]|1[0-3]))$/i.test(c)) return true;
  if (/^FRET\s+(?:[0-9]|1[0-3])$/i.test(c)) return true;

  // String / note / scale display commands.
  if (/^STRING\s+(?:LE|A|D|G|B|HE)$/i.test(c)) return true;
  if (/^STRINGS\s+[\[(].+[\])]$/i.test(c)) return true;
  if (/^NOTES\s+[\[(].+[\])]$/i.test(c)) return true;
  if (/^SCALE\s+[A-G](?:#|b)?\s+(?:major|minor|pent|pentatonic)\s+(?:ALL|SHAPE\s+[1-5])$/i.test(c)) return true;
  if (/^S(?:He|B|G|D|A|Le)(?:[0-9]|1[0-3])$/i.test(c)) return true;
  // V7.8.8: grouped (simultaneous) or sequenced SF tokens, e.g. (SA3,SD2,SG0,SB3,SHe0) or [SG5,SG7,SG9].
  if (/^[\[(]\s*S(?:He|B|G|D|A|Le)(?:[0-9]|1[0-3])(?:\s*,\s*S(?:He|B|G|D|A|Le)(?:[0-9]|1[0-3]))*\s*[\])]$/i.test(c)) return true;

  // Triads and CAGED/bar shapes.
  if (/^TRIAD\s+(?:HE|B|G|D|A|LE)\s+[A-G](?:#|b)?m?$/i.test(c)) return true;
  if (/^(?:E|A|D)\s+SHAPE\s+[A-G](?:#|b)?m?(?:\s+PLAY)?$/i.test(c)) return true;
  if (/^(?:C|G)\s+SHAPE\s+[A-G](?:#|b)?(?:\s+PLAY)?$/i.test(c)) return true;

  // Power chords: named root+string or movable shape demo.
  if (/^CHORD\s+P\s+(?:[A-G](?:#|b)?(?:LE|A|D|G|B)|(?:LE|A|D|G|B)\s+PLAY)$/i.test(c)) return true;

  // Named/open chord. Keep this intentionally compact so prose such as
  // "CHORD Em PLAY and then..." cannot pass through.
  if (/^CHORD\s+[A-G](?:#|b)?(?:m|6|7|m7|maj7|add9|sus2|sus4|dim|aug|9|11|13)?$/i.test(c)) return true;

  // CHORDS is the firmware's sequence container. Require brackets/parentheses
  // and reject obvious prose punctuation/question text.
  if (/^CHORDS\s+[\[(].+[\])]$/i.test(c) && !/[?]/.test(c)) return true;

  return false;
}

function validateViziCommands(commands, context = {}) {
  const raw = String(commands || '').trim();
  if (!raw) return { commands: '', blocked: false, reason: '' };

  const stage = structuredStageFromSteps(context.steps);
  const explicitDisplay = userExplicitlyAskedForDisplay(context.userMessage);

  // These structured stages own their visual/practice behavior. A direct
  // student request such as "show me E minor pentatonic shape one" overrides
  // this suppression and may use a normal hardware command.
  if (!explicitDisplay && ['warm-up', 'strumming', 'theory'].includes(stage)) {
    return {
      commands: '',
      blocked: true,
      reason: `structured-${stage}-stage-owns-hardware`
    };
  }

  if (!isAllowedViziCommand(raw)) {
    return { commands: '', blocked: true, reason: 'not-in-command-whitelist' };
  }

  return { commands: raw, blocked: false, reason: '' };
}

// V5.2: Short acknowledgements are continuations of the immediately preceding
// assistant offer, not fresh requests for curriculum routing. This helper is
// deliberately narrow so mastery phrases such as “I've got this” still use
// normal structured-stage progress handling.
function isShortContinuationCue(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[.!?,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return /^(?:yes|yeah|yep|sure|okay|ok|go ahead|do it|show me|let's go|lets go|let's do it|lets do it|sure go ahead|okay show me|ok show me)$/.test(t);
}

// P5: prepend the student's progress code to the CURRENT user turn only.
function injectProgress(messages, progress, steps, mode) {
  const modeName = String(mode || '').toLowerCase();
  const progressCode = String(progress || '');
  if (!progressCode || !/^[0-9]{6}$/.test(progressCode)) return messages;
  if (!messages.length) return messages;

  const i = messages.length - 1;
  if (typeof messages[i].content !== 'string') return messages;

  const originalUserText = messages[i].content;
  const structuredSessionStart = isStructuredReturningSessionStart(originalUserText, progressCode);
  if (((modeName === 'talk' || modeName === 'general') && !structuredSessionStart) || progressCode === '000000') {
    return messages;
  }

  const continuation = isShortContinuationCue(originalUserText);

  let header = `PROGRESS: ${progress}.`;

  if (continuation) {
    header +=
      `\nCONVERSATION CONTINUATION — HARD: This short reply accepts/continues the ` +
      `immediately preceding assistant offer. Resolve it from conversation history first. ` +
      `Do NOT use CURRENT STEPS to replace that pending offer, start Warm-up, jump categories, ` +
      `or ask permission again. If the pending offer was a specific valid fretboard display, ` +
      `execute that exact display now.`;
  }

  if (steps && typeof steps === 'string' && steps.trim()) {
    header +=
      `\nCURRENT STEPS (already resolved from the code — teach THESE exact steps; ` +
      `do NOT re-derive them from the digits, and never say a step number aloud): ` +
      `${steps.trim().slice(0, 600)}`;
  }

  messages[i] = {
    ...messages[i],
    content: header + '\n' + messages[i].content
  };

  return messages;
}

// ─── Fretboard command relay ─────────────────────────────────────────────────
let fretboardQueue = [];
const FRETBOARD_QUEUE_MAX = 50;

function enqueueFretboardCommands(commandsStr) {
  if (!commandsStr) return;

  commandsStr.split('|').forEach(c => {
    // Defensive cleanup: an ESP32 command must never contain trailing prose.
    // Keep only the first physical line of each queued command.
    const cmd = c.split(/\r?\n/)[0].trim();
    if (!cmd) return;

    if (/^(OPEN|PROGRESS)\b/i.test(cmd)) return;

    if (/^SCALE\b/i.test(cmd)) {
      fretboardQueue.push('HOLD ON');
    }

    fretboardQueue.push(cmd);
  });

  if (fretboardQueue.length > FRETBOARD_QUEUE_MAX) {
    fretboardQueue = fretboardQueue.slice(-FRETBOARD_QUEUE_MAX);
  }
}

app.get('/fretboard-poll', (req, res) => {
  const command = fretboardQueue.shift() || null;

  if (command) {
    console.log(
      '[FRETBOARD POLL] sending:',
      command,
      '| remaining:',
      fretboardQueue.length
    );
  }

  res.json({
    command,
    remaining: fretboardQueue.length
  });
});

app.post('/fretboard-command', (req, res) => {
  const command = req.body && req.body.command;

  console.log(
    '[FRETBOARD COMMAND] received:',
    command || '(empty)'
  );

  if (!command) {
    return res.status(400).json({ error: 'Missing command' });
  }

  enqueueFretboardCommands(command);

  console.log(
    '[FRETBOARD COMMAND] queue now:',
    JSON.stringify(fretboardQueue)
  );

  res.json({
    status: 'queued',
    command,
    queued: fretboardQueue.length
  });
});

app.post('/fretboard-clear', (req, res) => {
  const cleared = fretboardQueue.length;
  fretboardQueue = [];

  console.log(`[fretboard-clear] Flushed ${cleared} queued command(s)`);

  res.json({
    status: 'ok',
    cleared
  });
});

app.get('/fretboard-clear', (req, res) => {
  const cleared = fretboardQueue.length;
  fretboardQueue = [];

  console.log(
    `[fretboard-clear GET] Flushed ${cleared} queued command(s)`,
    '| user-agent:',
    req.get('user-agent') || '',
    '| referer:',
    req.get('referer') || '',
    '| ip:',
    req.ip || ''
  );

  res.json({
    status: 'ok',
    cleared
  });
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'Vizi TTS Proxy running',
    voice: VOICE_NAME,
    model: 'claude-haiku-4-5-20251001',
    claudeReady: !!ANTHROPIC_API_KEY,
    youtubeReady: !!YOUTUBE_API_KEY,
    historyLength: conversationHistory.length,
    historyIdleSecs: Math.floor((Date.now() - lastActivityTime) / 1000),
    activeSessions: Object.keys(sessions).length,
    multerReady: !!multer,
    songPromptReady: !!SONG_PROMPT,
    fretboardQueued: fretboardQueue.length
  });
});

// ─── Reset ───────────────────────────────────────────────────────────────────
app.post('/reset', (req, res) => {
  conversationHistory = [];
  lastActivityTime = Date.now();

  console.log('Conversation history reset via POST');

  res.json({
    status: 'ok',
    message: 'Conversation history cleared'
  });
});

app.get('/reset', (req, res) => {
  conversationHistory = [];
  lastActivityTime = Date.now();

  console.log('Conversation history reset via GET');

  res.json({
    status: 'ok',
    message: 'Conversation history cleared'
  });
});

// ─── Vizi isolated QA test endpoint ───────────────────────────────────────────
// TESTING ONLY: Uses the same Vizi prompts/model as production, but keeps its
// own conversation history and NEVER calls TTS or queues commands to the guitar.
const viziTestSessions = new Map();
const VIZI_TEST_MAX_HISTORY = 20;
const VIZI_TEST_TTL_MS = 30 * 60 * 1000;

function getViziTestHistory(sessionId) {
  const id = String(sessionId || 'default').slice(0, 80);
  const now = Date.now();
  let session = viziTestSessions.get(id);

  if (!session || now - session.lastActivity > VIZI_TEST_TTL_MS) {
    session = { history: [], lastActivity: now };
    viziTestSessions.set(id, session);
  }

  session.lastActivity = now;
  return session.history;
}

app.post('/vizi-test', (req, res) => {
  let message = req.body && req.body.message;
  const mode = (req.body && req.body.mode) || 'general';
  const sessionId = (req.body && req.body.sessionId) || 'default';
  const reset = !!(req.body && req.body.reset);

  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }

  message = String(message).replace(/[\r\n]+/g, ' ').trim();
  const history = getViziTestHistory(sessionId);

  if (reset) history.length = 0;
  history.push({ role: 'user', content: message });
  if (history.length > VIZI_TEST_MAX_HISTORY) {
    history.splice(0, history.length - VIZI_TEST_MAX_HISTORY);
  }

  const messages = history.map(m => ({ ...m }));
  injectProgress(
    messages,
    req.body && req.body.progress,
    req.body && req.body.steps,
    mode
  );

  const systemText = buildTurnSystemText(mode, message, req.body && req.body.progress);
  const referenceContextApplied = systemText.includes('QUESTION-SPECIFIC VERIFIED GUITAR FACTS');
  const claudeBody = JSON.stringify({
    model: 'claude-haiku-5-5',
    max_tokens: 1000,
    system: cachedSystem(systemText),
    messages
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

  const claudeReq = https.request(options, claudeRes => {
    let data = '';
    claudeRes.on('data', chunk => { data += chunk; });
    claudeRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (claudeRes.statusCode !== 200) {
          history.pop();
          return res.status(claudeRes.statusCode).json({
            error: 'Claude API error',
            detail: parsed
          });
        }

        logClaudeCache('vizi-test', parsed.usage);
        const contentBlocks = Array.isArray(parsed.content) ? parsed.content : [];
        const textBlocks = contentBlocks.filter(
          block => block && block.type === 'text' && typeof block.text === 'string'
        );
        const rawFullText = textBlocks.map(block => block.text).join('');

        if (!rawFullText.trim()) {
          history.pop();
          const contentTypes = contentBlocks.map(block => block && block.type || 'unknown');
          console.error('[vizi-test] Claude response contained no text block', {
            model: parsed.model || 'unknown',
            stop_reason: parsed.stop_reason || 'unknown',
            contentTypes
          });
          return res.status(502).json({
            error: 'Claude response contained no text block',
            model: parsed.model || null,
            stop_reason: parsed.stop_reason || null,
            contentTypes
          });
        }

        const parsedPipe = parsePipeResponse(rawFullText);
        const recoveredPipe = recoverMisplacedViziCommand(parsedPipe);
        const spoken = cleanSpokenFormatting(recoveredPipe.spoken);
        const rawCommands = recoveredPipe.commands;
        const validation = validateViziCommands(rawCommands, {
          mode,
          steps: req.body && req.body.steps,
          userMessage: message
        });
        const commands = validation.commands;
        const fullText = normalizedPipeResponse(spoken, commands);

        // Store the normalized response so later turns see the same safe format
        // that the product actually uses.
        history.push({ role: 'assistant', content: fullText });
        if (history.length > VIZI_TEST_MAX_HISTORY) {
          history.splice(0, history.length - VIZI_TEST_MAX_HISTORY);
        }

        // IMPORTANT: test route intentionally does NOT call
        // enqueueFretboardCommands() and does NOT call TTS.
        res.json({
          test: true,
          sessionId: String(sessionId),
          fullText,
          rawFullText,
          spoken,
          commands,
          rawCommands,
          commandBlocked: validation.blocked,
          commandBlockReason: validation.reason,
          pipeCount: (fullText.match(/\|/g) || []).length,
          rawPipeCount: parsedPipe.rawPipeCount,
          commandRecovered: recoveredPipe.commandRecovered,
          responseNormalized: fullText !== rawFullText.trim(),
          referenceContextApplied,
          justTalkContextApplied: systemText.includes('JUST TALK DIRECT-ADDRESS GUARD'),
          progressContextInjected: Boolean(
            req.body && req.body.progress &&
            String(req.body.progress) !== '000000' &&
            String(mode || '').toLowerCase() !== 'talk'
          ),
          historyLength: history.length
        });
      } catch (err) {
        history.pop();
        res.status(500).json({ error: 'Parse error', detail: err.message });
      }
    });
  });

  claudeReq.on('error', err => {
    history.pop();
    res.status(500).json({ error: 'Claude request failed', detail: err.message });
  });

  claudeReq.write(claudeBody);
  claudeReq.end();
});

app.post('/vizi-test-reset', (req, res) => {
  const sessionId = String((req.body && req.body.sessionId) || 'default').slice(0, 80);
  viziTestSessions.delete(sessionId);
  res.json({ status: 'ok', sessionId, message: 'Vizi test conversation cleared' });
});

// ─── Spoken chord normalization ──────────────────────────────────────────────
function speakableChords(text) {
  if (!text) return text;

  const NOTE = '[A-G](?:#|b)?';

  const numWord = {
    '2': 'two',
    '4': 'four',
    '5': 'five',
    '6': 'six',
    '7': 'seven',
    '9': 'nine',
    '11': 'eleven',
    '13': 'thirteen'
  };

  const acc = n =>
    n.replace('#', ' sharp').replace(/b$/, ' flat');

  const spell = (note, q) => {
    let out = acc(note);

    switch (q) {
      case 'm':
        out += ' minor';
        break;
      case 'm7':
        out += ' minor seven';
        break;
      case 'maj7':
        out += ' major seven';
        break;
      case 'add9':
        out += ' add nine';
        break;
      case 'sus2':
        out += ' suspended two';
        break;
      case 'sus4':
        out += ' suspended four';
        break;
      case 'dim':
        out += ' diminished';
        break;
      case 'aug':
        out += ' augmented';
        break;
      case undefined:
      case '':
        break;
      default:
        out += ' ' + (numWord[q] || q);
        break;
    }

    return out;
  };

  const QUAL =
    '(?:maj7|m7|add9|sus2|sus4|dim|aug|m|7|6|9|11|13)';

  text = text.replace(
    new RegExp('\\b(' + NOTE + ')(' + QUAL + ')?\\/(' + NOTE + ')\\b', 'g'),
    (_, a, q, b) => spell(a, q) + ' over ' + acc(b)
  );

  text = text.replace(
    new RegExp('\\b(' + NOTE + ')(' + QUAL + ')\\b', 'g'),
    (_, a, q) => spell(a, q)
  );

  text = text.replace(/\b([A-G])#/g, '$1 sharp');
  text = text.replace(/\b([A-G])b\b/g, '$1 flat');

  return text;
}

// ─── Google TTS helper ───────────────────────────────────────────────────────
function synthesize(text, res) {
  text = speakableChords(cleanSpokenFormatting(text));

  console.log('Synthesizing:', text.slice(0, 80));

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({
      error: 'GOOGLE_API_KEY not set'
    });
  }

  const requestBody = JSON.stringify({
    input: { text },
    voice: {
      languageCode: LANGUAGE_CODE,
      name: VOICE_NAME
    },
    audioConfig: {
      audioEncoding: 'MP3'
    }
  });

  const options = {
    hostname: 'texttospeech.googleapis.com',
    path:
      '/v1/text:synthesize?key=' +
      encodeURIComponent(GOOGLE_API_KEY),
    method: 'POST',
    agent: googleAgent,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };

  const googleReq = https.request(options, googleRes => {
    let data = '';

    googleRes.on('data', chunk => {
      data += chunk;
    });

    googleRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);

        if (!parsed.audioContent) {
          console.error(
            'TTS error response:',
            JSON.stringify(parsed)
          );

          return res.status(500).json({
            error: 'No audio returned',
            detail: parsed
          });
        }

        const audioBuffer = Buffer.from(
          parsed.audioContent,
          'base64'
        );

        res.set({
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuffer.length,
          'Cache-Control': 'no-cache'
        });

        res.send(audioBuffer);
      } catch (err) {
        res.status(500).json({
          error: 'Parse error',
          detail: err.message
        });
      }
    });
  });

  googleReq.on('error', err => {
    res.status(500).json({
      error: 'Google TTS request failed',
      detail: err.message
    });
  });

  googleReq.write(requestBody);
  googleReq.end();
}

// ─── Promise TTS helper ──────────────────────────────────────────────────────
function synthesizeToBuffer(text) {
  text = speakableChords(cleanSpokenFormatting(text));

  return new Promise((resolve, reject) => {
    if (!GOOGLE_API_KEY) {
      return reject(
        new Error('GOOGLE_API_KEY not set')
      );
    }

    const requestBody = JSON.stringify({
      input: { text },
      voice: {
        languageCode: LANGUAGE_CODE,
        name: VOICE_NAME
      },
      audioConfig: {
        audioEncoding: 'MP3'
      }
    });

    const options = {
      hostname: 'texttospeech.googleapis.com',
      path:
        '/v1/text:synthesize?key=' +
        encodeURIComponent(GOOGLE_API_KEY),
      method: 'POST',
      agent: googleAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    };

    const googleReq = https.request(options, googleRes => {
      let data = '';

      googleRes.on('data', chunk => {
        data += chunk;
      });

      googleRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          if (!parsed.audioContent) {
            return reject(
              new Error('No audio returned from TTS')
            );
          }

          resolve(
            Buffer.from(
              parsed.audioContent,
              'base64'
            )
          );
        } catch (err) {
          reject(err);
        }
      });
    });

    googleReq.on('error', err => reject(err));

    googleReq.write(requestBody);
    googleReq.end();
  });
}

app.get('/tts', (req, res) => {
  const text = req.query.text;

  if (!text) {
    return res.status(400).json({
      error: 'Missing text parameter'
    });
  }

  synthesize(text, res);
});

app.post('/tts', (req, res) => {
  let text;

  if (typeof req.body === 'string') {
    try {
      text = JSON.parse(req.body).text;
    } catch(e) {
      text = req.body;
    }
  } else {
    text = req.body && req.body.text;
  }

  if (!text) {
    return res.status(400).json({
      error: 'Missing text parameter'
    });
  }

  synthesize(text, res);
});

// ─── Claude + TTS combined ───────────────────────────────────────────────────
app.post('/claude-tts', (req, res) => {
  let message = req.body && req.body.message;
  const mode  = req.body && req.body.mode;

  console.log(
    'POST /claude-tts mode:',
    mode,
    'message:',
    message && message.slice(0, 80)
  );

  if (!message) {
    return res.status(400).json({
      error: 'Missing message'
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not set'
    });
  }

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({
      error: 'GOOGLE_API_KEY not set'
    });
  }

  message = message
    .replace(/[\r\n]+/g, ' ')
    .trim();

  const systemText = buildTurnSystemText(mode, message, req.body && req.body.progress);

  getHistory();
  addToHistory('user', message);

  const messages = [...conversationHistory];

  injectProgress(
    messages,
    req.body && req.body.progress,
    req.body && req.body.steps,
    mode
  );

  const claudeBody = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: cachedSystem(systemText),
    messages
  });

  const claudeOptions = {
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

  const claudeReq = https.request(
    claudeOptions,
    claudeRes => {
      let data = '';

      claudeRes.on('data', chunk => {
        data += chunk;
      });

      claudeRes.on('end', async () => {
        try {
          const parsed = JSON.parse(data);

          if (claudeRes.statusCode !== 200) {
            conversationHistory.pop();

            return res
              .status(claudeRes.statusCode)
              .json({
                error: 'Claude API error',
                detail: parsed
              });
          }

          logClaudeCache(
            'claude-tts',
            parsed.usage
          );

          const rawFullText =
            parsed.content &&
            parsed.content[0] &&
            parsed.content[0].text ||
            '';

          const parsedPipe = parsePipeResponse(rawFullText);
          const recoveredPipe = recoverMisplacedViziCommand(parsedPipe);
          const spoken = cleanSpokenFormatting(recoveredPipe.spoken);
          const rawCommands = recoveredPipe.commands;

          const validation = validateViziCommands(rawCommands, {
            mode,
            steps: req.body && req.body.steps,
            userMessage: message
          });
          const commands = validation.commands;
          const fullText = normalizedPipeResponse(spoken, commands);

          addToHistory(
            'assistant',
            fullText
          );

          console.log(
            'claude-tts response:',
            fullText.slice(0, 80)
          );

          if (validation.blocked) {
            console.warn('[VIZI COMMAND BLOCKED]', validation.reason, '| raw:', rawCommands);
          }

          enqueueFretboardCommands(
            commands
          );

          if (!spoken) {
            return res.status(500).json({
              error: 'Empty spoken text'
            });
          }

          try {
            const audioBuffer =
              await synthesizeToBuffer(spoken);

            res.set({
              'Content-Type': 'audio/mpeg',
              'Content-Length':
                audioBuffer.length,
              'X-Vizi-Text':
                encodeURIComponent(
                  spoken.substring(0, 900)
                ),
              'X-Vizi-Commands':
                encodeURIComponent(
                  commands.substring(0, 500)
                ),
              'Cache-Control': 'no-cache'
            });

            res.send(audioBuffer);
          } catch (ttsErr) {
            res.status(500).json({
              error: 'TTS failed',
              detail: ttsErr.message
            });
          }
        } catch (err) {
          conversationHistory.pop();

          res.status(500).json({
            error: 'Parse error',
            detail: err.message
          });
        }
      });
    }
  );

  claudeReq.on('error', err => {
    conversationHistory.pop();

    res.status(500).json({
      error: 'Claude request failed',
      detail: err.message
    });
  });

  claudeReq.write(claudeBody);
  claudeReq.end();
});

// ─── STT + Claude + TTS ──────────────────────────────────────────────────────
app.post('/stt-claude-tts', async (req, res) => {
  const tHandlerStart = Date.now();

  const audioContent =
    req.body && req.body.audio;

  const sampleRate =
    (req.body && req.body.sampleRate) ||
    17000;

  const mode =
    (req.body && req.body.mode) ||
    'general';

  console.log(
    'POST /stt-claude-tts sampleRate:',
    sampleRate,
    'audioLen:',
    audioContent && audioContent.length
  );

  if (!audioContent) {
    return res.status(400).json({
      error: 'Missing audio content'
    });
  }

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({
      error: 'GOOGLE_API_KEY not set'
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not set'
    });
  }

  // ── Step 1: STT ──
  const tSttStart = Date.now();

  let transcript = '';
  let tSttEnd = null;

  try {
    const sttBody = JSON.stringify({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: sampleRate,
        languageCode: 'en-US',
        model: 'default'
      },
      audio: {
        content: audioContent
      }
    });

    transcript = await new Promise(
      (resolve, reject) => {
        const options = {
          hostname: 'speech.googleapis.com',
          path:
            '/v1/speech:recognize?key=' +
            encodeURIComponent(
              GOOGLE_API_KEY
            ),
          method: 'POST',
          agent: googleAgent,
          headers: {
            'Content-Type':
              'application/json',
            'Content-Length':
              Buffer.byteLength(sttBody)
          }
        };

        const sttReq = https.request(
          options,
          sttRes => {
            let data = '';

            sttRes.on('data', chunk => {
              data += chunk;
            });

            sttRes.on('end', () => {
              try {
                const parsed =
                  JSON.parse(data);

                if (
                  sttRes.statusCode !== 200
                ) {
                  return reject(
                    new Error(
                      'STT error: ' +
                      sttRes.statusCode
                    )
                  );
                }

                if (
                  !parsed.results ||
                  parsed.results.length === 0
                ) {
                  return resolve('');
                }

                resolve(
                  parsed.results[0]
                    .alternatives[0]
                    .transcript || ''
                );
              } catch (err) {
                reject(err);
              }
            });
          }
        );

        sttReq.on(
          'error',
          err => reject(err)
        );

        sttReq.write(sttBody);
        sttReq.end();
      }
    );
  } catch (err) {
    console.error(
      'STT error:',
      err.message
    );

    return res.status(500).json({
      error: 'STT failed',
      detail: err.message
    });
  }

  tSttEnd = Date.now();

  console.log(
    'STT transcript:',
    transcript,
    `(${tSttEnd - tSttStart}ms)`
  );

  if (
    !transcript ||
    transcript.trim().length === 0
  ) {
    return res.json({
      transcript: '',
      empty: true
    });
  }

  // ── Step 2: Claude ──
  const tClaudeStart = Date.now();

  let tClaudeEnd = null;
  let fullText = '';

  try {
    const systemText = buildTurnSystemText(
      mode,
      transcript.trim(),
      req.body && req.body.progress
    );

    getHistory();

    addToHistory(
      'user',
      transcript.trim()
    );

    const messages = [
      ...conversationHistory
    ];

    injectProgress(
      messages,
      req.body && req.body.progress,
      req.body && req.body.steps,
      mode
    );

    const claudeBody = JSON.stringify({
      model:
        'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: cachedSystem(systemText),
      messages
    });

    fullText = await new Promise(
      (resolve, reject) => {
        const options = {
          hostname:
            'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            'x-api-key':
              ANTHROPIC_API_KEY,
            'anthropic-version':
              '2023-06-01',
            'Content-Length':
              Buffer.byteLength(
                claudeBody
              )
          }
        };

        const claudeReq =
          https.request(
            options,
            claudeRes => {
              let data = '';

              claudeRes.on(
                'data',
                chunk => {
                  data += chunk;
                }
              );

              claudeRes.on(
                'end',
                () => {
                  try {
                    const parsed =
                      JSON.parse(data);

                    if (
                      claudeRes.statusCode
                      !== 200
                    ) {
                      conversationHistory.pop();

                      return reject(
                        new Error(
                          'Claude error: ' +
                          claudeRes.statusCode
                        )
                      );
                    }

                    logClaudeCache(
                      'stt-claude-tts',
                      parsed.usage
                    );

                    const text =
                      parsed.content &&
                      parsed.content[0] &&
                      parsed.content[0].text ||
                      '';

                    // Store raw model text only after the outer handler parses,
                    // validates, and normalizes it. This keeps conversational
                    // history consistent with what the student/product actually saw.
                    console.log(
                      'stt-claude-tts Claude:',
                      text.slice(0, 80)
                    );

                    resolve(text);
                  } catch (err) {
                    conversationHistory.pop();
                    reject(err);
                  }
                }
              );
            }
          );

        claudeReq.on(
          'error',
          err => {
            conversationHistory.pop();
            reject(err);
          }
        );

        claudeReq.write(claudeBody);
        claudeReq.end();
      }
    );
  } catch (err) {
    console.error(
      'Claude error:',
      err.message
    );

    return res.status(500).json({
      error: 'Claude failed',
      detail: err.message
    });
  }

  tClaudeEnd = Date.now();

  // ── Step 3: TTS ──
  const parsedPipe = parsePipeResponse(fullText);
  const recoveredPipe = recoverMisplacedViziCommand(parsedPipe);
  const spoken = cleanSpokenFormatting(recoveredPipe.spoken);
  const rawCommands = recoveredPipe.commands;

  const validation = validateViziCommands(rawCommands, {
    mode,
    steps: req.body && req.body.steps,
    userMessage: transcript
  });
  const commands = validation.commands;
  const normalizedAssistantText = normalizedPipeResponse(spoken, commands);
  addToHistory('assistant', normalizedAssistantText);

  if (validation.blocked) {
    console.warn('[VIZI COMMAND BLOCKED]', validation.reason, '| raw:', rawCommands);
  }

  enqueueFretboardCommands(
    commands
  );

  if (!spoken) {
    return res.status(500).json({
      error:
        'Empty spoken text from Claude'
    });
  }

  const tTtsStart = Date.now();

  try {
    const audioBuffer =
      await synthesizeToBuffer(spoken);

    const tTtsEnd = Date.now();

    console.log(
      'stt-claude-tts complete — transcript:',
      transcript,
      'spoken:',
      spoken.slice(0, 60)
    );

    const timing = {
      total:
        tTtsEnd - tHandlerStart,
      stt:
        tSttEnd - tSttStart,
      claude:
        tClaudeEnd - tClaudeStart,
      tts:
        tTtsEnd - tTtsStart
    };

    console.log(
      'stt-claude-tts timing:',
      timing
    );

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length':
        audioBuffer.length,
      'X-Vizi-Transcript':
        encodeURIComponent(
          transcript.substring(0, 200)
        ),
      'X-Vizi-Text':
        encodeURIComponent(
          spoken.substring(0, 900)
        ),
      'X-Vizi-Commands':
        encodeURIComponent(
          commands.substring(0, 500)
        ),
      'X-Vizi-Timing':
        encodeURIComponent(
          JSON.stringify(timing)
        ),
      'Cache-Control': 'no-cache'
    });

    res.send(audioBuffer);
  } catch (err) {
    console.error(
      'TTS error:',
      err.message
    );

    res.status(500).json({
      error: 'TTS failed',
      detail: err.message
    });
  }
});

// ─── Google STT standalone ───────────────────────────────────────────────────
app.post('/stt', (req, res) => {
  console.log('POST /stt received');

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({
      error: 'GOOGLE_API_KEY not set'
    });
  }

  const audioContent =
    req.body && req.body.audio;

  const sampleRate =
    (req.body && req.body.sampleRate) ||
    17000;

  if (!audioContent) {
    return res.status(400).json({
      error: 'Missing audio content'
    });
  }

  const sttBody = JSON.stringify({
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: sampleRate,
      languageCode: 'en-US',
      model: 'default'
    },
    audio: {
      content: audioContent
    }
  });

  const options = {
    hostname:
      'speech.googleapis.com',
    path:
      '/v1/speech:recognize?key=' +
      encodeURIComponent(
        GOOGLE_API_KEY
      ),
    method: 'POST',
    agent: googleAgent,
    headers: {
      'Content-Type':
        'application/json',
      'Content-Length':
        Buffer.byteLength(sttBody)
    }
  };

  const googleReq =
    https.request(
      options,
      googleRes => {
        let data = '';

        googleRes.on(
          'data',
          chunk => {
            data += chunk;
          }
        );

        googleRes.on(
          'end',
          () => {
            try {
              const parsed =
                JSON.parse(data);

              if (
                googleRes.statusCode
                !== 200
              ) {
                return res
                  .status(
                    googleRes.statusCode
                  )
                  .json({
                    error:
                      'Google STT error',
                    detail: parsed
                  });
              }

              if (
                !parsed.results ||
                parsed.results.length === 0
              ) {
                return res.json({
                  transcript: '',
                  confidence: 0
                });
              }

              const transcript =
                parsed.results[0]
                  .alternatives[0]
                  .transcript ||
                '';

              const confidence =
                parsed.results[0]
                  .alternatives[0]
                  .confidence ||
                0;

              res.json({
                transcript,
                confidence
              });
            } catch (err) {
              res.status(500).json({
                error:
                  'STT parse error',
                detail:
                  err.message
              });
            }
          }
        );
      }
    );

  googleReq.on(
    'error',
    err => {
      res.status(500).json({
        error:
          'STT request failed',
        detail: err.message
      });
    }
  );

  googleReq.write(sttBody);
  googleReq.end();
});

// ─── Song Preview ────────────────────────────────────────────────────────────
app.post('/song-preview', async (req, res) => {
  const query =
    req.body && req.body.query;

  if (!query) {
    return res.status(400).json({
      error: 'Missing query'
    });
  }

  const fallbackUrl =
    'https://www.youtube.com/results?search_query=' +
    encodeURIComponent(query);

  if (!YOUTUBE_API_KEY) {
    return res.json({
      videoUrl: fallbackUrl,
      title: query,
      query,
      fallback: true
    });
  }

  try {
    const searchPath =
      '/youtube/v3/search?part=snippet&type=video&maxResults=1' +
      '&q=' +
      encodeURIComponent(query) +
      '&key=' +
      encodeURIComponent(
        YOUTUBE_API_KEY
      );

    const result =
      await new Promise(
        (resolve, reject) => {
          const options = {
            hostname:
              'www.googleapis.com',
            path: searchPath,
            method: 'GET'
          };

          const ytReq =
            https.request(
              options,
              ytRes => {
                let data = '';

                ytRes.on(
                  'data',
                  chunk => {
                    data += chunk;
                  }
                );

                ytRes.on(
                  'end',
                  () => {
                    try {
                      resolve({
                        status:
                          ytRes.statusCode,
                        data:
                          JSON.parse(data)
                      });
                    } catch (err) {
                      reject(err);
                    }
                  }
                );
              }
            );

          ytReq.on(
            'error',
            err => reject(err)
          );

          ytReq.end();
        }
      );

    const items =
      result.data.items;

    if (
      !items ||
      items.length === 0
    ) {
      return res.json({
        videoUrl: fallbackUrl,
        title: query,
        query,
        fallback: true
      });
    }

    const videoId =
      items[0].id.videoId;

    const title =
      items[0].snippet.title;

    res.json({
      videoUrl:
        'https://www.youtube.com/watch?v=' +
        videoId,
      title,
      query,
      fallback: false
    });
  } catch (err) {
    res.json({
      videoUrl: fallbackUrl,
      title: query,
      query,
      fallback: true
    });
  }
});

// ─── Claude standalone ───────────────────────────────────────────────────────
app.post('/claude', (req, res) => {
  let message =
    req.body && req.body.message;

  const mode =
    req.body && req.body.mode;

  if (!message) {
    return res.status(400).json({
      error: 'Missing message'
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error:
        'ANTHROPIC_API_KEY not set'
    });
  }

  message = message
    .replace(/[\r\n]+/g, ' ')
    .trim();

  const systemText = buildTurnSystemText(
    mode,
    message,
    req.body && req.body.progress
  );

  getHistory();

  addToHistory(
    'user',
    message
  );

  const messages = [
    ...conversationHistory
  ];

  injectProgress(
    messages,
    req.body && req.body.progress,
    req.body && req.body.steps,
    mode
  );

  const claudeBody =
    JSON.stringify({
      model:
        'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system:
        cachedSystem(systemText),
      messages
    });

  const options = {
    hostname:
      'api.anthropic.com',
    path:
      '/v1/messages',
    method:
      'POST',
    headers: {
      'Content-Type':
        'application/json',
      'x-api-key':
        ANTHROPIC_API_KEY,
      'anthropic-version':
        '2023-06-01',
      'Content-Length':
        Buffer.byteLength(
          claudeBody
        )
    }
  };

  const claudeReq =
    https.request(
      options,
      claudeRes => {
        let data = '';

        claudeRes.on(
          'data',
          chunk => {
            data += chunk;
          }
        );

        claudeRes.on(
          'end',
          () => {
            try {
              const parsed =
                JSON.parse(data);

              if (
                claudeRes.statusCode
                !== 200
              ) {
                conversationHistory.pop();

                return res
                  .status(
                    claudeRes.statusCode
                  )
                  .json({
                    error:
                      'Claude API error',
                    detail: parsed
                  });
              }

              logClaudeCache(
                'claude',
                parsed.usage
              );

              const text =
                parsed.content &&
                parsed.content[0] &&
                parsed.content[0].text ||
                '';

              addToHistory(
                'assistant',
                text
              );

              res.json({
                text
              });
            } catch (err) {
              conversationHistory.pop();

              res.status(500).json({
                error:
                  'Parse error',
                detail:
                  err.message
              });
            }
          }
        );
      }
    );

  claudeReq.on(
    'error',
    err => {
      conversationHistory.pop();

      res.status(500).json({
        error:
          'Claude request failed',
        detail: err.message
      });
    }
  );

  claudeReq.write(claudeBody);
  claudeReq.end();
});

// ─── Session endpoints ───────────────────────────────────────────────────────
app.post('/session-create', (req, res) => {
  const songTitle =
    (req.body &&
      req.body.songTitle) ||
    '';

  const id =
    createSession(songTitle);

  res.json({
    sessionId: id,
    uploadUrl:
      `https://aivisualguitar.com/upload?session=${id}`,
    qrContent:
      `https://aivisualguitar.com/upload?session=${id}`
  });
});

app.get('/session-create', (req, res) => {
  const songTitle =
    req.query.song || '';

  const id =
    createSession(songTitle);

  res.json({
    sessionId: id,
    uploadUrl:
      `https://aivisualguitar.com/upload?session=${id}`,
    qrContent:
      `https://aivisualguitar.com/upload?session=${id}`
  });
});

app.get('/session-status/:id', (req, res) => {
  const id =
    req.params.id
      .trim()
      .toUpperCase();

  const session =
    sessions[id];

  if (!session) {
    return res
      .status(404)
      .json({
        error:
          'Session not found',
        id
      });
  }

  res.json({
    sessionId: id,
    status:
      session.status,
    songTitle:
      session.songTitle,
    type:
      session.type,
    chords:
      session.chords,
    progression:
      session.progression,
    tabTokens:
      session.tabTokens,
    error:
      session.error
  });
});

// ─── Strumming patterns ──────────────────────────────────────────────────────
const STRUM_PATTERNS = {
  'Pattern 1 — All Down': {
    name: 'All Down',
    arrows: '↓ ↓ ↓ ↓',
    counts: '1 2 3 4',
    spoken:
      'down, down, down, down'
  },

  'Pattern 2 — Down Up': {
    name: 'Down Up',
    arrows: '↓ ↑ ↓ ↑',
    counts: '1 and 2 and',
    spoken:
      'down, up, down, up'
  },

  'Pattern 3 — Common Pop Rock': {
    name: 'Common Pop Rock',
    arrows: '↓ ↓ ↑ ↑ ↓ ↑',
    counts:
      '1 2 and and 4 and',
    spoken:
      'down, down, up, up, down, up'
  },

  'Pattern 4 — Reggae Skank': {
    name: 'Reggae Skank',
    arrows: '✗ ↑ ✗ ↑',
    counts: '1 and 2 and',
    spoken:
      'skip, up, skip, up'
  },

  'Pattern 5 — Ballad': {
    name: 'Ballad',
    arrows: '↓ ↓ ↑ ↓ ↑',
    counts: '1 2 and 3 and',
    spoken:
      'down, down, up, down, up'
  }
};

// ─── Song assignment: chord simplification + practice progressions ───────────
// Built in code so the spoken lesson, the Chords-stage screen, and the chord
// counts always agree. Rules mirror the Song prompt's CHORD SIMPLIFICATION.
const SLASH_CHORDS_OK = ['Am/F#','Am7/G','C/B','C/G','D/A','D/F#','Em/B','Em/G','F/A','G/B','G/F#'];
const FLAT_TO_SHARP = { Db:'C#', Eb:'D#', Gb:'F#', Ab:'G#', Bb:'A#' };
const NATURAL_ROOTS = ['C','D','E','F','G','A','B'];
const QUAL_SUFFIX = { '':'', m:'m', '7':'7', m7:'m7', maj7:'maj7', '6':'6', m6:'m6' };

function normNoteName(n) {
  const t = String(n).charAt(0).toUpperCase() + String(n).slice(1);
  return FLAT_TO_SHARP[t] || t;
}

// Returns { name, changed, literal } or null when the token is not a chord.
function parseSongChord(token) {
  const literal = String(token || '').replace(/\([^)]*\)/g, '').replace(/[,;:.]+$/, '').trim();
  const m = literal.match(/^([A-G](?:#|b)?)([^\/]*)(?:\/([A-G](?:#|b)?))?$/);
  if (!m) return null;
  const root = normNoteName(m[1]);
  const q = m[2];
  const natural = NATURAL_ROOTS.indexOf(root) >= 0;
  let qual = null;
  let changed = false;

  if (/^(maj|Maj|M|Δ)/.test(q)) {
    const rest = q.replace(/^(maj|Maj|M|Δ)/, '');
    if (rest === '') qual = '';
    else if (/^7$/.test(rest)) qual = 'maj7';
    else if (/^(9|11|13)$/.test(rest)) { qual = 'maj7'; changed = true; }
    else if (/^(add|sus|6|2|4)/.test(rest)) { qual = ''; changed = true; }
  } else if (/^(m|min|-)/.test(q)) {
    const rest = q.replace(/^(min|m|-)/, '');
    if (rest === '') qual = 'm';
    else if (rest === '7') qual = 'm7';
    else if (/^(7|9|11|13)/.test(rest)) { qual = 'm7'; changed = true; }
    else if (rest === '6') { qual = natural ? 'm6' : 'm'; changed = !natural; }
    else if (/^(add|sus|2|4|b5|5|6)/.test(rest)) { qual = 'm'; changed = true; }
  } else {
    if (q === '') qual = '';
    else if (q === '7') qual = '7';
    else if (/^7sus/.test(q)) { qual = '7'; changed = true; }
    else if (/^7/.test(q)) { qual = '7'; changed = true; }
    else if (/^(9|11|13)$/.test(q)) { qual = '7'; changed = true; }
    else if (q === '6') { qual = natural ? '6' : ''; changed = !natural; }
    else if (/^(add|sus|2|4|5|6\/9|69)/.test(q)) { qual = ''; changed = true; }
    else if (/^(dim|o|°|ø)/.test(q)) { qual = 'm'; changed = true; }
    else if (/^(aug|\+)/.test(q)) { qual = ''; changed = true; }
  }
  if (qual === null) return null;

  let name = root + QUAL_SUFFIX[qual];
  if (m[3]) {
    const cand = name + '/' + normNoteName(m[3]);
    if (SLASH_CHORDS_OK.indexOf(cand) >= 0) name = cand;
    else if (normNoteName(m[3]) !== root) changed = true;
  }
  return { name, changed, literal };
}

function speakSongChord(name) {
  const m = String(name).match(/^([A-G])(#?)(maj7|m7|m6|m|7|6)?(?:\/([A-G])(#?))?$/);
  if (!m) return String(name);
  const words = { m: ' minor', '7': ' seven', m7: ' minor seven', maj7: ' major seven', '6': ' six', m6: ' minor six' };
  let out = m[1] + (m[2] ? ' sharp' : '') + (words[m[3] || ''] || '');
  if (m[4]) out += ' over ' + m[4] + (m[5] ? ' sharp' : '');
  return out;
}

function chordsFromProgressionText(text) {
  const out = [];
  String(text || '').replace(/\[[^\]]*\]/g, ' ').split(/[\s|]+/).forEach(tok => {
    const p = parseSongChord(tok);
    if (p) out.push(p);
  });
  return out;
}

function collapseRuns(arr) {
  const out = [];
  arr.forEach(x => { if (out[out.length - 1] !== x) out.push(x); });
  return out;
}

function fallbackProgressions(seq) {
  const c = collapseRuns(seq);
  const out = [];
  const covered = new Set();
  let i = 0;
  while (out.length < 3 && i < c.length) {
    const win = c.slice(i, i + 4);
    if (win.length >= 2) out.push(win);
    win.forEach(x => covered.add(x));
    const j = c.findIndex((x, idx) => idx > i && !covered.has(x));
    if (j < 0) break;
    i = Math.max(j - 1, i + 1);
  }
  return out;
}

function buildAssignment(session) {
  let parsedSeq = chordsFromProgressionText(session.progression);
  if (parsedSeq.length < 2) {
    parsedSeq = [];
    (session.chords || []).forEach(c => { const p = parseSongChord(c); if (p) parsedSeq.push(p); });
  }
  const seq = parsedSeq.map(p => p.name);
  const unique = [];
  seq.forEach(n => { if (unique.indexOf(n) < 0) unique.push(n); });

  const simplified = [];
  parsedSeq.forEach(p => {
    if (p.changed && !simplified.some(x => x.from === p.literal)) simplified.push({ from: p.literal, to: p.name });
  });

  const seen = new Set();
  let progressions = [];
  (Array.isArray(session.progressions) ? session.progressions : []).forEach(raw => {
    const toks = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,→>-]+/);
    const names = collapseRuns(toks.map(t => parseSongChord(t)).filter(Boolean).map(p => p.name))
      .filter(n => unique.indexOf(n) >= 0);
    const key = names.join('>');
    if (names.length >= 2 && !seen.has(key)) { seen.add(key); progressions.push(names.slice(0, 4)); }
  });
  progressions = progressions.slice(0, 3);
  if (!progressions.length) progressions = fallbackProgressions(seq);

  const pat = STRUM_PATTERNS[session.strummingPattern] || null;
  const target = session.suggestedBpm || null;
  let practice = target ? Math.max(50, Math.round((target * 0.75) / 5) * 5) : null;
  if (practice !== null && practice >= target) practice = null;

  return {
    title: session.songTitle || '',
    capo: session.capo || 0,
    key: session.key || '',
    chords: unique.map(name => ({ name, speak: speakSongChord(name) })),
    simplified: simplified.slice(0, 3),
    progressions,
    strum: pat ? { name: pat.name, arrows: pat.arrows, counts: pat.counts, spoken: pat.spoken } : null,
    bpm: target ? { target, practice } : null
  };
}

function assignmentMessageText(a) {
  const ord = ['first', 'second', 'third'];
  let t = 'ASSIGNMENT FROM THE APP (final, already simplified — speak exactly these chord names and never re-derive them; do not say the word assignment): ' +
    'Chords to practice (' + a.chords.length + '): ' + a.chords.map(c => c.speak).join(', ') + '. ';
  if (a.simplified.length) {
    t += 'Simplified from the sheet: ' + a.simplified.map(x => x.from + ' became ' + x.to).join('; ') + '. ';
  }
  if (a.progressions.length) {
    t += 'Progressions (the student also sees these on the Chords stage screen): ' +
      a.progressions.map((p, i) => ord[i] + ' progression: ' + p.map(speakSongChord).join(', ')).join('. ') + '. ';
  }
  return t;
}

// ─── Song prompt endpoint ────────────────────────────────────────────────────
app.get('/session-prompt/:id', (req, res) => {
  const id =
    req.params.id
      .trim()
      .toUpperCase();

  const session =
    sessions[id];

  if (!session) {
    return res
      .status(404)
      .json({
        ready: false,
        error:
          'Session not found',
        id
      });
  }

  if (
    session.status !==
    'ready'
  ) {
    return res.json({
      ready: false,
      status:
        session.status,
      id
    });
  }

  const songTitle =
    session.songTitle ||
    'this song';

  const progression =
    session.progression ||
    '';

  const type =
    session.type ||
    'chords';

  const chords =
    session.chords ||
    [];

  const capo =
    session.capo ||
    0;

  const key =
    session.key ||
    '';

  const timeSignature =
    session.timeSignature ||
    '';

  const strummingPattern =
    session.strummingPattern ||
    '';

  const suggestedBpm =
    session.suggestedBpm;

  const chordList =
    chords.length > 0
      ? chords.join(', ')
      : 'various chords';

  const patternInfo =
    STRUM_PATTERNS[
      strummingPattern
    ] || null;

  let message =
    'SONG RECEIVED: ' +
    songTitle +
    '. ';

  const assignment = buildAssignment(session);

  if (progression) {
    message +=
      'Sheet progression (reference only — when you speak chord names, use the ASSIGNMENT names below): ' +
      progression +
      '. ';
  }

  message += assignmentMessageText(assignment);

  if (key) {
    message +=
      'Estimated key: ' +
      key +
      '. ';
  }

  if (timeSignature) {
    message +=
      'Time signature: ' +
      timeSignature +
      '. ';
  }

  if (patternInfo) {
    message +=
      'Suggested strumming pattern: ' +
      patternInfo.name +
      ' — the motion is ' +
      patternInfo.spoken +
      '. ';

    message +=
      'This exact pattern is shown visually on screen. ';
  }

  if (suggestedBpm) {
    message +=
      'Suggested metronome tempo: ' +
      suggestedBpm +
      ' BPM. ';
  }

  if (capo > 0) {
    message +=
      'Capo is on fret ' +
      capo +
      '. ';
  } else {
    message +=
      'No capo for this song. ';
  }

  if (
    type === 'tab' ||
    type === 'mixed'
  ) {
    message +=
      'This song also includes tab and melody sections. ';
  }

  message +=
    'You now have this song loaded. Follow your Song Mode initial response rules exactly. ' +
    'Your spoken introduction must come first, then append the CAPO command as a pipe command ' +
    'at the very end of your response.';

  res.json({
    ready: true,
    sessionId: id,
    songTitle,
    message,
    assignment,
    mode: 'song',
    key: key || null,
    timeSignature:
      timeSignature || null,
    suggestedBpm:
      suggestedBpm || null,
    strumPattern:
      patternInfo
        ? {
            name:
              patternInfo.name,
            arrows:
              patternInfo.arrows,
            counts:
              patternInfo.counts
          }
        : null
  });
});

// ─── Song Upload ─────────────────────────────────────────────────────────────
app.post('/song-upload', (req, res, next) => {
  if (!multer) {
    return res.status(500).json({
      error:
        'File upload not available'
    });
  }

  upload.single('file')(
    req,
    res,
    err => {
      if (err) {
        return res
          .status(400)
          .json({
            error:
              'File upload error',
            detail:
              err.message
          });
      }

      handleSongUpload(
        req,
        res
      );
    }
  );
});

async function handleSongUpload(req, res) {
  const sessionId =
    (req.body &&
      req.body.session) ||
    (req.query &&
      req.query.session);

  const pastedText =
    req.body &&
    req.body.text;

  const file =
    req.file;

  // IMPORTANT:
  // songs.html sends the uploaded filename,
  // without its extension, as the authoritative title.
  const submittedSongTitle =
    (
      (req.body &&
        req.body.songTitle) ||
      ''
    )
      .trim()
      .slice(0, 180);

  if (!sessionId) {
    return res
      .status(400)
      .json({
        error:
          'Missing session ID'
      });
  }

  const id =
    sessionId.toUpperCase();

  const session =
    sessions[id];

  if (!session) {
    return res
      .status(404)
      .json({
        error:
          'Session not found or expired',
        id
      });
  }

  if (
    !file &&
    !pastedText
  ) {
    return res
      .status(400)
      .json({
        error:
          'No file or text provided'
      });
  }

  if (!ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({
        error:
          'ANTHROPIC_API_KEY not set'
      });
  }

  session.status =
    'processing';

  // The filename title wins before analysis begins.
  if (submittedSongTitle) {
    session.songTitle =
      submittedSongTitle;
  }

  try {
    let claudeContent = [];

    if (file) {
      const mimeType =
        file.mimetype ||
        'image/jpeg';

      const base64Data =
        file.buffer.toString(
          'base64'
        );

      if (
        mimeType ===
        'application/pdf'
      ) {
        claudeContent = [
          {
            type:
              'document',
            source: {
              type:
                'base64',
              media_type:
                'application/pdf',
              data:
                base64Data
            }
          },
          {
            type:
              'text',
            text:
              buildAnalysisPrompt(
                session.songTitle
              )
          }
        ];
      } else {
        claudeContent = [
          {
            type:
              'image',
            source: {
              type:
                'base64',
              media_type:
                mimeType,
              data:
                base64Data
            }
          },
          {
            type:
              'text',
            text:
              buildAnalysisPrompt(
                session.songTitle
              )
          }
        ];
      }
    } else {
      claudeContent = [
        {
          type:
            'text',
          text:
            buildTextAnalysisPrompt(
              pastedText,
              session.songTitle
            )
        }
      ];
    }

    const claudeBody =
      JSON.stringify({
        model:
          'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system:
          `You are a music analysis assistant for the Vizi AI guitar tutor system. ` +
          `Your job is to extract chord and tab information from uploaded music and return it as structured JSON. ` +
          `Always respond with ONLY valid JSON — no markdown, no explanation, no code fences.`,
        messages: [
          {
            role: 'user',
            content:
              claudeContent
          }
        ]
      });

    const result =
      await callClaudeAPI(
        claudeBody
      );

    const parsed =
      parseClaudeAnalysis(
        result
      );

    session.type =
      parsed.type;

    session.chords =
      parsed.chords ||
      [];

    session.progression =
      parsed.progression ||
      '';

    session.progressions =
      Array.isArray(parsed.progressions)
        ? parsed.progressions
        : [];

    session.tabTokens =
      parsed.tabTokens ||
      [];

    session.rawText =
      parsed.rawText ||
      '';

    // AUTHORITATIVE TITLE RULE:
    // Uploaded filename wins.
    // AI may infer a title only when the client supplied none.
    session.songTitle =
      submittedSongTitle ||
      session.songTitle ||
      parsed.songTitle ||
      '';

    session.capo =
      parsed.capo ||
      0;

    session.key =
      parsed.key ||
      '';

    session.timeSignature =
      parsed.timeSignature ||
      '4/4';

    session.strummingPattern =
      parsed.strummingPattern ||
      '';

    session.suggestedBpm =
      normalizeBpm(
        parsed.suggestedBpm
      );

    session.status =
      'ready';

    res.json({
      status: 'ready',
      sessionId: id,
      type:
        session.type,
      chords:
        session.chords,
      progression:
        session.progression,
      message:
        'Song uploaded successfully. Vizi is ready!'
    });
  } catch (err) {
    session.status =
      'error';

    session.error =
      err.message;

    res.status(500).json({
      error:
        'Failed to process upload',
      detail:
        err.message
    });
  }
}

// ─── Song analysis prompt ────────────────────────────────────────────────────
function buildAnalysisPrompt(songTitle) {
  return `Analyze this image of sheet music, a chord chart, or guitar tab.
${songTitle
  ? `AUTHORITATIVE SONG TITLE FROM THE UPLOAD: "${songTitle}". Copy this EXACTLY into songTitle. Do NOT rename, correct, reinterpret, or replace it based on the page contents.`
  : 'No authoritative title was supplied; infer songTitle only if it is clearly visible.'}

Return ONLY this JSON structure (no markdown, no explanation):
{"songTitle":"song name if visible or provided","type":"chords","capo":0,"key":"G major","timeSignature":"4/4","strummingPattern":"Pattern 3 — Common Pop Rock","suggestedBpm":90,"chords":["G","Em","C","D"],"progression":"[Verse] G Em C D | [Chorus] C G Am F","progressions":[["G","Em","C","D"],["C","G","Am","F"]],"tabTokens":[],"rawText":"any text you extracted"}

RULES:
- "type" must be "chords", "tab", or "mixed"
- "progressions" is up to 3 practice progressions for a beginner, each 2-4 chords in the real song order, using only chords that appear in the progression (e.g. a recurring loop or the main section phrases). No two progressions may be identical.
- "capo" must be a number — 0 if no capo
- "key" is your best-guess overall key of the song (e.g. "G major", "A minor"), based on the chords and progression
- "timeSignature" is your best-guess time signature (e.g. "4/4", "3/4", "6/8") — default to "4/4" if you cannot determine it
- "strummingPattern" must be exactly one of these five:
  "Pattern 1 — All Down"
  "Pattern 2 — Down Up"
  "Pattern 3 — Common Pop Rock"
  "Pattern 4 — Reggae Skank"
  "Pattern 5 — Ballad"
- "suggestedBpm" is a single number — your best estimate of the song's tempo, typically between 60 and 140
- "chords" must use standard chord names
- "progression" should preserve section labels if visible
- "tabTokens" only for tab/mixed. String codes: He=high E, B, G, D, A, Le=low E
- If you cannot read clearly, return type:"chords" with empty chords array`;
}

function buildTextAnalysisPrompt(text, songTitle) {
  return `Analyze this guitar chord chart or tab text.
${songTitle
  ? `AUTHORITATIVE SONG TITLE FROM THE UPLOAD: "${songTitle}". Copy this EXACTLY into songTitle. Do NOT rename, correct, reinterpret, or replace it based on the page contents.`
  : 'No authoritative title was supplied; infer songTitle only if it is clearly visible.'}

TEXT:
${text}

Return ONLY this JSON structure (no markdown, no explanation):
{"songTitle":"song name if visible or provided","type":"chords","capo":0,"key":"G major","timeSignature":"4/4","strummingPattern":"Pattern 3 — Common Pop Rock","suggestedBpm":90,"chords":["G","Em","C","D"],"progression":"[Verse] G Em C D | [Chorus] C G Am F","progressions":[["G","Em","C","D"],["C","G","Am","F"]],"tabTokens":[],"rawText":"${text.replace(/"/g, "'").slice(0, 200)}"}

RULES:
- "type" must be "chords", "tab", or "mixed"
- "progressions" is up to 3 practice progressions for a beginner, each 2-4 chords in the real song order, using only chords that appear in the progression (e.g. a recurring loop or the main section phrases). No two progressions may be identical.
- "chords" must list every unique chord used
- "capo" must be a number — 0 if no capo
- "key" is your best-guess overall key of the song
- "timeSignature" is your best-guess time signature — default to "4/4" if uncertain
- "strummingPattern" must be exactly one of the five approved patterns
- "suggestedBpm" is a single number, normally between 60 and 140
- "tabTokens" only for tab sections. String codes: He=high E, B, G, D, A, Le=low E`;
}

// ─── Claude analysis helper ──────────────────────────────────────────────────
function callClaudeAPI(claudeBody) {
  return new Promise(
    (resolve, reject) => {
      const options = {
        hostname:
          'api.anthropic.com',
        path:
          '/v1/messages',
        method:
          'POST',
        headers: {
          'Content-Type':
            'application/json',
          'x-api-key':
            ANTHROPIC_API_KEY,
          'anthropic-version':
            '2023-06-01',
          'Content-Length':
            Buffer.byteLength(
              claudeBody
            )
        }
      };

      const apiReq =
        https.request(
          options,
          claudeRes => {
            let data = '';

            claudeRes.on(
              'data',
              chunk => {
                data += chunk;
              }
            );

            claudeRes.on(
              'end',
              () => {
                try {
                  const parsed =
                    JSON.parse(data);

                  if (
                    claudeRes.statusCode
                    !== 200
                  ) {
                    return reject(
                      new Error(
                        `Claude API ${claudeRes.statusCode}: ${JSON.stringify(parsed)}`
                      )
                    );
                  }

                  resolve(
                    parsed.content &&
                    parsed.content[0] &&
                    parsed.content[0].text ||
                    ''
                  );
                } catch (err) {
                  reject(err);
                }
              }
            );
          }
        );

      apiReq.on(
        'error',
        err => reject(err)
      );

      apiReq.write(
        claudeBody
      );

      apiReq.end();
    }
  );
}

function parseClaudeAnalysis(text) {
  const clean =
    text
      .replace(
        /```json|```/g,
        ''
      )
      .trim();

  try {
    return JSON.parse(clean);
  } catch(e) {
    return {
      type: 'chords',
      chords: [],
      progression: '',
      progressions: [],
      tabTokens: [],
      rawText: text,
      key: '',
      timeSignature: '4/4',
      strummingPattern: '',
      suggestedBpm: null
    };
  }
}

function normalizeBpm(value) {
  const n =
    parseInt(value, 10);

  if (
    Number.isNaN(n)
  ) {
    return null;
  }

  if (
    n < 40 ||
    n > 220
  ) {
    return null;
  }

  return n;
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT =
  process.env.PORT ||
  3000;

app.listen(PORT, () => {
  console.log(
    'Vizi TTS Proxy listening on port ' +
    PORT
  );

  console.log(
    'Voice:',
    VOICE_NAME
  );

  console.log(
    'Claude ready:',
    !!ANTHROPIC_API_KEY
  );

  console.log(
    'YouTube ready:',
    !!YOUTUBE_API_KEY
  );

  console.log(
    'Multer ready:',
    !!multer
  );

  console.log(
    'Song prompt ready:',
    !!SONG_PROMPT
  );
});

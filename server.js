const express = require('express');
const https = require('https');
const app = express();

app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch(e) {
      req.body = { text: data };
    }
    next();
  });
});

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const VOICE_NAME = process.env.VOICE_NAME || 'en-US-Neural2-F';
const LANGUAGE_CODE = 'en-US';

app.get('/health', (req, res) => {
  res.json({ status: 'Vizi TTS Proxy running', voice: VOICE_NAME });
});

function synthesize(text, res) {
  console.log('Synthesizing:', text);

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });
  }

  const requestBody = JSON.stringify({
    input: { text: text },
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
    path: `/v1/text:synthesize?key=${GOOGLE_API_KEY}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };

  const googleReq = https.request(options, (googleRes) => {
    let data = '';
    googleRes.on('data', (chunk) => { data += chunk; });
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

  googleReq.on('error', (err) => {
    res.status(500).json({ error: 'Google TTS request failed', detail: err.message });
  });

  googleReq.write(requestBody);
  googleReq.end();
}

app.get('/tts', (req, res) => {
  const text = req.query.text;
  console.log('GET /tts text:', text);
  if (!text) {
    return res.status(400).json({ error: 'Missing text parameter' });
  }
  synthesize(text, res);
});

app.post('/tts', (req, res) => {
  let text;
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      text = parsed.text;
    } catch(e) {
      text = req.body;
    }
  } else {
    text = req.body ? req.body.text : undefined;
  }
  console.log('POST /tts text:', text);
  if (!text) {
    return res.status(400).json({ error: 'Missing text parameter' });
  }
  synthesize(text, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vizi TTS Proxy listening on port ${PORT}`);
  console.log(`Voice: ${VOICE_NAME}`);
});
```

**Then update App Inventor `Button_TestTTS` blocks:**
```
set Web_TTS.Url to join
  "https://vizi-tts-proxy-production.up.railway.app/tts?text="
  call Web_TTS.UriEncode
    text = "Hello I am Vizi your guitar tutor"

call Web_TTS.Get

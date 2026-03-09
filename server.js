const express = require('express');
const https = require('https');
const app = express();

app.use(express.json());

// Your Google TTS API key — set as environment variable in Railway
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Voice config — Journey-F for natural Vizi voice
const VOICE_NAME = process.env.VOICE_NAME || 'en-US-Neural2-F';
const LANGUAGE_CODE = 'en-US';

app.get('/health', (req, res) => {
  res.json({ status: 'Vizi TTS Proxy running', voice: VOICE_NAME });
});

app.post('/tts', (req, res) => {
  console.log('Received body:', JSON.stringify(req.body));
  console.log('Raw text:', req.body.text);
  const text = req.body.text;

  if (!text) {
    return res.status(400).json({ error: 'Missing text parameter' });
  }

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY not set' });
  }

  // Build Google TTS request body
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

        // Decode base64 and send as MP3 file directly
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vizi TTS Proxy listening on port ${PORT}`);
  console.log(`Voice: ${VOICE_NAME}`);
});

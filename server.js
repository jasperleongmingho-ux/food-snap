// v1 — minimal server, no extra features
require('dotenv').config();
const express = require('express');
const multer = require('multer');

const crypto = require('crypto');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15 MB, phone photos fit comfortably
});

// Which AI provider analyzes the photo: 'gemini' (default, free tier) or 'anthropic'
const PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

// Password protection (HTTP Basic Auth). Any username, password = APP_PASSWORD.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (!APP_PASSWORD) {
  if (process.env.RENDER) {
    console.error('[fatal] APP_PASSWORD must be set when deployed. Refusing to start without it.');
    process.exit(1);
  }
  console.warn('[warn] APP_PASSWORD not set: app is open to anyone who can reach it (ok for local use).');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(password, APP_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Food Snap"');
  res.status(401).send('Password required');
});

app.use(express.static('public'));

const prompt = `Look at this food photo. Respond with ONLY a JSON object, no markdown fences, no extra text, in exactly this shape:
{"food_name": "string", "calories": "string (e.g. '350-420 kcal')", "protein": "string (e.g. '20-25g')", "confidence_note": "string, 1-2 sentences explaining this is a visual estimate and what affects accuracy"}`;

// Gemini free tier often returns 503 "high demand" (or 429 when a model's quota
// is used up). Retry briefly, then fall back to the next model in the list.
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  ...(process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')
    .split(',').map(m => m.trim()).filter(Boolean)
].filter((m, i, all) => all.indexOf(m) === i);
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function analyzeWithGemini(base64Data, mediaType) {
  let lastError;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callGemini(model, base64Data, mediaType);
      } catch (err) {
        lastError = err;
        if (!RETRYABLE_STATUS.has(err.status)) throw err;
        console.warn(`[retry] ${model} attempt ${attempt} failed (${err.status})`);
        if (attempt < 2) await sleep(1500);
      }
    }
  }
  const busy = new Error('The AI service is busy right now. Please try again in a minute.');
  busy.cause = lastError;
  throw busy;
}

async function callGemini(model, base64Data, mediaType) {
  console.log(`[step] trying Gemini model ${model}`);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mediaType, data: base64Data } },
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          response_schema: {
            type: 'object',
            properties: {
              food_name: { type: 'string' },
              calories: { type: 'string' },
              protein: { type: 'string' },
              confidence_note: { type: 'string' }
            },
            required: ['food_name', 'calories', 'protein', 'confidence_note']
          }
        }
      })
    }
  );

  const data = await response.json();
  console.log('[step] Gemini API responded:', JSON.stringify(data).slice(0, 300));

  if (data.error) {
    const err = new Error('API error: ' + JSON.stringify(data.error));
    err.status = data.error.code || response.status;
    throw err;
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('');
}

async function analyzeWithAnthropic(base64Data, mediaType) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: prompt }
          ]
        }
      ]
    })
  });

  const data = await response.json();
  console.log('[step] Anthropic API responded:', JSON.stringify(data).slice(0, 300));

  if (data.error) {
    throw new Error('API error: ' + JSON.stringify(data.error));
  }

  const textBlock = data.content.find(c => c.type === 'text');
  return textBlock ? textBlock.text : '';
}

app.post('/api/analyze', upload.single('photo'), async (req, res) => {
  console.log('[step] received upload:', req.file?.originalname, req.file?.mimetype, req.file?.size);

  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' });
  }

  const base64Data = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype;

  try {
    console.log(`[step] calling ${PROVIDER} API`);
    const rawText = PROVIDER === 'anthropic'
      ? await analyzeWithAnthropic(base64Data, mediaType)
      : await analyzeWithGemini(base64Data, mediaType);

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    console.log('[step] parsed result:', parsed);
    res.json(parsed);
  } catch (err) {
    console.error('[error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Friendly error for oversized uploads
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Photo is too large (max 15 MB).' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Food Snap server running at http://localhost:${PORT} (provider: ${PROVIDER})`));

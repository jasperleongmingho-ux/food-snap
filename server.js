// Food Snap server: photo analysis (Gemini/Claude) + optional Notion food log
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

// ---- AI analysis ----

// Asks for an itemised breakdown so each component (e.g. rice, chicken) is spelled out,
// with a gram estimate and a USDA-style name used to look up nutrition per 100 g.
// userNotes = extra details typed by the user when re-analyzing (missing items, portions).
function buildPrompt(userNotes) {
  let p = `Look at this food photo. Identify every separate food component on the plate (e.g. for chicken rice: the rice, the chicken, the cucumber, the sauce) and estimate each one's weight in grams, calories and protein.
To judge portion size, use any size reference visible in the photo (fork, spoon, chopsticks, hand, phone, card, standard plate or bowl). Account for cooking oil, sauces and gravy as their own items when they are likely present.
Respond with ONLY a JSON object, no markdown fences, no extra text, in exactly this shape:
{"food_name": "string (overall dish name)", "items": [{"name": "string", "portion": "string, household measure (e.g. '1 cup', '1 piece')", "grams": number (estimated edible weight in grams), "usda_query": "string, generic USDA FoodData Central style description including cooking method (e.g. 'rice, white, cooked', 'chicken, drumstick, meat and skin, roasted')", "calories_kcal": number, "protein_g": number}], "calories": "string, range for the whole meal (e.g. '350-420 kcal')", "protein": "string, range for the whole meal (e.g. '20-25g')", "calories_kcal": number (best estimate for the whole meal, should equal the sum of items), "protein_g": number (best estimate for the whole meal, should equal the sum of items), "confidence_note": "string, 1-2 sentences explaining this is a visual estimate and what affects accuracy"}`;
  if (userNotes) {
    p += `

The person who ate this meal added these details. Treat them as correct: include any items they mention even if not visible in the photo, and use the portions they give:
"""${userNotes}"""`;
  }
  return p;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    portion: { type: 'string' },
    grams: { type: 'number' },
    usda_query: { type: 'string' },
    calories_kcal: { type: 'number' },
    protein_g: { type: 'number' }
  },
  required: ['name', 'portion', 'grams', 'usda_query', 'calories_kcal', 'protein_g']
};

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    food_name: { type: 'string' },
    items: { type: 'array', items: ITEM_SCHEMA },
    calories: { type: 'string' },
    protein: { type: 'string' },
    calories_kcal: { type: 'number' },
    protein_g: { type: 'number' },
    confidence_note: { type: 'string' }
  },
  required: ['food_name', 'items', 'calories', 'protein', 'calories_kcal', 'protein_g', 'confidence_note']
};

// Gemini free tier often returns 503 "high demand" (or 429 when a model's quota
// is used up). Retry briefly, then fall back to the next model in the list.
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  ...(process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')
    .split(',').map(m => m.trim()).filter(Boolean)
].filter((m, i, all) => all.indexOf(m) === i);
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ask the configured AI for JSON. `image` is optional ({ base64, mediaType }).
async function generateJson({ prompt, schema, image, models = GEMINI_MODELS }) {
  const rawText = PROVIDER === 'anthropic'
    ? await callAnthropic(prompt, image)
    : await callGeminiWithFallback(prompt, schema, image, models);
  return JSON.parse(rawText.replace(/```json|```/g, '').trim());
}

async function callGeminiWithFallback(prompt, schema, image, models) {
  let lastError;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callGemini(model, prompt, schema, image);
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

async function callGemini(model, prompt, schema, image) {
  console.log(`[step] trying Gemini model ${model}`);
  const parts = [{ text: prompt }];
  if (image) parts.unshift({ inline_data: { mime_type: image.mediaType, data: image.base64 } });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { response_mime_type: 'application/json', response_schema: schema }
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

  const out = data.candidates?.[0]?.content?.parts || [];
  return out.map(p => p.text || '').join('');
}

async function callAnthropic(prompt, image) {
  const content = [{ type: 'text', text: prompt }];
  if (image) content.unshift({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content }]
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

// ---- USDA FoodData Central lookup (free: https://fdc.nal.usda.gov/api-guide) ----
// Replaces the AI's remembered nutrition values with measured values per 100 g.
// The AI still identifies the food and estimates grams.
const USDA_API_KEY = process.env.USDA_API_KEY || 'DEMO_KEY';
const USDA_ENABLED = (process.env.USDA_LOOKUP || 'on').toLowerCase() !== 'off';
const usdaCache = new Map();
const round1 = n => Math.round(n * 10) / 10;

async function searchUsda(query) {
  const key = query.toLowerCase().trim();
  if (usdaCache.has(key)) return usdaCache.get(key);

  const response = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(USDA_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, dataType: ['Foundation', 'SR Legacy', 'Survey (FNDDS)'], pageSize: 8 })
  });
  if (!response.ok) throw new Error(`USDA search failed (${response.status})`);
  const data = await response.json();

  // Values in search results are per 100 g for these data types
  const pick = (food, number, unit) =>
    food.foodNutrients.find(x => String(x.nutrientNumber) === number && (!unit || x.unitName === unit))?.value ?? null;
  const candidates = (data.foods || [])
    .map(f => ({
      fdcId: f.fdcId,
      description: f.description,
      // 208 = Energy; Foundation foods may only have Atwater energy (958 specific, 957 general)
      kcal: pick(f, '208', 'KCAL') ?? pick(f, '958', 'KCAL') ?? pick(f, '957', 'KCAL'),
      protein: pick(f, '203')
    }))
    .filter(c => c.kcal != null && c.protein != null);

  usdaCache.set(key, candidates);
  return candidates;
}

// USDA's top search hit is often a near-miss (e.g. "glutinous rice" for white rice,
// "chicken skin" for drumstick), so a quick text-only AI call picks the right candidate.
async function enrichWithUsda(items) {
  const withCandidates = await Promise.all(items.map(async item => {
    try {
      return await searchUsda(item.usda_query || item.name);
    } catch (err) {
      console.warn('[warn] USDA lookup failed for', item.name, err.message);
      return [];
    }
  }));
  if (!withCandidates.some(c => c.length)) return;

  const listing = items.map((item, i) =>
    `Item ${i}: "${item.name}" (${item.usda_query}` +
    (item.grams > 0 ? `, AI estimate ${Math.round(item.calories_kcal / item.grams * 100)} kcal/100g` : '') + `)\n` +
    (withCandidates[i].length
      ? withCandidates[i].map((c, j) => `  ${j}: ${c.description} (${Math.round(c.kcal)} kcal, ${round1(c.protein)} g protein per 100g)`).join('\n')
      : '  (no candidates)')
  ).join('\n');

  let choices = [];
  try {
    const result = await generateJson({
      prompt: `Match each food item to the USDA FoodData Central entry that best describes it (same food, same cooking method, same part, e.g. meat vs skin only). If no candidate is a reasonable match, use -1.\n\n${listing}\n\nRespond with ONLY JSON: {"choices": [{"item": number, "candidate": number}]}`,
      schema: {
        type: 'object',
        properties: { choices: { type: 'array', items: { type: 'object', properties: { item: { type: 'number' }, candidate: { type: 'number' } }, required: ['item', 'candidate'] } } },
        required: ['choices']
      },
      // Matching is a simple text task: start with the lighter models to save quota
      models: [...GEMINI_MODELS.slice(1), GEMINI_MODELS[0]]
    });
    choices = result.choices || [];
  } catch (err) {
    console.warn('[warn] USDA matching step failed, keeping AI values:', err.message);
    return;
  }

  for (const { item: i, candidate: j } of choices) {
    const item = items[i];
    const match = withCandidates[i]?.[j];
    if (!item || !match) continue;

    // Sanity check against the AI's own estimate: a wildly different energy
    // density usually means a bad match, so keep the AI value instead.
    const aiPer100 = item.grams > 0 ? (item.calories_kcal / item.grams) * 100 : null;
    const ratio = aiPer100 ? match.kcal / aiPer100 : 1;
    if (aiPer100 && (ratio < 0.5 || ratio > 2)) {
      console.warn(`[warn] USDA match for ${item.name} looks off (${match.description}), keeping AI values`);
      continue;
    }
    item.kcal_per_100g = round1(match.kcal);
    item.protein_per_100g = round1(match.protein);
    item.source = `USDA: ${match.description}`;
  }
}

// Every item ends up with per-100 g values so the page can rescale when grams are edited
function finalizeItems(items) {
  for (const item of items) {
    const grams = Number(item.grams) || 0;
    if (item.kcal_per_100g == null) {
      item.kcal_per_100g = grams > 0 ? round1(item.calories_kcal / grams * 100) : 0;
      item.protein_per_100g = grams > 0 ? round1(item.protein_g / grams * 100) : 0;
      item.source = 'AI estimate';
    }
    if (grams > 0) {
      item.calories_kcal = Math.round(item.kcal_per_100g * grams / 100);
      item.protein_g = round1(item.protein_per_100g * grams / 100);
    }
    item.grams = Math.round(grams);
    delete item.usda_query;
  }
}

app.post('/api/analyze', upload.single('photo'), async (req, res) => {
  console.log('[step] received upload:', req.file?.originalname, req.file?.mimetype, req.file?.size);

  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' });
  }

  const image = { base64: req.file.buffer.toString('base64'), mediaType: req.file.mimetype };
  const userNotes = String(req.body.user_notes || '').trim().slice(0, 1000);
  if (userNotes) console.log('[step] re-analyzing with user notes:', userNotes);

  try {
    console.log(`[step] calling ${PROVIDER} API`);
    const parsed = await generateJson({ prompt: buildPrompt(userNotes), schema: ANALYSIS_SCHEMA, image });
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    if (USDA_ENABLED && items.length) {
      console.log('[step] looking up USDA nutrition data');
      await enrichWithUsda(items);
    }
    finalizeItems(items);

    // Keep the meal totals consistent with the item breakdown
    if (items.length) {
      parsed.calories_kcal = Math.round(items.reduce((t, i) => t + i.calories_kcal, 0));
      parsed.protein_g = round1(items.reduce((t, i) => t + i.protein_g, 0));
    }

    console.log('[step] parsed result:', JSON.stringify(parsed));
    res.json(parsed);
  } catch (err) {
    console.error('[error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Notion food log ----
const NOTION_VERSION = '2026-03-11';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || '';
const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
let notionDataSourceId = null;

async function notion(path, { method = 'GET', json, body } = {}) {
  const headers = { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION };
  if (json) headers['Content-Type'] = 'application/json';
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers,
    body: json ? JSON.stringify(json) : body
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Notion ${method} ${path} failed (${response.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

// Pages are created under the database's data source (Notion API 2025-09-03+)
async function getDataSourceId() {
  if (!notionDataSourceId) {
    const db = await notion(`databases/${NOTION_DATABASE_ID}`);
    notionDataSourceId = db.data_sources?.[0]?.id;
    if (!notionDataSourceId) throw new Error('Notion database has no data source');
  }
  return notionDataSourceId;
}

async function uploadPhotoToNotion(file) {
  const created = await notion('file_uploads', {
    method: 'POST',
    json: { filename: file.originalname || 'meal.jpg', content_type: file.mimetype }
  });
  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'meal.jpg');
  const sent = await notion(`file_uploads/${created.id}/send`, { method: 'POST', body: form });
  if (sent.status !== 'uploaded') throw new Error('Notion photo upload did not complete');
  return created.id;
}

const text = value => [{ type: 'text', text: { content: String(value || '').slice(0, 2000) } }];
const numberOrNull = value => (value === '' || value == null || isNaN(Number(value)) ? null : Number(value));

app.post('/api/log', upload.single('photo'), async (req, res) => {
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    return res.status(503).json({ error: 'Food log is not set up (NOTION_TOKEN / NOTION_DATABASE_ID missing).' });
  }
  const b = req.body;
  console.log('[step] logging meal to Notion:', b.food_name);

  try {
    const dataSourceId = await getDataSourceId();
    const photoId = req.file ? await uploadPhotoToNotion(req.file) : null;

    const properties = {
      Food: { title: text(b.food_name || 'Meal') },
      Date: { date: { start: b.eaten_at || new Date().toISOString() } },
      'Calories (kcal)': { number: numberOrNull(b.calories_kcal) },
      'Protein (g)': { number: numberOrNull(b.protein_g) },
      Items: { rich_text: text(b.items) },
      Notes: { rich_text: text(b.notes) }
    };
    if (MEALS.includes(b.meal)) properties.Meal = { select: { name: b.meal } };
    if (photoId) {
      properties.Photo = { files: [{ type: 'file_upload', file_upload: { id: photoId }, name: 'photo.jpg' }] };
    }

    const page = await notion('pages', {
      method: 'POST',
      json: {
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties
      }
    });

    console.log('[step] saved to Notion:', page.url);
    res.json({ ok: true, url: page.url });
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

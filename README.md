# Food Snap Estimator (v1)

Internal app: take or choose a food photo, an AI model estimates food name,
calories, and protein. You can correct the numbers and save the meal (with photo)
to a Notion food log. Single user, protected by APP_PASSWORD.

## Setup

1. Get a free Gemini API key from https://aistudio.google.com/apikey
2. Copy `.env.example` to `.env` and paste your key into `GEMINI_API_KEY`:
   ```
   cp .env.example .env
   ```
3. Install and run:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000 on your computer, or on your phone (same wifi)
   using your computer's local IP instead of localhost.

## Choosing the AI provider

Set `AI_PROVIDER` in `.env`:

- `gemini` (default) — Google Gemini, free tier. Model set by `GEMINI_MODEL`
  (default `gemini-3.6-flash`). If it is busy, the server retries and falls back
  to `GEMINI_FALLBACK_MODELS`. Note: on the free tier Google may use the
  photos/prompts to improve its products.
- `anthropic` — Claude (`claude-sonnet-5`), paid, needs `ANTHROPIC_API_KEY`.

Restart the server after changing `.env`.

## Food log (Notion)

Saved meals go to the "Food Log" Notion database (gallery + daily calories chart).

1. Create an internal integration at https://www.notion.so/profile/integrations
   and copy its secret into `NOTION_TOKEN`.
2. Open the Food Log database in Notion → `•••` → Connections → add the integration.
3. `NOTION_DATABASE_ID` is the database's ID (already set in `.env.example`).

Photos are shrunk in the browser to ~1280px JPEG before upload.

## Why a server instead of pure frontend?

The API key stays on the server (`server.js`), never exposed in the browser.
The frontend just uploads the photo to `/api/analyze` and shows the result.

## Notes

- Model names change over time — if you get a "model not found" error, check
  https://ai.google.dev/gemini-api/docs/models and update `GEMINI_MODEL`.

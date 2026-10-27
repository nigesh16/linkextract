import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { extractUrl } from './extractor.js';

const BATCH = 5;      // URLs fetched in parallel (same as the original script)
const MAX_URLS = 20;  // per request; the client sends chunks of 5
const app = express();
app.use(express.json({ limit: '100kb' }));

// Nothing is stored: each request fetches, parses and returns the results.
app.post('/api/extract', async (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls.map(String).slice(0, MAX_URLS) : [];
  if (!urls.length) return res.status(400).json({ error: 'No URLs provided' });
  const timeZone = typeof req.body.timeZone === 'string' ? req.body.timeZone : undefined;
  const results = [];
  for (let i = 0; i < urls.length; i += BATCH) {
    results.push(...await Promise.all(urls.slice(i, i + BATCH).map(u => extractUrl(u, timeZone))));
  }
  res.json({ results });
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LinkExtract server running on port ${PORT}`);
});

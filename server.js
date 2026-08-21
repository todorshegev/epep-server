const express = require('express');
const { searchCase, getCaseDetail } = require('./scraper');

/**
 * Справките към ecase.justice.bg се провалят от време на време заради бавен отговор.
 * Опитваме повторно, вместо да върнем грешка при първото забавяне.
 */
async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fn();
      if (r && r.success === false) throw new Error(r.error || 'неуспешна справка');
      if (i > 1) console.log(`[RETRY] ${label}: успех от опит ${i}`);
      return r;
    } catch (err) {
      lastErr = err;
      console.warn(`[RETRY] ${label}: опит ${i}/${attempts} се провали — ${err.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}


const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// CORS — позволява заявки от мобилното приложение
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'EPEP Scraper API', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// POST /api/case/search  { num, year, court }
// GET  /api/case/search?num=...&year=...&court=...
app.get('/api/case/search', async (req, res) => {
  const { num, year, court = '' } = req.query;
  if (!num || !year) {
    return res.status(400).json({ success: false, error: 'Липсва num или year' });
  }
  console.log(`[API] Търсене: ${num}/${year} | съд: ${court || '-'}`);
  try {
    const result = await withRetry(`search ${num}/${year}`, () => searchCase({ caseNum: num, year, court }));
    res.json(result);
  } catch (e) {
    console.error('[API] Грешка:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/case/detail?url=...
app.get('/api/case/detail', async (req, res) => {
  const { url, force } = req.query;
  if (!url) {
    return res.status(400).json({ success: false, error: 'Липсва url' });
  }
  console.log(`[API] Детайли: ${url}`);
  try {
    const result = await withRetry('detail', () => getCaseDetail(url));
    res.json(result);
  } catch (e) {
    console.error('[API] Грешка:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`EPEP API сървър стартиран на порт ${PORT}`);
});

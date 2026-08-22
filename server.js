const express = require('express');
const { searchCase, getCaseDetail } = require('./scraper');

/**
 * Справките към ecase.justice.bg се провалят от време на време заради бавен отговор.
 * Опитваме повторно, вместо да върнем грешка при първото забавяне.
 */
async function withRetry(label, fn, attempts = 2) {
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
      if (i < attempts) await new Promise(r => setTimeout(r, 1000));
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

// ── Изпращане на известия ─────────────────────────────────────────────
// Шифроването на уеб известия иска Node — в средата на Supabase
// библиотеката произвежда съдържание, което телефонът не може да разчете.
const webpush = require('web-push');

/** Ключовете се четат при всяко изпращане — така добавянето им в
 *  средата не изисква рестарт и редът на действията няма значение. */
function pushReady() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:office@htia-lawco.com', pub, priv);
  return true;
}

app.post('/api/push', async (req, res) => {
  if (!pushReady()) return res.status(503).json({ success: false, error: 'Липсват ключове за известия',
    vidyani: { pub: !!process.env.VAPID_PUBLIC_KEY, priv: !!process.env.VAPID_PRIVATE_KEY } });
  const { subscriptions, payload, secret } = req.body || {};
  if (process.env.PUSH_SECRET && secret !== process.env.PUSH_SECRET) {
    return res.status(401).json({ success: false, error: 'Няма достъп' });
  }
  if (!Array.isArray(subscriptions) || !payload) {
    return res.status(400).json({ success: false, error: 'Липсват subscriptions или payload' });
  }

  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let ok = 0, gone = [], failed = 0;
  for (const s of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      ok++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) gone.push(s.endpoint);
      else failed++;
    }
  }
  res.json({ success: true, ok, gone, failed });
});

app.listen(PORT, () => {
  console.log(`EPEP API сървър стартиран на порт ${PORT}`);
});

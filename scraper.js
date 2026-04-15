const puppeteer = require('puppeteer');
const SEARCH_URL = 'https://ecase.justice.bg/Case';
const PAGE_TIMEOUT = 30000;
const WAIT = ms => new Promise(r => setTimeout(r, ms));

function parseBase(t, fallbackNum) {
  function grab(rx) { const m = t.match(rx); return m ? m[1].trim() : null; }
  const numM = t.match(/[\u2116#]\s*(\d+)[\s\S]{0,10}?\n\s*(\d{4})\s*\n/);
  const num = (numM ? numM[1] + '/' + numM[2] : '') || (fallbackNum || '');
  const info = {};
  const fields = [
    ['Тип',         /[\r\n]([^\r\n]+дело)[\r\n]/i],
    ['Съд',         /[\r\n]Съд[\r\n]([^\r\n]+)/],
    ['Съдия',       /[\r\n]Съдия докладчик[\r\n]([^\r\n]+)/],
    ['Дата',        /[\r\n]Дата на образуване[\r\n]([^\r\n]+)/],
    ['Вх. номер',   /[\r\n]Входящ номер[\r\n]([^\r\n]+)/],
    ['Състав',      /[\r\n]Съдебен състав[\r\n]([^\r\n]+)/],
    ['Ищец',        /[\r\n]Инициираща страна[\r\n][^\r\n]+[\r\n]([^\r\n]+)/],
    ['Ответник',    /[\r\n]Ответна страна[\r\n]([^\r\n]+)/],
  ];
  fields.forEach(([k,rx]) => { const v = grab(rx); if (v) info[k] = v; });
  const parties = [];
  const names = [...t.matchAll(/[\r\n]Име[\r\n]([^\r\n]+)/g)].map(m => m[1].trim());
  const roles = [...t.matchAll(/[\r\n]Качество[\r\n]([^\r\n]+)/g)].map(m => m[1].trim());
  names.forEach((name, i) => parties.push({ name, role: roles[i] || '' }));
  return { num, info, parties,
    title: 'Дело № ' + num + (info['Тип'] ? ' (' + info['Тип'] + ')' : '') };
}

function parseHearings(t) {
  const hearings = [];
  const rx = /Начало[\s\n]+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})[\s\S]*?Вид[\s\n]+([^\n]+)[\s\S]*?Резултат[\s\n]+([^\n]+)/g;
  let m;
  while ((m = rx.exec(t)) !== null) {
    hearings.push({ date: m[1], time: m[2], kind: m[3].trim(), result: m[4].trim() });
  }
  if (hearings.length === 0) {
    const rx2 = /Начало[\s\n]+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})/g;
    while ((m = rx2.exec(t)) !== null) {
      hearings.push({ date: m[1], time: m[2], kind: '', result: '' });
    }
  }
  return hearings;
}

function parseActs(t) {
  const acts = [];
  const rx = /Вид[\s\n]+([^\n]+)[\s\n]+Номер[\s\n]+(\d+)/g;
  let m;
  while ((m = rx.exec(t)) !== null) {
    const kind = m[1].trim();
    const num = m[2].trim();
    const before = t.substring(Math.max(0, m.index - 300), m.index);
    const dateRx1 = /(\d{2}\.\d{2}\.\d{4})/g;
    const dates1 = [...before.matchAll(dateRx1)];
    let date = dates1.length > 0 ? dates1[dates1.length-1][1] : '';
    if (!date) {
      const bgMonths = {'януари':'01','февруари':'02','март':'03','април':'04','май':'05','юни':'06',
        'юли':'07','август':'08','септември':'09','октомври':'10','ноември':'11','декември':'12'};
      const rx2 = /(\d{1,2})\s+(януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември)\s+(\d{4})/gi;
      const m2 = rx2.exec(before);
      if (m2) {
        const day = m2[1].padStart(2,'0');
        const mon = bgMonths[m2[2].toLowerCase()] || '01';
        date = day + '.' + mon + '.' + m2[3];
      }
    }
    acts.push({ kind, num, date });
  }
  return acts;
}

async function searchCase({ caseNum, year, court = '' }) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    page.setDefaultTimeout(PAGE_TIMEOUT);

    let apiData = null;
    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('ecase') && url.includes('/api/')) {
        try {
          if ((res.headers()['content-type'] || '').includes('json')) {
            apiData = await res.json();
          }
        } catch (e) {}
      }
    });

    console.log('[EPEP] Зареждане...');
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2' });
    await WAIT(1500);

    try {
      await page.evaluate(() => {
        const btn = document.querySelector('button.cta-active, button.btn-comfirm');
        if (btn) btn.click();
      });
      await WAIT(600);
    } catch (e) {}

    await page.waitForSelector('#RegNumber', { timeout: PAGE_TIMEOUT });
    await WAIT(500);
    console.log('[EPEP] Форма заредена.');

    await page.evaluate((val) => {
      const el = document.querySelector('#RegNumber');
      el.focus(); el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, caseNum);
    console.log('[EPEP] Номер:', caseNum);

    if (year) {
      const opts = await page.evaluate(() =>
        Array.from(document.querySelector('#RegYear')?.options || []).map(o => o.value)
      );
      if (opts.includes(year)) {
        await page.evaluate((yr) => {
          const s = document.querySelector('#RegYear');
          s.value = yr; s.dispatchEvent(new Event('change', { bubbles: true }));
        }, year);
        console.log('[EPEP] Година:', year);
      }
    }

    if (court && court.trim()) {
      const val = await page.evaluate((name) => {
        const match = Array.from(document.querySelector('#CourtId')?.options || [])
          .find(o => o.text.toLowerCase().includes(name.toLowerCase()));
        return match ? match.value : null;
      }, court);
      if (val) {
        await page.evaluate((v) => {
          const s = document.querySelector('#CourtId');
          s.value = v; s.dispatchEvent(new Event('change', { bubbles: true }));
        }, val);
        console.log('[EPEP] Съд:', court);
      }
    }

    await page.evaluate(() => {
      const btn = document.querySelector('button.oc-submit');
      if (btn) btn.click();
    });
    console.log('[EPEP] Търсене...');
    await WAIT(4500);

    const caseLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="CaseDetail"]'))
        .map(a => ({ text: a.innerText ? a.innerText.trim() : '', href: a.href }))
    );
    console.log('[EPEP] Намерени', caseLinks.length, 'дела.');

    let caseDetails = null;

    if (caseLinks.length >= 1) {
      const targetLink = court
        ? (caseLinks.find(l => l.text.toLowerCase().includes(court.toLowerCase())) || caseLinks[0])
        : caseLinks[0];
      console.log('[EPEP] Детайли:', targetLink.href);
      await browser.close();
      browser = null;
      const detailResult = await getCaseDetail(targetLink.href);
      if (detailResult.success) {
        caseDetails = detailResult.data;
      }
    }

    return { success: true, caseNum, year, court, timestamp: new Date().toISOString(), caseLinks, caseDetails };

  } catch (err) {
    console.error('[EPEP] Грешка:', err.message);
    return { success: false, error: err.message, caseNum, year, timestamp: new Date().toISOString() };
  } finally {
    if (browser) await browser.close();
  }
}

async function getCaseDetail(caseUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(caseUrl, { waitUntil: 'networkidle2' });
    await WAIT(2000);

    const rawInitial = await page.evaluate(() => document.body.innerText);
    const base = parseBase(rawInitial, '');

    async function clickTab(name) {
      await page.evaluate((n) => {
        const btns = Array.from(document.querySelectorAll('button.gv-loader-tab'));
        const btn = btns.find(b => (b.innerText||'').trim() === n);
        if (btn) btn.click();
      }, name);
      await WAIT(1000);
      try {
        await page.waitForFunction(() => {
          const l = document.querySelector('.loading, .spinner, [class*="loader"]:not(.gv-loader-tab)');
          return !l || l.style.display === 'none';
        }, { timeout: 8000 });
      } catch(e) {}
      await WAIT(2000);
      return page.evaluate(() => document.body.innerText);
    }

    const rawH = await clickTab('Заседания').catch(() => '');
    const rawA = await clickTab('Актове').catch(() => '');
    const hearings = parseHearings(rawH);
    const acts = parseActs(rawA);

    const data = { ...base, hearings, acts, url: caseUrl };
    return { success: true, timestamp: new Date().toISOString(), data };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { searchCase, getCaseDetail };

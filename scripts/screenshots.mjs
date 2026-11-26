// Regenerates docs/screenshots/*.png from the real extension.
// Loads the extension into a throwaway Chromium profile, fills it with
// made-up demo data and takes the pictures. It never starts a sync and
// never talks to LinkedIn or Clay.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'docs', 'screenshots');
const profileDir = path.join(root, '.screenshot-profile');
fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });

// Invented people. Any match with a real person is a coincidence.
const PEOPLE = [
  ['Mara', 'Lindqvist', 'Head of Revenue Operations at Northbeam Logistics'],
  ['Tobias', 'Achterberg', 'Founder & CEO, Fennel Analytics'],
  ['Priya', 'Venkataraman', 'VP Marketing | B2B SaaS | Speaker'],
  ['Jonas', 'Feldkamp', 'Sales Director DACH at Quillstone'],
  ['Elena', 'Marchetti', 'Growth Lead at Harbor & Pine'],
  ['Samuel', 'Okonjo', 'Partnerships Manager, Tallgrass Software'],
  ['Hanna', 'Bergström', 'Chief of Staff at Lumenfold'],
  ['Daniel', 'Roche', 'Account Executive, Mid-Market at Brightwell'],
  ['Aiko', 'Tanabe', 'Product Marketing Manager at Cedarline'],
  ['Lukas', 'Wiedemann', 'Managing Director, Wiedemann & Partner Consulting'],
  ['Sofia', 'Almeida', 'Demand Generation at Kestrel Cloud'],
  ['Ben', 'Hartley', 'GTM Engineer | Clay, HubSpot, n8n'],
  ['Nora', 'Kaltenbach', 'People & Culture Lead at Miro Werk'],
  ['Felix', 'Drummond', 'Co-Founder at Paperkite Studio'],
];

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const base = `chrome-extension://${new URL(worker.url()).host}`;

// The popup only checks that this cookie exists, to show "LinkedIn connected".
await context.addCookies([
  { name: 'li_at', value: 'demo', domain: 'www.linkedin.com', path: '/', secure: true },
]);

const page = await context.newPage();
await page.setViewportSize({ width: 360, height: 700 });
await page.goto(`${base}/popup.html`);

// ---- demo data -------------------------------------------------------
await page.evaluate(async ({ PEOPLE, HOUR, DAY }) => {
  const now = Date.now();
  const today = new Date(now); today.setHours(8, 0, 12, 0);
  const lastRun = Math.min(today.getTime(), now - 5 * 60e3);
  const runAt = (daysAgo) => lastRun - daysAgo * DAY;

  const runs = [
    { at: runAt(0), trigger: 'scheduled', success: true, message: 'Synced 4 new connections to Clay.', count: 4, scanned: 100, durationMs: 3400 },
    { at: runAt(1), trigger: 'scheduled', success: true, message: 'Synced 3 new connections to Clay.', count: 3, scanned: 100, durationMs: 3100 },
    { at: runAt(2), trigger: 'catch-up', success: true, message: 'Synced 2 new connections to Clay.', count: 2, scanned: 100, durationMs: 2900 },
    { at: runAt(3), trigger: 'scheduled', success: false, message: 'LinkedIn session expired — log in at linkedin.com', count: 0, durationMs: 800 },
    { at: runAt(4), trigger: 'scheduled', success: true, message: 'No new connections to sync.', count: 0, scanned: 100, durationMs: 2100 },
    { at: runAt(5) + 6 * HOUR, trigger: 'manual', success: true, message: 'Synced 5 connections to Clay.', count: 5, scanned: 5, durationMs: 4600 },
  ];

  await chrome.storage.local.set({
    webhookUrl: 'https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-demo',
    deltaSync: true,
    notify: true,
    schedule: { mode: 'daily', time: '08:00', weekday: 1 },
    scheduleSetAt: now,
    lastScheduledAttempt: now,
    watermark: lastRun,
    lastSyncTime: new Date(lastRun).toISOString(),
    runs,
  });
  await chrome.runtime.sendMessage({ type: 'RESCHEDULE' });

  // Which run sent whom: 4 today, 3 yesterday, 2 the day before, 5 in the first manual run.
  const runOf = [0, 0, 0, 0, 1, 1, 1, 2, 2, 5, 5, 5, 5, 5];
  await ProfileLog.count(); // creates the database with the extension's own schema
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('linkedin-clay-sync', 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = db.transaction('profiles', 'readwrite');
  PEOPLE.forEach(([firstName, lastName, headline], i) => {
    const run = runs[runOf[i]];
    const id = `${firstName}-${lastName}-demo`.toLowerCase().replace(/[^a-z-]/g, '');
    const synced = run.at + 1200 + i * 110;
    tx.objectStore('profiles').put({
      key: `urn:li:fsd_profile:DEMO${i}`,
      entityUrn: `urn:li:fsd_profile:DEMO${i}`,
      firstName, lastName, fullName: `${firstName} ${lastName}`, headline,
      profileUrl: `https://www.linkedin.com/in/${id}`,
      publicIdentifier: id,
      connectedAt: new Date(run.at - (3 + i * 1.7) * HOUR).toISOString(),
      firstSyncedAt: synced, lastSyncedAt: synced, timesSent: 1,
      lastRunAt: run.at, lastTrigger: run.trigger,
    });
  });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}, { PEOPLE, HOUR, DAY });

const snapPopup = async (file) => {
  const height = await page.evaluate(() => document.body.offsetHeight);
  await page.screenshot({ path: path.join(shots, file), clip: { x: 0, y: 0, width: 360, height } });
};

// ---- 1. popup, set up and idle ----------------------------------------
await page.reload();
await page.waitForFunction(() => document.getElementById('li-text').textContent === 'LinkedIn connected');
await page.waitForFunction(() => /synced profiles/.test(document.getElementById('open-history').textContent) && /\d/.test(document.getElementById('open-history').textContent));
await snapPopup('popup.png');

// ---- 2. popup while a sync runs (state only, no sync is started) -------
await page.evaluate(() => chrome.storage.session.set({
  syncState: { running: true, trigger: 'manual', progress: 91, text: 'Sent 2/4 to Clay…', result: null, startedAt: Date.now() },
}));
await page.waitForFunction(() => document.getElementById('sync-btn').textContent === 'Syncing…');
await page.waitForTimeout(500);
await snapPopup('popup-syncing.png');

// ---- 3. popup after a sync ---------------------------------------------
await page.evaluate(() => chrome.storage.session.set({
  syncState: { running: false, progress: 100, text: '', result: { success: true, message: 'Synced 4 new connections to Clay.', count: 4 } },
}));
await page.waitForFunction(() => document.getElementById('result').classList.contains('ok'));
await page.waitForTimeout(400);
await snapPopup('popup-done.png');
await page.evaluate(() => chrome.storage.session.remove('syncState'));

// ---- 4. synced profiles + run history ----------------------------------
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(`${base}/history.html`);
await page.waitForSelector('#profiles tr a');
await page.screenshot({ path: path.join(shots, 'history.png'), fullPage: true });

// ---- 5. banner for the top of the README --------------------------------
const b64 = (f) => fs.readFileSync(f).toString('base64');
const banner = await context.newPage();
await banner.setViewportSize({ width: 1280, height: 640 });
await banner.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 640px; overflow: hidden; position: relative;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff;
    background: radial-gradient(1100px 700px at 85% 10%, #2f8fe6 0%, transparent 60%),
                radial-gradient(900px 600px at 0% 100%, #ff7a59 0%, transparent 55%),
                linear-gradient(135deg, #0a2540 0%, #0a66c2 100%); }
  .copy { position: absolute; left: 72px; top: 150px; width: 520px; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 20px; font-weight: 600; opacity: .95; }
  .brand img { width: 52px; height: 52px; border-radius: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
  h1 { font-size: 60px; line-height: 1.04; letter-spacing: -.02em; margin: 28px 0 18px; }
  p { font-size: 23px; line-height: 1.4; margin: 0; opacity: .92; }
  .chips { display: flex; gap: 10px; margin-top: 30px; }
  .chips span { font-size: 15px; font-weight: 600; padding: 7px 14px; border-radius: 999px;
    background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.28); }
  .shot { position: absolute; border-radius: 14px; background: #fff;
    box-shadow: 0 30px 80px rgba(0,0,0,.38), 0 0 0 1px rgba(255,255,255,.2); }
  .history { width: 760px; left: 700px; top: 96px; }
  .popup { width: 300px; left: 610px; top: 112px; }
</style></head><body>
  <div class="copy">
    <div class="brand"><img src="data:image/png;base64,${b64(path.join(root, 'icons/icon128.png'))}">LinkedIn → Clay Sync</div>
    <h1>Your LinkedIn network, in Clay.</h1>
    <p>New connections land in your Clay table on a daily or weekly schedule.</p>
    <div class="chips"><span>Scheduled</span><span>Only new connections</span><span>No tracking</span></div>
  </div>
  <img class="shot history" src="data:image/png;base64,${b64(path.join(shots, 'history.png'))}">
  <img class="shot popup" src="data:image/png;base64,${b64(path.join(shots, 'popup.png'))}">
</body></html>`);
await banner.waitForTimeout(300);
await banner.screenshot({ path: path.join(shots, 'banner.png') });

await context.close();
fs.rmSync(profileDir, { recursive: true, force: true });
console.log('Wrote', fs.readdirSync(shots).join(', '));

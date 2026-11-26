// ============================================
// LinkedIn → Clay Sync (Scheduled) — background service worker
//
// Fetches your LinkedIn connections with your existing browser session and
// POSTs each one to your Clay webhook. Runs on demand (popup) or on a
// daily / weekly schedule via chrome.alarms. Nothing is sent anywhere except
// LinkedIn (to read) and your own webhook URL (to write).
// ============================================

importScripts('db.js');

const ALARM_SCHEDULED = 'scheduled-sync';
const ALARM_CATCH_UP = 'catch-up-sync';

const CFG = {
  PAGE_SIZE: 100,
  PAGE_DELAY_MS: 2000,     // pause between LinkedIn pages
  POST_DELAY_MS: 100,      // pause between webhook POSTs
  MAX_RETRIES: 3,          // on 429 / 5xx
  RETRY_BASE_MS: 30000,    // 30s, 60s, 120s
  CATCH_UP_DELAY_MIN: 1,   // wait a minute after browser start before a missed run
  MIN_GAP_MS: 10 * 60 * 1000, // never run two scheduled syncs within 10 min
  LOG_SIZE: 20,
};

const DEFAULTS = {
  webhookUrl: '',
  deltaSync: true,
  notify: true,
  schedule: { mode: 'off', time: '08:00', weekday: 1 }, // mode: off | daily | weekly; weekday 0=Sun
  scheduleSetAt: 0,
  watermark: null,         // ms timestamp: everything connected at/before this is handled
  sentUrns: [],            // URNs sent since the last fully successful run (partial-run dedupe)
  lastSyncTime: null,
  lastScheduledAttempt: 0,
  runs: [],                // recent run log, newest first
};

const getSettings = () => chrome.storage.local.get(DEFAULTS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================
// Scheduling
// ============================================

function nextOccurrence(schedule, from = Date.now()) {
  if (!schedule || !['daily', 'weekly'].includes(schedule.mode)) return null;
  const [h, m] = String(schedule.time || '08:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(h || 0, m || 0, 0, 0);
  if (schedule.mode === 'daily') {
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  } else {
    const wd = Number(schedule.weekday) || 0;
    d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7));
    if (d.getTime() <= from) d.setDate(d.getDate() + 7);
  }
  return d.getTime();
}

function previousOccurrence(schedule, from = Date.now()) {
  const next = nextOccurrence(schedule, from);
  if (!next) return null;
  const d = new Date(next);
  d.setDate(d.getDate() - (schedule.mode === 'weekly' ? 7 : 1));
  return d.getTime();
}

async function reschedule() {
  const { schedule } = await getSettings();
  await chrome.alarms.clear(ALARM_SCHEDULED);
  const when = nextOccurrence(schedule);
  if (when) await chrome.alarms.create(ALARM_SCHEDULED, { when });
  return when;
}

// Alarms may not survive a browser restart, and a run is missed if Chrome was
// closed at the scheduled time. On startup: recreate the alarm, and if the
// most recent scheduled slot was missed, queue a catch-up run shortly after.
async function ensureScheduleAndCatchUp() {
  const s = await getSettings();
  if (!nextOccurrence(s.schedule)) {
    await chrome.alarms.clear(ALARM_SCHEDULED);
    return;
  }
  const existing = await chrome.alarms.get(ALARM_SCHEDULED);
  if (!existing || existing.scheduledTime !== nextOccurrence(s.schedule)) await reschedule();

  const prev = previousOccurrence(s.schedule);
  if (prev && s.lastScheduledAttempt < prev && s.scheduleSetAt < prev) {
    await chrome.alarms.create(ALARM_CATCH_UP, { delayInMinutes: CFG.CATCH_UP_DELAY_MIN });
  }
}

async function runScheduled(trigger) {
  const s = await getSettings();
  if (!nextOccurrence(s.schedule)) return;
  if (Date.now() - s.lastScheduledAttempt < CFG.MIN_GAP_MS) return;
  await chrome.storage.local.set({ lastScheduledAttempt: Date.now() });
  const result = await runSync(trigger);
  if (result.skipped || !s.notify) return;
  if (!result.success) {
    notify('Clay sync failed', result.message);
  } else if (result.count > 0) {
    notify('Clay sync complete', result.message);
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: String(message).slice(0, 250),
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SCHEDULED) {
    await reschedule();
    await runScheduled('scheduled');
  } else if (alarm.name === ALARM_CATCH_UP) {
    await runScheduled('catch-up');
  }
});

chrome.runtime.onStartup.addListener(ensureScheduleAndCatchUp);
chrome.runtime.onInstalled.addListener(ensureScheduleAndCatchUp);

// ============================================
// Popup messages
// ============================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SYNC_NOW') {
    const alreadyRunning = running;
    runSync('manual'); // progress is reported via storage.session
    sendResponse({ started: !alreadyRunning });
  } else if (msg.type === 'RESCHEDULE') {
    reschedule().then((when) => sendResponse({ when }));
    return true;
  }
  return false;
});

// ============================================
// Sync state (mirrored into storage.session so the popup can follow along;
// the writes also keep the service worker awake during long runs)
// ============================================

let running = false;
let state = {};

async function setState(patch) {
  state = { ...state, ...patch };
  await chrome.storage.session.set({ syncState: state });
}

// ============================================
// Sync
// ============================================

async function runSync(trigger = 'manual') {
  if (running) return { skipped: true };
  running = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const startedAt = Date.now();
  let result;
  let sent = null;
  await setState({ running: true, trigger, progress: 0, text: 'Starting…', result: null, startedAt });

  try {
    const s = await getSettings();
    if (!/^https:\/\//i.test(s.webhookUrl || '')) throw new Error('No Clay webhook URL set');
    const csrf = await getCsrfToken();

    const delta = s.deltaSync && s.watermark != null;
    sent = new Set(s.sentUrns);

    const { connections, newest } = await fetchConnections(csrf, delta ? s.watermark : null);

    const todo = connections
      .filter((c) => !delta || (c.connectedAtMs != null && c.connectedAtMs > s.watermark))
      .filter((c) => !(s.deltaSync && c.entityUrn && sent.has(c.entityUrn)))
      .sort((a, b) => (a.connectedAtMs ?? 0) - (b.connectedAtMs ?? 0)); // oldest first

    await setState({ progress: 85, text: `Found ${todo.length} ${delta ? 'new ' : ''}connections…` });
    await sendToWebhook(todo, s.webhookUrl, sent, { at: startedAt, trigger });

    const watermark = Math.max(s.watermark ?? 0, newest ?? 0) || s.watermark;
    sent = null; // full success: everything up to the watermark is handled
    await chrome.storage.local.set({ watermark, sentUrns: [], lastSyncTime: new Date().toISOString() });

    const message = todo.length
      ? `Synced ${todo.length} ${delta ? 'new ' : ''}connection${todo.length === 1 ? '' : 's'} to Clay.`
      : 'No new connections to sync.';
    result = { success: true, message, count: todo.length, scanned: connections.length };
  } catch (err) {
    result = { success: false, message: err.message || String(err), count: 0 };
  } finally {
    if (sent) await chrome.storage.local.set({ sentUrns: [...sent] });
    clearInterval(keepAlive);
    running = false;
  }

  await logRun({ at: startedAt, trigger, ...result, durationMs: Date.now() - startedAt });
  await setState({ running: false, progress: result.success ? 100 : 0, text: '', result });
  return result;
}

async function logRun(entry) {
  const { runs } = await getSettings();
  await chrome.storage.local.set({ runs: [entry, ...runs].slice(0, CFG.LOG_SIZE) });
}

async function getCsrfToken() {
  const liAt = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
  if (!liAt?.value) throw new Error('Not logged into LinkedIn in this browser');
  const js = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' });
  const csrf = js?.value?.replace(/"/g, '');
  if (!csrf) throw new Error('LinkedIn session cookie missing — open linkedin.com and reload');
  return csrf;
}

// Pages through connections newest-first. In delta mode it stops as soon as it
// reaches connections at/before the watermark, so a daily run usually needs a
// single request instead of re-downloading the whole network. If LinkedIn ever
// returns them unsorted, it falls back to a full scan.
async function fetchConnections(csrf, stopAtMs) {
  const all = [];
  let start = 0;
  let useSort = true;
  let sorted = true;
  let prevMs = Infinity;
  let newest = null;
  let total = null;

  for (;;) {
    let data;
    try {
      data = await fetchConnectionsPage(start, csrf, useSort);
    } catch (err) {
      if (useSort && start === 0 && err.status === 400) {
        useSort = false;
        sorted = false;
        continue;
      }
      throw err;
    }

    const elements = data.elements || [];
    if (total == null) total = data.paging?.total ?? null;

    for (const el of elements) {
      const c = parseConnection(el);
      if (!c) continue;
      if (c.connectedAtMs != null) {
        if (c.connectedAtMs > prevMs) sorted = false;
        prevMs = c.connectedAtMs;
        newest = Math.max(newest ?? 0, c.connectedAtMs);
      }
      all.push(c);
    }

    await setState({
      progress: total ? Math.min((all.length / total) * 80, 80) : Math.min(all.length / 10, 80),
      text: `Fetched ${all.length} connections…`,
    });

    if (elements.length < CFG.PAGE_SIZE) break;
    if (stopAtMs != null && useSort && sorted && prevMs <= stopAtMs) break;
    start += CFG.PAGE_SIZE;
    await sleep(CFG.PAGE_DELAY_MS);
  }

  return { connections: all, newest };
}

async function fetchConnectionsPage(start, csrf, useSort) {
  const url =
    'https://www.linkedin.com/voyager/api/relationships/dash/connections' +
    '?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16' +
    `&count=${CFG.PAGE_SIZE}&q=search${useSort ? '&sortType=RECENTLY_ADDED' : ''}&start=${start}`;

  const res = await fetchWithRetry(url, {
    credentials: 'include',
    headers: {
      'csrf-token': csrf,
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
    },
  }, 'LinkedIn');

  if (res.status === 401 || res.status === 403) {
    throw httpError('LinkedIn session expired — log in at linkedin.com', res.status);
  }
  if (!res.ok) throw httpError(`LinkedIn API error: ${res.status}`, res.status);
  return res.json();
}

function parseConnection(el) {
  try {
    const p = el.connectedMemberResolutionResult || {};
    const ms = typeof el.createdAt === 'number' ? el.createdAt : null;
    return {
      firstName: p.firstName || '',
      lastName: p.lastName || '',
      fullName: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
      headline: p.headline || '',
      profileUrl: p.publicIdentifier ? `https://www.linkedin.com/in/${p.publicIdentifier}` : '',
      publicIdentifier: p.publicIdentifier || '',
      connectedAt: ms != null ? new Date(ms).toISOString() : '',
      entityUrn: p.entityUrn || el.entityUrn || '',
      connectedAtMs: ms,
    };
  } catch {
    return null;
  }
}

async function sendToWebhook(connections, webhookUrl, sent, run) {
  for (let i = 0; i < connections.length; i++) {
    const { connectedAtMs, ...payload } = connections[i];
    const res = await fetchWithRetry(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 'Webhook');
    if (!res.ok) throw httpError(`Webhook error: ${res.status} (after ${i} sent)`, res.status);

    if (payload.entityUrn) sent.add(payload.entityUrn);
    try {
      await ProfileLog.recordSynced(payload, run);
    } catch (err) {
      console.warn('Could not record synced profile', err); // never break the sync over the log
    }
    if (i % 10 === 0 || i === connections.length - 1) {
      await chrome.storage.local.set({ sentUrns: [...sent] });
      await setState({
        progress: 85 + ((i + 1) / connections.length) * 15,
        text: `Sent ${i + 1}/${connections.length} to Clay…`,
      });
    }
    await sleep(CFG.POST_DELAY_MS);
  }
}

async function fetchWithRetry(url, options, label) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= CFG.MAX_RETRIES) return res;
    const wait = CFG.RETRY_BASE_MS * 2 ** attempt;
    await setState({ text: `${label} rate limit (${res.status}) — retrying in ${Math.round(wait / 1000)}s…` });
    await sleep(wait);
  }
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

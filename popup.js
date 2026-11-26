// ============================================
// LinkedIn → Clay Sync (Scheduled) — popup
// ============================================

const $ = (id) => document.getElementById(id);
const el = {
  liDot: $('li-dot'), liText: $('li-text'),
  webhook: $('webhook-url'),
  mode: $('schedule-mode'), weekday: $('schedule-weekday'), time: $('schedule-time'),
  weekdayWrap: $('weekday-wrap'), timeWrap: $('time-wrap'), nextRun: $('next-run'),
  delta: $('delta-sync'), notify: $('notify'), history: $('history-info'),
  baseline: $('baseline'), reset: $('reset'), openHistory: $('open-history'),
  syncBtn: $('sync-btn'), progress: $('progress'), bar: $('bar'), status: $('status'), result: $('result'),
};

let linkedInOk = false;
let syncRunning = false;

const fmt = (ms) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function init() {
  const s = await chrome.storage.local.get({
    webhookUrl: '', deltaSync: true, notify: true,
    schedule: { mode: 'off', time: '08:00', weekday: 1 },
  });
  el.webhook.value = s.webhookUrl;
  el.delta.checked = s.deltaSync;
  el.notify.checked = s.notify;
  el.mode.value = s.schedule.mode;
  el.time.value = s.schedule.time;
  el.weekday.value = String(s.schedule.weekday);
  updateScheduleFields();

  await Promise.all([checkLinkedIn(), renderNextRun(), renderHistory()]);

  const { syncState } = await chrome.storage.session.get('syncState');
  if (syncState) renderState(syncState);

  el.webhook.addEventListener('input', () => {
    chrome.storage.local.set({ webhookUrl: el.webhook.value.trim() });
    updateButton();
  });
  el.delta.addEventListener('change', () => chrome.storage.local.set({ deltaSync: el.delta.checked }));
  el.notify.addEventListener('change', () => chrome.storage.local.set({ notify: el.notify.checked }));
  for (const input of [el.mode, el.time, el.weekday]) input.addEventListener('change', saveSchedule);

  el.syncBtn.addEventListener('click', () => {
    el.result.className = 'result';
    chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
  });

  el.openHistory.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') }));
  renderProfileCount();

  el.baseline.addEventListener('click', async () => {
    if (!confirm("Mark everyone you're connected with right now as already synced? Only connections made after this moment will be sent.")) return;
    await chrome.storage.local.set({ watermark: Date.now(), sentUrns: [], deltaSync: true });
    el.delta.checked = true;
    renderHistory();
  });
  el.reset.addEventListener('click', async () => {
    if (!confirm('Forget sync history? The next sync will send all of your connections.')) return;
    await chrome.storage.local.set({ watermark: null, sentUrns: [], lastSyncTime: null });
    renderHistory();
  });

  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.syncState) renderState(changes.syncState.newValue || {});
  });
  chrome.storage.local.onChanged.addListener((changes) => {
    if (changes.runs || changes.watermark || changes.lastSyncTime) renderHistory();
    if (changes.runs) renderProfileCount();
  });
}

function updateScheduleFields() {
  el.weekdayWrap.hidden = el.mode.value !== 'weekly';
  el.timeWrap.hidden = el.mode.value === 'off';
}

async function saveSchedule() {
  updateScheduleFields();
  const schedule = { mode: el.mode.value, time: el.time.value || '08:00', weekday: Number(el.weekday.value) };
  await chrome.storage.local.set({ schedule, scheduleSetAt: Date.now() });
  await chrome.runtime.sendMessage({ type: 'RESCHEDULE' });
  renderNextRun();
}

async function renderNextRun() {
  const alarm = await chrome.alarms.get('scheduled-sync');
  el.nextRun.textContent = alarm ? `Next run: ${fmt(alarm.scheduledTime)}` : 'No scheduled runs.';
}

async function renderHistory() {
  const { watermark, lastSyncTime, runs } = await chrome.storage.local.get({ watermark: null, lastSyncTime: null, runs: [] });
  const parts = [];
  if (lastSyncTime) parts.push(`Last sync: ${fmt(Date.parse(lastSyncTime))}`);
  else if (watermark) parts.push(`Starting from ${fmt(watermark)}`);
  else parts.push('Never synced — the first sync sends all connections.');
  const last = runs[0];
  if (last) parts.push(`Last run (${last.trigger}): ${last.success ? '✓' : '✗'} ${last.message}`);
  el.history.textContent = parts.join(' · ');
}

async function renderProfileCount() {
  const n = await ProfileLog.count().catch(() => 0);
  el.openHistory.textContent = n ? `View ${n.toLocaleString()} synced profiles & run history` : 'View synced profiles & run history';
}

async function checkLinkedIn() {
  const cookie = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' }).catch(() => null);
  linkedInOk = !!cookie?.value;
  el.liDot.className = `dot ${linkedInOk ? 'ok' : 'err'}`;
  el.liText.textContent = linkedInOk ? 'LinkedIn connected' : 'Not logged into LinkedIn';
  updateButton();
}

function updateButton() {
  el.syncBtn.disabled = syncRunning || !linkedInOk || !/^https:\/\//i.test(el.webhook.value.trim());
}

function renderState(st) {
  syncRunning = !!st.running;
  el.syncBtn.textContent = syncRunning ? 'Syncing…' : 'Sync now';
  el.progress.classList.toggle('active', syncRunning);
  el.bar.style.width = `${st.progress || 0}%`;
  el.status.textContent = syncRunning ? st.text || '' : '';
  if (!syncRunning && st.result) {
    el.result.className = `result ${st.result.success ? 'ok' : 'err'}`;
    el.result.textContent = st.result.message;
  }
  updateButton();
}

init();

// ============================================
// Synced profiles + run history page
// ============================================

const $ = (id) => document.getElementById(id);
const PAGE = 500;

let profiles = [];
let runs = [];
let sortKey = 'lastSyncedAt';
let sortDir = -1;
let shown = PAGE;

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function td(text, cls) {
  const cell = document.createElement('td');
  if (cls) cell.className = cls;
  cell.textContent = text;
  return cell;
}

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const when = $('when').value;
  let since = null;
  if (when === 'lastrun') since = runs.find((r) => r.success && r.count > 0)?.at ?? Infinity;
  else if (when !== 'all') since = Date.now() - Number(when) * 86400000;

  return profiles
    .filter((p) => (since == null ? true : when === 'lastrun' ? p.lastRunAt === since : p.lastSyncedAt >= since))
    .filter((p) => !q || [p.fullName, p.headline, p.publicIdentifier].some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => {
      const x = a[sortKey] ?? '', y = b[sortKey] ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sortDir;
    });
}

function renderProfiles() {
  const rows = filtered();
  const body = $('profiles');
  body.replaceChildren();
  $('count').textContent = `${rows.length.toLocaleString()} of ${profiles.length.toLocaleString()} profiles`;

  if (!rows.length) {
    const tr = document.createElement('tr');
    const cell = td(profiles.length ? 'No profiles match.' : 'Nothing synced yet. Run a sync and the profiles sent to Clay will show up here.', 'empty');
    cell.colSpan = 5;
    tr.append(cell);
    body.append(tr);
  }

  for (const p of rows.slice(0, shown)) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    if (p.profileUrl) {
      const a = document.createElement('a');
      a.href = p.profileUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = p.fullName || p.publicIdentifier || p.profileUrl;
      name.append(a);
    } else {
      name.textContent = p.fullName || '—';
    }
    const last = td(fmtDateTime(p.lastSyncedAt) + ' ', 'nowrap');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = p.lastTrigger;
    last.append(tag);
    tr.append(name, td(p.headline || '', 'headline'), td(fmtDate(p.connectedAt), 'nowrap'), last, td(String(p.timesSent), 'num'));
    body.append(tr);
  }

  $('more').hidden = rows.length <= shown;
  $('more').textContent = `Show more (${(rows.length - shown).toLocaleString()} left)`;
  for (const th of document.querySelectorAll('th[data-sort]')) {
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = th.dataset.sort === sortKey ? `${base} ${sortDir > 0 ? '▲' : '▼'}` : base;
  }
}

function renderRuns() {
  const body = $('runs');
  body.replaceChildren();
  if (!runs.length) {
    const tr = document.createElement('tr');
    const cell = td('No runs yet.', 'empty');
    cell.colSpan = 6;
    tr.append(cell);
    body.append(tr);
    return;
  }
  for (const r of runs) {
    const tr = document.createElement('tr');
    tr.append(
      td(fmtDateTime(r.at), 'nowrap'),
      td(r.trigger),
      td(`${r.success ? '✓' : '✗'} ${r.message}`, r.success ? 'ok' : 'err'),
      td(String(r.count ?? 0), 'num'),
      td(r.scanned != null ? String(r.scanned) : '—', 'num'),
      td(r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : '—', 'num'),
    );
    body.append(tr);
  }
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheets from treating it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const cols = ['fullName', 'firstName', 'lastName', 'headline', 'profileUrl', 'publicIdentifier', 'connectedAt', 'firstSyncedAt', 'lastSyncedAt', 'timesSent', 'lastTrigger', 'entityUrn'];
  const iso = (v) => (v ? new Date(v).toISOString() : '');
  const lines = [cols.join(',')];
  for (const p of filtered()) {
    lines.push(cols.map((c) => csvCell(c === 'firstSyncedAt' || c === 'lastSyncedAt' ? iso(p[c]) : p[c])).join(','));
  }
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `clay-synced-profiles-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function load() {
  [profiles, { runs }] = await Promise.all([ProfileLog.all(), chrome.storage.local.get({ runs: [] })]);
  renderProfiles();
  renderRuns();
}

$('q').addEventListener('input', () => { shown = PAGE; renderProfiles(); });
$('when').addEventListener('change', () => { shown = PAGE; renderProfiles(); });
$('more').addEventListener('click', () => { shown += PAGE; renderProfiles(); });
$('export').addEventListener('click', exportCsv);
$('clear').addEventListener('click', async () => {
  if (!confirm('Clear this list? This only empties the list on this page. It does not change what has been synced or what gets sent next.')) return;
  await ProfileLog.clear();
  load();
});
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    if (sortKey === th.dataset.sort) sortDir = -sortDir;
    else { sortKey = th.dataset.sort; sortDir = th.dataset.sort === 'fullName' || th.dataset.sort === 'headline' ? 1 : -1; }
    renderProfiles();
  });
}

// Refresh when a sync finishes while this page is open.
chrome.storage.local.onChanged.addListener((changes) => { if (changes.runs) load(); });

load();

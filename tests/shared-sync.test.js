import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const helperSource = await readFile(new URL('../shared-sync.js', import.meta.url), 'utf8');

function createBrowserHarness({ previewMode = false } = {}) {
  const calls = [];
  const storageData = new Map();
  const remoteState = {
    protrack_records: [{ id: 'cloud-record', date: '2026-11-07', workerName: 'Repair Team Member', attendance: 'Present', installs: 3, restored: 1, totalUnits: 4 }],
    protrack_workers: [{ id: 'worker-1', name: 'Repair Team Member', photo: '' }],
    protrack_team_logo: '',
    protrack_fleet: [],
    protrack_updates: [],
    protrack_weekend: []
  };
  const versions = Object.fromEntries(Object.keys(remoteState).map(key => [key, 1]));
  let etag = '"initial-version"';

  class FakeStorage {
    getItem(key) { return storageData.has(String(key)) ? storageData.get(String(key)) : null; }
    setItem(key, value) { storageData.set(String(key), String(value)); }
    removeItem(key) { storageData.delete(String(key)); }
  }
  const localStorage = new FakeStorage();
  const elements = new Map();
  const renderCounts = { dashboard: 0, table: 0, workers: 0, directory: 0, logo: 0, fleet: 0, updates: 0, weekend: 0 };
  const label = { textContent: '' };
  const syncStatus = { className: '', title: '', setAttribute() {}, querySelector: () => label };
  const overlay = { classList: { add() {} } };
  const notice = { classList: { add() {}, remove() {} } };
  const message = { textContent: '' };
  const importButton = { classList: { add() {}, toggle() {} }, disabled: false, textContent: '' };
  const reloadButton = { classList: { add() {}, remove() {} } };
  elements.set('shared-sync-status', syncStatus);
  elements.set('shared-loading-overlay', overlay);
  elements.set('shared-storage-notice', notice);
  elements.set('shared-storage-message', message);
  elements.set('shared-storage-import-button', importButton);
  elements.set('shared-storage-reload-button', reloadButton);

  const document = {
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [],
    createElement: () => ({ classList: { add() {} } })
  };
  const window = {
    Storage: FakeStorage,
    localStorage,
    setInterval: () => 1,
    confirm: () => false,
    location: { reload() {} }
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === '/api/state' && options.method !== 'PUT') {
      const suppliedEtag = new Headers(options.headers || {}).get('If-None-Match');
      if (!previewMode && suppliedEtag === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      const stateBody = previewMode
        ? { initialized: false, state: {}, versions: {}, previewMode: 'local-only' }
        : { initialized: true, state: structuredClone(remoteState), versions: structuredClone(versions) };
      return new Response(JSON.stringify(stateBody), {
        status: 200,
        headers: { 'content-type': 'application/json', ETag: etag }
      });
    }
    if (String(url) === '/api/admin/session') {
      return new Response(JSON.stringify({ authenticated: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url) === '/api/team-lead/login' && options.method === 'POST') {
      return new Response(JSON.stringify({ authenticated: true, role: 'team_lead' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url) === '/api/attendance' && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      if (payload.version !== versions.protrack_records) {
        return new Response(JSON.stringify({ error: 'version conflict' }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      remoteState.protrack_records = remoteState.protrack_records.map(record =>
        record.workerName === payload.workerName && record.date === payload.date
          ? { ...record, attendance: payload.status }
          : record
      );
      versions.protrack_records += 1;
      etag = `"version-${Date.now()}"`;
      return new Response(JSON.stringify({ records: remoteState.protrack_records, version: versions.protrack_records, role: 'team_lead' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).startsWith('/api/state/') && options.method === 'PUT') {
      const key = decodeURIComponent(String(url).split('/').at(-1));
      const payload = JSON.parse(options.body);
      if (payload.version !== versions[key]) {
        return new Response(JSON.stringify({ error: 'version conflict' }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      remoteState[key] = payload.value;
      versions[key] += 1;
      etag = `"version-${Date.now()}"`;
      return new Response(JSON.stringify({ version: versions[key] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = {
    window,
    document,
    fetch,
    Headers,
    Response,
    console,
    Object,
    JSON,
    Array,
    Number,
    String,
    Promise,
    encodeURIComponent,
    structuredClone,
    isAdminMode: false,
    records: [],
    workers: [],
    teamLogo: '',
    fleetVehicles: [],
    teamUpdates: [],
    weekendSchedule: [],
    renderTeamLogo: () => { renderCounts.logo += 1; },
    populateWorkerSelect: () => {},
    renderDashboard: () => { renderCounts.dashboard += 1; },
    renderTable: () => { renderCounts.table += 1; },
    renderWorkers: () => { renderCounts.workers += 1; },
    renderDirectory: () => { renderCounts.directory += 1; },
    renderFleet: () => { renderCounts.fleet += 1; },
    renderUpdates: () => { renderCounts.updates += 1; },
    renderWeekendSchedule: () => { renderCounts.weekend += 1; },
    applyAdminUIState: () => {},
    showToast: () => {},
    isTeamLeadMode: false,
    currentUserRole: 'worker'
  };
  runInNewContext(helperSource, context, { filename: 'shared-sync.js' });
  return { context, calls, localStorage, remoteState, versions, renderCounts, label, message };
}

test('a fresh device hydrates the shared records and a read-only browser cannot write them', async () => {
  const harness = createBrowserHarness();
  const { context } = harness;
  await runInNewContext('initializeSharedData()', context);

  assert.equal(runInNewContext('records[0].id', context), 'cloud-record');
  assert.equal(runInNewContext('workers[0].name', context), 'Repair Team Member');
  assert.equal(harness.localStorage.getItem('protrack_records'), JSON.stringify(harness.remoteState.protrack_records));
  assert.ok(harness.renderCounts.dashboard > 0);
  assert.ok(harness.renderCounts.table > 0);

  harness.localStorage.setItem('protrack_records', JSON.stringify([{ id: 'local-only' }]));
  await runInNewContext('sharedWriteQueue', context);
  assert.equal(harness.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.equal(harness.remoteState.protrack_records[0].id, 'cloud-record');
});

test('admin storage changes serialize into versioned same-origin writes', async () => {
  const harness = createBrowserHarness();
  const { context } = harness;
  await runInNewContext('initializeSharedData()', context);
  runInNewContext('isAdminMode = true; updateSharedSyncUI()', context);

  harness.localStorage.setItem('protrack_records', JSON.stringify([{ id: 'updated-1' }]));
  harness.localStorage.setItem('protrack_records', JSON.stringify([{ id: 'updated-2' }]));
  await runInNewContext('sharedWriteQueue', context);

  const writes = harness.calls.filter(call => call.options.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(call => JSON.parse(call.options.body).version), [1, 2]);
  assert.equal(harness.remoteState.protrack_records[0].id, 'updated-2');
  assert.ok(writes.every(call => call.options.credentials === 'same-origin'));
  assert.equal(harness.versions.protrack_records, 3);
});

test('Team Leads use the attendance-only API and cannot queue full-state writes', async () => {
  const harness = createBrowserHarness();
  const { context } = harness;
  await runInNewContext('initializeSharedData()', context);

  const login = await runInNewContext("roleLogin('team-lead-passcode', 'team_lead')", context);
  assert.equal(login.role, 'team_lead');
  runInNewContext("isTeamLeadMode = true; currentUserRole = 'team_lead'; updateSharedSyncUI()", context);
  await runInNewContext("updateSharedAttendance({ workerName: 'Repair Team Member', date: '2026-11-07', status: 'Sick Leave' })", context);

  assert.equal(harness.remoteState.protrack_records[0].attendance, 'Sick Leave');
  assert.equal(harness.remoteState.protrack_records[0].installs, 3);
  assert.equal(harness.remoteState.protrack_records[0].restored, 1);
  assert.equal(harness.remoteState.protrack_records[0].totalUnits, 4);
  assert.equal(harness.calls.filter(call => call.url === '/api/attendance' && call.options.method === 'POST').length, 1);
  assert.equal(harness.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.equal(harness.label.textContent, 'Team Lead · attendance only');
});

test('local-only Preview mode stays visible without reporting a shared-storage initialization error', async () => {
  const harness = createBrowserHarness({ previewMode: true });
  const { context } = harness;
  await runInNewContext('initializeSharedData()', context);

  assert.equal(runInNewContext('sharedPreviewMode', context), true);
  assert.equal(runInNewContext('sharedApiReady', context), false);
  assert.equal(harness.label.textContent, 'Preview · local only');
  assert.match(harness.message.textContent, /edits and cross-device sync are disabled/);
  assert.equal(harness.calls.filter(call => call.url === '/api/admin/session').length, 0);

  harness.localStorage.setItem('protrack_records', JSON.stringify([{ id: 'device-local' }]));
  await runInNewContext('sharedWriteQueue', context);
  assert.equal(harness.calls.filter(call => call.options.method === 'PUT').length, 0);
});

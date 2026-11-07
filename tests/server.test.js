import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp, createLocalPreviewRepository, SHARED_STATE_KEYS } from '../server.js';

function createMemoryRepository() {
  let initialized = false;
  let state = {};
  let versions = {};
  const sessions = new Map();

  return {
    async getState() {
      return {
        initialized,
        state: structuredClone(state),
        versions: structuredClone(versions)
      };
    },
    async initializeState(nextState) {
      if (initialized) return { initialized: false };
      state = structuredClone(nextState);
      versions = Object.fromEntries(SHARED_STATE_KEYS.map(key => [key, 1]));
      initialized = true;
      return this.getState();
    },
    async updateState(key, value, expectedVersion) {
      if (!initialized) return { reason: 'not_initialized' };
      const currentVersion = versions[key] || 0;
      if (currentVersion !== expectedVersion) return { reason: 'version_conflict', currentVersion };
      state[key] = structuredClone(value);
      versions[key] = currentVersion + 1;
      return { version: versions[key] };
    },
    async createAdminSession(tokenHash, role = 'admin') {
      sessions.set(tokenHash, role);
    },
    async getAdminSessionRole(tokenHash) {
      return sessions.get(tokenHash) || null;
    },
    async hasAdminSession(tokenHash) {
      return sessions.has(tokenHash);
    },
    async deleteAdminSession(tokenHash) {
      sessions.delete(tokenHash);
    }
  };
}

test('public visitors can read; only an authenticated admin can import or update shared data', async t => {
  const app = createApp({ repository: createMemoryRepository(), adminPassword: 'secure-test-passcode-2026' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = {
    'content-type': 'application/json',
    'x-protrack-request': '1'
  };

  const publicRead = await fetch(`${baseUrl}/api/state`);
  assert.equal(publicRead.status, 200);
  assert.deepEqual(await publicRead.json(), { initialized: false, state: {}, versions: {} });

  const unauthenticatedWrite = await fetch(`${baseUrl}/api/state/protrack_records`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ value: [], version: 0 })
  });
  assert.equal(unauthenticatedWrite.status, 401);

  const migrationWithoutSession = await fetch(`${baseUrl}/api/admin/migrate`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ state: {} })
  });
  assert.equal(migrationWithoutSession.status, 401);

  const invalidLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ passcode: 'incorrect-passcode' })
  });
  assert.equal(invalidLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ passcode: 'secure-test-passcode-2026' })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=None/i);
  const cookie = setCookie.split(';', 1)[0];

  const initialState = {
    protrack_records: [{ id: 'record-1', workerName: 'Repair Team Member', attendance: 'Present', installs: 2, restored: 1 }],
    protrack_workers: [{ id: 'worker-1', name: 'Repair Team Member', photo: 'data:image/jpeg;base64,dGVzdA==' }],
    protrack_team_logo: '',
    protrack_fleet: [],
    protrack_updates: [],
    protrack_weekend: []
  };
  const migration = await fetch(`${baseUrl}/api/admin/migrate`, {
    method: 'POST',
    headers: { ...jsonHeaders, cookie },
    body: JSON.stringify({ state: initialState })
  });
  assert.equal(migration.status, 201);
  const migrated = await migration.json();
  assert.equal(migrated.initialized, true);
  assert.deepEqual(Object.keys(migrated.versions).sort(), [...SHARED_STATE_KEYS].sort());

  const secondMigration = await fetch(`${baseUrl}/api/admin/migrate`, {
    method: 'POST',
    headers: { ...jsonHeaders, cookie },
    body: JSON.stringify({ state: initialState })
  });
  assert.equal(secondMigration.status, 409);

  const publicSharedRead = await fetch(`${baseUrl}/api/state`);
  assert.equal(publicSharedRead.status, 200);
  const publicData = await publicSharedRead.json();
  assert.deepEqual(publicData.state, initialState);

  const update = await fetch(`${baseUrl}/api/state/protrack_records`, {
    method: 'PUT',
    headers: { ...jsonHeaders, cookie },
    body: JSON.stringify({
      value: [{ ...initialState.protrack_records[0], installs: 3, totalUnits: 4 }],
      version: migrated.versions.protrack_records
    })
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).version, 2);

  const staleUpdate = await fetch(`${baseUrl}/api/state/protrack_records`, {
    method: 'PUT',
    headers: { ...jsonHeaders, cookie },
    body: JSON.stringify({ value: [], version: 1 })
  });
  assert.equal(staleUpdate.status, 409);

  const logout = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { ...jsonHeaders, cookie },
    body: JSON.stringify({})
  });
  assert.equal(logout.status, 200);

  const writeAfterLogout = await fetch(`${baseUrl}/api/state/protrack_records`, {
    method: 'PUT',
    headers: { ...jsonHeaders, cookie },
    body: JSON.stringify({ value: [], version: 2 })
  });
  assert.equal(writeAfterLogout.status, 401);
});

test('Team Leads can update attendance only and preserve production quantities', async t => {
  const adminPassword = 'admin-access-passcode-2026';
  const teamLeadPassword = 'team-lead-passcode-2026';
  const app = createApp({
    repository: createMemoryRepository(),
    adminPassword,
    teamLeadPassword
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = {
    'content-type': 'application/json',
    'x-protrack-request': '1'
  };

  const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ passcode: adminPassword })
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get('set-cookie').split(';', 1)[0];
  const initialState = {
    protrack_records: [{
      id: 'record-1', date: '2026-11-01', workerName: 'Repair Team Member',
      attendance: 'Present', installs: 4, restored: 2, totalUnits: 6, notes: 'Keep this log.'
    }],
    protrack_workers: [{ id: 'worker-1', name: 'Repair Team Member', photo: '' }],
    protrack_team_logo: '',
    protrack_fleet: [],
    protrack_updates: [],
    protrack_weekend: []
  };
  const migration = await fetch(`${baseUrl}/api/admin/migrate`, {
    method: 'POST',
    headers: { ...jsonHeaders, cookie: adminCookie },
    body: JSON.stringify({ state: initialState })
  });
  assert.equal(migration.status, 201);
  const initialized = await migration.json();

  const teamLeadLogin = await fetch(`${baseUrl}/api/team-lead/login`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ passcode: teamLeadPassword })
  });
  assert.equal(teamLeadLogin.status, 200);
  const teamLeadCookie = teamLeadLogin.headers.get('set-cookie').split(';', 1)[0];
  const session = await fetch(`${baseUrl}/api/admin/session`, { headers: { cookie: teamLeadCookie } });
  assert.deepEqual(await session.json(), { authenticated: true, role: 'team_lead' });

  const profileWrite = await fetch(`${baseUrl}/api/state/protrack_workers`, {
    method: 'PUT',
    headers: { ...jsonHeaders, cookie: teamLeadCookie },
    body: JSON.stringify({ value: [], version: initialized.versions.protrack_workers })
  });
  assert.equal(profileWrite.status, 403);

  const attendanceWrite = await fetch(`${baseUrl}/api/attendance`, {
    method: 'POST',
    headers: { ...jsonHeaders, cookie: teamLeadCookie },
    body: JSON.stringify({
      workerName: 'Repair Team Member',
      date: '2026-11-01',
      status: 'Sick Leave',
      version: initialized.versions.protrack_records
    })
  });
  assert.equal(attendanceWrite.status, 200);
  const changed = (await attendanceWrite.json()).records[0];
  assert.equal(changed.attendance, 'Sick Leave');
  assert.equal(changed.installs, 4);
  assert.equal(changed.restored, 2);
  assert.equal(changed.totalUnits, 6);
  assert.equal(changed.notes, 'Keep this log.');

  const installationWrite = await fetch(`${baseUrl}/api/attendance`, {
    method: 'POST',
    headers: { ...jsonHeaders, cookie: teamLeadCookie },
    body: JSON.stringify({
      workerName: 'Installation Member',
      date: '2026-11-01',
      status: 'Present',
      version: 2
    })
  });
  assert.equal(installationWrite.status, 403);

  const fullRecordWrite = await fetch(`${baseUrl}/api/state/protrack_records`, {
    method: 'PUT',
    headers: { ...jsonHeaders, cookie: teamLeadCookie },
    body: JSON.stringify({ value: [], version: 2 })
  });
  assert.equal(fullRecordWrite.status, 403);
});

test('local-only Preview serves state and health endpoints but disables admin writes', async t => {
  const app = createApp({ repository: createLocalPreviewRepository() });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = {
    'content-type': 'application/json',
    'x-protrack-request': '1'
  };

  const stateResponse = await fetch(`${baseUrl}/api/state`);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    initialized: false,
    state: {},
    versions: {},
    previewMode: 'local-only'
  });

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ passcode: 'anything' })
  });
  assert.equal(login.status, 503);
  assert.match((await login.json()).error, /local-only Preview/);

  const write = await fetch(`${baseUrl}/api/state/protrack_records`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ value: [], version: 0 })
  });
  assert.equal(write.status, 401);
});

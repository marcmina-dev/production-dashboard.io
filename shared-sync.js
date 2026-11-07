const PROTRACK_SHARED_KEYS = Object.freeze([
  'protrack_records',
  'protrack_workers',
  'protrack_team_logo',
  'protrack_fleet',
  'protrack_updates',
  'protrack_weekend'
]);

let sharedApiReady = false;
let sharedDataInitialized = false;
let sharedWriteBlocked = false;
let sharedVersions = Object.create(null);
let sharedEtag = '';
let sharedWriteQueue = Promise.resolve();
let sharedPollTimer = null;
let pendingSharedWrites = 0;
let originalStorageSetItem = null;
let storageBridgeInstalled = false;
let sharedPreviewMode = false;

function sharedEditingAllowed() {
  return sharedApiReady && sharedDataInitialized && isAdminMode && !sharedWriteBlocked;
}

function sharedAttendanceEditingAllowed() {
  return sharedApiReady && sharedDataInitialized && (isAdminMode || isTeamLeadMode) && !sharedWriteBlocked;
}

function setSharedSyncStatus(text, tone = 'neutral') {
  const node = document.getElementById('shared-sync-status');
  if (!node) return;
  const tones = {
    neutral: 'text-slate-400 border-slate-700 bg-slate-900',
    good: 'text-emerald-300 border-emerald-700/60 bg-emerald-950/40',
    busy: 'text-cyan-200 border-cyan-700/60 bg-cyan-950/40',
    warning: 'text-amber-200 border-amber-700/60 bg-amber-950/40',
    error: 'text-rose-200 border-rose-700/60 bg-rose-950/40'
  };
  node.className = `flex items-center gap-2 rounded-full border px-2 py-1.5 text-[11px] font-semibold sm:px-3 ${tones[tone] || tones.neutral}`;
  node.title = text;
  node.setAttribute('aria-label', text);
  const label = node.querySelector('[data-sync-label]');
  if (label) label.textContent = text;
}

function updateSharedSyncUI() {
  const panel = document.getElementById('shared-storage-notice');
  const message = document.getElementById('shared-storage-message');
  const importButton = document.getElementById('shared-storage-import-button');
  const reloadButton = document.getElementById('shared-storage-reload-button');
  const isAdmin = Boolean(isAdminMode);
  const isTeamLead = Boolean(isTeamLeadMode);

  if (sharedPreviewMode) {
    if (panel) panel.classList.remove('hidden');
    if (message) message.textContent = 'This is a local-only Preview using this browser’s saved copy. Shared MySQL is not configured here, so edits and cross-device sync are disabled.';
    if (importButton) importButton.classList.add('hidden');
    if (reloadButton) reloadButton.classList.add('hidden');
    setSharedSyncStatus('Preview · local only', 'warning');
    return;
  }

  if (!sharedApiReady) {
    if (panel) panel.classList.remove('hidden');
    if (message) message.textContent = 'Shared storage is not reachable. This device may show its own saved copy, but changes are not being shared.';
    if (importButton) importButton.classList.add('hidden');
    if (reloadButton) reloadButton.classList.add('hidden');
    setSharedSyncStatus('Shared storage unavailable', 'error');
    return;
  }

  if (!sharedDataInitialized) {
    if (panel) panel.classList.remove('hidden');
    if (message) {
      message.textContent = isAdmin
        ? 'Shared storage is empty. Import this device’s saved dashboard data once to make it available to everyone with the link. This will not replace existing shared data.'
        : 'Shared storage is ready but has not been initialized. An administrator must import the saved dashboard data from its original device.';
    }
    if (importButton) importButton.classList.toggle('hidden', !isAdmin);
    if (reloadButton) reloadButton.classList.add('hidden');
    setSharedSyncStatus('Waiting for first data sync', 'warning');
    return;
  }

  if (sharedWriteBlocked) {
    if (panel) panel.classList.remove('hidden');
    if (message) message.textContent = 'A shared-data conflict stopped editing to protect newer changes. Reload this page to load the latest shared copy before editing again.';
    if (importButton) importButton.classList.add('hidden');
    if (reloadButton) reloadButton.classList.remove('hidden');
    setSharedSyncStatus('Sync paused — reload required', 'error');
    return;
  }

  if (panel) panel.classList.add('hidden');
  if (importButton) importButton.classList.add('hidden');
  if (reloadButton) reloadButton.classList.add('hidden');
  if (isTeamLead) setSharedSyncStatus('Team Lead · attendance only', 'good');
  else if (!isAdmin) setSharedSyncStatus('Shared data · read-only', 'good');
  else if (pendingSharedWrites) setSharedSyncStatus('Syncing changes…', 'busy');
  else setSharedSyncStatus('Shared data · synced', 'good');
}

async function sharedApiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
    headers.set('X-ProTrack-Request', '1');
  }
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store'
  });
  const body = response.status === 204 || response.status === 304
    ? null
    : await response.json().catch(() => null);
  if (!response.ok && response.status !== 304) {
    const error = new Error(body?.error || `Shared request failed (${response.status}).`);
    error.status = response.status;
    error.isStaticOnlyPreview = response.status === 404 && !String(response.headers.get('Content-Type') || '').toLowerCase().includes('application/json');
    throw error;
  }
  return { body, response };
}

function localDashboardSnapshot() {
  return {
    protrack_records: Array.isArray(records) ? records : [],
    protrack_workers: Array.isArray(workers) ? workers : [],
    protrack_team_logo: typeof teamLogo === 'string' ? teamLogo : '',
    protrack_fleet: Array.isArray(fleetVehicles) ? fleetVehicles : [],
    protrack_updates: Array.isArray(teamUpdates) ? teamUpdates : [],
    protrack_weekend: Array.isArray(weekendSchedule) ? weekendSchedule : []
  };
}

function applySharedState(state) {
  const next = state && typeof state === 'object' ? state : {};
  if (Array.isArray(next.protrack_records)) records = next.protrack_records;
  if (Array.isArray(next.protrack_workers)) workers = next.protrack_workers;
  if (typeof next.protrack_team_logo === 'string') teamLogo = next.protrack_team_logo;
  if (Array.isArray(next.protrack_fleet)) fleetVehicles = next.protrack_fleet;
  if (Array.isArray(next.protrack_updates)) teamUpdates = next.protrack_updates;
  if (Array.isArray(next.protrack_weekend)) weekendSchedule = next.protrack_weekend;

  if (!originalStorageSetItem) originalStorageSetItem = window.localStorage.setItem.bind(window.localStorage);
  for (const key of PROTRACK_SHARED_KEYS) {
    if (!Object.hasOwn(next, key)) continue;
    const value = key === 'protrack_team_logo' ? next[key] : JSON.stringify(next[key]);
    originalStorageSetItem(key, value);
  }
}

function decodeStoredValue(key, rawValue) {
  if (key === 'protrack_team_logo') return String(rawValue || '');
  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function queueSharedWrite(key, value) {
  if (!sharedEditingAllowed()) return;
  const snapshot = key === 'protrack_team_logo'
    ? String(value || '')
    : JSON.parse(JSON.stringify(value));
  pendingSharedWrites += 1;
  updateSharedSyncUI();

  sharedWriteQueue = sharedWriteQueue
    .then(async () => {
      if (sharedWriteBlocked) return;
      const expectedVersion = Number(sharedVersions[key] || 0);
      const { body } = await sharedApiRequest(`/api/state/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: snapshot, version: expectedVersion })
      });
      sharedVersions[key] = Number(body?.version);
      sharedEtag = '';
    })
    .catch(error => {
      sharedWriteBlocked = true;
      console.error('Shared write failed:', error?.status || error?.name || 'network_error');
      updateSharedSyncUI();
      if (typeof showToast === 'function') {
        showToast(error?.status === 409
          ? 'Another device changed shared data. Reload before editing again.'
          : 'The shared save failed. Reload to verify the latest data before editing again.', 'error');
      }
      applyAdminUIState();
    })
    .finally(() => {
      pendingSharedWrites = Math.max(0, pendingSharedWrites - 1);
      updateSharedSyncUI();
    });
}

function installSharedStorageBridge() {
  if (storageBridgeInstalled || !window.Storage || !window.localStorage) return;
  const storagePrototype = window.Storage.prototype;
  const localStorageObject = window.localStorage;
  const nativeSetItem = storagePrototype.setItem;
  const nativeRemoveItem = storagePrototype.removeItem;
  originalStorageSetItem = nativeSetItem.bind(localStorageObject);

  storagePrototype.setItem = function(key, value) {
    nativeSetItem.call(this, key, value);
    const normalizedKey = String(key);
    if (this !== localStorageObject || !PROTRACK_SHARED_KEYS.includes(normalizedKey) || !sharedEditingAllowed()) return;
    const decoded = decodeStoredValue(normalizedKey, String(value));
    if (decoded === null && normalizedKey !== 'protrack_team_logo') {
      sharedWriteBlocked = true;
      updateSharedSyncUI();
      applyAdminUIState();
      return;
    }
    queueSharedWrite(normalizedKey, decoded);
  };

  storagePrototype.removeItem = function(key) {
    nativeRemoveItem.call(this, key);
    const normalizedKey = String(key);
    if (this === localStorageObject && normalizedKey === 'protrack_records') {
      queueSharedWrite(normalizedKey, []);
    }
  };
  storageBridgeInstalled = true;
}

function refreshDashboardViewsFromSharedData() {
  try {
    const workerFilter = document.getElementById('filter-worker');
    const previousWorkerFilter = workerFilter?.value || 'all';
    populateWorkerSelect();
    const updatedWorkerFilter = document.getElementById('filter-worker');
    if (updatedWorkerFilter && [...updatedWorkerFilter.options].some(option => option.value === previousWorkerFilter)) {
      updatedWorkerFilter.value = previousWorkerFilter;
    }
    renderTeamLogo();
    renderDashboard();
    renderTable();
    renderWorkers();
    renderDirectory();
    renderFleet();
    renderUpdates();
    renderWeekendSchedule();
  } catch (error) {
    console.error('Shared dashboard refresh failed:', error?.name || 'unknown_error');
  }
}

async function refreshSharedState({ force = false, apply = true } = {}) {
  const headers = {};
  if (!force && sharedEtag) headers['If-None-Match'] = sharedEtag;
  const { body, response } = await sharedApiRequest('/api/state', { headers });
  if (response.status === 304) {
    sharedApiReady = true;
    updateSharedSyncUI();
    return false;
  }
  if (body?.previewMode === 'local-only') {
    sharedPreviewMode = true;
    sharedApiReady = false;
    sharedDataInitialized = false;
    sharedVersions = Object.create(null);
    sharedEtag = '';
    isAdminMode = false;
    isTeamLeadMode = false;
    currentUserRole = 'worker';
    updateSharedSyncUI();
    return false;
  }
  sharedPreviewMode = false;
  if (!body || typeof body.initialized !== 'boolean') throw new Error('Shared storage returned an invalid state response.');

  sharedApiReady = true;
  sharedDataInitialized = body.initialized;
  sharedVersions = body.versions && typeof body.versions === 'object' ? body.versions : Object.create(null);
  sharedEtag = response.headers.get('ETag') || '';

  if (sharedDataInitialized && apply && !isAdminMode) {
    applySharedState(body.state);
    refreshDashboardViewsFromSharedData();
  }
  updateSharedSyncUI();
  return true;
}

async function initializeSharedData() {
  installSharedStorageBridge();
  const overlay = document.getElementById('shared-loading-overlay');
  setSharedSyncStatus('Connecting to shared storage…', 'busy');
  try {
    await refreshSharedState({ force: true, apply: true });
    if (!sharedPreviewMode) {
      const { body } = await sharedApiRequest('/api/admin/session');
      currentUserRole = body?.authenticated ? (body.role || 'admin') : 'worker';
      isAdminMode = Boolean(body?.authenticated && currentUserRole === 'admin');
      isTeamLeadMode = Boolean(body?.authenticated && currentUserRole === 'team_lead');
      sharedApiReady = true;
    }
  } catch (error) {
    sharedPreviewMode = Boolean(error?.isStaticOnlyPreview);
    sharedApiReady = false;
    sharedDataInitialized = false;
    isAdminMode = false;
    isTeamLeadMode = false;
    currentUserRole = 'worker';
    if (!sharedPreviewMode) {
      console.error('Shared data initialization failed:', error?.status || error?.name || 'network_error');
    }
  } finally {
    if (overlay) overlay.classList.add('hidden');
    updateSharedSyncUI();
  }

  if (!sharedPreviewMode && !sharedPollTimer) {
    sharedPollTimer = window.setInterval(async () => {
      if (isAdminMode || pendingSharedWrites) return;
      try {
        await refreshSharedState({ apply: true });
      } catch (error) {
        sharedApiReady = false;
        console.error('Shared data refresh failed:', error?.status || error?.name || 'network_error');
        updateSharedSyncUI();
      }
    }, 15000);
  }
}

async function roleLogin(passcode, role = 'admin') {
  const endpoint = role === 'team_lead' ? '/api/team-lead/login' : '/api/admin/login';
  const { body } = await sharedApiRequest(endpoint, {
    method: 'POST',
    body: JSON.stringify({ passcode })
  });
  return body;
}

async function adminLogin(passcode) {
  return roleLogin(passcode, 'admin');
}

async function adminLogout() {
  try {
    await sharedWriteQueue.catch(() => {});
    await sharedApiRequest('/api/admin/logout', {
      method: 'POST',
      body: JSON.stringify({})
    });
  } catch (error) {
    console.error('Admin sign-out request failed:', error?.status || error?.name || 'network_error');
  }
}

async function updateSharedAttendance({ workerName, date, status }) {
  if (!sharedAttendanceEditingAllowed()) throw new Error('Attendance editing is not available for this role.');
  if (pendingSharedWrites) throw new Error('Wait for the current shared save to finish before updating attendance.');

  try {
    const { body } = await sharedApiRequest('/api/attendance', {
      method: 'POST',
      body: JSON.stringify({
        workerName,
        date,
        status,
        version: Number(sharedVersions.protrack_records || 0)
      })
    });
    if (!Array.isArray(body?.records) || !Number.isSafeInteger(body?.version)) {
      throw new Error('The attendance service returned an invalid response.');
    }
    sharedVersions.protrack_records = body.version;
    sharedEtag = '';
    applySharedState({ protrack_records: body.records });
    refreshDashboardViewsFromSharedData();
    updateSharedSyncUI();
    return body;
  } catch (error) {
    if (error?.status === 409) {
      sharedWriteBlocked = true;
      updateSharedSyncUI();
      applyAdminUIState();
    }
    throw error;
  }
}

async function migrateLocalDashboardData() {
  if (!isAdminMode || !sharedApiReady || sharedDataInitialized || sharedWriteBlocked) return;
  const accepted = window.confirm(
    'Import the dashboard data saved on this device into the empty shared database? This one-time import makes it visible to anyone with the link and does not overwrite existing shared data.'
  );
  if (!accepted) return;

  const button = document.getElementById('shared-storage-import-button');
  if (button) {
    button.disabled = true;
    button.textContent = 'Importing…';
  }
  try {
    const { body } = await sharedApiRequest('/api/admin/migrate', {
      method: 'POST',
      body: JSON.stringify({ state: localDashboardSnapshot() })
    });
    sharedDataInitialized = Boolean(body?.initialized);
    sharedVersions = body?.versions && typeof body.versions === 'object' ? body.versions : Object.create(null);
    sharedEtag = '';
    if (sharedDataInitialized) {
      await refreshSharedState({ force: true, apply: false });
      applyAdminUIState();
      updateSharedSyncUI();
      showToast('Saved dashboard data is now shared across devices.', 'success');
    }
  } catch (error) {
    if (error?.status === 409) {
      try {
        isAdminMode = false;
        isTeamLeadMode = false;
        currentUserRole = 'worker';
        await refreshSharedState({ force: true, apply: true });
        const session = (await sharedApiRequest('/api/admin/session')).body;
        currentUserRole = session?.authenticated ? (session.role || 'admin') : 'worker';
        isAdminMode = Boolean(session?.authenticated && currentUserRole === 'admin');
        isTeamLeadMode = Boolean(session?.authenticated && currentUserRole === 'team_lead');
        applyAdminUIState();
        showToast('Shared data was initialized on another device. The existing shared copy was kept.', 'error');
      } catch {
        showToast('Shared data was initialized elsewhere. Reload to load the current shared copy.', 'error');
      }
    } else {
      showToast(error?.message || 'Could not import this device’s saved data.', 'error');
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Import this device’s saved data';
    }
    updateSharedSyncUI();
  }
}

function reloadSharedDashboard() {
  window.location.reload();
}

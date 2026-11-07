import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import mysql from 'mysql2/promise';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');
const SESSION_COOKIE = 'protrack_admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const SHARED_STATE_KEYS = Object.freeze([
  'protrack_records',
  'protrack_workers',
  'protrack_team_logo',
  'protrack_fleet',
  'protrack_updates',
  'protrack_weekend'
]);

const STATE_VALUE_TYPES = Object.freeze({
  protrack_records: 'array',
  protrack_workers: 'array',
  protrack_team_logo: 'string',
  protrack_fleet: 'array',
  protrack_updates: 'array',
  protrack_weekend: 'array'
});

const STATE_MAX_ITEMS = Object.freeze({
  protrack_records: 50000,
  protrack_workers: 1000,
  protrack_fleet: 1000,
  protrack_updates: 5000,
  protrack_weekend: 1000
});
const ATTENDANCE_STATUSES = new Set(['Present', 'Absent', 'Rest Day', 'Vacation Leave', 'Sick Leave']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function constantTimeEqual(candidate, expected) {
  const left = Buffer.from(String(candidate));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookieHeader(header, name) {
  if (!header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`;
}

function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;
}

function validateStateValue(key, value) {
  const expected = STATE_VALUE_TYPES[key];
  if (!expected) return 'Unknown shared state key.';
  if (expected === 'array' && !Array.isArray(value)) return 'This shared state value must be an array.';
  if (expected === 'string' && typeof value !== 'string') return 'This shared state value must be text.';
  if (expected === 'array' && value.length > STATE_MAX_ITEMS[key]) return 'This shared state value contains too many items.';
  if (key === 'protrack_team_logo' && value.length > 2_000_000) return 'The team logo is too large.';
  return null;
}

function validateCompleteState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'Shared state must be an object.';
  const keys = Object.keys(state);
  if (keys.length !== SHARED_STATE_KEYS.length || SHARED_STATE_KEYS.some(key => !Object.hasOwn(state, key))) {
    return 'The import must include each supported dashboard data collection.';
  }
  for (const key of SHARED_STATE_KEYS) {
    const error = validateStateValue(key, state[key]);
    if (error) return error;
  }
  return null;
}

function createRateLimiter({ maximum = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return function isRateLimited(identity) {
    const now = Date.now();
    const previous = attempts.get(identity);
    if (!previous || now >= previous.resetAt) {
      attempts.set(identity, { count: 1, resetAt: now + windowMs });
      return false;
    }
    previous.count += 1;
    return previous.count > maximum;
  };
}

export function createMysqlPool(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const url = new URL(databaseUrl);
  if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must use the mysql protocol.');
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!url.hostname || !database) throw new Error('DATABASE_URL is missing its host or database name.');

  return mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: { rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 8,
    queueLimit: 0,
    timezone: 'Z',
    enableKeepAlive: true
  });
}

export function createMysqlRepository(pool) {
  return {
    async migrateSchema() {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS protrack_schema_migrations (
          migration_id VARCHAR(190) NOT NULL PRIMARY KEY,
          applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      const files = (await readdir(MIGRATIONS_DIR))
        .filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
        .sort();

      for (const filename of files) {
        const [applied] = await pool.execute(
          'SELECT migration_id FROM protrack_schema_migrations WHERE migration_id = ?',
          [filename]
        );
        if (applied.length) continue;

        const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
        const statements = sql.split(';').map(statement => statement.trim()).filter(Boolean);
        for (const statement of statements) await pool.query(statement);
        await pool.execute(
          'INSERT IGNORE INTO protrack_schema_migrations (migration_id) VALUES (?)',
          [filename]
        );
      }
    },

    async getStateMetadata() {
      const [metaRows] = await pool.execute(
        'SELECT initialized FROM protrack_app_meta WHERE id = 1'
      );
      const [rows] = await pool.execute(
        'SELECT state_key, version FROM protrack_shared_state ORDER BY state_key'
      );
      const versions = {};
      for (const row of rows) versions[row.state_key] = Number(row.version);
      return { initialized: Boolean(metaRows[0]?.initialized), versions };
    },

    async getState() {
      const metadata = await this.getStateMetadata();
      const [rows] = await pool.execute(
        'SELECT state_key, state_json FROM protrack_shared_state ORDER BY state_key'
      );
      const state = {};
      for (const row of rows) {
        try {
          state[row.state_key] = JSON.parse(row.state_json);
        } catch {
          throw new Error('A stored shared-state value is invalid.');
        }
      }
      return { ...metadata, state };
    },

    async initializeState(state) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [metaRows] = await connection.execute(
          'SELECT initialized FROM protrack_app_meta WHERE id = 1 FOR UPDATE'
        );
        if (!metaRows.length || Boolean(metaRows[0].initialized)) {
          await connection.rollback();
          return { initialized: false };
        }

        for (const key of SHARED_STATE_KEYS) {
          await connection.execute(
            'INSERT INTO protrack_shared_state (state_key, state_json, version) VALUES (?, ?, 1)',
            [key, JSON.stringify(state[key])]
          );
        }
        await connection.execute(
          'UPDATE protrack_app_meta SET initialized = 1 WHERE id = 1'
        );
        await connection.commit();
        return await this.getState();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async updateState(key, value, expectedVersion) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [metaRows] = await connection.execute(
          'SELECT initialized FROM protrack_app_meta WHERE id = 1 FOR UPDATE'
        );
        if (!metaRows.length || !Boolean(metaRows[0].initialized)) {
          await connection.rollback();
          return { reason: 'not_initialized' };
        }

        const [rows] = await connection.execute(
          'SELECT version FROM protrack_shared_state WHERE state_key = ? FOR UPDATE',
          [key]
        );
        const currentVersion = rows.length ? Number(rows[0].version) : 0;
        if (currentVersion !== expectedVersion) {
          await connection.rollback();
          return { reason: 'version_conflict', currentVersion };
        }

        const nextVersion = currentVersion + 1;
        if (currentVersion === 0) {
          await connection.execute(
            'INSERT INTO protrack_shared_state (state_key, state_json, version) VALUES (?, ?, ?)',
            [key, JSON.stringify(value), nextVersion]
          );
        } else {
          await connection.execute(
            'UPDATE protrack_shared_state SET state_json = ?, version = ? WHERE state_key = ? AND version = ?',
            [JSON.stringify(value), nextVersion, key, currentVersion]
          );
        }
        await connection.commit();
        return { version: nextVersion };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async createAdminSession(tokenHash, role = 'admin') {
      await pool.execute(
        'DELETE FROM protrack_admin_sessions WHERE expires_at <= UTC_TIMESTAMP()'
      );
      await pool.execute(
        'INSERT INTO protrack_admin_sessions (token_hash, role, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR))',
        [tokenHash, role]
      );
    },

    async getAdminSessionRole(tokenHash) {
      const [rows] = await pool.execute(
        'SELECT role FROM protrack_admin_sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1',
        [tokenHash]
      );
      return rows[0]?.role || null;
    },

    async hasAdminSession(tokenHash) {
      return Boolean(await this.getAdminSessionRole(tokenHash));
    },

    async deleteAdminSession(tokenHash) {
      await pool.execute(
        'DELETE FROM protrack_admin_sessions WHERE token_hash = ?',
        [tokenHash]
      );
    }
  };
}

export function createApp({ repository, adminPassword, teamLeadPassword, staticRoot = ROOT }) {
  if (!repository) throw new TypeError('A shared-state repository is required.');
  const app = express();
  const isLoginRateLimited = createRateLimiter();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use('/api/admin/login', express.json({ limit: '2kb', strict: true }));
  app.use('/api/team-lead/login', express.json({ limit: '2kb', strict: true }));
  app.use('/api', express.json({ limit: '20mb', strict: true }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    next();
  });

  function requireSameOriginJson(req, res, next) {
    if (req.get('x-protrack-request') !== '1' || !req.is('application/json')) {
      return res.status(403).json({ error: 'This request is not allowed.' });
    }
    next();
  }

  async function requireRoles(req, res, next, allowedRoles) {
    try {
      const token = parseCookieHeader(req.headers.cookie, SESSION_COOKIE);
      if (!token) return res.status(401).json({ error: 'Sign-in is required.' });
      const tokenHash = sha256(token);
      const role = typeof repository.getAdminSessionRole === 'function'
        ? await repository.getAdminSessionRole(tokenHash)
        : (await repository.hasAdminSession(tokenHash) ? 'admin' : null);
      if (!role) {
        res.append('Set-Cookie', expiredSessionCookie());
        return res.status(401).json({ error: 'The session has expired.' });
      }
      if (!allowedRoles.includes(role)) return res.status(403).json({ error: 'Your role does not allow this change.' });
      req.adminTokenHash = tokenHash;
      req.userRole = role;
      next();
    } catch (error) {
      next(error);
    }
  }

  const requireAdmin = (req, res, next) => requireRoles(req, res, next, ['admin']);
  const requireAttendanceEditor = (req, res, next) => requireRoles(req, res, next, ['admin', 'team_lead']);

  app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));

  app.get('/api/state', async (req, res, next) => {
    try {
      const matchingTag = req.get('if-none-match');
      if (matchingTag && typeof repository.getStateMetadata === 'function') {
        const metadata = await repository.getStateMetadata();
        const metadataTag = `"${sha256(JSON.stringify({ initialized: metadata.initialized, versions: metadata.versions }))}"`;
        res.set('ETag', metadataTag);
        if (matchingTag === metadataTag) return res.status(304).end();
      }
      const result = await repository.getState();
      const etag = `"${sha256(JSON.stringify({ initialized: result.initialized, versions: result.versions }))}"`;
      res.set('ETag', etag);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/session', async (req, res, next) => {
    try {
      const token = parseCookieHeader(req.headers.cookie, SESSION_COOKIE);
      const role = token && typeof repository.getAdminSessionRole === 'function'
        ? await repository.getAdminSessionRole(sha256(token))
        : (token && await repository.hasAdminSession(sha256(token)) ? 'admin' : null);
      const authenticated = Boolean(role);
      if (token && !authenticated) res.append('Set-Cookie', expiredSessionCookie());
      res.json({ authenticated, role: role || null });
    } catch (error) {
      next(error);
    }
  });

  function createRoleLoginHandler(expectedPassword, role) {
    return async (req, res, next) => {
      try {
        if (!expectedPassword) {
          if (process.env.NODE_ENV !== 'production') {
            return res.status(503).json({ error: 'Sign-in is unavailable in this local-only Preview.' });
          }
          return res.status(503).json({ error: 'Sign-in is not configured.' });
        }
        const identity = req.ip || req.socket.remoteAddress || 'unknown';
        if (isLoginRateLimited(identity)) {
          return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
        }
        const passcode = req.body?.passcode;
        if (typeof passcode !== 'string' || passcode.length > 1024 || !constantTimeEqual(passcode, expectedPassword)) {
          return res.status(401).json({ error: 'Incorrect passcode.' });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        await repository.createAdminSession(sha256(token), role);
        res.append('Set-Cookie', sessionCookie(token));
        res.json({ authenticated: true, role });
      } catch (error) {
        next(error);
      }
    };
  }

  app.post('/api/admin/login', requireSameOriginJson, createRoleLoginHandler(adminPassword, 'admin'));
  app.post('/api/team-lead/login', requireSameOriginJson, createRoleLoginHandler(teamLeadPassword, 'team_lead'));

  app.post('/api/admin/logout', requireSameOriginJson, async (req, res, next) => {
    try {
      const token = parseCookieHeader(req.headers.cookie, SESSION_COOKIE);
      if (token) await repository.deleteAdminSession(sha256(token));
      res.append('Set-Cookie', expiredSessionCookie());
      res.json({ authenticated: false });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/migrate', requireSameOriginJson, requireAdmin, async (req, res, next) => {
    try {
      const state = req.body?.state;
      const validationError = validateCompleteState(state);
      if (validationError) return res.status(400).json({ error: validationError });
      const result = await repository.initializeState(state);
      if (!result.initialized) {
        return res.status(409).json({ error: 'Shared data is already initialized; this import did not replace it.' });
      }
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/state/:key', requireSameOriginJson, requireAdmin, async (req, res, next) => {
    try {
      const key = req.params.key;
      if (!SHARED_STATE_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown shared data collection.' });
      const value = req.body?.value;
      const validationError = validateStateValue(key, value);
      if (validationError) return res.status(400).json({ error: validationError });
      const expectedVersion = req.body?.version;
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        return res.status(400).json({ error: 'A valid shared-data version is required.' });
      }
      const result = await repository.updateState(key, value, expectedVersion);
      if (result.reason === 'not_initialized') {
        return res.status(409).json({ error: 'Shared storage must be initialized before editing.' });
      }
      if (result.reason === 'version_conflict') {
        return res.status(409).json({ error: 'Shared data changed on another device. Reload before editing again.' });
      }
      res.json({ version: result.version });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/attendance', requireSameOriginJson, requireAttendanceEditor, async (req, res, next) => {
    try {
      const { workerName, date, status } = req.body || {};
      const expectedVersion = req.body?.version;
      if (typeof workerName !== 'string' || !workerName.trim() || workerName.length > 160) {
        return res.status(400).json({ error: 'Choose a valid repair-team member.' });
      }
      const parsedDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? new Date(`${date}T00:00:00.000Z`)
        : null;
      if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        return res.status(400).json({ error: 'Choose a valid attendance date.' });
      }
      if (!ATTENDANCE_STATUSES.has(status)) return res.status(400).json({ error: 'Choose a valid attendance status.' });
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return res.status(400).json({ error: 'A valid attendance-data version is required.' });
      }

      const current = await repository.getState();
      if (!current.initialized) return res.status(409).json({ error: 'Shared storage must be initialized before attendance can be edited.' });
      const repairNames = new Set((current.state.protrack_workers || []).map(worker => worker?.name).filter(Boolean));
      if (!repairNames.has(workerName)) return res.status(403).json({ error: 'Attendance can only be updated for a repair-team member.' });

      const nextRecords = Array.isArray(current.state.protrack_records) ? current.state.protrack_records.map(record => ({ ...record })) : [];
      const matching = nextRecords.filter(record => record.workerName === workerName && record.date === date);
      if (matching.length) {
        matching.forEach(record => {
          record.attendance = status;
          if (req.userRole === 'admin' && status !== 'Present') {
            record.installs = 0;
            record.restored = 0;
            record.totalUnits = 0;
          }
        });
      } else {
        nextRecords.unshift({
          id: `rec_${crypto.randomUUID()}`,
          date,
          workerName,
          attendance: status,
          installs: 0,
          restored: 0,
          totalUnits: 0,
          notes: ''
        });
      }

      const update = await repository.updateState('protrack_records', nextRecords, expectedVersion);
      if (update.reason === 'version_conflict') {
        return res.status(409).json({ error: 'Attendance changed on another device. Reload before trying again.' });
      }
      if (update.reason === 'not_initialized') return res.status(409).json({ error: 'Shared storage must be initialized before attendance can be edited.' });
      const updated = await repository.getState();
      res.json({ records: updated.state.protrack_records, version: updated.versions.protrack_records, role: req.userRole });
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(staticRoot, 'index.html'));
  });
  app.get('/index.html', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(staticRoot, 'index.html'));
  });
  app.get('/shared-sync.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(staticRoot, 'shared-sync.js'));
  });
  app.get('/attendance-report.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(staticRoot, 'attendance-report.js'));
  });
  app.get('/protrack-mark.svg', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('image/svg+xml').sendFile(path.join(staticRoot, 'protrack-mark.svg'));
  });
  app.get('/manus-routes.json', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/json').sendFile(path.join(staticRoot, 'manus-routes.json'));
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    console.error('ProTrack request failed:', error?.code || error?.name || 'unknown_error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'The request could not be completed.' });
  });
  return app;
}

export function createLocalPreviewRepository() {
  return {
    async getStateMetadata() {
      return { initialized: false, versions: {}, previewMode: 'local-only' };
    },
    async getState() {
      return { initialized: false, state: {}, versions: {}, previewMode: 'local-only' };
    },
    async initializeState() {
      return { initialized: false };
    },
    async updateState() {
      return { reason: 'not_initialized' };
    },
    async createAdminSession() {
      throw new Error('Admin sessions are unavailable in local Preview mode.');
    },
    async getAdminSessionRole() {
      return null;
    },
    async hasAdminSession() {
      return false;
    },
    async deleteAdminSession() {}
  };
}

async function startServer() {
  const adminPassword = process.env.PROTRACK_ADMIN_PASSWORD;
  const teamLeadPassword = process.env.PROTRACK_TEAM_LEAD_PASSWORD;
  const hasManagedConfig = Boolean(
    process.env.DATABASE_URL &&
    adminPassword && adminPassword.length >= 12 &&
    teamLeadPassword && teamLeadPassword.length >= 12 &&
    !constantTimeEqual(adminPassword, teamLeadPassword)
  );
  const port = Number(process.env.PORT || 3000);

  if (!hasManagedConfig) {
    if (process.env.NODE_ENV === 'production') {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
      if (!adminPassword || adminPassword.length < 12) throw new Error('PROTRACK_ADMIN_PASSWORD must be configured with at least 12 characters in production.');
      if (!teamLeadPassword || teamLeadPassword.length < 12) throw new Error('PROTRACK_TEAM_LEAD_PASSWORD must be configured with at least 12 characters in production.');
      if (constantTimeEqual(adminPassword, teamLeadPassword)) throw new Error('Admin and Team Lead passcodes must be different.');
    }

    const app = createApp({ repository: createLocalPreviewRepository(), staticRoot: ROOT });
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`ProTrack local-only Preview listening on port ${port}; shared storage and edits are disabled.`);
    });
    process.once('SIGTERM', () => server.close());
    process.once('SIGINT', () => server.close());
    return;
  }

  const pool = createMysqlPool(process.env.DATABASE_URL);
  const repository = createMysqlRepository(pool);
  await repository.migrateSchema();
  await pool.query('SELECT 1');

  const app = createApp({ repository, adminPassword, teamLeadPassword, staticRoot: ROOT });
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`ProTrack server listening on port ${port}.`);
  });

  const close = async () => {
    server.close();
    await pool.end();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  startServer().catch(error => {
    console.error('ProTrack server startup failed:', error?.code || error?.name || 'startup_error');
    process.exit(1);
  });
}

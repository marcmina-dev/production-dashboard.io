# Shared Dashboard Data Plan

## Approved behavior

Anyone with the published link can view the dashboard and shared production data without signing in. Workers and other visitors are read-only. Administrators retain full editing rights. Team Leads use a separate shared Team Lead passcode and can update attendance only; the server must not let them change production quantities, profiles, fleet, or other dashboard data. Team Lead sessions are distinct from administrator sessions, but the shared passcode does not provide individual user identification or an individual audit trail.

The managed database becomes authoritative after initialization. A one-time admin-confirmed migration imports the current browser’s saved state only when shared storage is empty; it cannot overwrite an already populated shared database. Existing browser data remains available until the admin chooses to import it. Development and the published application use the same managed database once configured, so feature work must not insert or delete sample production rows.

## Implementation approach

Enable the platform-managed server and MySQL database. Run additive schema migrations for shared-state versions and role-bearing sessions. Provide a same-origin Node API: anonymous state reads; separate admin and Team Lead passcode login/logout and session inspection; an admin-only, empty-database migration endpoint; admin-only per-key updates guarded by optimistic versions; and an attendance-only endpoint available to admins and Team Leads. Store both passcodes as server-only protected secrets. Use opaque, database-backed, expiring HttpOnly session cookies with `SameSite=None; Secure` for the cross-site HTTPS Preview context.

Retain the existing `protrack_*` localStorage representation as a device cache and migration source. Load shared values before first rendering on each device. Route full dashboard edits through the server; restrict Team Lead writes to a validated person/date/status update that preserves all non-attendance production fields. Synchronize production logs, worker profiles/photos, logo, fleet, updates, and weekend schedule. Keep installation-team log names and historical rows intact; continue excluding them from Personnel & Duty Days, its summary, and the attendance chart.

Add a month selector and per-person monthly attendance table to Personnel & Duty Days. Count each person/date once; Present counts as Duty Days, while Absent, Rest Day, Vacation Leave, and Sick Leave remain separate status totals. Provide a CSV download of the selected month’s table. The month selector is independent of the shared daily filter.

When the project is running in a non-production Preview without managed database or admin credentials, start a read-only local-preview API adapter that returns an explicit `local-only` mode at `/api/state`, keeps each browser’s existing localStorage view, disables sign-in and edits, and avoids 404 errors. Do not initialize or write to the managed database in this mode. A production container must fail closed when required database or passcode credentials are missing; it must never silently use the local adapter.

Keep the static frontend build output and add a hybrid container deployment. The frontend output contains `index.html`, `shared-sync.js`, `attendance-report.js`, the route manifest, and the logo. Published `/api/*` and health requests go to the Node server; the static catch-all serves the frontend. The server’s health endpoint is unauthenticated and does not expose database details.

## Project structure

- `index.html` — existing dashboard UI, role selection, monthly report table, CSV export, sync status, and import affordances.
- `shared-sync.js` — browser API client, cloud hydration, role-specific sessions, one-time migration, queued admin writes, Team Lead attendance requests, and conflict/status reporting.
- `server.js` — HTTP routes, input validation, role authorization, admin passcode/session handling, attendance-only updates, static assets, managed database adapter, and read-only local-preview adapter.
- `db/migrations/001_shared_state.sql` and `002_session_roles.sql` — additive schema for versioned shared state, expiring role-bearing sessions, and future-compatible role migration.
- `tests/server.test.js`, `tests/shared-sync.test.js`, and `tests/attendance-report.test.js` — isolated API authorization, monthly report aggregation, CSV safety, migration/versioning, hydration, and browser-write tests that do not write to the managed database.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` — pinned Node toolchain/dependencies and reviewed install-script policy.
- `Dockerfile` — production container install, committed frontend assets, health route, and `PORT`-aware server entrypoint.
- `README.md`, `TODO.md`, `plan.md` — operator instructions, required outcomes, and this architecture.

## Constraints

The shared database is project-scoped and used by development and production; do not use it for disposable test writes or destructive reset operations. Public reads are intentional per the user’s choice, while every data mutation is enforced again by the server. A public release is complete only after the static build, container health, anonymous reads, role-isolation checks, Team Lead attendance-only writes, one-time migration guard, monthly CSV generation, checkpoint, and successful publish have been verified. The original browser’s localStorage is not accessible to the cloud workspace, so after deployment the admin must open the original device and approve the one-time import to make its existing dataset visible to other phones.

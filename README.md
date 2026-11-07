# ProTrack Production Dashboard

The editable dashboard is `index.html`; `shared-sync.js` handles browser-to-server sync, `attendance-report.js` builds the monthly report and CSV, and `server.js` serves the API. The original dark ProTrack dashboard remains in place, including Personnel Info photo upload, crop, and resize.

## Roles and access

Anyone with the published link can view the shared dashboard, production logs, repair-team profiles and photos, and attendance reports without signing in. Workers and other visitors are read-only. Administrators can make all dashboard changes. Team Leads sign in with a separate shared Team Lead passcode and can change attendance status only; the server rejects their attempts to edit production quantities, profiles/photos, fleet, or other dashboard data. Team Lead attendance updates preserve all existing production fields. The shared Team Lead passcode does not identify individual users or provide an individual audit trail.

Set distinct, server-only `PROTRACK_ADMIN_PASSWORD` and `PROTRACK_TEAM_LEAD_PASSWORD` values (at least 12 characters each) through protected project secret input. Never put either value in browser code or commit it. Sessions use an HttpOnly, Secure, SameSite=None cookie for HTTPS Preview and published access. The project also requires the managed MySQL `DATABASE_URL` for cross-device storage.

## Monthly attendance report

In Personnel & Duty Days, choose a month to view one row per repair-team member with Present/duty days, Absent, Rest Day, Vacation Leave, and Sick Leave totals. Counts use one status per person/date. Only Present records count as Duty Days. The report can be downloaded as a CSV for the selected month; it remains read-only for workers and visitors.

## Shared data and first-time import

Once configured, managed MySQL is the shared source of truth across phones and computers. Public browsers load the same production logs, profiles/photos, dashboard data, and attendance records. The existing `protrack_*` browser-local values remain as a device cache. The public page polls for shared changes every 15 seconds and refreshes when reopened.

The cloud database starts empty. On the phone or computer that still has the old dashboard data in its browser, open the published link, sign in as Administrator, choose **Import this device’s saved data**, and confirm. The one-time import is accepted only while shared storage is empty; it cannot replace an initialized shared dataset. After it succeeds, open the same link on other devices to see that data. The cloud workspace cannot read another device’s browser storage for you.

## Development and checks

Development and publication use the same managed database, so do not use it for sample-data writes or destructive checks. Database migrations are additive and tracked by the server’s migration ledger. API tests use an in-memory repository; browser sync and monthly-report tests are isolated.

Install from the committed lockfile with `pnpm install --frozen-lockfile`, start with `pnpm dev`, and run checks with `pnpm check` and `pnpm test`. The static frontend build must copy `index.html`, `shared-sync.js`, `attendance-report.js`, `manus-routes.json`, and `protrack-mark.svg` into `dist/`; the Dockerfile serves the API and health endpoint for the hybrid deployment.

If managed MySQL or either role credential is unavailable in a non-production Preview, `pnpm dev` serves a read-only local-preview API rather than returning 404 for `/api/state`. It preserves this browser’s saved copy and labels it local-only; sign-in, edits, and cross-device sync are disabled. Production fails closed if required database or role credentials are missing.

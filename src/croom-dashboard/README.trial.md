# Management dashboard trial

This packages the existing React/Express/PostgreSQL dashboard for a single
management API process. Use the companion `croom.trial_management` agent, not
upstream's incompatible DashboardClient. The Kubernetes preparation PR routes
browser/API requests through Authelia and grants only the enrollment and `/ws`
machine paths direct access to application authentication.

## Scope

The trial supports device enrollment, Online/Offline status, system metrics,
Read Device Status and room name/location/timezone configuration. Configuration
returns success only after the device acknowledges durable application.
Unsupported reboot/update/delete actions are omitted or return an explicit error.
Meeting/calendar/AI integrations remain outside this trial.

Device keys and one-use enrollment tokens are stored as SHA-256 hashes in the
server database. Tokens expire within 24 hours by default (maximum 7 days).
Enrollment is transactional. Device messages are bound to the authenticated
WebSocket; a caller-supplied device ID cannot select another device's records.
WebSocket authentication must complete within 10 seconds. Disconnections and
server restarts clear Online status. Connections time out after 90 seconds
without authenticated activity.

## Build and test

Use Node 22:

```sh
cd src/croom-dashboard/backend
npm ci
npm run build
# Point DB_* at a DISPOSABLE PostgreSQL database whose name ends in _test.
# Tests drop/recreate its tables; they refuse any other database name.
npm test
cd ../frontend
npm ci
npm run build
```

Both components include lockfiles and Dockerfiles. The frontend includes its
TypeScript and PostCSS configuration. Its Nginx server serves the SPA on 8080;
the API listens on 3001. Route `/api` and `/ws` to the API separately.

## Bootstrap a fresh database

Set `DB_HOST`, `DB_PORT` (default 5432), `DB_NAME`, `DB_USER` and `DB_PASSWORD`.
Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (16–72 bytes), then run
`node dist/bootstrap.js` using the backend image/build. This creates missing
tables without `alter` or `force` and creates one administrator if absent. It
never rotates an existing administrator's password or promotes another role.

This is initial schema creation for a fresh trial database, not an upgrade
migration for an existing dashboard. Preserve the database/PVC; future schema
changes require reviewed migrations.

Start the API with a generated `JWT_SECRET` of at least 32 characters. It fails
startup without one. Set `BASE_URL` and `CORS_ORIGIN` to the dashboard HTTPS
origin. The server never synchronizes schema at startup. Bootstrap credentials
belong only to the one-time/init bootstrap process, not the running API.

Administrator registration now requires an existing administrator's bearer
token. Login produces a 24-hour JWT; middleware rechecks the current user's role
and existence in the database. Passwords use bcrypt. Administrator browser
access is additionally protected by the deployment's existing Authelia policy.

## Publish after merge

The `Dashboard trial` workflow validates backend integration tests and the
frontend build. On main pushes or manual dispatch in the Inflection fork it
publishes AMD64/ARM64 images to:

- `ghcr.io/inflection-space-systems/croom-dashboard-backend:sha-<source-SHA>`
- `ghcr.io/inflection-space-systems/croom-dashboard-frontend:sha-<source-SHA>`

Enable GitHub Actions on the fork if disabled. The workflow publishes only in
`Inflection-Space-Systems/croom.to`; upstream PR builds do not publish packages.
Check both images exist before activating the Kubernetes overlay. One API replica
is required because connection and pending-command state belongs to that process.

## Known trial limits

Metrics have no retention worker yet; monitor database volume usage during the
small trial. API restarts temporarily disconnect agents, which reconnect with
persisted keys. Delivery/database failures can leave a configuration result
uncertain even when the device applied it; read status and reapply the intended
room values. There are no arbitrary shell commands or automatic device updates.

# Active Together

A dependency-free Node.js MVP for time-based team activity challenges.

## Included
- Global admin, team admin and member roles
- User creation and role management
- Team creation and email-specific invite links
- Time-based challenges and manual activity logging
- Team leaderboard and recent activity
- SQLite persistence, password hashing, HTTP-only sessions and duplicate-safe health imports
- Integration contract for Android Health Connect and Apple HealthKit companion apps

## Run with Docker
1. Change `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `APP_ORIGIN` in `compose.yaml`.
2. Run: `docker compose up -d --build`
3. Open `http://localhost:3000`

## Run directly
Requires Node.js 22 or newer:

```bash
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='ChangeMe123!' node server.js
```

## Health integration boundary
Health Connect and HealthKit are device-local native APIs. A normal website cannot read them directly. Build a small Android/iOS companion app that:
1. Requests explicit permission for exercise/workout records only.
2. Reads completed sessions and converts duration to whole minutes.
3. POSTs records to `/api/health/import` while the user is authenticated.
4. Supplies a stable `source_ref` so repeated synchronisation remains idempotent.

Example body:
```json
{"source":"health_connect","records":[{"team_id":1,"challenge_id":1,"activity_type":"Walking","minutes":42,"activity_date":"2026-09-01","source_ref":"device-record-id"}]}
```

## Production checklist
- Put behind HTTPS and a reverse proxy.
- Replace local accounts with approved enterprise SSO if deployed at Company.
- Add CSRF protection, rate limiting, email delivery, password reset and audit logs.
- Complete privacy impact, retention, consent and app-store health-data declarations.
- Do not collect medical records, routes, heart rate or other health data when activity duration is sufficient.

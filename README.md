# Active Together

A dependency-free Node.js MVP for time-based team activity challenges.

## Included
- Self-service registration and sign-in — anyone can create an account, no admin needed
- Anyone can create a challenge or a team; the creator becomes its owner/team admin
- **Challenges and teams are private by default.** They never appear to anyone who hasn't joined —
  joining requires either a challenge/team invite code or an emailed invite link
- One shared invite-code box handles both cases: a challenge code joins the challenge (pick a team
  once inside, or create one); a team code joins that team and its parent challenge in one step
- Per-challenge leaderboards, both by team and by individual member
- Time-based challenges and manual activity logging
- SQLite persistence, password hashing, HTTP-only sessions and duplicate-safe health imports
- Native Android (Health Connect) and iOS (HealthKit) companion apps that sync workout minutes in

## How the data model fits together

A **Challenge** is the top-level container (e.g. "September Step Challenge"), created by any
signed-in user, who becomes its `owner`. A challenge has an `invite_code`. Anyone who joins becomes
a `member`.

A **Team** always belongs to exactly one challenge. Any challenge member can create a team (becoming
its `team_admin`) or self-join any existing team in a challenge they're already in — no separate code
needed for that, since challenge membership is the gate. A team also has its own `invite_code` for
inviting someone straight into that team (which grants challenge membership too, in one step).

Visibility is enforced server-side via `challenge_members`/`team_members` join tables — every read
endpoint checks membership, not just the UI.

## Run with Docker
1. Copy `.env.example` to `.env` and set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `APP_ORIGIN`
   (the admin account is only a seeded fallback — everyone else registers themselves).
2. Run: `docker compose up -d --build`
3. Open `http://localhost:3000`

## Run directly
Requires Node.js 22 or newer:

```bash
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='ChangeMe123!' node server.js
```

On Windows, you can also run the local helper. It uses Node.js from `PATH` when available; otherwise it downloads a portable Node.js 24 runtime into `.tools/`.

```powershell
.\start-local.ps1
```

Then open `http://localhost:3000` and either create your own account, or sign in as the seeded
fallback admin:

- Email: `admin@example.com`
- Password: `ChangeMe123!`

## Test in GitHub Enterprise
GitHub-hosted runners are disabled for this repository, so the included GitHub Actions workflow targets a self-hosted runner.

1. Add a repository, organization or enterprise self-hosted runner with the `self-hosted` label.
2. Re-run the `Test` workflow from the Actions tab.
3. The workflow installs Node.js 24, runs `npm test`, and builds the Docker image when Docker is available on the runner.

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

## Android companion app
An Android Health Connect companion MVP is included in [companion/android](companion/android). It signs in to this server, requests exercise-session permission from Health Connect, reads the last 30 days of exercise sessions, converts durations to whole minutes, and uploads them to `/api/health/import`. It only syncs into a challenge/team you already belong to — join and create those in the web app first.

For emulator testing with the local server, use `http://10.0.2.2:3000` as the server URL in the companion app.

## iOS companion app
An iOS HealthKit companion MVP with the same behaviour is included in [companion/ios](companion/ios), as Swift source plus setup instructions (it ships without an `.xcodeproj` — see that folder's README for why, and the two-minute Xcode setup).

## Production checklist
- Put behind HTTPS and a reverse proxy.
- Replace local accounts with approved enterprise SSO if deployed at Company.
- Add CSRF protection, rate limiting, email delivery, password reset and audit logs.
- Complete privacy impact, retention, consent and app-store health-data declarations.
- Do not collect medical records, routes, heart rate or other health data when activity duration is sufficient.

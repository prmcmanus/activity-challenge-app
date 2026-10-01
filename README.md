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
- Team admins/challenge owners can rename or delete a team, add an existing user to it directly by
  email, or remove someone from it
- Everyone can edit their own name/email/password (via My account); a global admin can edit any
  user's fields, including a password reset. Either kind of password change signs out that user's
  other sessions.
- Anyone can edit or delete an activity entry they logged themselves, with an optional start/finish
  time (auto-filling minutes) alongside the required date and duration
- The challenge owner (or a global admin) can edit a challenge's name, dates and description — the
  description supports rich text (bold/italic/lists/links/images), sanitized server-side
- A team can have an optional logo image, set at creation or changed later; a user can have an
  optional avatar, both shown next to the name in team lists and leaderboards
- Activity entries support an optional free-text comment
- A challenge owner (or global admin) can promote another member to co-owner, and export either
  leaderboard as CSV
- A [privacy policy](public/privacy.html) is linked from the registration page and every page's
  footer. **A challenge and everything scoped to it is automatically deleted 60 days after its end
  date**, on a daily schedule — see that page for the full retention policy
- Challenges measure either active minutes or distance (miles or km), chosen when the challenge is
  created and changeable later; manual activity logging asks for whichever the challenge measures
- A challenge is played in teams or by individuals only (no teams: everyone logs straight to the
  challenge and there is one leaderboard); switchable later by the owner
- The challenge owner (or a global admin) can delete a challenge, with all its teams and activity,
  after typing its name to confirm
- SQLite persistence, password hashing, HTTP-only sessions and duplicate-safe health imports
- Native Android (Health Connect) and iOS (HealthKit) companion apps that sync workout minutes and distance in
- Optional reCAPTCHA on registration/sign-in, plus per-IP rate limiting everywhere, against bots

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
1. Requests explicit permission for exercise/workout records, and optionally the distance recorded during them.
2. Reads completed sessions and converts duration to whole minutes and distance to metres (`distance_m`, omitted when none was recorded).
3. POSTs records to `/api/health/import` while the user is authenticated.
4. Supplies a stable `source_ref` so repeated synchronisation remains idempotent.

A record must carry the challenge's own measure: in a distance challenge a session with no
`distance_m` (yoga, say) is skipped and counted in `skipped`; in a minutes challenge `minutes` is
required and `distance_m` is optional extra detail.

Example body:
```json
{"source":"health_connect","records":[{"team_id":1,"challenge_id":1,"activity_type":"Walking","minutes":42,"distance_m":3540,"activity_date":"2026-09-01","source_ref":"device-record-id","start_time":"07:00","end_time":"07:42"}]}
```

## Android companion app
An Android Health Connect companion MVP is included in [companion/android](companion/android). It signs in to this server, requests exercise-session permission from Health Connect, reads the last 30 days of exercise sessions, converts durations to whole minutes and adds the distance recorded during each one, and uploads them to `/api/health/import`. It only syncs into a challenge/team you already belong to — join and create those in the web app first.

The companion talks to `https://activetogether.team` only (`SERVER_URL` in `MainActivity.kt`); see its README for pointing it at a local server while testing.

## iOS companion app
An iOS HealthKit companion MVP with the same behaviour is included in [companion/ios](companion/ios), as Swift source plus setup instructions (it ships without an `.xcodeproj` — see that folder's README for why, and the two-minute Xcode setup).

## Uploaded images (avatars, team logos, description images)

One endpoint, `POST /api/uploads`, backs all three. The client resizes the image with a `<canvas>`
before sending it (avatars to 320px, team logos to 400px, description images to 900px, all
re-encoded as JPEG) — no image library needed server-side, so this stays dependency-free. The
server still enforces a hard 10MB cap on the decoded payload regardless of what the client did.

It never trusts the client's claimed mime type: it sniffs the actual magic bytes (PNG/JPEG/GIF/
WEBP) and names the file itself (`<32 hex chars>.<sniffed extension>`), so neither the extension
nor the content-type served back can be influenced by the uploader. `image_url`/`avatarUrl` fields
elsewhere in the API are validated against that exact naming pattern — a hand-crafted request
pointing a team logo at an external URL is rejected, not silently accepted.

Uploaded files live under `DATA_DIR/uploads/`, not `public/` — the latter is baked into the Docker
image and wiped on every rebuild, so anything meant to survive a deploy has to be on the volume.
`GET /uploads/*` streams them back with a one-year immutable cache header (filenames are random,
never reused) and `X-Content-Type-Options: nosniff`.

**Known gap:** deleting a challenge, team, or clearing an avatar doesn't delete the underlying
uploaded file — there's no reference-counting cleanup. Orphaned files accumulate in `uploads/`
over time. Documented here and in the privacy policy rather than silently ignored.

## Rich text challenge descriptions

Descriptions support a small set of formatting (bold/italic/lists/links/images) via a
`contenteditable` toolbar (`document.execCommand` — deprecated but still functional everywhere,
and the only no-dependency way to build this). What actually makes it safe is server-side: every
write path (`POST`/`PATCH /api/challenges`) runs the HTML through `sanitizeHtml()` in `server.js`
before it ever reaches the database, and the client trusts stored `description` values as already
clean and renders them with `innerHTML` directly — it does **not** re-sanitize on read, so the
server-side pass on every write path is the entire security boundary. That matters because the API
is a public HTTP interface: a direct `curl` to `POST /api/challenges` skips the browser (and any
client-side sanitizer) entirely.

`sanitizeHtml()` is a hand-rolled allowlist tokenizer, not a battle-tested library like DOMPurify —
consistent with this app staying dependency-free, but worth being honest about: it's a streaming
scan (never a find/replace over the whole string), and any tag not on the allowlist is dropped
while its own text content survives as inert, escaped text — which is what neutralises
`<script>alert(1)</script>` into the harmless text `alert(1)`. No tag, allowed or not, may ever
carry a `style` or `on*` attribute (neither appears in the attribute allowlist for anything, so
they're stripped unconditionally rather than pattern-matched), and `href`/`src` are restricted to
`https:`/`mailto:` and `https:`/`/uploads/` respectively — a `javascript:` URL never survives.
It hasn't been fuzzed against the kind of parser-differential bypasses that real sanitizer
libraries are hardened against, so treat it as solid for this app's threat model (a small,
trusted user base) rather than as a guarantee against a determined, sophisticated attacker.

## Data retention

Per the [privacy policy](public/privacy.html): a challenge, and everything scoped to it (teams,
memberships, activity entries), is deleted 60 days after its `end_date`. `purgeExpiredChallenges()`
in `server.js` runs once at boot and then every 24 hours. Activities have no `ON DELETE CASCADE` on
`challenge_id` (unlike `challenge_members`/`team_members`, which do), so they're deleted explicitly
first, inside the same transaction — same pattern as the existing team-delete endpoint. This is not
configurable via an environment variable; changing the window means changing the `-60 days` literal
in that function (and updating the privacy policy to match).

## Bot and abuse precautions

- **reCAPTCHA v2** ("I'm not a robot") on the registration and sign-in *pages*. Optional — unset
  `RECAPTCHA_SITE_KEY`/`RECAPTCHA_SECRET_KEY` (the default) disables it everywhere with no code
  change, which is what local dev and the automated tests rely on. Get a key pair at
  [google.com/recaptcha/admin](https://www.google.com/recaptcha/admin) for your real domain, put
  them in the server's `.env`, and `docker compose up -d --build` to pick them up. `GET /api/config`
  tells the frontend whether a widget should render, so nothing needs rebuilding client-side either.
- The **Android/iOS companion apps sign in through a separate endpoint**, `/api/mobile/login`, not
  the recaptcha-gated `/api/login` — there's no page there to render a widget in. It relies on the
  rate limit below instead.
- **Per-IP rate limiting**, in-memory, no dependency: `register` and `login` (and `/api/mobile/login`)
  each get their own bucket, default 20 attempts per 15 minutes per IP
  (`AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_MS`); `POST /api/uploads` gets its own, default 30
  per 15 minutes (`UPLOAD_RATE_LIMIT_MAX`/`UPLOAD_RATE_LIMIT_WINDOW_MS`); all on top of a general
  ceiling across every `/api/` route, default 300 requests/minute/IP
  (`API_RATE_LIMIT_MAX`/`API_RATE_LIMIT_WINDOW_MS`). All six are overridable in `.env`. Counters
  reset on container restart — an acceptable escape hatch at this scale, same tradeoff ITCM's
  login lockout makes.
- Order of checks matters for cost: the rate limit (cheap) runs before reCAPTCHA verification
  (a network call), which runs before password hashing (deliberately CPU-expensive, `scrypt`) —
  so a scripted flood gets turned away before it can burn CPU or hit Google's API.
- Client IP is read from `CF-Connecting-IP` first (this deployment sits behind a Cloudflare Tunnel),
  falling back to `X-Forwarded-For` then the raw socket address.

## Production checklist
- Put behind HTTPS and a reverse proxy.
- Replace local accounts with approved enterprise SSO if deployed at Company.
- Add CSRF protection, email delivery, password reset and audit logs.
- A plain-language [privacy policy](public/privacy.html) exists and states the 60-day challenge
  retention window, which is enforced in code. A formal DPIA, consent-capture flow, and the
  app-store health-data declarations the companion apps would need for a real store listing are
  still outside this project's scope.
- Do not collect medical records, routes, heart rate or other health data when activity duration is sufficient.
- Orphaned uploaded images (see "Uploaded images" above) are not garbage collected.

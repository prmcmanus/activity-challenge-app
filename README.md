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
- One activity can count in several challenges at once (the Android app logs and syncs into every
  challenge a workout fits); each challenge gets its own entry
- Optional GPS routes: upload a GPX file with an activity on the web, or switch on routes in the
  Android app. Routes are stored once per workout, shown on an OpenStreetMap map under My activity,
  and visible only to their owner
- My activity on the home page lists everything you've logged across every challenge
- Anyone can leave a team (what they logged stays on its total) or a whole challenge (their entries
  in it are deleted; the last owner has to hand over or delete the challenge instead)
- Following: follow a challenge-mate from their profile. Profiles show follower and following counts
  and lists, naming only people the viewer shares a challenge with (counts only on a private profile)
- Profiles: challenge-mates can open each other's profile (name, photo, an "about me" line) from the
  leaderboard, on the web as well as in the apps. Each
  person chooses what else it shows - Private, Totals (default) or Full (recent activity) - and only
  for challenges they share; routes never appear
- Help & support (web header and app): quick answers, plus tickets - bug reports, feature requests
  and questions with an optional screenshot. Users follow their own tickets and replies (with a
  "new reply" badge); global admins get a support dashboard (counts, status/type filters), reply,
  add internal notes and set status (New, In progress, Planned, Done, Declined) and the outcome
- SQLite persistence, password hashing, HTTP-only sessions and duplicate-safe health imports
- Native Android (Health Connect) and iOS (HealthKit) companion apps that sync workout minutes and distance in.
  Fitbit, Garmin and other watches come through the phone's health store (see public/sync.html)
- Virtual journeys: a challenge whose teams or people travel a route on a map (say London to Edinburgh),
  picked by place search or by tapping the map, along roads (OSRM foot/bike routing) or as a straight
  line. Measured in miles, km or steps (an average 0.762 m stride); on foot (rides don't count) or
  cycling (only rides count). Leaderboards add progress and finishing days; a journey map shows each
  team's logo or person's photo at their virtual position, on the web and in both apps
- Apple Shortcuts sync for iPhone with no app install: a personal sync key (stored hashed) lets a
  shortcut POST a day's steps, exercise minutes, walking distance and cycling distance to `/api/shortcut/day`; resending a day
  updates it. Setup for users: /sync.html; building the shared shortcut: /shortcut-build.html
- Optional reCAPTCHA on registration/sign-in, plus per-IP rate limiting everywhere, against bots
- Invite only (optional, for global admins on the Admin page): new accounts then need a challenge or
  team invite code, or an emailed invite. Invite links pass the code along automatically, including
  the apps' "Create an account" links
- Backups: Litestream keeps 7 days of database history in R2; a daily job (tools/standby/prune.sh)
  deletes pre-update copies, switch-over leftovers and old backup sets after 30 days

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

Once a day (`sweepUploads()` in `server.js`), files nothing refers to any more - an old avatar, a
deleted account's photo, a purged challenge's pictures, a ticket screenshot whose ticket is gone - are
deleted, a day after they were uploaded so an image added to a form that hasn't been saved yet survives.
`files-sync` mirrors the folder to R2 with `rclone sync`, which moves deleted files to
`<epoch>/deleted/<date>`; `tools/standby/prune.sh` empties those after 30 days.

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
`https:`/`mailto:` and this site's own `/uploads/` files respectively — a `javascript:` URL never
survives, and a picture from another site (which would tell that site who opened the challenge) is
dropped.
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

- **A bot check** on the registration, sign-in and forgotten-password *pages*: **Cloudflare
  Turnstile** (usually invisible) when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set, else
  **reCAPTCHA v2** when `RECAPTCHA_SITE_KEY`/`RECAPTCHA_SECRET_KEY` are, else none (local dev and the
  automated tests). For Turnstile: Cloudflare dashboard → Turnstile → Add widget, hostname
  `activetogether.team`, mode Managed; put the two keys in the server's `.env` and
  `docker compose --profile primary up -d`. `GET /api/config` tells the page which one to show.
- The **Android/iOS companion apps sign in through a separate endpoint**, `/api/mobile/login`, not
  the recaptcha-gated `/api/login` — there's no page there to render a widget in. It relies on the
  rate limit below instead.
- **Rate limiting**, in-memory, no dependency. Signing in counts attempts per network *and email*
  (`AUTH_RATE_LIMIT_MAX`, default 20 per 15 minutes), with a network as a whole allowed five times
  that, so an office behind one address can all sign in; registration allows three times the per-network
  limit (`REGISTER_RATE_LIMIT_MAX`); `POST /api/uploads` has its own (`UPLOAD_RATE_LIMIT_MAX`, default
  30 per 15 minutes). Every `/api/` request also counts: per signed-in person (`API_RATE_LIMIT_MAX`,
  default 300 a minute) with ten times that per network (`API_NETWORK_RATE_LIMIT_MAX`), or per network
  when signed out. Counters reset on restart - an acceptable escape hatch at this scale.
- Order of checks matters for cost: the rate limit (cheap) runs before reCAPTCHA verification
  (a network call), which runs before password hashing (deliberately CPU-expensive, `scrypt`) —
  so a scripted flood gets turned away before it can burn CPU or hit Google's API.
- Client IP is read from `CF-Connecting-IP` first (this deployment sits behind a Cloudflare Tunnel),
  falling back to `X-Forwarded-For` then the raw socket address.

## Standby machine and failover

Two machines can share the job: one is live (the "primary"), the other is a standby that can take
over in about a minute. Only one is ever live - SQLite and the local uploads folder can't be shared
by two running copies, so this is failover, not load balancing.

- **Litestream** streams every database change to a Cloudflare R2 bucket within a second, keeping a
  week of point-in-time history. The app runs SQLite in WAL mode for this.
- **files-sync** (rclone) copies `/data/uploads` and `/data/downloads` to the same bucket every
  minute, and once more when it stops.
- **tunnel** runs `cloudflared` for a tunnel dedicated to this app, so whichever machine is live
  serves the site. Don't reuse a tunnel that also carries other hostnames.
- An object called `primary` in the bucket names the live machine's *epoch*
  (`<HOST_ID>-<UTC time it took over>`), and each epoch replicates under its own prefix, so a
  machine that comes back after a failover can never overwrite the live copy. A systemd timer on
  each machine (`tools/standby/guard.sh`) stops the stack there within a minute if R2 says another
  machine is live.

These services sit in the `primary` compose profile, so `docker compose up` on its own (local dev,
the test instance) still runs just the app. On the live machine, deploy with
`docker compose --profile primary up -d --build`.

| Task | Run on | Command |
| --- | --- | --- |
| First-time setup, on the machine holding the live data | that machine | `tools/standby/takeover.sh --init` |
| Install the guard timer (once per machine) | each machine | `tools/standby/install-guard.sh` |
| Fail over, or fail back | the machine that should go live | `tools/standby/takeover.sh` |
| ...when the live machine is unreachable | the machine that should go live | `tools/standby/takeover.sh --force` |

`takeover.sh` stops the other machine over SSH (`PEER_SSH`), claims the marker, puts its own stale
copy aside in `/data/pre-takeover-<time>/`, restores the database and files from the old epoch,
starts the stack and keeps the three newest epochs in R2. With `--force`, anything written on the
unreachable machine since its last sync is lost (normally under a second of database changes and a
minute of uploads).

## Email

Password reset links, "you've been added to a challenge" notes and support ticket news go out through
[Resend](https://resend.com)'s HTTP API when `RESEND_API_KEY` is set (`MAIL_FROM` must be on a domain
verified in Resend; replies go to `MAIL_REPLY_TO`, default support@activetogether.team). Without a key
nothing is emailed, and a global admin makes reset links instead (Admin → Edit user). Each person can
turn the notes off in My account. A password reset emails one account at most twice an hour.

## Sign in with Google and Apple

The website (Google and Apple), the Android app (Google) and the iPhone app (Google, and Apple in the App Store
build, which Apple requires alongside Google) sign in with the provider and send its ID token to
`POST /api/auth/google|apple` (`/api/mobile/auth/...` for the apps). The server checks the token against the
provider's published keys and our client IDs. A known Google/Apple account signs in; otherwise an account using
the same, provider-verified email is linked (and its other sessions are ended); otherwise a new account is made,
with no password (the invite code is asked for on an invite-only site). Two-step sign-in still applies. Settings:
`GOOGLE_WEB_CLIENT_ID` (website and Android), `GOOGLE_IOS_CLIENT_ID`, `APPLE_SERVICES_ID` (website); the iPhone
app's bundle ID is accepted for Apple. Nothing shows until they're set; the apps read them from `/api/config`.

## Two-step sign-in

Anyone can turn on authenticator-app codes (TOTP, RFC 6238) in My account; global admins are prompted
to. It gives ten one-time backup codes. A global admin can turn it off for someone who has lost their
phone (Admin → Edit user). If the **only** admin is locked out: set `CLEAR_TWO_FACTOR_FOR=their@email`
in `.env`, `docker compose --profile primary up -d`, sign in, then remove the setting and restart again.

## Activity log

What global admins and challenge owners do to other people's accounts and entries (adding and removing
people, deleting entries or accounts, password resets, role changes, two-step sign-in switched off) is
recorded in the `audit_log` table, readable by global admins under Admin → Activity log, kept a year.

## Health check

`GET /api/health` answers when the app is up and its database reads; `compose.yaml` checks it every 30
seconds, and `tools/standby/guard.sh` (every minute) restarts an app that has stopped answering. On
`SIGTERM` the server stops taking connections, lets requests in progress finish (up to 10 seconds) and
closes the database cleanly.

## Production checklist
- Put behind HTTPS and a reverse proxy.
- Replace local accounts with approved enterprise SSO if deployed at Company.
- CSRF: session cookies are `SameSite=Strict` and every write takes JSON.
- A plain-language [privacy policy](public/privacy.html) exists and states the 60-day challenge
  retention window, which is enforced in code. A formal DPIA, consent-capture flow, and the
  app-store health-data declarations the companion apps would need for a real store listing are
  still outside this project's scope.
- Do not collect medical records, routes, heart rate or other health data when activity duration is sufficient.
- Set up Resend (domain verified) and Turnstile keys in `.env`, and add a DMARC record for the domain.

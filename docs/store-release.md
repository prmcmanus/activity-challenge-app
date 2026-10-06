# Publishing Active Together on Google Play and the App Store

A step-by-step guide for getting the Android and iPhone apps into the stores. The code side is
already prepared (see "What's already done"); most of what's left is accounts, forms and pictures
in the two store dashboards.

Plan on **3-5 weeks** for Google Play with a new personal account (a compulsory 14-day test with
12 people, then a review) and **1-2 weeks** for Apple (mostly waiting for review).

## What's already done in the code

| Requirement | Android | iPhone |
| --- | --- | --- |
| App name "Active Together" on the home screen | Done | Done |
| Account deletion inside the app (both stores require it) | Me → Edit → Delete my account | Me → Edit → Delete my account |
| A store build never offers its own updates (store rule) | `play` build type | `AT_DISTRIBUTION=appstore` build setting |
| Current platform requirement | Targets Android 16 (API 36) | Built with Xcode 26 (`macos-26` CI runner) |
| Signing for upload | Upload key in `~/.android/activetogether-upload.*` | Done by Apple's tools at upload |
| Privacy manifest | n/a | `Sources/PrivacyInfo.xcprivacy` |
| Privacy policy URL | https://activetogether.team/privacy.html | same |
| Account deletion URL | https://activetogether.team/privacy.html#delete-account | same |

The website downloads (sideloaded APK and Sideloadly .ipa) keep working alongside the stores.

## Decisions to make first

1. **Personal or organisation developer accounts.** A personal account is quickest and shows your
   own name as the developer/seller. An organisation account shows an organisation name. On Google
   it also skips the 14-day/12-tester test, but it needs a registered organisation with a free
   [D-U-N-S number](https://developer.apple.com/support/D-U-N-S/), which can take a couple of weeks
   to arrive.
2. **Store app IDs.** These are permanent once the first upload is made, and users never see them.
   Today they are `com.activetogether.companion` (Android) and `team.activetogether.companion`
   (iPhone). Keeping them is fine. If you'd rather lose "companion" before it's fixed for good,
   change them now (one line in each app, plus `public/.well-known/assetlinks.json`).
3. **The name must be free.** Search both stores for "Active Together" first. Apple won't let two
   apps share a name; if it's taken, use something like "Active Together: Team Challenges". The
   name under the icon on the phone stays "Active Together" either way.

## Google Play

### 1. Developer account
1. Go to https://play.google.com/console and sign up ($25, once).
2. Complete identity verification (ID document; organisations also need a D-U-N-S number).
3. Verify a contact phone number and email when asked.

### 2. Create the app
1. **Create app** → App name "Active Together", default language English (UK), **App**, **Free**.
2. Accept the declarations.

### 3. Build the upload file
On this laptop, from `companion/android`:
```bash
sg docker -c 'docker run --rm -v "$PWD":/src -v at-gradle-cache:/root/.gradle -v $HOME/.android:/root/.android \
  -w /src ghcr.io/cirruslabs/android-sdk:35 sh ./gradlew --no-daemon :app:bundlePlay'
# -> app/build/outputs/bundle/play/app-play.aab
```
Bump `versionCode` in `app/build.gradle.kts` for every upload; Play refuses a number it has seen.

**Back up the upload key** (`~/.android/activetogether-upload.jks` and
`activetogether-upload.properties`, which holds its password) somewhere safe, such as a password
manager. If it's lost, Google can reset it, but that takes a support request and a few days.

### 4. App signing and invite links
On the first upload, accept **Play App Signing** (Google keeps the final signing key). Then:
1. Play Console → **Test and release → App integrity → App signing**, and copy the
   **App signing key certificate SHA-256 fingerprint**.
2. Add it to `public/.well-known/assetlinks.json` next to the existing fingerprint (keep the old
   one for the website APK) and deploy the website. Invite links then open the Play Store app too.

### 5. App content (Policy → App content)
- **Privacy policy:** https://activetogether.team/privacy.html
- **Ads:** No ads.
- **App access:** "All or some functionality is restricted" → give a demo account (create one on
  the website, join it to a demo challenge with some activity), with the email and password.
- **Content rating:** fill in the questionnaire. No violence, no gambling. Users can interact
  (profiles, follows, comments). Expect a rating like "Everyone"/PEGI 3.
- **Target audience:** 18 and over is simplest. Choosing under-13s adds Families policy rules.
- **Health apps:** declare it a fitness app that reads from Health Connect. The permissions and
  why:
  - Exercise sessions, distance, steps: logging workouts and steps into challenges.
  - Exercise routes (optional, off by default): saving a workout's map, shown only to its owner.
  - Read in background: automatic sync, when the user switches it on.
  - Read history: syncing workouts from before the app was installed into a challenge that
    already started.
- **Account deletion:** in the app (Me → Edit → Delete my account) and on the web at
  https://activetogether.team/privacy.html#delete-account
- **Data safety:** see the answers below.
- **Government app / financial features / news:** No.

#### Data safety answers
Data is encrypted in transit (HTTPS): **Yes**. Users can request deletion: **Yes**. No data is
shared with third parties, and nothing is used for ads or analytics.

| Data type | Collected | Optional? | Purpose |
| --- | --- | --- | --- |
| Personal info → Name, Email address, User IDs | Yes | Required | App functionality, Account management |
| Health and fitness → Fitness info (workouts, distance, steps) | Yes | Required for syncing (manual logging works without) | App functionality |
| Location → Precise location (GPS routes) | Yes | Optional, off by default | App functionality |
| Photos | Yes | Optional (avatar, team logo, ticket screenshot) | App functionality |
| Messages → Other in-app messages (support tickets, comments) | Yes | Optional | App functionality, Customer support |
| App info and performance | No | | |
| Device or other IDs | No | | |

If reCAPTCHA is switched on for the website, mention that Google receives IP and browser data at
sign-up and sign-in on the **website**. The app itself doesn't use reCAPTCHA.

### 6. Store listing (Grow users → Store presence → Main store listing)
- **App name:** Active Together
- **Short description** and **full description:** see "Listing text" below.
- **App icon:** `public/icon-512.png` (512 × 512).
- **Feature graphic:** 1024 × 500 PNG/JPG (still to make; brand red with the logo and name works).
- **Phone screenshots:** at least 2 (up to 8), e.g. challenge list, leaderboard, profile,
  log activity, sync.
- **Category:** Health & Fitness. **Contact email:** a support address.

### 7. Testing, then production
1. **Internal testing** (instant, up to 100 people): upload the .aab and try it yourself.
2. **Closed testing** (required for new personal accounts): create a track, add at least
   **12 testers** by email (a Google Group is easiest), share the opt-in link, and keep them
   opted in **14 days in a row**. Google checks that they actually use the app.
3. Dashboard → **Apply for production**, answer the questions about the test, and wait for review
   (usually a few days).
4. Create a production release with the same .aab and roll out.

## Apple App Store

### 1. Developer account
1. Enrol at https://developer.apple.com/programs/ ($99 a year). An individual enrolment needs
   your Apple ID with two-factor authentication. An organisation also needs a D-U-N-S number.
2. Note your **Team ID** (Membership details).

### 2. App ID with Apple Health
1. https://developer.apple.com/account → Certificates, IDs & Profiles → **Identifiers** → **+**
   → App IDs → App.
2. Bundle ID (explicit): `team.activetogether.companion` (or your new choice; see decisions).
3. Capabilities: tick **HealthKit**. Save.

### 3. Create the app in App Store Connect
1. https://appstoreconnect.apple.com → Apps → **+** → New App.
2. Platform iOS, name "Active Together", primary language English (U.K.), the bundle ID above,
   SKU `activetogether`, Full Access.

### 4. Let GitHub upload builds
There's no Mac here, so the existing GitHub workflow builds the app. To let it upload to
TestFlight:
1. App Store Connect → Users and Access → **Integrations** → App Store Connect API → generate a
   **Team key** with the **App Manager** role. Download the `.p8` file (only offered once) and
   note the **Key ID** and **Issuer ID**.
2. Add them to the GitHub repository's secrets (Settings → Secrets and variables → Actions):
   `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the file's contents), `APPLE_TEAM_ID`.
3. Then ask Claude to add the App Store job: it builds with `AT_DISTRIBUTION=appstore`, signs
   automatically through the API key and uploads to TestFlight. That part is written once these
   exist, so it can be tested straight away.

### 5. App information and privacy
- **Category:** Health & Fitness. **Age rating:** answer the questionnaire; expect 4+ or 9+.
- **Privacy policy URL:** https://activetogether.team/privacy.html
- **Support URL:** https://activetogether.team/help
- **App Privacy** ("nutrition label"): Data Linked to You, none used for tracking, all for **App
  Functionality**: Name, Email Address, User ID, Health, Fitness, Precise Location (optional
  routes), Photos, Other User Content, Customer Support. This matches `PrivacyInfo.xcprivacy`.

### 6. Version page
- **Screenshots:** 6.9-inch iPhone, 1320 × 2868 (or 1290 × 2796), at least 1 and up to 10.
- **Promotional text, description, keywords:** see "Listing text" below.
- **App Review information:** a demo account (as for Google), and these notes:
  > Active Together runs team activity challenges for small groups. Sign-in is required; accounts
  > are created on our website, https://activetogether.team. The demo account is already in a
  > challenge. HealthKit is read only (workouts, distance, steps and, if the user turns it on,
  > workout routes) to log activity into the user's challenges; nothing is written to Health.
  > Account deletion: Me → Edit → Delete my account.
- **Export compliance:** already answered in the app (no non-exempt encryption).

### 7. TestFlight, then review
1. When a build arrives (about 15 minutes after upload), test it in TestFlight.
2. Select the build on the version page → **Add for Review** → **Submit**. Review usually takes
   1-3 days.

## Listing text

**Name:** Active Together

**Subtitle (Apple, max 30):** Team activity challenges

**Short description (Google, max 80):**
Team activity challenges: log workouts, sync from Health, climb the leaderboard.

**Full description:**
> Active Together turns getting active into a team game. Start a challenge for your workplace,
> club, family or friends, share the invite code, and see who moves the most.
>
> • Challenges count active minutes, distance or steps, between the dates you choose
> • Play in teams or as individuals, with live team and individual leaderboards
> • Sync workouts and daily steps automatically from Health Connect / Apple Health, or log them
>   by hand
> • Optional GPS routes on a map, only ever visible to you
> • Profiles: follow challenge-mates and see how they're doing, with you in control of what's shared
> • Private by default: only people you invite can see a challenge
>
> No ads and no tracking. You can delete your account and everything in it at any time.

**Keywords (Apple, max 100 characters):**
`team,challenge,steps,fitness,workout,leaderboard,walking,running,cycling,office,club,activity`

## After launch
- Replace the website's Android/iPhone download cards with store badges and links (or keep the
  downloads for people who'd rather sideload).
- People on the sideloaded Android app must **uninstall it and install from Play**, because Play
  signs with a different key. Their data is on the server, so they just sign in again.
- For each release: bump the version in `app/build.gradle.kts` and `companion/ios/project.yml`,
  build `bundlePlay` and upload it, and run the App Store job.

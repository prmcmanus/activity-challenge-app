# Publishing Active Together on Google Play and the App Store

A step-by-step guide for getting the Android and iPhone apps into the stores. The code, the
website pages and the store pictures are ready (see "What's ready"); what's left is accounts, forms
and waiting for review in the two store dashboards.

Plan on **3-5 weeks** for Google Play with a new personal account (a compulsory 14-day closed test
with 12 people, then a review) and **1-2 weeks** for Apple (mostly waiting for review). The two can
run side by side.

## What's ready

| Requirement | Android | iPhone |
| --- | --- | --- |
| Store build (never offers its own updates) | `play` build type, made by `tools/build-play.sh` | `AT_DISTRIBUTION=appstore`, made by the "iOS App Store" GitHub workflow |
| Platform requirement | Targets Android 16 (API 36) | Built with Xcode 26 (`macos-26` runner) |
| Signing | Upload key in `~/.android/activetogether-upload.*` | Automatic, through the App Store Connect API key |
| Account deletion in the app | Me → Edit → Delete my account | Me → Edit → Delete my account |
| Privacy policy link in the app | Sign-in screen, Me (bottom), Health Connect rationale | Sign-in screen, Me (bottom) |
| Health data | Read only; rationale screen for Health Connect | Read only (no write permission requested); `PrivacyInfo.xcprivacy` |
| Version | 1.11.0 (versionCode 18) | 1.11.0 (build number set by the workflow) |

Website pages the stores ask for:

- Privacy policy: https://activetogether.team/privacy.html
- Account deletion: https://activetogether.team/privacy.html#delete-account
- Support: https://activetogether.team/support.html (contact: support@activetogether.team)

Store pictures, in `companion/android/store-assets/`:

- `feature-graphic-1024x500.png`: the Play feature graphic.
- `phone-screenshots/`: five phone screenshots at 1080 × 1920 (challenges, leaderboard, journey
  map, activity, profile), taken with demo data.
- The Play icon is `companion/android/store-icon-512.png`.

The website downloads (the sideloaded APK and the Sideloadly .ipa) keep working alongside the
stores.

## Before you start

1. **Make sure support@activetogether.team receives mail.** It's on the support page, in the
   privacy policy and in both store listings, and Apple may write to it.
2. **Create a reviewer account.** Both stores need a sign-in to test with. The site is invite-only,
   so open an invite link to the demo challenge yourself (or turn invite-only off for a minute) and
   sign up as, say, `review@activetogether.team` with a strong password. Join a challenge that's
   running and log an activity or two, so reviewers don't see an empty app. Keep the account until
   both apps are approved; reviewers come back for every update.
3. **Back up the Android upload key**: `~/.android/activetogether-upload.jks` and
   `~/.android/activetogether-upload.properties` (holds its password), for example in a password
   manager. If it's lost, Google can reset it, but that takes a support request and a few days.

The store name is **ActiveTogether.Team**, because "Active Together" is taken on the App Store and
Apple won't allow two apps with one name. The name under the icon stays "Active Together". The
app IDs (`com.activetogether.companion` on Android, `team.activetogether.companion` on iPhone) are
permanent after the first upload; users never see them.

## Google Play

### 1. Developer account
1. Sign up at https://play.google.com/console as a **personal** account ($25, once).
2. Complete identity verification (ID document) and verify a phone number and email.
3. Also verify that you own an Android device: install the Play Console app on your phone and sign
   in, when asked.

### 2. Create the app
1. **Create app**: name **ActiveTogether.Team**, default language English (United Kingdom),
   **App**, **Free**.
2. Accept the declarations.

### 3. Build the upload file
On this laptop, from the repository:
```bash
tools/build-play.sh
# -> companion/android/ActiveTogether-1.11.0.aab
```
Each upload needs a new `versionCode` in `companion/android/app/build.gradle.kts`. Play refuses a
number it has already seen.

### 4. App content (Policy and programs → App content)
Work through every item on the page:

- **Privacy policy:** https://activetogether.team/privacy.html
- **App access:** "All or some functionality is restricted". Add the reviewer account's email and
  password, with the note "Sign in with these details. The account is already in a challenge."
- **Ads:** No.
- **Content rating:** fill in the questionnaire (category: "All other app
  types"). No violence, sex, drugs or gambling. Users can interact (profiles,
  follows), and the app doesn't share the user's location with other users. Expect "Everyone" /
  PEGI 3.
- **Target audience:** 18 and over. Choosing under-13s adds the Families policy rules.
- **News app / Government app / Financial features:** No.
- **Data safety:** see "Data safety answers" below.
- **Health apps:** tick **Activity and fitness**.
- **Health Connect permissions**: explain each one that's requested.
  - Exercise sessions, Distance, Steps: "Logs the user's workouts, distance and daily steps into
    the activity challenges they have joined."
  - Exercise routes: "Optional, off by default. Saves a workout's route so the user can see it on a
    map. Visible only to that user."
  - Read in background: "Automatic sync, which the user switches on in the app."
  - Read history: "Syncs workouts from before the app was installed into a challenge that had
    already started."
- **Account deletion:** "In the app (Me → Edit → Delete my account)" and the web URL
  https://activetogether.team/privacy.html#delete-account

#### Data safety answers
- Collects or shares data: **Yes**. Encrypted in transit: **Yes**. Users can request deletion:
  **Yes**.
- Nothing is **shared**. (Cloudflare and Cloudflare R2 count as service providers, which Google
  doesn't count as sharing.) Nothing is used for ads, marketing or analytics.

| Data type | Collected | Optional? | Purpose |
| --- | --- | --- | --- |
| Personal info → Name, Email address, User IDs | Yes | Required | App functionality, Account management |
| Health and fitness → Fitness info | Yes | Optional (manual logging works without it) | App functionality |
| Location → Precise location (workout routes) | Yes | Optional, off by default | App functionality |
| Photos and videos → Photos (avatar, team logo) | Yes | Optional | App functionality |
| Messages → Other in-app messages (support tickets) | Yes | Optional | Customer support |
| App activity → Other user-generated content (bio) | Yes | Optional | App functionality |

### 5. Store listing (Grow users → Store presence → Main store listing)
- **App name:** ActiveTogether.Team
- **Short description** and **Full description:** see "Listing text" below.
- **App icon:** `companion/android/store-icon-512.png`
- **Feature graphic:** `companion/android/store-assets/feature-graphic-1024x500.png`
- **Phone screenshots:** the five in `companion/android/store-assets/phone-screenshots/`
- **Store settings:** category **Health & Fitness**. Email support@activetogether.team, website
  https://activetogether.team

### 6. Closed test (14 days)
New personal accounts must run a closed test with at least **12 testers** who stay opted in for
**14 days in a row** before they can publish.

1. **Test and release → Testing → Closed testing** → create a track (or use "Alpha").
2. **Testers**: create an email list and add 12 or more people's Google account emails (add a few
   spares in case someone drops out).
3. **Create new release**: accept **Play App Signing** when asked (Google keeps the final signing
   key), upload `ActiveTogether-1.11.0.aab`, and use release notes such as "First store release."
4. **Countries**: United Kingdom (and any others). **Send for review**. The first review takes a
   few days.
5. Once approved, copy the **opt-in link** from the track and send it to the testers. Each must open
   it, tap **Become a tester**, install from Play and keep the app installed. Ask them to open it
   a few times; Google checks that it's being used.
6. Anyone on the website's sideloaded APK must **uninstall it first**, because Play signs the app
   with a different key. Their data is on the server, so they just sign in again.

### 7. Invite links in the Play version
After the first upload: **Test and release → Setup → App signing**, and copy the **SHA-256
certificate fingerprint** of the *App signing key*. Ask Claude to add it to
`public/.well-known/assetlinks.json` (next to the existing one, which the website APK still needs)
and deploy, so invite links open the Play version of the app.

### 8. Production
1. After 14 days, **Dashboard → Apply for production**, and answer the questions about the test:
   who tested, what feedback they gave, and what you changed.
2. When approved (usually within a week), **Production → Create new release**, add the same .aab
   from the library (or a newer build), and **roll out**.

## Apple App Store

### 1. Developer account
1. Enrol at https://developer.apple.com/programs/ as an **individual** ($99 a year). You need your
   Apple ID with two-factor authentication. Approval usually takes up to 48 hours.
2. Note your **Team ID** (Account → Membership details).
3. Accept the agreements under App Store Connect → **Business** (the free-app agreement is
   enough).

### 2. App ID with Apple Health
1. https://developer.apple.com/account → Certificates, IDs & Profiles → **Identifiers** → **+**
   → App IDs → App.
2. Description "Active Together", Bundle ID **explicit**: `team.activetogether.companion`.
3. Capabilities: tick **HealthKit**. Continue, then Register.

### 3. Create the app in App Store Connect
1. https://appstoreconnect.apple.com → Apps → **+** → New App.
2. Platform iOS. Name **ActiveTogether.Team**. Primary language English (U.K.). Bundle ID
   `team.activetogether.companion`. SKU `activetogether`. User access Full Access.

### 4. Let GitHub build and upload
There's no Mac here, so a GitHub workflow builds the app and uploads it.

1. App Store Connect → Users and Access → **Integrations** → App Store Connect API → **Team
   Keys** → **+**. Name it "GitHub", Access **Admin** (needed so it can create the distribution
   certificate). Download the `.p8` file (offered only once) and note the **Key ID** and the
   **Issuer ID** shown above the list.
2. GitHub → the repository → Settings → Secrets and variables → Actions → **New repository
   secret**, four times:
   - `ASC_KEY_ID`: the Key ID
   - `ASC_ISSUER_ID`: the Issuer ID
   - `ASC_KEY_P8`: the whole contents of the `.p8` file, including the BEGIN/END lines
   - `APPLE_TEAM_ID`: your Team ID
3. GitHub → **Actions** → **iOS App Store** → **Run workflow** (branch main). It takes about 10
   minutes. If it fails, the log (and the `appstore-logs` download on the run page) says why; send
   it to Claude.
4. The build appears in App Store Connect → **TestFlight** 10-30 minutes later. If asked about
   encryption, the app already declares that it uses none.

### 5. Try it in TestFlight
1. TestFlight → **Internal Testing** → **+** → add yourself. Install **TestFlight** on your iPhone,
   then install the app from it.
2. Delete the sideloaded app first if it's on the phone: both use the same bundle ID.
3. Check sign-in, a sync from Apple Health and the privacy policy link.

### 6. App information (left-hand menu)
- **Subtitle:** Team activity challenges
- **Category:** Health & Fitness (secondary: Social Networking, optional)
- **Content rights:** doesn't use third-party content.
- **Age rating:** answer the questionnaire: everything "None"/"No". There's no unrestricted web
  access and no user-to-user chat, so expect 4+.
- **Privacy policy URL:** https://activetogether.team/privacy.html

### 7. App Privacy
**Get Started**: "Yes, we collect data". Select these types. For each one: **App Functionality**
only; **Linked to the user: Yes**; **Used for tracking: No**.

- Contact info: Name, Email address
- Health and fitness: Health, Fitness
- Location: Precise location (optional workout routes)
- User content: Photos or videos, Customer support, Other user content
- Identifiers: User ID

**Publish** the answers.

### 8. The version page (1.11.0 "Prepare for Submission")
- **Screenshots** (6.9-inch display, required): 3-5 screenshots at 1290 × 2796. Take them on your
  iPhone (side button + volume up) with the app signed in to an account with good-looking data, and
  send them to Claude to resize to the exact size. The App Store builds the smaller sizes from
  these.
- **Promotional text, description, keywords:** see "Listing text" below.
- **Support URL:** https://activetogether.team/support.html
- **Marketing URL:** https://activetogether.team
- **Copyright:** 2026 your name
- **Build:** pick the TestFlight build.
- **App Review information:** sign-in required, with the reviewer account's email and password.
  Contact: your name, phone and email. Notes:
  > Active Together runs activity challenges for small groups such as workplaces, clubs and
  > families. Sign-in is required, and accounts are created on our website
  > (https://activetogether.team). The demo account above is already in a challenge.
  > HealthKit is read only: workouts, distance and daily steps (and, only if the user switches it
  > on, workout routes) are read to log activity into the user's challenges. Nothing is written to
  > Health, and health data is never used for advertising or shared.
  > Account deletion: Me → Edit → Delete my account.
- **Version release:** automatically, or manually if you want to choose the day.

### 9. Submit
**Add for Review** → **Submit to App Review**. Review usually takes 1-3 days. If Apple rejects
something, the message is in App Store Connect → **App Review**; send it to Claude.

## Listing text

**Store name:** ActiveTogether.Team

**Subtitle (Apple, max 30):** Team activity challenges

**Short description (Google, max 80):**
Team activity challenges: log workouts, sync from Health, climb the leaderboard.

**Promotional text (Apple, max 170):**
Start a challenge for your workplace, club, family or friends, and see who moves the most.

**Full description (both):**
> Active Together turns getting active into a team game. Start a challenge for your workplace,
> club, family or friends, share the invite code, and see who moves the most.
>
> • Challenges count active minutes, distance or steps, between the dates you choose
> • Virtual journeys: walk or cycle from London to Edinburgh, or any route you like, together
> • Play in teams or as individuals, with live team and individual leaderboards
> • Sync workouts and daily steps automatically from Health Connect or Apple Health, or log them
>   by hand
> • Optional GPS routes on a map, only ever visible to you
> • Profiles: follow challenge-mates and see how they're doing, with you in control of what's shared
> • Private by default: only people you invite can see a challenge
>
> No ads and no tracking. You can delete your account and everything in it at any time.

**Keywords (Apple, max 100 characters):**
`team,challenge,steps,fitness,workout,leaderboard,walking,running,cycling,journey,club,activity`

## Releasing updates
1. Bump `versionCode` and `versionName` in `companion/android/app/build.gradle.kts`, and
   `MARKETING_VERSION` in `companion/ios/project.yml`.
2. Android: `tools/build-play.sh`, then upload the .aab as a new release in Play Console
   (Production, or a testing track first).
3. iPhone: run the **iOS App Store** workflow, then create a new version in App Store Connect, pick
   the build and submit.
4. The website downloads are separate: `tools/publish-android.sh` and `tools/publish-ios.sh`.

## After launch
- Add the store badges and links to the website's sync page and the "Get the app" button (ask
  Claude), and keep or retire the sideload downloads.

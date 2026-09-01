# Active Together iOS Companion

Native iOS companion MVP for syncing workout durations from Apple Health into Active Together — the
HealthKit counterpart to [companion/android](../android)'s Health Connect app.

## What it does

- Signs in to the Active Together server with the same email/password as the web app.
- Stores the returned bearer session token in app storage.
- Loads the member's challenge/team memberships from `/api/mobile/bootstrap` and offers them as one
  combined "Challenge — Team" picker, since a synced record needs a valid team+challenge pairing.
- Requests HealthKit read access for workouts.
- Reads workouts from the last 30 days.
- Uploads whole-minute durations to `/api/health/import` (with `source: "health_kit"`) using each
  workout's stable UUID as `source_ref`, so repeated syncs are idempotent.

This companion is sync-only: it does not create accounts or join challenges/teams. Register, join
with an invite code, and create/join a team in the web app first, then sign in here with the same
credentials.

## Why there's no `.xcodeproj` in this folder

This app was built without access to Xcode or macOS, and an Xcode project file (`project.pbxproj`)
is a finicky, mostly-generated format that is easy to corrupt by hand and impossible to verify
without Xcode itself. Rather than ship a project file that might silently fail to open, this folder
has the complete, working Swift source in [`Sources/`](Sources/) plus the exact steps below to drop
it into a fresh Xcode project — about two minutes of clicking, and Xcode generates its own
known-good project file.

## Setting up the Xcode project

1. **Xcode → File → New → Project…** → iOS → **App**. Set:
   - Product Name: `ActiveTogetherCompanion`
   - Interface: **SwiftUI**
   - Language: **Swift**
   - Uncheck "Include Tests" (optional)
   - Organization identifier: your own reverse-DNS (e.g. `team.activetogether`), giving a bundle id
     like `team.activetogether.ActiveTogetherCompanion`
2. Save it anywhere convenient — for example as a sibling of this `Sources/` folder, or replace this
   `companion/ios/` folder's contents once the project exists (either is fine; nothing in the server
   or web app depends on where the iOS project lives).
3. In the new project, **delete** the placeholder `ContentView.swift` and the `*App.swift` file that
   Xcode generated (keep `Assets.xcassets`).
4. Drag the four files from this repo's [`Sources/`](Sources/) folder into the Xcode project
   navigator (check **Copy items if needed** and **Add to target: ActiveTogetherCompanion**):
   - `ActiveTogetherCompanionApp.swift`
   - `ContentView.swift`
   - `ActiveTogetherAPI.swift`
   - `HealthKitSync.swift`
5. Add the **HealthKit** capability: select the project in the navigator → target
   `ActiveTogetherCompanion` → **Signing & Capabilities** → **+ Capability** → **HealthKit**. This
   both links `HealthKit.framework` and generates an entitlements file — if you'd rather start from
   the one already in this repo, add `../ActiveTogetherCompanion.entitlements` to the target instead
   and set it as the target's "Code Signing Entitlements" path.
6. Add a HealthKit usage description: target → **Info** tab → add key
   `Privacy - Health Share Usage Description`
   (`NSHealthShareUsageDescription`) with a value such as:
   > Active Together reads your recent workouts to log activity minutes toward your team's
   > challenge.
7. Set the **Minimum Deployments** iOS version to **16.0** or later (the app uses Swift concurrency
   and `NavigationStack`, both available since iOS 16).
8. Build and run on a **physical iPhone** signed into Health, or the iOS Simulator with sample
   workout data added manually in the Health app (`Health → Browse → Activity → Workouts → Add
   Data`) — the Simulator has no real Health data of its own.
9. Use your Mac's LAN IP and the server's port (e.g. `http://203.0.113.10:8700`) as the Server URL —
   `localhost` from a device or simulator does not reach a server running elsewhere.

## Privacy boundary

The companion reads only workout records and uploads only:

- team ID
- challenge ID
- activity type (a short label such as "Running" or "Cycling")
- whole minutes
- activity date
- stable source reference (the workout's UUID)

It does not upload routes, heart rate, calories, medical records, GPS data, or raw HealthKit samples.

## Known limitations

- The session token is stored in `UserDefaults` via `@AppStorage`, matching the Android companion's
  use of plain `SharedPreferences` — convenient for this MVP, but not Keychain-backed. See the root
  [README's production checklist](../../README.md#production-checklist) before shipping either
  companion to real users.
- `HKWorkoutActivityType` is mapped to a short label for only the most common workout types; anything
  else uploads as "Exercise" (still a valid, storable activity type on the server).

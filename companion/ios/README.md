# Active Together for iPhone

The SwiftUI counterpart of [the Android app](../android), with the same features:

- Challenges: list, create, edit, delete, join with a code, invite links (`activetogether://join/CODE`),
  teams (join or create), leaderboards, and tapping a person to see their profile.
- Activity: everything you've logged, with maps for routes; log by hand into several challenges at once;
  edit and remove entries; step-challenge days.
- Sync from Apple Health: review workouts (type, distance, which challenges), GPS routes if you turn them
  on, and daily step totals for step challenges. Automatic sync on opening the app and in the background
  when iOS allows.
- Me: your profile as others see it, editing it (photo, bio, sharing level, email, password), sync settings.
- Help & support tickets, the admin support dashboard, and the admin users/challenges screens.
- An "Update available" notice when a newer build is published on the website.

## Building

There is no `.xcodeproj` in the repo: [`project.yml`](project.yml) describes the project and
[XcodeGen](https://github.com/yonaskolb/XcodeGen) generates it (`brew install xcodegen && xcodegen generate`).

The [`iOS app` GitHub Actions workflow](../../.github/workflows/ios.yml) does this on a macOS runner on every
change under `companion/ios/`, builds for iPhone, and uploads `ActiveTogether.ipa` as an artifact. The `.ipa`
is ad-hoc signed with the app's Apple Health entitlement, ready to be re-signed for a real device.

With a Mac instead: `xcodegen generate`, open `ActiveTogether.xcodeproj`, choose your team under Signing &
Capabilities, and run on your iPhone.

## Installing on an iPhone without a Mac

With no Apple Developer Program membership, use [Sideloadly](https://sideloadly.io) (free, Windows or Mac):

1. Download the `.ipa` (from the website's "Get the iPhone app" card once published, or the workflow artifact).
2. On Windows, install iTunes from apple.com (Sideloadly needs its drivers), then Sideloadly.
3. Connect the iPhone by cable and trust the computer.
4. Drag the `.ipa` into Sideloadly, enter your Apple ID, Start.
5. On the iPhone: Settings › General › VPN & Device Management › trust your Apple ID; on iOS 16+ also turn on
   Settings › Privacy & Security › Developer Mode.

A free Apple ID's signature lasts **7 days**; reinstall the same way to renew (the app's data is kept).
A paid Apple Developer account would allow TestFlight and `https://activetogether.team/join/...` links
opening the app directly (Associated Domains); free signing only supports the `activetogether://` links.

Publish a build for the website and the in-app update notice with `tools/publish-ios.sh <ipa> <version> <build>`.

## Privacy

Reads only workouts (type, time, distance), daily step counts and - only if "Include GPS routes" is on -
workout routes. Never writes to Apple Health. Routes are visible only to you on the server.

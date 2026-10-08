#!/usr/bin/env bash
# Build the Google Play upload file (an Android App Bundle, .aab), signed with the Play upload key.
# Runs the Android build in Docker, so nothing else needs installing. The upload key lives outside the
# repo: ~/.android/activetogether-upload.jks and activetogether-upload.properties (keep a backup).
#
# Usage: tools/build-play.sh      -> companion/android/ActiveTogether-<version>.aab
# Bump versionCode (and versionName) in companion/android/app/build.gradle.kts before each upload:
# Play refuses a versionCode it has already seen.
set -euo pipefail
cd "$(dirname "$0")/../companion/android"
[ -f ~/.android/activetogether-upload.properties ] || { echo "No upload key: ~/.android/activetogether-upload.properties is missing." >&2; exit 1; }
VERSION=$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)
CODE=$(sed -n 's/.*versionCode = \([0-9]*\).*/\1/p' app/build.gradle.kts)
echo "Building Play bundle $VERSION ($CODE)..."
docker run --rm -v "$PWD":/src -v at-gradle-cache:/root/.gradle -v "$HOME/.android":/root/.android -w /src \
  ghcr.io/cirruslabs/android-sdk:35 sh -c "sh ./gradlew --no-daemon -q :app:bundlePlay; rc=\$?; chown -R $(id -u):$(id -g) /src /root/.android; exit \$rc"
OUT="ActiveTogether-$VERSION.aab"
cp app/build/outputs/bundle/play/app-play.aab "$OUT"
echo "Ready: companion/android/$OUT ($(du -h "$OUT" | cut -f1)) - upload it in Play Console."

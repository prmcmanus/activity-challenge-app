#!/usr/bin/env bash
# Publish an Android APK as the download signed-in users get from the website.
# It goes onto the container's data volume (/data/downloads), so no redeploy is needed and it
# survives rebuilds. The version shown on the site is read from app/build.gradle.kts.
#
# Usage: tools/publish-android.sh companion/android/ActiveTogether-1.4.0.apk [user@host]
set -euo pipefail
APK=${1:?usage: tools/publish-android.sh path/to/app.apk [user@host]}
HOST=${2:-paul@203.0.113.10}
CONTAINER=activity-challenge-activity-challenge-1
cd "$(dirname "$0")/.."
GRADLE=companion/android/app/build.gradle.kts
VERSION=$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' "$GRADLE")
CODE=$(sed -n 's/.*versionCode = \([0-9]*\).*/\1/p' "$GRADLE")
case "$APK" in *"$VERSION"*) ;; *) echo "Warning: $APK doesn't look like version $VERSION from $GRADLE" >&2 ;; esac
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
TMP=$(mktemp -d)
cp "$APK" "$TMP/ActiveTogether.apk"
printf '{"version":"%s","versionCode":%s,"sha256":"%s","published":"%s"}\n' "$VERSION" "$CODE" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP/android.json"
scp -q "$TMP/ActiveTogether.apk" "$TMP/android.json" "$HOST:/tmp/"
# APK first, then the version info that announces it.
ssh "$HOST" "docker exec $CONTAINER mkdir -p /data/downloads \
  && docker cp /tmp/ActiveTogether.apk $CONTAINER:/data/downloads/ActiveTogether.apk \
  && docker cp /tmp/android.json $CONTAINER:/data/downloads/android.json \
  && rm /tmp/ActiveTogether.apk /tmp/android.json"
rm -r "$TMP"
echo "Published Android $VERSION ($CODE), sha256 $SHA"

#!/usr/bin/env bash
# Publish an iPhone .ipa as the download signed-in users get from the website, and as the version the
# app's "Update available" notice compares against. Goes onto the container's data volume, like the
# Android download (tools/publish-android.sh), so no redeploy is needed.
#
# Usage: tools/publish-ios.sh ActiveTogether.ipa 1.6.1 13 [user@host]
set -euo pipefail
IPA=${1:?usage: tools/publish-ios.sh app.ipa version build [user@host]}
VERSION=${2:?version}; BUILD=${3:?build}
HOST=${4:-paul@203.0.113.10}
CONTAINER=activity-challenge-activity-challenge-1
TMP=$(mktemp -d)
cp "$IPA" "$TMP/ActiveTogether.ipa"
printf '{"version":"%s","build":%s,"published":"%s"}\n' "$VERSION" "$BUILD" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP/ios.json"
scp -q "$TMP/ActiveTogether.ipa" "$TMP/ios.json" "$HOST:/tmp/"
ssh "$HOST" "docker exec $CONTAINER mkdir -p /data/downloads \
  && docker cp /tmp/ActiveTogether.ipa $CONTAINER:/data/downloads/ActiveTogether.ipa \
  && docker cp /tmp/ios.json $CONTAINER:/data/downloads/ios.json \
  && rm /tmp/ActiveTogether.ipa /tmp/ios.json"
rm -r "$TMP"
echo "Published iPhone $VERSION ($BUILD)"

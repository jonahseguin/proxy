#!/bin/sh
set -eu
: "${OBJECTSTORE_ENDPOINT:?Object storage must be configured}"
: "${OBJECTSTORE_BUCKET:?Object storage must be configured}"
: "${OBJECTSTORE_ACCESS_KEY:?Object storage must be configured}"
: "${OBJECTSTORE_SECRET_KEY:?Object storage must be configured}"
# CPA bootstrap merges auth files; never retain a previous account's local mirror.
export OBJECTSTORE_LOCAL_PATH=/tmp/proxy-credentials
rm -rf "$OBJECTSTORE_LOCAL_PATH"
exec /CLIProxyAPI/CLIProxyAPI

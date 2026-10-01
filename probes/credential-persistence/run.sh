#!/usr/bin/env bash
set -euo pipefail

probe_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(git -C "$probe_dir" rev-parse --show-toplevel)"
reference="$repo_root/.reference/CLIProxyAPI"
revision="${1:-c93978c4ea2e908255a2a06c37599fda3651554a}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/proxy-persistence.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

git -C "$reference" rev-parse --verify "$revision^{commit}"
git -C "$reference" archive "$revision" | tar -x -C "$scratch"
cp "$probe_dir/persistence_test.go" "$scratch/internal/store/proxy_persistence_test.go"

docker run --rm \
	-v "$scratch:/source" \
	-w /source \
	golang:1.26@sha256:6c2a5538f964f1c82f97ad14988bf05de100d922d159d0e398b54c7b0ca0c6c9 \
	go test -count=1 -timeout=120s -v ./internal/store -run '^TestProxyProbe'

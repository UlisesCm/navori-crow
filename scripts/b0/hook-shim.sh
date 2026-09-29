#!/bin/sh
# B0 experiment shim (the `command` + `async` transport candidate of design.md D14).
# Reads the hook JSON from stdin and POSTs it to the scratch receiver.
# Always exit 0, never writes to stdout/stderr.
# Usage: hook-shim.sh <engine>   (env CROW_B0_HOOK_URL, default http://127.0.0.1:7790/hook)
URL="${CROW_B0_HOOK_URL:-http://127.0.0.1:7790/hook}/${1:-claude}"
curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- "$URL" >/dev/null 2>&1 || true
exit 0

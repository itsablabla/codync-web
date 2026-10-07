#!/bin/bash
# Run codync-host (loopback) and the web proxy together; if either dies, the container exits
# so the platform restarts it.
set -u

mkdir -p "$HOME/.codync"

codync-host serve --port 19222 &
HOST_PID=$!

node /app/server.mjs &
PROXY_PID=$!

# Wait for whichever dies first, then stop the other.
wait -n "$HOST_PID" "$PROXY_PID"
STATUS=$?
kill "$HOST_PID" "$PROXY_PID" 2>/dev/null
exit "$STATUS"

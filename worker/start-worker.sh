#!/bin/bash
# =============================================================================
# Start GPU Worker
# =============================================================================
# Connects to the Assetgenerator server and registers as a GPU worker.
# Auto-reconnects on disconnect. Ctrl+C to stop.
#
# Usage:
#   ./start-worker.sh                    # Connect to production
#   ./start-worker.sh local              # Connect to localhost:5200
#   WORKER_SERVER_URL=wss://... ./start-worker.sh  # Custom URL
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to production, allow "local" shortcut
if [ "${1}" = "local" ]; then
  export WORKER_SERVER_URL="ws://localhost:5200/ws/worker"
elif [ -z "${WORKER_SERVER_URL}" ]; then
  export WORKER_SERVER_URL="wss://assetgen.korczewski.de/ws/worker"
fi

echo "Starting GPU worker → ${WORKER_SERVER_URL}"
exec node "${SCRIPT_DIR}/index.js"

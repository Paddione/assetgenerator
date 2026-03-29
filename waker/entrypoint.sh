#!/bin/sh
# =============================================================================
# GPU Waker Entrypoint
# =============================================================================
# Sends an SSH wake signal to the GPU worker machine, then idles.
# KEDA scales this pod 0→1 when assetgenerator queue-depth > 0, and back to 0
# when the queue is drained.
#
# Required mounts:
#   /ssh/id_ed25519  — private key for patrick@GPU_HOST
#
# Environment:
#   GPU_HOST        — GPU machine IP (default: 10.10.0.3)
#   GPU_SSH_PORT    — SSH port (default: 2222)
#   GPU_SSH_USER    — SSH user (default: patrick)
#   ASSETGEN_URL    — Assetgenerator base URL for health polling
# =============================================================================

set -e

GPU_HOST="${GPU_HOST:-10.10.0.3}"
GPU_SSH_PORT="${GPU_SSH_PORT:-2222}"
GPU_SSH_USER="${GPU_SSH_USER:-patrick}"
MAX_RETRIES=5
RETRY_DELAY=10

echo "[gpu-waker] Waking GPU worker at ${GPU_SSH_USER}@${GPU_HOST}:${GPU_SSH_PORT}"

for i in $(seq 1 $MAX_RETRIES); do
  if ssh -o StrictHostKeyChecking=no \
         -o ConnectTimeout=10 \
         -o UserKnownHostsFile=/dev/null \
         -o LogLevel=ERROR \
         -i /ssh/id_ed25519 \
         -p "${GPU_SSH_PORT}" \
         "${GPU_SSH_USER}@${GPU_HOST}" \
         'systemctl --user start gpu-worker'; then
    echo "[gpu-waker] Wake signal sent successfully (attempt ${i})"
    break
  fi

  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "[gpu-waker] ERROR: Failed to wake GPU worker after ${MAX_RETRIES} attempts"
    exit 1
  fi

  echo "[gpu-waker] SSH attempt ${i} failed, retrying in ${RETRY_DELAY}s..."
  sleep "$RETRY_DELAY"
done

# Stay alive — KEDA will scale us back to 0 when the queue empties.
# Optionally poll worker-status so logs show when the worker actually connects.
if [ -n "${ASSETGEN_URL}" ]; then
  echo "[gpu-waker] Polling worker status at ${ASSETGEN_URL}/api/worker-status"
  while true; do
    STATUS=$(curl -sf "${ASSETGEN_URL}/api/worker-status" 2>/dev/null || echo '{"connected":false}')
    CONNECTED=$(echo "$STATUS" | grep -o '"connected":true' || true)
    if [ -n "$CONNECTED" ]; then
      echo "[gpu-waker] Worker connected. Standing by until KEDA scales down."
    fi
    sleep 30
  done
else
  echo "[gpu-waker] Standing by (KEDA will scale down when queue empties)"
  exec sleep infinity
fi

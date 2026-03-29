/**
 * GPU Worker — thin WebSocket client that connects to the Assetgenerator server
 * and executes shell commands on the local machine (with GPU access).
 *
 * Usage:
 *   cd Assetgenerator/worker && npm start
 *   # Or: WORKER_SERVER_URL=wss://assetgen.korczewski.de/ws/worker npm start
 */

import WebSocket from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_URL = 'wss://assetgen.korczewski.de/ws/worker';
const DEFAULT_RECONNECT_DELAY = 5000;

function detectGpu() {
  const candidates = ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi'];
  for (const bin of candidates) {
    try {
      const output = execFileSync(bin, ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf-8', timeout: 5000 });
      return output.trim().split('\n')[0] || 'Unknown GPU';
    } catch { /* try next */ }
  }
  return 'No GPU detected';
}

export function createWorker(opts = {}) {
  const url = opts.url || process.env.WORKER_SERVER_URL || DEFAULT_URL;
  const reconnectDelay = opts.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
  const gpuName = opts.gpu || detectGpu();

  let ws = null;
  let currentProc = null;
  let closed = false;
  let reconnectTimer = null;

  const idleTimeoutMs = opts.idleTimeoutMs ?? parseInt(process.env.IDLE_TIMEOUT_MS || '0', 10);
  let idleTimer = null;

  function resetIdleTimer() {
    if (idleTimeoutMs <= 0) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`Idle timeout (${idleTimeoutMs / 1000}s) reached, shutting down.`);
      process.exit(0);
    }, idleTimeoutMs);
  }

  function clearIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`Connected to ${url}`);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'welcome') {
        ws.send(JSON.stringify({
          type: 'register',
          hostname: hostname(),
          gpu: gpuName,
        }));
        console.log(`Registered as ${hostname()} (${gpuName})`);
        resetIdleTimer();
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'exec') {
        clearIdleTimer();
        console.log(`Job ${msg.jobId}: ${msg.cmd} ${msg.args.join(' ')}`);
        ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));

        currentProc = spawn(msg.cmd, msg.args, {
          cwd: msg.cwd,
          env: { ...process.env, ...(msg.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        currentProc.stdout.on('data', (d) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stdout', jobId: msg.jobId, data: d.toString() }));
          }
        });

        currentProc.stderr.on('data', (d) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stderr', jobId: msg.jobId, data: d.toString() }));
          }
        });

        currentProc.on('close', (code) => {
          console.log(`Job ${msg.jobId}: exit ${code}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: code ?? 1 }));
          }
          currentProc = null;
          resetIdleTimer();
        });

        currentProc.on('error', (err) => {
          console.error(`Job ${msg.jobId}: spawn error: ${err.message}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stderr', jobId: msg.jobId, data: err.message }));
            ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 1 }));
          }
          currentProc = null;
          resetIdleTimer();
        });

        return;
      }

      if (msg.type === 'cancel') {
        if (currentProc) {
          console.log(`Job ${msg.jobId}: cancelling`);
          currentProc.kill('SIGTERM');
        }
        return;
      }
    });

    ws.on('close', () => {
      console.log('Disconnected.');
      ws = null;
      if (!closed) {
        console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
        reconnectTimer = setTimeout(connect, reconnectDelay);
      }
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error: ${err.message}`);
    });
  }

  connect();

  return {
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearIdleTimer();
      if (currentProc) currentProc.kill('SIGTERM');
      if (ws) ws.close();
    },
  };
}

// If run directly (not imported as module), start the worker
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
  console.log('Starting GPU worker...');
  createWorker();
}

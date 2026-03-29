/**
 * Worker Manager — server-side WebSocket manager for GPU worker connections.
 *
 * Accepts a single worker connection on /ws/worker. Dispatches exec commands
 * and returns Promises that resolve with { stdout, stderr, code }.
 *
 * Usage:
 *   import { initWorkerManager, getWorker, getWorkerStatus } from './worker-manager.js';
 *   initWorkerManager(httpServer);
 */

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

let wss = null;
let worker = null; // { ws, hostname, gpu, currentJob }
let pingTimer = null;
let pongTimer = null;
let jobQueue = []; // { jobId, payload, resolve, reject, stdout, stderr }

// Configurable for testing
let PING_INTERVAL = 45_000;
let PONG_TIMEOUT = 30_000;
let JOB_RETRY_LIMIT = 2;
let RECONNECT_WAIT_MS = 60_000;

export function initWorkerManager(httpServer, opts = {}) {
  PING_INTERVAL = opts.pingInterval ?? 30_000;
  PONG_TIMEOUT = opts.pongTimeout ?? 10_000;
  JOB_RETRY_LIMIT = opts.jobRetryLimit ?? 2;
  RECONNECT_WAIT_MS = opts.reconnectWaitMs ?? 60_000;

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws/worker') {
      if (worker) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'register') {
        worker = { ws, hostname: msg.hostname, gpu: msg.gpu, currentJob: null };
        // Clear reconnect timers on queued jobs — worker is back
        for (const job of jobQueue) clearTimeout(job._reconnectTimer);
        console.log(`Worker registered: ${msg.hostname} (${msg.gpu || 'no GPU'})${jobQueue.length ? `, ${jobQueue.length} job(s) queued` : ''}`);
        startHeartbeat();
        dispatchNext();
        return;
      }

      if (msg.type === 'pong') {
        clearTimeout(pongTimer);
        return;
      }

      if (!worker?.currentJob) return;
      const job = worker.currentJob;

      if (msg.type === 'ack') return;

      if (msg.type === 'stdout') {
        job.stdout += msg.data;
        if (job.onStdout) job.onStdout(msg.data);
        return;
      }

      if (msg.type === 'stderr') {
        job.stderr += msg.data;
        return;
      }

      if (msg.type === 'exit') {
        const { resolve } = job;
        const result = { stdout: job.stdout, stderr: job.stderr, code: msg.code };
        worker.currentJob = null;
        resolve(result);
        dispatchNext();
        return;
      }
    });

    ws.on('close', () => {
      const currentJob = worker?.currentJob;
      stopHeartbeat();
      worker = null;

      if (currentJob) {
        currentJob.retries = (currentJob.retries || 0) + 1;
        if (currentJob.retries <= JOB_RETRY_LIMIT) {
          console.warn(`Worker disconnected during ${currentJob.jobId} — re-queuing (attempt ${currentJob.retries}/${JOB_RETRY_LIMIT}), waiting ${RECONNECT_WAIT_MS / 1000}s for reconnect`);
          currentJob.stdout = '';
          currentJob.stderr = '';
          jobQueue.unshift(currentJob);
          // Set a timeout — if worker doesn't reconnect in time, reject remaining jobs
          currentJob._reconnectTimer = setTimeout(() => {
            if (!worker) {
              console.error(`Worker did not reconnect within ${RECONNECT_WAIT_MS / 1000}s — failing queued jobs`);
              for (const job of jobQueue) {
                clearTimeout(job._reconnectTimer);
                job.reject(new Error('Worker disconnected and did not reconnect'));
              }
              jobQueue = [];
            }
          }, RECONNECT_WAIT_MS);
        } else {
          currentJob.reject(new Error(`Worker disconnected during job (exhausted ${JOB_RETRY_LIMIT} retries)`));
        }
      }
      // Don't reject queued jobs — they'll be dispatched when a new worker connects
    });

    ws.on('error', () => {
      ws.close();
    });
  });
}

function startHeartbeat() {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (!worker) return;
    worker.ws.send(JSON.stringify({ type: 'ping' }));
    pongTimer = setTimeout(() => {
      if (worker) {
        worker.ws.close();
      }
    }, PONG_TIMEOUT);
  }, PING_INTERVAL);
}

function stopHeartbeat() {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  pingTimer = null;
  pongTimer = null;
}

function dispatchNext() {
  if (!worker || worker.currentJob || jobQueue.length === 0) return;
  const job = jobQueue.shift();
  worker.currentJob = job;
  worker.ws.send(JSON.stringify({
    type: 'exec',
    jobId: job.jobId,
    cmd: job.payload.cmd,
    args: job.payload.args,
    cwd: job.payload.cwd,
    env: job.payload.env || {},
  }));
}

export function enqueueJob(payload, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const job = {
      jobId: randomUUID(),
      payload,
      resolve,
      reject,
      stdout: '',
      stderr: '',
      onStdout,
    };
    jobQueue.push(job);
    dispatchNext();
  });
}

export function getQueueDepth() {
  const active = worker?.currentJob ? 1 : 0;
  const pending = jobQueue.length;
  return {
    depth: pending + active,
    pending,
    active,
    workerConnected: !!worker,
  };
}

export function getWorker() {
  if (!worker) return null;
  return {
    exec(payload, { onStdout } = {}) {
      return new Promise((resolve, reject) => {
        const job = {
          jobId: randomUUID(),
          payload,
          resolve,
          reject,
          stdout: '',
          stderr: '',
          onStdout,
        };
        jobQueue.push(job);
        dispatchNext();
      });
    },
  };
}

export function getWorkerStatus() {
  return {
    connected: !!worker,
    hostname: worker?.hostname ?? null,
    gpu: worker?.gpu ?? null,
    currentJob: worker?.currentJob?.jobId ?? null,
  };
}

export function shutdownWorkerManager() {
  stopHeartbeat();
  if (worker) {
    worker.ws.close();
    worker = null;
  }
  jobQueue = [];
  if (wss) {
    wss.close();
    wss = null;
  }
}

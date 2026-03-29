/**
 * Worker Manager Tests
 *
 * Tests the server-side WebSocket manager that handles GPU worker connections.
 * Uses mock WebSocket servers — no real worker or GPU needed.
 *
 * Run: cd Assetgenerator && npx vitest run test/worker-manager.test.js
 */

import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { initWorkerManager, getWorker, getWorkerStatus, shutdownWorkerManager, enqueueJob, getQueueDepth } from '../worker-manager.js';

// Helper: create a minimal HTTP server for testing
function createTestServer() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// Helper: create a WS client that connects as a worker
function connectWorker(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
    ws.on('open', () => {
      // Wait for welcome, then register
      ws.once('message', (raw) => {
        const msg = JSON.parse(raw);
        expect(msg.type).toBe('welcome');
        ws.send(JSON.stringify({ type: 'register', hostname: 'test-pc', gpu: 'RTX Test' }));
        // Give server time to process register
        setTimeout(() => resolve(ws), 50);
      });
    });
    ws.on('error', reject);
  });
}

describe('WorkerManager', () => {
  let httpServer, port;

  beforeAll(async () => {
    ({ server: httpServer, port } = await createTestServer());
    initWorkerManager(httpServer, { pingInterval: 500, pongTimeout: 200, reconnectWaitMs: 500 });
  });

  afterAll(async () => {
    shutdownWorkerManager();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  describe('connection lifecycle', () => {
    it('getWorker() returns null when no worker connected', () => {
      const worker = getWorker();
      expect(worker).toBe(null);
    });

    it('getWorkerStatus() shows disconnected when no worker', () => {
      const status = getWorkerStatus();
      expect(status.connected).toBe(false);
      expect(status.hostname).toBe(null);
      expect(status.gpu).toBe(null);
    });

    it('getWorker() returns truthy after worker connects and registers', async () => {
      const ws = await connectWorker(port);
      const worker = getWorker();
      expect(worker).toBeTruthy();
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('getWorkerStatus() shows connected with hostname and gpu', async () => {
      const ws = await connectWorker(port);
      const status = getWorkerStatus();
      expect(status.connected).toBe(true);
      expect(status.hostname).toBe('test-pc');
      expect(status.gpu).toBe('RTX Test');
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('getWorker() returns null after worker disconnects', async () => {
      const ws = await connectWorker(port);
      expect(getWorker()).toBeTruthy();
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(getWorker()).toBe(null);
    });

    it('rejects second worker connection', async () => {
      const ws1 = await connectWorker(port);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
      // Server rejects at HTTP upgrade level (403), so WS never opens.
      // ws client fires 'error' then 'close' with code 1006 (abnormal).
      const result = await new Promise((resolve) => {
        ws2.on('error', () => {}); // suppress unhandled error
        ws2.on('close', (code) => resolve(code));
      });
      expect([1006, 1005].includes(result)).toBeTruthy();
      ws1.close();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('exec()', () => {
    it('sends exec message and resolves on exit', async () => {
      const ws = await connectWorker(port);

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          ws.send(JSON.stringify({ type: 'stdout', jobId: msg.jobId, data: 'SEED:12345\n' }));
          ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
        }
      });

      const worker = getWorker();
      const result = await worker.exec({ cmd: 'echo', args: ['hello'], cwd: '/tmp', env: {} });
      expect(result.code).toBe(0);
      expect(result.stdout.includes('SEED:12345')).toBeTruthy();

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('collects stderr in result', async () => {
      const ws = await connectWorker(port);

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          ws.send(JSON.stringify({ type: 'stderr', jobId: msg.jobId, data: 'warning: something\n' }));
          ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
        }
      });

      const worker = getWorker();
      const result = await worker.exec({ cmd: 'test', args: [], cwd: '/tmp', env: {} });
      expect(result.stderr.includes('warning: something')).toBeTruthy();

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('rejects when worker disconnects mid-job', async () => {
      const ws = await connectWorker(port);

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          ws.close();
        }
      });

      const worker = getWorker();
      await expect(
        () => worker.exec({ cmd: 'test', args: [], cwd: '/tmp', env: {} })
      ).rejects.toThrow(/disconnect/i);

      // Wait for reconnect timer to fire and clean up re-queued jobs
      await new Promise((r) => setTimeout(r, 700));
    });

    it('queues second job while first is running', async () => {
      const ws = await connectWorker(port);
      const jobOrder = [];

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          jobOrder.push(msg.jobId);
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
          }, 50);
        }
      });

      const worker = getWorker();
      const [r1, r2] = await Promise.all([
        worker.exec({ cmd: 'job1', args: [], cwd: '/tmp', env: {} }),
        worker.exec({ cmd: 'job2', args: [], cwd: '/tmp', env: {} }),
      ]);

      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      expect(jobOrder.length).toBe(2);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('heartbeat', () => {
    it('marks worker disconnected on missed pong', async () => {
      const ws = await connectWorker(port);
      expect(getWorker()).toBeTruthy();

      // Don't respond to pings — wait for timeout
      // pingInterval=500ms, pongTimeout=200ms → disconnect at ~700ms
      // Use 1500ms for CI safety margin
      await new Promise((r) => setTimeout(r, 1500));
      expect(getWorker()).toBe(null);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('enqueueJob()', () => {
    // Ensure previous test's worker is fully disconnected before each test
    beforeEach(async () => {
      let retries = 0;
      while (getWorkerStatus().connected && retries++ < 20) {
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    it('queues a job even when no worker is connected', async () => {
      const depth = getQueueDepth();
      expect(depth.depth).toBe(0);

      const jobPromise = enqueueJob({ cmd: 'echo', args: ['test'], cwd: '/tmp', env: {} });
      expect(jobPromise instanceof Promise).toBeTruthy();

      const depthAfter = getQueueDepth();
      expect(depthAfter.depth).toBe(1);
      expect(depthAfter.pending).toBe(1);
      expect(depthAfter.active).toBe(0);
      expect(depthAfter.workerConnected).toBe(false);

      // Connect manually: attach exec handler before register so we catch
      // the job that dispatchNext() sends synchronously on registration.
      const ws = await new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
        sock.on('open', () => {
          sock.on('message', (raw) => {
            const msg = JSON.parse(raw);
            if (msg.type === 'welcome') {
              sock.send(JSON.stringify({ type: 'register', hostname: 'test-pc', gpu: 'RTX Test' }));
              return;
            }
            if (msg.type === 'ping') {
              sock.send(JSON.stringify({ type: 'pong' }));
              return;
            }
            if (msg.type === 'exec') {
              sock.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
              sock.send(JSON.stringify({ type: 'stdout', jobId: msg.jobId, data: 'output\n' }));
              sock.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
            }
          });
          resolve(sock);
        });
        sock.on('error', reject);
      });

      const result = await jobPromise;
      expect(result.code).toBe(0);
      expect(result.stdout.includes('output')).toBeTruthy();

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('dispatches immediately if worker is already connected', async () => {
      const ws = await connectWorker(port);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
        }
      });

      const result = await enqueueJob({ cmd: 'test', args: [], cwd: '/tmp', env: {} });
      expect(result.code).toBe(0);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('supports onStdout callback', async () => {
      const ws = await connectWorker(port);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          ws.send(JSON.stringify({ type: 'stdout', jobId: msg.jobId, data: 'line1\n' }));
          ws.send(JSON.stringify({ type: 'stdout', jobId: msg.jobId, data: 'line2\n' }));
          ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
        }
      });

      const chunks = [];
      const result = await enqueueJob(
        { cmd: 'test', args: [], cwd: '/tmp', env: {} },
        { onStdout: (data) => chunks.push(data) }
      );
      expect(result.code).toBe(0);
      expect(chunks.length).toBe(2);
      expect(chunks[0].includes('line1')).toBeTruthy();

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('getQueueDepth()', () => {
    it('returns zeros when queue is empty and no worker', () => {
      const depth = getQueueDepth();
      expect(depth.depth).toBe(0);
      expect(depth.pending).toBe(0);
      expect(depth.active).toBe(0);
      expect(depth.workerConnected).toBe(false);
    });

    it('shows active=1 when a job is executing', async () => {
      const ws = await connectWorker(port);
      let resolveExec;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          resolveExec = () => {
            ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
          };
        }
      });

      const jobPromise = enqueueJob({ cmd: 'slow', args: [], cwd: '/tmp', env: {} });
      await new Promise((r) => setTimeout(r, 100));

      const depth = getQueueDepth();
      expect(depth.active).toBe(1);
      expect(depth.workerConnected).toBe(true);

      resolveExec();
      await jobPromise;

      const depthAfter = getQueueDepth();
      expect(depthAfter.depth).toBe(0);
      expect(depthAfter.pending).toBe(0);
      expect(depthAfter.active).toBe(0);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    });
  });
});

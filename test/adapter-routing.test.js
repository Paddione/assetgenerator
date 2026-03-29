/**
 * Adapter Routing Tests
 *
 * Tests that GPU adapters route to worker when connected,
 * and throw when disconnected. Cloud adapters always run locally.
 *
 * Run: cd Assetgenerator && npx vitest run test/adapter-routing.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { initWorkerManager, getWorker, shutdownWorkerManager } from '../worker-manager.js';

function createTestServer() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function connectWorker(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
    ws.on('open', () => {
      ws.once('message', (raw) => {
        const msg = JSON.parse(raw);
        expect(msg.type).toBe('welcome');
        ws.send(JSON.stringify({ type: 'register', hostname: 'test', gpu: 'Test GPU' }));
        setTimeout(() => resolve(ws), 50);
      });
    });
    ws.on('error', reject);
  });
}

describe('Adapter Routing', () => {
  let httpServer, port;

  beforeAll(async () => {
    ({ server: httpServer, port } = await createTestServer());
    initWorkerManager(httpServer);
  });

  afterAll(async () => {
    shutdownWorkerManager();
    await new Promise((r) => httpServer.close(r));
  });

  it('getWorker() returns exec-capable proxy when worker connected', async () => {
    const ws = await connectWorker(port);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'exec') {
        ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
        ws.send(JSON.stringify({ type: 'stdout', jobId: msg.jobId, data: 'SEED:99999\n' }));
        ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
      }
    });

    const worker = getWorker();
    expect(worker).toBeTruthy();
    const result = await worker.exec({ cmd: 'python3', args: ['test.py'], cwd: '/tmp', env: {} });
    expect(result.code).toBe(0);
    expect(result.stdout.includes('SEED:99999')).toBeTruthy();

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('getWorker() returns null when no worker — adapter should throw', async () => {
    const worker = getWorker();
    expect(worker).toBe(null);
  });

  it('exec message has correct shape', async () => {
    const ws = await connectWorker(port);
    const execReceived = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'exec') {
          ws.send(JSON.stringify({ type: 'ack', jobId: msg.jobId }));
          ws.send(JSON.stringify({ type: 'exit', jobId: msg.jobId, code: 0 }));
          resolve(msg);
        }
      });
    });

    const worker = getWorker();
    worker.exec({ cmd: 'python3', args: ['--version'], cwd: '/home/test', env: { CUDA: '0' } });
    const msg = await execReceived;

    expect(msg.type).toBe('exec');
    expect(msg.jobId).toBeTruthy();
    expect(msg.cmd).toBe('python3');
    expect(msg.args).toEqual(['--version']);
    expect(msg.cwd).toBe('/home/test');
    expect(msg.env).toEqual({ CUDA: '0' });

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

/**
 * GPU Worker Client Tests
 *
 * Tests the worker CLI that connects to the server and executes commands.
 * Uses a mock WebSocket server — no real server or GPU needed.
 *
 * Run: cd Assetgenerator/worker && node --test test/worker.test.js
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createWorker } from '../index.js';

function createMockServer() {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, '127.0.0.1', () => {
      const port = httpServer.address().port;
      resolve({ httpServer, wss, port });
    });
  });
}

describe('GPU Worker', () => {
  let mockServer, wss, port;

  before(async () => {
    ({ httpServer: mockServer, wss, port } = await createMockServer());
  });

  after(async () => {
    wss.close();
    await new Promise((r) => mockServer.close(r));
  });

  it('connects, receives welcome, sends register', async () => {
    const registered = new Promise((resolve) => {
      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type === 'register') resolve(msg);
        });
      });
    });

    const worker = createWorker({ url: `ws://127.0.0.1:${port}`, reconnectDelay: 100 });
    const msg = await registered;

    assert.equal(msg.type, 'register');
    assert.ok(msg.hostname);
    assert.ok(msg.gpu);

    worker.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('spawns process on exec and streams stdout back', async () => {
    const exitReceived = new Promise((resolve) => {
      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
        const messages = [];
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          messages.push(msg);
          if (msg.type === 'register') {
            ws.send(JSON.stringify({
              type: 'exec',
              jobId: 'test-1',
              cmd: 'echo',
              args: ['hello world'],
              cwd: '/tmp',
              env: {},
            }));
          }
          if (msg.type === 'exit') resolve(messages);
        });
      });
    });

    const worker = createWorker({ url: `ws://127.0.0.1:${port}`, reconnectDelay: 100 });
    const messages = await exitReceived;

    const ack = messages.find((m) => m.type === 'ack');
    assert.ok(ack);
    assert.equal(ack.jobId, 'test-1');

    const stdout = messages.filter((m) => m.type === 'stdout');
    const combined = stdout.map((m) => m.data).join('');
    assert.ok(combined.includes('hello world'));

    const exit = messages.find((m) => m.type === 'exit');
    assert.equal(exit.code, 0);

    worker.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('responds to ping with pong', async () => {
    const pongReceived = new Promise((resolve) => {
      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type === 'register') {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
          if (msg.type === 'pong') resolve(msg);
        });
      });
    });

    const worker = createWorker({ url: `ws://127.0.0.1:${port}`, reconnectDelay: 100 });
    const msg = await pongReceived;
    assert.equal(msg.type, 'pong');

    worker.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('kills process on cancel', async () => {
    const exitReceived = new Promise((resolve) => {
      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type === 'register') {
            ws.send(JSON.stringify({
              type: 'exec',
              jobId: 'cancel-test',
              cmd: 'sleep',
              args: ['30'],
              cwd: '/tmp',
              env: {},
            }));
          }
          if (msg.type === 'ack') {
            setTimeout(() => {
              ws.send(JSON.stringify({ type: 'cancel', jobId: 'cancel-test' }));
            }, 100);
          }
          if (msg.type === 'exit') resolve(msg);
        });
      });
    });

    const worker = createWorker({ url: `ws://127.0.0.1:${port}`, reconnectDelay: 100 });
    const exit = await exitReceived;

    assert.notEqual(exit.code, 0);
    assert.equal(exit.jobId, 'cancel-test');

    worker.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  describe('idle timeout', () => {
    it('exits after IDLE_TIMEOUT_MS with no jobs', async () => {
      const exitPromise = new Promise((resolve) => {
        const originalExit = process.exit;
        process.exit = (code) => {
          process.exit = originalExit;
          resolve(code);
        };
      });

      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type === 'register') { /* registered, no jobs sent */ }
        });
      });

      const worker = createWorker({
        url: `ws://127.0.0.1:${port}`,
        reconnectDelay: 100,
        idleTimeoutMs: 200,
      });

      const exitCode = await exitPromise;
      assert.equal(exitCode, 0);
      worker.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('resets idle timer on job completion', async () => {
      let exitCalled = false;
      const originalExit = process.exit;
      process.exit = () => { exitCalled = true; process.exit = originalExit; };

      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type === 'register') {
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'exec', jobId: 'idle-test', cmd: 'echo', args: ['hi'], cwd: '/tmp', env: {},
              }));
            }, 100);
          }
          if (msg.type === 'exit') {
            setTimeout(() => {
              assert.equal(exitCalled, false, 'Should not have exited — timer was reset');
              process.exit = originalExit;
            }, 150);
          }
        });
      });

      const worker = createWorker({
        url: `ws://127.0.0.1:${port}`,
        reconnectDelay: 100,
        idleTimeoutMs: 400,
      });

      await new Promise((r) => setTimeout(r, 350));
      worker.close();
    });

    it('keeps ticking across reconnect cycles', async () => {
      const exitPromise = new Promise((resolve) => {
        const originalExit = process.exit;
        process.exit = (code) => {
          process.exit = originalExit;
          resolve(code);
        };
      });

      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type === 'register') {
            setTimeout(() => ws.close(), 50);
          }
        });
      });

      wss.once('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'welcome', serverVersion: '1.0' }));
      });

      const worker = createWorker({
        url: `ws://127.0.0.1:${port}`,
        reconnectDelay: 50,
        idleTimeoutMs: 300,
      });

      const exitCode = await exitPromise;
      assert.equal(exitCode, 0);
      worker.close();
      await new Promise((r) => setTimeout(r, 100));
    });
  });
});

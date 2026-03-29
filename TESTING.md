# Assetgenerator Testing Guide

Testing guide for the Assetgenerator service — usable by human testers (Chrome browser), automated agents (OpenClaw), or AI assistants (Claude).

**Service URL:** `http://localhost:5200` (local) or the deployed instance.

---

## Quick Reference

| Area | How to Test | GPU Required | NAS Required |
|------|-------------|--------------|--------------|
| API CRUD (audio library) | REST calls | No | No (uses local fallback) |
| API CRUD (visual library) | REST calls | No | No (uses local fallback) |
| Project scan/sync | REST calls | No | Yes (or mock dir) |
| Audio generation | SSE stream | Yes (AudioCraft) or No (ElevenLabs/Suno) |Yes |
| Visual pipeline | SSE stream | Yes (ComfyUI/Diffusers/Blender) | Yes |
| Worker connection | WebSocket | Yes (GPU worker) | No |
| Frontend UI | Browser | No | No |
| Prerequisites check | REST call | No | No |

---

## 1. Prerequisites & Startup

### 1.1 Start the Server

```bash
cd Assetgenerator && node server.js --project arena
```

The server listens on port 5200. Verify with:

```bash
curl -s http://localhost:5200/api/prerequisites | jq .
```

Expected response:
```json
{
  "python": true,
  "ffmpeg": true,
  "cuda": true,
  "pythonPath": "/usr/bin/python3"
}
```

> **Note:** `cuda: false` is expected on machines without NVIDIA GPUs. This disables local GPU backends (AudioCraft, ComfyUI, Diffusers, TripoSR, Blender) but cloud backends still work.

### 1.2 Check Available Backends

```bash
curl -s http://localhost:5200/api/backends | jq .
```

Each backend has `enabled: true/false`. Cloud backends also show `requiresEnv` — if the env var is missing, generation calls will fail for that backend.

### 1.3 Check Worker Status

```bash
curl -s http://localhost:5200/api/worker-status | jq .
```

Returns `{ "connected": true/false, "hostname": "...", "gpu": "..." }`. If no GPU worker is connected, local GPU jobs will queue indefinitely.

---

## 2. API Testing — Audio Library

The audio library is the centralized store at `library.json`. All mutations are safe — they modify JSON files, not external systems (generation is a separate step).

### 2.1 List All Audio Assets

```bash
curl -s http://localhost:5200/api/library | jq '.[0]'
```

Verify: returns array of objects with `id`, `name`, `category`, `prompt`, `backend`, `filePath`, `assignedTo`.

### 2.2 Create a Test Sound

```bash
curl -s -X POST http://localhost:5200/api/library \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "test_sound_001",
    "name": "Test Sound",
    "category": "sfx/ui",
    "tags": ["test"],
    "prompt": "short beep, digital notification, clean",
    "duration": 0.5,
    "backend": "audiocraft"
  }' | jq .
```

**Expected:** 201 with the created asset object.
**Failure modes:** 409 if `id` already exists.

### 2.3 Update a Sound

```bash
curl -s -X PUT http://localhost:5200/api/library/test_sound_001 \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "updated prompt text", "flagged": true}' | jq .
```

**Verify:** Response shows updated fields. Re-fetch to confirm persistence.

### 2.4 Assign to Project

```bash
curl -s -X POST http://localhost:5200/api/library/test_sound_001/assign \
  -H 'Content-Type: application/json' \
  -d '{"project": "arena", "targetPath": "sfx/test_sound_001"}' | jq .
```

**Verify:** Asset's `assignedTo` now includes `arena` key.

### 2.5 Unassign from Project

```bash
curl -s -X POST http://localhost:5200/api/library/test_sound_001/unassign \
  -H 'Content-Type: application/json' \
  -d '{"project": "arena"}' | jq .
```

### 2.6 Delete Test Sound

```bash
curl -s -X DELETE http://localhost:5200/api/library/test_sound_001 | jq .
```

**Verify:** Subsequent GET returns 404 for that ID.

### 2.7 Stream Audio Playback

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5200/api/library/<existing-id>/audio
```

**Expected:** 200 with `Content-Type: audio/wav`. Returns 404 if the WAV file doesn't exist on NAS.

---

## 3. API Testing — Visual Library

The visual library tracks assets through a 4-phase pipeline: concept → model → render → pack.

### 3.1 List Visual Assets

```bash
curl -s http://localhost:5200/api/visual-library | jq '.[0]'
```

Verify: returns array with `id`, `name`, `category`, `prompt`, `poses`, `directions`, `pipeline` (with phase statuses).

### 3.2 Create a Visual Asset

```bash
curl -s -X POST http://localhost:5200/api/visual-library \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "test_char_001",
    "name": "Test Character",
    "category": "characters",
    "tags": ["test"],
    "prompt": "robot soldier, metallic armor, blue visor",
    "poses": ["stand", "gun"],
    "directions": 8,
    "size": 64,
    "color": "#00ff00",
    "conceptBackend": "comfyui"
  }' | jq .
```

**Expected:** 201 with pipeline phases all set to `"pending"`.

### 3.3 Check Single Asset Detail

```bash
curl -s http://localhost:5200/api/visual-library/test_char_001 | jq .pipeline
```

**Expected:** `{ "concept": {"status":"pending"}, "model": {"status":"pending"}, "render": {"status":"pending"}, "pack": {"status":"pending"} }`

### 3.4 Serve Concept Image (After Generation)

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5200/api/visual-library/<id>/concept
```

Returns 200 with PNG if concept exists, 404 otherwise.

### 3.5 List Rendered Frames

```bash
curl -s http://localhost:5200/api/visual-library/<id>/renders | jq .
```

Returns array of frame filenames after render phase completes.

### 3.6 Delete Test Asset

```bash
curl -s -X DELETE http://localhost:5200/api/visual-library/test_char_001 | jq .
```

Also cleans up NAS files for that asset.

---

## 4. Generation Testing (SSE Streams)

Generation endpoints return **Server-Sent Events (SSE)**. These are the core workflow tests.

### 4.1 Single Audio Generation

```bash
curl -N http://localhost:5200/api/library/<id>/generate
```

**SSE event sequence:**
```
data: {"type":"progress","message":"Generating...","asset":"<id>"}
data: {"type":"progress","message":"Processing audio..."}
data: {"type":"done","asset":"<id>","seed":1234567890}
```

**Error case:**
```
data: {"type":"error","message":"Worker not connected","asset":"<id>"}
```

> **Automated testing tip:** Parse SSE lines, assert the stream contains a `done` or `error` event within a timeout (60s for AudioCraft, 120s for Suno music).

### 4.2 Batch Audio Regeneration (Flagged)

First flag some assets, then:

```bash
curl -N -X POST http://localhost:5200/api/library/regenerate-flagged
```

Emits progress events per asset. Watch for `batch-done` at the end.

### 4.3 Visual Pipeline Batch Generation

```bash
curl -N -X POST http://localhost:5200/api/visual-library/batch/generate \
  -H 'Content-Type: application/json' \
  -d '{"ids": ["test_char_001"], "fromPhase": "concept"}'
```

**SSE event sequence per phase:**
```
data: {"type":"progress","phase":"concept","asset":"test_char_001","message":"Generating concept..."}
data: {"type":"phase-done","phase":"concept","asset":"test_char_001"}
data: {"type":"progress","phase":"model","asset":"test_char_001","message":"Generating 3D model..."}
data: {"type":"phase-done","phase":"model","asset":"test_char_001"}
...
data: {"type":"done","asset":"test_char_001"}
```

**Phase skipping:** Use `fromPhase: "render"` to skip concept+model if they're already done.

### 4.4 SSE Testing Pattern (for Automation)

For OpenClaw or scripted testing, here's a Node.js pattern to consume SSE:

```javascript
async function consumeSSE(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Accept': 'text/event-stream' } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        events.push(JSON.parse(line.slice(6)));
      }
    }
  }
  return events;
}

// Usage:
const events = await consumeSSE('http://localhost:5200/api/library/<id>/generate');
const lastEvent = events[events.length - 1];
assert(lastEvent.type === 'done' || lastEvent.type === 'error');
```

---

## 5. Project Operations

### 5.1 List Projects

```bash
curl -s http://localhost:5200/api/projects | jq .
```

### 5.2 Scan Project Audio

```bash
curl -s -X POST http://localhost:5200/api/projects/arena/scan | jq .
```

Reads files from the project's audio directory and updates the project manifest. Returns updated sound list.

### 5.3 Sync Library → Project

```bash
curl -s -X POST http://localhost:5200/api/projects/arena/sync | jq .
```

Copies assigned library assets to the project's output directory. Requires NAS access.

---

## 6. Frontend / Browser Testing

Open `http://localhost:5200` in Chrome (or any browser).

### 6.1 Smoke Test Checklist

| # | Check | How | Expected |
|---|-------|-----|----------|
| 1 | Page loads | Navigate to `/` | Cyberpunk-themed UI with header, tabs, project selector |
| 2 | Worker indicator | Top-left dot | Green = connected, Gray = disconnected |
| 3 | Tab switching | Click "Audio" / "Visual" | Containers swap visibility, active tab highlighted cyan |
| 4 | Project selector | Dropdown in header | Lists available projects (arena, l2p, etc.) |
| 5 | Audio library loads | Audio tab active | Grid of sound cards with play buttons |
| 6 | Audio playback | Click play button on a card | Audio plays in browser (requires WAV file on NAS) |
| 7 | Visual library loads | Visual tab active | Grid of visual asset cards with pipeline status |
| 8 | Concept preview | Click visual asset card | Shows concept image if generated |
| 9 | Logs panel | Click "Logs" at bottom | Expandable panel showing SSE event history |
| 10 | Status bar | Trigger a generation | Shows progress message + elapsed time |

### 6.2 Audio Workflow (Browser)

1. Switch to **Audio** tab
2. Click **"Add Sound"** → fill form (id, name, category, prompt, backend)
3. Verify card appears in the grid
4. Click **flag icon** on the card → card shows flagged state
5. Click **"Regenerate Flagged"** → status bar shows progress
6. Wait for completion → card updates with timestamp
7. Click **play** → audio plays

### 6.3 Visual Workflow (Browser)

1. Switch to **Visual** tab
2. Click **"Add Asset"** → fill form (id, name, category, prompt, poses)
3. Verify card appears with all pipeline phases showing "pending"
4. Select the asset → click **"Generate"** with phase selector
5. Watch status bar for SSE progress events
6. After concept phase: concept thumbnail appears on card
7. After all phases: sprite atlas preview available

### 6.4 Error Scenarios to Test

| Scenario | Trigger | Expected Behavior |
|----------|---------|-------------------|
| No worker connected | Generate with GPU backend | Error SSE event, status shows "Worker not connected" |
| Duplicate ID | Create asset with existing ID | 409 response, UI shows error message |
| Missing API key | Generate with cloud backend (no env var) | Error event with clear message |
| NAS unavailable | Generate when `/mnt/pve3a/` unmounted | Error during file write, asset stays in previous state |
| Invalid category | Create with unknown category | Server validation error |
| Empty prompt | Create with blank prompt field | Validation prevents or generation fails |

---

## 7. WebSocket Worker Testing

The worker protocol uses WebSocket at `/ws/worker`. This is an advanced test — primarily useful for verifying the worker manager logic.

### 7.1 Simulate Worker Connection

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:5200/ws/worker');

ws.on('open', () => {
  // Register as a worker
  ws.send(JSON.stringify({
    type: 'register',
    hostname: 'test-worker',
    gpu: 'Test GPU'
  }));
  console.log('Registered as worker');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'exec') {
    console.log('Received job:', msg.cmd, msg.args);
    // Simulate job completion
    ws.send(JSON.stringify({ type: 'stdout', data: 'Processing...\n' }));
    ws.send(JSON.stringify({ type: 'exit', code: 0 }));
  }
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
});
```

### 7.2 Worker Status After Connection

```bash
curl -s http://localhost:5200/api/worker-status | jq .
# Expected: { "connected": true, "hostname": "test-worker", "gpu": "Test GPU" }
```

### 7.3 Worker Disconnection Recovery

1. Connect mock worker
2. Trigger a generation job
3. Kill the worker connection mid-job
4. Verify: job retries up to 2 times with 60s reconnect window
5. If worker reconnects within window: job resumes
6. If not: job fails with error event

---

## 8. Running Existing Tests

The service has three test files using Node.js built-in `node:test`:

```bash
# Full API test suite (creates temp dirs, no NAS needed)
cd Assetgenerator && node --test test/api.test.js

# Worker manager unit tests
cd Assetgenerator && node --test test/worker-manager.test.js

# Adapter routing tests
cd Assetgenerator && node --test test/adapter-routing.test.js

# Run all tests
cd Assetgenerator && node --test test/*.test.js
```

> **Important:** `api.test.js` starts its own server instance on a random port and uses temp directories to simulate NAS storage. It backs up and restores `library.json` / `visual-library.json` after each run. These tests are safe to run against the live codebase.

---

## 9. Automated Test Scenarios (OpenClaw / CI)

These are end-to-end scenarios suitable for automated testing. Each is self-contained (creates test data, verifies, cleans up).

### Scenario 1: Audio CRUD Lifecycle

```
1. POST /api/library          → create test sound (201)
2. GET  /api/library           → verify sound appears in list
3. PUT  /api/library/:id       → update prompt (200)
4. GET  /api/library/:id/audio → 404 (no WAV yet)
5. POST /api/library/:id/assign → assign to arena (200)
6. GET  /api/library           → verify assignedTo includes arena
7. POST /api/library/:id/unassign → unassign (200)
8. DELETE /api/library/:id     → cleanup (200)
9. GET  /api/library           → verify sound removed
```

**Pass criteria:** All status codes match. No 500 errors. State is consistent after each mutation.

### Scenario 2: Visual CRUD Lifecycle

```
1. POST /api/visual-library      → create test character (201)
2. GET  /api/visual-library/:id   → verify pipeline phases all "pending"
3. PUT  /api/visual-library/:id   → update prompt (200)
4. GET  /api/visual-library/:id/concept → 404 (no concept yet)
5. GET  /api/visual-library/:id/renders → empty array
6. DELETE /api/visual-library/:id → cleanup (200)
```

### Scenario 3: Audio Generation (Cloud Backend)

Requires `ELEVENLABS_API_KEY` or `SUNO_API_KEY` set.

```
1. POST /api/library            → create test sound with backend "elevenlabs"
2. GET  /api/library/:id/generate (SSE) → consume stream
3. Assert: stream contains "done" event with seed
4. GET  /api/library/:id/audio  → 200 (WAV file exists)
5. DELETE /api/library/:id      → cleanup
```

**Timeout:** 60s for ElevenLabs, 180s for Suno (music generation is slow).

### Scenario 4: Visual Concept Generation (Cloud Backend)

Requires `SILICONFLOW_API_KEY` or Gemini API key.

```
1. POST /api/visual-library       → create test asset with conceptBackend "siliconflow"
2. POST /api/visual-library/batch/generate (SSE)
   body: {"ids": ["<id>"], "fromPhase": "concept"}
3. Assert: stream contains "phase-done" for concept
4. GET  /api/visual-library/:id/concept → 200 (PNG exists)
5. DELETE /api/visual-library/:id  → cleanup
```

### Scenario 5: Project Sync Integrity

```
1. POST /api/library              → create test sound
2. POST /api/library/:id/assign   → assign to arena
3. POST /api/projects/arena/sync  → sync
4. Verify: file exists at project output path
5. POST /api/library/:id/unassign → unassign
6. DELETE /api/library/:id        → cleanup
```

### Scenario 6: Concurrent Mutation Safety

```
1. POST /api/library → create 3 test sounds in parallel
2. Verify: all 3 appear in GET /api/library
3. PUT all 3 in parallel (different prompts)
4. Verify: all 3 have updated prompts
5. DELETE all 3 in parallel
6. Verify: none appear in GET /api/library
```

Tests the JSON file locking mechanism (concurrent writes must not corrupt `library.json`).

---

## 10. Health Check Endpoints

For monitoring (post-deploy verification):

| Check | Command | Healthy |
|-------|---------|---------|
| Server alive | `curl -s -o /dev/null -w "%{http_code}" http://localhost:5200/` | 200 |
| API responding | `curl -s http://localhost:5200/api/prerequisites \| jq .python` | `true` |
| Library readable | `curl -s http://localhost:5200/api/library \| jq 'length'` | > 0 |
| Visual lib readable | `curl -s http://localhost:5200/api/visual-library \| jq 'length'` | > 0 |
| Worker connected | `curl -s http://localhost:5200/api/worker-status \| jq .connected` | `true` (if GPU available) |
| Backends loaded | `curl -s http://localhost:5200/api/backends \| jq 'length'` | > 0 |

---

## 11. Common Failure Modes & Debugging

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `ENOENT` on generate | NAS not mounted at `/mnt/pve3a/` | Mount NAS or create local dirs |
| `Worker not connected` | No GPU worker running | Start worker or use cloud backend |
| `ECONNREFUSED :8188` | ComfyUI not running | Start ComfyUI or switch to diffusers/cloud |
| `ffmpeg not found` | FFmpeg not installed | `apt install ffmpeg` |
| `CUDA not available` | No NVIDIA GPU or drivers | Use cloud backends only |
| SSE stream hangs | Job queued but no worker | Connect worker or kill request |
| `409 Conflict` on create | Asset ID already exists | Use unique ID or delete existing |
| Audio 404 | WAV not generated yet | Run generation first |
| Visual concept 404 | Concept phase not run | Run batch generate from "concept" |

---

## 12. Test Data Cleanup

Always clean up test data after automated runs:

```bash
# Delete any test assets (by convention, prefix test IDs with "test_")
for id in $(curl -s http://localhost:5200/api/library | jq -r '.[] | select(.id | startswith("test_")) | .id'); do
  curl -s -X DELETE "http://localhost:5200/api/library/$id"
done

for id in $(curl -s http://localhost:5200/api/visual-library | jq -r '.[] | select(.id | startswith("test_")) | .id'); do
  curl -s -X DELETE "http://localhost:5200/api/visual-library/$id"
done
```

> **Convention:** Always prefix test asset IDs with `test_` so cleanup scripts can target them without touching real data.

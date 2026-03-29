# Assetgenerator — CLAUDE.md

## Overview

Multi-phase AI asset generation service for Arena and L2P. Express API + WebSocket server orchestrating audio and visual asset generation across local GPU and cloud backends. No database — JSON state files + NAS storage.

**Documentation references:**
- This file -- Quick start, commands
- [docs/services/assetgenerator.md](../docs/services/assetgenerator.md) -- Deep dive: GPU worker, pipelines, API
- [docs/guides/deployment.md](../docs/guides/deployment.md) -- Deployment to k3s

## Architecture

- **Server**: Express.js (Node 22 ESM), port 5200, single-file (`server.js`)
- **Worker**: Remote GPU daemon on WSL2 machine (10.10.0.3), connects via WebSocket
- **Storage**: NAS-backed PVs at `/mnt/pve3a/audio-library` and `/mnt/pve3a/visual-library`
- **KEDA**: Auto-scales gpu-waker pod (0→1) based on queue depth to wake GPU worker via SSH

## GPU Worker System

The GPU worker is an **external machine** (10.10.0.3), not a k8s node. The wakeup chain:

1. Job enqueued → `/api/queue-depth` returns depth ≥ 1
2. KEDA scales gpu-waker pod 0→1 (polls every 30s)
3. gpu-waker SSH's to `patrick@10.10.0.3:2222` → `systemctl --user start gpu-worker`
4. Worker connects to `wss://assetgen.korczewski.de/ws/worker`
5. Worker registers with hostname + GPU info
6. Server dispatches queued jobs

### Checking GPU Worker Availability

Before dispatching GPU-dependent generation, ALWAYS check worker status:

```bash
# From inside cluster or via curl
curl -s https://assetgen.korczewski.de/api/worker-status
# Returns: { "connected": true/false, "hostname": "...", "gpu": "NVIDIA RTX 5070 Ti", "currentJob": null }

curl -s https://assetgen.korczewski.de/api/queue-depth
# Returns: { "depth": 0, "pending": 0, "active": 0, "workerConnected": true/false }

curl -s https://assetgen.korczewski.de/api/prerequisites
# Returns: { "python": true/false, "ffmpeg": true/false, "cuda": true/false }
```

### If GPU Worker Is NOT Connected

1. **Try to wake it**: The KEDA auto-scaler wakes the worker when jobs are enqueued. Simply enqueue the job and wait up to 90 seconds for the worker to connect.
2. **Manual wake**: `ssh patrick@10.10.0.3 -p 2222 'systemctl --user start gpu-worker'`
3. **If still unavailable**: Warn the user that GPU worker is offline. The following adapters REQUIRE GPU and will fail without it:
   - `audiocraft` (audio generation)
   - `comfyui` (concept art)
   - `diffusers` (concept art)
   - `triposr` (3D model generation)
   - `blender` (sprite rendering)
4. **Cloud fallback adapters** that work WITHOUT GPU:
   - `elevenlabs` (audio — needs `ELEVENLABS_API_KEY`)
   - `suno` (music — needs `SUNO_API_KEY`)
   - `siliconflow` (concept art — cloud API)
   - `gemini-imagen` (concept art — cloud API)
   - `meshy` (3D models — cloud API)
   - `packer` (atlas packing — CPU only)
5. **Inform the user**: "GPU worker is unavailable. Generation will use cloud API fallbacks where available. GPU-only phases (AudioCraft, ComfyUI, TripoSR, Blender) will fail. Cloud adapters (SiliconFlow, Gemini Imagen, Meshy, ElevenLabs) will be used instead."

## Generating Assets — Required Information

### Audio Assets

When asked to generate audio, collect these details before calling the API:

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `id` | Yes | Unique sound ID (snake_case) | `gunshot_rifle`, `music_lobby` |
| `name` | Yes | Display name | `Rifle Gunshot` |
| `category` | Yes | `sfx_*` or `music_*` | `sfx_weapons`, `music_lobby` |
| `prompt` | Yes | Generation prompt for AI | `"Short punchy rifle gunshot, military, close range"` |
| `duration` | No | Duration in seconds (default varies) | `2` for SFX, `30` for music |
| `backend` | No | Backend override | `audiocraft` (GPU), `elevenlabs` (cloud), `suno` (music cloud) |

**API calls:**
```bash
# Add to library
curl -X POST https://assetgen.korczewski.de/api/library \
  -H 'Content-Type: application/json' \
  -d '{"id":"gunshot_rifle","name":"Rifle Gunshot","category":"sfx_weapons","prompt":"Short punchy rifle gunshot","duration":2}'

# Generate (returns SSE stream)
curl -X POST https://assetgen.korczewski.de/api/library/gunshot_rifle/generate

# Assign to project
curl -X POST https://assetgen.korczewski.de/api/library/gunshot_rifle/assign \
  -H 'Content-Type: application/json' \
  -d '{"project":"arena","slot":"gunshot_rifle"}'
```

### Visual Assets

When asked to generate visual assets, collect these details:

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `id` | Yes | Unique asset ID (snake_case) | `soldier_basic`, `ak47` |
| `name` | Yes | Display name | `Basic Soldier` |
| `category` | Yes | `characters`, `weapons`, `items`, `tiles`, `cover`, `ui` | `characters` |
| `prompt` | Yes | Concept art prompt | `"Low-poly soldier, tactical gear, isometric game sprite"` |
| `tags` | No | Tags array | `["arena", "combat"]` |
| `poses` | No | Override default poses | `["stand", "gun", "reload"]` |
| `directions` | No | Override directions (1 or 8) | `8` for characters |
| `size` | No | Sprite size in px | `64` for characters, `32` for items |
| `conceptBackend` | No | Override concept backend | `comfyui`, `gemini-imagen`, `siliconflow` |
| `modelBackend` | No | Override model backend | `meshy`, `hyper3d`, `hunyuan3d`, `triposr`, `sketchfab` |
| `sketchfabUid` | No | Sketchfab model UID (for sourcing) | `abc123def456` |
| `weaponModel` | No | Path to weapon GLB (replaces procedural geometry) | `models/weapons/rifle.glb` |

**Visual pipeline phases:** `concept` → `model` → `render` → `pack` (or `full` for all)

**API calls:**
```bash
# Create visual asset
curl -X POST https://assetgen.korczewski.de/api/visual-library \
  -H 'Content-Type: application/json' \
  -d '{"id":"soldier_basic","name":"Basic Soldier","category":"characters","prompt":"Low-poly soldier, tactical gear, isometric"}'

# Generate single phase (returns SSE stream)
curl -X POST https://assetgen.korczewski.de/api/visual-library/soldier_basic/generate/concept
curl -X POST https://assetgen.korczewski.de/api/visual-library/soldier_basic/generate/model
curl -X POST https://assetgen.korczewski.de/api/visual-library/soldier_basic/generate/full

# Batch generate multiple assets
curl -X POST https://assetgen.korczewski.de/api/visual-library/batch/generate \
  -H 'Content-Type: application/json' \
  -d '{"ids":["soldier_basic","ak47"],"fromPhase":"concept"}'

# Assign to project
curl -X POST https://assetgen.korczewski.de/api/visual-library/soldier_basic/assign \
  -H 'Content-Type: application/json' \
  -d '{"project":"arena","atlas":"characters"}'
```

### Category Defaults

| Category | Directions | Default Poses | Size | 3D |
|----------|-----------|---------------|------|----|
| characters | 8 | stand, gun, machine, reload, hold, silencer | 64px | Yes |
| weapons | 1 | idle | 32px | Yes |
| items | 1 | idle | 32px | Yes |
| tiles | 1 | idle | 32px | No (2D only) |
| cover | 1 | idle | 32px | Yes |
| ui | 1 | idle | 16px | No (2D only) |

### Concept Backend Priority

Fallback chain for concept generation: `comfyui` → `gemini-imagen` → `siliconflow` → `diffusers`

### Model Backend Priority

Fallback chain for 3D model generation (local-first, free by default):

`hunyuan3d-local` (local GPU, free) → `triposr` (local GPU, free) → `meshy` (cloud, paid) → `hyper3d` (cloud, subscription) → `hunyuan3d` (fal.ai, paid)

Per-asset override via `modelBackend` field (same pattern as `conceptBackend`).

### Hunyuan3D Local Setup (GPU Worker)

Self-hosted Hunyuan3D v2.1 on the GPU worker machine (10.10.0.3). Shape-only generation (no textures — needs >21GB VRAM).

```bash
# One-time setup on GPU worker
ssh patrick@10.10.0.3 -p 2222
bash ~/projects/Assetgenerator/scripts/setup-hunyuan3d.sh

# Start/stop the server
systemctl --user start hunyuan3d
systemctl --user stop hunyuan3d

# Check health
curl http://10.10.0.3:8081/health
```

- **Server URL**: `http://10.10.0.3:8081` (override with `HUNYUAN3D_LOCAL_URL` env var)
- **VRAM**: ~10GB shape-only (fits RTX 5070 Ti 16GB)
- **Speed**: ~15-30s per model
- **Requires**: PyTorch nightly with cu128 (for RTX 5070 Ti / Blackwell sm_120)

### Asset Sourcing (Sketchfab / PolyHaven)

For pre-made models (weapons, cover, items), use Sketchfab sourcing instead of AI generation:

```bash
# Search Sketchfab
curl https://assetgen.korczewski.de/api/sketchfab/search?q=rifle&count=10

# Set Sketchfab source on asset (skips concept+model phases, downloads model on next generate)
curl -X POST https://assetgen.korczewski.de/api/visual-library/ak47/source/sketchfab \
  -H 'Content-Type: application/json' -d '{"uid":"sketchfab-model-uid"}'

# Search PolyHaven textures/HDRIs
curl https://assetgen.korczewski.de/api/polyhaven/search?type=textures&categories=metal

# Apply PolyHaven texture to asset
curl -X POST https://assetgen.korczewski.de/api/visual-library/ak47/texture/rusty_metal \
  -H 'Content-Type: application/json' -d '{"resolution":"1k"}'
```

### Blender MCP Interactive Workflow

During Claude Code sessions, Blender MCP tools provide interactive asset creation:
1. `search_sketchfab_models` → find real models
2. `get_sketchfab_model_preview` → visual confirm
3. `download_sketchfab_model` → import into Blender
4. `get_viewport_screenshot` → QA check
5. `execute_blender_code` → export GLB to visual library
6. `generate_hyper3d_model_via_text` → generate 3D directly in scene

### Environment Variables (New)

| Variable | Required For | Description |
|----------|-------------|-------------|
| `HUNYUAN3D_LOCAL_URL` | hunyuan3d-local adapter | Override local server URL (default: `http://10.10.0.3:8081`) |
| `HYPER3D_API_KEY` | hyper3d adapter | Hyper3D Rodin API key (paid subscription) |
| `HUNYUAN3D_API_KEY` or `FAL_KEY` | hunyuan3d adapter | fal.ai API key for Hunyuan3D cloud ($0.16/gen) |
| `SKETCHFAB_API_KEY` | sketchfab adapter | Sketchfab v3 API token (free account) |

**Default pipeline is fully free**: `hunyuan3d-local` + `triposr` need no API keys (just GPU worker running).

## Commands

```bash
npm run dev           # node --watch server.js --project arena (port 5200)
npm run start         # node server.js --project arena
npm run test          # node --test test/api.test.js (49+ API tests)
```

## Deployment

- **URL**: https://assetgen.korczewski.de
- **Deploy**: `./k8s/scripts/deploy/deploy-assetgenerator.sh` (builds server + gpu-waker images)
- **Resources**: 100m-500m CPU, 256Mi-512Mi memory
- **Storage**: SMB-CSI PVs for audio (10Gi) and visual (50Gi) libraries

## Monitoring

- `GET /health` — Basic health (used by k8s probes)
- `GET /api/worker-status` — GPU worker connection state, hostname, GPU name
- `GET /api/queue-depth` — Job queue depth (used by KEDA for auto-scaling)
- `GET /api/prerequisites` — Python, ffmpeg, CUDA availability

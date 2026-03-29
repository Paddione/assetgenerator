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

### Blender MCP Pipeline (Primary)

The asset generator **primarily uses Blender MCP** for model generation and rendering. The `blender-mcp` adapter talks directly to Blender via TCP socket (port 9876) on the GPU machine, bypassing the WebSocket worker layer.

**Architecture:**
```
Server → TCP:9876 → Blender MCP Addon (10.10.0.3) → execute in Blender
                                                    ↕ fallback
Server → WebSocket → GPU Worker → blender --background (CLI)
```

**Pipeline flow with Blender MCP + Figma:**
1. **concept** — Figma (for ui/tiles with `figmaNodeId`) or AI generation (ComfyUI / Gemini Imagen)
2. **model** — `blender-mcp` generates model IN Blender (Hunyuan3D local or Sketchfab), exports GLB
3. **render** — `blender-mcp` spawns headless Blender subprocess via `execute_code`, renders sprites
4. **pack** — unchanged (free-tex-packer-core)

**Fallback chain:** If Blender MCP is unreachable (Blender not running, addon not started), each phase falls back to the next backend in the priority list automatically. The server runs a 5-second `isAvailable()` ping before attempting each MCP operation.

**Checking Blender MCP status:**
```bash
curl -s https://assetgen.korczewski.de/api/blender-mcp/status
# Returns: { "available": true/false, "host": "10.10.0.3", "port": 9876, "name": "Scene", "object_count": N, ... }
```

**Prerequisites for Blender MCP:**
1. Blender running on GPU machine (10.10.0.3) with MCP addon enabled
2. Addon server started (sidebar → BlenderMCP → Start Server)
3. For model generation: Hunyuan3D local server running (`systemctl --user start hunyuan3d`) OR Sketchfab enabled in addon
4. Network connectivity from assetgenerator pod/host to 10.10.0.3:9876

### Blender MCP Interactive Workflow

During Claude Code sessions, Blender MCP tools provide interactive asset creation:
1. `search_sketchfab_models` → find real models
2. `get_sketchfab_model_preview` → visual confirm
3. `download_sketchfab_model` → import into Blender
4. `get_viewport_screenshot` → QA check
5. `execute_blender_code` → export GLB to visual library
6. `generate_hyper3d_model_via_text` → generate 3D directly in scene

### Figma Integration

Figma provides design-system-driven assets as an alternative to AI generation, especially for **UI** and **tiles** categories.

**5 integration points:**

1. **UI concept art** — Export designed Figma components (health bars, buttons, HUD elements) as pixel-perfect PNGs. Replaces AI generation for the concept phase.
2. **Tile concept art** — Pull grid-aligned, seamless tile designs from Figma. Ensures precise tiling geometry.
3. **Reference images** — Designer sketches from Figma become image-to-3D input for the model phase (Hunyuan3D/Hyper3D accept reference images).
4. **Design tokens → accent colors** — Extract fill color styles from Figma and apply them as `asset.color` values for consistent rendering across the pipeline.
5. **Component discovery** — List available Figma components for mapping to visual assets.

**How it works:** Assets with a `figmaNodeId` field are exported from Figma via the REST API. Assets without `figmaNodeId` skip Figma instantly (`BackendSkipError`) and fall through to AI generation — no API call, no delay.

**Setting a Figma source on an asset:**
```bash
# Set Figma node ID on an existing asset
curl -X POST https://assetgen.korczewski.de/api/visual-library/health_bar/figma-source \
  -H 'Content-Type: application/json' -d '{"nodeId":"123:456"}'

# Or include when creating the asset
curl -X POST https://assetgen.korczewski.de/api/visual-library \
  -H 'Content-Type: application/json' \
  -d '{"id":"health_bar","name":"Health Bar","category":"ui","figmaNodeId":"123:456"}'

# Generate — Figma adapter pulls from Figma (no AI generation)
curl -X POST https://assetgen.korczewski.de/api/visual-library/health_bar/generate/concept
```

**Extracting design tokens (colors):**
```bash
# List available color styles
curl -X POST https://assetgen.korczewski.de/api/figma/design-tokens \
  -H 'Content-Type: application/json' -d '{}'
# Returns: { "tokens": { "Primary/Red": { "hex": "#ff3333", "opacity": 1 }, ... } }

# Extract AND apply matching colors to assets
curl -X POST https://assetgen.korczewski.de/api/figma/design-tokens \
  -H 'Content-Type: application/json' -d '{"apply":true}'
```

**Listing Figma components:**
```bash
curl https://assetgen.korczewski.de/api/figma/components
# Returns: { "components": [{ "nodeId": "123:456", "name": "HealthBar", ... }], "count": N }
```

**Checking Figma status:**
```bash
curl https://assetgen.korczewski.de/api/figma/status
# Returns: { "available": true/false, "fileKey": "...", "hasApiKey": true/false }
```

**Prerequisites for Figma integration:**
1. `FIGMA_API_KEY` env var — [Personal Access Token](https://www.figma.com/developers/api#access-tokens)
2. `FIGMA_FILE_KEY` env var — from your Figma file URL: `figma.com/design/<FILE_KEY>/...`
3. Figma nodes organized by category (UI components, tile assets, etc.)

**Interactive Figma MCP (Claude Code sessions):**
The official Figma MCP server is configured in `.mcp.json` for interactive sessions. Use `mcp-figma` tools to browse files, export nodes, and write to canvas. Setup: set `FIGMA_API_KEY` in `.mcp.json` → restart Claude Code → use Figma tools directly.

### Backend Priority Configuration

Priorities are configured in `config/visual-config.json`. Categories can override the global concept priority.

| Phase | Priority | Default Fallback Chain |
|-------|----------|------------------------|
| concept | `conceptBackendPriority` | comfyui → gemini-imagen → siliconflow → diffusers |
| concept (ui) | per-category override | **figma** → comfyui → gemini-imagen → siliconflow |
| concept (tiles) | per-category override | **figma** → comfyui → gemini-imagen → siliconflow |
| model | `modelBackendPriority` | **blender-mcp** → hunyuan3d-local → triposr → meshy → hyper3d → hunyuan3d |
| render | `renderBackendPriority` | **blender-mcp** → blender (CLI via GPU worker) |
| pack | — | packer (always) |

### Environment Variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `FIGMA_API_KEY` | figma adapter | Figma Personal Access Token |
| `FIGMA_FILE_KEY` | figma adapter | Default Figma file key (from URL) |
| `BLENDER_MCP_HOST` | blender-mcp adapter | Override Blender MCP host (default: `10.10.0.3`) |
| `BLENDER_MCP_PORT` | blender-mcp adapter | Override Blender MCP port (default: `9876`) |
| `HUNYUAN3D_LOCAL_URL` | hunyuan3d-local, blender-mcp | Override local server URL (default: `http://10.10.0.3:8081`) |
| `HYPER3D_API_KEY` | hyper3d adapter | Hyper3D Rodin API key (paid subscription) |
| `HUNYUAN3D_API_KEY` or `FAL_KEY` | hunyuan3d adapter | fal.ai API key for Hunyuan3D cloud ($0.16/gen) |
| `SKETCHFAB_API_KEY` | sketchfab adapter | Sketchfab v3 API token (free account) |

**Default pipeline is fully free**: `blender-mcp` + `hunyuan3d-local` need no API keys (just Blender + GPU worker running). Figma integration requires a free Figma account + API token.

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
- `GET /api/blender-mcp/status` — Blender MCP addon reachability + scene info
- `GET /api/figma/status` — Figma API key validity + file key config

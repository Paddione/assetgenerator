# Asset Library Workflows

Four workflows for viewing, browsing, and modifying the asset library. Each suits a different task.

| Workflow | Best For | Requires |
|----------|----------|----------|
| [Web Dashboard](#1-web-dashboard) | Browsing, QA, playback | Browser |
| [Bulk JSON Editing](#2-bulk-json-editing) | Adding/changing many assets at once | Text editor, git |
| [REST API](#3-rest-api) | Single asset tweaks, scripting, CI | curl or HTTP client |
| [Claude Code + Blender MCP](#4-claude-code--blender-mcp) | Creative iteration, 3D QA | Claude Code session, Blender running |

---

## 1. Web Dashboard

**URL**: https://assetgen.korczewski.de

The single-page dashboard provides visual browsing and control over both audio and visual libraries.

### Layout

- **Header**: Project selector, Audio/Visual tab toggle, GPU worker status indicator
- **Action bar**: Scan (re-read filesystem), Sync (push assignments), Regenerate Flagged
- **Filter bar**: All / SFX / Music / Flagged (audio tab) or All / category filters (visual tab)
- **Asset cards**: One per asset with inline controls

### Audio Tab

Each audio asset card shows:
- Name, category, prompt, duration
- Inline audio player (play/pause/scrub)
- Status badge (generated / pending / error)
- Generate button (triggers SSE-streamed generation)
- Flag toggle (mark for regeneration)
- Assignment status (which project slot it occupies)

### Visual Tab

Each visual asset card shows:
- Concept art thumbnail (click to expand)
- Pipeline progress bar: `concept` -> `model` -> `render` -> `pack`
- Per-phase status (done / pending / generating / error)
- Per-phase previews:
  - **concept**: Full-size concept art image
  - **model**: Click to open interactive 3D viewer (Three.js + GLTFLoader)
  - **render**: Grid of all rendered sprite frames
  - **pack**: Atlas sprite sheet preview
- Generate buttons per phase or "Full" for entire pipeline
- Backend override selector

### Typical QA session

```
1. Open https://assetgen.korczewski.de
2. Switch to Visual tab
3. Filter by category (e.g. "characters")
4. Click a concept art thumbnail to inspect
5. Click "View Model" to orbit the 3D model
6. Check render grid for sprite quality
7. Flag any assets that need regeneration
8. Click "Regenerate Flagged" to re-run pipeline
```

---

## 2. Bulk JSON Editing

For adding multiple assets or changing prompts/settings across many assets at once.

### Files

| File | Location | Purpose |
|------|----------|---------|
| `visual-library.json` | Repo root (git-tracked) | Visual asset definitions |
| `library.json` | Repo root (git-tracked) | Audio asset definitions |
| NAS copies | `/mnt/pve3a/visual-library/visual-library.json` | Runtime state (pipeline progress, assignments) |

### How merging works

On server startup, `mergeVisualLibraryDefinitions()` merges git-tracked definitions into the NAS copy:
- **Definition fields** (prompt, category, tags, poses, size, backends) from git **overwrite** NAS
- **Runtime fields** (`pipeline`, `assignedTo`) on NAS are **preserved**
- **New assets** in git are added to NAS entirely

This means you can safely edit prompts, add assets, or change backends in git without losing generation progress.

### Adding a new visual asset

Add an entry to `visual-library.json`:

```json
{
  "assets": {
    "existing_asset": { "..." : "..." },
    "my_new_asset": {
      "id": "my_new_asset",
      "name": "My New Asset",
      "category": "items",
      "prompt": "Low-poly health potion bottle, glowing green liquid, fantasy game item, isometric view",
      "tags": ["arena", "consumable"]
    }
  }
}
```

Category defaults (directions, poses, size) are applied automatically from `config/visual-config.json`.

### Adding a new audio asset

Add to `library.json`:

```json
{
  "sounds": {
    "reload_rifle": {
      "id": "reload_rifle",
      "name": "Rifle Reload",
      "category": "sfx_weapons",
      "prompt": "Mechanical rifle reload, magazine click, bolt action, close range",
      "duration": 2
    }
  }
}
```

### Deploying changes

```bash
# Edit the JSON files
vim visual-library.json

# Commit and push
git add visual-library.json
git commit -m "Add new visual assets"
git push

# Rebuild and deploy (k3d)
docker build -t registry.localhost:5000/assetgenerator:latest .
docker push registry.localhost:5000/assetgenerator:latest
kubectl rollout restart deployment/assetgenerator -n assetgen

# Or for local dev, just restart the server
npm run dev
```

### Bulk prompt update example

```bash
# Update all character prompts to include a style directive
python3 -c "
import json
with open('visual-library.json') as f:
    lib = json.load(f)
for id, asset in lib['assets'].items():
    if asset.get('category') == 'characters':
        if 'low-poly' not in asset.get('prompt', '').lower():
            asset['prompt'] = 'Low-poly stylized ' + asset['prompt']
with open('visual-library.json', 'w') as f:
    json.dump(lib, f, indent=2)
"
```

---

## 3. REST API

For single asset operations, scripting, and CI/CD integration.

### Base URL

```
https://assetgen.korczewski.de
```

### Browse assets

```bash
# List all visual assets
curl -s https://assetgen.korczewski.de/api/visual-library | jq '.assets | keys'

# Get single asset details
curl -s https://assetgen.korczewski.de/api/visual-library/student | jq

# Download concept art
curl -s https://assetgen.korczewski.de/api/visual-library/student/concept -o student_concept.png

# Download 3D model
curl -s https://assetgen.korczewski.de/api/visual-library/student/model -o student.glb

# List rendered frames
curl -s https://assetgen.korczewski.de/api/visual-library/student/renders | jq

# Download atlas
curl -s https://assetgen.korczewski.de/api/visual-library/student/atlas -o student_atlas.png

# List all audio assets
curl -s https://assetgen.korczewski.de/api/library | jq '.sounds | keys'

# Get single audio asset details
curl -s https://assetgen.korczewski.de/api/library/gunshot | jq

# Download audio file
curl -s https://assetgen.korczewski.de/api/library/gunshot/audio -o gunshot.wav
```

### Create a new asset

```bash
# Create visual asset
curl -X POST https://assetgen.korczewski.de/api/visual-library \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "shield_wooden",
    "name": "Wooden Shield",
    "category": "items",
    "prompt": "Low-poly wooden medieval shield, iron rivets, isometric game item"
  }'

# Create audio asset
curl -X POST https://assetgen.korczewski.de/api/library \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "shield_block",
    "name": "Shield Block",
    "category": "sfx_impacts",
    "prompt": "Wooden shield blocking a sword strike, impact, close range",
    "duration": 1
  }'
```

### Update an asset

```bash
# Update prompt
curl -X PUT https://assetgen.korczewski.de/api/visual-library/shield_wooden \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Low-poly round wooden shield with iron boss, isometric, fantasy RPG"}'

# Set Sketchfab source (skip AI concept+model, use real 3D model)
curl -X POST https://assetgen.korczewski.de/api/visual-library/shield_wooden/source/sketchfab \
  -H 'Content-Type: application/json' \
  -d '{"uid": "abc123def456"}'

# Set Figma source (for UI/tile assets)
curl -X POST https://assetgen.korczewski.de/api/visual-library/health_bar/figma-source \
  -H 'Content-Type: application/json' \
  -d '{"nodeId": "123:456"}'
```

### Generate assets

```bash
# Generate single phase (returns SSE event stream)
curl -X POST https://assetgen.korczewski.de/api/visual-library/shield_wooden/generate/concept
curl -X POST https://assetgen.korczewski.de/api/visual-library/shield_wooden/generate/model
curl -X POST https://assetgen.korczewski.de/api/visual-library/shield_wooden/generate/render
curl -X POST https://assetgen.korczewski.de/api/visual-library/shield_wooden/generate/full

# Batch generate
curl -X POST https://assetgen.korczewski.de/api/visual-library/batch/generate \
  -H 'Content-Type: application/json' \
  -d '{"ids": ["shield_wooden", "health_pack"], "fromPhase": "concept"}'

# Generate audio
curl -X POST https://assetgen.korczewski.de/api/library/shield_block/generate
```

### Assign to project

```bash
# Assign visual asset to project atlas
curl -X POST https://assetgen.korczewski.de/api/visual-library/shield_wooden/assign \
  -H 'Content-Type: application/json' \
  -d '{"project": "arena", "atlas": "items"}'

# Assign audio to project slot
curl -X POST https://assetgen.korczewski.de/api/library/shield_block/assign \
  -H 'Content-Type: application/json' \
  -d '{"project": "arena", "slot": "shield_block"}'
```

### Delete an asset

```bash
curl -X DELETE https://assetgen.korczewski.de/api/visual-library/shield_wooden
curl -X DELETE https://assetgen.korczewski.de/api/library/shield_block
```

### Monitor

```bash
# Check GPU worker
curl -s https://assetgen.korczewski.de/api/worker-status | jq

# Check queue
curl -s https://assetgen.korczewski.de/api/queue-depth | jq

# Check Blender MCP
curl -s https://assetgen.korczewski.de/api/blender-mcp/status | jq

# Check Figma
curl -s https://assetgen.korczewski.de/api/figma/status | jq
```

---

## 4. Claude Code + Blender MCP

For creative iteration with visual feedback. Requires a Claude Code session with Blender MCP connected.

### Prerequisites

1. Blender running on the GPU machine (10.10.0.3) with MCP addon enabled
2. Addon server started (Blender sidebar -> BlenderMCP -> Start Server)
3. Claude Code session with `.mcp.json` configured for `blender` and `figma` servers

### Typical creative workflow

#### Search and import a model from Sketchfab

```
You: "Find me a good rifle model on Sketchfab"

Claude uses: mcp__blender__search_sketchfab_models (query="tactical rifle low poly")
Claude uses: mcp__blender__get_sketchfab_model_preview (uid="...")  <- visual confirm
Claude uses: mcp__blender__download_sketchfab_model (uid="...")     <- import into Blender
Claude uses: mcp__blender__get_viewport_screenshot                  <- QA check
```

#### Generate a 3D model from text

```
You: "Generate a health potion bottle"

Claude uses: mcp__blender__generate_hyper3d_model_via_text (prompt="...")
Claude uses: mcp__blender__poll_rodin_job_status                    <- wait for completion
Claude uses: mcp__blender__import_generated_asset                   <- import into scene
Claude uses: mcp__blender__get_viewport_screenshot                  <- QA check
```

#### Render and export to the asset library

```
You: "Export this as the health_pack model"

Claude uses: mcp__blender__execute_blender_code  <- export GLB to visual library path
Claude uses: curl API to update asset pipeline status
```

#### Apply textures from PolyHaven

```
You: "Give it a rusty metal texture"

Claude uses: mcp__blender__search_polyhaven_assets (query="rusty metal")
Claude uses: mcp__blender__download_polyhaven_asset (asset_id="...")
Claude uses: mcp__blender__set_texture (...)
Claude uses: mcp__blender__get_viewport_screenshot  <- QA check
```

#### Use Figma designs as concept art

```
You: "Use the health bar design from Figma"

Claude uses: mcp__figma__get_file_components       <- list available components
Claude uses: mcp__figma__get_image (nodeId="...")   <- export as PNG
Claude uses: curl API to set figma source on asset
```

### Key MCP tools reference

| Tool | Purpose |
|------|---------|
| `get_scene_info` | Check what's in the Blender scene |
| `get_viewport_screenshot` | Visual QA of current viewport |
| `execute_blender_code` | Run arbitrary Blender Python |
| `search_sketchfab_models` | Find pre-made 3D models |
| `download_sketchfab_model` | Import Sketchfab model into scene |
| `generate_hyper3d_model_via_text` | AI-generate 3D model from text prompt |
| `generate_hunyuan3d_model` | AI-generate via Hunyuan3D |
| `search_polyhaven_assets` | Find textures, HDRIs |
| `download_polyhaven_asset` | Import PolyHaven asset |
| `set_texture` | Apply texture to object |
| `get_object_info` | Inspect selected object properties |

### Tips

- Always check `get_scene_info` before starting to understand what's already loaded
- Use `execute_blender_code` for operations not covered by dedicated tools (e.g., vertex manipulation, custom rendering)
- GLB models from the API may need rotation correction (Y-up to Z-up) via bmesh vertex rotation
- Viewport screenshots may fail on headless setups; use `bpy.ops.render.render()` + base64 encoding as fallback
- The asset library NAS mount (`/mnt/pve3a/visual-library`) is not accessible from the Windows Blender host; use the API to transfer files

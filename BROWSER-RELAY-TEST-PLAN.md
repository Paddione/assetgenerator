# Assetgenerator — Browser Relay Test Plan

> Created: 2026-03-23
> Author: ClosedPaw (OpenClaw agent)
> Target: `http://localhost:5200` via OpenClaw browser relay (profile: `chrome-relay`)
> Based on: `TESTING.md`, `CLAUDE.md`, `docs/services/assetgenerator.md`

This plan covers critical UI workflows tested via the OpenClaw browser relay. The relay connects to the PK-Desktop Chrome instance running on `10.10.0.3`, where the assetgenerator frontend is reachable at `localhost:5200`.

---

## Prerequisites

Before running these tests, verify:

- [ ] Browser relay is active on PK-Desktop (Chrome extension / OpenClaw Relay toolbar icon ON)
- [ ] `autossh` tunnel is running from ubuntu-laptop: ports 18789 + 18792 forwarded
- [ ] Assetgenerator server is running on PK-Desktop: `npm run dev` at `localhost:5200`
- [ ] NAS is mounted on PK-Desktop: `/mnt/pve3a/` accessible
- [ ] GPU worker status is known (connected or not — cloud fallback may be used)

---

## Browser Relay Approach

All tests use `browser(profile="chrome-relay")` via OpenClaw.

**Workflow per test:**
1. `browser(action="open", profile="chrome-relay", url="http://localhost:5200")` — navigate
2. `browser(action="snapshot", profile="chrome-relay")` — capture current state
3. `browser(action="act", kind="click"|"fill"|"press", ref=<aria-ref>)` — interact
4. Re-snapshot to verify state change
5. Check for expected DOM changes / network responses

---

## Test Suite

---

### TC-01: Page Load & Smoke Test

**Critical:** Yes — all other tests depend on this.

**Steps:**
1. Open `http://localhost:5200`
2. Take snapshot

**Expected in snapshot:**
- Header with project selector (dropdown listing `arena`, `l2p`, etc.)
- Worker connection indicator (colored dot, top area)
- Tab bar with "Audio" and "Visual" tabs
- No JS console errors

**Pass criteria:** Page renders without blank screen or uncaught errors.

---

### TC-02: Worker Status Indicator

**Critical:** Yes — determines which backends are available.

**Steps:**
1. Snapshot the header
2. Locate the worker status dot/indicator
3. Note color: green = connected, gray/red = disconnected

**Also verify via API (curl from relay or background):**
```
GET http://localhost:5200/api/worker-status
```

**Expected:**
- UI indicator matches API response's `connected` field
- If `connected: false`, UI shows "No GPU worker" or similar warning

**Pass criteria:** Visual indicator is consistent with API truth.

---

### TC-03: Tab Switching — Audio ↔ Visual

**Critical:** Yes — core navigation.

**Steps:**
1. Default tab loads (likely Audio)
2. Click "Visual" tab → snapshot
3. Click "Audio" tab → snapshot

**Expected:**
- Active tab has distinct highlight (cyan border per cyberpunk theme)
- Content area swaps between audio grid and visual grid
- No page reload (SPA behavior)
- Inactive tab content is hidden (not removed from DOM — verify no flicker on re-click)

**Pass criteria:** Both tabs render their libraries without error.

---

### TC-04: Project Selector

**Critical:** Yes — determines which asset set is displayed.

**Steps:**
1. Locate project selector dropdown in header
2. Take snapshot of current selection
3. Change to a different project (if multiple exist)
4. Snapshot the resulting library content

**Expected:**
- Dropdown shows all available projects
- On change: library reloads with assets assigned to the new project
- Page title or indicator updates to reflect selected project

**Pass criteria:** Switching projects updates the asset grid without page crash.

---

### TC-05: Audio Library Grid Renders

**Critical:** Yes.

**Steps:**
1. Ensure "Audio" tab is active
2. Snapshot the grid area

**Expected:**
- Grid shows cards for existing library sounds
- Each card displays: sound name, category badge, backend label, play button, flag toggle
- Empty state shows "No sounds" message (if library is empty)

**Pass criteria:** Grid renders all library entries, no broken cards.

---

### TC-06: Add Audio Asset via UI

**Critical:** Yes — core mutation workflow.

**Steps:**
1. Click "Add Sound" or "+" button
2. Fill form:
   - ID: `test_browser_001`
   - Name: `Browser Test Sound`
   - Category: `sfx/ui`
   - Prompt: `short click, digital, clean`
   - Backend: `elevenlabs`
   - Duration: `0.5`
3. Submit form
4. Snapshot result

**Expected:**
- New card appears in the grid for `test_browser_001`
- No error toast / modal
- Form closes after successful submit

**API verify:**
```
GET http://localhost:5200/api/library
→ array contains entry with id "test_browser_001"
```

**Pass criteria:** Asset created, visible in UI, confirmed via API.

---

### TC-07: Flag / Unflag Audio Asset

**Critical:** Yes — flags control batch regeneration.

**Steps:**
1. Locate card for `test_browser_001` (or any existing sound)
2. Click the flag icon
3. Snapshot — card should show flagged state
4. Click flag icon again
5. Snapshot — card should show unflagged state

**Expected:**
- Flag icon toggles visual state (filled vs outline)
- API reflects the change:
  ```
  GET http://localhost:5200/api/library/test_browser_001
  → { "flagged": true } after first click
  ```

**Pass criteria:** Flag toggle updates UI and persists to `library.json`.

---

### TC-08: Audio Generation via UI (Cloud Backend)

**Critical:** Yes — end-to-end SSE flow.
**Requires:** `ELEVENLABS_API_KEY` set in server environment.

**Steps:**
1. Locate `test_browser_001` card (backend: elevenlabs)
2. Click "Generate" button on the card
3. Watch status bar / log panel for SSE events
4. Snapshot during generation (should show progress indicator)
5. Wait for completion (up to 60 seconds)
6. Snapshot final state

**Expected:**
- Progress events visible in UI: `Generating...` → `Processing audio...` → `Done`
- Card updates with a timestamp or "Generated" badge after completion
- Play button becomes active (file exists)
- No error toast

**API verify after:**
```
GET http://localhost:5200/api/library/test_browser_001/audio
→ 200 with audio content
```

**Pass criteria:** Generation completes, audio file exists, UI reflects success.

---

### TC-09: Audio Playback via Browser

**Critical:** Yes — verifies file delivery and browser audio stack.

**Steps:**
1. Locate a card with a generated audio file (after TC-08 or use pre-existing)
2. Click the play button
3. Observe: audio should play in browser

**Expected:**
- Play button toggles to pause icon while playing
- Browser plays audio (WAV stream from `/api/library/:id/audio`)
- No console errors (`NotAllowedError`, `MEDIA_ERR_SRC_NOT_SUPPORTED`, etc.)

**Pass criteria:** Audio plays without errors.

---

### TC-10: Visual Library Grid Renders

**Critical:** Yes.

**Steps:**
1. Click "Visual" tab
2. Snapshot the grid area

**Expected:**
- Cards for existing visual assets
- Each card shows: name, category, pipeline phase indicators (concept / model / render / pack)
- Phase badges: color-coded by status (pending = gray, done = green, error = red)

**Pass criteria:** Grid renders, phase statuses visible per asset.

---

### TC-11: Add Visual Asset via UI

**Critical:** Yes.

**Steps:**
1. In Visual tab, click "Add Asset" or "+"
2. Fill form:
   - ID: `test_browser_char_001`
   - Name: `Browser Test Character`
   - Category: `characters`
   - Prompt: `robot soldier, metallic, blue visor, isometric sprite`
   - Poses: `stand, gun`
   - Directions: `8`
   - Size: `64`
   - Concept Backend: `siliconflow`
3. Submit form

**Expected:**
- Card appears in grid
- All 4 pipeline phases show "pending"
- No error

**API verify:**
```
GET http://localhost:5200/api/visual-library/test_browser_char_001
→ pipeline: { concept: {status:"pending"}, ... }
```

**Pass criteria:** Asset created with correct pipeline state.

---

### TC-12: Visual Concept Generation via UI

**Critical:** Yes — first phase of the visual pipeline.
**Requires:** `SILICONFLOW_API_KEY` or `GEMINI_API_KEY` set, or GPU worker connected.

**Steps:**
1. Select `test_browser_char_001` card
2. Set phase selector to "concept"
3. Click "Generate" (or "Generate Phase")
4. Watch status bar / log panel
5. Wait up to 90 seconds
6. Snapshot result

**Expected:**
- SSE events visible: `Generating concept...` → `phase-done: concept`
- Card's concept phase badge turns green
- Concept thumbnail appears on the card

**API verify:**
```
GET http://localhost:5200/api/visual-library/test_browser_char_001/concept
→ 200 with PNG image
```

**Pass criteria:** Concept phase completes, thumbnail visible in UI and accessible via API.

---

### TC-13: Logs Panel

**Critical:** Medium — developer visibility.

**Steps:**
1. After running a generation (TC-08 or TC-12), click "Logs" or the log panel toggle
2. Snapshot the panel

**Expected:**
- Expandable log panel at bottom of page
- Shows timestamped SSE event history from recent generations
- Events readable: type, asset ID, message

**Pass criteria:** Log panel opens, shows event history.

---

### TC-14: Error Handling — Duplicate Asset ID

**Critical:** Yes — tests validation and UX error feedback.

**Steps:**
1. Try to add an audio asset with ID `test_browser_001` again (already created in TC-06)
2. Submit the form

**Expected:**
- Server returns 409
- UI shows error toast or inline error: "Asset with this ID already exists"
- Form stays open (does not close on error)

**Pass criteria:** 409 surfaced to user clearly, no silent failure.

---

### TC-15: Error Handling — No Worker Connected (GPU-Only Backend)

**Critical:** Yes — important fallback behavior.
**Setup:** Confirm worker is not connected (`/api/worker-status` → `connected: false`).

**Steps:**
1. Add a test sound with backend `audiocraft` (GPU-only)
2. Click "Generate"
3. Observe SSE stream / UI feedback

**Expected:**
- SSE emits `error` event: `"Worker not connected"` or similar
- UI shows error state on the card (not a permanent "failed" — should be retryable)
- No crash, no unhandled promise rejection

**Pass criteria:** Error surfaced gracefully in UI.

---

### TC-16: Cleanup — Delete Test Assets via UI

**Critical:** Yes — ensures delete workflow functions.

**Steps:**
1. Find `test_browser_001` card
2. Click delete button (trash icon)
3. Confirm deletion in any confirmation dialog
4. Snapshot — card should be gone
5. Repeat for `test_browser_char_001`

**API verify:**
```
GET http://localhost:5200/api/library → no test_browser_001
GET http://localhost:5200/api/visual-library → no test_browser_char_001
```

**Pass criteria:** Both assets removed from UI and API.

---

## Critical Path Summary

The minimum set to validate core functionality:

| # | Test | Why Critical |
|---|------|--------------|
| TC-01 | Page Load | Everything else needs this |
| TC-02 | Worker Status | Determines available backends |
| TC-03 | Tab Switching | Core navigation |
| TC-05 | Audio Grid | Library readable |
| TC-06 | Add Audio | Create path works |
| TC-07 | Flag Toggle | Batch regen dependency |
| TC-08 | Audio Generation | End-to-end SSE + cloud API |
| TC-10 | Visual Grid | Visual library readable |
| TC-11 | Add Visual | Visual create path works |
| TC-14 | Duplicate Error | Validation feedback |
| TC-16 | Delete Assets | Cleanup + delete path |

---

## OpenClaw Automation Notes

When running these via OpenClaw browser relay:

- Use `refs="aria"` on snapshots for stable element references
- After clicking "Generate", poll snapshot every 5s for up to 120s waiting for phase completion
- SSE streams cannot be directly monitored via browser tool — infer completion from DOM state changes (card badge color, timestamp appearance)
- Use `browser(action="console")` to check for JS errors after each major action
- Always run TC-16 (cleanup) even if earlier tests fail — use a `finally`-style cleanup step

---

## Test Environment Notes

| Item | Value |
|------|-------|
| Service URL | `http://localhost:5200` (PK-Desktop) |
| Browser relay profile | `chrome-relay` |
| Tunnel required | Yes — autossh ports 18789+18792 from ubuntu-laptop |
| Audio library state | `library.json` on NAS `/mnt/pve3a/audio-library/` |
| Visual library state | `visual-library.json` on NAS `/mnt/pve3a/visual-library/` |
| Test ID convention | Prefix all test assets with `test_browser_` |

---

## Changelog

- 2026-03-23: Initial plan created by ClosedPaw based on TESTING.md + CLAUDE.md

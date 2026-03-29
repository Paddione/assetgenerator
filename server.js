import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { initWorkerManager, getWorkerStatus, getQueueDepth } from './worker-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PORT || '5200', 10);

// CLI args
const cliArgs = process.argv.slice(2);
const projectFlagIdx = cliArgs.indexOf('--project');
const defaultProject = projectFlagIdx !== -1 ? cliArgs[projectFlagIdx + 1] : null;

// Prerequisites check
const prerequisites = { python: false, ffmpeg: false, cuda: false, pythonPath: 'python3' };

function checkPrerequisites(projectPythonPath) {
  // Use project's venv python if available, fall back to system python3
  const pythonCandidates = projectPythonPath
    ? [projectPythonPath, 'python3']
    : ['python3'];

  for (const py of pythonCandidates) {
    try {
      execFileSync(py, ['--version'], { stdio: 'pipe' });
      prerequisites.python = true;
      prerequisites.pythonPath = py;
      try {
        const result = execFileSync(py, ['-c', 'import torch; print(torch.cuda.is_available())'], { stdio: 'pipe' });
        prerequisites.cuda = result.toString().trim() === 'True';
      } catch { prerequisites.cuda = false; }
      break;
    } catch { /* try next candidate */ }
  }

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    prerequisites.ffmpeg = true;
  } catch { prerequisites.ffmpeg = false; }
}

// Initial check with system python (will re-check with project venv on scan)
checkPrerequisites();

// =============================================================================
// Project state management
// =============================================================================

const PROJECTS_DIR = join(__dirname, 'projects');
const BACKENDS_PATH = join(__dirname, 'config', 'backends.json');

function loadBackends() {
  return JSON.parse(readFileSync(BACKENDS_PATH, 'utf-8'));
}

function saveBackends(data) {
  writeFileSync(BACKENDS_PATH, JSON.stringify(data, null, 2));
}

function listProjects() {
  return readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

function loadProject(name) {
  const filePath = join(PROJECTS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return null;
  const project = JSON.parse(readFileSync(filePath, 'utf-8'));
  project._basePath = __dirname;
  return project;
}

function saveProject(project) {
  const name = project.name;
  const toSave = { ...project };
  delete toSave._basePath;
  // Strip transient computed fields from each sound entry
  if (toSave.sounds) {
    for (const sound of Object.values(toSave.sounds)) {
      delete sound._fileSize;
      delete sound._fileDuration;
    }
  }
  writeFileSync(join(PROJECTS_DIR, `${name}.json`), JSON.stringify(toSave, null, 2));
}

// =============================================================================
// Library state management
// =============================================================================

const _libConfig = JSON.parse(readFileSync(join(__dirname, 'config', 'library-config.json'), 'utf-8'));
const _vConfig = JSON.parse(readFileSync(join(__dirname, 'config', 'visual-config.json'), 'utf-8'));
const LIBRARY_PATH = join(_libConfig.libraryRoot, 'library.json');
const VISUAL_LIBRARY_PATH = join(_vConfig.libraryRoot, 'visual-library.json');
const LIBRARY_CONFIG_PATH = join(__dirname, 'config', 'library-config.json');
const VISUAL_CONFIG_PATH = join(__dirname, 'config', 'visual-config.json');

// Seed NAS library from git-tracked copy if NAS copy is missing or empty
function seedLibraryIfEmpty(nasPath, localFallback, label) {
  const localPath = join(__dirname, localFallback);
  if (!existsSync(localPath)) return;
  const needsSeed = !existsSync(nasPath) ||
    (() => { try { const d = JSON.parse(readFileSync(nasPath, 'utf-8')); return Object.keys(d.sounds || d.assets || {}).length === 0; } catch { return true; } })();
  if (needsSeed) {
    console.log(`  Seeding ${label} from ${localFallback}`);
    const dir = dirname(nasPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    copyFileSync(localPath, nasPath);
  }
}

seedLibraryIfEmpty(LIBRARY_PATH, 'library.json', 'audio library');
seedLibraryIfEmpty(VISUAL_LIBRARY_PATH, 'visual-library.json', 'visual library');

// Merge asset definitions from git-tracked image into PV, preserving runtime state.
// This ensures new fields (e.g. conceptBackend, prompt changes) propagate on deploy
// without overwriting pipeline progress or assignment state stored on the PV.
function mergeVisualLibraryDefinitions() {
  const localPath = join(__dirname, 'visual-library.json');
  if (!existsSync(localPath) || !existsSync(VISUAL_LIBRARY_PATH)) return;

  try {
    const image = JSON.parse(readFileSync(localPath, 'utf-8'));
    const pv = JSON.parse(readFileSync(VISUAL_LIBRARY_PATH, 'utf-8'));
    const runtimeKeys = new Set(['pipeline', 'assignedTo']);
    let updated = false;

    for (const [id, imgAsset] of Object.entries(image.assets || {})) {
      const pvAsset = pv.assets[id];
      if (!pvAsset) {
        // New asset — add it entirely
        pv.assets[id] = imgAsset;
        updated = true;
        continue;
      }
      // Merge: image definitions win, PV runtime state preserved
      for (const [key, value] of Object.entries(imgAsset)) {
        if (runtimeKeys.has(key)) continue;
        if (JSON.stringify(pvAsset[key]) !== JSON.stringify(value)) {
          pvAsset[key] = value;
          updated = true;
        }
      }
    }

    if (updated) {
      writeFileSync(VISUAL_LIBRARY_PATH, JSON.stringify(pv, null, 2));
      console.log('  Merged visual library definitions from image → PV');
    }
  } catch (err) {
    console.warn(`  Visual library merge warning: ${err.message}`);
  }
}

mergeVisualLibraryDefinitions();

function loadLibrary() {
  if (!existsSync(LIBRARY_PATH)) return { version: 1, sounds: {} };
  return JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8'));
}

function saveLibrary(library) {
  const incoming = Object.keys(library.sounds || {}).length;
  if (incoming === 0 && existsSync(LIBRARY_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8'));
      if (Object.keys(existing.sounds || {}).length > 0) {
        console.warn('saveLibrary: refusing to overwrite populated library with empty data');
        return;
      }
    } catch { /* file unreadable, allow write */ }
  }
  writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, 2));
}

function loadVisualLibrary() {
  if (!existsSync(VISUAL_LIBRARY_PATH)) return { version: 1, assets: {} };
  return JSON.parse(readFileSync(VISUAL_LIBRARY_PATH, 'utf-8'));
}

function saveVisualLibrary(library) {
  const incoming = Object.keys(library.assets || {}).length;
  if (incoming === 0 && existsSync(VISUAL_LIBRARY_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(VISUAL_LIBRARY_PATH, 'utf-8'));
      if (Object.keys(existing.assets || {}).length > 0) {
        console.warn('saveVisualLibrary: refusing to overwrite populated library with empty data');
        return;
      }
    } catch { /* file unreadable, allow write */ }
  }
  writeFileSync(VISUAL_LIBRARY_PATH, JSON.stringify(library, null, 2));
}

function loadLibraryConfig() {
  return JSON.parse(readFileSync(LIBRARY_CONFIG_PATH, 'utf-8'));
}

function loadVisualConfig() {
  return JSON.parse(readFileSync(VISUAL_CONFIG_PATH, 'utf-8'));
}

function processAudioFile(wavPath, outputDir, id, type) {
  const config = loadLibraryConfig();
  const lufs = type.startsWith('music') ? config.loudness.music : config.loudness.sfx;
  const af = `silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB,loudnorm=I=${lufs}:TP=-1.5:LRA=11`;

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  // Validate source WAV has audible content (reject silent stubs)
  // volumedetect writes to stderr; spawnSync captures it regardless of exit code
  const volProbe = spawnSync('ffmpeg', [
    '-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'
  ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  const volStderr = volProbe.stderr?.toString() || '';
  const volMatch = volStderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
  if (volMatch) {
    const maxVol = parseFloat(volMatch[1]);
    if (maxVol < -80) {
      throw new Error(`Source WAV is silent (max_volume: ${maxVol} dB) — likely a placeholder stub. Re-generate with a real audio backend.`);
    }
  }

  const baseName = id;
  const oggPath = join(outputDir, `${baseName}.ogg`);
  execFileSync('ffmpeg', [
    '-y', '-i', wavPath,
    '-af', af,
    '-ar', '48000', '-ac', '1',
    '-c:a', 'libopus', '-b:a', '96k',
    oggPath
  ], { stdio: 'pipe' });

  const mp3Path = join(outputDir, `${baseName}.mp3`);
  execFileSync('ffmpeg', [
    '-y', '-i', wavPath,
    '-af', af,
    '-ar', '44100', '-ac', '1',
    '-c:a', 'libmp3lame', '-b:a', '128k',
    mp3Path
  ], { stdio: 'pipe' });

  // Validate output files have actual content (not just headers)
  const MIN_OUTPUT_SIZE = 1024;
  for (const outPath of [oggPath, mp3Path]) {
    const stat = statSync(outPath);
    if (stat.size < MIN_OUTPUT_SIZE) {
      throw new Error(`Output file ${outPath} is too small (${stat.size} bytes) — silenceremove may have stripped all audio. Check source WAV.`);
    }
  }

  return { oggPath, mp3Path };
}

// =============================================================================
// Scan
// =============================================================================

function getAudioDuration(audioFilePath) {
  try {
    const result = execFileSync(
      'ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioFilePath],
      { stdio: 'pipe' }
    );
    const val = parseFloat(result.toString().trim());
    return val != null && !isNaN(val) ? Math.round(val * 10) / 10 : null;
  } catch {
    return null;
  }
}

function getFileSize(filePath) {
  try { return statSync(filePath).size; } catch { return 0; }
}

function scanProject(project) {
  const audioRoot = resolve(__dirname, project.audioRoot);
  if (!existsSync(audioRoot)) return project;

  // Load manifest for prompt pre-fill
  let manifestSfx = [];
  let manifestMusic = [];
  if (project.manifestPath) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(__dirname, project.manifestPath), 'utf-8'));
      manifestSfx = manifest.sfx || [];
      manifestMusic = manifest.music || [];
    } catch { /* no manifest */ }
  }

  const manifestMap = {};
  for (const s of manifestSfx) manifestMap[s.id] = { ...s, type: 'sfx' };
  for (const m of manifestMusic) manifestMap[m.id] = { ...m, type: 'music' };

  if (!project.sounds) project.sounds = {};

  for (const type of ['sfx', 'music']) {
    const dir = join(audioRoot, type);
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.wav')) continue;
      const id = file.replace('.wav', '');
      const relPath = `${type}/${file}`;
      const fullPath = join(audioRoot, relPath);

      if (project.sounds[id]) {
        project.sounds[id].filePath = relPath;
        project.sounds[id]._fileSize = getFileSize(fullPath);
        project.sounds[id]._fileDuration = getAudioDuration(fullPath);
        continue;
      }

      const manifestEntry = manifestMap[id];
      project.sounds[id] = {
        type,
        prompt: manifestEntry?.prompt || '',
        seed: null,
        duration: manifestEntry?.duration || getAudioDuration(fullPath) || 1.0,
        backend: 'default',
        flagged: false,
        lastGeneratedAt: null,
        filePath: relPath,
        _fileSize: getFileSize(fullPath),
        _fileDuration: getAudioDuration(fullPath),
      };
      if (type === 'music' && manifestEntry?.loop !== undefined) {
        project.sounds[id].loop = manifestEntry.loop;
      }
    }
  }

  saveProject(project);
  return project;
}

// =============================================================================
// API Routes
// =============================================================================

// Prerequisites
app.get('/api/prerequisites', (req, res) => res.json(prerequisites));

// Backends
app.get('/api/backends', (req, res) => res.json(loadBackends()));

app.post('/api/backends', (req, res) => {
  const { id, label, adapter, requiresEnv } = req.body;
  if (!id || !label || !adapter) return res.status(400).json({ error: 'id, label, adapter required' });
  const backends = loadBackends();
  backends[id] = { label, enabled: true, adapter, ...(requiresEnv && { requiresEnv }) };
  saveBackends(backends);
  res.json(backends);
});

// Projects
app.get('/api/projects', (req, res) => res.json(listProjects()));

app.get('/api/projects/:name', (req, res) => {
  const project = loadProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

app.post('/api/projects', (req, res) => {
  const { name, audioRoot, outputRoot, processScript, generateScript, manifestPath } = req.body;
  if (!name || !audioRoot) return res.status(400).json({ error: 'name and audioRoot required' });
  const project = { name, audioRoot, outputRoot, processScript, generateScript, manifestPath, sounds: {} };
  saveProject(project);
  res.json(project);
});

// Scan
app.post('/api/projects/:name/scan', (req, res) => {
  const project = loadProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(scanProject(project));
});

// Sounds
app.put('/api/projects/:name/sounds/:id', (req, res) => {
  const project = loadProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.sounds[req.params.id]) return res.status(404).json({ error: 'Sound not found' });
  const allowed = ['prompt', 'seed', 'duration', 'backend', 'flagged'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) project.sounds[req.params.id][key] = req.body[key];
  }
  saveProject(project);
  res.json(project.sounds[req.params.id]);
});

// Audio streaming
app.get('/api/projects/:name/sounds/:id/audio', (req, res) => {
  const project = loadProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const sound = project.sounds[req.params.id];
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  const audioRoot = resolve(__dirname, project.audioRoot);
  const audioFilePath = join(audioRoot, sound.filePath);
  if (!existsSync(audioFilePath)) return res.status(404).json({ error: 'Audio file not found' });
  res.sendFile(audioFilePath);
});

// =============================================================================
// Regeneration with SSE
// =============================================================================

let regenerationInProgress = false;

app.post('/api/projects/:name/regenerate', async (req, res) => {
  if (regenerationInProgress) return res.status(409).json({ error: 'Regeneration already in progress' });

  const project = loadProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const flagged = Object.entries(project.sounds).filter(([, s]) => s.flagged);
  if (flagged.length === 0) return res.status(400).json({ error: 'No flagged sounds' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  regenerationInProgress = true;
  const backends = loadBackends();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < flagged.length; i++) {
    const [id, sound] = flagged[i];
    const backendKey = sound.backend === 'default' ? 'audiocraft' : sound.backend;
    const index = i + 1;
    const total = flagged.length;

    res.write(`event: progress\ndata: ${JSON.stringify({ sound: id, status: 'generating', backend: backendKey, index, total })}\n\n`);

    try {
      const adapterName = backends[backendKey]?.adapter || backendKey;
      const adapterPath = join(__dirname, 'adapters', `${adapterName}.js`);
      const adapter = await import(adapterPath);

      const audioRoot = resolve(__dirname, project.audioRoot);
      const outputPath = join(audioRoot, sound.filePath);

      const result = await adapter.generate({
        id, type: sound.type, prompt: sound.prompt,
        seed: sound.seed, duration: sound.duration,
        outputPath, projectConfig: project,
      });

      // Delete existing OGG/MP3 to clear process_audio.sh skip-guard
      if (project.outputRoot) {
        const outputRoot = resolve(__dirname, project.outputRoot);
        for (const ext of ['.ogg', '.mp3']) {
          const outFile = join(outputRoot, sound.type, id + ext);
          if (existsSync(outFile)) unlinkSync(outFile);
        }
      }

      res.write(`event: progress\ndata: ${JSON.stringify({ sound: id, status: 'processing', index, total })}\n\n`);

      if (project.processScript) {
        const processPath = resolve(__dirname, project.processScript);
        try {
          execFileSync('bash', [processPath, '--type', sound.type], { stdio: 'pipe', timeout: 120000 });
        } catch (procErr) {
          console.error(`process_audio.sh warning: ${procErr.message}`);
        }
      }

      // Update state
      const updatedProject = loadProject(project.name);
      updatedProject.sounds[id].seed = result.seed != null ? Math.round(result.seed) : null;
      updatedProject.sounds[id].lastGeneratedAt = new Date().toISOString();
      updatedProject.sounds[id].flagged = false;
      saveProject(updatedProject);

      succeeded++;
      res.write(`event: done\ndata: ${JSON.stringify({ sound: id, seed: result.seed != null ? Math.round(result.seed) : null, duration: sound.duration, index, total })}\n\n`);
    } catch (err) {
      failed++;
      res.write(`event: error\ndata: ${JSON.stringify({ sound: id, error: err.message, index, total })}\n\n`);
    }
  }

  res.write(`event: complete\ndata: ${JSON.stringify({ total: flagged.length, succeeded, failed })}\n\n`);
  res.end();
  regenerationInProgress = false;
});

// =============================================================================
// Audio Library Routes
// =============================================================================

app.get('/api/library', (req, res) => {
  res.json(loadLibrary());
});

app.get('/api/library/:id/audio', (req, res) => {
  const library = loadLibrary();
  const sound = library.sounds[req.params.id];
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  const config = loadLibraryConfig();
  const format = req.query.format || 'wav';
  let filePath;
  if (format === 'wav') {
    filePath = join(config.libraryRoot, sound.filePath);
  } else {
    const base = sound.filePath.replace(/\.wav$/, '');
    filePath = join(config.libraryRoot, `${base}.${format}`);
  }
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Audio file not found' });
  res.sendFile(filePath);
});

app.post('/api/library', (req, res) => {
  const { id, name, category, tags, prompt, seed, duration, backend } = req.body;
  if (!id || !name || !category) return res.status(400).json({ error: 'id, name, category required' });
  const library = loadLibrary();
  if (library.sounds[id]) return res.status(409).json({ error: 'Sound already exists' });
  library.sounds[id] = {
    id, name, category,
    tags: tags || [],
    prompt: prompt || '',
    seed: seed || null,
    duration: duration || null,
    backend: backend || 'audiocraft',
    filePath: `${category}/${id}.wav`,
    createdAt: new Date().toISOString(),
    assignedTo: {},
  };
  saveLibrary(library);
  res.status(201).json(library.sounds[id]);
});

app.put('/api/library/:id', (req, res) => {
  const library = loadLibrary();
  const sound = library.sounds[req.params.id];
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  const allowed = ['name', 'category', 'tags', 'prompt', 'seed', 'duration', 'backend', 'flagged'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) sound[key] = req.body[key];
  }
  saveLibrary(library);
  res.json(sound);
});

app.delete('/api/library/:id', (req, res) => {
  const library = loadLibrary();
  const sound = library.sounds[req.params.id];
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  const config = loadLibraryConfig();
  const basePath = join(config.libraryRoot, sound.filePath.replace(/\.wav$/, ''));
  for (const ext of ['.wav', '.ogg', '.mp3']) {
    const f = basePath + ext;
    if (existsSync(f)) unlinkSync(f);
  }
  delete library.sounds[req.params.id];
  saveLibrary(library);
  res.json({ deleted: req.params.id });
});

app.post('/api/library/:id/assign', (req, res) => {
  const { project, targetPath } = req.body;
  if (!project || !targetPath) return res.status(400).json({ error: 'project and targetPath required' });
  const library = loadLibrary();
  const sound = library.sounds[req.params.id];
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  const proj = loadProject(project);
  if (!proj) return res.status(404).json({ error: `Project ${project} not found` });

  // Record assignment only — file processing and copying happens during sync
  if (!sound.assignedTo) sound.assignedTo = {};
  sound.assignedTo[project] = { targetPath, syncedAt: null };
  saveLibrary(library);
  res.json(sound);
});

app.post('/api/library/:id/unassign', (req, res) => {
  const { project } = req.body;
  if (!project) return res.status(400).json({ error: 'project required' });
  const library = loadLibrary();
  const sound = library.sounds[req.params.id];
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  if (sound.assignedTo?.[project]) {
    delete sound.assignedTo[project];
    saveLibrary(library);
  }
  res.json(sound);
});

app.post('/api/projects/:name/sync', (req, res) => {
  const project = loadProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const library = loadLibrary();
  const config = loadLibraryConfig();
  const synced = [];
  for (const [id, sound] of Object.entries(library.sounds)) {
    const assignment = sound.assignedTo?.[req.params.name];
    if (!assignment) continue;
    const baseName = sound.filePath.replace(/\.wav$/, '');
    // Use WAV file mtime (not createdAt) to detect changes — audio can be
    // reprocessed/replaced without updating the library entry's createdAt.
    const wavPath = join(config.libraryRoot, sound.filePath);
    if (assignment.syncedAt && existsSync(wavPath)) {
      const wavMtime = statSync(wavPath).mtime;
      if (wavMtime <= new Date(assignment.syncedAt)) continue;
    }

    // Ensure processed files exist on NAS (WAV → OGG/MP3)
    const oggNas = join(config.libraryRoot, `${baseName}.ogg`);
    const mp3Nas = join(config.libraryRoot, `${baseName}.mp3`);
    if (existsSync(wavPath) && (!existsSync(oggNas) || !existsSync(mp3Nas))) {
      try {
        processAudioFile(wavPath, dirname(wavPath), id, sound.category);
      } catch (err) {
        console.error(`Sync: processing failed for ${id}:`, err.message);
        continue;
      }
    }

    const outputRoot = resolve(__dirname, project.outputRoot);
    for (const ext of ['.ogg', '.mp3']) {
      const src = join(config.libraryRoot, `${baseName}${ext}`);
      const dest = join(outputRoot, `${assignment.targetPath}${ext}`);
      if (existsSync(src)) {
        const destDir = dirname(dest);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        copyFileSync(src, dest);
      }
    }
    assignment.syncedAt = new Date().toISOString();
    synced.push(id);
  }
  saveLibrary(library);
  res.json({ synced, count: synced.length });
});

let audioGenerationInProgress = false;

app.post('/api/library/:id/generate', async (req, res) => {
  if (audioGenerationInProgress) return res.status(409).json({ error: 'Audio generation in progress' });
  const library = loadLibrary();
  const sound = library.sounds[req.params.id];
  if (!sound) return res.status(404).json({ error: 'Sound not found' });
  const config = loadLibraryConfig();
  audioGenerationInProgress = true;

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  try {
    const backendKey = sound.backend || 'audiocraft';
    const backends = loadBackends();
    const adapterName = backends[backendKey]?.adapter || backendKey;
    const adapterPath = join(__dirname, 'adapters', `${adapterName}.js`);
    const adapter = await import(adapterPath);

    const wavDir = join(config.libraryRoot, dirname(sound.filePath));
    if (!existsSync(wavDir)) mkdirSync(wavDir, { recursive: true });
    const wavPath = join(config.libraryRoot, sound.filePath);

    res.write(`event: progress\ndata: ${JSON.stringify({ sound: req.params.id, status: 'generating', backend: backendKey })}\n\n`);

    const defaultProj = defaultProject ? loadProject(defaultProject) : null;
    const result = await adapter.generate({
      id: req.params.id,
      type: sound.category.startsWith('music') ? 'music' : 'sfx',
      prompt: sound.prompt,
      seed: sound.seed,
      duration: sound.duration,
      outputPath: wavPath,
      projectConfig: defaultProj || { _basePath: __dirname },
    });

    res.write(`event: progress\ndata: ${JSON.stringify({ sound: req.params.id, status: 'processing' })}\n\n`);
    processAudioFile(wavPath, wavDir, req.params.id, sound.category);

    sound.seed = result.seed != null ? Math.round(result.seed) : null;
    sound.lastModifiedAt = new Date().toISOString();
    sound.createdAt = sound.createdAt || sound.lastModifiedAt;
    saveLibrary(library);

    res.write(`event: done\ndata: ${JSON.stringify({ sound: req.params.id, seed: result.seed != null ? Math.round(result.seed) : null })}\n\n`);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ sound: req.params.id, error: err.message })}\n\n`);
  }

  res.write(`event: complete\ndata: ${JSON.stringify({ sound: req.params.id })}\n\n`);
  res.end();
  audioGenerationInProgress = false;
});

app.post('/api/library/regenerate-flagged', async (req, res) => {
  if (audioGenerationInProgress) return res.status(409).json({ error: 'Audio generation in progress' });
  const library = loadLibrary();
  const flagged = Object.entries(library.sounds).filter(([, s]) => s.flagged);
  if (flagged.length === 0) return res.status(400).json({ error: 'No flagged sounds' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  audioGenerationInProgress = true;
  const backends = loadBackends();
  const config = loadLibraryConfig();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < flagged.length; i++) {
    const [id, sound] = flagged[i];
    const backendKey = sound.backend || 'audiocraft';
    const index = i + 1;
    const total = flagged.length;

    res.write(`event: progress\ndata: ${JSON.stringify({ sound: id, status: 'generating', backend: backendKey, index, total })}\n\n`);

    try {
      const adapterName = backends[backendKey]?.adapter || backendKey;
      const adapterPath = join(__dirname, 'adapters', `${adapterName}.js`);
      const adapter = await import(adapterPath);

      const wavDir = join(config.libraryRoot, dirname(sound.filePath));
      if (!existsSync(wavDir)) mkdirSync(wavDir, { recursive: true });
      const wavPath = join(config.libraryRoot, sound.filePath);

      const defaultProj = defaultProject ? loadProject(defaultProject) : null;
      const result = await adapter.generate({
        id, type: sound.category.startsWith('music') ? 'music' : 'sfx',
        prompt: sound.prompt, seed: sound.seed, duration: sound.duration,
        outputPath: wavPath, projectConfig: defaultProj || { _basePath: __dirname },
      });

      res.write(`event: progress\ndata: ${JSON.stringify({ sound: id, status: 'processing', index, total })}\n\n`);
      processAudioFile(wavPath, wavDir, id, sound.category);

      const updatedLib = loadLibrary();
      updatedLib.sounds[id].seed = result.seed != null ? Math.round(result.seed) : null;
      updatedLib.sounds[id].lastModifiedAt = new Date().toISOString();
      updatedLib.sounds[id].createdAt = updatedLib.sounds[id].createdAt || updatedLib.sounds[id].lastModifiedAt;
      updatedLib.sounds[id].flagged = false;
      saveLibrary(updatedLib);

      succeeded++;
      res.write(`event: done\ndata: ${JSON.stringify({ sound: id, seed: result.seed != null ? Math.round(result.seed) : null, duration: sound.duration, index, total })}\n\n`);
    } catch (err) {
      failed++;
      res.write(`event: error\ndata: ${JSON.stringify({ sound: id, error: err.message, index, total })}\n\n`);
    }
  }

  res.write(`event: complete\ndata: ${JSON.stringify({ total: flagged.length, succeeded, failed })}\n\n`);
  res.end();
  audioGenerationInProgress = false;
});

app.post('/api/library/import', (req, res) => {
  const { project } = req.body;
  if (!project) return res.status(400).json({ error: 'project required' });
  const proj = loadProject(project);
  if (!proj) return res.status(404).json({ error: `Project ${project} not found` });
  const library = loadLibrary();
  const config = loadLibraryConfig();
  const imported = [];

  const subcategoryMap = {
    gunshot: 'sfx/weapons', gunshot_new: 'sfx/weapons', melee_swing: 'sfx/weapons',
    grenade_launch: 'sfx/weapons', grenade_explode: 'sfx/weapons',
    footstep_walk: 'sfx/footsteps', footstep_sprint: 'sfx/footsteps',
    bullet_impact: 'sfx/impacts', player_hit: 'sfx/impacts', player_death: 'sfx/impacts',
    health_pickup: 'sfx/ui', armor_pickup: 'sfx/ui',
    match_victory: 'sfx/ui', match_defeat: 'sfx/ui',
    round_start: 'sfx/ui', round_end: 'sfx/ui',
    zone_warning: 'sfx/environment', zone_tick: 'sfx/environment',
    battle: 'music/battle', lobby: 'music/ambient',
    victory: 'music/stings', defeat: 'music/stings', respect_event: 'music/stings',
  };

  const audioRoot = resolve(__dirname, proj.audioRoot);

  for (const [id, sound] of Object.entries(proj.sounds || {})) {
    if (library.sounds[id]) continue;
    const category = subcategoryMap[id] || (sound.type === 'music' ? 'music/ambient' : 'sfx/ui');
    const wavSrc = join(audioRoot, sound.filePath);

    if (existsSync(wavSrc)) {
      const nasDir = join(config.libraryRoot, category);
      if (!existsSync(nasDir)) mkdirSync(nasDir, { recursive: true });
      copyFileSync(wavSrc, join(nasDir, `${id}.wav`));

      library.sounds[id] = {
        id,
        name: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        category,
        tags: [project],
        prompt: sound.prompt || '',
        seed: sound.seed || null,
        duration: sound.duration || null,
        backend: sound.backend === 'default' ? 'audiocraft' : (sound.backend || 'audiocraft'),
        filePath: `${category}/${id}.wav`,
        createdAt: sound.lastGeneratedAt || new Date().toISOString(),
        assignedTo: {
          [project]: { targetPath: `${sound.type}/${id}`, syncedAt: new Date().toISOString() },
        },
      };
      imported.push(id);
    }
  }

  saveLibrary(library);
  res.json({ imported, count: imported.length });
});

// =============================================================================
// Visual Library Routes
// =============================================================================

function promptHash(prompt) {
  return createHash('sha256').update(prompt || '').digest('hex').slice(0, 16);
}

function markDownstreamStale(asset, fromPhase) {
  const phases = ['concept', 'model', 'render', 'pack'];
  const startIdx = phases.indexOf(fromPhase) + 1;
  for (let i = startIdx; i < phases.length; i++) {
    if (asset.pipeline[phases[i]]) {
      asset.pipeline[phases[i]].status = 'pending';
    }
  }
}

let visualGenerationInProgress = false;

// Track which concept backends are rate-limited for the current batch run
let _rateLimitedBackends = new Set();

/**
 * Try generating a concept using the priority chain of backends.
 * If a backend throws a RateLimitError, mark it as exhausted and try the next.
 * Returns { result, adapterName } on success.
 */
async function generateConceptWithFallback({ id, asset, vConfig, onFallback }) {
  const configPriority = vConfig.conceptBackendPriority || ['comfyui', 'gemini-imagen', 'siliconflow'];
  let backends;
  if (asset.conceptBackend) {
    backends = [asset.conceptBackend, ...configPriority.filter(b => b !== asset.conceptBackend)];
  } else {
    backends = [...configPriority];
  }

  const available = backends.filter(b => !_rateLimitedBackends.has(b));
  if (available.length === 0) {
    _rateLimitedBackends.clear();
    available.push(...backends);
  }

  let lastError;
  for (const backendName of available) {
    const adapterPath = join(__dirname, 'adapters', `${backendName}.js`);
    if (!existsSync(adapterPath)) continue;

    try {
      const adapter = await import(adapterPath);
      const result = await adapter.generate({ id, asset, config: vConfig, libraryRoot: vConfig.libraryRoot });
      return { result, adapterName: backendName };
    } catch (err) {
      if (err.name === 'RateLimitError') {
        _rateLimitedBackends.add(backendName);
        console.log(`  [Fallback] ${backendName} rate-limited, trying next backend...`);
        if (onFallback) onFallback(backendName, err.message);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('All concept backends exhausted (rate-limited)');
}

let _rateLimitedModelBackends = new Set();

/**
 * Try generating a 3D model using the priority chain of backends.
 * Mirrors generateConceptWithFallback — rate-limit aware fallback chain.
 * Returns { result, adapterName } on success.
 */
async function generateModelWithFallback({ id, asset, vConfig, onFallback }) {
  const configPriority = vConfig.modelBackendPriority || ['meshy', 'triposr'];
  let backends;
  if (asset.modelBackend) {
    backends = [asset.modelBackend, ...configPriority.filter(b => b !== asset.modelBackend)];
  } else {
    backends = [...configPriority];
  }

  const available = backends.filter(b => !_rateLimitedModelBackends.has(b));
  if (available.length === 0) {
    _rateLimitedModelBackends.clear();
    available.push(...backends);
  }

  let lastError;
  for (const backendName of available) {
    const adapterPath = join(__dirname, 'adapters', `${backendName}.js`);
    if (!existsSync(adapterPath)) continue;

    try {
      const adapter = await import(adapterPath);
      const result = await adapter.generate({ id, asset, config: vConfig, libraryRoot: vConfig.libraryRoot });
      return { result, adapterName: backendName };
    } catch (err) {
      if (err.name === 'RateLimitError') {
        _rateLimitedModelBackends.add(backendName);
        console.log(`  [Model Fallback] ${backendName} rate-limited, trying next backend...`);
        if (onFallback) onFallback(backendName, err.message);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('All model backends exhausted (rate-limited)');
}

app.get('/api/visual-library', (req, res) => {
  res.json(loadVisualLibrary());
});

app.get('/api/visual-library/:id', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  res.json(asset);
});

app.get('/api/visual-library/:id/concept', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!asset.pipeline.concept?.path) return res.status(404).json({ error: 'No concept generated' });
  const vConfig = loadVisualConfig();
  const filePath = join(vConfig.libraryRoot, asset.pipeline.concept.path);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(filePath);
});

app.get('/api/visual-library/:id/model', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (!asset.pipeline.model?.path) return res.status(404).json({ error: 'No model generated' });
  const vConfig = loadVisualConfig();
  const filePath = join(vConfig.libraryRoot, asset.pipeline.model.path);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(filePath);
});

app.get('/api/visual-library/:id/render/:pose/:direction', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const vConfig = loadVisualConfig();
  const filePath = join(vConfig.libraryRoot, 'renders', asset.category, asset.id,
    `${asset.id}-${req.params.pose}-${req.params.direction}.png`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Render not found' });
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(filePath);
});

// Serve render frame by filename (simpler than pose/direction pattern)
app.get('/api/visual-library/:id/render-frame/:filename', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const vConfig = loadVisualConfig();
  const filePath = join(vConfig.libraryRoot, 'renders', asset.category, asset.id, req.params.filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Frame not found' });
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(filePath);
});

// List all rendered frames for a visual asset
app.get('/api/visual-library/:id/renders', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const vConfig = loadVisualConfig();
  const renderDir = join(vConfig.libraryRoot, 'renders', asset.category, asset.id);
  if (!existsSync(renderDir)) return res.json({ frames: [] });
  const frames = readdirSync(renderDir).filter(f => f.endsWith('.png')).sort();
  res.json({ frames, basePath: `/api/visual-library/${req.params.id}/render` });
});

app.get('/api/visual-library/:id/atlas', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const vConfig = loadVisualConfig();
  const filePath = join(vConfig.libraryRoot, 'sprites', `${asset.category}.png`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Atlas not found' });
  res.sendFile(filePath);
});

// Upload a concept image from a client-rendered 3D model front view
app.post('/api/visual-library/:id/concept-from-snapshot', async (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  // Expect raw PNG body (Content-Type: image/png)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const pngBuffer = Buffer.concat(chunks);
  if (pngBuffer.length < 100) return res.status(400).json({ error: 'Empty or invalid image data' });

  const vConfig = loadVisualConfig();
  const conceptDir = join(vConfig.libraryRoot, 'concepts', asset.category);
  if (!existsSync(conceptDir)) mkdirSync(conceptDir, { recursive: true });
  const conceptPath = join(conceptDir, `${asset.id}.png`);
  writeFileSync(conceptPath, pngBuffer);

  asset.pipeline.concept = {
    status: 'done',
    generatedAt: new Date().toISOString(),
    backend: 'model-snapshot',
    path: `concepts/${asset.category}/${asset.id}.png`,
    promptHash: promptHash(asset.prompt),
  };
  saveVisualLibrary(library);

  console.log(`  [concept] Saved snapshot for ${asset.id} (${(pngBuffer.length / 1024).toFixed(1)} KB)`);
  res.json({ status: 'ok', size: pngBuffer.length });
});

app.post('/api/visual-library', (req, res) => {
  const { id, name, category, tags, prompt, poses, directions, size, color, conceptBackend, modelBackend } = req.body;
  if (!id || !name || !category) return res.status(400).json({ error: 'id, name, category required' });
  const library = loadVisualLibrary();
  if (library.assets[id]) return res.status(409).json({ error: 'Asset already exists' });
  const vConfig = loadVisualConfig();
  const catConfig = vConfig.categories[category] || {};

  const pipeline = {
    concept: { status: 'pending' },
    render: { status: 'pending' },
    pack: { status: 'pending' },
  };
  if (catConfig.has3D !== false) {
    pipeline.model = { status: 'pending' };
  }

  library.assets[id] = {
    id, name, category,
    tags: tags || [],
    prompt: prompt || '',
    poses: poses || catConfig.defaultPoses || ['idle'],
    directions: directions || catConfig.directions || 1,
    size: size || catConfig.size || 32,
    color: color || '#ffffff',
    conceptBackend: conceptBackend || null,
    modelBackend: modelBackend || null,
    pipeline,
    assignedTo: {},
  };

  saveVisualLibrary(library);
  res.status(201).json(library.assets[id]);
});

app.put('/api/visual-library/:id', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const oldPrompt = asset.prompt;
  const allowed = ['name', 'category', 'tags', 'prompt', 'poses', 'directions', 'size', 'color', 'conceptBackend', 'modelBackend'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) asset[key] = req.body[key];
  }
  // Prompt changed → invalidate entire pipeline (concept + downstream)
  if (req.body.prompt !== undefined && req.body.prompt !== oldPrompt) {
    for (const phase of ['concept', 'model', 'render', 'pack']) {
      if (asset.pipeline[phase]) asset.pipeline[phase].status = 'pending';
    }
  }
  saveVisualLibrary(library);
  res.json(asset);
});

app.delete('/api/visual-library/:id', (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const vConfig = loadVisualConfig();

  // Best-effort NAS cleanup
  const conceptPath = join(vConfig.libraryRoot, 'concepts', asset.category, `${asset.id}.png`);
  if (existsSync(conceptPath)) unlinkSync(conceptPath);
  const modelPath = join(vConfig.libraryRoot, 'models', asset.category, `${asset.id}.glb`);
  if (existsSync(modelPath)) unlinkSync(modelPath);

  delete library.assets[req.params.id];
  saveVisualLibrary(library);
  res.json({ deleted: req.params.id });
});

app.post('/api/visual-library/batch/generate', async (req, res) => {
  if (visualGenerationInProgress) return res.status(409).json({ error: 'Visual generation in progress' });
  const { ids, fromPhase } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });

  visualGenerationInProgress = true;
  req.on('close', () => { visualGenerationInProgress = false; });
  _rateLimitedBackends.clear();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  try {
    const library = loadVisualLibrary();
    const vConfig = loadVisualConfig();
    let succeeded = 0, failed = 0;

    for (const id of ids) {
      const asset = library.assets[id];
      if (!asset) {
        res.write(`event: error\ndata: ${JSON.stringify({ asset: id, error: 'Not found' })}\n\n`);
        failed++;
        continue;
      }

      const phases = ['concept', 'model', 'render', 'pack'];
      let startIdx = fromPhase ? phases.indexOf(fromPhase) : 0;
      const catConfig = vConfig.categories[asset.category] || {};
      // Force concept regeneration if prompt changed since last concept was generated
      // Skip stale detection for externally sourced assets (Sketchfab thumbnails / placeholders)
      const batchIsExternal = asset.sketchfabUid || asset.pipeline.concept?.backend === 'sketchfab-thumbnail';
      const batchConceptStale = !batchIsExternal
        && asset.pipeline.concept?.status === 'done'
        && asset.pipeline.concept.promptHash !== promptHash(asset.prompt);
      if (batchConceptStale && startIdx > 0) startIdx = 0;
      const phasesToRun = phases.slice(startIdx >= 0 ? startIdx : 0)
        .filter(p => !(p === 'model' && catConfig.has3D === false))
        .filter(p => asset.pipeline[p]);

      let assetFailed = false;
      for (const p of phasesToRun) {
        try {
          res.write(`event: progress\ndata: ${JSON.stringify({ asset: id, phase: p, status: 'generating' })}\n\n`);
          asset._currentPhase = p;

          let result, adapterName;

          if (p === 'concept') {
            // Use fallback chain for concept generation (ComfyUI → Gemini → SiliconFlow)
            const fallbackResult = await generateConceptWithFallback({
              id, asset, vConfig,
              onFallback: (backend, reason) => {
                res.write(`event: fallback\ndata: ${JSON.stringify({ asset: id, phase: p, from: backend, reason })}\n\n`);
              },
            });
            result = fallbackResult.result;
            adapterName = fallbackResult.adapterName;
          } else if (p === 'model') {
            // Use fallback chain for model generation (Meshy → Hyper3D → Hunyuan3D → TripoSR)
            _rateLimitedModelBackends.clear();
            const fallbackResult = await generateModelWithFallback({
              id, asset, vConfig,
              onFallback: (backend, reason) => {
                res.write(`event: fallback\ndata: ${JSON.stringify({ asset: id, phase: p, from: backend, reason })}\n\n`);
              },
            });
            result = fallbackResult.result;
            adapterName = fallbackResult.adapterName;
          } else {
            const defaultAdapterMap = { render: 'blender', pack: 'packer', rig: 'mixamo', animate: 'mixamo' };
            adapterName = defaultAdapterMap[p];
            const adapterPath = join(__dirname, 'adapters', `${adapterName}.js`);
            if (!existsSync(adapterPath)) throw new Error(`Adapter ${adapterName} not found`);

            const adapter = await import(adapterPath);
            result = await adapter.generate({ id, asset, config: vConfig, libraryRoot: vConfig.libraryRoot });
          }

          asset.pipeline[p] = { status: 'done', generatedAt: new Date().toISOString(), backend: adapterName };
          if (p === 'concept') asset.pipeline[p].promptHash = promptHash(asset.prompt);
          if (result.path) asset.pipeline[p].path = result.path;
          if (result.frameCount) asset.pipeline[p].frameCount = result.frameCount;
          if (result.backend) asset.pipeline[p].backend = result.backend;
          saveVisualLibrary(library);

          res.write(`event: done\ndata: ${JSON.stringify({ asset: id, phase: p, ...result, backend: adapterName })}\n\n`);
        } catch (err) {
          asset.pipeline[p] = { status: 'error' };
          saveVisualLibrary(library);
          res.write(`event: error\ndata: ${JSON.stringify({ asset: id, phase: p, error: err.message })}\n\n`);
          assetFailed = true;
          break;
        }
      }
      if (assetFailed) failed++; else succeeded++;
    }

    visualGenerationInProgress = false;
    res.write(`event: complete\ndata: ${JSON.stringify({ total: ids.length, succeeded, failed })}\n\n`);
    res.end();
  } catch (outerErr) {
    visualGenerationInProgress = false;
    try { res.end(); } catch {}
  }
});

app.post('/api/visual-library/import', (req, res) => {
  const { project } = req.body;
  if (!project) return res.status(400).json({ error: 'project required' });
  const proj = loadProject(project);
  if (!proj) return res.status(404).json({ error: `Project ${project} not found` });

  const library = loadVisualLibrary();
  const vConfig = loadVisualConfig();

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(__dirname, proj.manifestPath), 'utf-8'));
  } catch {
    return res.status(400).json({ error: 'Cannot read manifest' });
  }

  const imported = [];
  const arenaRoot = resolve(__dirname, proj.audioRoot, '..');

  const categoryAssets = {
    characters: manifest.characters || [],
    weapons: manifest.weapons || [],
    items: manifest.items || [],
    tiles: manifest.tiles || [],
    cover: manifest.cover || [],
    ui: manifest.ui || [],
  };

  for (const [category, assets] of Object.entries(categoryAssets)) {
    const catConfig = vConfig.categories[category] || {};

    for (const asset of assets) {
      const id = asset.id;
      if (library.assets[id]) continue;

      const pipeline = {};

      // Concept
      const conceptSrc = join(arenaRoot, 'concepts', category, `${id}.png`);
      if (existsSync(conceptSrc)) {
        const conceptDest = join(vConfig.libraryRoot, 'concepts', category);
        if (!existsSync(conceptDest)) mkdirSync(conceptDest, { recursive: true });
        copyFileSync(conceptSrc, join(conceptDest, `${id}.png`));
        pipeline.concept = { status: 'done', path: `concepts/${category}/${id}.png`, generatedAt: new Date().toISOString() };
      } else {
        pipeline.concept = { status: 'pending' };
      }

      // Model (3D categories only)
      if (catConfig.has3D !== false) {
        const modelSrc = join(arenaRoot, 'models', category, `${id}.glb`);
        if (existsSync(modelSrc)) {
          const modelDest = join(vConfig.libraryRoot, 'models', category);
          if (!existsSync(modelDest)) mkdirSync(modelDest, { recursive: true });
          copyFileSync(modelSrc, join(modelDest, `${id}.glb`));
          pipeline.model = { status: 'done', path: `models/${category}/${id}.glb`, generatedAt: new Date().toISOString() };
        } else {
          pipeline.model = { status: 'pending' };
        }
      }

      // Renders
      const renderSrc = join(arenaRoot, 'renders', category, id);
      if (existsSync(renderSrc) && statSync(renderSrc).isDirectory()) {
        const renderDest = join(vConfig.libraryRoot, 'renders', category, id);
        if (!existsSync(renderDest)) mkdirSync(renderDest, { recursive: true });
        const files = readdirSync(renderSrc).filter(f => f.endsWith('.png'));
        for (const f of files) copyFileSync(join(renderSrc, f), join(renderDest, f));
        pipeline.render = { status: 'done', frameCount: files.length, generatedAt: new Date().toISOString() };
      } else {
        pipeline.render = { status: 'pending' };
      }

      // Pack (check atlas)
      const atlasSrc = join(arenaRoot, '..', 'frontend', 'public', 'assets', 'sprites', `${category}.png`);
      if (existsSync(atlasSrc)) {
        const spritesDest = join(vConfig.libraryRoot, 'sprites');
        if (!existsSync(spritesDest)) mkdirSync(spritesDest, { recursive: true });
        for (const ext of ['.png', '.json']) {
          const src = join(arenaRoot, '..', 'frontend', 'public', 'assets', 'sprites', `${category}${ext}`);
          if (existsSync(src)) copyFileSync(src, join(spritesDest, `${category}${ext}`));
        }
        pipeline.pack = { status: 'done', generatedAt: new Date().toISOString() };
      } else {
        pipeline.pack = { status: 'pending' };
      }

      library.assets[id] = {
        id,
        name: asset.name || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        category,
        tags: [project],
        prompt: asset.prompt || '',
        conceptBackend: 'comfyui',
        poses: asset.poses || catConfig.defaultPoses || ['idle'],
        directions: catConfig.directions || 1,
        size: asset.size || catConfig.size || 32,
        color: asset.color || '#ffffff',
        pipeline,
        assignedTo: { [project]: { atlas: category, syncedAt: new Date().toISOString() } },
      };
      imported.push(id);
    }
  }

  // Copy Blender templates
  const blendSrc = join(arenaRoot, 'blend');
  if (existsSync(blendSrc) && statSync(blendSrc).isDirectory()) {
    const blendDest = join(vConfig.libraryRoot, 'blend');
    if (!existsSync(blendDest)) mkdirSync(blendDest, { recursive: true });
    const walkAndCopy = (src, dest) => {
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        try {
          if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(srcPath).isDirectory())) {
            if (!existsSync(destPath)) mkdirSync(destPath, { recursive: true });
            walkAndCopy(srcPath, destPath);
          } else {
            copyFileSync(srcPath, destPath);
          }
        } catch (err) {
          console.warn(`  Skipping ${srcPath}: ${err.message}`);
        }
      }
    };
    try {
      walkAndCopy(blendSrc, blendDest);
    } catch (err) {
      console.warn(`  Blender template copy warning: ${err.message}`);
    }
  }

  saveVisualLibrary(library);
  res.json({ imported, count: imported.length });
});

app.post('/api/visual-library/:id/generate/:phase', async (req, res) => {
  if (visualGenerationInProgress) return res.status(409).json({ error: 'Visual generation in progress' });
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const phase = req.params.phase;
  const validPhases = ['concept', 'model', 'render', 'pack', 'rig', 'animate', 'full'];
  if (!validPhases.includes(phase)) return res.status(400).json({ error: `Invalid phase: ${phase}` });

  visualGenerationInProgress = true;
  req.on('close', () => { visualGenerationInProgress = false; });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  try {
    const vConfig = loadVisualConfig();
    const catConfig = vConfig.categories[asset.category] || {};

    // Detect stale concept: prompt changed since last concept generation
    // Skip stale detection for externally sourced assets (Sketchfab thumbnails / placeholders)
    const isExternallySourced = asset.sketchfabUid || asset.pipeline.concept?.backend === 'sketchfab-thumbnail';
    const conceptStale = !isExternallySourced
      && asset.pipeline.concept?.status === 'done'
      && asset.pipeline.concept.promptHash !== promptHash(asset.prompt);

    let phasesToRun;
    if (phase === 'full') {
      // If concept is stale, re-run entire pipeline (concept changed → everything downstream is invalid)
      phasesToRun = ['concept', 'model', 'render', 'pack']
        .filter(p => asset.pipeline[p] && (asset.pipeline[p].status !== 'done' || conceptStale));
    } else {
      phasesToRun = [phase];
    }
    // Skip model for non-3D categories
    phasesToRun = phasesToRun.filter(p => !(p === 'model' && catConfig.has3D === false));

    _rateLimitedBackends.clear();
    for (const p of phasesToRun) {
      try {
        res.write(`event: progress\ndata: ${JSON.stringify({ asset: asset.id, phase: p, status: 'generating' })}\n\n`);
        if (!asset.pipeline[p]) asset.pipeline[p] = {};
        asset.pipeline[p].status = 'generating';
        asset._currentPhase = p;

        let result, adapterName;

        if (p === 'concept') {
          const fallbackResult = await generateConceptWithFallback({
            id: asset.id, asset, vConfig,
            onFallback: (backend, reason) => {
              res.write(`event: fallback\ndata: ${JSON.stringify({ asset: asset.id, phase: p, from: backend, reason })}\n\n`);
            },
          });
          result = fallbackResult.result;
          adapterName = fallbackResult.adapterName;
        } else if (p === 'model') {
          _rateLimitedModelBackends.clear();
          const fallbackResult = await generateModelWithFallback({
            id: asset.id, asset, vConfig,
            onFallback: (backend, reason) => {
              res.write(`event: fallback\ndata: ${JSON.stringify({ asset: asset.id, phase: p, from: backend, reason })}\n\n`);
            },
          });
          result = fallbackResult.result;
          adapterName = fallbackResult.adapterName;
        } else {
          const defaultAdapterMap = { render: 'blender', pack: 'packer', rig: 'mixamo', animate: 'mixamo' };
          adapterName = defaultAdapterMap[p];
          const adapterPath = join(__dirname, 'adapters', `${adapterName}.js`);
          if (!existsSync(adapterPath)) throw new Error(`Adapter not found: ${adapterPath}`);

          const adapter = await import(adapterPath);
          result = await adapter.generate({ id: asset.id, asset, config: vConfig, libraryRoot: vConfig.libraryRoot });
        }

        asset.pipeline[p].status = 'done';
        asset.pipeline[p].generatedAt = new Date().toISOString();
        asset.pipeline[p].backend = adapterName;
        if (p === 'concept') asset.pipeline[p].promptHash = promptHash(asset.prompt);
        if (result.path) asset.pipeline[p].path = result.path;
        if (result.frameCount) asset.pipeline[p].frameCount = result.frameCount;

        markDownstreamStale(asset, p);
        saveVisualLibrary(library);

        res.write(`event: done\ndata: ${JSON.stringify({ asset: asset.id, phase: p, ...result, backend: adapterName })}\n\n`);
      } catch (err) {
        asset.pipeline[p].status = 'error';
        saveVisualLibrary(library);
        res.write(`event: error\ndata: ${JSON.stringify({ asset: asset.id, phase: p, error: err.message })}\n\n`);
        break;
      }
    }

    visualGenerationInProgress = false;
    res.write(`event: complete\ndata: ${JSON.stringify({ asset: asset.id })}\n\n`);
    res.end();
  } catch (outerErr) {
    visualGenerationInProgress = false;
    try { res.end(); } catch {}
  }
});

app.post('/api/visual-library/:id/assign', (req, res) => {
  const { project, atlas } = req.body;
  if (!project || !atlas) return res.status(400).json({ error: 'project and atlas required' });
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const proj = loadProject(project);
  if (!proj) return res.status(404).json({ error: `Project ${project} not found` });

  // Record assignment only — file copying happens during sync
  if (!asset.assignedTo) asset.assignedTo = {};
  asset.assignedTo[project] = { atlas, syncedAt: null };
  saveVisualLibrary(library);
  res.json(asset);
});

app.post('/api/visual-library/:id/unassign', (req, res) => {
  const { project } = req.body;
  if (!project) return res.status(400).json({ error: 'project required' });
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.assignedTo?.[project]) {
    delete asset.assignedTo[project];
    saveVisualLibrary(library);
  }
  res.json(asset);
});

app.post('/api/projects/:name/sync-visual', (req, res) => {
  const project = loadProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const library = loadVisualLibrary();
  const vConfig = loadVisualConfig();
  const synced = [];

  // Write to NAS exports dir (accessible from container), not project outputRoot
  const exportDir = join(vConfig.libraryRoot, 'exports', req.params.name, 'sprites');
  if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

  for (const [id, asset] of Object.entries(library.assets)) {
    const assignment = asset.assignedTo?.[req.params.name];
    if (!assignment) continue;
    const packGen = asset.pipeline?.pack?.generatedAt;
    if (packGen && assignment.syncedAt && new Date(packGen) <= new Date(assignment.syncedAt)) continue;

    for (const ext of ['.png', '.json']) {
      const src = join(vConfig.libraryRoot, 'sprites', `${asset.category}${ext}`);
      if (existsSync(src)) copyFileSync(src, join(exportDir, `${asset.category}${ext}`));
    }

    assignment.syncedAt = new Date().toISOString();
    synced.push(id);
  }

  saveVisualLibrary(library);
  res.json({ synced, count: synced.length, exportPath: exportDir });
});

// =============================================================================
// Sketchfab & PolyHaven API proxies
// =============================================================================

app.get('/api/sketchfab/search', async (req, res) => {
  try {
    const adapter = await import(join(__dirname, 'adapters', 'sketchfab.js'));
    const results = await adapter.search({
      query: req.query.q || '',
      count: parseInt(req.query.count) || 20,
    });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sketchfab/preview/:uid', async (req, res) => {
  try {
    const key = process.env.SKETCHFAB_API_KEY;
    if (!key) return res.status(400).json({ error: 'SKETCHFAB_API_KEY not set' });

    const apiRes = await fetch(`https://api.sketchfab.com/v3/models/${req.params.uid}`, {
      headers: { Authorization: `Token ${key}` },
    });
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: 'Sketchfab API error' });
    const model = await apiRes.json();
    res.json({
      uid: model.uid,
      name: model.name,
      thumbnail: model.thumbnails?.images?.[0]?.url,
      vertexCount: model.vertexCount,
      faceCount: model.faceCount,
      isAnimated: model.isAnimated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/visual-library/:id/source/sketchfab', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  asset.sketchfabUid = uid;
  asset.modelBackend = 'sketchfab';
  // Invalidate model phase so next generate picks up the Sketchfab source
  if (asset.pipeline.model) asset.pipeline.model.status = 'pending';

  // If concept is not done, create a placeholder so pipeline gate doesn't block model phase.
  // Use the Sketchfab thumbnail as concept art and lock the promptHash so it's never stale.
  if (asset.pipeline.concept?.status !== 'done') {
    const vConfig = loadVisualConfig();
    const conceptDir = join(vConfig.libraryRoot, 'concepts', asset.category);
    if (!existsSync(conceptDir)) mkdirSync(conceptDir, { recursive: true });
    const conceptPath = join(conceptDir, `${asset.id}.png`);

    // Try to download Sketchfab thumbnail as placeholder concept
    try {
      const apiKey = process.env.SKETCHFAB_API_KEY;
      const headers = apiKey ? { Authorization: `Token ${apiKey}` } : {};
      const modelResp = await fetch(`https://api.sketchfab.com/v3/models/${uid}`, { headers });
      if (modelResp.ok) {
        const modelData = await modelResp.json();
        const thumbUrl = modelData.thumbnails?.images?.[0]?.url;
        if (thumbUrl) {
          const imgResp = await fetch(thumbUrl);
          if (imgResp.ok) {
            const buffer = Buffer.from(await imgResp.arrayBuffer());
            writeFileSync(conceptPath, buffer);
          }
        }
      }
    } catch (_) { /* thumbnail download is best-effort */ }

    asset.pipeline.concept = {
      status: 'done',
      generatedAt: new Date().toISOString(),
      backend: 'sketchfab-thumbnail',
      path: `concepts/${asset.category}/${asset.id}.png`,
      promptHash: promptHash(asset.prompt),
    };
  }

  saveVisualLibrary(library);
  res.json(asset);
});

app.get('/api/polyhaven/search', async (req, res) => {
  try {
    const adapter = await import(join(__dirname, 'adapters', 'polyhaven.js'));
    const results = await adapter.search({
      type: req.query.type || 'textures',
      categories: req.query.categories,
    });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/visual-library/:id/texture/:textureId', async (req, res) => {
  const library = loadVisualLibrary();
  const asset = library.assets[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  try {
    const adapter = await import(join(__dirname, 'adapters', 'polyhaven.js'));
    const vConfig = loadVisualConfig();
    const texturePath = join(vConfig.libraryRoot, 'textures', asset.category, `${req.params.id}_${req.params.textureId}.jpg`);

    await adapter.download({
      assetId: req.params.textureId,
      type: 'textures',
      resolution: req.body.resolution || '1k',
      outputPath: texturePath,
    });

    if (!asset.textures) asset.textures = {};
    asset.textures[req.params.textureId] = texturePath;
    saveVisualLibrary(library);
    res.json({ asset: asset.id, texture: req.params.textureId, path: texturePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Static serving & startup
// =============================================================================

// Health endpoint (k8s probes)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Worker status endpoint (UI polling)
app.get('/api/worker-status', (req, res) => {
  res.json(getWorkerStatus());
});

app.get('/api/queue-depth', (req, res) => {
  res.json(getQueueDepth());
});

app.use(express.static(__dirname));

const httpServer = createServer(app);
initWorkerManager(httpServer);

httpServer.listen(PORT, async () => {
  console.log(`\n  Assetgenerator running at http://localhost:${PORT}`);
  console.log(`  Prerequisites: python=${prerequisites.python} ffmpeg=${prerequisites.ffmpeg} cuda=${prerequisites.cuda}\n`);

  if (defaultProject) {
    const project = loadProject(defaultProject);
    if (project) {
      // Re-check prerequisites with project's venv python
      if (project.pythonPath) {
        const resolvedPy = resolve(__dirname, project.pythonPath);
        checkPrerequisites(resolvedPy);
        console.log(`  Prerequisites (with venv): python=${prerequisites.python} ffmpeg=${prerequisites.ffmpeg} cuda=${prerequisites.cuda}`);
        console.log(`  Python: ${prerequisites.pythonPath}`);
      }
      console.log(`  Auto-scanning project: ${defaultProject}`);
      scanProject(project);
    } else {
      console.log(`  Warning: project "${defaultProject}" not found in projects/`);
    }
  }

  if (process.env.BROWSER !== 'none') {
    try {
      const openModule = await import('open');
      const cp = openModule.default(`http://localhost:${PORT}`);
      if (cp && typeof cp.on === 'function') cp.on('error', () => {});
    } catch { /* silent */ }
  }
});

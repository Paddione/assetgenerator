import { resolve, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enqueueJob } from '../worker-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.ASSETGENERATOR_ROOT || resolve(__dirname, '..');

export async function generate({ id, asset, config, libraryRoot, onProgress }) {
  const blenderPath = config.blenderPath || 'blender';
  const catConfig = config.categories?.[asset.category] || {};
  const phase = asset._currentPhase;

  if (phase === 'rig') {
    return generateRig({ id, asset, config, libraryRoot, blenderPath, onProgress });
  }

  if (phase === 'animate') {
    return generateAnimations({ id, asset, config, libraryRoot, blenderPath, catConfig, onProgress });
  }

  throw new Error(`mixamo adapter: unknown phase "${phase}". Expected "rig" or "animate".`);
}

async function generateRig({ id, asset, config, libraryRoot, blenderPath, onProgress }) {
  const inputPath = join(libraryRoot, 'models', asset.category, `${id}.glb`);
  const riggedPath = join(libraryRoot, 'models', asset.category, `${id}_rigged.glb`);
  const optimizedPath = join(libraryRoot, 'models', asset.category, `${id}_rigged_opt.glb`);

  const autoRigScript = join(PROJECT_ROOT, 'scripts', 'auto_rig.py');
  const optimizeScript = join(PROJECT_ROOT, 'scripts', 'optimize_glb.sh');

  if (!existsSync(inputPath)) {
    throw new Error(`mixamo rig: input model not found: ${inputPath}`);
  }

  // Step 1: Auto-rig via Blender + Rigify
  if (onProgress) onProgress(`Rigging ${id} with Rigify...`);
  const rigArgs = [
    '--background',
    '--python', autoRigScript,
    '--',
    '--input', inputPath,
    '--output', riggedPath,
  ];

  const rigResult = await enqueueJob({ cmd: blenderPath, args: rigArgs, cwd: PROJECT_ROOT, env: {} });
  if (rigResult.code !== 0) {
    throw new Error(`auto_rig.py exited ${rigResult.code}: ${rigResult.stderr.slice(-500)}`);
  }

  if (!existsSync(riggedPath)) {
    throw new Error(`auto_rig.py exited 0 but ${riggedPath} was not created`);
  }

  // Step 2: Optimize the rigged GLB
  if (onProgress) onProgress(`Optimizing rigged GLB for ${id}...`);
  const optResult = await enqueueJob({
    cmd: 'bash',
    args: [optimizeScript, riggedPath, optimizedPath],
    cwd: PROJECT_ROOT,
    env: {},
  });
  if (optResult.code !== 0) {
    throw new Error(`optimize_glb.sh exited ${optResult.code}: ${optResult.stderr.slice(-500)}`);
  }

  if (!existsSync(optimizedPath)) {
    throw new Error(`optimize_glb.sh exited 0 but ${optimizedPath} was not created`);
  }

  return {
    status: 'done',
    path: `models/${asset.category}/${id}_rigged_opt.glb`,
    backend: 'mixamo',
  };
}

async function generateAnimations({ id, asset, config, libraryRoot, blenderPath, catConfig, onProgress }) {
  const riggedPath = join(libraryRoot, 'models', asset.category, `${id}_rigged_opt.glb`);
  const animOutputDir = join(libraryRoot, 'animations', asset.category, id);

  const bakeScript = join(PROJECT_ROOT, 'scripts', 'bake_animation.py');

  if (!existsSync(riggedPath)) {
    throw new Error(`mixamo animate: rigged model not found: ${riggedPath}. Run "rig" phase first.`);
  }

  const clips = catConfig.animationClips || [];
  if (clips.length === 0) {
    throw new Error(`mixamo animate: no animationClips defined in config for category "${asset.category}"`);
  }

  const results = [];

  for (const clip of clips) {
    if (onProgress) onProgress(`Baking animation "${clip}" for ${id}...`);
    const clipOutputPath = join(animOutputDir, `${clip}.glb`);

    const bakeArgs = [
      '--background',
      '--python', bakeScript,
      '--',
      '--input', riggedPath,
      '--clip', clip,
      '--output', clipOutputPath,
    ];

    const bakeResult = await enqueueJob({ cmd: blenderPath, args: bakeArgs, cwd: PROJECT_ROOT, env: {} });
    if (bakeResult.code !== 0) {
      throw new Error(`bake_animation.py exited ${bakeResult.code} for clip "${clip}": ${bakeResult.stderr.slice(-500)}`);
    }

    if (!existsSync(clipOutputPath)) {
      throw new Error(`bake_animation.py exited 0 but ${clipOutputPath} was not created`);
    }

    results.push(clip);
  }

  return {
    status: 'done',
    clips: results,
    path: `animations/${asset.category}/${id}`,
    backend: 'mixamo',
  };
}

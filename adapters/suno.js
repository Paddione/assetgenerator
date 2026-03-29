import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import https from 'node:https';

/**
 * Suno adapter — generates music via Suno AI (through sunoapi.org).
 * Runs on the server (cloud API, no GPU needed). Async: submits job, polls until ready.
 *
 * Requires: SUNO_API_KEY environment variable
 * Get key at: https://sunoapi.org (third-party Suno API wrapper)
 *
 * Best for: lobby music, battle themes, victory stings (up to 8 min)
 * Not suitable for: short SFX (use AudioCraft or ElevenLabs instead)
 *
 * Models: V4, V4_5, V4_5PLUS, V4_5ALL, V5
 */

const API_BASE = 'https://api.sunoapi.org/api/v1';
const DEFAULT_MODEL = 'V4_5';
const POLL_INTERVAL = 5000; // 5 seconds between polls
const MAX_POLL_TIME = 300_000; // 5 minute timeout

function apiRequest(method, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${path}`);
    const isGet = method === 'GET';

    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...(!isGet && { 'Content-Type': 'application/json' }),
      },
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Suno API ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Suno API invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (!isGet && body) req.write(JSON.stringify(body));
    req.end();
  });
}

function downloadAudio(audioUrl) {
  return new Promise((resolve, reject) => {
    const doGet = (url) => {
      https.get(url, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Audio download failed: ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    doGet(audioUrl);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function generate({ id, type, prompt, seed, duration, outputPath, projectConfig }) {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) {
    throw new Error('SUNO_API_KEY environment variable not set. Get one at https://sunoapi.org');
  }

  if (!prompt) {
    throw new Error('Prompt is required for Suno music generation');
  }

  // Ensure output directory exists
  if (outputPath) {
    const dir = join(outputPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const isInstrumental = type === 'music';
  const style = isInstrumental
    ? 'video game soundtrack, electronic, loopable'
    : 'video game sound effect';

  console.log(`  [Suno] Generating ${type} for ${id}: "${prompt.slice(0, 80)}..."`);

  // Submit generation request
  const submitResponse = await apiRequest('POST', '/generate', apiKey, {
    customMode: true,
    instrumental: isInstrumental,
    prompt: prompt,
    style: style,
    title: id,
    model: DEFAULT_MODEL,
    callBackUrl: 'https://localhost/suno-callback',  // Required by API, not used (we poll instead)
  });

  if (submitResponse.code !== 200 || !submitResponse.data?.taskId) {
    throw new Error(`Suno submit failed: ${JSON.stringify(submitResponse)}`);
  }

  const taskId = submitResponse.data.taskId;
  console.log(`  [Suno] Task submitted: ${taskId}`);

  // Poll for completion
  const startTime = Date.now();
  let lastStatus = '';

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await sleep(POLL_INTERVAL);

    const statusUrl = `/generate/record-info?taskId=${encodeURIComponent(taskId)}`;
    const statusResponse = await apiRequest('GET', statusUrl, apiKey);

    const status = statusResponse.data?.status;
    if (status !== lastStatus) {
      console.log(`  [Suno] Status: ${status}`);
      lastStatus = status;
    }

    if (status === 'SUCCESS') {
      const sunoData = statusResponse.data?.response?.sunoData;
      if (!sunoData || sunoData.length === 0) {
        throw new Error('Suno returned SUCCESS but no audio data');
      }

      // Take the first generated track
      const track = sunoData[0];
      const audioUrl = track.audioUrl;
      if (!audioUrl) {
        throw new Error('Suno track missing audioUrl');
      }

      console.log(`  [Suno] Downloading: ${track.title} (${track.duration}s)`);

      // Download the audio file
      const audioBuffer = await downloadAudio(audioUrl);

      // Suno returns MP3 — save it, then convert to WAV if outputPath specified
      if (outputPath) {
        // Save MP3 first
        const mp3Path = outputPath.replace(/\.wav$/, '.mp3');
        writeFileSync(mp3Path, audioBuffer);
        console.log(`  [Suno] Saved MP3: ${mp3Path} (${(audioBuffer.length / 1024).toFixed(0)} KB)`);

        // Convert MP3 to WAV using ffmpeg (for consistency with other adapters)
        const { execFileSync } = await import('node:child_process');
        try {
          execFileSync('ffmpeg', [
            '-y', '-i', mp3Path,
            '-ar', '32000', '-ac', '1',
            outputPath,
          ], { stdio: 'pipe', timeout: 30000 });
          console.log(`  [Suno] Converted to WAV: ${outputPath}`);
        } catch (err) {
          console.warn(`  [Suno] ffmpeg conversion failed, keeping MP3: ${err.message}`);
        }
      }

      console.log(`  [Suno] Done: ${track.title} (${track.duration}s, track: ${track.id})`);

      return {
        seed: seed,
        stdout: `SEED:${seed || 0}\nSUNO_TRACK_ID:${track.id}\nDURATION:${track.duration}\n`,
        stderr: '',
      };
    }

    // Check for error states
    if (status && status.includes('FAILED') || status === 'SENSITIVE_WORD_ERROR') {
      throw new Error(`Suno generation failed: ${status}`);
    }
  }

  throw new Error(`Suno generation timed out after ${MAX_POLL_TIME / 1000}s (task: ${taskId})`);
}

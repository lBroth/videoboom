// BYOK secret storage. API keys are encrypted at rest with Electron `safeStorage` (backed by the OS
// keychain / credential store) and persisted as base64 ciphertext in keys.json under userData. They are
// decrypted only in-memory when spawning the sidecar — never logged, never sent anywhere but the child's
// env, never written in plaintext.
import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

// logical key name -> the env var the render engine reads
const ENV_MAP: Record<string, string> = {
  openrouter: 'VB_OPENROUTER_API_KEY',   // required (LLM storyboard, image keyframes, i2v, moderation)
  replicate: 'REPLICATE_API_TOKEN',      // required (WhisperX forced-aligned transcription)
};

function keysFile(): string {
  return path.join(app.getPath('userData'), 'keys.json');
}

function readStore(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(keysFile(), 'utf8')); } catch { return {}; }
}

function writeStore(store: Record<string, string>): void {
  fs.writeFileSync(keysFile(), JSON.stringify(store), { mode: 0o600 });   // owner-only
}

export function setKey(name: string, value: string): void {
  if (!(name in ENV_MAP)) throw new Error(`unknown key: ${name}`);
  const store = readStore();
  if (!value) {
    delete store[name];
  } else if (safeStorage.isEncryptionAvailable()) {
    store[name] = safeStorage.encryptString(value).toString('base64');
  } else {
    // No OS encryption backend (rare headless Linux) — refuse to store plaintext rather than leak a key.
    throw new Error('OS secure storage unavailable — cannot store API keys safely on this system');
  }
  writeStore(store);
}

function decrypt(b64: string): string {
  try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return ''; }
}

/** Which keys are set (booleans only — never returns the secret value to the renderer). */
export function keyStatus(): Record<string, boolean> {
  const store = readStore();
  return Object.fromEntries(Object.keys(ENV_MAP).map((k) => [k, Boolean(store[k])]));
}

/** Decrypt all stored keys into the env-var map the sidecar expects (main process only). */
export function keysEnv(): Record<string, string> {
  const store = readStore();
  const env: Record<string, string> = {};
  for (const [name, envVar] of Object.entries(ENV_MAP)) {
    if (store[name]) {
      const v = decrypt(store[name]);
      if (v) env[envVar] = v;
    }
  }
  return env;
}

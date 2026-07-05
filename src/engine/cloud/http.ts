// Shared HTTP helpers for the cloud stage clients (OpenRouter + Replicate). Every provider URL in the app
// lives under src/engine/cloud/** (the check-no-cloud allowlist, DUAL_BACKEND_PLAN.md §6) — this file owns
// the OpenRouter base + auth header. Restored from 5125093~1:src/engine/providers.ts.
import fs from 'node:fs';
import { env } from '../config';
import { hostAllowed } from '../../shared/netAllowlist';

export const OR = 'https://openrouter.ai/api/v1';
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function orHdr(): Record<string, string> {
  return { Authorization: 'Bearer ' + env('VB_OPENROUTER_API_KEY'), 'Content-Type': 'application/json', 'User-Agent': UA };
}

interface HttpErr extends Error {
  status?: number;
  body?: string;
}

export async function httpJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  // Backstop: a cloud client may only ever reach a known provider host (defends against a mistyped/hijacked
  // slug or endpoint pointing traffic off-provider). The resolver already ensures we're here only when opted in.
  let host = '';
  try { host = new URL(url).hostname; } catch { /* invalid URL → blocked below */ }
  if (!hostAllowed(host)) throw new Error(`blocked non-allowlisted host: ${host || url}`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) {
      const e: HttpErr = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      e.body = text;
      throw e;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

export function dataUri(path: string, mime = 'image/png'): string {
  return `data:${mime};base64,` + fs.readFileSync(path).toString('base64');
}

export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

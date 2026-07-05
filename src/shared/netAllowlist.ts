// The ONLY external hosts the app may contact for CLOUD INFERENCE. Single source of truth for two guards:
//  1. cloud/http.ts refuses to fetch any host not listed here (typo/hijack backstop — a slug can't redirect
//     traffic off-provider).
//  2. the main-process Electron session firewall (main/index.ts) denies all external requests by default and
//     permits a host only when its provider is BOTH keyed AND actually opted into by a resolved stage.
// Model-download / bootstrap hosts (Hugging Face, mirrors) are NOT here — those go through the Python
// downloader, not Electron/main fetch, and have their own download-time allowlist (LOCAL_PLAN §3.4).
export const CLOUD_HOSTS: Record<'openrouter' | 'replicate', string[]> = {
  openrouter: ['openrouter.ai'],                                                  // LLM, VLM, keyframe, moderation, Kling
  replicate: ['api.replicate.com', 'replicate.delivery', '*.replicate.delivery'], // WhisperX submit/poll + result CDN
};

export const ALL_CLOUD_HOSTS: string[] = Object.values(CLOUD_HOSTS).flat();

/** True if `host` matches one of `patterns` (default: every known cloud host). `*.base` matches base and any
 * subdomain of base — nothing else. */
export function hostAllowed(host: string, patterns: string[] = ALL_CLOUD_HOSTS): boolean {
  const h = (host || '').toLowerCase();
  return patterns.some((p) => {
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    return h === p;
  });
}

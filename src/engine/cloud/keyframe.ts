// Cloud KEYFRAME stage (OpenRouter image model). No backend branch — the registry routed here. Restored +
// refit from 5125093~1:src/engine/providers.ts (cloudKeyframe). concurrency() is network-parallel (this is
// the single home of the pre-pivot kfWorkers one-liner); needsGpu() is false.
import fs from 'node:fs';
import { env, envInt } from '../config';
import { costAdd, orCost } from '../cost';
import { OR, orHdr, httpJson, dataUri, fileExists, sleep } from './http';
import { TOON_STYLE } from '../stages';
import type { KeyframeBackend } from '../backends/types';

export const cloudKeyframe: KeyframeBackend = {
  concurrency: () => Math.max(envInt('VB_WORKERS', 4), envInt('VB_KF_WORKERS', 4)),
  needsGpu: () => false,

  async keyframe(prompt: string, outPath: string, refs: [string, string][] = [], toon = false): Promise<boolean> {
    const model = env('VB_KEYFRAME_MODEL', 'google/gemini-3.1-flash-image');
    const vstyle = toon ? TOON_STYLE : env('VB_VISUAL_STYLE', '');
    const nosign =
      '16:9 widescreen. Every surface, screen, sign and package in the scene is blank and unbranded — zero readable text anywhere. No letters, no words, no captions, no watermark, no logo. NO neon signs with writing, NO Asian/Chinese/Japanese/Korean signage anywhere.';
    const imgs: [string, string][] = [];
    for (const [path, label] of refs || []) {
      if (path && fileExists(path)) {
        try {
          imgs.push([dataUri(path), label]);
        } catch {
          /* skip unreadable ref */
        }
      }
    }
    let content: any[];
    if (imgs.length) {
      const roster = imgs.map(([, lbl], i) => `reference ${i + 1} = ${lbl}`).join('; ');
      let text: string;
      if (toon) {
        text =
          `Redraw the SAME subjects as 3D animated cartoon characters. Reference photos in order: ${roster}. CRITICAL — keep each subject unmistakably recognizable: preserve their exact facial features and proportions (face shape, eyes, nose, mouth, jaw, eyebrows), hair, age and build; for animals keep the exact breed, coat color and markings. Do NOT blend or swap identities. Place them together in a new scene: ${prompt}. ${TOON_STYLE}. ${nosign}`;
      } else {
        text =
          `Place these EXACT real subjects into a new cinematic scene. Reference photos in order: ${roster}. CRITICAL — preserve each subject's identity PERFECTLY: faithfully reproduce every facial feature from their own reference photo (face shape, eyes, nose, mouth, jawline, eyebrows, skin tone, facial hair, hairstyle and apparent age) so each person is unmistakably the SAME individual; for any animal keep the exact breed, coat color and markings. Do NOT blend, average, beautify, de-age or otherwise alter any face. The reference photos OVERRIDE any physical description in the text. Scene: ${prompt}. ${vstyle}. ${nosign}`;
      }
      content = [{ type: 'text', text }, ...imgs.map(([u]) => ({ type: 'image_url', image_url: { url: u } }))];
    } else {
      content = [{ type: 'text', text: `${vstyle}. ${prompt}. Cinematic. ${nosign}` }];
    }
    const body: any = { model, messages: [{ role: 'user', content }], modalities: ['image', 'text'], usage: { include: true } };
    if (model.toLowerCase().includes('gpt')) body.input_fidelity = 'high';
    for (let i = 0; i < 4; i++) {
      let r: any;
      try {
        r = await httpJson(OR + '/chat/completions', { method: 'POST', headers: orHdr(), body: JSON.stringify(body) }, 180_000);
      } catch {
        await sleep(2000);
        continue;
      }
      costAdd(orCost(r));
      const out = r?.choices?.[0]?.message?.images || [];
      const url: string = out.length ? out[0]?.image_url?.url || '' : '';
      if (url.includes(',')) {
        fs.writeFileSync(outPath, Buffer.from(url.split(',', 2)[1], 'base64'));
        if (fileExists(outPath)) return true;
      }
    }
    return false;
  },
};

// The timeline resolution each VIDEO backend renders at — ONE definition, imported by both sides that
// need it, because they have to agree exactly:
//  1. main/autoconfig.ts turns it into VB_W / VB_H (what the engine actually generates and conforms to);
//  2. engine/backends/*/video.ts reports it as `timelineRes()` on the backend interface.
// These used to be two hand-copied pairs of literals with nothing tying them together, so a change to one
// silently desynced the other — and a mismatch is not loud: clips still render, they just get scaled and
// padded by conformClip at assemble time, costing resolution for no visible reason.
export const TIMELINE_RES = {
  // Wan 2.2 i2v on MLX: the 48GB Metal working-set ceiling. Finished to 1080p by the ESRGAN upscale pass.
  local: { w: 832, h: 480 },
  // Kling returns near-HD already, so the cloud path skips the upscale entirely.
  cloud: { w: 1280, h: 720 },
} as const;

export type TimelineRes = { w: number; h: number };

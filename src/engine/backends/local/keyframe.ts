// Local KEYFRAME adapter: on-device mflux (FLUX + Kontext). GPU-serial (follows VB_WORKERS, forced to 1
// during a local render); needsGpu() gates the render-time GPU lock (C5).
import { keyframeLocal } from '../../localKeyframe';
import { envInt } from '../../config';
import type { KeyframeBackend } from '../types';

export const localKeyframe: KeyframeBackend = {
  keyframe: keyframeLocal,
  concurrency: () => envInt('VB_WORKERS', 4),
  needsGpu: () => true,
};

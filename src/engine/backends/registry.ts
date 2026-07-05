// Stage dispatch: stageBackend() → the cloud or local impl object, per stage. `require` (not top-level
// import) so a cloud-only render never executes the Python-driven local modules, and a local-only render
// never loads the cloud clients. stageBackend defaults to 'local', so a missing env can only route local.
// VIDEO is added in C4. See DUAL_BACKEND_PLAN.md §1.2.
import { stageBackend } from '../config';
import type * as T from './types';

export const stt = (): T.SttBackend =>
  stageBackend('STT') === 'cloud' ? require('../cloud/stt').cloudStt : require('./local/stt').localStt;

export const llm = (): T.LlmBackend =>
  stageBackend('LLM') === 'cloud' ? require('../cloud/llm').cloudLlm : require('./local/llm').localLlm;

export const vlm = (): T.VlmBackend =>
  stageBackend('VLM') === 'cloud' ? require('../cloud/vlm').cloudVlm : require('./local/vlm').localVlm;

export const keyframe = (): T.KeyframeBackend =>
  stageBackend('KEYFRAME') === 'cloud' ? require('../cloud/keyframe').cloudKeyframe : require('./local/keyframe').localKeyframe;

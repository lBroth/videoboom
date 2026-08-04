// Local VLM adapter: on-device mlx-vlm (portrait caption + moderation, fails OPEN).
import { vlmCaptionLocal, moderateImageLocal } from '../../localVlm';
import type { VlmBackend } from '../types';

export const localVlm: VlmBackend = {
  vlmCaption: vlmCaptionLocal,
  moderateImage: moderateImageLocal,
};

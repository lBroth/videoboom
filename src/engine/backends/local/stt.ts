// Local STT adapter: on-device mlx-whisper. Already returns the {ok, words, error?} contract.
import { transcribeWordsLocal } from '../../localStt';
import type { SttBackend } from '../types';

export const localStt: SttBackend = {
  transcribeWords: transcribeWordsLocal,
};

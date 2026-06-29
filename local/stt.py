"""Local speech-to-text with word timing, MLX-native, via mlx-whisper.

Returns the same {start, end, word} shape the engine's WhisperX path produces, so providers.transcribeWords
can swap cloud<->local with no pipeline change. mlx-whisper caches the loaded model internally (lru), so a
warm sidecar reuses it across songs.

Note: WhisperX adds wav2vec2 *forced alignment* for very tight word timing; whisper's own word_timestamps
are slightly looser but good enough for phrase-based scene segmentation.
"""


def run_stt(req: dict) -> dict:
    import mlx_whisper

    audio = req["audio"]
    model = req.get("model", "mlx-community/whisper-large-v3-turbo")
    language = req.get("language") or None  # None => auto-detect

    kw = {"path_or_hf_repo": model, "word_timestamps": True}
    if language:
        kw["language"] = language
    res = mlx_whisper.transcribe(audio, **kw)

    words = []
    for seg in res.get("segments", []):
        for w in seg.get("words", []):
            st, en = w.get("start"), w.get("end")
            wd = (w.get("word") or "").strip()
            if st is not None and en is not None and float(en) > float(st) and wd:
                words.append({"start": float(st), "end": float(en), "word": wd})
    return {"ok": True, "words": words, "text": (res.get("text") or "").strip()}

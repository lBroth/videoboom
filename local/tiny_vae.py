"""Tiny-VAE decode for the Wan 14B path: TAEHV taew2_1 (madebyollin, MIT) on torch-MPS in place of the
official Wan 2.1 VAE decoder (Wan 2.2 A14B still uses the 2.1 VAE). The official decode is ~62s of a
~293s clip; TAEHV is a 22MB conv net that decodes the same latents in seconds at near-official quality.

Weights: models/taew2_1.safetensors (from HF lightx2v/Autoencoders, Apache-2.0 — safetensors, no pickle).
Code: taehv_upstream.py (audited copy of github.com/madebyollin/taehv taehv.py).

Frame math matches the official decoder exactly: latent T -> 4T raw frames -> trim 3 -> 4T-3
(official: 4*(T-1)+1 = 4T-3), so downstream frame budgeting is unchanged.

patch() monkeypatches mlx_video.models.wan_2.generate.load_vae_decoder; only the 16-channel (14B/2.1)
VAE is replaced — the 5B's 48-channel x64 VAE falls through to the original loader.
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.path.join(_HERE, "models", "taew2_1.safetensors")

_DECODER = None  # one instance per process (the sidecar runs i2v in one resident process)


class _TaehvDecoder:
    """Duck-types the slice of the mlx-video VAE decoder API generate_video uses: decode / decode_tiled."""

    def __init__(self):
        import torch
        from safetensors.torch import load_file
        from taehv_upstream import TAEHV

        self._torch = torch
        self._dev = "mps" if torch.backends.mps.is_available() else "cpu"
        # checkpoint_path=None keeps the defaults, which ARE the taew2_1 shape (16ch, patch 1);
        # weights load from safetensors so no pickle is ever touched.
        model = TAEHV(checkpoint_path=None)
        model.load_state_dict(model.patch_tgrow_layers(load_file(WEIGHTS)))
        self._model = model.to(self._dev, torch.float16).eval()

    def decode(self, z):
        """z: mx.array [1, 16, T, h, w] (raw sampler latents) -> mx.array [1, 3, T', H, W] in [-1, 1]
        (generate_video then does (x+1)/2*255, same as with the official decoder)."""
        import mlx.core as mx
        import numpy as np

        torch = self._torch
        zn = np.asarray(z.astype(mx.float32))  # [1, C, T, h, w]
        with torch.no_grad():
            zt = torch.from_numpy(zn).to(self._dev, torch.float16).permute(0, 2, 1, 3, 4)  # NTCHW
            rgb = self._model.decode_video(zt, parallel=True, show_progress_bar=False)     # [1,T',3,H,W] in [0,1]
            out = rgb.permute(0, 2, 1, 3, 4).float().mul_(2.0).sub_(1.0).cpu().numpy()     # [1,3,T',H,W] in [-1,1]
        return mx.array(out)

    def decode_tiled(self, z, _tiling_config):
        # TAEHV's working set is tiny — tiling is pointless, decode whole.
        return self.decode(z)


def patch() -> None:
    """Replace load_vae_decoder for 16-channel Wan VAEs with the TAEHV shim (idempotent)."""
    from mlx_video.models.wan_2 import generate as gen

    if getattr(gen.load_vae_decoder, "_vb_tiny_vae", False):
        return
    orig = gen.load_vae_decoder

    def load_vae_decoder(vae_path, config):
        global _DECODER
        if getattr(config, "vae_z_dim", 16) == 16 and os.path.isfile(WEIGHTS):
            if _DECODER is None:
                _DECODER = _TaehvDecoder()
            return _DECODER
        return orig(vae_path, config)

    load_vae_decoder._vb_tiny_vae = True
    gen.load_vae_decoder = load_vae_decoder

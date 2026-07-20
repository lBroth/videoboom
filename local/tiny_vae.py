"""Tiny-VAE decode for both local Wan engines: TAEHV (madebyollin, MIT) on torch-MPS in place of the
official Wan VAE decoder. TAEHV is a ~22MB conv net that decodes the same latents in seconds at
near-official quality.

Two engines, two VAEs, two checkpoints:
  * 14B (Wan 2.2 A14B still uses the 2.1 VAE) — 16 channels, patch 1. Official decode is ~62s of a
    ~293s clip; taew2_1 takes it to ~3s.
  * 5B (Wan 2.2 TI2V) — 48 channels, patch 2 (x16 spatial). The official decode DOMINATES that path
    (134.3s of a 165.7s clip), which is why the engine was retired; taew2_2 is the whole point of
    bringing it back.

Weights: models/taew2_{1,2}.safetensors (HF lightx2v/Autoencoders, Apache-2.0 — safetensors, no pickle).
Code: taehv_upstream.py (audited copy of github.com/madebyollin/taehv taehv.py).

Frame math matches the official decoder exactly for BOTH: t_upscale 4, frames_to_trim 3, so
latent T -> 4T raw frames -> trim 3 -> 4T-3 (official: 4*(T-1)+1 = 4T-3). Downstream frame budgeting
is unchanged either way.

patch() monkeypatches mlx_video.models.wan_2.generate.load_vae_decoder, dispatching on config.vae_z_dim;
an unknown z dim (or a missing checkpoint) falls through to the original loader.
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))

# vae_z_dim -> (checkpoint, TAEHV shape). The shape args are passed explicitly rather than relying on
# TAEHV's filename sniffing, because that path also torch.loads the checkpoint (we load safetensors).
SPECS = {
    16: ("taew2_1.safetensors", {"patch_size": 1, "latent_channels": 16}),
    48: ("taew2_2.safetensors", {"patch_size": 2, "latent_channels": 48}),
}


def weights_path(z_dim: int) -> str:
    return os.path.join(_HERE, "models", SPECS[z_dim][0])


_DECODERS: dict = {}  # z_dim -> decoder (the sidecar runs i2v in one resident process)


class _TaehvDecoder:
    """Duck-types the slice of the mlx-video VAE decoder API generate_video uses: decode / decode_tiled."""

    def __init__(self, z_dim: int):
        import torch
        from safetensors.torch import load_file
        from taehv_upstream import TAEHV

        self._torch = torch
        self._z_dim = z_dim
        self._dev = "mps" if torch.backends.mps.is_available() else "cpu"
        # checkpoint_path=None skips TAEHV's own torch.load; the shape comes from SPECS and the
        # weights load from safetensors, so no pickle is ever touched.
        model = TAEHV(checkpoint_path=None, **SPECS[z_dim][1])
        model.load_state_dict(model.patch_tgrow_layers(load_file(weights_path(z_dim))))
        self._model = model.to(self._dev, torch.float16).eval()

    def _decode_ntchw(self, zt):
        """torch NTCHW latents -> torch NTCHW RGB in [-1, 1]."""
        with self._torch.no_grad():
            rgb = self._model.decode_video(zt, parallel=True, show_progress_bar=False)  # [N,T',3,H,W] in [0,1]
            return rgb.float().mul_(2.0).sub_(1.0)

    # ── 16-channel (Wan 2.1 VAE / 14B): channels-first, raw sampler latents ────────────────────────
    def decode(self, z):
        """z: mx.array [1, C, T, h, w] (raw sampler latents) -> mx.array [1, 3, T', H, W] in [-1, 1]
        (generate_video then does (x+1)/2*255, same as with the official decoder)."""
        import mlx.core as mx
        import numpy as np

        zn = np.asarray(z.astype(mx.float32))  # [1, C, T, h, w]
        zt = self._torch.from_numpy(zn).to(self._dev, self._torch.float16).permute(0, 2, 1, 3, 4)  # NTCHW
        out = self._decode_ntchw(zt).permute(0, 2, 1, 3, 4).cpu().numpy()  # [1, 3, T', H, W]
        return mx.array(out)

    # ── 48-channel (Wan 2.2 VAE / 5B): channels-LAST, and the caller has already denormalized ──────
    def __call__(self, z):
        """z: mx.array [1, T, h, w, C], already through vae22.denormalize_latents (that is what the
        official Wan2.2 decoder wants). TAEHV wants ~Gaussian latents, so undo it exactly, then return
        [1, T', H, W, 3] in [-1, 1] — the layout the caller's Wan2.2 branch expects."""
        import mlx.core as mx
        import numpy as np
        from mlx_video.models.wan_2.vae22 import VAE22_MEAN, VAE22_STD

        z = (z - VAE22_MEAN.reshape(1, 1, 1, 1, -1)) / VAE22_STD.reshape(1, 1, 1, 1, -1)
        zn = np.asarray(z.astype(mx.float32))  # [1, T, h, w, C]
        zt = self._torch.from_numpy(zn).to(self._dev, self._torch.float16).permute(0, 1, 4, 2, 3)  # NTCHW
        out = self._decode_ntchw(zt).permute(0, 1, 3, 4, 2).cpu().numpy()  # [1, T', H, W, 3]
        return mx.array(out)

    def decode_tiled(self, z, _tiling_config):
        # TAEHV's working set is tiny (a 22MB conv net, streamed frame-by-frame) — tiling is pointless.
        # Dispatch on z dim because the two Wan VAEs are called with different layouts.
        return self(z) if self._z_dim == 48 else self.decode(z)


def patch() -> None:
    """Replace load_vae_decoder for Wan VAEs we have a TAEHV checkpoint for (idempotent)."""
    from mlx_video.models.wan_2 import generate as gen

    if getattr(gen.load_vae_decoder, "_vb_tiny_vae", False):
        return
    orig = gen.load_vae_decoder

    def load_vae_decoder(vae_path, config):
        z_dim = getattr(config, "vae_z_dim", 16)
        if z_dim in SPECS and os.path.isfile(weights_path(z_dim)):
            if z_dim not in _DECODERS:
                _DECODERS[z_dim] = _TaehvDecoder(z_dim)
            return _DECODERS[z_dim]
        return orig(vae_path, config)

    load_vae_decoder._vb_tiny_vae = True
    gen.load_vae_decoder = load_vae_decoder

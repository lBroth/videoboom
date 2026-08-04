"""FastWan DMD sampling support for the Wan sidecar.

FastWan2.2-TI2V-5B is a 3-step DMD distill: it is trained on the EXACT
denoising list [1000, 757, 522] (generic set_timesteps(3) would give
[1000, 909, 714]) and the reference sampler re-noises to the next level with
FRESH noise (deterministic euler over the same sigmas ghosts characters in
camera transitions — measured, research/videogen storyboard 2026-07-05).

A FastWan model dir is marked by a "fastwan_dmd" key in its config.json:
    {"sigmas": [1.0, 0.757, 0.522, 0.0], "renoise": true}
patch(spec) monkeypatches FlowMatchEulerScheduler accordingly (idempotent per
process; the sidecar runs one generation per process, so no unpatch needed).
"""
import mlx.core as mx
import numpy as np

import mlx_video.models.wan_2.scheduler as sched_mod

_PATCHED = False


def patch(spec: dict) -> int:
    """Apply the DMD schedule/sampler. Returns the step count to request."""
    global _PATCHED
    sigmas = [float(s) for s in spec["sigmas"]]
    steps = len(sigmas) - 1
    if _PATCHED:
        return steps

    orig_set = sched_mod.FlowMatchEulerScheduler.set_timesteps

    def dmd_set_timesteps(self, num_steps, shift=1.0):
        orig_set(self, num_steps, shift)
        if num_steps == steps:
            self.sigmas = mx.array(np.array(sigmas, dtype=np.float32))
            self.timesteps = mx.array(
                np.array([s * self.num_train_timesteps for s in sigmas[:-1]],
                         dtype=np.float32)
            )
            self._sigmas_float = list(sigmas)
            self._step_index = 0

    sched_mod.FlowMatchEulerScheduler.set_timesteps = dmd_set_timesteps

    if spec.get("renoise"):
        def dmd_step(self, model_output, timestep, sample):
            s = self._sigmas_float[self._step_index]
            s_next = self._sigmas_float[self._step_index + 1]
            x0 = sample - s * model_output
            if s_next > 0:
                noise = mx.random.normal(sample.shape).astype(sample.dtype)
                out = (1.0 - s_next) * x0 + s_next * noise
            else:
                out = x0
            self._step_index += 1
            return out

        sched_mod.FlowMatchEulerScheduler.step = dmd_step

    _PATCHED = True
    return steps

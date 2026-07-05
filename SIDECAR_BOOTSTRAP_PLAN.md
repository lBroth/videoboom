# Videoboom — macOS Sidecar Bootstrap Plan (M3, Apple Silicon slice)

Branch: `local-only-pivot` (authored on `bf16-relay`). This is the macOS slice of
`LOCAL_PLAN.md` M3. It turns the notarized `.dmg` — which today boots the UI but
cannot render on-device because `local/` is never bundled and there is no
first-run provisioning — into an app that provisions and runs the MLX sidecar
entirely from `userData`, with zero terminal, zero repo checkout, and no loss of
notarization validity.

It is written from the two verified designs (A: bootstrap architecture; B:
first-run UX + models) and resolves every blocker and major verifier finding
in-text. The Windows/CUDA slice of M3 stays in `LOCAL_PLAN.md`.

---

## 0. Summary + honest feasibility verdict

**Verdict: YES — with a per-Mach-O ad-hoc re-sign and a post-harden exec probe.**

A notarized, stapled, hardened-runtime `.dmg` *can* provision a Python
interpreter + native MLX/torch/ncnn wheels into `~/Library/Application
Support/Videoboom/local` at first run and `posix_spawn` it as the sidecar. This
is the proven Pinokio / ComfyUI-Desktop model: the parent app is not sandboxed,
sets no `LSFileQuarantineEnabled`, and the child interpreter is a *separate*
process whose hardened-runtime/library-validation posture does **not** inherit
from the parent across `exec`. No new entitlement is required — spawning a
sibling process needs none, and the four keys already in
`build/entitlements.mac.plist` (`allow-jit`,
`allow-unsigned-executable-memory`, `disable-library-validation`,
`allow-dyld-environment-variables`) govern the *Electron* process, not the
child.

The feasibility hinges on **one** load-bearing mechanic that the designs got
partly wrong and the verifiers corrected:

- **The ad-hoc re-sign is the fix, not the xattr strip.** On Apple Silicon a
  freshly-written Mach-O launched by `exec` from a Developer-ID parent is
  SIGKILLed (Sequoia: `Killed: 9`) or hangs at `_dyld_start` (Tahoe / macOS 26)
  unless it carries a *fresh, valid* code signature. `codesign --force --sign -`
  mints a new cdhash that clears `syspolicyd`/AMFI. `xattr -rd
  com.apple.provenance` is a **no-op** (kernel-managed, SIP-protected — `xattr
  -d` exits 0 and leaves it) and must not be relied on. Because uv writes fresh
  Mach-Os at a fresh path under `userData`, the re-sign has clean files to sign;
  that is why it works, not because provenance was stripped.

- **`--deep` on `.venv` does not sign the nested Mach-Os.** `.venv` is a plain
  directory tree, not a bundle; `codesign --deep` only descends a bundle's
  `Contents/`. Run against `.venv` it either errors (`bundle format
  unrecognized`) or exits without signing `libpython3.12.dylib`, the interpreter
  binaries, or the wheels' `.dylibs/*.so`. AMFI checks *every* Mach-O on
  `exec`/`dlopen`, so a single unsigned interpreter binary is fatal, silently.
  The harden step therefore **iterates every Mach-O individually** and re-signs
  each, failing the bootstrap loudly on any error.

- **The failure is invisible at spawn time.** A bad signature does not raise the
  "damaged" Gatekeeper *dialog* (that only fires for LaunchServices double-clicks
  of quarantined bundles, never for a `posix_spawn`'d child). It surfaces as a
  sidecar that never answers `/health`. So the bootstrap adds an explicit
  **`verify` phase** that execs the provisioned interpreter (`python -c 'import
  mlx.core, sys'`) with the real spawn env and treats SIGKILL/timeout/non-zero
  as a hard, phase-attributed bootstrap error.

Two operational caveats that keep this an honest "yes":

1. **Tahoe (macOS 26) is the primary validation target, not Sequoia.** Tahoe
   enforces `AppleSystemPolicy` harder and *removed* the `spctl` Gatekeeper
   disable escape hatch, so there is no user-side rescue if the re-sign is
   incomplete. The approach still works on Tahoe (confirmed by independent
   reports), but the margin is thinner and depends entirely on (a) every Mach-O
   being re-signed and (b) files being freshly written at a fresh path (uv →
   `userData` satisfies this). The full download→open-quarantined-dmg→
   bootstrap→spawn flow **must** be tested on real macOS 26 hardware; CI cannot
   reproduce it.

2. **Model provisioning has one external blocker: the HF org.** The out-of-box
   *Fast* tier needs `videoboom/FastWan2.2-TI2V-5B-MLX` published self-contained
   (its `t5_encoder`/`vae` are currently symlinks on the dev box). Until it
   lands, ship the **14B interim default**, which works from public/community
   repos but is heavier and does not fit the app's own 32 GB floor. See §5, §10.

Everything else — path resolution, the venv bootstrap, the electron-builder
wiring, the readiness gates, the UX — is code we own and lands incrementally
with `npm test` + `npm run build` green (§9).

---

## 1. Runtime layout — read-only code vs writable runtime

Two roots. **Code** ships inside the notarized bundle (immutable, signed).
**Runtime** (uv, Python, venv, weights, markers, caches) lives under
`app.getPath('userData')` = `~/Library/Application Support/Videoboom`, *outside*
the `.app`, so nothing provisioned at first run touches the notarized/stapled
artifact and staple validity is preserved.

```
Videoboom.app/Contents/Resources/            ← process.resourcesPath (read-only, signed, stapled)
├── app.asar                                 dist/** + renderer-dist/** (unchanged build.files)
├── local/                                   ← codeDir()  (extraResources; §8)
│   ├── server.py manager.py wan_i2v.py relay_generate.py fastwan_dmd.py
│   ├── tiny_vae.py taehv_upstream.py stt.py llm.py vlm.py keyframe.py
│   ├── interp.py upscale.py download.py requirements.txt
│   └── models/                              ← tiny READ-ONLY, code-relative assets ONLY
│       ├── rife-v4.26/{flownet.param,.bin}      interp.py:31 dirname(__file__)/models
│       └── taew2_1.safetensors                  tiny_vae.py:16-17 _HERE/models  (22.6 MB)
├── bin/uv                                   ← Developer-ID-signed uv (§4, §8)
├── wheels/                                  vendored *.whl incl. mlx_video + torch (§3, §8)
└── requirements.macos.lock                  hashed lock (§3)

~/Library/Application Support/Videoboom/     ← app.getPath('userData')  (writable)
└── local/                                   ← runtimeDir()
    ├── uv/python/…/bin/python3.12           ← the REAL interpreter Mach-O (re-signed §4)
    ├── uv/cache/                            uv wheel cache
    ├── .venv/bin/python                     ← venvPython()  (symlink/copy of uv python)
    ├── models/                              ← modelsDir()  (Wan/FastWan/Lightning snapshots)
    ├── hf-cache/                            ← HUGGINGFACE_HUB_CACHE (STT/LLM/VLM/KEYFRAME)
    ├── .model-path .model-path-5b .lightning-dir   ← markerDir()
    └── venv-manifest.json                   bootstrap stamp (§3)
```

**Why two `models/` dirs.** `interp.py:31` (`os.path.join(_HERE, "models",
"rife-v4.26")`) and `tiny_vae.py:16-17` (`os.path.join(_HERE, "models",
"taew2_1.safetensors")`) read a **code-relative** path that is *not*
`VB_LOCAL_MODELS_DIR`-aware. Those two assets are tiny (rife-v4.26 flownet ≈ 44
MB, taew2_1 = 22.6 MB), read-only, and ride next to the code in
`resourcesPath/local/models`. The heavy generated weights key off
`modelsDir()`/markers → `userData`. The two consumers never cross, so there is no
collision. **Correction to Design A: there is no `rife-v4.25`** — `ls
local/models` shows only `rife-v4.26` + `taew2_1.safetensors`. `interp.py:30`
probes `("rife-v4.26","rife-v4.25")` then falls back to the wheel's `rife-v4.6`,
so shipping only 4.26 is correct; drop every `rife-v4.25` reference from the
layout, the extraResources filter, and the git-add list.

**Env the engine sets** (computed once in `paths.ts`, injected via `localEnv()`):

| Var | Packaged value | Dev value |
|---|---|---|
| `VB_LOCAL_DIR` | `resourcesPath/local` | `<repo>/local` |
| `VB_LOCAL_PYTHON` | `userData/local/.venv/bin/python` | `<repo>/local/.venv/bin/python` |
| `VB_LOCAL_MODELS_DIR` | `userData/local/models` | `<repo>/local/models` |
| `VB_LOCAL_MARKER_DIR` *(new)* | `userData/local` | `<repo>/local` |
| `HUGGINGFACE_HUB_CACHE` | `userData/local/hf-cache` | `<repo>/local/hf-cache` |

Today **nothing** sets these: `sidecarEnv()` (`index.ts:82-85`) merges only
`keysEnv()` + `resolvedConfig().toEnv()`, and `toEnv()` sets `VB_LOCAL_WAN_DIR`
only when `settings.localWanDir` is non-empty (default `''`,
`settingsSchema.ts:42`). So every path falls through to
`process.cwd()/local` — the packaged bug. This layout closes it. In dev,
`runtimeDir() === codeDir() === <repo>/local`, so the existing `.venv`, `models`,
and markers resolve unchanged: **zero dev disruption**, and `detect()` sees the
venv already present and skips bootstrap.

---

## 2. Path-resolution rewrite (dev vs packaged, file:line)

The resolver is **electron-aware** and lives in main (`src/main/paths.ts`, new).
The engine modules (`sidecar.ts`, `localVideo.ts`) must stay electron-free
(they live in `src/engine`, imported in-process, deliberately dependency-light —
`config.ts:14-17` `env()` already falls back to `process.env`). So main computes
the roots and **injects them as env**; the engine keeps thin env-readers.
`localModels.ts` (in main) imports `paths.ts` directly and deletes its duplicate
resolvers (`localModels.ts:20-30`).

**New `src/main/paths.ts`:**

```ts
import { app } from 'electron';
import path from 'node:path';

const repoLocal = () => path.join(app.getAppPath(), 'local'); // dev: getAppPath()=repo root

export function codeDir(): string {                            // read-only sidecar CODE
  if (process.env.VB_LOCAL_DIR) return process.env.VB_LOCAL_DIR;
  return app.isPackaged ? path.join(process.resourcesPath, 'local') : repoLocal();
}
export function runtimeDir(): string {                         // writable runtime ROOT
  if (process.env.VB_LOCAL_RUNTIME_DIR) return process.env.VB_LOCAL_RUNTIME_DIR;
  return app.isPackaged ? path.join(app.getPath('userData'), 'local') : repoLocal();
}
export const venvPython = () => process.env.VB_LOCAL_PYTHON || path.join(runtimeDir(), '.venv', 'bin', 'python');
export const modelsDir  = () => process.env.VB_LOCAL_MODELS_DIR || path.join(runtimeDir(), 'models');
export const markerDir  = () => process.env.VB_LOCAL_MARKER_DIR || runtimeDir();
export const hfCacheDir  = () => process.env.HUGGINGFACE_HUB_CACHE || path.join(runtimeDir(), 'hf-cache');
export const uvBin      = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'uv') : 'uv');

/** The env block injected into EVERY sidecar / download / bootstrap spawn. */
export function localEnv(): Record<string, string> {
  return {
    VB_LOCAL_DIR: codeDir(),
    VB_LOCAL_PYTHON: venvPython(),
    VB_LOCAL_MODELS_DIR: modelsDir(),
    VB_LOCAL_MARKER_DIR: markerDir(),
    HUGGINGFACE_HUB_CACHE: hfCacheDir(),
  };
}
```

**Wiring (main):**

- `index.ts:82-85` `sidecarEnv()` → `{ ...keysEnv(), ...resolvedConfig().toEnv(),
  ...localEnv() }`. Now `streamOp` (`index.ts:127`) and every stage get correct
  paths.
- `localModels.ts:20-30` — delete the duplicated `localDir`/`localPython`/
  `hfCache`; import `codeDir`/`venvPython`/`hfCacheDir` from `paths.ts`.
- `localModels.ts:122` download spawn env → merge `localEnv()` (it currently
  passes only `{ ...process.env, HF_HUB_DISABLE_XET }`).

**Blocker resolved — HF cache 3-way consistency.** The verifiers found
`HUGGINGFACE_HUB_CACHE` reaching only the download spawn, so STT/LLM/KEYFRAME
would download into `userData/local/hf-cache` but be read from
`~/.cache/huggingface/hub` by both the sidecar and the readiness gate. All three
consumers are now unified on `hfCacheDir()`:

1. **Sidecar spawn** (`sidecar.ts:61-67`) currently spawns `server.py` with `env:
   { ...process.env, VB_FFMPEG, VB_FFPROBE }`. Since `config.setEnv()` writes to a
   module-level `CFG` map (`config.ts:7-11`), **not** `process.env`, the Python
   child never inherits the injected cache. Fix: `sidecar.ts` reads the cache via
   `env('HUGGINGFACE_HUB_CACHE')` (already a `config.ts` reader) and adds it to
   the spawn env: `env: { ...process.env, VB_FFMPEG, VB_FFPROBE,
   HUGGINGFACE_HUB_CACHE: env('HUGGINGFACE_HUB_CACHE'), VB_LOCAL_MARKER_DIR:
   env('VB_LOCAL_MARKER_DIR'), VB_LOCAL_MODELS_DIR: env('VB_LOCAL_MODELS_DIR') }`.
   `stt.py`, `llm.py`, `keyframe.py`, `vlm.py` resolve a **repo id** out of the HF
   cache (`stt.py` path_or_hf_repo, `llm.py` mlx_lm.load, `keyframe.py`
   ModelConfig.from_name), so they now load from the same cache the download
   wrote to.
2. **Readiness gate** — `localModels.hfCache()` is deleted and replaced by the
   `paths.ts` `hfCacheDir()`, so `repoReady()`/`modelStatus()` look in the same
   place.
3. **Download** — already reads `HF_HUB_CACHE`; `localEnv()` sets it.

Note `netAllowlist.ts` confirms the Python subprocess is *outside* the Electron
firewall, so a cache mismatch would silently re-download multi-GB at render time
— exactly the failure this unification prevents.

**Engine edits (`src/engine`, minimal):**

- `sidecar.ts:24-31` `readMarker` — base on the **marker dir**, not the code dir
  (the map's single most tangled coupling):
  ```ts
  const base = env('VB_LOCAL_MARKER_DIR', localDir());
  return fs.readFileSync(path.join(base, name), 'utf8').trim();
  ```
  `localVideo.ts:32-35,40` (`modelDir`/`lightningLoras` via `readMarker`) inherit
  the fix for free.
- `sidecar.ts:21-23` `localPython()` — already reads `VB_LOCAL_PYTHON`; main now
  always injects it, so the broken `localDir()/.venv` packaged default is never
  hit. Keep it as a standalone-test failsafe.
- `sidecar.ts:15-17` `localDir()` — reads `VB_LOCAL_DIR` (now always injected);
  the `cwd/local` fallback stays as a test-only failsafe.

**Python side (`download.py:40-49,83`):** markers are hardcoded to `here`
(read-only when packaged). Honor the new env:
```py
here = os.path.dirname(os.path.abspath(__file__))
marker_dir = os.environ.get("VB_LOCAL_MARKER_DIR", here)
os.makedirs(marker_dir, exist_ok=True)
marker = os.path.join(marker_dir, ".model-path")   # or .model-path-5b (§5)
# ... os.path.join(marker_dir, ".lightning-dir")
```
`models_dir` already honors `VB_LOCAL_MODELS_DIR` (`download.py:41`). `server.py`
`_run_isolated` uses `sys.executable` (the venv python) + `dirname(__file__)` —
both correct once spawned with the venv interpreter and `cwd:codeDir()`.

---

## 3. Python + venv + deps bootstrap (uv, sizes, pinned lockfile, no git)

New `src/main/bootstrap.ts`. Reuses the exact streaming pattern of
`downloadModel` (`localModels.ts:111-148`): spawn → parse newline JSON → forward
to a renderer channel `bootstrap`. Model download stays the separate
`downloadModel` flow, invoked after `deps` completes.

**Phases:** `detect → python → venv → deps → harden → verify → stamp → done`.
Every step is idempotent and gated on its own readiness so a killed run
re-enters cheaply.

```ts
type Phase = 'detect'|'python'|'venv'|'deps'|'harden'|'verify'|'done';

export function detect(): BootState {
  const venvReady = fs.existsSync(venvPython());
  const m = readManifest();                          // runtimeDir()/venv-manifest.json
  const depsReady = venvReady && m?.lockSha256 === shippedLockSha();
  return { pythonReady: uvPythonPresent(), venvReady, depsReady };
}
```

**`install()`** — all uv state redirected under `runtimeDir()` so nothing writes
into the bundle:

```ts
const RT = runtimeDir();
const uvEnv = { ...process.env, ...localEnv(),
  UV_PYTHON_INSTALL_DIR: path.join(RT, 'uv', 'python'),
  UV_CACHE_DIR:          path.join(RT, 'uv', 'cache') };

// 0. preflight — reuse localCapabilities() (arm64, macOS≥14, RAM≥32) + free disk ≥25GB (deps+Fast tier)
await run(uvBin(), ['python','install','3.12'], uvEnv, 'python');           // skip if pythonReady
await run(uvBin(), ['venv', venvDir, '--python','3.12'], uvEnv, 'venv');    // skip if venvReady
await run(uvBin(), ['pip','sync','--python',venvPython(),'--require-hashes', // deps
  '--find-links', path.join(process.resourcesPath,'wheels'),
  path.join(process.resourcesPath,'requirements.macos.lock')], uvEnv, 'deps');
await hardenProvisionedTree(venvDir, path.join(RT,'uv','python'));           // §4
await verifyRuntime();                                                       // §4 post-harden exec probe
writeManifest({ schema:1, python:'3.12', lockSha256: shippedLockSha(),
  wheels:{ mlx_video: MLX_VIDEO_SHA, torch: TORCH_VER },
  completedAt:new Date().toISOString(), platform:'macos-arm64' });
```

**`uv venv` interpreter mechanics (Apple-Silicon-specific).** `uv python install
3.12` unpacks an Astral python-build-standalone interpreter into
`UV_PYTHON_INSTALL_DIR`; that directory's `bin/python3.12` + `lib/libpython3.12.dylib`
are the **real Mach-Os** that get `exec`'d. `uv venv` then creates
`.venv/bin/python` as a symlink (or, with `--copies`, a copy) of that
interpreter — matching what we see in the dev repo, where `.venv/bin/python →
python3.12 → /opt/homebrew/.../python3.12`. The harden step therefore must reach
**both** `UV_PYTHON_INSTALL_DIR` (the standalone interpreter + libpython) and
`.venv` (any copied binary + the wheels' `.so`/`.dylib`). Passing both dirs to
`hardenProvisionedTree` is correct; the per-Mach-O iteration inside it is what
makes it work (§4).

**Dependency manifest — the lock.** `requirements.macos.lock` is generated in CI
by `uv pip compile --generate-hashes` from a macOS-only input and installed with
`--require-hashes` for byte-reproducibility. It references the **vendored**
`mlx_video` wheel by hash (not `git+https`), so **no git binary is invoked at
runtime** — closing the setup.sh dependency on a repo checkout. Contents (from
`requirements.txt`, minus the git URL):

| Package | Role | Notes |
|---|---|---|
| `mlx`, `mlx-lm`, `mlx-vlm` | core + LLM + VLM | pulled by mlx-video; small |
| `mlx_video` (vendored whl) | Wan i2v engine | pure-python wheel by hash |
| `mlx-whisper` | STT | |
| `mflux` | FLUX keyframes | |
| `huggingface_hub` | downloads | |
| **`torch`** | **runtime** VAE decode | **mandatory — see below** |
| `rife-ncnn-vulkan-python-tntwise` | interp | native `.so` |
| `realesrgan-ncnn-py` | upscale | native `.so` |
| `numpy`, `safetensors`, `pillow`, `transformers`, `imageio`, `tqdm` | transitive | |

**Blocker resolved — torch is a RUNTIME dependency, not convert-only.**
`requirements.txt:5-7` comments torch as "needed ONLY at convert time," and
Design B proposed dropping it with the convert path. That is wrong for the
shipped default. `tiny_vae.py:26` (`import torch`) + `taehv_upstream.py` implement
the TAEHV tiny-VAE decode, invoked by `wan_i2v.py:168-170` (`import tiny_vae;
tiny_vae.patch()`) whenever the `tiny_vae` flag is set — and `localVideo.ts:85`
sets it **on by default** for the non-hd path (`envBool('VB_LOCAL_TINY_VAE',
!isHd)`). Grep confirms `import torch` appears only in `tiny_vae.py` and
`taehv_upstream.py`, i.e. purely at *decode* time, and the shipped default
(14B fast / bf16-relay) hits that decode. **torch stays mandatory in the lock and
vendored wheels.** Only its use as the `mlx_video.models.wan_2.convert` tool goes
away (the convert path is deleted in §5). The macOS-arm64 torch wheel is ~60–90 MB
compressed; it dominates the deps download.

**Sizes.** uv binary ~40 MB (shipped, not downloaded). uv-managed CPython 3.12 ≈
30–45 MB download / ~120 MB on disk. Wheels ≈ 400–600 MB download (torch + mlx +
transformers + numpy) / ~1.0–1.5 GB installed. Show a **"~500 MB, 2–4 min"**
estimate up front. Because torch and the `.so`-carrying ncnn wheels are vendored
in `Resources/wheels`, `uv pip sync --find-links` can install fully **offline** if
the user provisions on a metered/absent connection — only the *models* (§5) need
the network.

**Progress + resumability.** `run()` streams uv's per-package stdout; the `deps`
phase parses `Prepared/Installed N/T` lines into `{event:'progress',phase:'deps',
pct}`. `python`/`venv`/`harden`/`verify` emit coarse phase-start/end. Weighted
total pct = python 8 / venv 4 / deps 68 / harden 12 / verify 8. `uv pip sync`
reconverges the venv to the lock from *any* partial state, and uv's cache makes
re-entry cheap; a shipped-lock change flips `lockSha256` and triggers a delta
re-sync.

**IPC** (`index.ts`, alongside `models:download` at :303):
```ts
ipcMain.handle('bootstrap:status', () => ({ ...detect(), caps: localCapabilities() }));
ipcMain.handle('bootstrap:start',  () => { BOOTSTRAP.set('engine', run);
  return install(ev => win?.webContents.send('bootstrap', ev)).finally(()=> BOOTSTRAP.delete('engine')); });
ipcMain.handle('bootstrap:cancel', () => { bootChild?.kill(); return true; });
```
`preload/index.ts` gains `bootstrapStatus()`, `startBootstrap()`, `onBootstrap(cb)`,
`cancelBootstrap()`, cloning the `downloadModel`/`onDownload` shape
(`preload/index.ts:75-89`). Concurrency: track `BOOTSTRAP` as a `Map` like
`DOWNLOADS` (`index.ts:135`); `guardRender` (`index.ts:173-193`) and
`guardPortrait` (`index.ts:197-202`) refuse while it is non-empty.

---

## 4. Gatekeeper / notarization handling — exact mechanism

**No entitlement change and no plist change.** The notarized, hardened,
Developer-ID parent can `posix_spawn` a `userData` Python that `dlopen`s unsigned
torch/mlx/ncnn dylibs because **library validation and hardened runtime are
per-process and do not cross the `exec` boundary** — the ad-hoc, non-hardened
child carries no `CS_REQUIRE_LV`. `build/entitlements.mac.plist` already declares
`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`,
`allow-dyld-environment-variables`; none governs the child, and spawning needs
none. **Do not** add `LSFileQuarantineEnabled` to Info.plist and **do not**
sandbox the app — files uv/Node write into `userData` carry no
`com.apple.quarantine` because the app is not sandboxed. This is the
Pinokio/ComfyUI-Desktop posture.

The **one required** mechanic is neutralizing the Apple-Silicon "no valid
signature → SIGKILL/hang on exec" trap. The corrected harden phase:

```ts
async function hardenProvisionedTree(...dirs: string[]) {
  for (const d of dirs) {
    // Best-effort insurance only. quarantine IS removable; provenance is SIP-protected
    // and this call is EXPECTED to no-op (kernel-managed) — it is NOT what fixes exec.
    await execFile('xattr', ['-rd', 'com.apple.quarantine', d]).catch(()=>{});
    await execFile('xattr', ['-rd', 'com.apple.provenance', d]).catch(()=>{});
  }
  // THE FIX: ad-hoc re-sign EVERY Mach-O individually (never --deep, never a bundle assumption).
  const machos = await collectMachOs(dirs);   // interpreter binaries + libpython + every *.so/*.dylib
  for (const f of machos) {
    // Ad-hoc ONLY — never --options runtime,library (that re-enables LV and blocks unsigned mlx/ncnn).
    await execFile('codesign', ['--force', '--sign', '-', f]);   // throws → bootstrap fails loudly
  }
}
```

`collectMachOs` = `find <dirs> -type f \( -name '*.so' -o -name '*.dylib' -o
-perm -u+x \)` filtered to Mach-O (magic `0xcafebabe`/`0xfeedfacf`, or
`file`/`otool -h`), plus the explicit interpreter binaries
(`.venv/bin/python3.12`, `uv/python/**/bin/python3.12`) and every `libpython*.dylib`.
Each is re-signed; any `codesign` non-zero **fails the bootstrap** with a
phase-attributed error (unlike the `xattr` lines, which swallow errors).

**Why the corrections matter (verifier majors resolved):**

- **`xattr -rd com.apple.provenance` is a no-op.** It is kernel-managed and
  SIP-protected: `xattr -d` returns 0 but leaves the attribute. The design/research
  treated it as one of two load-bearing operations; it does nothing. The **re-sign**
  is what clears AMFI/`syspolicyd`, by minting a fresh cdhash on files that were
  freshly written at a fresh path (uv → `userData`). The design text and code
  comments are corrected to say exactly this; the provenance strip is downgraded to
  harmless best-effort with a "expected to no-op" comment. `com.apple.quarantine`
  removal is kept as cheap insurance (that xattr *is* removable).

- **The harden rationale is AMFI mandatory-signing-on-exec, not pip dylib
  rewriting.** Modern binary wheels (mlx, torch, ncnn) are pre-delocated by the
  wheel builder; `uv pip sync` unpacks them and does **not** run `install_name_tool`
  at install, so their `.so`/`.dylib` keep valid build-time ad-hoc signatures and
  `dlopen` fine into a non-LV child anyway. The genuinely-must-re-sign target is the
  **interpreter** produced/copied by uv (+ its `libpython`). Re-signing all Mach-Os
  is belt-and-suspenders and is kept, but the *reason* the phase exists is the
  interpreter, so `collectMachOs` must unambiguously include it.

- **Tahoe (macOS 26) is the ship target.** The preflight floor stays macOS ≥14
  (`localCapabilities`), but Tahoe enforces `AppleSystemPolicy` harder (silent kill
  / `_dyld_start` hang, no dialog, no log) and removed the `spctl` disable escape
  hatch, so an incomplete re-sign is unrecoverable by the user. The re-sign
  approach still works on Tahoe *because* files are fresh at a fresh path and each
  Mach-O is re-signed. This is a manual QA gate (§9, M3m): download → open a
  genuinely quarantined `.dmg` → bootstrap → confirm `/health` on real macOS 26
  hardware.

**Post-harden exec probe (`verifyRuntime`) — resolves the silent-failure major.**
A broken signature does not raise the "damaged" *dialog* for a `posix_spawn`'d
child; it surfaces later as a sidecar that dies on spawn and times out on
`/health` — a generic "sidecar didn't start" with no cause. So the bootstrap adds:

```ts
async function verifyRuntime() {
  const env = { ...process.env, ...localEnv() };            // the REAL spawn env
  const r = await execFile(venvPython(), ['-c', 'import mlx.core, sys; print(sys.version)'],
    { env, timeout: 30_000 }).catch(e => e);
  if (r?.killed || r?.signal || r?.code) throw new BootError('verify',
    'On-device runtime could not be signed to run on this Mac. See logs for the signing step.');
}
```
A SIGKILL, timeout, or non-zero exit becomes a **visible, phase-attributed**
bootstrap error, converting the silent runtime death into an actionable message.

**Signing uv itself.** `bin/uv` is Astral-signed + notarized upstream; it ships as
a Mach-O in `Resources/bin/uv`. electron-builder walks nested Resources Mach-Os and
re-signs them under our Developer-ID + hardened runtime during the notarize path.
To be explicit, `scripts/mac-sign.js` adds `codesign --force --options runtime
--timestamp <app>/Contents/Resources/bin/uv` **before** the `notarize()` call at
`mac-sign.js:24` (hardened runtime on *our* tool is fine — it is the *provisioned*
python that must stay ad-hoc/non-LV). The no-creds ad-hoc dev path
(`mac-sign.js:32` `--deep`) already covers it.

---

## 5. Model provisioning — manifest, pre-converted vs community, HF-org dependency

**Delete the download-then-convert path.** `download.py:34-87` `download_video()`
snapshots the ~120 GB fp32 `Wan-AI/Wan2.2-I2V-A14B`, runs
`mlx_video.models.wan_2.convert`, and needs torch as a *convert* tool. A `.dmg`
user cannot do 120 GB + a multi-hour convert. It becomes a plain
`snapshot_download` of a **pre-converted MLX** repo selected by engine, then a
per-engine marker write.

**`VIDEO_ENGINES` manifest** (one constant, mirrored in `download.py` and
`localModels.ts`, keyed off `settings.localVideoModel`):

| Engine | Repo | Size | Marker | Fits 32 GB? |
|---|---|---|---|---|
| `5b` Fast (target default) | `videoboom/FastWan2.2-TI2V-5B-MLX` | ~24 GB | `.model-path-5b` | **yes** |
| `14b` Quality (interim default) | `Anes1032/Wan2.2-I2V-A14B-mlx-q8` | ~43 GB | `.model-path` | no (needs 48 GB+) |

**Recommended (mandatory) set — the keyless render prerequisites.**
`RENDER_STAGES` (`index.ts:142-147`) is STT + LLM + KEYFRAME + VIDEO (VLM is
portrait-only). So the mandatory set is exactly those four:

| Stage | Repo | Size |
|---|---|---|
| STT | `mlx-community/whisper-large-v3-turbo` | ~1.6 GB |
| LLM | `lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit` | ~20 GB |
| KEYFRAME | `dhairyashil/FLUX.1-schnell-mflux-4bit` | ~9.6 GB |
| VIDEO (5b) | `videoboom/FastWan2.2-TI2V-5B-MLX` | ~24 GB |
| **Lightning LoRA** (14b tier only) | `lightx2v/Wan2.2-Lightning` (I2V-A14B-4steps) | ~2.5 GB |

Fast tier total ≈ **~55 GB**; 14B interim tier ≈ 31 GB (STT+LLM+KEYFRAME) + 43 GB
(Q8) + 2.5 GB (Lightning) ≈ **~77 GB**. VLM (`gemma-3-12b-it-4bit`, ~8 GB) and
FLUX-Kontext stay optional (portrait/reference only).

**Major resolved — KEYFRAME must not be gated on Kontext.**
`STAGE_REPOS['KEYFRAME']` lists both `FLUX.1-schnell` *and*
`akx/FLUX.1-Kontext-dev-mflux-4bit` (`download.py:25`, `localModels.ts:16`), and
`modelStatus()` gates KEYFRAME on `repos.every(repoReady)` (`localModels.ts:100`).
Since the recommended set ships only schnell, KEYFRAME would stay `absent` after
the recommended download and `guardRender` would refuse. **Split KEYFRAME:**
schnell is the render prerequisite; Kontext is a separate **optional** repo
(portrait/reference only). Concretely:
- `STAGE_REPOS['KEYFRAME'] = ['dhairyashil/FLUX.1-schnell-mflux-4bit']` (render
  prereq).
- Add `OPTIONAL_REPOS['KEYFRAME_KONTEXT'] =
  ['akx/FLUX.1-Kontext-dev-mflux-4bit']`, downloaded on demand by the
  portrait/reference flow, not gated by `guardRender`.
- Fix `App.tsx:468` KEYFRAME size from `~15 GB` to `~9.6 GB` (schnell only).

**Major resolved — Lightning LoRA is mandatory for the 14B fast tier.**
`localVideo.ts:90-104`: the 14B non-hd (default `localQuality:'fast'`) path runs 4
steps *only if* `lightningLoras()` returns a LoRA; absent it and with
`VB_LOCAL_WAN_STEPS` unset, `wan_i2v` falls back to the model-config **40 steps**
(~38 min/clip — `localVideo.ts:106-107` warns it "would time out EVERY clip"
against the 1800 s deadline). So while the 14B interim default is the shipped
video engine, the **Lightning LoRA is in the mandatory set for that tier**. Load
must be verified against the *shipped* 14B weights (Q8, not just the dev bf16 —
§10). As a belt-and-suspenders fallback, the bootstrap can pin
`VB_LOCAL_WAN_STEPS` low if the LoRA is absent, but the correct fix is to
download it.

**Major resolved — VIDEO readiness must be engine-aware.**
`videoReady()` (`localModels.ts:41-48`) reads only `VB_LOCAL_WAN_DIR ||
.model-path` (the 14B marker), so a downloaded 5B (marker `.model-path-5b`)
reports `absent` and `guardRender` refuses — blocking the entire Fast tier.
Mirror the engine-side `modelDir()` (`localVideo.ts:32-35`):
```ts
function videoReady(): boolean {
  const is5b = getSettings().localVideoModel === '5b';
  const marker = is5b ? '.model-path-5b' : '.model-path';
  const override = is5b ? process.env.VB_LOCAL_WAN_5B_DIR : process.env.VB_LOCAL_WAN_DIR;
  try {
    const dir = (override || fs.readFileSync(path.join(markerDir(), marker), 'utf8')).trim();
    return Boolean(dir) && fs.existsSync(path.join(dir, 't5_encoder.safetensors'));
  } catch { return false; }
}
```
The `t5_encoder.safetensors` gate passes for both shipped repos (Anes1032 Q8 has a
real ~11 GB `t5_encoder`; FastWan-5B has one once inlined — see below).

**`download_video()` rewrite** collapses to the same clean, resumable,
progress-reporting `snapshot_download` + `HfApi.model_info` sizing path the
non-VIDEO branch already uses (`download.py:117-151`): pick the repo from
`VB_LOCAL_VIDEO_MODEL`, `snapshot_download(repo,
local_dir=models_dir/<name>)`, write the correct per-engine marker into
`VB_LOCAL_MARKER_DIR`. No torch, no convert, one code path.

**HF-org dependency (D1).** Spot-checks: `Anes1032/Wan2.2-I2V-A14B-mlx-q8` exists
(~42.7 GB, real `t5_encoder`, `config.json`) but surfaces library tag `mlx` (not
`mlx-video`) — **load-test it through the Blaizzy mlx-video pipeline before
committing**. `videoboom/FastWan2.2-TI2V-5B-MLX` returns **HTTP 401** — not yet
public; and on the dev box its `t5_encoder.safetensors`/`vae.safetensors` are
**symlinks** into `Wan2.2-TI2V-5B-MLX` (verified `ls -la`), so the publish step
must **inline them as real files** (~10 GB model + ~11.4 GB T5 + ~2.8 GB VAE ≈ 24
GB). Its `config.json` carries the `fastwan_dmd` block the engine reads
(`wan_i2v.py:138-140`), which the community base 5B repos lack — so no community
substitute exists. This single repo is the only mandatory-before-ship
re-host (§10).

---

## 6. First-run UX + in-app CTAs replacing "run setup.sh"

New `renderer/EngineSetup.tsx` — one component, reused in onboarding and Settings.
It renders off the tri-state `engineState()` (§7):

- `not-bootstrapped` → **"Set up on-device engine"** → `vb.startBootstrap()`, live
  progress bar (reuse `ModelDownload` markup, `App.tsx:544-571`), "~500 MB, 2–4
  min" estimate, and a **"Do this later"** escape (bootstrap is resumable — safe to
  defer).
- `partial` (venv ready, models pending) → **"Download models (Fast · ~55 GB)"**
  driving the recommended set (§5).
- `ready` → green "On-device ready".

**Onboarding wiring** (`Onboarding.tsx`). Steps are `'welcome' | 'keys' | 'done'`
(`Onboarding.tsx:54`). Insert a `'provision'` step between welcome and done, shown
only when `caps.supported` (`Onboarding.tsx:57`). On **supported**, the "Skip —
stay local" button (`Onboarding.tsx:96-98`) advances to `'provision'` (mounting
`EngineSetup` with a persistent "Do this later") instead of calling `goDone()`. On
**unsupported**, the flow is unchanged — it routes to `'keys'` (cloud needs a key),
the current nudge. Provisioning never blocks finishing onboarding.

**Kill the four dead-end `setup.sh` strings** — each becomes the `EngineSetup`
CTA:
- `App.tsx:679-682` HardwareCard `!caps.depsInstalled` branch ("run `bash
  local/setup.sh`") → embed `<EngineSetup/>`.
- `sidecar.ts:58` throw → "Set up the on-device engine in Settings → On-device."
- `localModels.ts:118` → same.
- `localVideo.ts:52` → "Download the on-device video model in Settings."

The three CTAs — **Install engine / Download {stage} / Render** — map 1:1 to
`not-bootstrapped / partial / ready`.

---

## 7. depsInstalled / guardRender extension for the hybrid

Today `depsInstalled = fs.existsSync(localPython())` (`localModels.ts:75`) is
folded into `localRunnable` (`autoconfig.ts:44`), so on a *bootstrappable* but
un-provisioned Mac a local-resolved stage gets `localAvailable:false`
(`autoconfig.ts:48`) and `guardRender` tells the user to "pick Cloud"
(`index.ts:184-186`) — wrong; they should be told to install the engine.

**Decouple.** In `resolveConfig` (`autoconfig.ts:44`), set `localRunnable =
Boolean(caps.supported)` — **hardware only**. `localAvailable` now means "this Mac
*can* run it on-device" (bootstrap + download are separate, in-app-fixable steps),
so the resolver never nudges a supported machine to cloud. `depsInstalled` stays
in `LocalCapabilities` for the UI, with its comment corrected to "engine
bootstrapped (venv present)."

**New `engineState()`** — a discriminated status the UI and guard both read:
- `'unsupported'` — `!caps.supported`.
- `'not-bootstrapped'` — supported, `!fs.existsSync(venvPython())`.
- `'partial'` — bootstrapped, but some **locally-resolved required** stage
  `modelStatus() !== 'ready'`.
- `'ready'` — bootstrapped + every locally-resolved required stage ready.

**Major resolved — `partial` must consider only *locally-resolved* stages.**
Design B put `engineState()` in `localModels.ts`, which has no access to the
resolver, so it would check *all* required stages and show `partial` for a user
who set VIDEO→cloud (Kling) despite being fully provisioned for their hybrid.
`guardRender` is already correct here — it skips cloud stages (`index.ts:181 if
(rs.backend !== 'local') continue`). So `engineState()` takes
`resolveConfig().stages` as an argument (computed in `index.ts`, where the
resolver is already called via `resolvedConfig()`), and only considers stages
where `stages[key].backend === 'local'`. This matches `guardRender` exactly.

**`guardRender` (`index.ts:173-193`)** gains one branch, ordered *before* the
model check (`index.ts:188`), every message an in-app CTA:
1. `DOWNLOADS.size || BOOTSTRAP.size` → "wait" (extend `index.ts:175`).
2. For each stage where `rs.backend === 'local'` (`index.ts:181`):
   - `!rs.localAvailable` → hardware can't run it → existing key/cloud nudge
     (`index.ts:184-186`).
   - **new:** supported but `engineState()==='not-bootstrapped'` → refuse "Set up
     the on-device engine in Settings → On-device."
   - `modelStatus()[key] !== 'ready'` → refuse "Download {label} in Settings"
     (existing `index.ts:188-190`).
3. GPU-busy (existing `index.ts:191`).

**Renderer.** `StageBackendRow` (`App.tsx:600-639`) mounts `ModelDownload` only
when `localResolved && rs.localAvailable` (`App.tsx:635`). Wrap it: if
`engineState()==='not-bootstrapped'`, render `<EngineSetup/>` (Install CTA)
instead of `ModelDownload` (Download CTA) — the same tri-state, per row. The
`HardwareCard` branch (`App.tsx:679-682`) hosts the primary `EngineSetup`.

---

## 8. electron-builder changes

Today `build.files = ["dist/**/*","renderer-dist/**/*","icons/icon.png"]` — `local/`
is not bundled (the root cause). Add `extraResources` (lands in
`Contents/Resources`, **outside** `app.asar`, so **no `asarUnpack`** is needed for
the sidecar; the existing `asarUnpack` for ffmpeg/ffprobe-static stays):

```jsonc
"extraResources": [
  { "from": "local", "to": "local", "filter": [
      "*.py", "requirements.txt",
      "!bench*.py", "!smoke_*.py",                 // resolves the *.py over-ship minor
      "models/rife-v4.26/**", "models/taew2_1.safetensors"
  ]},                                              // excludes .venv, big models/, dt/, __pycache__, setup.sh
  { "from": "build/bin/uv",                 "to": "bin/uv" },
  { "from": "build/wheels",                 "to": "wheels" },
  { "from": "local/requirements.macos.lock","to": "requirements.macos.lock" }
]
```

- **Minor resolved — the `*.py` over-ship.** A bare `"*.py"` matches `bench.py`,
  `bench_14b.py`, `bench_run.py`, `bench_steps.py`, `smoke_5b_esrgan.py`. They are
  inert (server.py's import closure is manager, wan_i2v, fastwan_dmd,
  relay_generate, tiny_vae, taehv_upstream, stt, llm, vlm, keyframe, interp,
  upscale — none of the bench/smoke files), so shipping them is harmless, but the
  negative filters `!bench*.py`, `!smoke_*.py` keep the bundle honest. `dt/`
  (Draw-Things CLI experiment) is excluded by omission.
- **Minor resolved — rife assets.** Ship `models/rife-v4.26/**` +
  `models/taew2_1.safetensors` only (no `rife-v4.25`, which does not exist). They
  are git-ignored (`.gitignore:20 local/models/`), so force-track exactly these:
  `git add -f local/models/rife-v4.26 local/models/taew2_1.safetensors`. Otherwise
  interp silently falls back to the wheel's 2022 `rife-v4.6` (`interp.py:34`).
- **`uv`** (~40 MB) → `build/bin/uv`, a pinned Astral release, `codesign`ed in
  `mac-sign.js` (§4).
- **`wheels/`** → `build/wheels/*.whl`, including the vendored pure-python
  `mlx_video` wheel **and torch** (so first run needs no git and can install
  offline). Inert zip data — no signing.
- **`requirements.macos.lock`** → CI-generated `uv pip compile --generate-hashes`,
  installed `--require-hashes`. References the vendored mlx-video wheel hash, not
  `git+https` → no git at runtime.

`build.files`, `asarUnpack`, `mac.hardenedRuntime`, `entitlements`, and both
sign/notarize hooks are otherwise unchanged. **`entitlements.mac.plist`: no
change.**

---

## 9. Commit roadmap M3a…M3n

Each commit keeps `npm test` (`typecheck` + `tsx --test test/*.test.ts` +
`check-no-cloud`) and `npm run build` green. "CI-testable" = fully validated in
CI; "hardware-only" = needs a real notarized/quarantined `.dmg` on Apple Silicon
that CI cannot produce.

| # | Commit | Scope | Validation |
|---|---|---|---|
| **M3a** | `paths.ts` + inject `localEnv()` | New `src/main/paths.ts`; `sidecarEnv()` += `localEnv()` (`index.ts:84`); delete dup resolvers (`localModels.ts:20-30`); `readMarker`→`VB_LOCAL_MARKER_DIR` (`sidecar.ts:24-31`); `download.py` markers→`VB_LOCAL_MARKER_DIR`. Dev unchanged (runtimeDir≡codeDir). | CI-testable |
| **M3b** | HF-cache unification | `hfCacheDir()` into the `server.py` spawn env (`sidecar.ts:61-67`) + download spawn (`localModels.ts:122`); `localModels.hfCache()`→`paths.hfCacheDir()`. | CI-testable (unit: all three read one path) |
| **M3c** | VIDEO readiness engine-aware | `videoReady()`/`modelStatus` read `.model-path-5b` when `localVideoModel==='5b'` (`localModels.ts:41-48`). | CI-testable (unit) |
| **M3d** | KEYFRAME split | schnell = render prereq; Kontext → `OPTIONAL_REPOS`; fix `every()` gate; `App.tsx:468` size→~9.6 GB. | CI-testable (unit) |
| **M3e** | Tri-state `engineState()` + resolver decouple | `autoconfig.ts:44` `localRunnable=caps.supported`; `engineState(stages)`; `guardRender` install-engine branch (`index.ts:181-190`). | CI-testable (unit) |
| **M3f** | `download.py` rewrite | Delete convert path (`download.py:34-87`); `VIDEO_ENGINES` manifest (mirrored `localModels.ts`); per-engine snapshot + marker; Lightning in 14B mandatory set. | CI-testable (dry-run / lint); real download hardware-only |
| **M3g** | `bootstrap.ts` core | detect/install/manifest state machine + IPC (`index.ts`) + preload additions. Harden/verify stubbed to skip in dev. | CI-testable (compiles, detect() unit); install hardware-only |
| **M3h** | Harden + verify phases | `hardenProvisionedTree` (per-Mach-O re-sign), `verifyRuntime` exec probe. | **hardware-only** |
| **M3i** | Renderer UX | `EngineSetup.tsx`; Onboarding `'provision'` step; StageBackendRow tri-state; replace 4 `setup.sh` strings; size labels. | CI-testable (build + `VB_SMOKE`) |
| **M3j** | electron-builder + vendoring | `extraResources`; `git add -f` rife-v4.26 + taew2_1; `build/bin/uv`; `build/wheels/*.whl`; `requirements.macos.lock` (CI compile job); sign `uv` in `mac-sign.js`. | Build green in CI; packaged sidecar resolution hardware-only |
| **M3k** | Publish `videoboom/FastWan2.2-TI2V-5B-MLX` | External HF upload, self-contained (inline the T5/VAE symlinks). | external / manual |
| **M3l** | Load-test + confirm 14B interim | Load-test `Anes1032` Q8 through mlx-video; confirm Lightning loads on Q8; keep `DEFAULTS.localVideoModel='14b'`, hide Fast tile "coming soon". | hardware-only |
| **M3m** | Real-hardware harden QA gate | Download→open quarantined `.dmg`→bootstrap→`/health` on macOS 26 (Tahoe) **and** Sequoia. | **hardware-only (blocking ship)** |
| **M3n** | Flip default to 5b | Once M3k lands + load-tested: `DEFAULTS.localVideoModel='5b'` (`settingsSchema.ts:42`) + `videoModel()` default (`localVideo.ts:15`); re-enable Fast tile; recommended set→Fast (~55 GB). One-line data change behind `VIDEO_ENGINES`. | CI-testable + hardware smoke |

M3a–M3f are safe refactors that leave dev byte-identical (runtimeDir≡codeDir).
M3g–M3j build the bootstrap and packaging. M3h and M3m are the two commits that
**cannot** be validated in CI and gate ship.

---

## 10. Open decisions for the user

- **D1 — HF org (`videoboom/*`).** Mandatory before a Fast-tier ship: publish
  `videoboom/FastWan2.2-TI2V-5B-MLX` **self-contained** (inline the dev-box
  symlinked `t5_encoder`/`vae`; currently HTTP 401). Optional later re-hosts
  (pinned `videoboom/Wan2.2-I2V-A14B-*`, a shared T5) are provenance insurance,
  not correctness. **Decision needed:** create/authorize the org and upload, or
  ship the 14B-only interim indefinitely.

- **D2 — 14B model default (Q4 vs bf16 vs Q8).** The current HEAD engine default
  is **14B bf16 via relay-shedding** (`.model-path` → `Wan2.2-I2V-A14B-MLX-bf16`,
  ~54 GB, `_wants_relay()` sheds one expert to fit 48 GB). No community bf16 MLX
  exists, so bf16 would need a `videoboom` re-host and does **not** fit the app's
  own 32 GB floor. Design B's interim uses `Anes1032` **Q8** (~43 GB, tag `mlx`
  not `mlx-video`, unverified-loadable, also needs ~48 GB). The old default,
  **Q4** (~18 GB), fits 32 GB but predates the bf16 quality overhaul. **Decision
  needed:** which 14B weight ships as the interim default — Q8 (public, heavier,
  verify-load), bf16 (best quality, re-host, 48 GB-only), or Q4 (fits 32 GB,
  lower quality)? This also decides whether the 32 GB-floor promise
  (`localModels.ts:50`) holds before FastWan-5B lands.

- **D3 — uv strategy: vendor wheels vs download.** Plan vendors `mlx_video` +
  torch + ncnn wheels in `Resources/wheels` (~500 MB in the `.dmg`, offline first
  run) vs a thinner `.dmg` that `uv pip install`s from PyPI at first run
  (network-dependent, but keeps mlx/torch auto-updatable). **Decision needed:**
  fat offline `.dmg` (recommended for reliability on the notarization-sensitive
  first run) vs thin online `.dmg`.

- **D4 — Fast tier as default (the 5b flip).** Once D1 lands and the 5B repo is
  load-tested, flip `DEFAULTS.localVideoModel` to `'5b'` (M3n) so the out-of-box
  default fits the 32 GB floor. **Decision needed:** flip immediately on publish,
  or keep 14B default and expose 5B as an opt-in Fast tile.

- **D5 — Load-test confirmations (verify before commit).** (a) `Anes1032` Q8
  through the Blaizzy mlx-video pipeline; (b) Wan2.2-Lightning 4-step LoRA onto the
  *shipped* 14B weights (Q8/bf16), not just the dev bf16; (c) the full
  download→quarantined-`.dmg`→bootstrap→`/health` flow on **macOS 26 (Tahoe)**.
  These are the empirical gates behind the §0 "YES-with-X" verdict.

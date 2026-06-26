// electron-builder afterSign hook — re-sign the macOS .app with a CLEAN deep ad-hoc signature.
//
// We have no Apple Developer ID, so we can't notarize. electron-builder's default ad-hoc signature on an
// app that asarUnpacks native binaries (our bundled ffmpeg / ffprobe) comes out BROKEN: the outer seal
// references resources that don't match, and Gatekeeper reports the bundle as "is damaged" on Apple
// Silicon (`codesign`/`spctl`: "code has no resources but signature indicates they must be present").
//
// A final `codesign --force --deep --sign -` rebuilds the whole seal correctly (signing the nested
// binaries too), which turns the dead-end "damaged" error into the normal, bypassable "unidentified
// developer" prompt (right-click → Open / System Settings → Open Anyway). No certificate needed — runs on
// any Mac, including CI. (A clean double-click with no prompt still needs a paid Developer ID + notarize.)
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adHocSign(context) {
  const platform = context.electronPlatformName || context.packager?.platform?.name;
  if (platform !== 'darwin' && platform !== 'mac') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc re-signing (deep) ${appPath}`);
  // --force overwrites the broken seal; --deep signs nested code (Electron helpers + ffmpeg/ffprobe).
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
  // Fail the build if the resulting signature isn't valid.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};

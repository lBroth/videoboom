// electron-builder afterSign hook — finalize the macOS .app signature.
//
// Two paths, chosen by whether Apple notarization credentials are present in the environment:
//
//   • Apple creds set (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID) — electron-builder has
//     already Developer-ID signed the app with the hardened runtime; we submit it to Apple's notary
//     service and STAPLE the ticket. Result: a clean double-click, no Gatekeeper prompt.
//
//   • No creds (local dev, forks, CI without secrets) — the app is unsigned, which makes downloaded
//     arm64 builds show the dead-end "is damaged" error. Do a clean deep AD-HOC signature so it becomes
//     the normal, bypassable "unidentified developer" prompt instead. No certificate needed.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function macSign(context) {
  const platform = context.electronPlatformName || context.packager?.platform?.name;
  if (platform !== 'darwin' && platform !== 'mac') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    console.log(`  • notarizing ${appPath} (Apple Developer ID)…`);
    const { notarize } = require('@electron/notarize');
    await notarize({ appPath, appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID });
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' }); // embed the ticket (offline Gatekeeper)
    console.log('  • notarized + stapled');
    return;
  }

  console.log(`  • no Apple creds → ad-hoc deep signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};

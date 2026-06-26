// electron-builder afterAllArtifactBuild hook — notarize + staple the .dmg itself.
//
// The afterSign hook notarizes the .app, but the .dmg that wraps it is a separate artifact. A quarantined
// un-notarized dmg still triggers Gatekeeper ("Apple cannot check it for malicious software") when the
// user opens it — so we notarize + staple the dmg too. Then both the dmg-open and the app-launch are
// clean. Gated on the Apple creds; a no-creds build skips this (the ad-hoc dmg is the free fallback).
const { execFileSync } = require('node:child_process');

exports.default = async function notarizeDmg(buildResult) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!(APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID)) return [];

  for (const p of buildResult.artifactPaths || []) {
    if (!p.endsWith('.dmg')) continue;
    console.log(`  • notarizing dmg ${p}…`);
    execFileSync('xcrun', ['notarytool', 'submit', p, '--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID, '--wait'], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'staple', p], { stdio: 'inherit' });
    console.log('  • dmg notarized + stapled');
  }
  return [];
};

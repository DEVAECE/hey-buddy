// Package Buddy for Windows into out/Buddy-win32-x64 (see BUILD.md).
// The ignore rules live here rather than in package.json: npm runs scripts through cmd.exe, which
// strips "^", so "^/dist" became "/dist" and silently dropped node_modules/vosk-browser/dist
// (the voice engine) from the build.
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// Only at the project root: build output, dev tooling, tests, docs and personal images.
const TOP_LEVEL_EXCLUDES = /^\/(dist|out|tools|test|Images|BUILD\.md|README\.md|\.gitignore|\.git)(\/|$)/;

const [appPath] = await packager({
  dir: root,
  name: 'Buddy',
  platform: 'win32',
  arch: 'x64',
  out: path.join(root, 'out'),
  overwrite: true,
  asar: false,
  icon: path.join(root, 'assets', 'icon.ico'),
  appCopyright: 'Buddy',
  win32metadata: { CompanyName: 'Buddy', FileDescription: 'Buddy' },
  ignore: [TOP_LEVEL_EXCLUDES],
});

// Fail the build if anything Buddy needs at runtime didn't make it in.
const required = [
  'resources/app/node_modules/vosk-browser/dist/vosk.js', // voice engine
  'resources/app/assets/model/vosk-model-small-en-us-0.15.tar.gz', // voice model
  'resources/app/renderer/index.html',
  'resources/app/renderer/companion.html',
  'resources/app/src/cli.js',
];
const missing = required.filter((f) => !fs.existsSync(path.join(appPath, f)));
if (missing.length) {
  console.error(`Build is missing required files:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`Packaged ${appPath}`);

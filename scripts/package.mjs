import { mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import versionTools from './version.cjs';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
VSCode QQ Packaging Entry Point

Usage:
  node scripts/package.mjs [options]
  npm run package [-- options]

Options:
  --release     Package as a release build (auto-converts dev version if needed)
  --dev         Package as a development / pre-release build
  --install     Automatically install the packaged VSIX into local VS Code
  --no-build    Skip the compilation / build step
  --test        Run unit tests before packaging
  --help, -h    Show this help message
`);
  process.exit(0);
}

const isRelease = args.includes('--release');
const isDev = args.includes('--dev');
const shouldInstall = args.includes('--install');
const skipBuild = args.includes('--no-build');
const runTests = args.includes('--test');

console.log('==================================================');
console.log('  VSCode QQ Packaging Entry Point');
console.log('==================================================');

// 1. Build
if (!skipBuild) {
  console.log('\n[1/3] Building extension (TypeScript & esbuild)...');
  const buildResult = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  if (buildResult.status !== 0) {
    console.error('\n[ERROR] Build step failed. Packaging aborted.');
    process.exit(buildResult.status ?? 1);
  }
} else {
  console.log('\n[1/3] Skipping build (--no-build specified)...');
}

// 2. Tests (optional)
if (runTests) {
  console.log('\n[TEST] Running unit tests...');
  const testResult = spawnSync(process.execPath, ['--test', 'dist/test/unit.cjs'], { stdio: 'inherit' });
  if (testResult.status !== 0) {
    console.error('\n[ERROR] Unit tests failed. Packaging aborted.');
    process.exit(testResult.status ?? 1);
  }
}

// 3. Resolve version & package configuration
console.log('\n[2/3] Checking package configuration and version...');
mkdirSync('artifacts', { recursive: true });

let manifest = JSON.parse(readFileSync('package.json', 'utf8'));
let currentVersion = manifest.version;
const parsedVersion = versionTools.parseVersion(currentVersion);

if (isRelease && parsedVersion.dev) {
  console.log(`[INFO] Converting dev version ${currentVersion} to release version...`);
  versionTools.updateVersion('release');
  manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  currentVersion = manifest.version;
} else if (isDev && !parsedVersion.dev) {
  console.log(`[INFO] Converting release version ${currentVersion} to next dev version...`);
  versionTools.updateVersion('dev');
  manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  currentVersion = manifest.version;
}

const activeParsed = versionTools.parseVersion(currentVersion);
const isPreRelease = Boolean(activeParsed.dev);

console.log(`  Package: ${manifest.name}`);
console.log(`  Version: ${currentVersion}`);
console.log(`  Target:  ${isPreRelease ? 'Pre-release (dev)' : 'Release'}`);

// 4. Packaging via vsce
console.log('\n[3/3] Packaging VSIX with @vscode/vsce...');
const outFile = join('artifacts', `${manifest.name}-${currentVersion}.vsix`);
const vsceArgs = [
  'node_modules/@vscode/vsce/vsce',
  'package',
  ...(isPreRelease ? ['--pre-release'] : []),
  '--no-dependencies',
  '--allow-missing-repository',
  '--out',
  outFile
];

const vsceResult = spawnSync(process.execPath, vsceArgs, { stdio: 'inherit' });
if (vsceResult.status !== 0) {
  console.error('\n[ERROR] Packaging failed.');
  process.exit(vsceResult.status ?? 1);
}

if (!existsSync(outFile)) {
  console.error(`\n[ERROR] Expected artifact not found at: ${outFile}`);
  process.exit(1);
}

const stats = statSync(outFile);
const sizeKb = (stats.size / 1024).toFixed(2);

console.log('\n==================================================');
console.log('  Packaging Completed Successfully!');
console.log(`  Output: ${outFile}`);
console.log(`  Size:   ${sizeKb} KB`);
console.log('==================================================');

// 5. Optional install
if (shouldInstall) {
  console.log('\n[INSTALL] Installing extension to local VS Code...');
  const installResult = spawnSync(process.execPath, ['scripts/install-extension.cjs', ...(isRelease ? ['--release'] : [])], { stdio: 'inherit' });
  if (installResult.status !== 0) {
    console.error('\n[WARNING] Installation command encountered an issue.');
    process.exit(installResult.status ?? 1);
  }
}

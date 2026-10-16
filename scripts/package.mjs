import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import versionTools from './version.cjs';
mkdirSync('artifacts', { recursive: true });
const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
// Versions are explicit: x.y.z-devN locally, x.y.z for a requested release.
const release = process.argv.includes('--release');
versionTools.checkPackageVersion(version, release);
const result = spawnSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'package', ...(!release ? ['--pre-release'] : []), '--no-dependencies', '--allow-missing-repository', '--out', `artifacts/${name}-${version}.vsix`], { stdio: 'inherit' });
process.exit(result.status ?? 1);

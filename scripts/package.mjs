import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('artifacts', { recursive: true });
const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
// Local development keeps the manifest version fixed. Only an explicit release builds a stable package.
const release = process.argv.includes('--release');
const suffix = release ? '' : '-pre';
const result = spawnSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'package', ...(!release ? ['--pre-release'] : []), '--no-dependencies', '--allow-missing-repository', '--out', `artifacts/${name}-${version}${suffix}.vsix`], { stdio: 'inherit' });
process.exit(result.status ?? 1);

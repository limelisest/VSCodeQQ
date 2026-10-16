'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { checkPackageVersion } = require('./version.cjs');
if (process.platform !== 'win32') throw new Error('请用 Windows Node 运行安装脚本');
const root = path.resolve(__dirname, '..');
const installation = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
const launcher = fs.readFileSync(path.join(installation, 'bin', 'code.cmd'), 'utf8');
const match = launcher.match(/%~dp0\.\.\\([^"\r\n]*resources\\app\\out\\cli\.js)/i);
if (!match) throw new Error('无法定位当前 VS Code CLI');
const cli = path.join(installation, match[1]);
const executable = path.join(installation, 'Code.exe');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
delete env.VSCODE_DEV;
const { publisher, name, version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const identity = `${publisher}.${name}@${version}`.toLowerCase();
checkPackageVersion(version, process.argv.includes('--release'));
const artifact = path.join(root, 'artifacts', `${name}-${version}.vsix`);
if (!fs.existsSync(artifact)) throw new Error('请先打包 VSIX');
let result = spawnSync(executable, [cli, '--install-extension', artifact, '--force'], { env, stdio: 'inherit', timeout: 120000 });
if (result.status !== 0) process.exit(result.status ?? 1);
result = spawnSync(executable, [cli, '--list-extensions', '--show-versions'], { env, encoding: 'utf8', timeout: 30000 });
if (result.status !== 0 || !result.stdout.toLowerCase().split(/\r?\n/).includes(identity)) {
  console.error('安装后的扩展列表验证失败'); process.exit(1);
}
console.log(`Verified installed: ${identity}`);

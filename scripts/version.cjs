'use strict';
const fs = require('node:fs');
const path = require('node:path');

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev([1-9]\d*))?$/.exec(version);
  if (!match) throw new Error(`不支持的版本号：${version}；请使用 x.y.z 或 x.y.z-devN`);
  return { major: match[1], minor: match[2], patch: match[3], dev: match[4] };
}
function nextDevVersion(version) {
  const { major, minor, patch, dev } = parseVersion(version);
  return dev ? `${major}.${minor}.${patch}-dev${BigInt(dev) + 1n}` : `${major}.${minor}.${BigInt(patch) + 1n}-dev1`;
}
function releaseVersion(version) {
  const { major, minor, patch } = parseVersion(version);
  return `${major}.${minor}.${patch}`;
}
function checkPackageVersion(version, release) {
  const parsed = parseVersion(version);
  if (release && parsed.dev) throw new Error('请先执行 npm run version:release，将开发版本转为正式版本');
  if (!release && !parsed.dev) throw new Error('请先执行 npm run version:dev，开始下一正式版本的开发');
}
function updateVersion(mode) {
  if (!['dev', 'release'].includes(mode)) throw new Error('用法：node scripts/version.cjs dev|release');
  const root = path.resolve(__dirname, '..');
  const manifestPath = path.join(root, 'package.json'), lockPath = path.join(root, 'package-lock.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8'), lockText = fs.readFileSync(lockPath, 'utf8');
  const manifest = JSON.parse(manifestText), lock = JSON.parse(lockText);
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) throw new Error('package.json 与 package-lock.json 版本不一致，请先检查');
  const next = mode === 'dev' ? nextDevVersion(manifest.version) : releaseVersion(manifest.version);
  const changeRoot = text => text.replace(/^(\s*"version"\s*:\s*")[^"]+("\s*,?)/m, (_, prefix, suffix) => prefix + next + suffix);
  const nextManifest = changeRoot(manifestText);
  const nextLock = changeRoot(lockText).replace(/("":\s*\{[^{}]*?"version"\s*:\s*")[^"]+(")/, (_, prefix, suffix) => prefix + next + suffix);
  if (JSON.parse(nextManifest).version !== next || JSON.parse(nextLock).version !== next || JSON.parse(nextLock).packages?.['']?.version !== next) throw new Error('无法更新版本字段，未写入文件');
  fs.writeFileSync(manifestPath, nextManifest); fs.writeFileSync(lockPath, nextLock);
  console.log(`${manifest.version} -> ${next}`);
}
module.exports = { parseVersion, nextDevVersion, releaseVersion, checkPackageVersion };
if (require.main === module) {
  try { updateVersion(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

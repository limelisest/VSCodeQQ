'use strict';
const fs = require('node:fs');
const path = require('node:path');

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev([1-9]\d*))?$/.exec(version);
  if (!match) throw new Error(`Unsupported version format: "${version}". Expected x.y.z or x.y.z-devN`);
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
  if (release && parsed.dev) throw new Error('Please run "npm run version:release" first to convert development version to release');
  if (!release && !parsed.dev) throw new Error('Please run "npm run version:dev" first to start development version');
}

function updateVersion(mode) {
  if (!['dev', 'release'].includes(mode)) throw new Error('Usage: node scripts/version.cjs dev|release');
  const root = path.resolve(__dirname, '..');
  const manifestPath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const lockText = fs.readFileSync(lockPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) {
    throw new Error('Version mismatch between package.json and package-lock.json. Please verify.');
  }
  const next = mode === 'dev' ? nextDevVersion(manifest.version) : releaseVersion(manifest.version);
  const changeRoot = text => text.replace(/^(\s*"version"\s*:\s*")[^"]+("\s*,?)/m, (_, prefix, suffix) => prefix + next + suffix);
  const nextManifest = changeRoot(manifestText);
  const nextLock = changeRoot(lockText).replace(/("":\s*\{[^{}]*?"version"\s*:\s*")[^"]+(")/, (_, prefix, suffix) => prefix + next + suffix);
  if (JSON.parse(nextManifest).version !== next || JSON.parse(nextLock).version !== next || JSON.parse(nextLock).packages?.['']?.version !== next) {
    throw new Error('Failed to update version field in manifest or lockfile.');
  }
  fs.writeFileSync(manifestPath, nextManifest);
  fs.writeFileSync(lockPath, nextLock);
  console.log(`Version updated: ${manifest.version} -> ${next}`);
}

module.exports = { parseVersion, nextDevVersion, releaseVersion, checkPackageVersion, updateVersion };

if (require.main === module) {
  try {
    updateVersion(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

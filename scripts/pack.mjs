import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function packageVersion(name) {
  const file = path.join(root, 'node_modules', name, 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) return fallback;
  return process.argv[index + 1];
}

const targetOs = arg('os', process.platform);
const targetCpu = arg('cpu', process.arch);
if (!['win32', 'linux'].includes(targetOs) || targetCpu !== 'x64') {
  throw new Error('Supported targets: --os win32|linux --cpu x64');
}

const nodeVersion = process.version.replace(/^v/, '');
const folderName = `mesh-to-tiles-${targetOs === 'win32' ? 'win' : 'linux'}-x64`;
const outDir = path.join(root, 'release', folderName);
const nodeLabel = `node-v${nodeVersion}-${targetOs === 'win32' ? 'win-x64' : 'linux-x64'}`;
const nodeUrl = targetOs === 'win32'
  ? `https://nodejs.org/dist/v${nodeVersion}/${nodeLabel}.zip`
  : `https://nodejs.org/dist/v${nodeVersion}/${nodeLabel}.tar.xz`;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const esbuild = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
function bundle(entry, outfile) {
  const result = spawnSync(process.execPath, [
    esbuild,
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${outfile}`,
    '--external:sharp',
    '--external:draco3dgltf',
    '--external:@loaders.gl/textures',
  ], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function installPacked(name, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-to-tiles-pack-'));
  const pack = spawnSync('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp], { stdio: 'inherit', shell: true });
  if (pack.status !== 0) process.exit(pack.status ?? 1);
  const tarball = fs.readdirSync(tmp).find((file) => file.endsWith('.tgz'));
  const dest = path.join(outDir, 'node_modules', ...name.split('/'));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const extract = spawnSync('tar', ['-xf', path.join(tmp, tarball), '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (extract.status !== 0) process.exit(extract.status ?? 1);
}

bundle(path.join(root, 'src', 'cli.ts'), path.join(outDir, 'mesh-to-tiles.js'));
bundle(path.join(root, 'src', 'ktx2-worker.ts'), path.join(outDir, 'ktx2-worker.js'));

const runtimePackage = {
  name: 'mesh-to-tiles-runtime',
  private: true,
  type: 'module',
  dependencies: {
    '@loaders.gl/textures': packageVersion('@loaders.gl/textures'),
    draco3dgltf: packageVersion('draco3dgltf'),
    sharp: packageVersion('sharp'),
  },
};
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(runtimePackage, null, 2));

const install = spawnSync('npm', [
  'install', '--omit=dev', '--foreground-scripts',
  '--os', targetOs, '--cpu', targetCpu,
], { cwd: outDir, stdio: 'inherit', shell: true });
if (install.status !== 0) process.exit(install.status ?? 1);
const sharpPlatform = targetOs === 'win32' ? '@img/sharp-win32-x64' : '@img/sharp-linux-x64';
installPacked(sharpPlatform, runtimePackage.dependencies.sharp);
const platformPackage = JSON.parse(fs.readFileSync(path.join(outDir, 'node_modules', sharpPlatform, 'package.json'), 'utf8'));
const nested = { ...platformPackage.dependencies, ...platformPackage.optionalDependencies };
for (const [name, version] of Object.entries(nested)) {
  if (name.startsWith('@img/')) installPacked(name, version);
}

const archive = path.join(os.tmpdir(), path.basename(nodeUrl));
if (!fs.existsSync(archive)) {
  const response = await fetch(nodeUrl);
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${nodeUrl}`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-to-tiles-node-'));
const nodeEntry = targetOs === 'win32' ? `${nodeLabel}/node.exe` : `${nodeLabel}/bin/node`;
const unpack = spawnSync('tar', ['-xf', archive, '-C', extracted, nodeEntry], { stdio: 'inherit' });
if (unpack.status !== 0) process.exit(unpack.status ?? 1);
const nodeSource = targetOs === 'win32'
  ? path.join(extracted, nodeLabel, 'node.exe')
  : path.join(extracted, nodeLabel, 'bin', 'node');
fs.copyFileSync(nodeSource, path.join(outDir, targetOs === 'win32' ? 'node.exe' : 'node'));
fs.rmSync(extracted, { recursive: true, force: true });

if (targetOs === 'win32') {
  fs.writeFileSync(path.join(outDir, 'mesh-to-tiles.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0mesh-to-tiles.js" %*\r\n');
} else {
  const launcher = path.join(outDir, 'mesh-to-tiles');
  fs.writeFileSync(launcher, '#!/bin/sh\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$DIR/node" "$DIR/mesh-to-tiles.js" "$@"\n');
  fs.chmodSync(launcher, 0o755);
  fs.chmodSync(path.join(outDir, 'node'), 0o755);
}

console.log(`Packed ${outDir}`);

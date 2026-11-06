#!/usr/bin/env node
import fs from 'node:fs';
import { run } from './pipeline.js';
import { convertOsgb } from './osgb.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}

function numberArg(value: string | boolean | undefined, fallback: number): number {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got ${value}`);
  return n;
}

const help = `mesh-to-tiles — photogrammetry mesh or OSGB to 3D Tiles 1.1

Usage:
  mesh-to-tiles --input model.obj --output dir [options]
  mesh-to-tiles --input model.glb --output dir [options]
  mesh-to-tiles --input osgb-dir --output dir [--no-ktx2]

A directory is OSGB (metadata.xml + .osgb). A file is OBJ or glTF.
OSGB reads the origin from metadata.xml. --up applies to every output. The other mesh options apply only to OBJ and glTF.

Options:
  --up y|z            Output glTF up axis (default y, the Cesium orientation)
  --leaf-size <m>     Target finest cell size (default 40)
  --leaf-error <m>    geometricError of the finest level (default 1)
  --max-levels <n>    Level cap (default 6)
  --longitude <deg>   Longitude of local origin (0,0,0)
  --latitude <deg>    Latitude of local origin
  --height <m>        Ellipsoid height of local origin (default 0)
  --texture-format <jpeg|webp|ktx2>  Atlas format (default jpeg)
  --texture-quality <1-100>          JPEG/WebP quality (default 75)
  --fine-texture-quality <0-100>     Finest level JPEG/WebP quality, 0 uses --texture-quality
  --max-texture-size <px>            Atlas edge cap, 0 disables (default 4096)
  --ktx2-quality <n>                 ETC1S 1-255 or UASTC 0-4 (default 128)
  --ktx2-uastc                       KTX2 UASTC instead of ETC1S
  --ktx2-threads <n>                 Textures encoded at once, 0 auto up to 16
  --ktx2-zstd-level <0-22>           UASTC Zstandard on when > 0 (default 0)
  --ktx-level <0-6>                  ETC1S effort (default 2)
  --no-ktx2                          Force JPEG
  --help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input || !args.output) {
  console.log(help);
  process.exit(args.help ? 0 : 1);
}

const up = args.up === undefined ? 'y' : String(args.up);
if (up !== 'z' && up !== 'y') {
  console.error('--up must be y or z');
  process.exit(1);
}

const ktxLevel = numberArg(args['ktx-level'], 2);
if (!Number.isInteger(ktxLevel) || ktxLevel < 0 || ktxLevel > 6) {
  console.error('--ktx-level must be an integer from 0 to 6');
  process.exit(1);
}
if (args['ktx-path']) {
  console.error('--ktx-path is not used. KTX2 is encoded by the bundled Basis encoder.');
  process.exit(1);
}
const formatArg = args['texture-format'] === undefined ? 'jpeg' : String(args['texture-format']).toLowerCase();
const format = formatArg === 'ktx2' ? 'ktx2' : formatArg === 'webp' ? 'webp' : formatArg === 'jpeg' ? 'jpeg' : '';
if (!format || (args['no-ktx2'] === true && format === 'ktx2')) {
  console.error('--texture-format must be jpeg, webp, or ktx2');
  process.exit(1);
}
const quality = numberArg(args['texture-quality'], 75);
const fineQuality = numberArg(args['fine-texture-quality'], 0);
const maxSize = numberArg(args['max-texture-size'], 4096);
const uastc = args['ktx2-uastc'] === true;
const ktx2Quality = numberArg(args['ktx2-quality'], 128);
const threads = numberArg(args['ktx2-threads'], 0);
const zstdLevel = numberArg(args['ktx2-zstd-level'], 0);
if (quality < 1 || quality > 100 || fineQuality < 0 || fineQuality > 100) {
  console.error('--texture-quality must be 1-100 and --fine-texture-quality must be 0-100');
  process.exit(1);
}
if (!Number.isInteger(maxSize) || maxSize < 0) {
  console.error('--max-texture-size must be an integer >= 0');
  process.exit(1);
}
if (uastc && (ktx2Quality < 0 || ktx2Quality > 4)) {
  console.error('--ktx2-quality must be 0-4 when --ktx2-uastc is set');
  process.exit(1);
}
if (!uastc && (ktx2Quality < 1 || ktx2Quality > 255)) {
  console.error('--ktx2-quality must be 1-255 for ETC1S');
  process.exit(1);
}
if (!Number.isInteger(threads) || threads < 0 || !Number.isInteger(zstdLevel) || zstdLevel < 0 || zstdLevel > 22) {
  console.error('--ktx2-threads must be >= 0 and --ktx2-zstd-level must be 0-22');
  process.exit(1);
}
if (zstdLevel > 0 && !uastc) {
  console.error('--ktx2-zstd-level requires --ktx2-uastc');
  process.exit(1);
}
const texture = {
  format: (args['no-ktx2'] === true ? 'jpeg' : format) as 'jpeg' | 'webp' | 'ktx2',
  quality,
  fineQuality,
  maxSize,
  ktx2Quality,
  uastc,
  threads,
  zstdLevel,
  ktxLevel,
};

if (fs.existsSync(String(args.input)) && fs.statSync(String(args.input)).isDirectory()) {
  convertOsgb(String(args.input), String(args.output), up as 'y' | 'z', texture).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else run({
  input: String(args.input),
  output: String(args.output),
  up: up as 'y' | 'z',
  leafSize: numberArg(args['leaf-size'], 40),
  leafError: numberArg(args['leaf-error'], 1),
  maxLevels: numberArg(args['max-levels'], 6),
  longitude: args.longitude === undefined ? undefined : numberArg(args.longitude, NaN),
  latitude: args.latitude === undefined ? undefined : numberArg(args.latitude, NaN),
  height: numberArg(args.height, 0),
  texture,
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

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
  --ktx-level <0-6>   ETC1S compression level (default 2). Higher is slower
  --no-ktx2           Keep PNG (mesh) or JPEG (OSGB). KTX2 ETC1S is on by default
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

if (fs.existsSync(String(args.input)) && fs.statSync(String(args.input)).isDirectory()) {
  convertOsgb(String(args.input), String(args.output), args['no-ktx2'] !== true, up as 'y' | 'z', ktxLevel).catch((err: unknown) => {
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
  ktx2: args['no-ktx2'] !== true,
  ktxLevel,
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env node
import { run } from './pipeline.js';

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

const help = `mesh-to-tiles — photogrammetry mesh to 3D Tiles 1.1

Usage:
  mesh-to-tiles --input model.obj --output dir [options]

Options:
  --up z|y            OBJ defaults to z, glTF defaults to y
  --leaf-size <m>     Target finest cell size (default 40)
  --leaf-error <m>    geometricError of the finest level (default 1)
  --max-levels <n>    Level cap (default 6)
  --longitude <deg>   Longitude of local origin (0,0,0)
  --latitude <deg>    Latitude of local origin
  --height <m>        Ellipsoid height of local origin (default 0)
  --no-ktx2           Keep the atlas as PNG. KTX2 ETC1S is on by default
  --help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input || !args.output) {
  console.log(help);
  process.exit(args.help ? 0 : 1);
}

const up = args.up === undefined ? undefined : String(args.up);
if (up !== undefined && up !== 'z' && up !== 'y') {
  console.error('--up must be z or y');
  process.exit(1);
}

run({
  input: String(args.input),
  output: String(args.output),
  up,
  leafSize: numberArg(args['leaf-size'], 40),
  leafError: numberArg(args['leaf-error'], 1),
  maxLevels: numberArg(args['max-levels'], 6),
  longitude: args.longitude === undefined ? undefined : numberArg(args.longitude, NaN),
  latitude: args.latitude === undefined ? undefined : numberArg(args.latitude, NaN),
  height: numberArg(args.height, 0),
  ktx2: args['no-ktx2'] !== true,
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

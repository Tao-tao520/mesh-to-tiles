export function enuTransform(longitudeDeg: number, latitudeDeg: number, height: number): number[] {
  const lon = (longitudeDeg * Math.PI) / 180;
  const lat = (latitudeDeg * Math.PI) / 180;
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const x = (n + height) * cosLat * Math.cos(lon);
  const y = (n + height) * cosLat * Math.sin(lon);
  const z = (n * (1 - e2) + height) * sinLat;
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-sinLat * Math.cos(lon), -sinLat * Math.sin(lon), cosLat];
  const up = [cosLat * Math.cos(lon), cosLat * Math.sin(lon), sinLat];
  return [
    east[0], east[1], east[2], 0,
    north[0], north[1], north[2], 0,
    up[0], up[1], up[2], 0,
    x, y, z, 1,
  ];
}

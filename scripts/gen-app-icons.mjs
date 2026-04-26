/**
 * Raster icons from the same nested-frame ratios as public/favicon.svg.
 * Run: node scripts/gen-app-icons.mjs  (requires devDependency pngjs)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../public');

/** sRGB + alpha */
const BG = [15, 23, 42, 255];
const MID = [30, 41, 59, 255];
const INNER = [15, 23, 42, 255];
const ACCENT = [56, 189, 248, 255];

function drawIcon(size) {
  const png = new PNG({ width: size, height: size, colorType: 6 });
  const w = size;

  const margin = Math.round((56 / 512) * w);
  const r1 = Math.round((112 / 512) * w);
  const r2 = Math.round((188 / 512) * w);
  const r1e = w - r1;
  const r2e = w - r2;

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2;
      let c = BG;
      if (x >= margin && x < w - margin && y >= margin && y < w - margin) c = MID;
      if (x >= r1 && x < r1e && y >= r1 && y < r1e) c = INNER;
      if (x >= r2 && x < r2e && y >= r2 && y < r2e) c = ACCENT;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = c[3];
    }
  }
  return PNG.sync.write(png);
}

for (const dim of [32, 192, 512]) {
  const name = dim === 32 ? 'favicon-32x32.png' : `icon-${dim}.png`;
  writeFileSync(join(publicDir, name), drawIcon(dim));
}

console.log('Wrote public/favicon-32x32.png, public/icon-192.png, public/icon-512.png');

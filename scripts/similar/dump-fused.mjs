// Dump fused BirdBox boxes from snap-benchmark row caches: node --import tsx scripts/similar/dump-fused.mjs <rowsDir> <out.json>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fuseBoxes } from '../../src/domain/detector/fusion.ts';
const [dir, out] = process.argv.slice(2), res = {};
for (const f of readdirSync(dir).filter(f => f.endsWith('.rows.f32'))) {
  const b = readFileSync(`${dir}/${f}`), d = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  // Key = segment name as similar-benchmark.py looks it up: '<seg>.wav.<hash>.rows.f32' → '<seg>'
  const key = f.replace(/\.wav\..*$/i, '').replace(/\.rows\.f32$/i, '');
  // Same fusion as snap-benchmark's default: confidence 0.15, gap 0.05 s; boxes in s and Hz
  res[key] = fuseBoxes(d, d.length / 9, 0.15, 0.05).map(x => [x.t0, x.t1, x.flo, x.fhi, x.max]);
}
writeFileSync(out, JSON.stringify(res));

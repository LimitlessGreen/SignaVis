// Dump fused BirdBox boxes from snap-benchmark row caches: node --import tsx scripts/similar/dump-fused.mjs <rowsDir> <out.json>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fuseBoxes } from '../../src/domain/detector/fusion.ts';
const [dir, out] = process.argv.slice(2), res = {};
for (const f of readdirSync(dir).filter(f => f.endsWith('.rows.f32'))) {
  const b = readFileSync(`${dir}/${f}`), d = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  res[f.split('.wav')[0]] = fuseBoxes(d, d.length / 9, 0.15, 0.05).map(x => [x.t0, x.t1, x.flo, x.fhi, x.max]);
}
writeFileSync(out, JSON.stringify(res));

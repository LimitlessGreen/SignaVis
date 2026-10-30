// Parity with the JS reference (fixtures from gen-fixtures.mjs).
use aw_dsp::*;

fn load(name: &str) -> Vec<f32> {
    let p = format!("{}/tests/fixtures/{name}.f32", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("{p}: {e} — run gen-fixtures.mjs"))
        .chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
}

fn params(scale: Scale, pcen: bool) -> SpecParams {
    let mut p = SpecParams::perch(32000);
    p.win_length = 1280;
    p.scale = scale;
    if !pcen { p.pcen = None; }
    if scale == Scale::Linear { p.fft_size = 1024; p.win_length = 1024; p.hop_size = 512; }
    p
}

/// Run streaming with a small block size so block boundaries are exercised.
fn compute(p: SpecParams, audio: &[f32], block: usize) -> Vec<f32> {
    let e = SpecEngine::new(p);
    let mut out = Vec::new();
    e.run(&mut MemSource(audio), block, |_, v| { out.extend_from_slice(v); Ok(()) }).unwrap();
    out
}

fn check(name: &str, p: SpecParams, tol: f32) {
    let audio = load("audio");
    let want = load(name);
    for block in [37, 4096] {
        let got = compute(p.clone(), &audio, block);
        assert_eq!(got.len(), want.len(), "{name}: length");
        let range = want.iter().fold(f32::MIN, |a, &b| a.max(b)) - want.iter().fold(f32::MAX, |a, &b| a.min(b));
        let (mut max_err, mut at) = (0f32, 0);
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            let e = (g - w).abs();
            if e > max_err { max_err = e; at = i; }
        }
        println!("{name} block={block}: max abs err {max_err:.2e} (range {range:.2}) at {at}");
        assert!(max_err <= tol * range, "{name}: err {max_err} at {at} (got {}, want {})", got[at], want[at]);
    }
}

#[test] fn mel_pcen() { check("mel_pcen", params(Scale::Mel, true), 1e-3); }
#[test] fn mel_db() { check("mel_db", params(Scale::Mel, false), 1e-3); }
#[test] fn linear_db() { check("linear_db", params(Scale::Linear, false), 1e-3); }

/// Independent blocks with PCEN warm-up must match the sequential stream.
#[test]
fn independent_blocks_match_sequential() {
    // 60 s with hard loud→near-silent transitions (worst case for warm-up).
    let mut seed = 1u32;
    let audio: Vec<f32> = (0..32000 * 60).map(|i| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed as f32 / 4294967296.0 - 0.5) * 1e-4;
        let loud = (i / 32000 / 7) % 2 == 0;
        noise + if loud { 0.8 * (i as f32 * 0.21).sin() } else { 0.0 }
    }).collect();
    let p = params(Scale::Mel, true);
    let e = SpecEngine::new(p.clone());
    let seq = compute(p.clone(), &audio, 4096);
    let bins = p.out_bins();
    let total = p.n_frames(audio.len() as u64) as usize;
    let warmup = e.pcen_warmup(1e-12);
    assert!(warmup > 1000 && warmup < 1200, "{warmup}");
    // Blocks of 777 frames; the first ones have clipped warm-up at file start.
    let mut max_rel = 0f32;
    for f0 in (0..total).step_by(777) {
        let n = 777.min(total - f0);
        let w = warmup.min(f0);
        let s0 = (f0 - w) * p.hop_size;
        let end = (s0 + e.samples_for_frames(w + n)).min(audio.len());
        let got = e.block_values(&audio[s0..end], w, n);
        for (g, want) in got.iter().zip(&seq[f0 * bins..(f0 + n) * bins]) {
            max_rel = max_rel.max((g - want).abs() / want.abs().max(1e-3));
        }
    }
    println!("independent blocks: max rel err {max_rel:.2e}");
    assert!(max_rel < 1e-5);
}

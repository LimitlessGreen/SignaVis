// Streaming benchmark on a WAV file.
//   cargo run --release --example bench -- gen <path.wav> <minutes>
//   cargo run --release --example bench -- run <path.wav> [block_frames]
use aw_dsp::v2::{FreqScale, Pcen, Stft, StftParams, WindowKind};
use aw_dsp::*;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("gen") => generate(&args[2], args[3].parse().unwrap()),
        Some("run") => run(&args[2], args.get(3).map_or(6000, |s| s.parse().unwrap())),
        Some("pyr") => pyr(&args[2], &args[3]),
        Some("read") => read(&args[2]),
        _ => eprintln!("usage: bench gen <wav> <minutes> | bench run <wav> [block_frames] | bench pyr <wav> <dir>"),
    }
}

/// Same signal as tests/bench-spectrogram-long.mjs (16-bit mono, 32 kHz).
fn generate(path: &str, minutes: u64) {
    let sr = 32000u32;
    let spec = hound::WavSpec { channels: 1, sample_rate: sr, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).unwrap();
    let mut seed: u32 = 1;
    for i in 0..sr as u64 * 60 * minutes {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let sec = i / sr as u64;
        let f = 500.0 + (sec % 60) as f64 * 200.0;
        let burst = if (i % sr as u64) < (sr as u64 / 20) {
            0.5 * (2.0 * std::f64::consts::PI * f * i as f64 / sr as f64).sin()
        } else { 0.0 };
        let v = 0.01 * (seed as f64 / 4294967296.0 - 0.5) + burst;
        w.write_sample((v * 32767.0) as i16).unwrap();
    }
    w.finalize().unwrap();
}

/// Perch-like settings: 1280-sample window, 10 ms hop, 128 mel bands, PCEN.
fn params(sr: u32) -> StftParams {
    StftParams {
        sample_rate: sr, win_len: 1280, hop: sr as usize / 100, n_fft: 2048, window: WindowKind::Hann,
        scale: FreqScale::Mel { bands: 128, f_min: 60.0, f_max: sr as f64 / 2.0 },
        pcen: Some(Pcen::default()), reassign: false, output: Default::default(),
    }
}

fn pyr(path: &str, dir: &str) {
    let mut src = WavSource::open(path).unwrap();
    let p = params(src.sample_rate());
    let t0 = Instant::now();
    let meta = build_pyramid(&mut src, p, std::path::Path::new(dir), |_| true).unwrap();
    println!("built in {:.2} s: {:?}
stats {:?}", t0.elapsed().as_secs_f64(), meta.levels, meta.stats);
    read(dir);
}

fn read(dir: &str) {
    let pyr = Pyramid::<StftParams>::open_as(std::path::Path::new(dir)).unwrap().unwrap();
    for f0 in [1_000_000u64, 1_003_000, 2_500_000] {
        let t1 = Instant::now();
        let tile = pyr.read(0, f0, f0 + 3000).unwrap(); // 30 s tile
        println!("30 s tile read @{f0}: {} values in {:.2} ms", tile.len(), t1.elapsed().as_secs_f64() * 1e3);
    }
}

fn run(path: &str, block: usize) {
    let mut src = WavSource::open(path).unwrap();
    let engine = Stft::new(params(src.sample_rate())).unwrap();
    let minutes = src.len() as f64 / src.sample_rate() as f64 / 60.0;
    println!("{path}: {minutes:.1} min, {} ch, threads {}", src.channels(), rayon::current_num_threads());

    let t0 = Instant::now();
    let mut checksum = 0f64;
    let mut last_report = Instant::now();
    let frames = engine.run(&mut src, block, |f0, v| {
        checksum += v[v.len() / 2] as f64;
        if last_report.elapsed().as_secs() >= 5 {
            println!("  … frame {f0} ({:.0} s)", t0.elapsed().as_secs_f64());
            last_report = Instant::now();
        }
        Ok(())
    }).unwrap();
    let s = t0.elapsed().as_secs_f64();
    println!("frames {frames}, {s:.2} s total, {:.3} s per audio minute, checksum {checksum:.3}", s / minutes);
}

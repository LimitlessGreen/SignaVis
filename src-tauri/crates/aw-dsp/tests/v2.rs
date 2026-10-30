// Analytic tests for aw_dsp::v2 — expectations come from signal theory,
// not from any previous implementation.
use aw_dsp::v2::*;
use std::f64::consts::PI;

const SR: u32 = 44100;

fn sine(freq: f64, amp: f64, secs: f64) -> Vec<f32> {
    (0..(secs * SR as f64) as usize).map(|i| (amp * (2.0 * PI * freq * i as f64 / SR as f64).sin()) as f32).collect()
}

fn params(win: usize, hop: usize, nfft: usize, window: WindowKind, scale: FreqScale) -> StftParams {
    StftParams { sample_rate: SR, win_len: win, hop, n_fft: nfft, window, scale, pcen: None, reassign: false }
}

/// Peak value and its row in a middle frame.
fn peak(p: &StftParams, audio: &[f32]) -> (f32, usize) {
    let out = Stft::new(p.clone()).unwrap().compute(audio);
    let bins = p.out_bins();
    let mid = out.len() / bins / 2;
    let row = &out[mid * bins..(mid + 1) * bins];
    let (i, v) = row.iter().enumerate().fold((0, f32::MIN), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
    (v, i)
}

#[test]
fn full_scale_sine_reads_0_dbfs_for_every_window_and_size() {
    // Bin-centred frequency so scalloping loss is zero.
    for (win, nfft) in [(256, 256), (512, 2048), (1024, 1024), (2048, 8192)] {
        let f = 40.0 * SR as f64 / nfft as f64 * (nfft / win) as f64;
        for w in [WindowKind::Hann, WindowKind::Hamming, WindowKind::Blackman, WindowKind::BlackmanHarris, WindowKind::Kaiser { beta: 8.0 }] {
            let p = params(win, win / 4, nfft, w, FreqScale::Linear);
            let (db, row) = peak(&p, &sine(f, 1.0, 1.0));
            assert!(db.abs() < 0.05, "{w:?} win={win} nfft={nfft}: {db} dBFS");
            let want = (f * nfft as f64 / SR as f64).round() as usize;
            assert_eq!(row, want);
        }
    }
}

#[test]
fn half_amplitude_is_minus_6_db() {
    let p = params(1024, 256, 1024, WindowKind::Hann, FreqScale::Linear);
    let f = 100.0 * SR as f64 / 1024.0;
    let (db, _) = peak(&p, &sine(f, 0.5, 1.0));
    assert!((db - (-6.0206)).abs() < 0.05, "{db}");
}

#[test]
fn mel_band_reads_sine_level() {
    // A sine inside a wide (high-frequency) mel band reads ≈ its level.
    let scale = FreqScale::Mel { bands: 128, f_min: 0.0, f_max: 22050.0 };
    let p = params(1024, 256, 2048, WindowKind::Hann, scale);
    let freqs = p.bin_frequencies();
    let f = freqs[100];
    let (db, row) = peak(&p, &sine(f, 1.0, 1.0));
    assert_eq!(row, 100);
    assert!(db.abs() < 0.5, "{db} dBFS");
}

#[test]
fn band_scales_have_no_empty_or_degenerate_bands() {
    for scale in [
        FreqScale::Mel { bands: 256, f_min: 0.0, f_max: 22050.0 },
        FreqScale::Log { bands: 240, f_min: 50.0, f_max: 22050.0 },
    ] {
        let p = params(512, 128, 512, WindowKind::Hann, scale);
        let fb = filterbank(&p);
        assert_eq!(fb.len(), p.out_bins());
        for (i, b) in fb.iter().enumerate() {
            let s: f32 = b.weights.iter().sum();
            assert!(s > 0.0, "{scale:?} band {i} empty");
        }
        let f = p.bin_frequencies();
        assert!(f.windows(2).all(|w| w[1] > w[0]), "centres not increasing");
    }
}

#[test]
fn frames_are_centred() {
    // An impulse at t = 0.5 s peaks in the frame whose time is 0.5 s.
    let p = params(1024, 441, 1024, WindowKind::Hann, FreqScale::Linear);
    let mut audio = vec![0f32; SR as usize];
    audio[SR as usize / 2] = 1.0;
    let out = Stft::new(p.clone()).unwrap().compute(&audio);
    let bins = p.out_bins();
    let energy: Vec<f32> = out.chunks(bins).map(|r| r.iter().map(|d| 10f32.powf(d / 10.0)).sum()).collect();
    let best = energy.iter().enumerate().fold((0, 0f32), |a, (i, &v)| if v > a.1 { (i, v) } else { a }).0;
    assert!((p.frame_time(best as u64) - 0.5).abs() < 1e-9, "peak frame at {}", p.frame_time(best as u64));
    assert_eq!(out.len() / bins, p.n_frames(audio.len() as u64) as usize);
}

#[test]
fn win_longer_than_fft_is_rejected() {
    assert!(Stft::new(params(2048, 512, 1024, WindowKind::Hann, FreqScale::Linear)).is_err());
}

#[test]
fn streaming_blocks_match_single_block() {
    let mut p = params(512, 128, 1024, WindowKind::Hann, FreqScale::Mel { bands: 64, f_min: 0.0, f_max: 22050.0 });
    p.pcen = Some(Pcen::default());
    let audio: Vec<f32> = sine(3000.0, 0.3, 2.0).iter().enumerate().map(|(i, s)| s * ((i / 5000) % 2) as f32).collect();
    let e = Stft::new(p).unwrap();
    let whole = e.compute(&audio);
    let mut parts = Vec::new();
    e.run(&mut aw_dsp::MemSource(&audio), 37, |_, v| { parts.extend_from_slice(v); Ok(()) }).unwrap();
    assert_eq!(whole.len(), parts.len());
    for (a, b) in whole.iter().zip(&parts) { assert!((a - b).abs() <= 1e-4 * a.abs().max(1.0), "{a} vs {b}"); }
}

#[test]
fn pcen_time_constant_is_hop_independent() {
    // Step in level at 1 s; PCEN output decays back with time constant T
    // regardless of hop. Measure when it falls to half its jump.
    let mut audio = sine(4000.0, 0.01, 1.0);
    audio.extend(sine(4000.0, 0.5, 2.0));
    let mut times = Vec::new();
    for hop in [64, 256, 1024] {
        let mut p = params(1024, hop, 1024, WindowKind::Hann, FreqScale::Mel { bands: 40, f_min: 0.0, f_max: 22050.0 });
        p.pcen = Some(Pcen { time_constant: 1.0, ..Pcen::default() });
        let out = Stft::new(p.clone()).unwrap().compute(&audio);
        let bins = p.out_bins();
        let row = p.bin_frequencies().iter().position(|&f| f > 4000.0).unwrap() - 1;
        let series: Vec<f32> = out.chunks(bins).map(|r| r[row]).collect();
        let f_step = (1.1 * SR as f64 / hop as f64) as usize;
        let peak_i = (f_step / 2..series.len()).max_by(|&a, &b| series[a].total_cmp(&series[b])).unwrap();
        let base = *series.last().unwrap();
        let half = base + (series[peak_i] - base) / 2.0;
        let t_half = (peak_i..series.len()).find(|&i| series[i] < half).unwrap();
        times.push(p.frame_time((t_half - peak_i) as u64));
    }
    let (lo, hi) = (times.iter().cloned().fold(f64::MAX, f64::min), times.iter().cloned().fold(0.0, f64::max));
    // Tolerance: two frames at the largest hop.
    assert!(hi - lo < 2.0 * 1024.0 / SR as f64, "decay times vary with hop: {times:?}");
}

#[test]
fn reassignment_sharpens_a_tone_and_keeps_level() {
    let f = 5123.0;
    let audio = sine(f, 1.0, 1.0);
    let base = params(1024, 256, 1024, WindowKind::Hann, FreqScale::Linear);
    let mut re = base.clone();
    re.reassign = true;
    let spread = |p: &StftParams| {
        let out = Stft::new(p.clone()).unwrap().compute(&audio);
        let bins = p.out_bins();
        let mid = out.len() / bins / 2;
        let row: Vec<f64> = out[mid * bins..(mid + 1) * bins].iter().map(|&d| 10f64.powf(d as f64 / 10.0)).collect();
        let total: f64 = row.iter().sum();
        let above = row.iter().filter(|&&v| v > total * 0.01).count();
        (above, 10.0 * total.log10())
    };
    let (n_plain, _) = spread(&base);
    let (n_re, total_re) = spread(&re);
    assert!(n_re < n_plain, "reassigned {n_re} bins vs plain {n_plain}");
    // Bilinear splat: a tone lands on at most two neighbouring bins.
    assert!(n_re <= 2, "{n_re}");
    // Summed power of a Hann-windowed sine = ENBW (1.5) × A² in our units.
    assert!((total_re - 10.0 * 1.5f64.log10()).abs() < 0.3, "{total_re}");
}

#[test]
fn silence_maps_to_floor_not_zero() {
    let p = params(512, 128, 512, WindowKind::Hann, FreqScale::Linear);
    let out = Stft::new(p).unwrap().compute(&vec![0f32; 4096]);
    assert!(out.iter().all(|&v| v == DB_FLOOR));
}

#[test]
fn display_stats_median_tracks_noise_floor() {
    let p = params(512, 128, 512, WindowKind::Hann, FreqScale::Linear);
    let mut s: u64 = 1;
    let noise: Vec<f32> = (0..SR as usize * 2).map(|_| { s = s.wrapping_mul(6364136223846793005).wrapping_add(1); ((s >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.002 }).collect();
    let out = Stft::new(p.clone()).unwrap().compute(&noise);
    let st = display_stats(&out, p.out_bins());
    assert!(st.median < -60.0 && st.median > -120.0, "{st:?}");
    assert!(st.p99_9 > st.median);
    assert_eq!(st.band_floor.len(), p.out_bins());
}

fn chirpy(secs: f64) -> Vec<f32> {
    (0..(secs * SR as f64) as usize).map(|i| {
        let t = i as f64 / SR as f64;
        let gate = if (t * 3.0).fract() < 0.4 { 0.4 } else { 0.002 };
        (gate * (2.0 * PI * (2000.0 * t + 1500.0 * t * t)).sin()) as f32
    }).collect()
}

/// Worker path: blocks computed independently must match the sequential run.
fn check_blocks(p: StftParams, tol_rel: f32) {
    let audio = chirpy(3.0);
    let e = Stft::new(p.clone()).unwrap();
    let whole = e.compute(&audio);
    let total = p.n_frames(audio.len() as u64);
    let warmup = e.pcen_warmup(1e-7);
    let bins = p.out_bins();
    let mut f0 = 0u64;
    let mut got = Vec::new();
    while f0 < total {
        let n = 301.min((total - f0) as usize);
        let (lo, hi) = e.block_frame_range(f0, n, total, warmup);
        let (start, len) = e.sample_range(lo, (hi - lo) as usize);
        // Hand over only the in-file part, as the JS coordinator does.
        let s0 = start.max(0) as usize;
        let s1 = ((start + len as i64).max(0) as usize).min(audio.len());
        got.extend(e.block_values(&audio[s0..s1.max(s0)], s0 as i64, f0, n, total, warmup));
        f0 += n as u64;
    }
    assert_eq!(got.len(), whole.len());
    let mut worst = 0f32;
    for (i, (a, b)) in got.iter().zip(&whole).enumerate() {
        let err = (a - b).abs() / b.abs().max(1.0);
        if err > worst { worst = err; }
        assert!(err <= tol_rel, "frame {} bin {}: {a} vs {b}", i / bins, i % bins);
    }
    println!("{:?} worst rel err {worst:.2e}", p.scale);
}

#[test]
fn independent_blocks_match_sequential_db() {
    check_blocks(params(512, 128, 1024, WindowKind::Hann, FreqScale::Linear), 1e-4);
}

#[test]
fn independent_blocks_match_sequential_pcen() {
    let mut p = params(1024, 256, 2048, WindowKind::Hann, FreqScale::Mel { bands: 96, f_min: 300.0, f_max: 16000.0 });
    p.pcen = Some(Pcen::default());
    check_blocks(p, 1e-3);
}

#[test]
fn independent_blocks_match_sequential_reassigned() {
    let mut p = params(512, 64, 1024, WindowKind::Hann, FreqScale::Linear);
    p.reassign = true;
    check_blocks(p, 1e-4);
}

#[test]
fn reassigned_energy_survives_block_boundaries() {
    // Same signal, tiny blocks vs one block: identical when margins work.
    let mut p = params(512, 64, 1024, WindowKind::Hann, FreqScale::Linear);
    p.reassign = true;
    let audio = chirpy(1.0);
    let e = Stft::new(p).unwrap();
    let whole = e.compute(&audio);
    let mut parts = Vec::new();
    e.run(&mut aw_dsp::MemSource(&audio), 7, |_, v| { parts.extend_from_slice(v); Ok(()) }).unwrap();
    for (a, b) in whole.iter().zip(&parts) { assert!((a - b).abs() <= 1e-3 * a.abs().max(1.0), "{a} vs {b}"); }
}

#[test]
fn pcen_start_matches_steady_state() {
    // Stationary noise: the opening frames must look like the settled
    // noise later on (first-frame initialisation makes them brighter).
    let mut s: u64 = 7;
    let audio: Vec<f32> = (0..SR as usize * 3).map(|_| { s = s.wrapping_mul(6364136223846793005).wrapping_add(1); ((s >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 1e-2 }).collect();
    let mut p = params(1024, 256, 1024, WindowKind::Hann, FreqScale::Mel { bands: 64, f_min: 300.0, f_max: 16000.0 });
    p.pcen = Some(Pcen::default());
    let out = Stft::new(p.clone()).unwrap().compute(&audio);
    let bins = p.out_bins();
    let mean = |a: usize, b: usize| out[a * bins..b * bins].iter().sum::<f32>() / ((b - a) * bins) as f32;
    let fps = SR as usize / 256;
    let (start, steady) = (mean(2, 2 + fps / 4), mean(2 * fps, 2 * fps + fps / 4));
    assert!((start / steady - 1.0).abs() < 0.25, "start {start} vs steady {steady}");
}

#[test]
fn v2_pyramid_roundtrip() {
    use aw_dsp::pyramid::{build_pyramid_v2, Pyramid, FORMAT_VERSION_V2};
    let audio = chirpy(30.0);
    let p = params(512, 128, 1024, WindowKind::Hann, FreqScale::Linear);
    let dir = tempfile::tempdir().unwrap();
    let meta = build_pyramid_v2(&mut aw_dsp::MemSource(&audio), p.clone(), dir.path(), |_| true).unwrap();
    assert_eq!(meta.version, FORMAT_VERSION_V2);
    assert_eq!(meta.levels[0].n_frames, p.n_frames(audio.len() as u64));
    assert!(meta.stats.median < meta.stats.p99_9);
    let pyr = Pyramid::<StftParams>::open_as(dir.path()).unwrap().unwrap();
    let direct = Stft::new(p).unwrap().compute(&audio);
    let l0 = pyr.read(0, 0, meta.levels[0].n_frames).unwrap();
    for (a, b) in l0.iter().zip(&direct) { assert!((a - b).abs() <= 0.1 + 1e-3 * b.abs(), "{a} vs {b}"); }
    // A v1 reader must not accept a v2 store.
    assert!(Pyramid::<aw_dsp::SpecParams>::open_as(dir.path()).unwrap().is_none());
}

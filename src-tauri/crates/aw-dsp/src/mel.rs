// Mel filterbank — mirrors createMelFilterbank / createSparseMelFilterbank in dsp.ts.

pub struct SparseBand { pub start: usize, pub weights: Vec<f32> }

pub fn hz_to_mel(hz: f64) -> f64 { 2595.0 * (1.0 + hz / 700.0).log10() }
pub fn mel_to_hz(mel: f64) -> f64 { 700.0 * (10f64.powf(mel / 2595.0) - 1.0) }

pub fn mel_filterbank(sr: f64, fft_size: usize, n_mels: usize, f_min: f64, f_max: f64) -> Vec<Vec<f32>> {
    let n_bins = fft_size / 2;
    let (m0, m1) = (hz_to_mel(f_min), hz_to_mel(f_max));
    let bin_points: Vec<i64> = (0..n_mels + 2)
        .map(|i| m0 + (i as f64 / (n_mels + 1) as f64) * (m1 - m0))
        .map(|m| ((fft_size + 1) as f64 * mel_to_hz(m) / sr).floor() as i64)
        .collect();
    let clampb = |b: i64| b.clamp(0, n_bins as i64 - 1) as usize;

    (1..=n_mels).map(|m| {
        let mut f = vec![0f32; n_bins];
        let (l, c, r) = (clampb(bin_points[m - 1]), clampb(bin_points[m]), clampb(bin_points[m + 1]));
        let dl = if c > l { (c - l) as f32 } else { 1.0 };
        let dr = if r > c { (r - c) as f32 } else { 1.0 };
        for k in l..c { f[k] = (k - l) as f32 / dl; }
        for k in c..r { f[k] = (r - k) as f32 / dr; }
        let mut sum: f32 = f.iter().sum();
        if sum == 0.0 { f[c] = 1.0; sum = 1.0; }
        for v in &mut f { *v /= sum; }
        f
    }).collect()
}

pub fn sparse_mel_filterbank(sr: f64, fft_size: usize, n_mels: usize, f_min: f64, f_max: f64) -> Vec<SparseBand> {
    mel_filterbank(sr, fft_size, n_mels, f_min, f_max).into_iter().map(|f| {
        let start = f.iter().position(|&v| v != 0.0).unwrap_or(0);
        let end = f.iter().rposition(|&v| v != 0.0).map_or(start, |e| e + 1);
        SparseBand { start, weights: f[start..end].to_vec() }
    }).collect()
}

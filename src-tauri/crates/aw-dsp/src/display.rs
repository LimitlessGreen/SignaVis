// ═══════════════════════════════════════════════════════════════════════
// display.rs — image-domain post-processing for the spectrogram view
//
// Runs on the display image (after time/frequency resampling), not on the
// STFT output, so it lives apart from the DSP core in v2.rs.
// ═══════════════════════════════════════════════════════════════════════

/// Subtracts the per-band noise floor (dB) from row-major [frame][bin] values.
/// No half-wave rectification: values below the floor stay negative, so the
/// display window can still reach below the noise floor.
pub fn subtract_band_floor(values: &mut [f32], bins: usize, floor: &[f32]) {
    if bins == 0 || floor.len() != bins { return; }
    for frame in values.chunks_exact_mut(bins) {
        for (v, f) in frame.iter_mut().zip(floor) { *v -= f; }
    }
}

/// Contrast Limited Adaptive Histogram Equalisation, in place, on a
/// row-major `width × height` image with values in [0, 1].
///
/// Each of `tiles_x × tiles_y` tiles gets a clipped-histogram CDF; pixels
/// interpolate bilinearly between the CDFs of the surrounding tile centres.
/// Pixels outside the outermost centres use the nearest tile (weights are
/// clamped to [0, 1], no extrapolation).
pub fn clahe(gray: &mut [f32], width: usize, height: usize, tiles_x: usize, tiles_y: usize, clip_limit: f32) {
    const N: usize = 256;
    let tx_n = tiles_x.min(width);
    let ty_n = tiles_y.min(height);
    if tx_n == 0 || ty_n == 0 || gray.len() != width * height { return; }
    let tile_w = width as f32 / tx_n as f32;
    let tile_h = height as f32 / ty_n as f32;
    let bin_of = |v: f32| ((v.clamp(0.0, 1.0) * (N - 1) as f32) as usize).min(N - 1);

    let mut cdfs = vec![[0f32; N]; tx_n * ty_n];
    for ty in 0..ty_n {
        let (y0, y1) = ((ty as f32 * tile_h) as usize, (((ty + 1) as f32 * tile_h) as usize).min(height));
        for tx in 0..tx_n {
            let (x0, x1) = ((tx as f32 * tile_w) as usize, (((tx + 1) as f32 * tile_w) as usize).min(width));
            let n_px = (x1 - x0) * (y1 - y0);
            if n_px == 0 { continue; }
            let mut hist = [0f32; N];
            for y in y0..y1 {
                for &v in &gray[y * width + x0..y * width + x1] { hist[bin_of(v)] += 1.0; }
            }
            let limit = (clip_limit * n_px as f32 / N as f32).floor().max(1.0);
            let mut excess = 0.0;
            for h in hist.iter_mut() {
                if *h > limit { excess += *h - limit; *h = limit; }
            }
            let per_bin = excess / N as f32;
            let cdf = &mut cdfs[ty * tx_n + tx];
            let mut acc = 0.0;
            for (c, h) in cdf.iter_mut().zip(hist) { acc += h + per_bin; *c = acc; }
            let (lo, range) = (cdf[0], (cdf[N - 1] - cdf[0]).max(1.0));
            for c in cdf.iter_mut() { *c = (*c - lo) / range; }
        }
    }

    // Tile index and weight of the next tile for a pixel coordinate.
    let axis = |p: usize, size: f32, n: usize| {
        let f = (p as f32 + 0.5) / size - 0.5;
        let i0 = (f.floor().max(0.0) as usize).min(n - 1);
        let i1 = (i0 + 1).min(n - 1);
        (i0, i1, (f - i0 as f32).clamp(0.0, 1.0))
    };
    for y in 0..height {
        let (ty0, ty1, fy) = axis(y, tile_h, ty_n);
        for x in 0..width {
            let (tx0, tx1, fx) = axis(x, tile_w, tx_n);
            let b = bin_of(gray[y * width + x]);
            let c = |ty: usize, tx: usize| cdfs[ty * tx_n + tx][b];
            let top = c(ty0, tx0) + (c(ty0, tx1) - c(ty0, tx0)) * fx;
            let bot = c(ty1, tx0) + (c(ty1, tx1) - c(ty1, tx0)) * fx;
            gray[y * width + x] = top + (bot - top) * fy;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_floor_is_subtracted_per_bin() {
        let mut v = vec![-60.0, -40.0, -50.0, -30.0];
        subtract_band_floor(&mut v, 2, &[-60.0, -40.0]);
        assert_eq!(v, vec![0.0, 0.0, 10.0, 10.0]);
    }

    #[test]
    fn clahe_stays_in_range_and_keeps_order() {
        let (w, h) = (64, 32);
        let mut img: Vec<f32> = (0..w * h).map(|i| (i % w) as f32 / (w - 1) as f32 * 0.5).collect();
        clahe(&mut img, w, h, 8, 4, 2.5);
        assert!(img.iter().all(|v| (0.0..=1.0).contains(v)));
        // A horizontal ramp stays monotonic within each row.
        for row in img.chunks(w) {
            assert!(row.windows(2).all(|p| p[1] >= p[0] - 1e-6));
        }
    }

    #[test]
    fn clahe_without_clipping_is_histogram_equalisation() {
        // One tile and a high clip limit: low-contrast input is stretched to [0, 1].
        let (w, h) = (64, 8);
        let mut img: Vec<f32> = (0..w * h).map(|i| 0.4 + (i % w) as f32 / (w - 1) as f32 * 0.2).collect();
        clahe(&mut img, w, h, 1, 1, 1000.0);
        let (lo, hi) = img.iter().fold((1f32, 0f32), |(a, b), &v| (a.min(v), b.max(v)));
        assert!(lo < 0.05 && hi > 0.99, "lo {lo} hi {hi}");
    }

    #[test]
    fn clahe_edges_do_not_extrapolate() {
        // Constant image: every pixel must map to the same value, including
        // the borders outside the outermost tile centres.
        let (w, h) = (40, 20);
        let mut img = vec![0.3f32; w * h];
        clahe(&mut img, w, h, 8, 4, 2.5);
        let first = img[0];
        assert!(img.iter().all(|v| (v - first).abs() < 1e-5));
    }
}

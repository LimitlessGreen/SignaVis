// ═══════════════════════════════════════════════════════════════════════
// detector — bat-detector listening modes, as known from field work
//
//   heterodyne:          mix with a carrier, keep |f − carrier| below a few
//                        kHz (calls on both sides of the carrier fold
//                        together, as on a real heterodyne detector)
//   frequency_division:  count zero crossings of the high-passed signal and
//                        toggle a square wave every `divisor` crossings → f/n
//   pitch_shift:         phase vocoder, every frequency ÷ factor, tempo kept
//
// Both run in real time (output duration = input duration) and return mono
// audio at `output_rate(sample_rate)`, ≈ 48 kHz by integer decimation.
// ═══════════════════════════════════════════════════════════════════════

use std::f32::consts::PI;

use realfft::RealFftPlanner;
use realfft::num_complex::Complex;

const TARGET_RATE: f32 = 48_000.0;
/// Audible band kept after frequency division (square-wave harmonics above alias).
const DIVISION_CUTOFF_HZ: f32 = 16_000.0;
/// Square-wave level of the frequency divider.
const DIVISION_LEVEL: f32 = 0.3;

/// Integer decimation factor from `sample_rate` to ≈ 48 kHz.
pub fn decimation(sample_rate: f32) -> usize {
    ((sample_rate / TARGET_RATE).round() as usize).max(1)
}

/// Sample rate of what the detector functions return.
pub fn output_rate(sample_rate: f32) -> f32 {
    sample_rate / decimation(sample_rate) as f32
}

/// Heterodyne detector: `samples` mixed with `carrier_hz`, low-passed at
/// `bandwidth_hz` and decimated to `output_rate(sample_rate)`. `first_sample`
/// is the recording index of `samples[0]`, so successive chunks join without
/// a carrier phase jump.
pub fn heterodyne(samples: &[f32], sample_rate: f32, first_sample: f64, carrier_hz: f32, bandwidth_hz: f32) -> Vec<f32> {
    let cycles_per_sample = carrier_hz as f64 / sample_rate as f64;
    let mixed: Vec<f32> = samples
        .iter()
        .enumerate()
        .map(|(i, &x)| {
            let cycles = ((first_sample + i as f64) * cycles_per_sample).fract();
            2.0 * x * ((2.0 * std::f64::consts::PI * cycles).cos() as f32)
        })
        .collect();
    let out_rate = output_rate(sample_rate);
    let cutoff = bandwidth_hz.clamp(500.0, 0.45 * out_rate);
    decimate(&mixed, sample_rate, cutoff, decimation(sample_rate))
}

/// Background level for `frequency_division`: median |x| after the front-end
/// high-pass. Calls are sparse, so over a whole recording this is the noise
/// floor; pass a sample of the recording, not just the stretch being played.
pub fn division_noise_level(samples: &[f32], sample_rate: f32, highpass_hz: f32) -> f32 {
    median_abs(&highpass(samples, sample_rate, highpass_hz))
}

/// Frequency-division detector. Crossings only count while the high-passed
/// signal swings beyond a noise threshold (hysteresis), so background noise
/// stays silent as on a real divider. `noise_level` comes from
/// `division_noise_level` (≤ 0: estimate from `samples`). `keep_envelope`
/// scales the square wave with the call's amplitude envelope (some detectors
/// do this).
pub fn frequency_division(
    samples: &[f32],
    sample_rate: f32,
    divisor: u32,
    highpass_hz: f32,
    noise_level: f32,
    keep_envelope: bool,
) -> Vec<f32> {
    let hp = highpass(samples, sample_rate, highpass_hz);
    let noise = if noise_level > 0.0 { noise_level } else { median_abs(&hp) };
    // ≈ 4σ of Gaussian background noise (median |x| ≈ 0.67σ).
    let threshold = 6.0 * noise.max(1e-6);

    // Envelope: instant attack, ~2 ms release.
    let release = (-1.0 / (0.002 * sample_rate)).exp();
    let peak = hp.iter().fold(0.0f32, |m, &v| m.max(v.abs())).max(threshold);

    let divisor = divisor.max(1);
    let mut out = Vec::with_capacity(hp.len());
    let mut positive = true;
    let mut crossings = 0u32;
    let mut level = DIVISION_LEVEL;
    let mut env = 0.0f32;
    for &v in &hp {
        let a = v.abs();
        env = if a > env { a } else { env * release };

        if positive && v < -threshold {
            positive = false;
            crossings += 1;
        } else if !positive && v > threshold {
            positive = true;
            crossings += 1;
        }
        if crossings >= divisor {
            crossings = 0;
            level = -level;
        }

        let active = env > threshold;
        let gain = if !active { 0.0 } else if keep_envelope { (env / peak).min(1.0) } else { 1.0 };
        out.push(level * gain);
    }
    let out_rate = output_rate(sample_rate);
    decimate(&out, sample_rate, DIVISION_CUTOFF_HZ.min(0.45 * out_rate), decimation(sample_rate))
}

/// Output frame length of the pitch shifter at `output_rate`; the input frame
/// is `decimation` times longer, so input and output bins are equally wide
/// and input bin k lands on output bin k / factor.
const PITCH_OUT_FRAME: usize = 256;
/// Frames overlap 4×: hop = frame / 4.
const PITCH_OVERLAP: usize = 4;

/// Phase-vocoder pitch shift down by `factor` with the tempo kept: sound at
/// f plays at f / factor in real time. Synthesises straight at
/// `output_rate(sample_rate)`, so a ÷10 shift of a 384 kHz recording costs a
/// 2048-point FFT in and a 256-point FFT out per hop. Calls shorter than a
/// frame (~5 ms) are smeared a little in time; time expansion keeps them exact.
pub fn pitch_shift(samples: &[f32], sample_rate: f32, factor: f32) -> Vec<f32> {
    let dec = decimation(sample_rate);
    let n_out = PITCH_OUT_FRAME;
    let n_in = n_out * dec;
    let hop_out = n_out / PITCH_OVERLAP;
    let hop_in = hop_out * dec;
    let factor = factor.max(1.0);

    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(n_in);
    let inv = planner.plan_fft_inverse(n_out);
    let win_in = hann(n_in);
    let win_out = hann(n_out);

    let bins_in = n_in / 2 + 1;
    let bins_out = n_out / 2 + 1;
    let expected = 2.0 * std::f64::consts::PI * hop_in as f64 / n_in as f64; // phase advance per bin and hop
    let mut last_phase = vec![0.0f32; bins_in];
    let mut sum_phase = vec![0.0f64; bins_out];
    let mut out_mag = vec![0.0f32; bins_out];
    let mut out_freq = vec![0.0f32; bins_out];

    let mut frame = fwd.make_input_vec();
    let mut spec = fwd.make_output_vec();
    let mut out_spec = inv.make_input_vec();
    let mut out_frame = inv.make_output_vec();

    let len_out = samples.len().div_ceil(dec);
    let mut y = vec![0.0f32; len_out + n_out];
    // Hann analysis peak = A·n_in/4; real inverse FFT doubles a bin; Hann OLA at 4× sums to 2.
    let scale = 1.0 / (n_in as f32 / 4.0) / 2.0 / 2.0;

    // Frames centred on output samples: frame m covers input [m·hop_in − n_in/2, +n_in).
    let n_frames = len_out.div_ceil(hop_out) + 1;
    for m in 0..n_frames {
        let start = (m * hop_in) as isize - (n_in / 2) as isize;
        for (i, v) in frame.iter_mut().enumerate() {
            let idx = start + i as isize;
            let x = if idx >= 0 && (idx as usize) < samples.len() { samples[idx as usize] } else { 0.0 };
            *v = x * win_in[i];
        }
        if fwd.process(&mut frame, &mut spec).is_err() {
            continue;
        }

        out_mag.iter_mut().for_each(|v| *v = 0.0);
        for (k, c) in spec.iter().enumerate() {
            let mag = c.norm();
            let phase = c.arg();
            let mut delta = (phase - last_phase[k]) as f64 - k as f64 * expected;
            last_phase[k] = phase;
            delta -= 2.0 * std::f64::consts::PI * (delta / (2.0 * std::f64::consts::PI)).round();
            // True frequency in bins (input and output bins are equally wide).
            let true_bin = k as f64 + delta / expected;
            let target = true_bin / factor as f64;
            let j = target.round();
            if j < 0.0 || j as usize >= bins_out - 1 {
                continue;
            }
            let j = j as usize;
            // Strongest contributor wins: keeps a tone's level, quiets folded noise.
            if mag > out_mag[j] {
                out_mag[j] = mag;
                out_freq[j] = target as f32;
            }
        }

        let advance = 2.0 * std::f64::consts::PI * hop_out as f64 / n_out as f64;
        for j in 0..bins_out {
            sum_phase[j] += out_freq[j] as f64 * advance;
            sum_phase[j] %= 2.0 * std::f64::consts::PI;
            out_spec[j] = if out_mag[j] > 0.0 && j > 0 && j < bins_out - 1 {
                Complex::from_polar(out_mag[j] * scale, sum_phase[j] as f32)
            } else {
                Complex::new(0.0, 0.0)
            };
        }
        if inv.process(&mut out_spec, &mut out_frame).is_err() {
            continue;
        }
        let at = (m * hop_out) as isize - (n_out / 2) as isize;
        for (i, &v) in out_frame.iter().enumerate() {
            let idx = at + i as isize;
            if idx >= 0 && (idx as usize) < y.len() {
                y[idx as usize] += v * win_out[i];
            }
        }
    }
    y.truncate(len_out);
    y
}

fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / n as f32).cos()).collect()
}

// ── Filters ──────────────────────────────────────────────────────────

/// Blackman-windowed-sinc low-pass, then keep every `factor`-th sample.
fn decimate(x: &[f32], sample_rate: f32, cutoff_hz: f32, factor: usize) -> Vec<f32> {
    let out_nyquist = 0.5 * sample_rate / factor as f32;
    let transition = (out_nyquist - cutoff_hz).max(0.05 * out_nyquist);
    let taps = (((5.5 * sample_rate / transition) as usize) | 1).clamp(31, 2047);
    let h = lowpass_taps(sample_rate, cutoff_hz, taps);
    let mid = taps / 2;

    let n_out = x.len().div_ceil(factor);
    let mut y = Vec::with_capacity(n_out);
    for k in 0..n_out {
        let centre = k * factor;
        let mut acc = 0.0f32;
        for (j, &c) in h.iter().enumerate() {
            let idx = centre as isize + j as isize - mid as isize;
            if idx >= 0 && (idx as usize) < x.len() {
                acc += c * x[idx as usize];
            }
        }
        y.push(acc);
    }
    y
}

fn lowpass_taps(sample_rate: f32, cutoff_hz: f32, taps: usize) -> Vec<f32> {
    let fc = cutoff_hz / sample_rate;
    let m = (taps - 1) as f32;
    let mut h: Vec<f32> = (0..taps)
        .map(|i| {
            let t = i as f32 - m / 2.0;
            let sinc = if t == 0.0 { 2.0 * fc } else { (2.0 * PI * fc * t).sin() / (PI * t) };
            let w = 0.42 - 0.5 * (2.0 * PI * i as f32 / m).cos() + 0.08 * (4.0 * PI * i as f32 / m).cos();
            sinc * w
        })
        .collect();
    let sum: f32 = h.iter().sum();
    for c in &mut h {
        *c /= sum;
    }
    h
}

/// 4th-order Butterworth high-pass (two identical biquads, Q = 1/√2 each is
/// close enough for a detector front end).
fn highpass(x: &[f32], sample_rate: f32, cutoff_hz: f32) -> Vec<f32> {
    let w0 = 2.0 * PI * cutoff_hz.min(0.45 * sample_rate) / sample_rate;
    let alpha = w0.sin() / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
    let cos = w0.cos();
    let a0 = 1.0 + alpha;
    let b = [(1.0 + cos) / 2.0 / a0, -(1.0 + cos) / a0, (1.0 + cos) / 2.0 / a0];
    let a = [-2.0 * cos / a0, (1.0 - alpha) / a0];

    let mut y = x.to_vec();
    for _ in 0..2 {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for v in &mut y {
            let x0 = *v;
            let y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
            *v = y0;
        }
    }
    y
}

/// Median of |x| over a subsample: the noise level for the divider threshold.
fn median_abs(x: &[f32]) -> f32 {
    let stride = (x.len() / 50_000).max(1);
    let mut v: Vec<f32> = x.iter().step_by(stride).map(|s| s.abs()).collect();
    if v.is_empty() {
        return 0.0;
    }
    let mid = v.len() / 2;
    *v.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 384_000.0;

    fn tone(freq: f32, seconds: f32, amp: f32) -> Vec<f32> {
        (0..(SR * seconds) as usize).map(|i| amp * (2.0 * PI * freq * i as f32 / SR).sin()).collect()
    }

    /// Dominant frequency from the zero-crossing rate of the middle half.
    fn zc_freq(y: &[f32], rate: f32) -> f32 {
        let s = &y[y.len() / 4..3 * y.len() / 4];
        let n = s.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        n as f32 / 2.0 / (s.len() as f32 / rate)
    }

    fn rms(y: &[f32]) -> f32 {
        (y.iter().map(|v| v * v).sum::<f32>() / y.len() as f32).sqrt()
    }

    #[test]
    fn output_rate_is_near_48k() {
        assert_eq!(output_rate(384_000.0), 48_000.0);
        assert_eq!(output_rate(250_000.0), 50_000.0);
        assert_eq!(output_rate(44_100.0), 44_100.0);
    }

    #[test]
    fn heterodyne_gives_difference_frequency() {
        let y = heterodyne(&tone(45_000.0, 0.2, 0.5), SR, 0.0, 40_000.0, 8_000.0);
        assert_eq!(y.len(), (0.2 * 48_000.0) as usize);
        let f = zc_freq(&y, 48_000.0);
        assert!((f - 5_000.0).abs() < 100.0, "got {f}");
        assert!(rms(&y) > 0.2, "level {}", rms(&y));
    }

    #[test]
    fn heterodyne_rejects_calls_far_from_carrier() {
        let y = heterodyne(&tone(80_000.0, 0.2, 0.5), SR, 0.0, 40_000.0, 8_000.0);
        assert!(rms(&y) < 0.01, "leak {}", rms(&y));
    }

    /// Uniform white noise from a fixed LCG.
    fn noise(n: usize, amp: f32) -> Vec<f32> {
        let mut seed = 1u32;
        (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                amp * ((seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0)
            })
            .collect()
    }

    #[test]
    fn pitch_shift_divides_frequency_and_keeps_level_and_time() {
        let y = pitch_shift(&tone(45_000.0, 0.3, 0.5), SR, 10.0);
        assert_eq!(y.len(), (0.3 * 48_000.0) as usize);
        let f = zc_freq(&y, 48_000.0);
        assert!((f - 4_500.0).abs() < 50.0, "got {f}");
        let mid = &y[y.len() / 4..3 * y.len() / 4];
        let level = rms(mid) * std::f32::consts::SQRT_2;
        assert!((level - 0.5).abs() < 0.1, "amplitude {level}");
    }

    #[test]
    fn pitch_shift_keeps_a_short_call_in_place() {
        // 4 ms call at 100–104 ms in silence: output energy stays around there.
        let mut x = vec![0.0f32; (SR * 0.2) as usize];
        for i in (SR * 0.1) as usize..(SR * 0.104) as usize {
            x[i] = 0.5 * (2.0 * PI * 45_000.0 * i as f32 / SR).sin();
        }
        let y = pitch_shift(&x, SR, 10.0);
        let energy = |a: f32, b: f32| y[(a * 48_000.0) as usize..(b * 48_000.0) as usize].iter().map(|v| v * v).sum::<f32>();
        let near = energy(0.094, 0.110);
        let total = energy(0.0, 0.2);
        assert!(near > 0.9 * total, "call smeared: {near} of {total}");
    }

    #[test]
    fn division_divides_frequency() {
        // 20 ms calls every 100 ms over faint noise, like a bat pass.
        let n = (SR * 0.5) as usize;
        let mut x = noise(n, 0.002);
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f32 / SR;
            if t % 0.1 < 0.02 {
                *v += 0.5 * (2.0 * PI * 45_000.0 * t).sin();
            }
        }
        let y = frequency_division(&x, SR, 10, 15_000.0, 0.0, false);
        // inside the second call: 100..120 ms, skip the edges
        let call = &y[(0.103 * 48_000.0) as usize..(0.117 * 48_000.0) as usize];
        let f = zc_freq(call, 48_000.0);
        assert!((f - 4_500.0).abs() < 200.0, "got {f}");
        // between calls: silent
        let gap = &y[(0.13 * 48_000.0) as usize..(0.19 * 48_000.0) as usize];
        assert!(rms(gap) < 0.01, "gap {}", rms(gap));
    }

    #[test]
    fn division_plays_a_call_only_stretch_with_a_global_noise_level() {
        // A label box around one call: the stretch itself has no quiet part.
        let n = (SR * 0.5) as usize;
        let mut x = noise(n, 0.002);
        let level = division_noise_level(&x, SR, 15_000.0);
        let call: Vec<f32> = (0..(SR * 0.02) as usize)
            .map(|i| x[i] + 0.5 * (2.0 * PI * 45_000.0 * i as f32 / SR).sin())
            .collect();
        x.truncate(0);
        let y = frequency_division(&call, SR, 10, 15_000.0, level, false);
        let f = zc_freq(&y, 48_000.0);
        assert!((f - 4_500.0).abs() < 300.0, "got {f}");
    }

    #[test]
    fn division_is_silent_on_noise() {
        let y = frequency_division(&noise((SR * 0.2) as usize, 0.01), SR, 10, 15_000.0, 0.0, false);
        assert!(rms(&y) < 0.02, "noise passes: {}", rms(&y));
    }
}

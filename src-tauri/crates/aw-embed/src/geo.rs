//! Geomodel trunk for range maps (see scripts/geo_trunk.py): the trunk maps
//! (lat, lon, week) to a hidden vector; the output layer of one species is
//! applied here, so a grid of thousands of points costs one trunk run each.

use crate::Error;
use std::path::Path;

/// Output layer: `w` is n x d row-major, score of row r = sigmoid(w[r] . h + b[r]).
pub struct Head {
    pub n: usize,
    pub d: usize,
    pub w: Vec<f32>,
    pub b: Vec<f32>,
}

impl Head {
    /// `head.bin`: n*d FP16 weights (little endian), then n FP32 biases.
    pub fn from_bin(bytes: &[u8], n: usize, d: usize) -> Result<Self, Error> {
        let need = n * d * 2 + n * 4;
        if bytes.len() != need {
            return Err(format!("head.bin: {} bytes, expected {need}", bytes.len()).into());
        }
        let w = bytes[..n * d * 2].chunks_exact(2).map(|c| f16_to_f32(u16::from_le_bytes([c[0], c[1]]))).collect();
        let b = bytes[n * d * 2..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        Ok(Self { n, d, w, b })
    }

    /// Score per hidden vector (`hidden`: k x d): max over `rows` of the sigmoid.
    pub fn scores(&self, hidden: &[f32], rows: &[usize]) -> Vec<f32> {
        hidden
            .chunks_exact(self.d)
            .map(|h| {
                rows.iter()
                    .map(|&r| {
                        let w = &self.w[r * self.d..(r + 1) * self.d];
                        let a = self.b[r] + w.iter().zip(h).map(|(x, y)| x * y).sum::<f32>();
                        1.0 / (1.0 + (-a).exp())
                    })
                    .fold(0.0f32, f32::max)
            })
            .collect()
    }
}

/// IEEE 754 half -> f32.
pub fn f16_to_f32(h: u16) -> f32 {
    let s = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let e = ((h >> 10) & 0x1f) as i32;
    let f = (h & 0x3ff) as f32;
    match e {
        0 => s * f / 1024.0 * 2f32.powi(-14),
        31 => if f == 0.0 { s * f32::INFINITY } else { f32::NAN },
        _ => s * (1.0 + f / 1024.0) * 2f32.powi(e - 15),
    }
}

/// Grid points (lat, lon, week) row-major: `lats` rows (north first), `cols` columns west -> east
/// (cell centres), longitudes wrapped to [-180, 180).
pub fn grid_points(lats: &[f32], west: f32, east: f32, cols: usize, week: f32) -> Vec<f32> {
    let d_lon = (east - west) / cols as f32;
    let mut x = Vec::with_capacity(lats.len() * cols * 3);
    for &lat in lats {
        for c in 0..cols {
            let lon = (west + (c as f32 + 0.5) * d_lon + 180.0).rem_euclid(360.0) - 180.0;
            x.extend_from_slice(&[lat, lon, week]);
        }
    }
    x
}

pub struct GeoTrunk {
    session: ort::session::Session,
    input: String,
    output: String,
    pub ep: &'static str,
}

impl GeoTrunk {
    /// `ep`: "cpu", "directml" or "cuda" (feature must be on).
    pub fn new(model: impl AsRef<Path>, threads: usize, ep: &'static str, input: &str, output: &str) -> Result<Self, Error> {
        use ort::execution_providers as eps;
        let mut b = ort::session::Session::builder()?.with_intra_threads(threads)?;
        let list: Vec<eps::ExecutionProviderDispatch> = match ep {
            #[cfg(feature = "directml")]
            "directml" => vec![eps::DirectMLExecutionProvider::default().build().error_on_failure()],
            #[cfg(feature = "cuda")]
            "cuda" => vec![eps::CUDAExecutionProvider::default().build().error_on_failure()],
            "cpu" => vec![],
            other => return Err(format!("execution provider not available: {other}").into()),
        };
        if !list.is_empty() {
            b = b.with_execution_providers(list)?;
        }
        let session = b.commit_from_file(model)?;
        Ok(Self { session, input: input.into(), output: output.into(), ep })
    }

    /// Hidden vectors for `x` (k x 3), in batches of `batch` points.
    pub fn hidden(&mut self, x: &[f32], batch: usize) -> Result<Vec<f32>, Error> {
        let mut out = Vec::new();
        for chunk in x.chunks(batch * 3) {
            let k = chunk.len() / 3;
            let t = ort::value::Tensor::from_array(([k, 3], chunk.to_vec().into_boxed_slice()))?;
            let res = self.session.run(ort::inputs![self.input.as_str() => t])?;
            let (_, h) = res[self.output.as_str()].try_extract_tensor::<f32>()?;
            out.extend_from_slice(h);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats() {
        assert_eq!(f16_to_f32(0x3c00), 1.0);
        assert_eq!(f16_to_f32(0xc000), -2.0);
        assert_eq!(f16_to_f32(0x0000), 0.0);
        assert!((f16_to_f32(0x3555) - 0.33325).abs() < 1e-4);
        assert!(f16_to_f32(0x7c01).is_nan());
    }

    #[test]
    fn head_scores_take_the_max_over_rows() {
        // n = 2 rows, d = 2: row 0 = (1, 0), b 0; row 1 = (0, 1), b 0
        let mut bytes = Vec::new();
        for v in [0x3c00u16, 0, 0, 0x3c00] { bytes.extend_from_slice(&v.to_le_bytes()); }
        for b in [0f32, 0.0] { bytes.extend_from_slice(&b.to_le_bytes()); }
        let head = Head::from_bin(&bytes, 2, 2).unwrap();
        let s = head.scores(&[2.0, -1.0, 0.0, 0.0], &[0, 1]);
        assert!((s[0] - 1.0 / (1.0 + (-2f32).exp())).abs() < 1e-6);
        assert!((s[1] - 0.5).abs() < 1e-6);
        assert_eq!(head.scores(&[2.0, -1.0], &[1])[0], 1.0 / (1.0 + 1f32.exp()));
        assert!(Head::from_bin(&bytes[1..], 2, 2).is_err());
    }

    #[test]
    fn grid_wraps_longitude_and_uses_cell_centres() {
        let x = grid_points(&[50.0], 170.0, 190.0, 2, 20.0);
        assert_eq!(x.len(), 6);
        assert!((x[1] - 175.0).abs() < 1e-4);
        assert!((x[4] + 175.0).abs() < 1e-4);
        assert_eq!(x[2], 20.0);
    }
}

/// Against the full geomodel (onnxruntime, Python): needs the split trunk,
/// `GEO_TRUNK_DIR=models/geo-trunk-v3.0 cargo test --lib geo -- --ignored --nocapture`.
#[cfg(test)]
mod model_tests {
    use super::*;

    #[test]
    #[ignore]
    fn trunk_and_head_match_the_full_model() {
        let dir = std::path::PathBuf::from(std::env::var("GEO_TRUNK_DIR").expect("GEO_TRUNK_DIR"));
        let meta: serde_like::Head = serde_like::read(&dir.join("head.json"));
        let head = Head::from_bin(&std::fs::read(dir.join("head.bin")).unwrap(), meta.n, meta.d).unwrap();
        let mut t = GeoTrunk::new(dir.join("trunk.onnx"), 4, "cpu", "input", &meta.hidden).unwrap();
        // Cuckoo = geo label 2760; reference: full model V3.0.4 10K FP16 BNL on onnxruntime 1.23.2.
        let rows: Vec<usize> = meta.rows.iter().map(|r| r[2760]).collect();
        let x = [51.34, 12.37, 20.0, 51.34, 12.37, 2.0, -1.0, 30.0, 4.0, 40.0, -100.0, 20.0];
        let s = head.scores(&t.hidden(&x, 64).unwrap(), &rows);
        for (got, want) in s.iter().zip([0.9437f32, 0.0025, 0.1809, 0.0]) {
            assert!((got - want).abs() < 0.002, "{got} vs {want}");
        }
        // Timing: 4,500 grid points (Europe), as the range map.
        let lats: Vec<f32> = (0..60).map(|i| 65.0 - i as f32 * 0.5).collect();
        let x = grid_points(&lats, -10.0, 40.0, 75, 20.0);
        let t0 = std::time::Instant::now();
        let h = t.hidden(&x, 4096).unwrap();
        let s = head.scores(&h, &rows);
        eprintln!("4,500 points: {:?} ({} scores)", t0.elapsed(), s.len());
    }

    /// Minimal head.json reader without a serde dependency.
    mod serde_like {
        pub struct Head { pub n: usize, pub d: usize, pub hidden: String, pub rows: Vec<Vec<usize>> }
        pub fn read(p: &std::path::Path) -> Head {
            let s = std::fs::read_to_string(p).unwrap();
            let num = |k: &str| -> usize {
                let i = s.find(&format!("\"{k}\":")).unwrap() + k.len() + 3;
                s[i..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap()
            };
            let hi = s.find("\"hidden\":\"").unwrap() + 10;
            let hidden = s[hi..s[hi..].find('"').unwrap() + hi].to_string();
            let ri = s.find("\"rows\":").unwrap() + 7;
            let body = &s[ri + 1..s.rfind(']').unwrap()];
            let rows = body.split("],[").map(|r| r.trim_matches(|c| c == '[' || c == ']')
                .split(',').map(|v| v.parse().unwrap()).collect()).collect();
            Head { n: num("n"), d: num("d"), hidden, rows }
        }
    }
}

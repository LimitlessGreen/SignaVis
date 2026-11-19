// ═══════════════════════════════════════════════════════════════════════
// embed_map.rs — 2-D-Karte der Perch-2-Embeddings (plans/lite-embedding-map-plan.md)
//
// PCA 1536 → 50 (randomisierte Unterraum-Iteration), exakter kNN im
// PCA-Raum, UMAP-Layout (Fuzzy-Graph + SGD mit Negativ-Sampling). Grosse
// Stores: Layout auf einer Stichprobe, Rest ueber die Nachbarn platziert.
// Ergebnis gecacht in .signavis/embeddings/perch2/map.json (nach Stamp).
// Keine zusaetzlichen Abhaengigkeiten; parallel ueber std::thread::scope.
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

use crate::embeddings::{store_dir, store_stamp, with_loaded, EmbedState};
use aw_embed::{DIM, SAMPLE_RATE, WINDOW};

pub const MAP_EVENT: &str = "lite-map-progress";
const MAP_VERSION: u32 = 1;
const PCA_DIM: usize = 50;
const K: usize = 15;
const K_PLACE: usize = 5;
const MAX_LAYOUT: usize = 40_000;
const SEED: u64 = 0x5167_4E41_5649_5321;
// min_dist 0.1, spread 1.0 (Werte wie umap-learn)
const UMAP_A: f32 = 1.577;
const UMAP_B: f32 = 0.8951;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MapData {
    version: u32,
    stamp: u64,
    window: f64,
    /// Punkte, die ins UMAP-Layout eingingen (Rest: ueber Nachbarn platziert).
    layout_points: usize,
    files: Vec<String>,
    /// Pro Punkt: Index in `files`, Startzeit (s), Koordinaten in [0, 1].
    file: Vec<u32>,
    start: Vec<f64>,
    x: Vec<f32>,
    y: Vec<f32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    root: String,
    phase: &'static str,
    frac: f32,
}

fn map_path(root: &str) -> PathBuf {
    store_dir(root).join("map.json")
}

// ── Hilfen ────────────────────────────────────────────────────────────

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn gauss(&mut self) -> f32 {
        let u = self.unit().max(1e-7);
        let v = self.unit();
        (-2.0 * u.ln()).sqrt() * (std::f32::consts::TAU * v).cos()
    }
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

/// `f(i)` fuer i in 0..n, auf Threads verteilt, Reihenfolge bleibt erhalten.
fn par_map<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    if n == 0 {
        return vec![];
    }
    let t = threads().min(n);
    let chunk = n.div_ceil(t);
    std::thread::scope(|s| {
        let f = &f;
        let hs: Vec<_> = (0..t)
            .map(|c| s.spawn(move || (c * chunk..((c + 1) * chunk).min(n)).map(f).collect::<Vec<T>>()))
            .collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    })
}

// ── PCA ───────────────────────────────────────────────────────────────

/// Spalten von `m` (rows × cols, zeilenweise) orthonormieren (modifiziertes Gram-Schmidt).
fn orthonormalize(m: &mut [f32], rows: usize, cols: usize) {
    for j in 0..cols {
        for p in 0..j {
            let dot: f32 = (0..rows).map(|r| m[r * cols + j] * m[r * cols + p]).sum();
            for r in 0..rows {
                m[r * cols + j] -= dot * m[r * cols + p];
            }
        }
        let norm = (0..rows).map(|r| m[r * cols + j].powi(2)).sum::<f32>().sqrt().max(1e-12);
        for r in 0..rows {
            m[r * cols + j] /= norm;
        }
    }
}

/// Eigenzerlegung einer symmetrischen Matrix (zyklisches Jacobi). Liefert
/// (Eigenwerte, Eigenvektoren spaltenweise), absteigend sortiert.
fn jacobi_eigen(a: &[f64], n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut a = a.to_vec();
    let mut v = vec![0.0; n * n];
    (0..n).for_each(|i| v[i * n + i] = 1.0);
    for _ in 0..100 {
        let off: f64 = (0..n).flat_map(|i| (0..n).filter(move |&j| j != i).map(move |j| (i, j))).map(|(i, j)| a[i * n + j].powi(2)).sum();
        if off < 1e-18 {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                let apq = a[p * n + q];
                if apq.abs() < 1e-30 {
                    continue;
                }
                let theta = (a[q * n + q] - a[p * n + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let akp = a[k * n + p];
                    let akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for k in 0..n {
                    let apk = a[p * n + k];
                    let aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for k in 0..n {
                    let vkp = v[k * n + p];
                    let vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| a[j * n + j].total_cmp(&a[i * n + i]));
    let vals = order.iter().map(|&i| a[i * n + i]).collect();
    let mut vecs = vec![0.0; n * n];
    for (c, &i) in order.iter().enumerate() {
        for r in 0..n {
            vecs[r * n + c] = v[r * n + i];
        }
    }
    (vals, vecs)
}

/// PCA von `x` (n × dim) auf `out` Dimensionen, Ergebnis n × out.
fn pca(x: &[f32], n: usize, dim: usize, out: usize, rng: &mut Rng) -> Vec<f32> {
    let out = out.min(dim).min(n.max(1));
    let l = (out + 10).min(dim).min(n.max(1));
    let mut mean = vec![0.0f32; dim];
    for row in x.chunks_exact(dim) {
        mean.iter_mut().zip(row).for_each(|(m, v)| *m += v);
    }
    mean.iter_mut().for_each(|m| *m /= n.max(1) as f32);

    // Y = (X - m) Z  (n × l)
    let project = |z: &[f32]| -> Vec<f32> {
        par_map(n, |i| {
            let row = &x[i * dim..(i + 1) * dim];
            let mut y = vec![0.0f32; l];
            for (d, (&v, &m)) in row.iter().zip(&mean).enumerate() {
                let c = v - m;
                let zr = &z[d * l..(d + 1) * l];
                y.iter_mut().zip(zr).for_each(|(a, b)| *a += c * b);
            }
            y
        })
        .concat()
    };

    let mut z: Vec<f32> = (0..dim * l).map(|_| rng.gauss()).collect();
    orthonormalize(&mut z, dim, l);
    for _ in 0..3 {
        let y = project(&z);
        // Z = (X - m)^T Y  (dim × l), blockweise summiert
        let t = threads().min(n.max(1));
        let chunk = n.div_ceil(t);
        let parts = par_map(t, |c| {
            let mut acc = vec![0.0f32; dim * l];
            for i in c * chunk..((c + 1) * chunk).min(n) {
                let row = &x[i * dim..(i + 1) * dim];
                let yr = &y[i * l..(i + 1) * l];
                for (d, (&v, &m)) in row.iter().zip(&mean).enumerate() {
                    let c = v - m;
                    acc[d * l..(d + 1) * l].iter_mut().zip(yr).for_each(|(a, b)| *a += c * b);
                }
            }
            acc
        });
        z.iter_mut().for_each(|v| *v = 0.0);
        for p in parts {
            z.iter_mut().zip(p).for_each(|(a, b)| *a += b);
        }
        orthonormalize(&mut z, dim, l);
    }
    let y = project(&z);
    let mut cov = vec![0.0f64; l * l];
    for yr in y.chunks_exact(l) {
        for a in 0..l {
            for b in a..l {
                cov[a * l + b] += (yr[a] * yr[b]) as f64;
            }
        }
    }
    for a in 0..l {
        for b in 0..a {
            cov[a * l + b] = cov[b * l + a];
        }
    }
    let (_, w) = jacobi_eigen(&cov, l);
    let mut p = vec![0.0f32; n * out];
    for (i, yr) in y.chunks_exact(l).enumerate() {
        for c in 0..out {
            p[i * out + c] = (0..l).map(|a| yr[a] as f64 * w[a * l + c]).sum::<f64>() as f32;
        }
    }
    p
}

// ── kNN ───────────────────────────────────────────────────────────────

fn dist2(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum()
}

/// k naechste Nachbarn von `q` unter den Zeilen `cand` (ohne `skip`), aufsteigend.
fn nearest(p: &[f32], d: usize, q: &[f32], cand: &[usize], k: usize, skip: Option<usize>) -> Vec<(usize, f32)> {
    let mut best: Vec<(usize, f32)> = Vec::with_capacity(k + 1);
    for (ci, &j) in cand.iter().enumerate() {
        if Some(ci) == skip {
            continue;
        }
        let dd = dist2(q, &p[j * d..(j + 1) * d]);
        if best.len() == k && dd >= best[k - 1].1 {
            continue;
        }
        let pos = best.partition_point(|b| b.1 <= dd);
        best.insert(pos, (ci, dd));
        best.truncate(k);
    }
    best.into_iter().map(|(i, dd)| (i, dd.sqrt())).collect()
}

// ── UMAP ──────────────────────────────────────────────────────────────

/// Fuzzy-Graph aus kNN (je Punkt k Paare (Nachbar, Abstand)), symmetrisiert.
/// Liefert gerichtete Kanten (i, j, w) in beiden Richtungen.
fn fuzzy_graph(knn: &[Vec<(usize, f32)>]) -> Vec<(u32, u32, f32)> {
    let mut directed: Vec<(u64, f32)> = Vec::new();
    for (i, nb) in knn.iter().enumerate() {
        if nb.is_empty() {
            continue;
        }
        let target = (nb.len() as f32).log2();
        let rho = nb.iter().map(|x| x.1).find(|&d| d > 0.0).unwrap_or(0.0);
        let (mut lo, mut hi, mut sigma) = (0.0f32, f32::INFINITY, 1.0f32);
        for _ in 0..64 {
            let s: f32 = nb.iter().map(|x| (-(x.1 - rho).max(0.0) / sigma).exp()).sum();
            if (s - target).abs() < 1e-5 {
                break;
            }
            if s > target {
                hi = sigma;
                sigma = (lo + hi) / 2.0;
            } else {
                lo = sigma;
                sigma = if hi.is_finite() { (lo + hi) / 2.0 } else { sigma * 2.0 };
            }
        }
        let sigma = sigma.max(1e-3 * nb.iter().map(|x| x.1).sum::<f32>() / nb.len() as f32).max(1e-12);
        for &(j, d) in nb {
            if j == i {
                continue;
            }
            let w = (-(d - rho).max(0.0) / sigma).exp();
            let (a, b) = if i < j { (i, j) } else { (j, i) };
            directed.push((((a as u64) << 32) | b as u64, w));
        }
    }
    directed.sort_by_key(|e| e.0);
    let mut edges = Vec::with_capacity(directed.len() * 2);
    let mut k = 0;
    while k < directed.len() {
        let key = directed[k].0;
        let mut w = directed[k].1;
        if k + 1 < directed.len() && directed[k + 1].0 == key {
            let v = directed[k + 1].1;
            w = w + v - w * v;
            k += 1;
        }
        k += 1;
        let (a, b) = ((key >> 32) as u32, key as u32);
        edges.push((a, b, w));
        edges.push((b, a, w));
    }
    edges
}

fn clip(v: f32) -> f32 {
    v.clamp(-4.0, 4.0)
}

/// SGD-Layout (wie umap-learn optimize_layout_euclidean), `y` n × 2 in-place.
fn optimize_layout(y: &mut [f32], n: usize, edges: &[(u32, u32, f32)], rng: &mut Rng, mut progress: impl FnMut(f32)) {
    if edges.is_empty() || n < 2 {
        return;
    }
    let epochs = if n <= 10_000 { 500 } else { 200 };
    let wmax = edges.iter().map(|e| e.2).fold(0.0f32, f32::max);
    let edges: Vec<_> = edges.iter().filter(|e| e.2 >= wmax / epochs as f32).collect();
    let eps: Vec<f32> = edges.iter().map(|e| wmax / e.2).collect();
    let neg_rate = 5.0f32;
    let eps_neg: Vec<f32> = eps.iter().map(|e| e / neg_rate).collect();
    let mut next = eps.clone();
    let mut next_neg = eps_neg.clone();
    let (a, b) = (UMAP_A, UMAP_B);
    for epoch in 0..epochs {
        let ef = epoch as f32;
        let alpha = 1.0 - ef / epochs as f32;
        for (e, &&(i, j, _)) in edges.iter().enumerate() {
            if next[e] > ef {
                continue;
            }
            let (i, j) = (i as usize, j as usize);
            let (dx, dy) = (y[i * 2] - y[j * 2], y[i * 2 + 1] - y[j * 2 + 1]);
            let d2 = dx * dx + dy * dy;
            if d2 > 0.0 {
                let g = -2.0 * a * b * d2.powf(b - 1.0) / (a * d2.powf(b) + 1.0);
                let (gx, gy) = (clip(g * dx) * alpha, clip(g * dy) * alpha);
                y[i * 2] += gx;
                y[i * 2 + 1] += gy;
                y[j * 2] -= gx;
                y[j * 2 + 1] -= gy;
            }
            next[e] += eps[e];
            let n_neg = ((ef - next_neg[e]) / eps_neg[e]).max(0.0) as usize;
            for _ in 0..n_neg {
                let k = rng.below(n);
                if k == i {
                    continue;
                }
                let (dx, dy) = (y[i * 2] - y[k * 2], y[i * 2 + 1] - y[k * 2 + 1]);
                let d2 = dx * dx + dy * dy;
                let (gx, gy) = if d2 > 0.0 {
                    let g = 2.0 * b / ((0.001 + d2) * (a * d2.powf(b) + 1.0));
                    (clip(g * dx), clip(g * dy))
                } else {
                    (4.0, 4.0)
                };
                y[i * 2] += gx * alpha;
                y[i * 2 + 1] += gy * alpha;
            }
            next_neg[e] += n_neg as f32 * eps_neg[e];
        }
        if epoch % 10 == 0 {
            progress(ef / epochs as f32);
        }
    }
}

/// Komplette Projektion: `x` (n × DIM, normiert) → 2-D-Koordinaten in [0, 1].
/// Liefert (xy n × 2, Anzahl Layout-Punkte).
pub(crate) fn project_2d(x: &[f32], n: usize, dim: usize, progress: &dyn Fn(&'static str, f32)) -> (Vec<f32>, usize) {
    let mut rng = Rng(SEED);
    if n == 0 {
        return (vec![], 0);
    }
    progress("pca", 0.0);
    let d = PCA_DIM.min(dim).min(n);
    let p = pca(x, n, dim, d, &mut rng);

    // Stichprobe fuers Layout
    let layout: Vec<usize> = if n > MAX_LAYOUT {
        let mut idx: Vec<usize> = (0..n).collect();
        for i in 0..MAX_LAYOUT {
            let j = i + rng.below(n - i);
            idx.swap(i, j);
        }
        let mut s = idx[..MAX_LAYOUT].to_vec();
        s.sort_unstable();
        s
    } else {
        (0..n).collect()
    };
    let m = layout.len();

    progress("knn", 0.0);
    let k = K.min(m.saturating_sub(1));
    let knn: Vec<Vec<(usize, f32)>> = par_map(m, |ci| nearest(&p, d, &p[layout[ci] * d..(layout[ci] + 1) * d], &layout, k, Some(ci)));

    // Init: erste zwei PCA-Komponenten, auf [-10, 10] skaliert
    let mut y = vec![0.0f32; m * 2];
    for c in 0..2.min(d) {
        let vals: Vec<f32> = layout.iter().map(|&i| p[i * d + c]).collect();
        let span = vals.iter().fold(0.0f32, |a, v| a.max(v.abs())).max(1e-12);
        for (ci, v) in vals.iter().enumerate() {
            y[ci * 2 + c] = v / span * 10.0 + rng.gauss() * 1e-4;
        }
    }
    progress("layout", 0.0);
    let edges = fuzzy_graph(&knn);
    optimize_layout(&mut y, m, &edges, &mut rng, |f| progress("layout", f));

    // Ganze Menge: Layout-Punkte direkt, Rest ueber Nachbarn
    let mut xy = vec![0.0f32; n * 2];
    for (ci, &i) in layout.iter().enumerate() {
        xy[i * 2] = y[ci * 2];
        xy[i * 2 + 1] = y[ci * 2 + 1];
    }
    if m < n {
        progress("place", 0.0);
        let mut in_layout = vec![false; n];
        layout.iter().for_each(|&i| in_layout[i] = true);
        let rest: Vec<usize> = (0..n).filter(|&i| !in_layout[i]).collect();
        let placed = par_map(rest.len(), |r| {
            let i = rest[r];
            let nb = nearest(&p, d, &p[i * d..(i + 1) * d], &layout, K_PLACE, None);
            let w = nb.len().max(1) as f32;
            let sx: f32 = nb.iter().map(|&(ci, _)| y[ci * 2]).sum();
            let sy: f32 = nb.iter().map(|&(ci, _)| y[ci * 2 + 1]).sum();
            (sx / w, sy / w)
        });
        for (r, (px, py)) in placed.into_iter().enumerate() {
            xy[rest[r] * 2] = px;
            xy[rest[r] * 2 + 1] = py;
        }
    }

    // Auf [0, 1] normieren (gleicher Massstab fuer beide Achsen)
    let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for c in xy.chunks_exact(2) {
        x0 = x0.min(c[0]);
        x1 = x1.max(c[0]);
        y0 = y0.min(c[1]);
        y1 = y1.max(c[1]);
    }
    let span = (x1 - x0).max(y1 - y0).max(1e-12);
    let (ox, oy) = ((span - (x1 - x0)) / 2.0, (span - (y1 - y0)) / 2.0);
    for c in xy.chunks_exact_mut(2) {
        c[0] = (c[0] - x0 + ox) / span;
        c[1] = (c[1] - y0 + oy) / span;
    }
    (xy, m)
}

// ── Kommando ──────────────────────────────────────────────────────────

/// 2-D-Karte aller Fenster des Projekts (gecacht; `force` rechnet neu).
#[tauri::command]
pub async fn embed_map(app: tauri::AppHandle, root: String, force: Option<bool>) -> Result<MapData, String> {
    tauri::async_runtime::spawn_blocking(move || compute_map(&app, &root, force.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

fn compute_map(app: &tauri::AppHandle, root: &str, force: bool) -> Result<MapData, String> {
    let emit = |phase: &'static str, frac: f32| {
        let _ = app.emit(MAP_EVENT, Progress { root: root.to_string(), phase, frac });
    };
    let data = build_map(&app.state::<EmbedState>(), root, force, &emit)?;
    emit("done", 1.0);
    Ok(data)
}

/// Karte aus dem Cache oder neu berechnet (und gecacht).
pub(crate) fn build_map(state: &EmbedState, root: &str, force: bool, emit: &dyn Fn(&'static str, f32)) -> Result<MapData, String> {
    let stamp = store_stamp(root).ok_or("Noch keine Embeddings in diesem Projekt")?;
    if !force {
        let cached = std::fs::read(map_path(root)).ok().and_then(|b| serde_json::from_slice::<MapData>(&b).ok());
        if let Some(c) = cached.filter(|c| c.version == MAP_VERSION && c.stamp == stamp) {
            return Ok(c);
        }
    }
    // Laeuft auf der gecachten Matrix (kein Kopieren); die Suche wartet solange.
    let data = with_loaded(state, root, |l| {
        let n = l.rows.len();
        let (xy, layout_points) = project_2d(&l.vecs, n, DIM, emit);
        let mut files: Vec<String> = Vec::new();
        let mut file = Vec::with_capacity(n);
        for r in &l.rows {
            if files.last() != Some(&r.path) {
                files.push(r.path.clone());
            }
            file.push((files.len() - 1) as u32);
        }
        MapData {
            version: MAP_VERSION,
            stamp: l.stamp,
            window: WINDOW as f64 / SAMPLE_RATE as f64,
            layout_points,
            files,
            file,
            start: l.rows.iter().map(|r| r.start).collect(),
            x: xy.iter().step_by(2).copied().collect(),
            y: xy.iter().skip(1).step_by(2).copied().collect(),
        }
    })?;
    if let Ok(json) = serde_json::to_vec(&data) {
        let _ = std::fs::write(map_path(root), json);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drei gut getrennte Gauss-Wolken in 64-D muessen auf der Karte getrennt bleiben.
    #[test]
    fn separates_clusters() {
        let (dim, per) = (64, 150);
        let mut rng = Rng(7);
        let mut x = Vec::new();
        for c in 0..3 {
            for _ in 0..per {
                for d in 0..dim {
                    let centre = if d % 3 == c { 3.0 } else { 0.0 };
                    x.push(centre + rng.gauss() * 0.3);
                }
            }
        }
        let n = 3 * per;
        let (xy, m) = project_2d(&x, n, dim, &|_, _| {});
        assert_eq!(m, n);
        assert!(xy.iter().all(|v| (0.0..=1.0).contains(v)));
        let centroid = |c: usize| {
            let pts = &xy[c * per * 2..(c + 1) * per * 2];
            let (sx, sy) = pts.chunks_exact(2).fold((0.0, 0.0), |a, p| (a.0 + p[0], a.1 + p[1]));
            (sx / per as f32, sy / per as f32)
        };
        let spread = |c: usize| {
            let (cx, cy) = centroid(c);
            let pts = &xy[c * per * 2..(c + 1) * per * 2];
            pts.chunks_exact(2).map(|p| ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt()).sum::<f32>() / per as f32
        };
        for a in 0..3 {
            for b in a + 1..3 {
                let (ax, ay) = centroid(a);
                let (bx, by) = centroid(b);
                let dist = ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt();
                assert!(dist > 2.0 * (spread(a) + spread(b)), "Cluster {a}/{b} zu nah: {dist}");
            }
        }
    }

    #[test]
    fn jacobi_matches_known_eigenvalues() {
        let (vals, _) = jacobi_eigen(&[2.0, 1.0, 1.0, 2.0], 2);
        assert!((vals[0] - 3.0).abs() < 1e-9 && (vals[1] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn subsample_places_rest_near_neighbours() {
        // Mehr Punkte als das Layout-Limit waere teuer im Test; Platzierung
        // ueber die Nachbarn testet nearest() direkt.
        let p = vec![0.0, 0.0, 1.0, 0.0, 5.0, 5.0];
        let nb = nearest(&p, 2, &[0.9, 0.1], &[0, 1, 2], 2, None);
        assert_eq!(nb.iter().map(|x| x.0).collect::<Vec<_>>(), vec![1, 0]);
    }

    /// Laufzeit bei realistischer Groesse: cargo test --release --lib embed_map -- --ignored --nocapture
    #[test]
    #[ignore]
    fn timing_large() {
        let (dim, n) = (DIM, 60_000);
        let mut rng = Rng(3);
        let x: Vec<f32> = (0..n * dim).map(|i| rng.gauss() * 0.1 + if i % dim == (i / dim) % 40 { 2.0 } else { 0.0 }).collect();
        let t = std::time::Instant::now();
        let (_, m) = project_2d(&x, n, dim, &|ph, f| if f == 0.0 { eprintln!("{:>6.1}s {ph}", t.elapsed().as_secs_f32()) });
        eprintln!("{n} Punkte ({m} Layout) in {:.1}s", t.elapsed().as_secs_f32());
    }

    /// Karte eines echten Projekts: EMBED_MAP_DIR=<projekt> cargo test --release --lib real_store -- --ignored
    #[test]
    #[ignore]
    fn real_store() {
        let root = std::env::var("EMBED_MAP_DIR").unwrap();
        let m = build_map(&EmbedState::default(), &root, true, &|_, _| {}).unwrap();
        assert_eq!(m.x.len(), m.start.len());
        eprintln!("{} Punkte, {} Dateien -> {}", m.x.len(), m.files.len(), map_path(&root).display());
    }
}

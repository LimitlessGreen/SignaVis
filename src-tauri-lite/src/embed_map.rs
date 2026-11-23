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

use crate::hdbscan;
use crate::embeddings::{store_dir, store_stamp, with_loaded, EmbedState, Loaded};
use aw_embed::{DIM, SAMPLE_RATE, WINDOW};

pub const MAP_EVENT: &str = "lite-map-progress";
const MAP_VERSION: u32 = 2;
/// Kern-Abstand fuer HDBSCAN (Mutual Reachability): Abstand zum 5. Nachbarn.
const MIN_SAMPLES: usize = 5;
const PCA_DIM: usize = 50;
const K: usize = 15;
const K_PLACE: usize = 5;
const MAX_LAYOUT: usize = 40_000;
const SEED: u64 = 0x5167_4E41_5649_5321;
/// Inkrementell nur, solange hoechstens dieser Anteil neu oder weg ist.
const MAX_INCREMENTAL: f64 = 0.25;
/// Kandidaten fuer das Einsortieren neuer Fenster (Stichprobe der alten Punkte).
const MAX_PLACE_CAND: usize = 20_000;
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
    /// Pro Punkt: Layout-Punkt (Index im Layout), ueber den er platziert wurde.
    anchor: Vec<u32>,
    /// Minimalbaum der Layout-Punkte (Mutual Reachability), fuer HDBSCAN.
    /// Nur im Cache, nicht an die Oberflaeche.
    #[serde(default)]
    mst_a: Vec<u32>,
    #[serde(default)]
    mst_b: Vec<u32>,
    #[serde(default)]
    mst_w: Vec<f32>,
    /// Neue Fenster, die zuletzt ohne neues Layout einsortiert wurden (0: frisch gerechnet).
    #[serde(default)]
    placed_new: usize,
    /// Pegel pro Punkt (dBFS) aus dem Index; nicht im Cache, leer ohne Pegel.
    #[serde(default, skip_deserializing)]
    level: Vec<f32>,
    /// Score pro Punkt (max. Perch-Logit); nicht im Cache, leer ohne Score.
    #[serde(default, skip_deserializing)]
    score: Vec<f32>,
    /// Ort pro Datei (GUANO), parallel zu `files`; nicht im Cache.
    #[serde(default, skip_deserializing)]
    places: Vec<Option<crate::guano::GuanoPlace>>,
    /// Signatur (Groesse:mtime) pro Datei, parallel zu `files`; nur im Cache.
    /// Geaenderte Datei am selben Pfad → ihre Fenster gelten als neu.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sigs: Vec<String>,
}

pub(crate) struct Projection {
    pub xy: Vec<f32>,
    pub layout_points: usize,
    pub anchor: Vec<u32>,
    pub mst: Vec<(u32, u32, f32)>,
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

/// Verbindet die Teile des kNN-Graphen mit ihrer echten kuerzesten Kante
/// (Borůvka-Schritte), damit HDBSCAN keine kuenstlichen Spruenge sieht.
fn connect_components(p: &[f32], d: usize, layout: &[usize], core: &[f32], mut edges: Vec<(u32, u32, f32)>) -> Vec<(u32, u32, f32)> {
    let m = layout.len();
    loop {
        let mut uf = hdbscan::UnionFind::new(m);
        edges.iter().for_each(|e| {
            uf.union(e.0 as usize, e.1 as usize);
        });
        let comp: Vec<usize> = (0..m).map(|i| uf.find(i)).collect();
        let mut roots: Vec<usize> = comp.clone();
        roots.sort_unstable();
        roots.dedup();
        if roots.len() <= 1 {
            return edges;
        }
        // je Teil die kuerzeste Kante nach aussen
        let best = par_map(roots.len(), |ri| {
            let r = roots[ri];
            let mut best = (u32::MAX, u32::MAX, f32::MAX);
            for i in (0..m).filter(|&i| comp[i] == r) {
                let qi = &p[layout[i] * d..(layout[i] + 1) * d];
                for j in (0..m).filter(|&j| comp[j] != r) {
                    let dd = dist2(qi, &p[layout[j] * d..(layout[j] + 1) * d]).sqrt().max(core[i]).max(core[j]);
                    if dd < best.2 {
                        best = (i as u32, j as u32, dd);
                    }
                }
            }
            best
        });
        edges.extend(best.into_iter().filter(|e| e.0 != u32::MAX));
    }
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
pub(crate) fn project_2d(x: &[f32], n: usize, dim: usize, progress: &dyn Fn(&'static str, f32)) -> Projection {
    let mut rng = Rng(SEED);
    if n == 0 {
        return Projection { xy: vec![], layout_points: 0, anchor: vec![], mst: vec![] };
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

    // Minimalbaum fuer HDBSCAN: kNN-Kanten mit Mutual-Reachability-Gewicht
    let core: Vec<f32> = knn.iter().map(|nb| nb.get(MIN_SAMPLES.min(nb.len()).saturating_sub(1)).map_or(0.0, |x| x.1)).collect();
    let mr_edges: Vec<(u32, u32, f32)> = knn
        .iter()
        .enumerate()
        .flat_map(|(i, nb)| nb.iter().map(move |&(j, d)| (i, j, d)))
        .map(|(i, j, d)| (i as u32, j as u32, d.max(core[i]).max(core[j])))
        .collect();
    let mr_edges = connect_components(&p, d, &layout, &core, mr_edges);
    let mst = hdbscan::mst(m, mr_edges);
    let mut anchor = vec![0u32; n];
    for (ci, &i) in layout.iter().enumerate() {
        anchor[i] = ci as u32;
    }

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
            (sx / w, sy / w, nb.first().map_or(0, |x| x.0) as u32)
        });
        for (r, (px, py, a)) in placed.into_iter().enumerate() {
            xy[rest[r] * 2] = px;
            xy[rest[r] * 2 + 1] = py;
            anchor[rest[r]] = a;
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
    Projection { xy, layout_points: m, anchor, mst }
}

// ── Kommando ──────────────────────────────────────────────────────────

/// 2-D-Karte aller Fenster des Projekts (gecacht; `force` rechnet neu).
#[tauri::command]
pub async fn embed_map(app: tauri::AppHandle, root: String, force: Option<bool>) -> Result<MapData, String> {
    let mut data = tauri::async_runtime::spawn_blocking(move || {
        let mut d = compute_map(&app, &root, force.unwrap_or(false))?;
        // Pegel und Score aus einem Index-Snapshot, und nur, wenn er zur Karte passt
        // (sonst koennten sie per Reihenfolge an fremde Punkte geraten).
        if let Some((_, meta)) = crate::embeddings::file_meta(&root).filter(|(s, _)| *s == d.stamp) {
            d.level = point_values(&meta, &d, |m| &m.level);
            d.score = point_values(&meta, &d, |m| &m.score);
        }
        d.places = d.files.iter().map(|f| safe_join(&root, f).and_then(|p| crate::guano::read_place(&p))).collect();
        d.sigs = vec![];
        Ok::<_, String>(d)
    })
    .await
    .map_err(|e| e.to_string())??;
    data.mst_a = vec![];
    data.mst_b = vec![];
    data.mst_w = vec![];
    Ok(data)
}

/// Projektpfad + relativer Dateipfad aus dem Karten-Cache; None, wenn der Pfad
/// absolut ist oder den Projektordner verlassen wuerde.
fn safe_join(root: &str, rel: &str) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let p = std::path::Path::new(rel);
    p.components().all(|c| matches!(c, Component::Normal(_))).then(|| std::path::Path::new(root).join(p))
}

/// Wert (Pegel, Score) jedes Kartenpunkts; leer, wenn er auch nur einer Datei fehlt.
fn point_values(
    meta: &std::collections::BTreeMap<String, crate::embeddings::FileMeta>,
    d: &MapData,
    pick: impl Fn(&crate::embeddings::FileMeta) -> &Vec<f32>,
) -> Vec<f32> {
    let by_file: std::collections::BTreeMap<&String, &Vec<f32>> = meta.iter().map(|(k, m)| (k, pick(m))).collect();
    let mut out = Vec::with_capacity(d.x.len());
    // Punkte einer Datei liegen hintereinander, in Zeilenreihenfolge.
    let (mut prev, mut row) = (u32::MAX, 0usize);
    for &f in &d.file {
        row = if f == prev { row + 1 } else { 0 };
        prev = f;
        let Some(lv) = by_file.get(&d.files[f as usize]) else { return vec![] };
        match lv.get(row) {
            Some(&v) => out.push(v),
            None => return vec![],
        }
    }
    out
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
    let (stamp, meta) = crate::embeddings::file_meta(root).ok_or("Noch keine Embeddings in diesem Projekt")?;
    let sigs: std::collections::HashMap<&str, &str> = meta.iter().map(|(k, m)| (k.as_str(), m.sig.as_str())).collect();
    if !force {
        if let Some(c) = cached_map(state, root) {
            if c.stamp == stamp {
                return Ok(c);
            }
            // Wenig geaendert: alte Punkte behalten, neue einsortieren. Nur wenn die
            // Matrix zum gelesenen Index passt (sonst passen die Signaturen nicht).
            emit("place", 0.0);
            if let Some(mut d) = with_loaded(state, root, |l| (l.stamp == stamp).then(|| update_map(&c, l, &sigs)).flatten())? {
                d.sigs = d.files.iter().map(|f| sigs.get(f.as_str()).unwrap_or(&"").to_string()).collect();
                return Ok(keep_map(state, root, d));
            }
        }
    }
    // Laeuft auf der gecachten Matrix (kein Kopieren); die Suche wartet solange.
    let mut data = with_loaded(state, root, |l| assemble(l, project_2d(&l.vecs, l.rows.len(), DIM, emit)))?;
    if data.stamp == stamp {
        data.sigs = data.files.iter().map(|f| sigs.get(f.as_str()).unwrap_or(&"").to_string()).collect();
    }
    Ok(keep_map(state, root, data))
}

/// Zuletzt berechnete Karte: aus dem Speicher, sonst aus map.json.
fn cached_map(state: &EmbedState, root: &str) -> Option<MapData> {
    let mem = state.map.lock().unwrap().as_ref().filter(|(r, _)| r == root).map(|(_, m)| m.clone());
    mem.or_else(|| std::fs::read(map_path(root)).ok().and_then(|b| serde_json::from_slice::<MapData>(&b).ok()))
        .filter(|c| c.version == MAP_VERSION)
}

/// Karte im Speicher halten und nach map.json schreiben (Schreibfehler: nur Speicher).
fn keep_map(state: &EmbedState, root: &str, d: MapData) -> MapData {
    if let Ok(json) = serde_json::to_vec(&d) {
        if let Err(e) = std::fs::write(map_path(root), json) {
            eprintln!("[map] map.json nicht geschrieben: {e}");
        }
    }
    *state.map.lock().unwrap() = Some((root.to_string(), d.clone()));
    d
}

/// Kartendaten aus geladener Matrix und Projektion.
fn assemble(l: &Loaded, proj: Projection) -> MapData {
    let Projection { xy, layout_points, anchor, mst } = proj;
    let n = l.rows.len();
    {
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
            anchor,
            mst_a: mst.iter().map(|e| e.0).collect(),
            mst_b: mst.iter().map(|e| e.1).collect(),
            mst_w: mst.iter().map(|e| e.2).collect(),
            placed_new: 0,
            level: vec![],
            score: vec![],
            places: vec![],
            sigs: vec![],
        }
    }
}

/// Karte fortschreiben statt neu rechnen: Punkte, die es noch gibt, behalten
/// Lage und Anker; neue Fenster kommen ans Mittel ihrer K_PLACE naechsten alten
/// Punkte (Kosinus im Embedding-Raum) und erben den Anker des naechsten.
/// None, wenn sich zu viel geaendert hat (dann neues Layout).
pub(crate) fn update_map(old: &MapData, l: &Loaded, sigs: &std::collections::HashMap<&str, &str>) -> Option<MapData> {
    let key = |path: &str, start: f64| (path.to_string(), (start * 1000.0).round() as i64);
    // Dateien, deren Inhalt sich geaendert hat (andere Signatur), zaehlen nicht als alt.
    let same_file = |fi: usize| {
        let f = old.files[fi].as_str();
        old.sigs.get(fi).is_none_or(|s| sigs.get(f).is_none_or(|n| n == s))
    };
    let old_idx: std::collections::HashMap<(String, i64), usize> = (0..old.x.len())
        .filter(|&i| same_file(old.file[i] as usize))
        .map(|i| (key(&old.files[old.file[i] as usize], old.start[i]), i))
        .collect();
    let n = l.rows.len();
    let found: Vec<Option<usize>> = l.rows.iter().map(|r| old_idx.get(&key(&r.path, r.start)).copied()).collect();
    let kept = found.iter().filter(|f| f.is_some()).count();
    let (added, removed) = (n - kept, old.x.len() - kept);
    if kept == 0 || (added + removed) as f64 > MAX_INCREMENTAL * old.x.len() as f64 {
        return None;
    }
    // Kandidaten: alte Punkte, die es noch gibt (Stichprobe bei grossen Stores)
    let mut cand: Vec<usize> = (0..n).filter(|&i| found[i].is_some()).collect();
    if cand.len() > MAX_PLACE_CAND {
        let mut rng = Rng(SEED ^ old.stamp);
        for i in 0..MAX_PLACE_CAND {
            let j = i + rng.below(cand.len() - i);
            cand.swap(i, j);
        }
        cand.truncate(MAX_PLACE_CAND);
    }
    let new_rows: Vec<usize> = (0..n).filter(|&i| found[i].is_none()).collect();
    let placed = par_map(new_rows.len(), |r| {
        let i = new_rows[r];
        let nb = nearest(&l.vecs, DIM, &l.vecs[i * DIM..(i + 1) * DIM], &cand, K_PLACE, None);
        let w = nb.len().max(1) as f32;
        let (sx, sy) = nb.iter().fold((0.0f32, 0.0f32), |a, &(ci, _)| {
            let o = found[cand[ci]].unwrap();
            (a.0 + old.x[o], a.1 + old.y[o])
        });
        let anchor = nb.first().map_or(0, |&(ci, _)| old.anchor[found[cand[ci]].unwrap()]);
        (sx / w, sy / w, anchor)
    });
    let mut new_iter = placed.into_iter();
    let (mut files, mut file) = (Vec::<String>::new(), Vec::with_capacity(n));
    let (mut x, mut y, mut anchor) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for (i, r) in l.rows.iter().enumerate() {
        if files.last() != Some(&r.path) {
            files.push(r.path.clone());
        }
        file.push((files.len() - 1) as u32);
        let (px, py, a) = match found[i] {
            Some(o) => (old.x[o], old.y[o], old.anchor[o]),
            None => new_iter.next().unwrap(),
        };
        x.push(px);
        y.push(py);
        anchor.push(a);
    }
    Some(MapData {
        version: MAP_VERSION,
        stamp: l.stamp,
        window: old.window,
        layout_points: old.layout_points,
        files,
        file,
        start: l.rows.iter().map(|r| r.start).collect(),
        x,
        y,
        anchor,
        mst_a: old.mst_a.clone(),
        mst_b: old.mst_b.clone(),
        mst_w: old.mst_w.clone(),
        placed_new: old.placed_new + added,
        level: vec![],
        score: vec![],
        places: vec![],
        sigs: vec![],
    })
}

// ── Cluster ───────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    id: i32,
    size: usize,
    /// Typische Punkte (Index in der Karte): am festesten im Cluster.
    exemplars: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clusters {
    stamp: u64,
    min_cluster_size: usize,
    /// Pro Kartenpunkt Cluster-Id (0 = groesster) oder −1 (Rauschen).
    labels: Vec<i32>,
    strength: Vec<f32>,
    /// Pro Kartenpunkt der naechste Cluster, auch fuer Rauschen (−1 nur ohne
    /// erreichbaren Cluster) – fuer „Unzugeordnete dem naechsten Cluster zuordnen“.
    nearest: Vec<i32>,
    clusters: Vec<ClusterInfo>,
    noise: usize,
}

/// Mindestgroesse ohne Vorgabe: ~2 % der Layout-Punkte, 5..100.
fn auto_min_size(m: usize) -> usize {
    (m / 50).clamp(5, 100)
}

pub(crate) fn clusters_from_map(map: &MapData, min_cluster_size: Option<usize>) -> Clusters {
    let m = map.layout_points;
    let mcs = min_cluster_size.unwrap_or_else(|| auto_min_size(m));
    let mst: Vec<(u32, u32, f32)> = (0..map.mst_w.len()).map(|i| (map.mst_a[i], map.mst_b[i], map.mst_w[i])).collect();
    let c = hdbscan::cluster(m, &mst, mcs);
    let n = map.x.len();
    let labels: Vec<i32> = (0..n).map(|i| c.labels.get(map.anchor[i] as usize).copied().unwrap_or(-1)).collect();
    // Nach inkrementellen Updates kann ein Cluster keine lebenden Punkte mehr haben:
    // dann darf er im Baum nur Durchgang sein, kein Ziel der Zuordnung.
    let live: std::collections::HashSet<i32> = labels.iter().copied().filter(|&l| l >= 0).collect();
    let seeds: Vec<i32> = c.labels.iter().map(|&l| if live.contains(&l) { l } else { -1 }).collect();
    let near_layout = hdbscan::assign_noise(m, &mst, &seeds);
    let nearest: Vec<i32> = (0..n).map(|i| near_layout.get(map.anchor[i] as usize).copied().unwrap_or(-1)).collect();
    // Platzierte Punkte erben Cluster und Staerke ihres Ankers.
    let strength: Vec<f32> = (0..n).map(|i| c.strength.get(map.anchor[i] as usize).copied().unwrap_or(0.0)).collect();
    let k = labels.iter().copied().max().map_or(0, |v| (v + 1).max(0) as usize);
    let mut members: Vec<Vec<u32>> = vec![vec![]; k];
    for (i, &l) in labels.iter().enumerate() {
        if l >= 0 {
            members[l as usize].push(i as u32);
        }
    }
    let clusters = members
        .into_iter()
        .enumerate()
        .map(|(id, mut pts)| {
            let size = pts.len();
            // typisch = fest im Cluster und nahe am 2-D-Schwerpunkt
            let (cx, cy) = pts.iter().fold((0.0, 0.0), |a, &i| (a.0 + map.x[i as usize], a.1 + map.y[i as usize]));
            let (cx, cy) = (cx / size.max(1) as f32, cy / size.max(1) as f32);
            let key = |i: u32| {
                let i = i as usize;
                let d = ((map.x[i] - cx).powi(2) + (map.y[i] - cy).powi(2)).sqrt();
                strength[i] - d
            };
            pts.sort_by(|&a, &b| key(b).total_cmp(&key(a)));
            pts.truncate(6);
            ClusterInfo { id: id as i32, size, exemplars: pts }
        })
        .filter(|c| c.size > 0)
        .collect();
    let noise = labels.iter().filter(|&&l| l < 0).count();
    Clusters { stamp: map.stamp, min_cluster_size: mcs, labels, strength, nearest, clusters, noise }
}

/// Unzugeordnete Punkte zum Cluster mit dem aehnlichsten Schwerpunkt (Kosinus im
/// Embedding-Raum). `vecs` normiert, eine Zeile pro Kartenpunkt. Auf Hawaii
/// (Zenodo 7078499, 73 k Fenster) trifft das die annotierte Art in 81 % der Faelle,
/// der Weg durch den Minimalbaum in 76 %, die haeufigste Art allein in 61 %.
pub(crate) fn nearest_centroid(vecs: &[f32], labels: &[i32]) -> Vec<i32> {
    let k = labels.iter().copied().max().map_or(0, |v| (v + 1).max(0) as usize);
    if k == 0 {
        return labels.to_vec();
    }
    let mut cent = vec![0.0f32; k * DIM];
    let mut count = vec![0usize; k];
    for (i, &l) in labels.iter().enumerate() {
        if l >= 0 {
            count[l as usize] += 1;
            let c = &mut cent[l as usize * DIM..(l as usize + 1) * DIM];
            c.iter_mut().zip(&vecs[i * DIM..(i + 1) * DIM]).for_each(|(a, b)| *a += b);
        }
    }
    for c in cent.chunks_exact_mut(DIM) {
        let nrm = c.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
        c.iter_mut().for_each(|x| *x /= nrm);
    }
    par_map(labels.len(), |i| {
        if labels[i] >= 0 {
            return labels[i];
        }
        let v = &vecs[i * DIM..(i + 1) * DIM];
        let dot = |c: &[f32]| c.iter().zip(v).map(|(a, b)| a * b).sum::<f32>();
        // Nur Cluster mit Mitgliedern (leere Schwerpunkte waeren Nullvektoren).
        (0..k)
            .filter(|&c| count[c] > 0)
            .max_by(|&a, &b| dot(&cent[a * DIM..(a + 1) * DIM]).total_cmp(&dot(&cent[b * DIM..(b + 1) * DIM])))
            .map_or(-1, |c| c as i32)
    })
}

/// HDBSCAN-Cluster auf der aktuellen Karte (`min_cluster_size` leer = automatisch).
#[tauri::command]
pub async fn embed_clusters(app: tauri::AppHandle, root: String, min_cluster_size: Option<usize>) -> Result<Clusters, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stamp = store_stamp(&root).ok_or("Noch keine Embeddings in diesem Projekt")?;
        let state = app.state::<EmbedState>();
        let map = cached_map(&state, &root)
            .filter(|m| m.stamp == stamp)
            .ok_or("Karte ist veraltet – bitte neu berechnen")?;
        let mut c = clusters_from_map(&map, min_cluster_size);
        // Naechster Cluster ueber die Schwerpunkte, wenn die Matrix zur Karte passt;
        // sonst bleibt der Weg durch den Minimalbaum.
        if let Ok(Some(n)) = with_loaded(&state, &root, |l| {
            (l.stamp == map.stamp && l.rows.len() == map.x.len()).then(|| nearest_centroid(&l.vecs, &c.labels))
        }) {
            c.nearest = n;
        }
        Ok(c)
    })
    .await
    .map_err(|e| e.to_string())?
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
        let Projection { xy, layout_points: m, .. } = project_2d(&x, n, dim, &|_, _| {});
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

    /// Drei Arten als Dateien a/b/c, je `per` Fenster um eine eigene Richtung im Embedding-Raum.
    fn synth(files: &[(&str, usize, usize)], seed: u64) -> Loaded {
        let mut rng = Rng(seed);
        let (mut rows, mut vecs) = (vec![], vec![]);
        for &(name, cls, count) in files {
            for k in 0..count {
                let mut v: Vec<f32> = (0..DIM).map(|d| if d % 3 == cls { 1.0 } else { 0.0 } + rng.gauss() * 0.3).collect();
                let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                v.iter_mut().for_each(|x| *x /= norm);
                vecs.extend(v);
                rows.push(crate::embeddings::RowRef { path: name.into(), start: k as f64 * 5.0 });
            }
        }
        Loaded { root: String::new(), stamp: seed, rows, vecs }
    }

    #[test]
    fn update_treats_windows_of_a_replaced_file_as_new() {
        let l0 = synth(&[("a.wav", 0, 100), ("b.wav", 1, 100), ("c.wav", 2, 10)], 1);
        let mut old = assemble(&l0, project_2d(&l0.vecs, l0.rows.len(), DIM, &|_, _| {}));
        old.sigs = vec!["1:1".into(), "2:2".into(), "3:3".into()];
        // c.wav am selben Pfad mit anderem Inhalt (andere Art, andere Signatur)
        let l1 = synth(&[("a.wav", 0, 100), ("b.wav", 1, 100), ("c.wav", 0, 10)], 2);
        let same: std::collections::HashMap<&str, &str> = [("a.wav", "1:1"), ("b.wav", "2:2"), ("c.wav", "3:3")].into();
        assert_eq!(update_map(&old, &l1, &same).unwrap().placed_new, 0, "gleiche Signatur: Lage bleibt");
        let changed: std::collections::HashMap<&str, &str> = [("a.wav", "1:1"), ("b.wav", "2:2"), ("c.wav", "9:9")].into();
        let new = update_map(&old, &l1, &changed).unwrap();
        assert_eq!(new.placed_new, 10, "Fenster der ersetzten Datei werden neu einsortiert");
        // ...und landen jetzt bei Art 0 (a.wav), nicht mehr an der alten Stelle
        let mean = |m: &MapData, f: &str| {
            let p: Vec<usize> = (0..m.x.len()).filter(|&i| m.files[m.file[i] as usize] == f).collect();
            (p.iter().map(|&i| m.x[i]).sum::<f32>() / p.len() as f32, p.iter().map(|&i| m.y[i]).sum::<f32>() / p.len() as f32)
        };
        let (a, c) = (mean(&new, "a.wav"), mean(&new, "c.wav"));
        let (b, c_old) = (mean(&new, "b.wav"), mean(&old, "c.wav"));
        let d = |p: (f32, f32), q: (f32, f32)| ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt();
        assert!(d(c, a) < d(c, b), "ersetzte Datei liegt bei ihrer neuen Art");
        assert!(d(c, c_old) > 0.0);
    }

    #[test]
    fn safe_join_rejects_paths_leaving_the_project() {
        assert!(safe_join("/p", "a/b.wav").is_some());
        assert!(safe_join("/p", "../x.wav").is_none());
        assert!(safe_join("/p", "/etc/x.wav").is_none());
        assert!(safe_join("/p", "a/../../x.wav").is_none());
    }

    #[test]
    fn update_places_new_windows_without_moving_old_ones() {
        let l0 = synth(&[("a.wav", 0, 100), ("b.wav", 1, 100), ("c.wav", 2, 100)], 1);
        let old = assemble(&l0, project_2d(&l0.vecs, l0.rows.len(), DIM, &|_, _| {}));
        let centroid = |m: &MapData, f: &str| {
            let pts: Vec<usize> = (0..m.x.len()).filter(|&i| m.files[m.file[i] as usize] == f).collect();
            let c = pts.iter().fold((0.0, 0.0), |a, &i| (a.0 + m.x[i], a.1 + m.y[i]));
            (c.0 / pts.len() as f32, c.1 / pts.len() as f32)
        };
        // 10 neue Fenster der Art b in einer neuen Datei (sortiert zwischen b und c)
        let l1 = synth(&[("a.wav", 0, 100), ("b.wav", 1, 100), ("b2.wav", 1, 10), ("c.wav", 2, 100)], 1);
        let new = update_map(&old, &l1, &Default::default()).expect("kleine Aenderung → inkrementell");
        assert_eq!(new.placed_new, 10);
        assert_eq!(new.x.len(), 310);
        for f in ["a.wav", "b.wav", "c.wav"] {
            assert_eq!(centroid(&new, f), centroid(&old, f), "{f}: alte Punkte bleiben liegen");
        }
        let (bx, by) = centroid(&old, "b.wav");
        let d2 = |(x, y): (f32, f32), (u, v): (f32, f32)| (x - u).powi(2) + (y - v).powi(2);
        for i in (0..new.x.len()).filter(|&i| new.files[new.file[i] as usize] == "b2.wav") {
            let p = (new.x[i], new.y[i]);
            assert!(d2(p, (bx, by)) < d2(p, centroid(&old, "a.wav")) && d2(p, (bx, by)) < d2(p, centroid(&old, "c.wav")));
        }
        // Cluster der neuen Punkte = Cluster von b
        let cl = clusters_from_map(&new, Some(20));
        let b_label = cl.labels[(0..new.x.len()).find(|&i| new.files[new.file[i] as usize] == "b.wav" && cl.labels[i] >= 0).unwrap()];
        let b2: Vec<i32> = (0..new.x.len()).filter(|&i| new.files[new.file[i] as usize] == "b2.wav").map(|i| cl.nearest[i]).collect();
        assert!(b2.iter().all(|&c| c == b_label), "{b2:?} vs {b_label}");
        // Ein Drittel weg → zu viel, neues Layout
        let l2 = synth(&[("a.wav", 0, 100), ("b.wav", 1, 100)], 1);
        assert!(update_map(&old, &l2, &Default::default()).is_none());
    }

    #[test]
    fn nearest_centroid_assigns_by_direction() {
        let l = synth(&[("a.wav", 0, 20), ("b.wav", 1, 20)], 3);
        // je 15 im Cluster, Rest Rauschen
        let labels: Vec<i32> = (0..40).map(|i| if i % 20 < 15 { (i / 20) as i32 } else { -1 }).collect();
        let near = nearest_centroid(&l.vecs, &labels);
        let want: Vec<i32> = (0..40).map(|i| (i / 20) as i32).collect();
        assert_eq!(near, want);
        assert_eq!(nearest_centroid(&l.vecs, &vec![-1; 40]), vec![-1; 40]);
    }

    #[test]
    fn tree_assignment_skips_clusters_without_live_points() {
        // Layout: A = {0,1,2}, B = {3,4,5} (eng), Punkt 6 haengt an B (Rauschen).
        let e = |a: u32, b: u32, w: f32| (a, b, w);
        let mst = [e(0, 1, 0.1), e(1, 2, 0.1), e(2, 3, 5.0), e(3, 4, 0.1), e(4, 5, 0.1), e(5, 6, 10.0)];
        let c = hdbscan::cluster(7, &mst, 2);
        let (ca, cb) = (c.labels[0], c.labels[3]);
        assert!(ca >= 0 && cb >= 0 && ca != cb && c.labels[6] < 0, "{:?}", c.labels);
        // Lebende Kartenpunkte nur in A und am Rauschpunkt 6 (B wurde entfernt).
        let map = MapData {
            version: MAP_VERSION, stamp: 1, window: 5.0, layout_points: 7,
            files: vec!["a".into()], file: vec![0; 4], start: vec![0.0, 5.0, 10.0, 15.0],
            x: vec![0.0; 4], y: vec![0.0; 4], anchor: vec![0, 1, 2, 6],
            mst_a: mst.iter().map(|x| x.0).collect(), mst_b: mst.iter().map(|x| x.1).collect(),
            mst_w: mst.iter().map(|x| x.2).collect(),
            placed_new: 0, level: vec![], score: vec![], places: vec![], sigs: vec![],
        };
        let k = clusters_from_map(&map, Some(2));
        assert_eq!(k.labels[3], -1);
        assert_eq!(k.nearest[3], ca, "Rauschen geht zum lebenden Cluster, nicht zum leeren B");
        assert!(k.clusters.iter().all(|x| x.size > 0 && x.id != cb));
    }

    #[test]
    fn nearest_centroid_skips_empty_cluster_ids() {
        // Cluster 0 hat keine Mitglieder mehr; ein Punkt, der von Cluster 1 weg zeigt,
        // haette gegen den Nullvektor (Kosinus 0) „gewonnen“.
        let mut vecs = vec![0f32; 3 * DIM];
        vecs[0] = 1.0; // Mitglied von Cluster 1
        vecs[DIM] = 1.0; // zweites Mitglied
        vecs[2 * DIM] = -1.0; // Rauschen, entgegengesetzt
        assert_eq!(nearest_centroid(&vecs, &[1, 1, -1]), vec![1, 1, 1]);
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
        let Projection { layout_points: m, .. } = project_2d(&x, n, dim, &|ph, f| if f == 0.0 { eprintln!("{:>6.1}s {ph}", t.elapsed().as_secs_f32()) });
        eprintln!("{n} Punkte ({m} Layout) in {:.1}s", t.elapsed().as_secs_f32());
    }

    /// Karte eines echten Projekts: EMBED_MAP_DIR=<projekt> cargo test --release --lib real_store -- --ignored
    #[test]
    #[ignore]
    fn real_store() {
        let root = std::env::var("EMBED_MAP_DIR").unwrap();
        let t0 = std::time::Instant::now();
        let last = std::sync::Mutex::new("");
        let m = build_map(&EmbedState::default(), &root, true, &|phase, _| {
            let mut l = last.lock().unwrap();
            if *l != phase {
                eprintln!("{:7.1} s  {phase}", t0.elapsed().as_secs_f64());
                *l = phase;
            }
        })
        .unwrap();
        eprintln!("{:7.1} s  fertig ({} Punkte, Layout auf {})", t0.elapsed().as_secs_f64(), m.x.len(), m.layout_points);
        let t1 = std::time::Instant::now();
        let _ = clusters_from_map(&m, None);
        eprintln!("HDBSCAN aus dem Cache: {:.2} s", t1.elapsed().as_secs_f64());
        assert_eq!(m.x.len(), m.start.len());
        for mcs in [3, 8, 12, 20] {
            let c = clusters_from_map(&m, Some(mcs));
            eprintln!("min {mcs}: {:?} Rauschen {}", c.clusters.iter().map(|x| x.size).collect::<Vec<_>>(), c.noise);
        }
        let c = clusters_from_map(&m, None);
        if let Ok(dump) = std::env::var("EMBED_MAP_DUMP") {
            std::fs::write(dump, serde_json::to_vec(&c).unwrap()).unwrap();
        }
        let sizes: Vec<usize> = c.clusters.iter().map(|x| x.size).collect();
        eprintln!("Cluster (min {}): {sizes:?}, Rauschen {}", c.min_cluster_size, c.noise);
        for cl in &c.clusters {
            let mut by: std::collections::BTreeMap<&str, usize> = Default::default();
            for (i, &l) in c.labels.iter().enumerate() {
                if l == cl.id {
                    *by.entry(m.files[m.file[i] as usize].split('/').next().unwrap()).or_default() += 1;
                }
            }
            eprintln!("  #{}: {by:?}", cl.id);
        }
        // Rauschen → naechster Cluster: passt die Art (oberster Ordner) zur Mehrheit des Clusters?
        let top = |i: usize| m.files[m.file[i] as usize].split('/').next().unwrap();
        let major: Vec<&str> = c
            .clusters
            .iter()
            .map(|cl| {
                let mut by: std::collections::BTreeMap<&str, usize> = Default::default();
                c.labels.iter().enumerate().filter(|(_, &l)| l == cl.id).for_each(|(i, _)| *by.entry(top(i)).or_default() += 1);
                by.into_iter().max_by_key(|x| x.1).map_or("", |x| x.0)
            })
            .collect();
        let noise: Vec<usize> = (0..m.x.len()).filter(|&i| c.labels[i] < 0).collect();
        let assigned = noise.iter().filter(|&&i| c.nearest[i] >= 0).count();
        let right = noise.iter().filter(|&&i| c.nearest[i] >= 0 && major[c.nearest[i] as usize] == top(i)).count();
        eprintln!("Rauschen {}: {} zugeordnet, davon {} zur Mehrheitsart des Clusters ({:.2})", noise.len(), assigned, right, right as f64 / assigned.max(1) as f64);
        eprintln!("{} Punkte, {} Dateien -> {}", m.x.len(), m.files.len(), map_path(&root).display());
    }
}

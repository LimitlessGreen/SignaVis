//! Agiles Modellieren auf Perch-2-Embeddings (Phase 1, SignaVis-Plattform).
//!
//! - Labels pro Klasse: Fenster (Pfad + Startzeit) als pos / neg / unsure,
//!   gespeichert in `.signavis/agile/labels.json`.
//! - Linearer Klassifikator (logistische Regression auf normierten
//!   Embeddings), gespeichert in `.signavis/agile/classifiers/<klasse>.json`.
//! - Ranking aller Fenster (oberste Scores oder unsicherste fuer aktive Auswahl).
//! - Export der Detektionen ueber einem Schwellwert als Raven-Tabelle oder CSV.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use aw_embed::{DIM, SAMPLE_RATE, WINDOW};

use crate::embeddings::{find_row, with_loaded, EmbedState, Loaded};

const AGILE_DIR: &str = ".signavis/agile";

fn window_s() -> f64 {
    WINDOW as f64 / SAMPLE_RATE as f64
}

fn agile_dir(root: &str) -> PathBuf {
    PathBuf::from(root).join(AGILE_DIR)
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("kein Ordner")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

// ── Labels ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub path: String,
    pub start: f64,
    /// "pos" | "neg" | "unsure"
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgileClass {
    pub name: String,
    #[serde(default)]
    pub examples: Vec<Example>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LabelsFile {
    pub version: u32,
    #[serde(default)]
    pub classes: Vec<AgileClass>,
}

impl Default for LabelsFile {
    fn default() -> Self {
        Self { version: 1, classes: vec![] }
    }
}

fn labels_path(root: &str) -> PathBuf {
    agile_dir(root).join("labels.json")
}

fn read_labels(root: &str) -> LabelsFile {
    std::fs::read(labels_path(root))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_labels(root: &str, f: &LabelsFile) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(f).map_err(|e| e.to_string())?;
    write_atomic(&labels_path(root), &json)
}

fn valid_class_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.len() > 120 {
        return Err("Klassenname leer oder zu lang".into());
    }
    Ok(n.to_string())
}

#[tauri::command]
pub fn agile_labels(root: String) -> LabelsFile {
    read_labels(&root)
}

#[tauri::command]
pub fn agile_class_add(root: String, name: String) -> Result<LabelsFile, String> {
    let name = valid_class_name(&name)?;
    let mut f = read_labels(&root);
    if !f.classes.iter().any(|c| c.name == name) {
        f.classes.push(AgileClass { name, examples: vec![] });
        write_labels(&root, &f)?;
    }
    Ok(f)
}

#[tauri::command]
pub fn agile_class_remove(root: String, name: String) -> Result<LabelsFile, String> {
    let mut f = read_labels(&root);
    f.classes.retain(|c| c.name != name);
    write_labels(&root, &f)?;
    let _ = std::fs::remove_file(classifier_path(&root, &name));
    Ok(f)
}

/// Label eines Fensters setzen; `label` = None entfernt es.
/// Gleiche Fenster (Pfad, Start auf 1 ms) werden ersetzt.
#[tauri::command]
pub fn agile_label_set(
    root: String,
    class: String,
    path: String,
    start: f64,
    label: Option<String>,
) -> Result<LabelsFile, String> {
    if let Some(l) = &label {
        if !matches!(l.as_str(), "pos" | "neg" | "unsure") {
            return Err(format!("Unbekanntes Label: {l}"));
        }
    }
    let class = valid_class_name(&class)?;
    let mut f = read_labels(&root);
    if !f.classes.iter().any(|c| c.name == class) {
        f.classes.push(AgileClass { name: class.clone(), examples: vec![] });
    }
    let c = f.classes.iter_mut().find(|c| c.name == class).unwrap();
    c.examples.retain(|e| !(e.path == path && (e.start - start).abs() < 1e-3));
    if let Some(label) = label {
        c.examples.push(Example { path, start, label });
    }
    write_labels(&root, &f)?;
    Ok(f)
}

#[derive(Deserialize)]
pub struct WindowRef {
    path: String,
    start: f64,
}

/// Label fuer viele Fenster auf einmal setzen (Lasso auf der Karte); `None` entfernt.
#[tauri::command]
pub fn agile_label_set_many(
    root: String,
    class: String,
    items: Vec<WindowRef>,
    label: Option<String>,
) -> Result<LabelsFile, String> {
    if let Some(l) = &label {
        if !matches!(l.as_str(), "pos" | "neg" | "unsure") {
            return Err(format!("Unbekanntes Label: {l}"));
        }
    }
    let class = valid_class_name(&class)?;
    let mut f = read_labels(&root);
    if !f.classes.iter().any(|c| c.name == class) {
        f.classes.push(AgileClass { name: class.clone(), examples: vec![] });
    }
    let c = f.classes.iter_mut().find(|c| c.name == class).unwrap();
    let same = |e: &Example, w: &WindowRef| e.path == w.path && (e.start - w.start).abs() < 1e-3;
    c.examples.retain(|e| !items.iter().any(|w| same(e, w)));
    if let Some(label) = label {
        c.examples.extend(items.into_iter().map(|w| Example { path: w.path, start: w.start, label: label.clone() }));
    }
    write_labels(&root, &f)?;
    Ok(f)
}

// ── Klassifikator ─────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Classifier {
    pub version: u32,
    pub class: String,
    pub dim: usize,
    pub weights: Vec<f32>,
    pub bias: f32,
    pub positives: usize,
    pub negatives: usize,
    /// Zufaellige ungelabelte Fenster, die als schwache Negative dienten.
    pub background: usize,
    pub trained_at: String,
}

fn safe_file_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
}

fn classifier_path(root: &str, class: &str) -> PathBuf {
    agile_dir(root).join("classifiers").join(format!("{}.json", safe_file_name(class)))
}

fn read_classifier(root: &str, class: &str) -> Option<Classifier> {
    let b = std::fs::read(classifier_path(root, class)).ok()?;
    serde_json::from_slice(&b).ok()
}

fn sigmoid(z: f32) -> f32 {
    1.0 / (1.0 + (-z).exp())
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Logistische Regression (L2, Adam, Vollbatch), Klassen gewichtet.
/// `x`: Zeilen der Laenge DIM, `y`: 0/1, `w`: Beispielgewicht.
fn fit_logreg(x: &[&[f32]], y: &[f32], sw: &[f32], l2: f32, iters: usize) -> (Vec<f32>, f32) {
    let n = x.len();
    let mut w = vec![0f32; DIM];
    let mut b = 0f32;
    let (mut mw, mut vw) = (vec![0f32; DIM], vec![0f32; DIM]);
    let (mut mb, mut vb) = (0f32, 0f32);
    let (b1, b2, lr, eps) = (0.9f32, 0.999f32, 0.05f32, 1e-8f32);
    let total: f32 = sw.iter().sum::<f32>().max(1e-6);
    let mut gw = vec![0f32; DIM];
    for t in 1..=iters {
        gw.iter_mut().for_each(|g| *g = 0.0);
        let mut gb = 0f32;
        for i in 0..n {
            let p = sigmoid(dot(&w, x[i]) + b);
            let d = (p - y[i]) * sw[i] / total;
            gb += d;
            for (g, xi) in gw.iter_mut().zip(x[i]) {
                *g += d * xi;
            }
        }
        for (g, wi) in gw.iter_mut().zip(&w) {
            *g += l2 * wi;
        }
        let (c1, c2) = (1.0 - b1.powi(t as i32), 1.0 - b2.powi(t as i32));
        for k in 0..DIM {
            mw[k] = b1 * mw[k] + (1.0 - b1) * gw[k];
            vw[k] = b2 * vw[k] + (1.0 - b2) * gw[k] * gw[k];
            w[k] -= lr * (mw[k] / c1) / ((vw[k] / c2).sqrt() + eps);
        }
        mb = b1 * mb + (1.0 - b1) * gb;
        vb = b2 * vb + (1.0 - b2) * gb * gb;
        b -= lr * (mb / c1) / ((vb / c2).sqrt() + eps);
    }
    (w, b)
}

/// Kleiner deterministischer Zufall (xorshift) fuer Hintergrundfenster und Folds.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

struct TrainSet {
    rows: Vec<usize>,
    y: Vec<f32>,
    sw: Vec<f32>,
    /// true = explizit gelabelt (zaehlt fuer die Kreuzvalidierung)
    labeled: Vec<bool>,
    positives: usize,
    negatives: usize,
    background: usize,
    missing: usize,
}

fn build_set(l: &Loaded, class: &AgileClass, use_background: bool) -> TrainSet {
    let mut s = TrainSet { rows: vec![], y: vec![], sw: vec![], labeled: vec![], positives: 0, negatives: 0, background: 0, missing: 0 };
    let mut seen: HashMap<usize, ()> = HashMap::new();
    for e in &class.examples {
        let y = match e.label.as_str() {
            "pos" => 1.0,
            "neg" => 0.0,
            _ => continue,
        };
        match find_row(l, &e.path, e.start + 1e-3) {
            Some(r) if !seen.contains_key(&r) => {
                seen.insert(r, ());
                s.rows.push(r);
                s.y.push(y);
                s.labeled.push(true);
                if y > 0.5 { s.positives += 1 } else { s.negatives += 1 }
            }
            Some(_) => {}
            None => s.missing += 1,
        }
    }
    // Gelabelte Fenster (auch "unsure") nie als Hintergrund ziehen.
    for e in &class.examples {
        if let Some(r) = find_row(l, &e.path, e.start + 1e-3) {
            seen.insert(r, ());
        }
    }
    let n_rows = l.rows.len();
    // Hintergrund nur als Notbehelf: ungelabelte Fenster enthalten auch Positive
    // und kosten Recall (Realtest Sperlingskauz: 100 % -> 77 %). Daher nur, bis
    // explizite + Hintergrund-Negative das Doppelte der Positiven erreichen.
    let need = (s.positives * 2).max(20).saturating_sub(s.negatives);
    if use_background && s.positives > 0 && need > 0 && n_rows > seen.len() {
        let want = need.min(n_rows - seen.len());
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ n_rows as u64);
        let mut tries = 0;
        while s.background < want && tries < want * 20 {
            tries += 1;
            let r = (rng.next() % n_rows as u64) as usize;
            if seen.insert(r, ()).is_none() {
                s.rows.push(r);
                s.y.push(0.0);
                s.labeled.push(false);
                s.background += 1;
            }
        }
    }
    // Klassen ausgleichen; Hintergrund schwaecher als explizite Negative.
    let pos_w = 1.0 / s.positives.max(1) as f32;
    let neg_total = s.negatives as f32 + 0.3 * s.background as f32;
    let neg_w = 1.0 / neg_total.max(1.0);
    for i in 0..s.rows.len() {
        let w = if s.y[i] > 0.5 { pos_w } else if s.labeled[i] { neg_w } else { 0.3 * neg_w };
        s.sw.push(w);
    }
    s
}

const L2: f32 = 1e-3;
const ITERS: usize = 300;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainResult {
    positives: usize,
    negatives: usize,
    background: usize,
    /// Gelabelte Fenster ohne Embedding (Datei fehlt / noch nicht berechnet).
    missing: usize,
    /// 5-fach-Kreuzvalidierung auf den explizit gelabelten Beispielen (Schwelle 0,5).
    cv_accuracy: Option<f32>,
    cv_precision: Option<f32>,
    cv_recall: Option<f32>,
}

#[tauri::command]
pub async fn agile_train(
    state: tauri::State<'_, EmbedState>,
    root: String,
    class: String,
    use_background: Option<bool>,
) -> Result<TrainResult, String> {
    let labels = read_labels(&root);
    let c = labels.classes.iter().find(|c| c.name == class).ok_or("Klasse nicht gefunden")?.clone();
    let use_background = use_background.unwrap_or(true);
    let (clf, result) = with_loaded(&state, &root, |l| -> Result<(Classifier, TrainResult), String> {
        let set = build_set(l, &c, use_background);
        if set.positives == 0 {
            return Err("Mindestens ein positives Beispiel noetig".into());
        }
        if set.negatives + set.background == 0 {
            return Err("Mindestens ein negatives Beispiel noetig".into());
        }
        let xs: Vec<&[f32]> = set.rows.iter().map(|&r| &l.vecs[r * DIM..(r + 1) * DIM]).collect();

        // Kreuzvalidierung nur, wenn genug explizite Beispiele beider Klassen.
        let (mut cv_acc, mut cv_p, mut cv_r) = (None, None, None);
        if set.positives >= 3 && set.negatives >= 3 {
            let mut rng = Rng(0xC0FF_EE00_1234_5678);
            let fold: Vec<usize> = (0..xs.len()).map(|_| (rng.next() % 5) as usize).collect();
            let (mut tp, mut fp, mut tn, mut fneg) = (0u32, 0u32, 0u32, 0u32);
            for k in 0..5 {
                let tr: Vec<usize> = (0..xs.len()).filter(|&i| fold[i] != k || !set.labeled[i]).collect();
                let te: Vec<usize> = (0..xs.len()).filter(|&i| fold[i] == k && set.labeled[i]).collect();
                if te.is_empty() {
                    continue;
                }
                let (w, b) = fit_logreg(
                    &tr.iter().map(|&i| xs[i]).collect::<Vec<_>>(),
                    &tr.iter().map(|&i| set.y[i]).collect::<Vec<_>>(),
                    &tr.iter().map(|&i| set.sw[i]).collect::<Vec<_>>(),
                    L2,
                    ITERS,
                );
                for &i in &te {
                    let pred = sigmoid(dot(&w, xs[i]) + b) >= 0.5;
                    match (pred, set.y[i] > 0.5) {
                        (true, true) => tp += 1,
                        (true, false) => fp += 1,
                        (false, false) => tn += 1,
                        (false, true) => fneg += 1,
                    }
                }
            }
            let n = (tp + fp + tn + fneg) as f32;
            if n > 0.0 {
                cv_acc = Some((tp + tn) as f32 / n);
                cv_p = (tp + fp > 0).then(|| tp as f32 / (tp + fp) as f32);
                cv_r = (tp + fneg > 0).then(|| tp as f32 / (tp + fneg) as f32);
            }
        }

        let (weights, bias) = fit_logreg(&xs, &set.y, &set.sw, L2, ITERS);
        let clf = Classifier {
            version: 1,
            class: c.name.clone(),
            dim: DIM,
            weights,
            bias,
            positives: set.positives,
            negatives: set.negatives,
            background: set.background,
            trained_at: chrono_now(),
        };
        let res = TrainResult {
            positives: set.positives,
            negatives: set.negatives,
            background: set.background,
            missing: set.missing,
            cv_accuracy: cv_acc,
            cv_precision: cv_p,
            cv_recall: cv_r,
        };
        Ok((clf, res))
    })??;
    let json = serde_json::to_vec(&clf).map_err(|e| e.to_string())?;
    write_atomic(&classifier_path(&root, &class), &json)?;
    Ok(result)
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

// ── Ranking ───────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankHit {
    path: String,
    start: f64,
    end: f64,
    score: f32,
    /// Vorhandenes Label dieses Fensters in der Klasse.
    label: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankResult {
    hits: Vec<RankHit>,
    /// Fenster mit Score >= threshold.
    above: usize,
    total: usize,
    trained: bool,
    trained_at: Option<String>,
}

fn scores_for(l: &Loaded, clf: &Classifier) -> Vec<f32> {
    l.vecs.chunks_exact(DIM).map(|v| sigmoid(dot(&clf.weights, v) + clf.bias)).collect()
}

/// `mode`: "top" (hoechste Scores), "uncertain" (nahe Schwelle) oder "random".
/// Bereits gelabelte Fenster werden bei `skip_labeled` ausgelassen.
#[tauri::command]
pub async fn agile_rank(
    state: tauri::State<'_, EmbedState>,
    root: String,
    class: String,
    mode: Option<String>,
    k: Option<usize>,
    threshold: Option<f32>,
    skip_labeled: Option<bool>,
) -> Result<RankResult, String> {
    let k = k.unwrap_or(50).clamp(1, 2000);
    let thr = threshold.unwrap_or(0.5);
    let skip = skip_labeled.unwrap_or(true);
    let mode = mode.unwrap_or_else(|| "top".into());
    let clf = read_classifier(&root, &class).ok_or("Noch kein Klassifikator trainiert")?;
    if clf.dim != DIM {
        return Err("Klassifikator passt nicht zum Embedding-Modell".into());
    }
    let labels = read_labels(&root);
    let examples: Vec<Example> = labels.classes.iter().find(|c| c.name == class).map(|c| c.examples.clone()).unwrap_or_default();
    with_loaded(&state, &root, |l| {
        let scores = scores_for(l, &clf);
        let mut labeled: HashMap<usize, String> = HashMap::new();
        for e in &examples {
            if let Some(r) = find_row(l, &e.path, e.start + 1e-3) {
                labeled.insert(r, e.label.clone());
            }
        }
        let above = scores.iter().filter(|&&s| s >= thr).count();
        let cand = (0..scores.len()).filter(|i| !skip || !labeled.contains_key(i));
        let picked: Vec<usize> = match mode.as_str() {
            "uncertain" => {
                let mut v: Vec<usize> = cand.collect();
                v.sort_by(|&a, &b| (scores[a] - thr).abs().total_cmp(&(scores[b] - thr).abs()));
                v.truncate(k);
                v
            }
            "random" => {
                let v: Vec<usize> = cand.collect();
                let mut rng = Rng(0xABCD_EF01 ^ v.len() as u64 ^ clf.trained_at.len() as u64);
                let mut out = Vec::new();
                let mut used = std::collections::HashSet::new();
                while out.len() < k.min(v.len()) {
                    let i = v[(rng.next() % v.len() as u64) as usize];
                    if used.insert(i) {
                        out.push(i);
                    }
                }
                out
            }
            _ => {
                let mut v: Vec<usize> = cand.collect();
                let kk = k.min(v.len());
                if kk > 0 {
                    v.select_nth_unstable_by(kk - 1, |&a, &b| scores[b].total_cmp(&scores[a]));
                    v.truncate(kk);
                    v.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]));
                }
                v
            }
        };
        let w = window_s();
        RankResult {
            hits: picked
                .into_iter()
                .map(|i| RankHit {
                    path: l.rows[i].path.clone(),
                    start: l.rows[i].start,
                    end: l.rows[i].start + w,
                    score: scores[i],
                    label: labeled.get(&i).cloned(),
                })
                .collect(),
            above,
            total: scores.len(),
            trained: true,
            trained_at: Some(clf.trained_at.clone()),
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifierInfo {
    trained: bool,
    positives: usize,
    negatives: usize,
    background: usize,
    trained_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoresOut {
    stamp: u64,
    /// Ein Score pro Fenster, in der Reihenfolge der Karte (embed_map).
    scores: Vec<f32>,
}

/// Klassifikator-Scores fuer alle Fenster (Faerbung der Karte).
#[tauri::command]
pub async fn agile_scores(state: tauri::State<'_, EmbedState>, root: String, class: String) -> Result<ScoresOut, String> {
    let clf = read_classifier(&root, &class).ok_or("Noch kein Klassifikator trainiert")?;
    if clf.dim != DIM {
        return Err("Klassifikator passt nicht zum Embedding-Modell".into());
    }
    with_loaded(&state, &root, |l| ScoresOut { stamp: l.stamp, scores: scores_for(l, &clf) })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Suspect {
    path: String,
    start: f64,
    label: String,
    /// Anteil der naechsten gelabelten Nachbarn mit dem anderen Label.
    other_frac: f32,
    neighbours: usize,
    /// Klassifikator-Score, falls trainiert.
    score: Option<f32>,
}

/// Moegliche Fehllabel einer Klasse: positive/negative Beispiele, deren
/// naechste gelabelte Nachbarn (Kosinus, volle Embeddings) mehrheitlich das
/// andere Label tragen oder die der Klassifikator deutlich anders sieht.
pub(crate) fn find_suspects(l: &Loaded, examples: &[Example], clf: Option<&Classifier>, k: usize) -> Vec<Suspect> {
    let lab: Vec<(&Example, usize)> = examples
        .iter()
        .filter(|e| e.label == "pos" || e.label == "neg")
        .filter_map(|e| find_row(l, &e.path, e.start).map(|r| (e, r)))
        .collect();
    let vec = |r: usize| &l.vecs[r * DIM..(r + 1) * DIM];
    let mut out = Vec::new();
    for (i, &(e, r)) in lab.iter().enumerate() {
        let mut sims: Vec<(f32, bool)> = lab
            .iter()
            .enumerate()
            .filter(|&(j, _)| j != i)
            .map(|(_, &(o, ro))| (dot(vec(r), vec(ro)), o.label != e.label))
            .collect();
        sims.sort_by(|a, b| b.0.total_cmp(&a.0));
        sims.truncate(k);
        let nb = sims.len();
        let other = sims.iter().filter(|x| x.1).count();
        let other_frac = if nb > 0 { other as f32 / nb as f32 } else { 0.0 };
        let score = clf.map(|c| sigmoid(dot(&c.weights, vec(r)) + c.bias));
        let by_neighbours = nb >= 3 && other_frac >= 0.6;
        let by_score = match (e.label.as_str(), score) {
            ("pos", Some(s)) => s < 0.2,
            ("neg", Some(s)) => s > 0.8,
            _ => false,
        };
        if by_neighbours || by_score {
            out.push(Suspect { path: e.path.clone(), start: e.start, label: e.label.clone(), other_frac, neighbours: nb, score });
        }
    }
    let severity = |s: &Suspect| {
        let disagree = s.score.map_or(0.0, |v| if s.label == "pos" { 1.0 - v } else { v });
        s.other_frac + disagree
    };
    out.sort_by(|a, b| severity(b).total_cmp(&severity(a)));
    out
}

#[tauri::command]
pub async fn agile_suspects(
    state: tauri::State<'_, EmbedState>,
    root: String,
    class: String,
    k: Option<usize>,
) -> Result<Vec<Suspect>, String> {
    let labels = read_labels(&root);
    let examples = labels.classes.iter().find(|c| c.name == class).map(|c| c.examples.clone()).unwrap_or_default();
    let clf = read_classifier(&root, &class).filter(|c| c.dim == DIM);
    with_loaded(&state, &root, |l| find_suspects(l, &examples, clf.as_ref(), k.unwrap_or(5).clamp(3, 25)))
}

#[tauri::command]
pub fn agile_classifier_info(root: String, class: String) -> ClassifierInfo {
    match read_classifier(&root, &class) {
        Some(c) => ClassifierInfo {
            trained: true,
            positives: c.positives,
            negatives: c.negatives,
            background: c.background,
            trained_at: Some(c.trained_at),
        },
        None => ClassifierInfo { trained: false, positives: 0, negatives: 0, background: 0, trained_at: None },
    }
}

// ── Export ────────────────────────────────────────────────────────────

/// Detektionen (Score >= threshold) als `raven` (Selection Table, eine pro
/// Projekt mit Spalte "Begin File") oder `csv` nach `dest` schreiben.
/// Aufeinanderfolgende Fenster derselben Datei werden zu einer Detektion
/// zusammengefasst, wenn `merge` gesetzt ist. Gibt die Zeilenzahl zurueck.
#[tauri::command]
pub async fn agile_export(
    state: tauri::State<'_, EmbedState>,
    root: String,
    class: String,
    threshold: f32,
    format: String,
    dest: String,
    merge: Option<bool>,
) -> Result<usize, String> {
    let clf = read_classifier(&root, &class).ok_or("Noch kein Klassifikator trainiert")?;
    let merge = merge.unwrap_or(true);
    let w = window_s();
    let dets: Vec<(String, f64, f64, f32)> = with_loaded(&state, &root, |l| {
        let scores = scores_for(l, &clf);
        let mut by_file: BTreeMap<&str, Vec<(f64, f32)>> = BTreeMap::new();
        for (i, s) in scores.iter().enumerate() {
            if *s >= threshold {
                by_file.entry(l.rows[i].path.as_str()).or_default().push((l.rows[i].start, *s));
            }
        }
        let mut out = Vec::new();
        for (path, mut v) in by_file {
            v.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut cur: Option<(f64, f64, f32)> = None;
            for (start, s) in v {
                let end = start + w;
                cur = match cur {
                    Some((a, b, m)) if merge && start <= b + 1e-6 => Some((a, end.max(b), m.max(s))),
                    Some((a, b, m)) => {
                        out.push((path.to_string(), a, b, m));
                        Some((start, end, s))
                    }
                    None => Some((start, end, s)),
                };
            }
            if let Some((a, b, m)) = cur {
                out.push((path.to_string(), a, b, m));
            }
        }
        out
    })?;
    let mut text = String::new();
    match format.as_str() {
        "raven" => {
            text.push_str("Selection\tView\tChannel\tBegin Time (s)\tEnd Time (s)\tLow Freq (Hz)\tHigh Freq (Hz)\tBegin File\tSpecies\tScore\n");
            for (i, (p, a, b, s)) in dets.iter().enumerate() {
                text.push_str(&format!(
                    "{}\tSpectrogram 1\t1\t{a:.3}\t{b:.3}\t0\t{}\t{}\t{}\t{s:.4}\n",
                    i + 1,
                    SAMPLE_RATE / 2,
                    p.replace('\t', " "),
                    class.replace('\t', " ")
                ));
            }
        }
        "csv" => {
            let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
            text.push_str("file,start_s,end_s,class,score\n");
            for (p, a, b, s) in &dets {
                text.push_str(&format!("{},{a:.3},{b:.3},{},{s:.4}\n", q(p), q(&class)));
            }
        }
        f => return Err(format!("Unbekanntes Format: {f}")),
    }
    std::fs::write(&dest, text).map_err(|e| format!("write {dest}: {e}"))?;
    Ok(dets.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logreg_separates() {
        // zwei Cluster entlang Achse 0 / 1
        let mut rows = Vec::new();
        for i in 0..20 {
            let mut v = vec![0f32; DIM];
            v[if i % 2 == 0 { 0 } else { 1 }] = 1.0;
            v[2] = (i as f32) * 0.01;
            rows.push(v);
        }
        let xs: Vec<&[f32]> = rows.iter().map(|v| v.as_slice()).collect();
        let y: Vec<f32> = (0..20).map(|i| if i % 2 == 0 { 1.0 } else { 0.0 }).collect();
        let sw = vec![1.0; 20];
        let (w, b) = fit_logreg(&xs, &y, &sw, L2, ITERS);
        for (x, t) in xs.iter().zip(&y) {
            assert_eq!(sigmoid(dot(&w, x) + b) >= 0.5, *t > 0.5);
        }
    }

    /// Realtest: AGILE_TEST_DIR = Projekt mit Unterordnern pro Art (Embeddings
    /// vorher per embeddings::tests::job_end_to_end berechnet), AGILE_TEST_CLASS = Ordner.
    /// Trainiert auf jeder zweiten Datei (Rest Negative), wertet auf dem Rest aus.
    #[test]
    #[ignore]
    fn real_holdout() {
        let root = std::env::var("AGILE_TEST_DIR").unwrap();
        let target = std::env::var("AGILE_TEST_CLASS").unwrap();
        let state = EmbedState::default();
        with_loaded(&state, &root, |l| {
            let mut class = AgileClass { name: target.clone(), examples: vec![] };
            let mut test = vec![];
            for (i, r) in l.rows.iter().enumerate() {
                let pos = r.path.starts_with(&format!("{target}/"));
                if i % 2 == 0 {
                    class.examples.push(Example { path: r.path.clone(), start: r.start, label: if pos { "pos" } else { "neg" }.into() });
                } else {
                    test.push((i, pos));
                }
            }
            for bg in [false, true] {
                let set = build_set(l, &class, bg);
                let xs: Vec<&[f32]> = set.rows.iter().map(|&r| &l.vecs[r * DIM..(r + 1) * DIM]).collect();
                let t = std::time::Instant::now();
                let (w, b) = fit_logreg(&xs, &set.y, &set.sw, L2, ITERS);
                let ms = t.elapsed().as_millis();
                let (mut tp, mut fp, mut tn, mut fneg) = (0, 0, 0, 0);
                for &(i, pos) in &test {
                    let p = sigmoid(dot(&w, &l.vecs[i * DIM..(i + 1) * DIM]) + b) >= 0.5;
                    match (p, pos) {
                        (true, true) => tp += 1,
                        (true, false) => fp += 1,
                        (false, false) => tn += 1,
                        (false, true) => fneg += 1,
                    }
                }
                eprintln!(
                    "{target} bg={bg}: train {}+/{}-/{}bg in {ms} ms | test tp {tp} fp {fp} tn {tn} fn {fneg} | acc {:.3}",
                    set.positives, set.negatives, set.background,
                    (tp + tn) as f32 / test.len() as f32
                );
                assert!((tp + tn) as f32 / test.len() as f32 > 0.8);
            }
        })
        .unwrap();
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_file_name("Aegolius funereus"), "Aegolius funereus");
        assert_eq!(safe_file_name("a/b:c"), "a_b_c");
    }

    #[test]
    fn suspects_flags_label_among_other_label() {
        // zwei Gruppen entlang Achse 0 / 1; ein "pos" mitten in den negativen
        let mut vecs = vec![];
        let mut rows = vec![];
        let mut ex = vec![];
        for i in 0..12 {
            let mut v = vec![0.0f32; DIM];
            let axis = if i < 6 { 0 } else { 1 };
            v[axis] = 1.0;
            v[2] = 0.01 * i as f32;
            let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            v.iter_mut().for_each(|x| *x /= n);
            vecs.extend(v);
            let path = format!("f{i}.wav");
            rows.push(crate::embeddings::RowRef { path: path.clone(), start: 0.0 });
            let label = if i < 6 { "pos" } else if i == 11 { "pos" } else { "neg" };
            ex.push(Example { path, start: 0.0, label: label.into() });
        }
        let l = Loaded { root: "x".into(), stamp: 1, rows, vecs };
        let s = find_suspects(&l, &ex, None, 5);
        assert_eq!(s.len(), 1, "{s:?}");
        assert_eq!(s[0].path, "f11.wav");
    }
}

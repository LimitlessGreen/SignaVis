//! Import preview: what a profile makes of a scanned folder, before anything is written.

use crate::{ImportProfile, resolve, scan::ScanResult};
use chrono::{NaiveDateTime, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRow {
    pub path: String,
    pub pattern: Option<usize>,
    pub site: Option<String>,
    pub device: Option<String>,
    /// Local clock, ISO without zone.
    pub start: Option<String>,
    pub meta: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedGroup {
    pub dir: String,
    pub count: usize,
    pub example: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub site: Option<String>,
    pub device: Option<String>,
    pub files: usize,
    pub bytes: u64,
    pub first: Option<String>,
    pub last: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// no-start | implausible-time | duplicate-time
    pub kind: String,
    pub count: usize,
    pub examples: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub audio_files: usize,
    pub audio_bytes: u64,
    pub selection_tables: usize,
    pub skipped_dirs: Vec<String>,
    pub per_pattern: Vec<usize>,
    pub unmatched: usize,
    pub unmatched_groups: Vec<UnmatchedGroup>,
    pub groups: Vec<GroupSummary>,
    pub issues: Vec<Issue>,
    pub samples: Vec<SampleRow>,
}

const MAX_EXAMPLES: usize = 5;

fn issue(map: &mut BTreeMap<&'static str, (usize, Vec<String>)>, kind: &'static str, path: &str) {
    let e = map.entry(kind).or_default();
    e.0 += 1;
    if e.1.len() < MAX_EXAMPLES { e.1.push(path.to_string()); }
}

pub fn preview(scan: &ScanResult, profile: &ImportProfile, n_samples: usize) -> Preview {
    let mut per_pattern = vec![0; profile.patterns.0.len()];
    let mut unmatched: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut groups: BTreeMap<(Option<String>, Option<String>), (usize, u64, Option<NaiveDateTime>, Option<NaiveDateTime>)> = BTreeMap::new();
    let mut issues = BTreeMap::new();
    let mut seen: HashMap<(Option<String>, NaiveDateTime), String> = HashMap::new();
    let mut samples = Vec::new();
    let step = (scan.audio.len() / n_samples.max(1)).max(1);
    let now = Utc::now().naive_utc() + chrono::Duration::days(1);
    let min = NaiveDateTime::parse_from_str("2000-01-01 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap();

    for (i, f) in scan.audio.iter().enumerate() {
        let m = profile.patterns.matches(&f.rel_path);
        let Some((pi, m)) = m else {
            let dir = f.rel_path.rsplit_once('/').map_or("", |(d, _)| d).to_string();
            let e = unmatched.entry(dir).or_insert((0, f.rel_path.clone()));
            e.0 += 1;
            if i % step == 0 && samples.len() < n_samples {
                samples.push(SampleRow { path: f.rel_path.clone(), pattern: None, site: None, device: None, start: None, meta: vec![] });
            }
            continue;
        };
        per_pattern[pi] += 1;
        let r = resolve(profile, &m);
        match r.start {
            None => issue(&mut issues, "no-start", &f.rel_path),
            Some(t) if t < min || t > now => issue(&mut issues, "implausible-time", &f.rel_path),
            Some(t) => {
                if let Some(prev) = seen.insert((r.device.clone(), t), f.rel_path.clone()) {
                    issue(&mut issues, "duplicate-time", &format!("{prev} = {}", f.rel_path));
                }
            }
        }
        let g = groups.entry((r.site.clone(), r.device.clone())).or_insert((0, 0, None, None));
        g.0 += 1;
        g.1 += f.size;
        if let Some(t) = r.start {
            g.2 = Some(g.2.map_or(t, |x: NaiveDateTime| x.min(t)));
            g.3 = Some(g.3.map_or(t, |x: NaiveDateTime| x.max(t)));
        }
        if i % step == 0 && samples.len() < n_samples {
            samples.push(SampleRow {
                path: f.rel_path.clone(), pattern: Some(pi), site: r.site, device: r.device,
                start: r.start.map(|t| t.format("%Y-%m-%dT%H:%M:%S").to_string()), meta: r.meta,
            });
        }
    }

    let mut unmatched_groups: Vec<_> = unmatched.into_iter()
        .map(|(dir, (count, example))| UnmatchedGroup { dir, count, example }).collect();
    unmatched_groups.sort_by(|a, b| b.count.cmp(&a.count));
    let fmt = |t: Option<NaiveDateTime>| t.map(|t| t.format("%Y-%m-%dT%H:%M:%S").to_string());
    Preview {
        audio_files: scan.audio.len(),
        audio_bytes: scan.audio.iter().map(|f| f.size).sum(),
        selection_tables: scan.selection_tables.len(),
        skipped_dirs: scan.skipped_dirs.clone(),
        unmatched: unmatched_groups.iter().map(|g| g.count).sum(),
        unmatched_groups,
        per_pattern,
        groups: groups.into_iter().map(|((site, device), (files, bytes, a, b))| GroupSummary {
            site, device, files, bytes, first: fmt(a), last: fmt(b),
        }).collect(),
        issues: issues.into_iter().map(|(kind, (count, examples))| Issue { kind: kind.into(), count, examples }).collect(),
        samples,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{profile_spec::{MappingSpec, ProfileSpec}, scan::ScannedFile};

    #[test]
    fn groups_issues_and_unmatched() {
        let files = ["A/R1_20240501_043000.wav", "A/R1_20240501_043000.wav", "B/R2_19990101_000000.wav", "x/odd.wav", "x/odd2.wav"];
        let scan = ScanResult {
            audio: files.iter().map(|p| ScannedFile { rel_path: p.to_string(), size: 10, mtime_ms: 0 }).collect(),
            ..Default::default()
        };
        let spec = ProfileSpec {
            name: "t".into(),
            patterns: vec!["{s}/{d}_{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "s".into(), role: "site".into(), ..Default::default() },
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let p = preview(&scan, &spec.build().unwrap(), 10);
        assert_eq!(p.per_pattern, vec![3]);
        assert_eq!(p.unmatched, 2);
        assert_eq!(p.unmatched_groups[0].dir, "x");
        assert_eq!(p.groups.len(), 2);
        let kinds: Vec<_> = p.issues.iter().map(|i| (i.kind.as_str(), i.count)).collect();
        assert_eq!(kinds, vec![("duplicate-time", 1), ("implausible-time", 1)]);
    }
}

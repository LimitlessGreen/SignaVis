//! Suggest import profiles from example paths, so nobody has to write template syntax.
//!
//! 1. Date/time blocks are recognised by plausible values (2023_03_13_17_00_01, 20240501_043000,
//!    2024-05-01, …) and become `{start:%…}` / `{date:%…}`.
//! 2. The rest is split into digit runs, letter runs and separators. Paths with the same shape
//!    form a group; tokens that are constant in a group stay literal, the others become fields.
//! 3. A field is named after the word in front of it ("Rekorder_11" → `rekorder`), and two fields
//!    that always carry the same value ("Rekorder_11/…/SK11_…") share one name, which the matcher
//!    then checks for consistency.
//! Every suggestion comes with field roles and the number of example paths it matches.

use crate::pattern::PathPattern;
use crate::profile_spec::MappingSpec;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub pattern: String,
    pub mappings: Vec<MappingSpec>,
    /// Example paths matched by this pattern (of the sample).
    pub matches: usize,
    pub example: String,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Digits(String),
    Alpha(String),
    Sep(char),
    /// Date/time block: raw text and its strftime format.
    Time(String, String),
}

impl Tok {
    fn shape(&self) -> String {
        match self {
            Tok::Digits(_) => "9".into(),
            Tok::Alpha(_) => "a".into(),
            Tok::Sep(c) => c.to_string(),
            Tok::Time(_, f) => format!("<{f}>"),
        }
    }
    fn text(&self) -> String {
        match self { Tok::Digits(s) | Tok::Alpha(s) | Tok::Time(s, _) => s.clone(), Tok::Sep(c) => c.to_string() }
    }
}

static DATETIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(
    r"(?x)^(\d{4})([-_.]?)(\d{2})([-_.]?)(\d{2})(?:([ _T-]?)(\d{2})([-_:.]?)(\d{2})(?:([-_:.]?)(\d{2}))?)?").unwrap());

/// Find a plausible date (and time) block in `s`; returns (start, end, strftime format).
/// Tried at every start of a digit run, so an implausible earlier candidate does not hide a later one.
fn find_time(s: &str) -> Option<(usize, usize, String)> {
    let starts = s.char_indices().filter(|&(i, c)| c.is_ascii_digit() && !s[..i].ends_with(|p: char| p.is_ascii_digit())).map(|(i, _)| i);
    for at in starts {
        let Some(c) = DATETIME.captures(&s[at..]) else { continue };
        let m = c.get(0).unwrap();
        let end = at + m.end();
        // Not glued to further digits (part of a longer number).
        if s[end..].starts_with(|ch: char| ch.is_ascii_digit()) { continue; }
        let n = |i: usize| c.get(i).map(|x| x.as_str().parse::<u32>().unwrap_or(99));
        let (y, mo, d) = (n(1).unwrap(), n(3).unwrap(), n(5).unwrap());
        if !(1990..=2100).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) { continue; }
        let sep = |i: usize| c.get(i).map_or("", |x| x.as_str()).replace('%', "%%");
        let mut fmt = format!("%Y{}%m{}%d", sep(2), sep(4));
        if let (Some(h), Some(mi)) = (n(7), n(9)) {
            if h > 23 || mi > 59 { continue; }
            fmt += &format!("{}%H{}%M", sep(6), sep(8));
            if let Some(sec) = n(11) {
                if sec > 59 { continue; }
                fmt += &format!("{}%S", sep(10));
            }
        }
        return Some((at, end, fmt));
    }
    None
}

fn is_hhmmss(v: &str) -> bool {
    v.len() == 6 && v.bytes().all(|b| b.is_ascii_digit())
        && v[0..2].parse::<u32>().is_ok_and(|h| h < 24) && v[2..4].parse::<u32>().is_ok_and(|m| m < 60)
        && v[4..6].parse::<u32>().is_ok_and(|s| s < 60)
}

fn tokenize_segment(seg: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut rest = seg;
    while !rest.is_empty() {
        if let Some((a, b, fmt)) = find_time(rest) {
            out.extend(tokenize_plain(&rest[..a]));
            out.push(Tok::Time(rest[a..b].to_string(), fmt));
            rest = &rest[b..];
        } else {
            out.extend(tokenize_plain(rest));
            break;
        }
    }
    out
}

fn tokenize_plain(s: &str) -> Vec<Tok> {
    let mut out: Vec<Tok> = Vec::new();
    for ch in s.chars() {
        let kind = if ch.is_ascii_digit() { 0 } else if ch.is_alphabetic() { 1 } else { 2 };
        match (kind, out.last_mut()) {
            (0, Some(Tok::Digits(t))) => t.push(ch),
            (1, Some(Tok::Alpha(t))) => t.push(ch),
            (0, _) => out.push(Tok::Digits(ch.to_string())),
            (1, _) => out.push(Tok::Alpha(ch.to_string())),
            _ => out.push(Tok::Sep(ch)),
        }
    }
    out
}

/// Path → tokens with `/` as separator token between segments.
fn tokenize(path: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    for (i, seg) in path.split('/').enumerate() {
        if i > 0 { out.push(Tok::Sep('/')); }
        out.extend(tokenize_segment(seg));
    }
    out
}

fn role_for(name: &str, time_fmt: Option<&str>) -> String {
    let n = name.to_lowercase();
    if let Some(f) = time_fmt {
        let has_date = f.contains("%d");
        let has_time = f.contains("%H");
        return if has_date && has_time { "start" } else if has_date { "date" } else { "time" }.into();
    }
    let site = ["site", "loc", "location", "standort", "ort", "plot", "station", "point", "punkt"];
    let dev = ["rec", "recorder", "rekorder", "device", "dev", "geraet", "gerät", "unit", "sn", "serial", "am", "sm", "mic"];
    if site.contains(&n.as_str()) { "site".into() }
    else if dev.contains(&n.as_str()) { "device".into() }
    else { format!("meta:{name}") }
}

fn clean_name(s: &str) -> String {
    let n: String = s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
    if n.is_empty() || n.chars().next().unwrap().is_ascii_digit() { String::new() } else { n }
}

/// Build one template for a group of token lists with identical shape.
fn template_for(group: &[Vec<Tok>]) -> Option<(String, Vec<MappingSpec>)> {
    let len = group[0].len();
    let variable: Vec<bool> = (0..len).map(|i| {
        matches!(group[0][i], Tok::Time(..)) || group.iter().any(|t| t[i].text() != group[0][i].text())
    }).collect();
    // Field slots: maximal runs of adjacent variable non-separator tokens (no field next to a field).
    let mut slots: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < len {
        if variable[i] && !matches!(group[0][i], Tok::Sep(_)) {
            let start = i;
            while i + 1 < len && (variable[i + 1] || matches!(group[0][i + 1], Tok::Digits(_) | Tok::Alpha(_)) && variable[i])
                && !matches!(group[0][i + 1], Tok::Sep(_)) { i += 1; }
            slots.push((start, i));
        } else if variable[i] {
            return None;   // varying separator: shape would not be stable
        }
        i += 1;
    }
    let value = |t: &Vec<Tok>, (a, b): (usize, usize)| t[a..=b].iter().map(|x| x.text()).collect::<String>();
    // Merge slots that always carry the same value.
    let mut alias: Vec<Option<usize>> = vec![None; slots.len()];
    for j in 0..slots.len() {
        for k in 0..j {
            if alias[k].is_none() && !matches!(group[0][slots[k].0], Tok::Time(..))
                && group.iter().all(|t| value(t, slots[j]) == value(t, slots[k])) {
                alias[j] = Some(k);
                break;
            }
        }
    }
    // Names: the word in front of the slot (same segment), else f<n>.
    let mut names: Vec<String> = Vec::new();
    let mut used: HashMap<String, usize> = HashMap::new();
    let mut fmts: Vec<Option<String>> = Vec::new();
    for (j, &(a, b)) in slots.iter().enumerate() {
        if let Some(k) = alias[j] { names.push(names[k].clone()); fmts.push(fmts[k].clone()); continue; }
        let mut fmt = match (&group[0][a], a == b) { (Tok::Time(_, f), true) => Some(f.clone()), _ => None };
        // HHMMSS next to a date-only block elsewhere in the path: time of day.
        let has_date_only = slots.iter().any(|&(x, y)| x == y && matches!(&group[0][x], Tok::Time(_, f) if !f.contains("%H")));
        if fmt.is_none() && a == b && has_date_only && group.iter().all(|t| is_hhmmss(&t[a].text())) {
            fmt = Some("%H%M%S".into());
        }
        let mut name = if let Some(f) = &fmt {
            role_for("", Some(f))
        } else {
            let mut w = String::new();
            let mut p = a;
            while p > 0 {
                p -= 1;
                match &group[0][p] {
                    Tok::Sep('/') => break,
                    Tok::Alpha(s) if !variable[p] => { w = clean_name(s); break; }
                    _ => {}
                }
            }
            if w.is_empty() { format!("f{}", j + 1) } else { w }
        };
        let n = used.entry(name.clone()).or_insert(0);
        *n += 1;
        if *n > 1 { name = format!("{name}{n}"); }
        names.push(name);
        fmts.push(fmt);
    }
    let mut pattern = String::new();
    let mut slot_at: BTreeMap<usize, usize> = BTreeMap::new();
    for (j, &(a, _)) in slots.iter().enumerate() { slot_at.insert(a, j); }
    let mut i = 0;
    while i < len {
        if let Some(&j) = slot_at.get(&i) {
            let (a, b) = slots[j];
            let all_digits = (a..=b).all(|x| matches!(group[0][x], Tok::Digits(_)));
            match &fmts[j] {
                Some(f) => pattern += &format!("{{{}:{}}}", names[j], f),
                None if all_digits && alias[j].is_none() && names[j].starts_with('f') => pattern += &format!("{{{}:int}}", names[j]),
                None => pattern += &format!("{{{}}}", names[j]),
            }
            i = b + 1;
        } else {
            let t = group[0][i].text();
            if t.contains(['{', '}', '*']) { return None; }
            pattern += &t;
            i += 1;
        }
    }
    let mut mappings = Vec::new();
    for (j, n) in names.iter().enumerate() {
        if alias[j].is_some() || mappings.iter().any(|m: &MappingSpec| &m.field == n) { continue; }
        let role = role_for(n, fmts[j].as_deref());
        let format = match role.as_str() {
            "site" | "device" => {
                // Keep the word of the folder name as display name ("Rekorder {}").
                let (a, _) = slots[j];
                let word = (0..a).rev().take_while(|&p| !matches!(group[0][p], Tok::Sep('/')))
                    .find_map(|p| match &group[0][p] { Tok::Alpha(s) if !variable[p] => Some(s.clone()), _ => None });
                word.map(|w| format!("{w} {{}}"))
            }
            _ => None,
        };
        mappings.push(MappingSpec { field: n.clone(), role, format, ..Default::default() });
    }
    Some((pattern, mappings))
}

/// Suggestions for a scan: an evenly spread sample of at most 5000 audio paths.
pub fn suggest_for_scan(scan: &crate::scan::ScanResult, max: usize) -> Vec<Suggestion> {
    let step = (scan.audio.len() / 5000).max(1);
    let sample: Vec<String> = scan.audio.iter().step_by(step).map(|f| f.rel_path.clone()).collect();
    let mut s = suggest(&sample, max);
    // Report matches on the whole scan, not just the sample.
    for x in &mut s {
        if let Ok(p) = PathPattern::new(&x.pattern) {
            x.matches = scan.audio.iter().filter(|f| p.matches(&f.rel_path).is_some()).count();
        }
    }
    s
}

/// Suggest up to `max` templates (largest groups first) for the given relative paths.
pub fn suggest(paths: &[String], max: usize) -> Vec<Suggestion> {
    let mut groups: HashMap<String, Vec<Vec<Tok>>> = HashMap::new();
    for p in paths {
        let t = tokenize(p);
        // Shape without the letters, so varying words (site names) still group together.
        let shape = t.iter().map(|x| x.shape()).collect::<Vec<_>>().join("\u{1}");
        groups.entry(shape).or_default().push(t);
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.len()));
    let mut out: Vec<Suggestion> = Vec::new();
    let mut compiled: Vec<PathPattern> = Vec::new();
    for g in groups {
        if out.len() >= max { break; }
        let example: String = g[0].iter().map(|t| t.text()).collect();
        // Already covered by an earlier (bigger) suggestion: nothing new.
        if g.iter().all(|t| { let p: String = t.iter().map(|x| x.text()).collect(); compiled.iter().any(|c| c.matches(&p).is_some()) }) {
            continue;
        }
        // Extra folders in front of a known layout (e.g. a swapped recorder): reuse that layout's
        // fields behind `{*}/` instead of a pattern of constants.
        let reused = (1..=3).find_map(|k| {
            let parts: Vec<&str> = example.splitn(k + 1, '/').collect();
            let rest = parts.get(k)?;
            let i = compiled.iter().position(|c| c.matches(rest).is_some())?;
            Some((format!("{}{}", "{*}/".repeat(k), out[i].pattern), out[i].mappings.clone()))
        });
        let Some((pattern, mappings)) = reused.or_else(|| template_for(&g)) else { continue };
        if out.iter().any(|s| s.pattern == pattern) { continue; }
        let Ok(pp) = PathPattern::new(&pattern) else { continue };
        let matches = paths.iter().filter(|p| pp.matches(p).is_some()).count();
        if matches == 0 { continue; }
        compiled.push(pp);
        out.push(Suggestion { pattern, mappings, matches, example });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn recorder_site_week_layout_with_shared_recorder() {
        let p = paths(&[
            "Rekorder_11_Standort_2/Woche_1/SK11_2023_03_13_17_00_01.wav",
            "Rekorder_11_Standort_2/Woche_2/SK11_2023_03_20_18_01_01.wav",
            "Rekorder_12_Standort_3/Woche_1/SK12_2023_03_13_17_00_02.wav",
            "Rekorder_26_Standort_10/Woche_3/SK26_2023_03_28_05_10_02.wav",
        ]);
        let s = suggest(&p, 3);
        assert_eq!(s[0].pattern, "Rekorder_{rekorder}_Standort_{standort}/Woche_{woche}/SK{rekorder}_{start:%Y_%m_%d_%H_%M_%S}.wav");
        assert_eq!(s[0].matches, 4);
        let roles: Vec<_> = s[0].mappings.iter().map(|m| (m.field.as_str(), m.role.as_str(), m.format.as_deref())).collect();
        assert_eq!(roles, vec![
            ("rekorder", "device", Some("Rekorder {}")), ("standort", "site", Some("Standort {}")),
            ("woche", "meta:woche", None), ("start", "start", None),
        ]);
    }

    #[test]
    fn audiomoth_and_song_meter_names() {
        let am = suggest(&paths(&["Moor/20240501_043000.WAV", "Wald/20240502_050000.WAV"]), 2);
        assert_eq!(am[0].pattern, "{f1}/{start:%Y%m%d_%H%M%S}.WAV");
        let sm = suggest(&paths(&["SMA01234_20240501_043000.wav", "SMA01234_20240501_053000.wav", "SMA05678_20240502_043000.wav"]), 2);
        assert_eq!(sm[0].pattern, "SMA{sma}_{start:%Y%m%d_%H%M%S}.wav");
        assert_eq!(sm[0].matches, 3);
    }

    #[test]
    fn date_folder_time_file_and_several_shapes() {
        let s = suggest(&paths(&[
            "site_A/2024-05-01/rec_043000.flac", "site_B/2024-05-02/rec_051500.flac",
            "notes/x.wav",
        ]), 3);
        assert_eq!(s[0].pattern, "site_{site}/{date:%Y-%m-%d}/rec_{time:%H%M%S}.flac");
        let roles: Vec<_> = s[0].mappings.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["site", "date", "time"]);
        assert_eq!(s[0].mappings[0].role, "site");
        assert_eq!(s[0].matches, 2);
        assert!(s.iter().any(|x| x.pattern.starts_with("notes/")) || s.len() == 1);
    }

    #[test]
    fn nested_swap_folder_reuses_the_main_layout_and_covered_shapes_are_dropped() {
        let mut p = Vec::new();
        for r in [11, 12, 14] {
            for w in 1..=2 { p.push(format!("Rekorder_{r}_Standort_{}/Woche_{w}/SK{r}_2023_03_1{w}_17_00_01.wav", r - 9)); }
        }
        p.push("Rekorder_11_Standort_2/Woche_1_Rest/SK11_2023_03_17_19_50_01.wav".into());
        p.push("Rekorder_34_21_Standort_1/Rekorder_21_Standort_1/Woche_3/SK21_2023_03_27_18_00_02.wav".into());
        let s = suggest(&p, 5);
        let pats: Vec<_> = s.iter().map(|x| x.pattern.as_str()).collect();
        assert_eq!(pats, [
            "Rekorder_{rekorder}_Standort_{standort}/Woche_{woche}/SK{rekorder}_{start:%Y_%m_%d_%H_%M_%S}.wav",
            "{*}/Rekorder_{rekorder}_Standort_{standort}/Woche_{woche}/SK{rekorder}_{start:%Y_%m_%d_%H_%M_%S}.wav",
        ]);
        assert_eq!(s[1].mappings[0].role, "device");
    }

    #[test]
    fn implausible_numbers_are_not_dates() {
        let s = suggest(&paths(&["a/12345678_99.wav", "a/22345678_98.wav"]), 1);
        assert!(!s[0].pattern.contains('%'), "{}", s[0].pattern);
    }
}

//! Path templates for import: extract fields (site, recorder, start time, …) from relative paths.
//!
//! Syntax (matched against the whole path relative to the root, `/` separated):
//! - `{name}`            one or more characters, no `/` (shortest match)
//! - `{name:int}`        digits
//! - `{name:%Y_%m_%d}`   date and/or time with strftime codes %Y %m %d %H %M %S %y %j;
//!                       the parsed value is in `PatternMatch::times` (date-only → date at 00:00,
//!                       time-only → `time_only`). Which field is the recording start is decided
//!                       by the import profile, not by the field name.
//! - `{*}`               anonymous field (same as `{name}`, value dropped)
//! - `*`                 any characters within one path segment
//! - `**/`               zero or more directories
//! Everything else is literal (regex characters are escaped).

use chrono::{NaiveDateTime, NaiveTime};
use regex::Regex;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct PathPattern {
    pub template: String,
    re: Regex,
    /// (group name, field name, strftime format if any)
    fields: Vec<(String, String, Option<String>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PatternMatch {
    pub fields: BTreeMap<String, String>,
    /// Parsed date/time fields (full date-time or date at 00:00).
    pub times: BTreeMap<String, NaiveDateTime>,
    /// Parsed time-of-day fields without a date.
    pub time_only: BTreeMap<String, NaiveTime>,
}

#[derive(Debug)]
pub struct PatternError(pub String);

impl std::fmt::Display for PatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for PatternError {}

fn strftime_to_regex(fmt: &str) -> Result<String, PatternError> {
    let mut out = String::new();
    let mut chars = fmt.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let code = chars.next().ok_or_else(|| PatternError(format!("dangling % in {fmt}")))?;
            out.push_str(match code {
                'Y' => r"\d{4}",
                'y' | 'm' | 'd' | 'H' | 'M' | 'S' => r"\d{2}",
                'j' => r"\d{3}",
                '%' => "%",
                _ => return Err(PatternError(format!("unsupported %{code} in {fmt}"))),
            });
        } else {
            out.push_str(&regex::escape(&c.to_string()));
        }
    }
    Ok(out)
}

impl PathPattern {
    pub fn new(template: &str) -> Result<Self, PatternError> {
        let mut re = String::from("^");
        let mut fields = Vec::new();
        let mut rest = template;
        let mut anon = 0;
        while !rest.is_empty() {
            if let Some(r) = rest.strip_prefix("**/") {
                re.push_str("(?:[^/]+/)*");
                rest = r;
            } else if let Some(r) = rest.strip_prefix('*') {
                re.push_str("[^/]*");
                rest = r;
            } else if let Some(r) = rest.strip_prefix('{') {
                let end = r.find('}').ok_or_else(|| PatternError(format!("unclosed {{ in {template}")))?;
                let spec = &r[..end];
                rest = &r[end + 1..];
                let (name, kind) = match spec.split_once(':') {
                    Some((n, k)) => (n.trim(), Some(k)),
                    None => (spec.trim(), None),
                };
                if name == "*" {
                    re.push_str("[^/]+?");
                    continue;
                }
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return Err(PatternError(format!("bad field name '{name}'")));
                }
                anon += 1;
                let group = format!("f{anon}");
                let (body, fmt) = match kind {
                    None => ("[^/]+?".to_string(), None),
                    Some("int") => (r"\d+".to_string(), None),
                    Some(k) if k.contains('%') => (strftime_to_regex(k)?, Some(k.to_string())),
                    Some(k) => return Err(PatternError(format!("unknown field type '{k}'"))),
                };
                re.push_str(&format!("(?P<{group}>{body})"));
                fields.push((group, name.to_string(), fmt));
            } else {
                let next = rest.find(['{', '*']).unwrap_or(rest.len());
                re.push_str(&regex::escape(&rest[..next]));
                rest = &rest[next..];
            }
        }
        re.push('$');
        let re = Regex::new(&re).map_err(|e| PatternError(e.to_string()))?;
        Ok(Self { template: template.to_string(), re, fields })
    }

    pub fn matches(&self, rel_path: &str) -> Option<PatternMatch> {
        let caps = self.re.captures(rel_path)?;
        let mut fields = BTreeMap::new();
        let (mut times, mut time_only) = (BTreeMap::new(), BTreeMap::new());
        for (group, name, fmt) in &self.fields {
            let v = caps.name(group)?.as_str();
            if let Some(fmt) = fmt {
                match parse_time(v, fmt)? {
                    Parsed::DateTime(t) => { times.insert(name.clone(), t); }
                    Parsed::Time(t) => { time_only.insert(name.clone(), t); }
                }
            }
            // A field used twice must agree (e.g. recorder in folder and file name).
            if let Some(prev) = fields.get(name) {
                if prev != v { return None; }
            }
            fields.insert(name.clone(), v.to_string());
        }
        Some(PatternMatch { fields, times, time_only })
    }
}

enum Parsed { DateTime(NaiveDateTime), Time(NaiveTime) }

fn parse_time(v: &str, fmt: &str) -> Option<Parsed> {
    if let Ok(t) = NaiveDateTime::parse_from_str(v, fmt) { return Some(Parsed::DateTime(t)); }
    if let Some(t) = chrono::NaiveDate::parse_from_str(v, fmt).ok().and_then(|d| d.and_hms_opt(0, 0, 0)) {
        return Some(Parsed::DateTime(t));
    }
    NaiveTime::parse_from_str(v, fmt).ok().map(Parsed::Time)
}

/// Several templates, first match wins.
#[derive(Debug, Clone, Default)]
pub struct PatternSet(pub Vec<PathPattern>);

impl PatternSet {
    pub fn parse(templates: &[&str]) -> Result<Self, PatternError> {
        Ok(Self(templates.iter().map(|t| PathPattern::new(t)).collect::<Result<_, _>>()?))
    }
    /// (index of the matching template, match)
    pub fn matches(&self, rel_path: &str) -> Option<(usize, PatternMatch)> {
        self.0.iter().enumerate().find_map(|(i, p)| p.matches(rel_path).map(|m| (i, m)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SK: &str = "Rekorder_{recorder}_Standort_{site}/Woche_{week:int}/SK{recorder}_{start:%Y_%m_%d_%H_%M_%S}.wav";

    #[test]
    fn recorder_site_week_layout() {
        let p = PathPattern::new(SK).unwrap();
        let m = p.matches("Rekorder_11_Standort_2/Woche_1/SK11_2023_03_13_17_00_01.wav").unwrap();
        assert_eq!(m.fields["recorder"], "11");
        assert_eq!(m.fields["site"], "2");
        assert_eq!(m.fields["week"], "1");
        assert_eq!(m.times["start"].to_string(), "2023-03-13 17:00:01");
    }

    #[test]
    fn recorder_must_agree_between_folder_and_file() {
        let p = PathPattern::new(SK).unwrap();
        assert!(p.matches("Rekorder_11_Standort_2/Woche_1/SK12_2023_03_13_17_00_01.wav").is_none());
    }

    #[test]
    fn swapped_recorder_with_anonymous_field() {
        let p = PathPattern::new(
            "Rekorder_{*}_Standort_{*}/Rekorder_{recorder}_Standort_{site}/Woche_{week:int}/SK{recorder}_{start:%Y_%m_%d_%H_%M_%S}.wav",
        ).unwrap();
        let m = p.matches("Rekorder_34_21_Standort_1/Rekorder_21_Standort_1/Woche_2/SK21_2023_04_01_05_59_01.wav").unwrap();
        assert_eq!(m.fields["recorder"], "21");
        assert_eq!(m.fields["site"], "1");
    }

    #[test]
    fn globs_and_invalid_dates() {
        let p = PathPattern::new("**/{start:%Y%m%d_%H%M%S}.WAV").unwrap();
        assert!(p.matches("a/b/20240501_043000.WAV").is_some());
        assert!(p.matches("20240501_043000.WAV").is_some());
        assert!(p.matches("a/20241301_043000.WAV").is_none(), "month 13 rejected");
        let w = PathPattern::new("Rekorder_{r}/Woche_{w}*/x.wav").unwrap();
        assert_eq!(w.matches("Rekorder_1/Woche_3_Rest/x.wav").unwrap().fields["w"], "3", "lazy field, rest eaten by *");
    }

    #[test]
    fn date_in_folder_time_in_file() {
        let p = PathPattern::new("{day:%Y-%m-%d}/{rec}_{clock:%H%M%S}.flac").unwrap();
        let m = p.matches("2024-05-01/AM07_043000.flac").unwrap();
        assert_eq!(m.times["day"].to_string(), "2024-05-01 00:00:00");
        assert_eq!(m.time_only["clock"].to_string(), "04:30:00");
    }

    #[test]
    fn literal_regex_chars_are_escaped() {
        let p = PathPattern::new("a.b(1)/{x}.wav").unwrap();
        assert!(p.matches("a.b(1)/y.wav").is_some());
        assert!(p.matches("aXb(1)/y.wav").is_none());
    }
}

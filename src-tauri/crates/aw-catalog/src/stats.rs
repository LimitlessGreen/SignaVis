//! Statistics page: totals, coverage per site and week, recorders with missing nights,
//! file integrity, labels, detections. Everything under the library filter.

use crate::query::{FROM, Filter, LOCAL_DAY, Skip, natural_cmp, where_clause};
use crate::{Catalog, Result};
use rusqlite::params_from_iter;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub recordings: i64,
    pub bytes: i64,
    /// Sum of known durations; `with_duration` says how many recordings that covers.
    pub seconds: f64,
    pub with_duration: i64,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub sites: i64,
    pub devices: i64,
    pub no_start: i64,
    pub unassigned: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integrity { pub ok: i64, pub missing: i64, pub changed: i64, pub hashed: i64, pub full_hashed: i64, pub header_read: i64 }

/// Recordings of one site in one week (Monday, local date).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekCell { pub site_id: Option<i64>, pub week: String, pub recordings: i64, pub seconds: f64, pub days: i64 }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStat {
    pub device_id: Option<i64>,
    pub device: Option<String>,
    pub recordings: i64,
    pub seconds: f64,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
    /// Local days with at least one recording.
    pub days: i64,
    /// Days between first and last without any recording (failure, card full, …).
    pub missing_days: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassCount { pub class: String, pub count: i64, pub recordings: i64 }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStat { pub run_id: i64, pub model: String, pub covered: i64, pub detections: i64, pub classes: Vec<ClassCount> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub totals: Totals,
    pub integrity: Integrity,
    pub sites: Vec<(Option<i64>, String)>,
    pub weeks: Vec<WeekCell>,
    pub devices: Vec<DeviceStat>,
    pub labeled_recordings: i64,
    pub labels: Vec<ClassCount>,
    pub runs: Vec<RunStat>,
}

fn collect<T, F: FnMut(&rusqlite::Row) -> rusqlite::Result<T>>(cat: &Catalog, sql: &str, p: &[Box<dyn rusqlite::ToSql>], f: F) -> Result<Vec<T>> {
    let mut st = cat.conn.prepare(sql)?;
    let v = st.query_map(params_from_iter(p.iter()), f)?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn stats(cat: &Catalog, f: &Filter, top_classes: usize) -> Result<Stats> {
    let (w, p) = where_clause(cat, f, Skip::None)?;
    let base = format!("{FROM} WHERE {w}");
    let totals = cat.conn.query_row(&format!(
        "SELECT COUNT(*), COALESCE(SUM(a.size), 0), COALESCE(SUM(r.duration_s), 0), COUNT(r.duration_s), MIN(r.start_ms), MAX(r.start_ms),
                COUNT(DISTINCT r.site_id), COUNT(DISTINCT r.device_id), COALESCE(SUM(r.start_ms IS NULL), 0),
                COALESCE(SUM(r.site_id IS NULL OR r.device_id IS NULL), 0) {base}"), params_from_iter(p.iter()), |r| Ok(Totals {
        recordings: r.get(0)?, bytes: r.get(1)?, seconds: r.get(2)?, with_duration: r.get(3)?, first_ms: r.get(4)?, last_ms: r.get(5)?,
        sites: r.get(6)?, devices: r.get(7)?, no_start: r.get(8)?, unassigned: r.get(9)?,
    }))?;
    let integrity = cat.conn.query_row(&format!(
        "SELECT COALESCE(SUM(a.status = 'ok'), 0), COALESCE(SUM(a.status = 'missing'), 0), COALESCE(SUM(a.status = 'changed'), 0),
                COUNT(a.quick_hash), COUNT(a.full_hash), COUNT(r.sample_rate) {base}"), params_from_iter(p.iter()), |r| Ok(Integrity {
        ok: r.get(0)?, missing: r.get(1)?, changed: r.get(2)?, hashed: r.get(3)?, full_hashed: r.get(4)?, header_read: r.get(5)?,
    }))?;
    let week = format!("date({LOCAL_DAY}, '-6 days', 'weekday 1')");
    let weeks = collect(cat, &format!(
        "SELECT r.site_id, {week}, COUNT(*), COALESCE(SUM(r.duration_s), 0), COUNT(DISTINCT {LOCAL_DAY}) {base} AND r.start_ms IS NOT NULL
         GROUP BY 1, 2 ORDER BY 2"), &p, |r| Ok(WeekCell { site_id: r.get(0)?, week: r.get(1)?, recordings: r.get(2)?, seconds: r.get(3)?, days: r.get(4)? }))?;
    let mut sites = collect(cat, &format!(
        "SELECT DISTINCT r.site_id, COALESCE((SELECT name FROM site WHERE id = r.site_id), '') {base}"), &p,
        |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?)))?;
    sites.sort_by(|a, b| a.0.is_none().cmp(&b.0.is_none()).then(natural_cmp(&a.1, &b.1)));

    // Recorders: days with recordings, and the gaps between their first and last day.
    let day_rows = collect(cat, &format!(
        "SELECT r.device_id, (SELECT name FROM device WHERE id = r.device_id), {LOCAL_DAY}, COUNT(*), COALESCE(SUM(r.duration_s), 0)
         {base} AND r.start_ms IS NOT NULL GROUP BY 1, 3 ORDER BY 1, 3"), &p,
        |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, f64>(4)?)))?;
    let mut devices: Vec<DeviceStat> = Vec::new();
    for (id, name, day, n, secs) in day_rows {
        if devices.last().is_none_or(|d| d.device_id != id) {
            devices.push(DeviceStat { device_id: id, device: name, recordings: 0, seconds: 0.0, first_day: None, last_day: None, days: 0, missing_days: vec![] });
        }
        let d = devices.last_mut().unwrap();
        if let (Some(prev), Ok(cur)) = (d.last_day.as_deref().and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()),
                                         chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d")) {
            let mut x = prev.succ_opt();
            while let Some(m) = x.filter(|m| *m < cur) {
                d.missing_days.push(m.format("%Y-%m-%d").to_string());
                x = m.succ_opt();
            }
        }
        if d.first_day.is_none() { d.first_day = Some(day.clone()); }
        d.last_day = Some(day);
        d.recordings += n;
        d.seconds += secs;
        d.days += 1;
    }
    devices.sort_by(|a, b| a.device.is_none().cmp(&b.device.is_none())
        .then(natural_cmp(a.device.as_deref().unwrap_or(""), b.device.as_deref().unwrap_or(""))));

    let labeled_recordings = cat.conn.query_row(&format!(
        "SELECT COUNT(*) {base} AND EXISTS (SELECT 1 FROM label l WHERE l.recording_id = r.id)"), params_from_iter(p.iter()), |r| r.get(0))?;
    let labels = collect(cat, &format!(
        "SELECT l.class, COUNT(*), COUNT(DISTINCT l.recording_id) FROM label l WHERE l.polarity = 'present'
         AND l.recording_id IN (SELECT r.id {base}) GROUP BY 1 ORDER BY 2 DESC LIMIT {top_classes}"), &p,
        |r| Ok(ClassCount { class: r.get(0)?, count: r.get(1)?, recordings: r.get(2)? }))?;
    let run_rows = collect(cat, &format!(
        "SELECT u.id, u.model, (SELECT COUNT(*) FROM run_coverage c WHERE c.run_id = u.id AND c.recording_id IN (SELECT r.id {base}))
         FROM run u ORDER BY u.id"), &p, |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?;
    let mut runs = Vec::new();
    for (run_id, model, covered) in run_rows {
        // The filter's placeholders keep their numbers; the run id comes after them.
        let (w2, mut all) = where_clause(cat, f, Skip::None)?;
        all.push(Box::new(run_id));
        let rid = all.len();
        let classes = collect(cat, &format!(
            "SELECT d.class, COUNT(*), COUNT(DISTINCT d.recording_id) FROM detection d WHERE d.run_id = ?{rid}
             AND d.recording_id IN (SELECT r.id {FROM} WHERE {w2}) GROUP BY 1 ORDER BY 2 DESC"), &all,
            |r| Ok(ClassCount { class: r.get(0)?, count: r.get(1)?, recordings: r.get(2)? }))?;
        let detections = classes.iter().map(|c| c.count).sum();
        runs.push(RunStat { run_id, model, covered, detections, classes: classes.into_iter().take(top_classes).collect() });
    }
    Ok(Stats { totals, integrity, sites, weeks, devices, labeled_recordings, labels, runs })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_and_missing_nights() {
        let cat = crate::entities::tests::fixture();
        let s = stats(&cat, &Filter::default(), 10).unwrap();
        assert_eq!((s.totals.recordings, s.totals.sites, s.totals.devices, s.totals.with_duration), (18, 2, 2, 18));
        assert_eq!(s.totals.seconds, 18.0 * 3600.0);
        assert_eq!(s.devices.len(), 2);
        let d = &s.devices[0];
        assert_eq!((d.device.as_deref(), d.days, d.recordings), (Some("11"), 3, 9));
        assert_eq!(d.missing_days, ["2023-03-15", "2023-03-16", "2023-03-17", "2023-03-18", "2023-03-19"]);
        // 13/14 March are in the week of Monday 13 March, 20 March starts the next one.
        let w: Vec<_> = s.weeks.iter().filter(|c| c.site_id == s.sites[0].0).map(|c| (c.week.as_str(), c.recordings, c.days)).collect();
        assert_eq!(w, [("2023-03-13", 6, 2), ("2023-03-20", 3, 1)]);
        assert_eq!(s.integrity.ok, 18);
        let one = stats(&cat, &Filter { site_ids: vec![s.sites[1].0.unwrap()], ..Default::default() }, 10).unwrap();
        assert_eq!((one.totals.recordings, one.devices.len()), (9, 1));
    }
}

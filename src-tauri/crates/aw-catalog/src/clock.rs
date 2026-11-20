//! Recorder clocks: local wall time → UTC.
//!
//! Many recorders (AudioMoth, most autonomous units) never switch to daylight saving time, so a
//! fixed offset is the default; an IANA zone applies the zone's rules (DST) instead. A site's clock
//! can be changed afterwards: the local wall times are kept and UTC is recomputed.

use crate::{Catalog, Result};
use chrono::{NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Clock {
    /// Minutes ahead of UTC, no DST.
    Fixed(i32),
    Zone(Tz),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fold { Ok, /** autumn: hour exists twice, earlier taken */ Ambiguous, /** spring gap: shifted forward */ Gap }

impl Clock {
    /// "Europe/Berlin" → zone; "UTC+01:00" / "+60" / "fixed:60" → fixed offset.
    pub fn parse(s: &str) -> Option<Clock> {
        let s = s.trim();
        if let Ok(tz) = s.parse::<Tz>() { return Some(Clock::Zone(tz)); }
        let t = s.strip_prefix("fixed:").or_else(|| s.strip_prefix("UTC")).unwrap_or(s);
        if t.is_empty() { return Some(Clock::Fixed(0)); }
        if let Some((h, m)) = t.split_once(':') {
            let sign = if h.starts_with('-') { -1 } else { 1 };
            let h: i32 = h.trim_start_matches(['+', '-']).parse().ok()?;
            let m: i32 = m.parse().ok()?;
            return Some(Clock::Fixed(sign * (h * 60 + m)));
        }
        t.parse::<i32>().ok().map(Clock::Fixed)
    }

    /// Text stored in `recording.tz` / `site.tz`.
    pub fn label(&self) -> String {
        match self {
            Clock::Zone(tz) => tz.name().to_string(),
            Clock::Fixed(m) => format!("UTC{}{:02}:{:02}", if *m < 0 { '-' } else { '+' }, m.abs() / 60, m.abs() % 60),
        }
    }

    /// (UTC ms, offset minutes at that instant, fold).
    pub fn to_utc(&self, local: NaiveDateTime) -> (i64, i32, Fold) {
        match self {
            Clock::Fixed(m) => (Utc.from_utc_datetime(&local).timestamp_millis() - *m as i64 * 60_000, *m, Fold::Ok),
            Clock::Zone(tz) => {
                use chrono::LocalResult::*;
                let (dt, fold) = match tz.from_local_datetime(&local) {
                    Single(d) => (d, Fold::Ok),
                    Ambiguous(a, _) => (a, Fold::Ambiguous),
                    None => {
                        // Spring gap: the wall time does not exist; take the instant one hour later.
                        let d = tz.from_local_datetime(&(local + chrono::Duration::hours(1))).earliest()
                            .unwrap_or_else(|| tz.from_utc_datetime(&local));
                        (d, Fold::Gap)
                    }
                };
                (dt.timestamp_millis(), dt.offset().fix().local_minus_utc() / 60, fold)
            }
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockReport { pub updated: usize, pub ambiguous: usize, pub gap: usize }

/// Set the clock of a site and recompute UTC starts of its recordings from their local wall time.
pub fn set_site_clock(cat: &mut Catalog, site_id: i64, clock: Clock) -> Result<ClockReport> {
    let tx = cat.conn.transaction()?;
    tx.execute("UPDATE site SET tz = ?2 WHERE id = ?1", params![site_id, clock.label()])?;
    let rows: Vec<(i64, i64, i64)> = {
        let mut st = tx.prepare("SELECT id, start_ms, COALESCE(local_offset_min, 0) FROM recording WHERE site_id = ?1 AND start_ms IS NOT NULL")?;
        st.query_map([site_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?
    };
    let mut rep = ClockReport::default();
    {
        let mut up = tx.prepare("UPDATE recording SET start_ms = ?2, local_offset_min = ?3, tz = ?4 WHERE id = ?1")?;
        let label = clock.label();
        for (id, start, off) in rows {
            let local = chrono::DateTime::from_timestamp_millis(start + off * 60_000).unwrap_or_default().naive_utc();
            let (utc, new_off, fold) = clock.to_utc(local);
            match fold { Fold::Ambiguous => rep.ambiguous += 1, Fold::Gap => rep.gap += 1, Fold::Ok => {} }
            up.execute(params![id, utc, new_off, label])?;
            rep.updated += 1;
        }
    }
    tx.commit()?;
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{import_scanned, profile_spec::{MappingSpec, ProfileSpec}, scan::ScannedFile};

    fn t(s: &str) -> NaiveDateTime { NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap() }

    #[test]
    fn parse_and_label() {
        assert_eq!(Clock::parse("UTC+01:00"), Some(Clock::Fixed(60)));
        assert_eq!(Clock::parse("-90"), Some(Clock::Fixed(-90)));
        assert_eq!(Clock::parse("fixed:120"), Some(Clock::Fixed(120)));
        assert_eq!(Clock::parse("Europe/Berlin").unwrap().label(), "Europe/Berlin");
        assert_eq!(Clock::Fixed(-330).label(), "UTC-05:30");
        assert_eq!(Clock::parse("Mars/Olympus"), None);
    }

    #[test]
    fn zone_applies_dst_fixed_does_not() {
        let z = Clock::parse("Europe/Berlin").unwrap();
        // 2023-03-26: clocks jump 02:00 → 03:00.
        assert_eq!(z.to_utc(t("2023-03-25 18:00:00")).1, 60);
        assert_eq!(z.to_utc(t("2023-03-27 18:00:00")).1, 120);
        assert_eq!(z.to_utc(t("2023-03-26 02:30:00")).2, Fold::Gap);
        assert_eq!(z.to_utc(t("2023-10-29 02:30:00")).2, Fold::Ambiguous);
        assert_eq!(Clock::Fixed(60).to_utc(t("2023-03-27 18:00:00")).1, 60);
    }

    #[test]
    fn changing_a_site_clock_keeps_wall_time() {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        let files: Vec<_> = ["S1/20230325_180000.wav", "S1/20230327_180000.wav"].iter()
            .map(|p| ScannedFile { rel_path: p.to_string(), size: 1, mtime_ms: 0 }).collect();
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["S{s}/{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "s".into(), role: "site".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            utc_offset_min: 60, ..Default::default()
        };
        import_scanned(&mut cat, root, &files, &spec.build().unwrap()).unwrap();
        let rep = set_site_clock(&mut cat, 1, Clock::parse("Europe/Berlin").unwrap()).unwrap();
        assert_eq!(rep.updated, 2);
        let rows: Vec<(i64, i64)> = cat.conn.prepare("SELECT start_ms, local_offset_min FROM recording ORDER BY start_ms").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        // Wall time 18:00 both days; after the DST switch it is 16:00 UTC instead of 17:00.
        assert_eq!(rows[0], (Utc.with_ymd_and_hms(2023, 3, 25, 17, 0, 0).unwrap().timestamp_millis(), 60));
        assert_eq!(rows[1], (Utc.with_ymd_and_hms(2023, 3, 27, 16, 0, 0).unwrap().timestamp_millis(), 120));
        let tz: String = cat.conn.query_row("SELECT tz FROM site WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(tz, "Europe/Berlin");
        // And back to a fixed clock: 18:00 wall time again at +60.
        set_site_clock(&mut cat, 1, Clock::Fixed(60)).unwrap();
        let s: i64 = cat.conn.query_row("SELECT MAX(start_ms) FROM recording", [], |r| r.get(0)).unwrap();
        assert_eq!(s, Utc.with_ymd_and_hms(2023, 3, 27, 17, 0, 0).unwrap().timestamp_millis());
    }
}

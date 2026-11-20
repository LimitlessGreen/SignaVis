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

/// One clock period of a recorder; `from` is recorder wall time (None = from the first recording).
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockPeriod {
    pub from: Option<String>,   // "YYYY-MM-DDTHH:MM:SS"
    pub clock: String,
    #[serde(default)]
    pub note: Option<String>,
}

fn parse_wall(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok()
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").ok())
}

fn wall_ms(t: NaiveDateTime) -> i64 { t.and_utc().timestamp_millis() }

pub fn device_clocks(cat: &Catalog, device_id: i64) -> Result<Vec<ClockPeriod>> {
    let mut st = cat.conn.prepare("SELECT from_wall_ms, clock, note FROM clock_period WHERE device_id = ?1 ORDER BY from_wall_ms IS NOT NULL, from_wall_ms")?;
    let v = st.query_map([device_id], |r| Ok(ClockPeriod {
        from: r.get::<_, Option<i64>>(0)?.and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.naive_utc().format("%Y-%m-%dT%H:%M:%S").to_string()),
        clock: r.get(1)?, note: r.get(2)?,
    }))?.collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

/// Replace a recorder's clock periods and recompute UTC of its recordings from their wall time.
/// A recording uses the last period whose start is at or before its wall time.
pub fn set_device_clocks(cat: &mut Catalog, device_id: i64, periods: &[ClockPeriod]) -> Result<ClockReport> {
    let mut parsed: Vec<(Option<i64>, Clock, &ClockPeriod)> = Vec::new();
    for p in periods {
        let c = Clock::parse(&p.clock).ok_or_else(|| format!("unknown clock '{}'", p.clock))?;
        let f = match p.from.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => Some(wall_ms(parse_wall(s).ok_or_else(|| format!("bad time '{s}'"))?)),
            None => None,
        };
        parsed.push((f, c, p));
    }
    parsed.sort_by_key(|(f, _, _)| f.unwrap_or(i64::MIN));
    let tx = cat.conn.transaction()?;
    tx.execute("DELETE FROM clock_period WHERE device_id = ?1", [device_id])?;
    for (f, c, p) in &parsed {
        tx.execute("INSERT INTO clock_period(device_id, from_wall_ms, clock, note) VALUES (?1, ?2, ?3, ?4)",
            params![device_id, f, c.label(), p.note])?;
    }
    let rows: Vec<(i64, i64, i64)> = {
        let mut st = tx.prepare("SELECT id, start_ms, COALESCE(local_offset_min, 0) FROM recording WHERE device_id = ?1 AND start_ms IS NOT NULL")?;
        st.query_map([device_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?
    };
    let mut rep = ClockReport::default();
    if !parsed.is_empty() {
        let mut up = tx.prepare("UPDATE recording SET start_ms = ?2, local_offset_min = ?3, tz = ?4 WHERE id = ?1")?;
        for (id, start, off) in rows {
            let wall = start + off * 60_000;
            let (_, clock, _) = parsed.iter().rev().find(|(f, _, _)| f.is_none_or(|f| f <= wall)).unwrap_or(&parsed[0]);
            let local = chrono::DateTime::from_timestamp_millis(wall).unwrap_or_default().naive_utc();
            let (utc, new_off, fold) = clock.to_utc(local);
            match fold { Fold::Ambiguous => rep.ambiguous += 1, Fold::Gap => rep.gap += 1, Fold::Ok => {} }
            up.execute(params![id, utc, new_off, clock.label()])?;
            rep.updated += 1;
        }
    }
    tx.commit()?;
    Ok(rep)
}

/// A likely manual clock change: from one night to the next the recording window moves by a whole
/// number of hours on the recorder's wall clock, while start-to-end duration stays the same.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockShift {
    pub device_id: i64,
    pub device: String,
    /// Wall time of the first recording after the change.
    pub from: String,
    pub shift_min: i64,
    /// Clock before (as stored) and the proposed clock after the change.
    pub clock_before: String,
    pub clock_after: String,
    /// "jump": seen inside this recorder's data; "like-others": recorder only started after other
    /// recorders were changed and uses their new recording window (from = its first recording).
    pub kind: &'static str,
}

pub fn detect_clock_shifts(cat: &Catalog) -> Result<Vec<ClockShift>> {
    // Nights: wall time shifted by 12 h so one night has one date.
    let mut st = cat.conn.prepare(
        "SELECT d.id, d.name, (r.start_ms + COALESCE(r.local_offset_min, 0) * 60000) AS w, COALESCE(r.local_offset_min, 0)
         FROM recording r JOIN device d ON d.id = r.device_id WHERE r.start_ms IS NOT NULL ORDER BY d.id, w")?;
    let rows: Vec<(i64, String, i64, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<_, _>>()?;
    const DAY: i64 = 86_400_000;
    // (device) -> nights: (night index, first wall, last wall, offset)
    let mut out = Vec::new();
    let mut first_nights: Vec<(i64, String, i64, i64, i64)> = Vec::new();   // device, name, first night, tod, offset
    let mut i = 0;
    while i < rows.len() {
        let dev = rows[i].0;
        let mut nights: Vec<(i64, i64, i64, i64)> = Vec::new();
        while i < rows.len() && rows[i].0 == dev {
            let (_, _, w, off) = rows[i];
            let n = (w - DAY / 2).div_euclid(DAY);
            match nights.last_mut() {
                Some(last) if last.0 == n => last.2 = w,
                _ => nights.push((n, w, w, off)),
            }
            i += 1;
        }
        let name = rows[i - 1].1.clone();
        // Only complete nights (same duration as the typical night) count.
        let mut durs: Vec<i64> = nights.iter().map(|x| x.2 - x.1).collect();
        durs.sort();
        let typical = durs.get(durs.len() / 2).copied().unwrap_or(0);
        let full: Vec<&(i64, i64, i64, i64)> = nights.iter().filter(|x| (x.2 - x.1 - typical).abs() < 10 * 60_000).collect();
        if let Some(f) = full.first() { first_nights.push((dev, name.clone(), f.0, f.1.rem_euclid(DAY), f.3)); }
        for w in full.windows(2) {
            let tod = |x: i64| x.rem_euclid(DAY);
            let mut d = tod(w[1].1) - tod(w[0].1);
            if d > DAY / 2 { d -= DAY } else if d < -DAY / 2 { d += DAY }
            let hours = (d as f64 / 3_600_000.0).round() as i64;
            let covered: bool = cat.conn.query_row(
                "SELECT COUNT(*) > 0 FROM clock_period WHERE device_id = ?1 AND from_wall_ms BETWEEN ?2 AND ?3",
                params![dev, w[0].2 + 1, w[1].1], |r| r.get(0))?;
            if !covered && hours != 0 && (d - hours * 3_600_000).abs() < 5 * 60_000 {
                let before = Clock::Fixed(w[0].3 as i32);
                let after = Clock::Fixed((w[0].3 + hours * 60) as i32);
                out.push(ClockShift {
                    device_id: dev, device: name.clone(),
                    from: chrono::DateTime::from_timestamp_millis(w[1].1).unwrap_or_default().naive_utc().format("%Y-%m-%dT%H:%M:%S").to_string(),
                    shift_min: hours * 60, clock_before: before.label(), clock_after: after.label(), kind: "jump",
                });
            }
        }
    }
    // Recorders that only started after others were changed, with the others' new window.
    let jumps: Vec<ClockShift> = out.clone();
    for (dev, name, first_night, tod, off) in first_nights {
        if jumps.iter().any(|j| j.device_id == dev) { continue; }
        let has_periods: bool = cat.conn.query_row("SELECT COUNT(*) > 0 FROM clock_period WHERE device_id = ?1", [dev], |r| r.get(0))?;
        if has_periods { continue; }
        let like = jumps.iter().find(|j| {
            let Some(from) = parse_wall(&j.from) else { return false };
            let jn = (wall_ms(from) - DAY / 2).div_euclid(DAY);
            first_night >= jn && (wall_ms(from).rem_euclid(DAY) - tod).abs() < 5 * 60_000 && j.clock_before == Clock::Fixed(off as i32).label()
        });
        if let Some(j) = like {
            let first = cat.conn.query_row(
                "SELECT MIN(start_ms + COALESCE(local_offset_min, 0) * 60000) FROM recording WHERE device_id = ?1", [dev], |r| r.get::<_, i64>(0))?;
            out.push(ClockShift {
                device_id: dev, device: name,
                from: chrono::DateTime::from_timestamp_millis(first).unwrap_or_default().naive_utc().format("%Y-%m-%dT%H:%M:%S").to_string(),
                shift_min: j.shift_min, clock_before: j.clock_before.clone(), clock_after: j.clock_after.clone(), kind: "like-others",
            });
        }
    }
    Ok(out)
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
    fn manual_switch_is_detected_and_periods_recompute_utc() {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        // Recorder schedule fixed in UTC (16:00–05:58), file names in local clock:
        // CET (+1) for two nights, then set by hand to CEST (+2).
        let mut files = Vec::new();
        for (day, start_h) in [(13, 17), (14, 17), (27, 18), (28, 18)] {
            for m in [0, 60, 120] {
                let t = NaiveDateTime::parse_from_str(&format!("2023-03-{day:02} {start_h:02}:00:00"), "%Y-%m-%d %H:%M:%S").unwrap()
                    + chrono::Duration::minutes(m);
                files.push(ScannedFile { rel_path: format!("R1/{}.wav", t.format("%Y%m%d_%H%M%S")), size: 1, mtime_ms: 0 });
            }
        }
        // A second recorder put out only at the visit, same new window.
        for day in [27, 28] {
            for m in [0, 60, 120] {
                let t = NaiveDateTime::parse_from_str(&format!("2023-03-{day:02} 18:00:00"), "%Y-%m-%d %H:%M:%S").unwrap() + chrono::Duration::minutes(m);
                files.push(ScannedFile { rel_path: format!("R2/{}.wav", t.format("%Y%m%d_%H%M%S")), size: 1, mtime_ms: 0 });
            }
        }
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["R{d}/{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            utc_offset_min: 60, ..Default::default()
        };
        import_scanned(&mut cat, root, &files, &spec.build().unwrap()).unwrap();
        let shifts = detect_clock_shifts(&cat).unwrap();
        assert_eq!(shifts.len(), 2);
        assert_eq!((shifts[1].device.as_str(), shifts[1].kind, shifts[1].from.as_str(), shifts[1].clock_after.as_str()),
            ("2", "like-others", "2023-03-27T18:00:00", "UTC+02:00"));
        assert_eq!((shifts[0].from.as_str(), shifts[0].shift_min, shifts[0].clock_after.as_str(), shifts[0].kind),
            ("2023-03-27T18:00:00", 60, "UTC+02:00", "jump"));
        let periods = vec![
            ClockPeriod { from: None, clock: "UTC+01:00".into(), note: None },
            ClockPeriod { from: Some(shifts[0].from.clone()), clock: shifts[0].clock_after.clone(), note: Some("set by hand".into()) },
        ];
        let rep = set_device_clocks(&mut cat, shifts[0].device_id, &periods).unwrap();
        assert_eq!(rep.updated, 12);
        set_device_clocks(&mut cat, shifts[1].device_id, &[ClockPeriod { from: None, clock: "UTC+02:00".into(), note: None }]).unwrap();
        assert_eq!(device_clocks(&cat, shifts[0].device_id).unwrap(), vec![
            ClockPeriod { from: None, clock: "UTC+01:00".into(), note: None },
            ClockPeriod { from: Some("2023-03-27T18:00:00".into()), clock: "UTC+02:00".into(), note: Some("set by hand".into()) },
        ]);
        // Every night now starts at 16:00 UTC, and the wall times are unchanged.
        let starts: Vec<String> = cat.conn.prepare("SELECT time(MIN(start_ms)/1000, 'unixepoch') FROM recording GROUP BY date(start_ms/1000, 'unixepoch')").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(starts, ["16:00:00"; 4]);
        assert!(detect_clock_shifts(&cat).unwrap().is_empty(), "a change covered by a clock period is not suggested again");
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

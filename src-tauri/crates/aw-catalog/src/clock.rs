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

/// Largest fixed offset accepted (UTC±14:00 covers every zone in use).
pub const MAX_OFFSET_MIN: i32 = 14 * 60;

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
        let minutes = if let Some((h, m)) = t.split_once(':') {
            let sign = if h.starts_with('-') { -1 } else { 1 };
            let h: i32 = h.trim_start_matches(['+', '-']).parse().ok()?;
            let m: i32 = m.parse().ok()?;
            if !(0..60).contains(&m) { return None; }
            sign * h.checked_mul(60)?.checked_add(m)?
        } else {
            t.parse::<i32>().ok()?
        };
        // Real offsets lie within ±14 h; anything else is a typo (and would overflow later).
        (minutes.unsigned_abs() <= MAX_OFFSET_MIN as u32).then_some(Clock::Fixed(minutes))
    }

    /// Text stored in `recording.tz` / `site.tz`.
    pub fn label(&self) -> String {
        match self {
            Clock::Zone(tz) => tz.name().to_string(),
            Clock::Fixed(m) => { let a = m.unsigned_abs(); format!("UTC{}{:02}:{:02}", if *m < 0 { '-' } else { '+' }, a / 60, a % 60) }
        }
    }

    /// (UTC ms, offset minutes at that instant, fold). In the repeated autumn hour the earlier instant.
    pub fn to_utc(&self, local: NaiveDateTime) -> (i64, i32, Fold) { self.to_utc_fold(local, false) }

    /// Like `to_utc`; `later` picks the second pass of a repeated hour (after setting back).
    pub fn to_utc_fold(&self, local: NaiveDateTime, later: bool) -> (i64, i32, Fold) {
        match self {
            Clock::Fixed(m) => (Utc.from_utc_datetime(&local).timestamp_millis() - *m as i64 * 60_000, *m, Fold::Ok),
            Clock::Zone(tz) => {
                use chrono::LocalResult::*;
                let (dt, fold) = match tz.from_local_datetime(&local) {
                    Single(d) => (d, Fold::Ok),
                    Ambiguous(a, b) => (if later { b } else { a }, Fold::Ambiguous),
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
pub struct ClockReport {
    pub updated: usize,
    /// In a repeated hour, decided by file order.
    pub ambiguous: usize,
    pub gap: usize,
    /// Offset taken from the file header (GUANO / AudioMoth) instead of the clock periods.
    pub from_header: usize,
}

/// Set the clock of a site and recompute UTC starts of its recordings from their local wall time.
pub fn set_site_clock(cat: &mut Catalog, site_id: i64, clock: Clock) -> Result<ClockReport> {
    let tx = cat.conn.transaction()?;
    tx.execute("UPDATE site SET tz = ?2 WHERE id = ?1", params![site_id, clock.label()])?;
    let rows: Vec<(i64, i64, i64)> = {
        let mut st = tx.prepare(&format!("SELECT r.id, r.start_ms, {} FROM recording r WHERE r.site_id = ?1 AND r.start_ms IS NOT NULL", crate::WALL))?;
        st.query_map([site_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?
    };
    let mut rep = ClockReport::default();
    {
        let mut up = tx.prepare("UPDATE recording SET start_ms = ?2, local_offset_min = ?3, tz = ?4, wall_ms = ?5 WHERE id = ?1")?;
        let label = clock.label();
        for (id, start, wall) in rows {
            let local = chrono::DateTime::from_timestamp_millis(wall).unwrap_or_default().naive_utc();
            // In a repeated hour keep the pass the recording already has (an earlier decision by file order).
            let (utc, new_off, fold) = match clock.to_utc_fold(local, true) {
                later @ (u, _, Fold::Ambiguous) if u == start => later,
                _ => clock.to_utc(local),
            };
            match fold { Fold::Ambiguous => rep.ambiguous += 1, Fold::Gap => rep.gap += 1, Fold::Ok => {} }
            up.execute(params![id, utc, new_off, label, wall])?;
            rep.updated += 1;
        }
    }
    tx.commit()?;
    Ok(rep)
}

/// Apply the saved clock periods of these recorders again (after new recordings were added).
pub fn reapply_device_clocks(cat: &mut Catalog, device_ids: &[i64]) -> Result<()> {
    for &d in device_ids {
        let periods = device_clocks(cat, d)?;
        if !periods.is_empty() { set_device_clocks(cat, d, &periods)?; }
    }
    Ok(())
}

/// One clock period of a recorder; `from` is recorder wall time (None = from the first recording).
#[derive(Debug, Clone, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockPeriod {
    pub from: Option<String>,   // "YYYY-MM-DDTHH:MM:SS"
    /// First file under this clock (relative path); decides inside a repeated hour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_path: Option<String>,
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
    let mut st = cat.conn.prepare("SELECT from_wall_ms, clock, note, from_path FROM clock_period WHERE device_id = ?1 ORDER BY from_wall_ms IS NOT NULL, from_wall_ms")?;
    let v = st.query_map([device_id], |r| Ok(ClockPeriod {
        from: r.get::<_, Option<i64>>(0)?.and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.naive_utc().format("%Y-%m-%dT%H:%M:%S").to_string()),
        clock: r.get(1)?, note: r.get(2)?, from_path: r.get(3)?,
    }))?.collect::<std::result::Result<_, _>>()?;
    Ok(v)
}

/// A recording as needed to decide its clock.
#[derive(Debug, Clone)]
pub struct ClockInput { pub id: i64, pub wall_ms: i64, pub path: String, pub header_offset_min: Option<i32> }

#[derive(Debug, Clone, PartialEq)]
pub struct ClockOutput { pub id: i64, pub utc_ms: i64, pub offset_min: i32, pub label: String, pub fold: Fold, pub from_header: bool }

struct Period { from: Option<i64>, from_path: Option<String>, clock: Clock }

fn offset_at(c: &Clock, wall: i64) -> i32 {
    c.to_utc(chrono::DateTime::from_timestamp_millis(wall).unwrap_or_default().naive_utc()).1
}

/// Decide UTC for every recording of one recorder.
///
/// 1. An offset written into the file by the recorder wins.
/// 2. Otherwise the last clock period that has started. A period starts at its wall time, except when
///    the clock was set back: the wall times just after the change then also occur before it. Inside
///    that repeated window a file is after the change if it is on the "second pass": in file order
///    (folder, name) an earlier file already had the same or a later wall time. This works for
///    recorders that add a suffix (`020000_1.wav`) and for a new folder/card after the change.
///    `from_path` overrides this: files sorting at or after it are after the change.
/// 3. A zone clock's own repeated autumn hour is split the same way.
pub fn assign_clocks(periods: &[ClockPeriod], recs: &[ClockInput]) -> std::result::Result<Vec<ClockOutput>, String> {
    let mut ps: Vec<Period> = periods.iter().map(|p| {
        let clock = Clock::parse(&p.clock).ok_or_else(|| format!("unknown clock '{}'", p.clock))?;
        let from = match p.from.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => Some(wall_ms(parse_wall(s).ok_or_else(|| format!("bad time '{s}'"))?)),
            None => None,
        };
        Ok(Period { from, from_path: p.from_path.clone().filter(|x| !x.is_empty()), clock })
    }).collect::<std::result::Result<_, String>>()?;
    ps.sort_by_key(|p| p.from.unwrap_or(i64::MIN));
    if ps.is_empty() { return Ok(vec![]); }
    // Length of the repeated window at each change (old offset − new offset, if positive).
    let overlap: Vec<i64> = (0..ps.len()).map(|j| {
        if j == 0 { return 0; }
        let f = ps[j].from.unwrap_or(i64::MIN);
        ((offset_at(&ps[j - 1].clock, f) - offset_at(&ps[j].clock, f)).max(0) as i64) * 60_000
    }).collect();
    // Second pass: in file order, an earlier file already reached this wall time (within 3 h).
    let mut order: Vec<&ClockInput> = recs.iter().collect();
    order.sort_by(|a, b| crate::query::natural_cmp(&a.path, &b.path));
    let mut second_pass = std::collections::HashSet::new();
    let mut max_wall = i64::MIN;
    for r in &order {
        if max_wall != i64::MIN && r.wall_ms <= max_wall && max_wall - r.wall_ms <= 3 * 3_600_000 { second_pass.insert(r.id); }
        max_wall = max_wall.max(r.wall_ms);
    }
    let period_of = |r: &ClockInput| -> usize {
        for j in (1..ps.len()).rev() {
            let f = ps[j].from.unwrap_or(i64::MIN);
            if r.wall_ms >= f + overlap[j] { return j; }
            if r.wall_ms >= f {
                let after = match ps[j].from_path.as_deref() {
                    Some(a) => crate::query::natural_cmp(&r.path, a) != std::cmp::Ordering::Less,
                    None => overlap[j] == 0 || second_pass.contains(&r.id),
                };
                if after { return j; }
            }
        }
        0
    };
    Ok(recs.iter().map(|r| {
        if let Some(h) = r.header_offset_min {
            let c = Clock::Fixed(h);
            let (utc, off, _) = c.to_utc(chrono::DateTime::from_timestamp_millis(r.wall_ms).unwrap_or_default().naive_utc());
            return ClockOutput { id: r.id, utc_ms: utc, offset_min: off, label: c.label(), fold: Fold::Ok, from_header: true };
        }
        let j = period_of(r);
        let p = &ps[j];
        let local = chrono::DateTime::from_timestamp_millis(r.wall_ms).unwrap_or_default().naive_utc();
        let (utc, off, mut fold) = p.clock.to_utc_fold(local, second_pass.contains(&r.id));
        // Inside a repeated window of a set-back the decision came from file order: report it.
        let in_window = (1..ps.len()).any(|k| { let f = ps[k].from.unwrap_or(i64::MIN); overlap[k] > 0 && r.wall_ms >= f && r.wall_ms < f + overlap[k] });
        if in_window && fold == Fold::Ok { fold = Fold::Ambiguous; }
        ClockOutput { id: r.id, utc_ms: utc, offset_min: off, label: p.clock.label(), fold, from_header: false }
    }).collect())
}

/// Replace a recorder's clock periods and recompute UTC of its recordings from their wall time.
pub fn set_device_clocks(cat: &mut Catalog, device_id: i64, periods: &[ClockPeriod]) -> Result<ClockReport> {
    // Validate before writing anything.
    assign_clocks(periods, &[])?;
    let tx = cat.conn.transaction()?;
    tx.execute("DELETE FROM clock_period WHERE device_id = ?1", [device_id])?;
    for p in periods {
        let c = Clock::parse(&p.clock).unwrap();
        let f = p.from.as_deref().filter(|s| !s.is_empty()).and_then(parse_wall).map(wall_ms);
        tx.execute("INSERT INTO clock_period(device_id, from_wall_ms, from_path, clock, note) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![device_id, f, p.from_path.as_deref().filter(|x| !x.is_empty()), c.label(), p.note])?;
    }
    let recs: Vec<ClockInput> = {
        let mut st = tx.prepare(&format!(
            "SELECT r.id, {}, COALESCE(a.rel_path, ''), r.header_offset_min
             FROM recording r LEFT JOIN asset a ON a.id = r.asset_id WHERE r.device_id = ?1 AND r.start_ms IS NOT NULL", crate::WALL))?;
        st.query_map([device_id], |r| Ok(ClockInput { id: r.get(0)?, wall_ms: r.get(1)?, path: r.get(2)?, header_offset_min: r.get(3)? }))?
            .collect::<std::result::Result<_, _>>()?
    };
    let mut rep = ClockReport::default();
    if !periods.is_empty() {
        let mut up = tx.prepare("UPDATE recording SET start_ms = ?2, local_offset_min = ?3, tz = ?4, wall_ms = ?5 WHERE id = ?1")?;
        let wall: std::collections::HashMap<i64, i64> = recs.iter().map(|r| (r.id, r.wall_ms)).collect();
        for o in assign_clocks(periods, &recs)? {
            match o.fold { Fold::Ambiguous => rep.ambiguous += 1, Fold::Gap => rep.gap += 1, Fold::Ok => {} }
            if o.from_header { rep.from_header += 1; }
            up.execute(params![o.id, o.utc_ms, o.offset_min, o.label, wall[&o.id]])?;
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
    /// "jump": recording window moves between nights; "like-others": recorder only started after
    /// other recorders were changed and uses their new window (from = its first recording);
    /// "set-back": the same wall times occur twice with different content (clock set back while
    /// recording; file order decides the sides).
    pub kind: &'static str,
    /// For "set-back": duplicated recordings found (and whether copies could be excluded by hash).
    #[serde(default)]
    pub duplicates: usize,
    #[serde(default)]
    pub unhashed: bool,
}

pub fn detect_clock_shifts(cat: &Catalog) -> Result<Vec<ClockShift>> {
    // Nights: wall time shifted by 12 h so one night has one date.
    let mut st = cat.conn.prepare(
        &format!("SELECT d.id, d.name, {} AS w, COALESCE(r.local_offset_min, 0)
         FROM recording r JOIN device d ON d.id = r.device_id WHERE r.start_ms IS NOT NULL ORDER BY d.id, w", crate::WALL))?;
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
                    shift_min: hours * 60, clock_before: before.label(), clock_after: after.label(), kind: "jump", duplicates: 0, unhashed: false,
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
                &format!("SELECT MIN({}) FROM recording r WHERE r.device_id = ?1", crate::WALL), [dev], |r| r.get::<_, i64>(0))?;
            out.push(ClockShift {
                device_id: dev, device: name,
                from: chrono::DateTime::from_timestamp_millis(first).unwrap_or_default().naive_utc().format("%Y-%m-%dT%H:%M:%S").to_string(),
                shift_min: j.shift_min, clock_before: j.clock_before.clone(), clock_after: j.clock_after.clone(), kind: "like-others", duplicates: 0, unhashed: false,
            });
        }
    }
    out.extend(detect_set_backs(cat)?);
    Ok(out)
}

/// Clock set back while recording: the same wall start occurs twice for one recorder, with different
/// content (identical fingerprints are plain copies and ignored). The duplicated span gives the size.
fn detect_set_backs(cat: &Catalog) -> Result<Vec<ClockShift>> {
    let mut st = cat.conn.prepare(&format!(
        "SELECT r.device_id, d.name, {} AS w, COALESCE(r.local_offset_min, 0),
                COUNT(*) AS n, COUNT(DISTINCT a.quick_hash) AS h, SUM(a.quick_hash IS NULL) AS un
         FROM recording r JOIN device d ON d.id = r.device_id JOIN asset a ON a.id = r.asset_id
         WHERE r.start_ms IS NOT NULL AND a.status != 'missing'
         GROUP BY r.device_id, w HAVING n > 1 ORDER BY r.device_id, w", crate::WALL))?;
    let rows: Vec<(i64, String, i64, i64, i64, i64, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut out = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        // Cluster duplicated walls of one device that are at most 30 min apart.
        let mut j = i;
        while j + 1 < rows.len() && rows[j + 1].0 == rows[i].0 && rows[j + 1].2 - rows[j].2 <= 30 * 60_000 { j += 1; }
        // Different content: more than one distinct fingerprint, or not fingerprinted yet.
        let real: Vec<_> = rows[i..=j].iter().filter(|c| c.6 > 0 || c.5 > 1).collect();
        if real.len() >= 2 {
            let span = real.last().unwrap().2 - real[0].2;
            let step = real.windows(2).map(|w| w[1].2 - w[0].2).min().unwrap_or(0);
            let hours = ((span + step) as f64 / 3_600_000.0).round() as i64;
            let covered: bool = cat.conn.query_row(
                "SELECT COUNT(*) > 0 FROM clock_period WHERE device_id = ?1 AND from_wall_ms BETWEEN ?2 AND ?3",
                params![rows[i].0, real[0].2 - 60_000, real[0].2 + 60_000], |r| r.get(0))?;
            // A set-back repeats whole hours; shorter duplicate runs are copies or re-recordings.
            let whole = (span + step - hours * 3_600_000).abs() <= 10 * 60_000;
            if hours >= 1 && whole && !covered {
                let off = real[0].3 as i32;
                out.push(ClockShift {
                    device_id: rows[i].0, device: rows[i].1.clone(),
                    from: chrono::DateTime::from_timestamp_millis(real[0].2).unwrap_or_default().naive_utc().format("%Y-%m-%dT%H:%M:%S").to_string(),
                    shift_min: -hours * 60, clock_before: Clock::Fixed(off).label(), clock_after: Clock::Fixed(off - hours as i32 * 60).label(),
                    kind: "set-back", duplicates: real.iter().map(|c| c.4 as usize).sum(), unhashed: real.iter().any(|c| c.6 > 0),
                });
            }
        }
        i = j + 1;
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
    fn out_of_range_offsets_are_rejected() {
        assert_eq!(Clock::parse("UTC+40000000:00"), None);
        assert_eq!(Clock::parse("fixed:-2147483648"), None);
        assert_eq!(Clock::parse("UTC+01:75"), None);
        assert_eq!(Clock::parse("UTC+14:00"), Some(Clock::Fixed(840)));
        assert_eq!(Clock::Fixed(i32::MIN).label().len() > 3, true, "label does not overflow");
    }

    fn one_file_catalog(name: &str, offset_min: i32) -> (Catalog, i64) {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["S{s}/{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "s".into(), role: "site".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            utc_offset_min: offset_min, ..Default::default()
        };
        import_scanned(&mut cat, root, &[ScannedFile { rel_path: name.into(), size: 1, mtime_ms: 0 }], &spec.build().unwrap()).unwrap();
        let site: i64 = cat.conn.query_row("SELECT id FROM site", [], |r| r.get(0)).unwrap();
        (cat, site)
    }
    fn start(cat: &Catalog) -> i64 { cat.conn.query_row("SELECT start_ms FROM recording", [], |r| r.get(0)).unwrap() }

    #[test]
    fn wall_time_in_the_spring_gap_survives_a_round_trip() {
        // 02:30 does not exist in Berlin on 2023-03-26.
        let (mut cat, site) = one_file_catalog("S1/20230326_023000.wav", 60);
        let before = start(&cat);
        set_site_clock(&mut cat, site, Clock::parse("Europe/Berlin").unwrap()).unwrap();
        set_site_clock(&mut cat, site, Clock::Fixed(60)).unwrap();
        assert_eq!(start(&cat), before, "back to UTC+01:00 gives the original instant");
    }

    #[test]
    fn reapplying_a_zone_keeps_the_later_pass_of_a_repeated_hour() {
        let (mut cat, site) = one_file_catalog("S1/20231029_023000.wav", 60);   // 02:30 CET = second pass in Berlin
        let z = Clock::parse("Europe/Berlin").unwrap();
        let later = z.to_utc_fold(t("2023-10-29 02:30:00"), true).0;
        cat.conn.execute("UPDATE recording SET start_ms = ?1, local_offset_min = 60", [later]).unwrap();
        set_site_clock(&mut cat, site, z).unwrap();
        assert_eq!(start(&cat), later);
    }

    #[test]
    fn new_recordings_follow_saved_clock_periods() {
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["R{d}/{t:%Y%m%d_%H%M%S}.wav".into()],
            mappings: vec![
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            utc_offset_min: 60, ..Default::default()
        };
        let p = spec.build().unwrap();
        let f = |n: &str| ScannedFile { rel_path: n.into(), size: 1, mtime_ms: 0 };
        import_scanned(&mut cat, root, &[f("R1/20230601_200000.wav")], &p).unwrap();
        let dev: i64 = cat.conn.query_row("SELECT id FROM device", [], |r| r.get(0)).unwrap();
        set_device_clocks(&mut cat, dev, &[ClockPeriod { from: None, clock: "UTC+02:00".into(), ..Default::default() }]).unwrap();
        import_scanned(&mut cat, root, &[f("R1/20230602_200000.wav")], &p).unwrap();
        let (utc, label): (i64, String) = cat.conn.query_row(
            "SELECT r.start_ms, r.tz FROM recording r JOIN asset a ON a.id = r.asset_id WHERE a.rel_path LIKE '%0602%'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(utc, Utc.with_ymd_and_hms(2023, 6, 2, 18, 0, 0).unwrap().timestamp_millis());
        assert_eq!(label, "UTC+02:00");
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
            ClockPeriod { from: None, clock: "UTC+01:00".into(), note: None, from_path: None },
            ClockPeriod { from: Some(shifts[0].from.clone()), clock: shifts[0].clock_after.clone(), note: Some("set by hand".into()), from_path: None },
        ];
        let rep = set_device_clocks(&mut cat, shifts[0].device_id, &periods).unwrap();
        assert_eq!(rep.updated, 12);
        set_device_clocks(&mut cat, shifts[1].device_id, &[ClockPeriod { from: None, clock: "UTC+02:00".into(), note: None, from_path: None }]).unwrap();
        assert_eq!(device_clocks(&cat, shifts[0].device_id).unwrap(), vec![
            ClockPeriod { from: None, clock: "UTC+01:00".into(), note: None, from_path: None },
            ClockPeriod { from: Some("2023-03-27T18:00:00".into()), clock: "UTC+02:00".into(), note: Some("set by hand".into()), from_path: None },
        ]);
        // Every night now starts at 16:00 UTC, and the wall times are unchanged.
        let starts: Vec<String> = cat.conn.prepare("SELECT time(MIN(start_ms)/1000, 'unixepoch') FROM recording GROUP BY date(start_ms/1000, 'unixepoch')").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(starts, ["16:00:00"; 4]);
        assert!(detect_clock_shifts(&cat).unwrap().is_empty(), "a change covered by a clock period is not suggested again");
    }

    fn wall(s: &str) -> i64 { wall_ms(parse_wall(s).unwrap()) }

    /// Continuous recording every 10 min from 01:00 to 04:00 true local CEST; at 03:00 CEST the clock
    /// is set back to 02:00 CET. Returns (inputs, expected UTC per id).
    fn set_back(name_second: impl Fn(&str) -> String) -> (Vec<ClockInput>, Vec<i64>) {
        let utc0 = Utc.with_ymd_and_hms(2023, 10, 28, 23, 0, 0).unwrap().timestamp_millis(); // 01:00 CEST
        let (mut recs, mut want) = (Vec::new(), Vec::new());
        for i in 0..24 {
            let utc = utc0 + i * 600_000;
            let off = if utc < utc0 + 2 * 3_600_000 { 120 } else { 60 };   // set back at 03:00 CEST
            let w = utc + off * 60_000;
            let stamp = chrono::DateTime::from_timestamp_millis(w).unwrap().naive_utc().format("%Y%m%d_%H%M%S").to_string();
            let path = if off == 60 && w < utc0 + 3 * 3_600_000 + 60 * 60_000 && w >= utc0 + 2 * 3_600_000 + 60 * 60_000 - 3_600_000 {
                name_second(&stamp)
            } else if off == 60 { name_second(&stamp) } else { format!("R/{stamp}.wav") };
            recs.push(ClockInput { id: i, wall_ms: w, path, header_offset_min: None });
            want.push(utc);
        }
        (recs, want)
    }

    fn periods_set_back(from_path: Option<&str>) -> Vec<ClockPeriod> {
        vec![
            ClockPeriod { from: None, clock: "UTC+02:00".into(), ..Default::default() },
            ClockPeriod { from: Some("2023-10-29T02:00:00".into()), clock: "UTC+01:00".into(), from_path: from_path.map(String::from), ..Default::default() },
        ]
    }

    #[test]
    fn set_back_with_suffix_names_is_resolved_by_file_order() {
        let (recs, want) = set_back(|stamp| format!("R/{stamp}_1.wav"));
        let out = assign_clocks(&periods_set_back(None), &recs).unwrap();
        let got: Vec<i64> = out.iter().map(|o| o.utc_ms).collect();
        assert_eq!(got, want);
        assert_eq!(out.iter().filter(|o| o.fold == Fold::Ambiguous).count(), 12, "both passes of the repeated hour reported");
    }

    #[test]
    fn set_back_with_a_new_folder_and_explicit_first_file() {
        let (recs, want) = set_back(|stamp| format!("S/{stamp}.wav"));
        assert_eq!(assign_clocks(&periods_set_back(None), &recs).unwrap().iter().map(|o| o.utc_ms).collect::<Vec<_>>(), want);
        // Override: first file after the change named explicitly.
        let out = assign_clocks(&periods_set_back(Some("S/20231029_020000.wav")), &recs).unwrap();
        assert_eq!(out.iter().map(|o| o.utc_ms).collect::<Vec<_>>(), want);
    }

    #[test]
    fn header_offset_wins_and_zone_autumn_hour_uses_file_order() {
        let (mut recs, want) = set_back(|stamp| format!("R/{stamp}_1.wav"));
        let zone = vec![ClockPeriod { from: None, clock: "Europe/Berlin".into(), ..Default::default() }];
        let out = assign_clocks(&zone, &recs).unwrap();
        assert_eq!(out.iter().map(|o| o.utc_ms).collect::<Vec<_>>(), want, "auto-DST recorder");
        // A wrong period but correct offsets in the headers: headers win.
        for (r, w) in recs.iter_mut().zip(&want) { r.header_offset_min = Some(((r.wall_ms - w) / 60_000) as i32); }
        let wrong = vec![ClockPeriod { from: None, clock: "UTC+00:00".into(), ..Default::default() }];
        let out = assign_clocks(&wrong, &recs).unwrap();
        assert_eq!(out.iter().map(|o| o.utc_ms).collect::<Vec<_>>(), want);
        assert!(out.iter().all(|o| o.from_header));
    }

    #[test]
    fn set_back_is_detected_from_duplicate_wall_times_and_copies_are_ignored() {
        use crate::hash::{HashKind, store_hashes};
        let (recs, want) = set_back(|stamp| format!("R/{stamp}_1.wav"));
        let mut cat = Catalog::open_in_memory().unwrap();
        let root = cat.add_root("r", "referenced", "m", "/x").unwrap();
        let files: Vec<_> = recs.iter().map(|r| ScannedFile { rel_path: r.path.clone(), size: 1, mtime_ms: 0 }).collect();
        // The recorder writes wall time in the name; import with its (wrong after the set-back) CEST clock.
        let spec = ProfileSpec {
            name: "t".into(), patterns: vec!["{d}/{t:%Y%m%d_%H%M%S}*.wav".into()],
            mappings: vec![
                MappingSpec { field: "d".into(), role: "device".into(), ..Default::default() },
                MappingSpec { field: "t".into(), role: "start".into(), ..Default::default() },
            ],
            utc_offset_min: 120, ..Default::default()
        };
        import_scanned(&mut cat, root, &files, &spec.build().unwrap()).unwrap();
        let ids: Vec<(i64, String)> = cat.conn.prepare("SELECT id, rel_path FROM asset").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        // All different content.
        store_hashes(&mut cat, HashKind::Quick, &ids.iter().map(|(id, p)| (*id, format!("h-{p}"))).collect::<Vec<_>>()).unwrap();
        let s = detect_clock_shifts(&cat).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].kind, s[0].from.as_str(), s[0].shift_min, s[0].clock_after.as_str(), s[0].duplicates),
            ("set-back", "2023-10-29T02:00:00", -60, "UTC+01:00", 12));
        let rep = set_device_clocks(&mut cat, s[0].device_id, &[
            ClockPeriod { from: None, clock: s[0].clock_before.clone(), ..Default::default() },
            ClockPeriod { from: Some(s[0].from.clone()), clock: s[0].clock_after.clone(), ..Default::default() },
        ]).unwrap();
        assert_eq!(rep.ambiguous, 12);
        let mut got: Vec<i64> = cat.conn.prepare("SELECT start_ms FROM recording ORDER BY start_ms").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        got.dedup();
        assert_eq!(got, want, "24 distinct instants in true order");
        // Copies (same fingerprint) are not a set-back.
        cat.conn.execute("UPDATE asset SET quick_hash = 'same' || substr(rel_path, 3, 15)", []).unwrap();
        cat.conn.execute("DELETE FROM clock_period", []).unwrap();
        assert!(detect_clock_shifts(&cat).unwrap().iter().all(|x| x.kind != "set-back"));
    }

    #[test]
    fn forward_change_needs_no_file_order() {
        let recs = vec![
            ClockInput { id: 1, wall_ms: wall("2023-03-26T01:50:00"), path: "z.wav".into(), header_offset_min: None },
            ClockInput { id: 2, wall_ms: wall("2023-03-26T03:00:00"), path: "a.wav".into(), header_offset_min: None },
        ];
        let ps = vec![
            ClockPeriod { from: None, clock: "UTC+01:00".into(), ..Default::default() },
            ClockPeriod { from: Some("2023-03-26T03:00:00".into()), clock: "UTC+02:00".into(), ..Default::default() },
        ];
        let out = assign_clocks(&ps, &recs).unwrap();
        assert_eq!(out[1].utc_ms - out[0].utc_ms, 10 * 60_000);
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

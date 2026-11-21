//! Sun events (sunrise, sunset, civil dawn/dusk) for time-of-day rules relative to the sun, e.g.
//! "sunset − 1 h to sunrise". Algorithm: the standard sunrise equation (NOAA/Wikipedia form), good
//! to about a minute between the polar circles — enough to choose recordings.

use rusqlite::{Connection, functions::FunctionFlags};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SunEvent { Sunrise, Sunset, Dawn, Dusk }

impl SunEvent {
    pub fn as_str(&self) -> &'static str {
        match self { Self::Sunrise => "sunrise", Self::Sunset => "sunset", Self::Dawn => "dawn", Self::Dusk => "dusk" }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s { "sunrise" => Self::Sunrise, "sunset" => Self::Sunset, "dawn" => Self::Dawn, "dusk" => Self::Dusk, _ => return None })
    }
    /// Sun altitude of the event (degrees) and whether it is the morning one.
    fn altitude_morning(&self) -> (f64, bool) {
        match self { Self::Sunrise => (-0.833, true), Self::Sunset => (-0.833, false), Self::Dawn => (-6.0, true), Self::Dusk => (-6.0, false) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SunRef {
    pub event: SunEvent,
    /// Minutes after (negative: before) the event.
    #[serde(default)]
    pub offset_min: i64,
}

/// From one sun reference to the next occurrence of the other, e.g. sunset − 60 → sunrise + 0.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SunWindow { pub from: SunRef, pub to: SunRef }

const DAY_MS: i64 = 86_400_000;

/// UTC ms of `event` on the solar day `day` (days since 1970-01-01, UTC) at the position; None when
/// the sun does not reach the altitude that day (polar day or night).
pub fn event_ms(day: i64, lat: f64, lon: f64, event: SunEvent) -> Option<i64> {
    let (h0, morning) = event.altitude_morning();
    let rad = std::f64::consts::PI / 180.0;
    let n = (day as f64 + 2_440_588.0) - 2_451_545.0;            // Julian day at noon − J2000
    let j_star = n - lon / 360.0;
    let m = (357.5291 + 0.985_600_28 * j_star).rem_euclid(360.0);
    let c = 1.9148 * (m * rad).sin() + 0.02 * (2.0 * m * rad).sin() + 0.0003 * (3.0 * m * rad).sin();
    let l = (m + c + 180.0 + 102.9372).rem_euclid(360.0);
    let transit = 2_451_545.0 + j_star + 0.0053 * (m * rad).sin() - 0.0069 * (2.0 * l * rad).sin();
    let sin_d = (l * rad).sin() * (23.4397 * rad).sin();
    let cos_d = (1.0 - sin_d * sin_d).sqrt();
    let cos_w = ((h0 * rad).sin() - (lat * rad).sin() * sin_d) / ((lat * rad).cos() * cos_d);
    if !(-1.0..=1.0).contains(&cos_w) { return None; }
    let w = cos_w.acos() / rad / 360.0;
    let jd = if morning { transit - w } else { transit + w };
    Some(((jd - 2_440_587.5) * DAY_MS as f64).round() as i64)
}

/// Is `t_ms` inside the window (from inclusive, to exclusive)? The window starts at `from` on some
/// day and ends at the first `to` after that.
pub fn in_window(t_ms: i64, lat: f64, lon: f64, w: &SunWindow) -> bool {
    let day = t_ms.div_euclid(DAY_MS);
    for d in day - 2..=day + 1 {
        let Some(a) = event_ms(d, lat, lon, w.from.event).map(|e| e + w.from.offset_min * 60_000) else { continue };
        if t_ms < a { continue; }
        let b = (d..=d + 2)
            .filter_map(|k| event_ms(k, lat, lon, w.to.event).map(|e| e + w.to.offset_min * 60_000))
            .find(|&b| b > a);
        if let Some(b) = b && t_ms < b { return true; }
    }
    false
}

/// SQL `sun_in(start_ms, lat, lon, from_event, from_off_min, to_event, to_off_min)` → 1/0, NULL
/// when start or position is unknown.
pub(crate) fn register(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function("sun_in", 7, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        let (Some(t), Some(lat), Some(lon)) = (ctx.get::<Option<i64>>(0)?, ctx.get::<Option<f64>>(1)?, ctx.get::<Option<f64>>(2)?)
            else { return Ok(None) };
        let ev = |i: usize| -> rusqlite::Result<SunEvent> {
            let s: String = ctx.get(i)?;
            SunEvent::parse(&s).ok_or_else(|| rusqlite::Error::UserFunctionError(format!("unknown sun event {s}").into()))
        };
        let w = SunWindow {
            from: SunRef { event: ev(3)?, offset_min: ctx.get(4)? },
            to: SunRef { event: ev(5)?, offset_min: ctx.get(6)? },
        };
        Ok(Some(in_window(t, lat, lon, &w) as i64))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn day_of(y: i32, m: u32, d: u32) -> i64 { Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap().timestamp_millis() / DAY_MS }
    fn hm(ms: i64) -> String { Utc.timestamp_millis_opt(ms).unwrap().format("%H:%M").to_string() }
    fn minutes(s: &str) -> i64 { let (h, m) = s.split_once(':').unwrap(); h.parse::<i64>().unwrap() * 60 + m.parse::<i64>().unwrap() }

    #[test]
    fn berlin_equinox_and_midsummer() {
        // Reference times from the Python package astral 3 (independent implementation), UTC, Berlin:
        // 2023-03-20 sunrise 05:10, sunset 17:18; 2023-06-21 sunrise 02:43, sunset 19:32, civil dawn 01:52.
        let (lat, lon) = (52.52, 13.405);
        let cases = [
            (day_of(2023, 3, 20), SunEvent::Sunrise, "05:10"), (day_of(2023, 3, 20), SunEvent::Sunset, "17:18"),
            (day_of(2023, 6, 21), SunEvent::Sunrise, "02:43"), (day_of(2023, 6, 21), SunEvent::Sunset, "19:32"),
            (day_of(2023, 6, 21), SunEvent::Dawn, "01:52"),
        ];
        for (d, ev, want) in cases {
            let got = hm(event_ms(d, lat, lon, ev).unwrap());
            assert!((minutes(&got) - minutes(want)).abs() <= 2, "{ev:?} {got} vs {want}");
        }
    }

    #[test]
    fn polar_night_has_no_sunrise() {
        assert!(event_ms(day_of(2023, 12, 21), 78.2, 15.6, SunEvent::Sunrise).is_none()); // Svalbard
    }

    #[test]
    fn night_window_wraps_midnight() {
        let (lat, lon) = (52.52, 13.405);
        let night = SunWindow { from: SunRef { event: SunEvent::Sunset, offset_min: -60 }, to: SunRef { event: SunEvent::Sunrise, offset_min: 0 } };
        let at = |d: u32, h: u32, m: u32| Utc.with_ymd_and_hms(2023, 3, d, h, m, 0).unwrap().timestamp_millis();
        assert!(in_window(at(20, 16, 30), lat, lon, &night), "sunset − 47 min");
        assert!(in_window(at(20, 23, 0), lat, lon, &night));
        assert!(in_window(at(21, 3, 0), lat, lon, &night), "after midnight");
        assert!(!in_window(at(21, 5, 30), lat, lon, &night), "after sunrise");
        assert!(!in_window(at(20, 12, 0), lat, lon, &night));
        assert!(!in_window(at(20, 16, 0), lat, lon, &night), "sunset − 77 min");
        // Daytime window does not wrap.
        let day = SunWindow { from: night.to, to: SunRef { event: SunEvent::Sunset, offset_min: 0 } };
        assert!(in_window(at(20, 12, 0), lat, lon, &day));
        assert!(!in_window(at(20, 23, 0), lat, lon, &day));
    }
}

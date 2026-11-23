//! Lengths of time and dates as people type them, with the same rules as Good Boy 3.

pub const SECOND: i64 = 1000;
pub const MINUTE: i64 = 60 * SECOND;
pub const HOUR: i64 = 60 * MINUTE;
pub const DAY: i64 = 24 * HOUR;

/// "90s", "10m", "2h", "1d", "1w" and sums such as "1h30m". Nothing else.
pub fn parse_duration(input: &str) -> Option<i64> {
    let s: String = input.trim().to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    if s.is_empty() {
        return None;
    }
    let (mut total, mut digits) = (0i64, String::new());
    for c in s.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit = match c {
            'w' => 7 * DAY,
            'd' => DAY,
            'h' => HOUR,
            'm' => MINUTE,
            's' => SECOND,
            _ => return None,
        };
        let n: i64 = digits.parse().ok()?; // a unit with no number before it is not a duration
        total = total.checked_add(n.checked_mul(unit)?)?;
        digits.clear();
    }
    (digits.is_empty() && total > 0).then_some(total)
}

/// Days since 1970-01-01 for a calendar date (the proleptic Gregorian calendar, as JavaScript's Date.UTC uses).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// A moment someone typed: a delay ("2h") from `now`, or "2026-12-31 18:30" in the server's timezone offset.
pub fn parse_when(input: &str, offset_hours: i64, now_ms: i64) -> Result<i64, &'static str> {
    const HOW: &str = "Use a delay like `2h` or `1d`, or a date like `2026-12-31 18:30` (in the server's timezone offset setting).";
    if let Some(ms) = parse_duration(input) {
        return Ok(now_ms + ms);
    }
    let t = input.trim();
    let (date, time) = t.split_once([' ', 'T']).ok_or(HOW)?;
    let d: Vec<&str> = date.split('-').collect();
    let (h, min) = time.split_once(':').ok_or(HOW)?;
    let digits = |s: &str, lens: &[usize]| lens.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    if d.len() != 3 || !digits(d[0], &[4]) || !digits(d[1], &[2]) || !digits(d[2], &[2]) || !digits(h, &[1, 2]) || !digits(min, &[2]) {
        return Err(HOW);
    }
    let n = |s: &str| s.parse::<i64>().unwrap_or(0);
    // like Date.UTC, a month or day past the end rolls over rather than being refused
    let months = n(d[1]) - 1;
    let (year, month) = (n(d[0]) + months.div_euclid(12), months.rem_euclid(12) + 1);
    let day_number = days_from_civil(year, month, 1) + n(d[2]) - 1;
    Ok(day_number * DAY + n(h) * HOUR + n(min) * MINUTE - offset_hours * HOUR)
}

/// Days since 1970 as (year, month, day).
pub fn civil(days: i64) -> (i64, i64, i64) {
    let d = date(days * DAY);
    let p: Vec<i64> = d.split('-').map(|x| x.parse().unwrap_or(0)).collect();
    (p[0], p[1], p[2])
}
/// The calendar date of a moment, as 2026-12-31 (UTC).
pub fn date(ms: i64) -> String {
    // days since 1970 back to a calendar date (the reverse of `days_from_civil`)
    let z = ms.div_euclid(DAY) + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// A length of time in words: "2 hours 5 minutes".
pub fn in_words(ms: i64) -> String {
    let mut left = ms.max(0) / SECOND;
    let mut parts = Vec::new();
    // whole weeks are said in weeks; anything else in days ("30 days", not "4 weeks 2 days")
    let days = left / 86400;
    let week = if days > 0 && days % 7 == 0 { 604800 } else { i64::MAX };
    for (size, one, many) in [(week, "week", "weeks"), (86400, "day", "days"), (3600, "hour", "hours"), (60, "minute", "minutes"), (1, "second", "seconds")] {
        let n = left / size;
        left %= size;
        if n > 0 && parts.len() < 2 {
            parts.push(format!("{n} {}", if n == 1 { one } else { many }));
        }
    }
    if parts.is_empty() { "a moment".into() } else { parts.join(" ") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration("10m"), Some(10 * MINUTE));
        assert_eq!(parse_duration(" 1h 30m "), Some(90 * MINUTE));
        assert_eq!(parse_duration("2W"), Some(14 * DAY));
        for bad in ["", "m", "10", "10x", "h2", "0m", "1h30", "-5m"] {
            assert_eq!(parse_duration(bad), None, "{bad}");
        }
    }
    #[test]
    fn dates() {
        assert_eq!(parse_when("2026-12-31 18:30", 0, 0), Ok(1798741800000));
        assert_eq!(parse_when("2026-12-31T18:30", 2, 0), Ok(1798741800000 - 2 * HOUR));
        assert_eq!(parse_when("1970-01-01 0:00", 0, 5), Ok(0));
        assert_eq!(parse_when("2h", 0, 1000), Ok(1000 + 2 * HOUR));
        assert!(parse_when("tomorrow", 0, 0).is_err());
        assert!(parse_when("2026-1-01 10:00", 0, 0).is_err());
        assert_eq!(in_words(2 * HOUR + 5 * MINUTE + 3 * SECOND), "2 hours 5 minutes");
        assert_eq!(in_words(DAY), "1 day");
        assert_eq!((in_words(30 * DAY), in_words(14 * DAY)), ("30 days".to_string(), "2 weeks".to_string()));
        assert_eq!((date(1798741800000), date(0), date(951782400000)), ("2026-12-31".to_string(), "1970-01-01".to_string(), "2000-02-29".to_string()));
    }
}

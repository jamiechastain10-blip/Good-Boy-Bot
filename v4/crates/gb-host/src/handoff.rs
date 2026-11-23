//! The handover from the last Good Boy 3: it writes one small file with the bot's token and licence and starts this
//! program with `--from-v3 <file>`. The file is read once and deleted straight away. The token goes to the computer's
//! own credential store, like any token given to Good Boy 4; it never leaves this computer.

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// What Good Boy 3 hands over.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Handoff {
    pub v: u32,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub license: String,
    /// Where Good Boy 4 writes a file once the bot is running, so Good Boy 3 knows it can step aside.
    #[serde(default)]
    pub marker: String,
    /// The backup Good Boy 3 made first (kept for 14 days, then removed).
    #[serde(default)]
    pub backup: String,
    /// The folder Good Boy 3 keeps its data in (the one holding eclipse.db): this is the data that moves across.
    #[serde(default)]
    pub data: String,
}

/// Reads the handover and deletes the file, whatever it held (a token must not stay on disk).
pub fn read(file: &Path) -> Result<Handoff, String> {
    let text = std::fs::read_to_string(file).map_err(|_| "The handover from Good Boy 3 could not be read.".to_string());
    let _ = std::fs::remove_file(file);
    let h: Handoff = serde_json::from_str(&text?).map_err(|_| "The handover from Good Boy 3 was not in the form expected.".to_string())?;
    if h.v != 1 || h.token.is_empty() { return Err("The handover from Good Boy 3 had no bot token in it.".into()); }
    Ok(h)
}

/// Tells Good Boy 3 the bot is running (it checks for this file, then removes itself).
pub fn mark_started(marker: &str) -> Result<(), String> {
    if marker.is_empty() { return Ok(()); }
    let path = PathBuf::from(marker);
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    std::fs::write(path, b"{\"started\":true}").map_err(|e| e.to_string())
}

/// The folder name every Good Boy 3 backup of this kind has; nothing else is ever removed.
pub fn is_backup(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("before-v4-")) && path.join("backup.json").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gb-handoff-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    #[test]
    fn the_handover_is_read_once_and_the_file_is_deleted() {
        let d = dir("read");
        let f = d.join("handoff-v4.json");
        std::fs::write(&f, r#"{"v":1,"token":"abc.def.ghi","license":"GB1.a.b","marker":"x/started.json","backup":"b","from":"4.0.0","data":"d"}"#).unwrap();
        let h = read(&f).unwrap();
        assert_eq!((h.token.as_str(), h.license.as_str(), h.marker.as_str()), ("abc.def.ghi", "GB1.a.b", "x/started.json"));
        assert!(!f.exists(), "a token must not stay on disk");
        assert!(read(&f).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn a_bad_or_empty_handover_is_refused_and_still_deleted() {
        let d = dir("bad");
        for body in ["not json", r#"{"v":2,"token":"t"}"#, r#"{"v":1,"token":""}"#] {
            let f = d.join("h.json");
            std::fs::write(&f, body).unwrap();
            assert!(read(&f).is_err(), "{body}");
            assert!(!f.exists());
        }
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn the_started_marker_is_written_and_only_real_backups_are_recognised() {
        let d = dir("mark");
        let marker = d.join("deep").join("v4-started.json");
        mark_started(marker.to_str().unwrap()).unwrap();
        assert!(marker.is_file());
        assert!(mark_started("").is_ok());
        let backup = d.join("before-v4-2026-11-22");
        std::fs::create_dir_all(&backup).unwrap();
        assert!(!is_backup(&backup), "no backup.json yet");
        std::fs::write(backup.join("backup.json"), "{}").unwrap();
        assert!(is_backup(&backup));
        assert!(!is_backup(&d.join("Documents")));
        let _ = std::fs::remove_dir_all(&d);
    }
}

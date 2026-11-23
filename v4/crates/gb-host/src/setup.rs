//! First run, and where things are kept on this computer.

use gb_data::{find_3x_data, import_3x, Store, Summary};
use std::path::{Path, PathBuf};

/// Where things live, worked out from the environment (passed in, so it can be tested).
pub struct Folders {
    /// Good Boy 4's own data folder (holds eclipse.db).
    pub data: PathBuf,
    /// The folder Good Boy 3's app keeps its per-user data under, when this computer has one.
    pub old_app_data: Option<PathBuf>,
}

pub fn folders(var: &dyn Fn(&str) -> Option<String>, os: &str) -> Result<Folders, String> {
    let path = |name: &str| var(name).filter(|v| !v.trim().is_empty()).map(PathBuf::from);
    if let Some(custom) = path("GOODBOY_DATA_DIR") {
        // a chosen folder: look for Good Boy 3 in the usual place for this system all the same
        let old = match os { "windows" => path("APPDATA"), "macos" => path("HOME").map(|h| h.join("Library/Application Support")), _ => path("HOME").map(|h| h.join(".config")) };
        return Ok(Folders { data: custom, old_app_data: old });
    }
    match os {
        "windows" => {
            let roaming = path("APPDATA").ok_or("Windows did not say where application data is kept (APPDATA is not set).")?;
            Ok(Folders { data: roaming.join("Good Boy 4").join("data"), old_app_data: Some(roaming) })
        }
        "macos" => {
            let support = path("HOME").ok_or("HOME is not set.")?.join("Library/Application Support");
            Ok(Folders { data: support.join("Good Boy 4").join("data"), old_app_data: Some(support) })
        }
        _ => {
            let home = path("HOME").ok_or("HOME is not set.")?;
            let share = path("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share"));
            Ok(Folders { data: share.join("good-boy-4").join("data"), old_app_data: Some(home.join(".config")) })
        }
    }
}

/// What getting the data ready did.
pub enum Prepared {
    AlreadyHere(Summary),
    CameFromGoodBoy3 { from: PathBuf, summary: Summary, files: usize },
    StartedFresh,
}

/// Makes sure Good Boy 4 has a database: keeps the one it has, else copies Good Boy 3's, else starts a new one.
pub fn prepare_data(f: &Folders) -> Result<Prepared, String> {
    let db = f.data.join("eclipse.db");
    if db.is_file() {
        let store = Store::open_read_only(&db).map_err(|e| e.to_string())?;
        return Ok(Prepared::AlreadyHere(store.summary().map_err(|e| e.to_string())?));
    }
    let old = f.old_app_data.as_deref().map(find_3x_data).unwrap_or_default();
    match old.first() {
        Some(from) => {
            let report = import_3x(from, &f.data).map_err(|e| format!("Your Good Boy 3 data could not be copied: {e}\nNothing was changed."))?;
            Ok(Prepared::CameFromGoodBoy3 { from: from.clone(), summary: report.summary, files: report.files })
        }
        None => {
            Store::create(&db).map_err(|e| e.to_string())?;
            Ok(Prepared::StartedFresh)
        }
    }
}

pub fn describe(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn folders_on_each_system() {
        let w = folders(&env(&[("APPDATA", "C:/Users/kai/AppData/Roaming")]), "windows").unwrap();
        assert_eq!(w.data, PathBuf::from("C:/Users/kai/AppData/Roaming/Good Boy 4/data"));
        assert_eq!(w.old_app_data, Some(PathBuf::from("C:/Users/kai/AppData/Roaming")));
        let m = folders(&env(&[("HOME", "/Users/kai")]), "macos").unwrap();
        assert_eq!(m.data, PathBuf::from("/Users/kai/Library/Application Support/Good Boy 4/data"));
        let l = folders(&env(&[("HOME", "/home/kai")]), "linux").unwrap();
        assert_eq!((l.data, l.old_app_data), (PathBuf::from("/home/kai/.local/share/good-boy-4/data"), Some(PathBuf::from("/home/kai/.config"))));
        let custom = folders(&env(&[("GOODBOY_DATA_DIR", "/srv/gb"), ("HOME", "/home/kai")]), "linux").unwrap();
        assert_eq!(custom.data, PathBuf::from("/srv/gb"));
        assert!(folders(&env(&[]), "windows").is_err());
    }

    #[test]
    fn with_no_good_boy_3_a_fresh_database_is_made_once_and_then_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let f = Folders { data: tmp.path().join("gb4"), old_app_data: Some(tmp.path().join("nothing-here")) };
        assert!(matches!(prepare_data(&f).unwrap(), Prepared::StartedFresh));
        assert!(f.data.join("eclipse.db").is_file());
        assert!(matches!(prepare_data(&f).unwrap(), Prepared::AlreadyHere(s) if s.servers == 0));
    }
}

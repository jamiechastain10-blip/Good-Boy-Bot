//! Bringing a Good Boy 3 install's data into Good Boy 4.
//!
//! The rule: the 3.x data is only ever read. Everything is copied into v4's own folder, so the old version
//! keeps working exactly as it was and going back is always possible. The database is copied with SQLite's
//! own backup, which is safe even while the old bot is still running.

use crate::{DataError, Result, Store, Summary};
use rusqlite::{backup::Backup, Connection};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What was brought across.
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub from: PathBuf,
    pub to: PathBuf,
    /// What the copied database holds.
    pub summary: Summary,
    /// Other files copied (your own art, saved uploads, legal pages...), and their total size.
    pub files: usize,
    pub bytes: u64,
    /// True when v4 already had data here and it was kept (nothing was overwritten).
    pub already_there: bool,
}

const DB: &str = "eclipse.db";

/// The folders Good Boy 3's app keeps its data in, for each edition, newest first when several exist.
/// `app_data` is the per-user application data folder (Windows: %APPDATA%, macOS: ~/Library/Application Support).
pub fn find_3x_data(app_data: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = ["Good Boy", "Good Boy Developer", "Good Boy Owner"]
        .iter()
        .map(|name| app_data.join(name).join("bot-data"))
        .filter(|dir| dir.join(DB).is_file())
        .map(|dir| (fs::metadata(dir.join(DB)).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), dir))
        .collect();
    found.sort_by_key(|(when, _)| std::cmp::Reverse(*when));
    found.into_iter().map(|(_, dir)| dir).collect()
}

/// Copies a 3.x data folder (`from`, the folder holding eclipse.db) into v4's data folder (`to`).
/// Never changes `from`. Never overwrites data v4 already has: if `to` holds a database, it is kept and reported.
pub fn import_3x(from: &Path, to: &Path) -> Result<ImportReport> {
    let source = from.join(DB);
    let old = Store::open_read_only(&source)?; // also refuses a database from a newer Good Boy
    old.integrity_ok()?;
    let target = to.join(DB);
    if target.is_file() {
        let summary = Store::open_read_only(&target)?.summary()?;
        return Ok(ImportReport { from: from.to_path_buf(), to: to.to_path_buf(), summary, files: 0, bytes: 0, already_there: true });
    }
    fs::create_dir_all(to)?;
    // 1. the database, through SQLite's backup (a consistent copy even if 3.x is writing right now)
    let part = to.join(format!("{DB}.importing"));
    let _ = fs::remove_file(&part);
    {
        let mut dst = Connection::open(&part)?;
        let backup = Backup::new(old.conn(), &mut dst)?;
        backup.run_to_completion(256, Duration::from_millis(5), None)?;
    }
    // 2. check the copy before it becomes v4's database
    {
        let copy = Connection::open(&part)?;
        let answer: String = copy.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if answer != "ok" {
            let _ = fs::remove_file(&part);
            return Err(DataError::Damaged(format!("the copy did not pass its check ({answer}); nothing was changed")));
        }
        copy.execute_batch(
            "CREATE TABLE IF NOT EXISTS v4_meta (key TEXT PRIMARY KEY, value TEXT);
             PRAGMA journal_mode = WAL;",
        )?;
        copy.execute("INSERT OR REPLACE INTO v4_meta (key, value) VALUES ('imported_from', ?)", [from.to_string_lossy().as_ref()])?;
        copy.execute("INSERT OR REPLACE INTO v4_meta (key, value) VALUES ('imported_schema', ?)", [old.schema_version()?.to_string()])?;
    }
    // 3. the other files (your art, uploads, anything modules saved), skipping the database and its side files
    let (mut files, mut bytes) = (0usize, 0u64);
    copy_tree(from, to, &mut files, &mut bytes)?;
    // 4. only now does the copy get its real name
    fs::rename(&part, &target)?;
    let summary = Store::open_read_only(&target)?.summary()?;
    Ok(ImportReport { from: from.to_path_buf(), to: to.to_path_buf(), summary, files, bytes, already_there: false })
}

fn copy_tree(from: &Path, to: &Path, files: &mut usize, bytes: &mut u64) -> Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let lossy = name.to_string_lossy();
        let kind = entry.file_type()?;
        if kind.is_symlink() || lossy.starts_with(DB) || lossy == "backups" {
            continue; // links are never followed; the database was copied above; old backups stay with the old version
        }
        let (src, dst) = (entry.path(), to.join(&name));
        if kind.is_dir() {
            fs::create_dir_all(&dst)?;
            copy_tree(&src, &dst, files, bytes)?;
        } else if kind.is_file() && !dst.exists() {
            *bytes += fs::copy(&src, &dst)?;
            *files += 1;
        }
    }
    Ok(())
}

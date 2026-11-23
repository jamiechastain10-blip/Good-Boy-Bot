//! Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! Updating Good Boy 4 from inside the program. It asks GitHub which Good Boy 4 is out, and when one is newer it
//! downloads the program, checks its size and its sha256 (the checksum GitHub recorded for the file) and only then
//! swaps it in for the running program. Nothing is replaced unless the file matches. Settings, data and the saved
//! token are not touched: they live outside the program.
//!
//! Only releases of this project, tagged `v4.x`, and only files from this project's own GitHub download address are
//! accepted. Everything that touches the network or the disk takes its inputs as arguments so each step is tested.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const OWNER: &str = "jamiechastain10-blip";
pub const REPO: &str = "Good-Boy-Bot";
pub const RELEASES: &str = "https://api.github.com/repos/jamiechastain10-blip/Good-Boy-Bot/releases?per_page=20";
const DOWNLOADS: &str = "https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/download/";

/// A Good Boy 4 that can be installed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub notes: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

fn parts(v: &str) -> [u64; 3] {
    let mut out = [0u64; 3];
    for (i, p) in v.trim_start_matches(['v', 'V']).split(['.', '-', '+']).take(3).enumerate() {
        out[i] = p.parse().unwrap_or(0);
    }
    out
}
/// Is version `a` newer than `b`?
pub fn newer(a: &str, b: &str) -> bool {
    parts(a) > parts(b)
}

/// The file name to look for: the window-less program for hosts runs the window-less update.
pub fn asset_for(exe: &Path) -> &'static str {
    let name = exe.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    if name.contains("no-window") { "Good-Boy-4-no-window.exe" } else { "Good-Boy-4.exe" }
}

/// The newest published `v4.x` release that is newer than `current`, has the file `asset`, and has a checksum on record.
/// Drafts are skipped, and so are test builds unless `allow_test`.
pub fn pick(releases: &Value, current: &str, asset: &str, allow_test: bool) -> Option<Release> {
    let mut best: Option<Release> = None;
    for r in releases.as_array()? {
        if r["draft"].as_bool().unwrap_or(false) || (!allow_test && r["prerelease"].as_bool().unwrap_or(false)) { continue; }
        let tag = r["tag_name"].as_str().unwrap_or("");
        if !tag.starts_with("v4.") { continue; }
        let version = tag.trim_start_matches('v').to_string();
        if !newer(&version, current) { continue; }
        let Some(a) = r["assets"].as_array().and_then(|l| l.iter().find(|a| a["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(asset)) && a["state"].as_str() != Some("new"))) else { continue };
        let sha = a["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(str::to_lowercase).filter(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit()));
        let url = a["browser_download_url"].as_str().unwrap_or("");
        let size = a["size"].as_u64().unwrap_or(0);
        let (Some(sha256), true, true) = (sha, url.starts_with(DOWNLOADS), size > 0) else { continue };
        if best.as_ref().is_none_or(|b| newer(&version, &b.version)) {
            best = Some(Release { version, notes: r["body"].as_str().unwrap_or("").chars().take(2000).collect(), url: url.to_string(), size, sha256 });
        }
    }
    best
}

/// Asks GitHub. `Ok(None)` means this is the newest. An error means GitHub could not be reached (not worth alarming anyone).
pub async fn check(current: &str, asset: &str, allow_test: bool) -> Result<Option<Release>, String> {
    let client = reqwest::Client::builder().user_agent("good-boy-4-updater").timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let res = client.get(RELEASES).header("Accept", "application/vnd.github+json").send().await.map_err(|_| "Could not reach GitHub to look for updates.".to_string())?;
    if !res.status().is_success() { return Err(format!("GitHub did not answer the update check ({}).", res.status().as_u16())); }
    let list: Value = res.json().await.map_err(|_| "GitHub's answer could not be read.".to_string())?;
    Ok(pick(&list, current, asset, allow_test))
}

/// Checks that a finished file is the one that was promised.
pub fn verify(file: &Path, size: u64, sha256: &str) -> Result<(), String> {
    let bytes = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    if bytes != size { return Err("The download is not the size it should be, so it was refused.".into()); }
    let mut hash = Sha256::new();
    let mut f = std::fs::File::open(file).map_err(|e| e.to_string())?;
    std::io::copy(&mut f, &mut hash).map_err(|e| e.to_string())?;
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != sha256.to_lowercase() { return Err("The download does not match its checksum, so it was refused. Nothing was changed.".into()); }
    Ok(())
}

/// Downloads the release to `dest`, checking it as it arrives. Nothing is left behind if it fails.
pub async fn download(rel: &Release, dest: &Path, mut progress: impl FnMut(u8)) -> Result<(), String> {
    if !rel.url.starts_with(DOWNLOADS) { return Err("The download address is not one Good Boy trusts.".into()); }
    let client = reqwest::Client::builder().user_agent("good-boy-4-updater").timeout(std::time::Duration::from_secs(15 * 60)).build().map_err(|e| e.to_string())?;
    let mut res = client.get(&rel.url).send().await.map_err(|_| "The download could not start.".to_string())?;
    if !res.status().is_success() { return Err(format!("The download failed ({}).", res.status().as_u16())); }
    let part = dest.with_extension("part");
    let result: Result<(), String> = async {
        let mut out = std::fs::File::create(&part).map_err(|e| format!("Could not save the update: {e}"))?;
        let mut hash = Sha256::new();
        let mut got = 0u64;
        while let Some(chunk) = res.chunk().await.map_err(|_| "The download was interrupted.".to_string())? {
            got += chunk.len() as u64;
            if got > rel.size { return Err("The download is bigger than expected, so it was refused.".into()); }
            hash.update(&chunk);
            out.write_all(&chunk).map_err(|e| format!("Could not save the update: {e}"))?;
            progress(((got * 100) / rel.size.max(1)).min(100) as u8);
        }
        out.flush().map_err(|e| e.to_string())?;
        let sum: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != rel.size || sum != rel.sha256 { return Err("The download does not match its checksum, so it was refused. Nothing was changed.".into()); }
        Ok(())
    }.await;
    match result {
        Ok(()) => std::fs::rename(&part, dest).map_err(|e| format!("Could not save the update: {e}")),
        Err(e) => { let _ = std::fs::remove_file(&part); Err(e) }
    }
}

/// Where the replaced program is kept until the new one has started.
pub fn old_path(exe: &Path) -> PathBuf {
    exe.with_extension("exe.old")
}

/// Puts `new` where `exe` is. The running program is renamed (Windows allows that, not deleting) to `.old`, the new
/// file takes its place, and if that fails the old one is put back. Both must be in the same folder.
pub fn swap_in(exe: &Path, new: &Path) -> Result<PathBuf, String> {
    let old = old_path(exe);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| format!("Could not replace the program in its folder ({e}). Install Good Boy with its installer, or keep the program in a folder you can write to, such as one inside your user folder, and try again."))?;
    if let Err(e) = std::fs::rename(new, exe) {
        let _ = std::fs::rename(&old, exe);
        return Err(format!("Could not put the update in place, so nothing was changed: {e}"));
    }
    Ok(old)
}
/// Puts the replaced program back (used when the new one could not be started).
pub fn swap_back(exe: &Path) -> Result<(), String> {
    let old = old_path(exe);
    let _ = std::fs::remove_file(exe);
    std::fs::rename(&old, exe).map_err(|e| format!("Could not put the old program back: {e}"))
}
/// Tells Windows' installed-programs list which version is now installed, when Good Boy was installed with its installer
/// (the entry the installer made). Does nothing when there is no such entry, so a program run on its own is left alone.
pub fn note_version(version: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\BasicGhostLabsGoodBoy4";
        let run = |args: &[&str]| std::process::Command::new("reg").args(args).creation_flags(0x0800_0000).output().map(|o| o.status.success()).unwrap_or(false);
        if run(&["query", key]) { run(&["add", key, "/v", "DisplayVersion", "/d", version, "/f"]); }
    }
    #[cfg(not(windows))]
    let _ = version;
}
/// Removes what an earlier update left behind. Safe to call at every start.
pub fn clean_up(exe: &Path) {
    let _ = std::fs::remove_file(old_path(exe));
    let _ = std::fs::remove_file(exe.with_extension("exe.new"));
    let _ = std::fs::remove_file(exe.with_extension("exe.part"));
}

/// Is a process with this id still running?
pub fn running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).creation_flags(0x0800_0000).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().any(|w| w == pid.to_string())).unwrap_or(false)
    }
    #[cfg(not(windows))]
    { Path::new(&format!("/proc/{pid}")).exists() }
}
/// Waits (up to `secs`) for the program that started the update to be gone, so the single-copy check does not turn the new one away.
pub fn wait_for_exit(pid: u32, secs: u64) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while running(pid) && std::time::Instant::now() < until { std::thread::sleep(std::time::Duration::from_millis(150)); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rel(tag: &str, pre: bool, name: &str, digest: Option<&str>, url_ok: bool) -> Value {
        let url = if url_ok { format!("{DOWNLOADS}{tag}/{name}") } else { format!("https://evil.example/{name}") };
        let mut a = json!({ "name": name, "size": 100, "browser_download_url": url, "state": "uploaded" });
        if let Some(d) = digest { a["digest"] = json!(d); }
        json!({ "tag_name": tag, "draft": false, "prerelease": pre, "body": "notes", "assets": [a] })
    }
    const SHA: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000001";

    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("4.0.10", "4.0.9") && newer("4.1.0", "4.0.99") && newer("v5.0.0", "4.9.9"));
        assert!(!newer("4.0.1", "4.0.1") && !newer("4.0.0", "4.0.1"));
    }
    #[test]
    fn the_newest_safe_release_is_chosen() {
        let list = json!([
            rel("v3.2.1", false, "Good-Boy-4.exe", Some(SHA), true),            // not a version 4
            rel("v4.0.0", false, "Good-Boy-4.exe", Some(SHA), true),            // not newer than 4.0.1
            rel("v4.0.2", false, "Good-Boy-4.exe", Some(SHA), true),
            rel("v4.0.9", true, "Good-Boy-4.exe", Some(SHA), true),             // a test build
            rel("v4.1.0", false, "Good-Boy-4.exe", None, true),                 // no checksum on record
            rel("v4.2.0", false, "Good-Boy-4.exe", Some(SHA), false),           // wrong download address
            rel("v4.3.0", false, "Good-Boy-4-no-window.exe", Some(SHA), true),  // not the file asked for
        ]);
        let got = pick(&list, "4.0.1", "Good-Boy-4.exe", false).unwrap();
        assert_eq!(got.version, "4.0.2");
        assert_eq!(got.sha256, SHA.trim_start_matches("sha256:"));
        assert_eq!(pick(&list, "4.0.1", "Good-Boy-4.exe", true).unwrap().version, "4.0.9", "test builds only when asked for");
        assert_eq!(pick(&list, "4.0.1", "Good-Boy-4-no-window.exe", false).unwrap().version, "4.3.0");
        assert!(pick(&list, "4.0.2", "Good-Boy-4.exe", false).is_none(), "already on the newest");
        assert!(pick(&json!({"message": "rate limited"}), "4.0.1", "Good-Boy-4.exe", false).is_none());
    }
    #[test]
    fn a_draft_is_never_offered() {
        let mut r = rel("v4.5.0", false, "Good-Boy-4.exe", Some(SHA), true);
        r["draft"] = json!(true);
        assert!(pick(&json!([r]), "4.0.1", "Good-Boy-4.exe", true).is_none());
    }
    #[test]
    fn the_program_for_hosts_gets_the_host_file() {
        assert_eq!(asset_for(Path::new("C:/x/Good-Boy-4-no-window.exe")), "Good-Boy-4-no-window.exe");
        assert_eq!(asset_for(Path::new("C:/x/Good-Boy-4.exe")), "Good-Boy-4.exe");
        assert_eq!(asset_for(Path::new("/opt/goodboy")), "Good-Boy-4.exe");
    }
    #[test]
    fn a_file_that_does_not_match_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("a.exe");
        std::fs::write(&f, b"hello").unwrap();
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"; // sha256("hello")
        assert!(verify(&f, 5, good).is_ok());
        assert!(verify(&f, 5, good.to_uppercase().as_str()).is_ok());
        assert!(verify(&f, 6, good).unwrap_err().contains("size"));
        assert!(verify(&f, 5, &"0".repeat(64)).unwrap_err().contains("checksum"));
    }
    #[test]
    fn the_swap_puts_the_new_one_in_and_can_be_undone() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("Good-Boy-4.exe");
        let new = tmp.path().join("Good-Boy-4.exe.new");
        std::fs::write(&exe, b"old").unwrap();
        std::fs::write(&new, b"new").unwrap();
        let old = swap_in(&exe, &new).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert_eq!(std::fs::read(&old).unwrap(), b"old");
        swap_back(&exe).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"old", "put back as it was");
        // when the new file is missing, nothing changes
        assert!(swap_in(&exe, &tmp.path().join("missing")).is_err());
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        // and leftovers go
        std::fs::write(old_path(&exe), b"x").unwrap();
        clean_up(&exe);
        assert!(!old_path(&exe).exists() && exe.exists());
    }
}

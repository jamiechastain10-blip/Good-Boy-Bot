//! The server's picture gallery: every picture uploaded for the bot is kept here so it is saved and can be used again.
//!
//! Pictures live in `files/gallery/<server>/`, named `<time>-<n>.<ext>` so a name can never point anywhere else. The name a
//! person gave a picture is kept in the data store. Using a picture for something (the welcome picture, the rank card
//! background) copies it, so removing it from the gallery never breaks a picture already in use.
use serde_json::json;
use std::path::PathBuf;

use crate::Db;

pub const MODULE: &str = "gallery";
/// Most pictures one server may keep.
pub const MAX_PICTURES: usize = 60;
/// Where a picture can be used: (id, what people see).
pub const SLOTS: &[(&str, &str)] = &[("welcome", "Welcome message"), ("goodbye", "Goodbye message"), ("rank", "Rank card background for everyone")];

/// One kept picture.
#[derive(Debug, Clone, PartialEq)]
pub struct Picture {
    /// Its file name, which is also its id.
    pub id: String,
    /// What the server called it.
    pub name: String,
    pub size: u64,
    /// When it was added, in milliseconds since 1970.
    pub at: i64,
}

/// A gallery file name as this module writes it (digits, a dash, digits, a picture extension).
pub fn ok_file(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    matches!(ext, "png" | "jpg" | "gif" | "webp") && stem.split_once('-').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit()))
}
/// A picture's name as people may type it: no odd characters, not too long, never empty.
pub fn clean_name(name: &str) -> String {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let kept: String = stem.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | '`' | '@' | '#' | '\\' | '/')).collect();
    let kept = kept.trim().chars().take(60).collect::<String>();
    if kept.trim().is_empty() { "Picture".into() } else { kept.trim().to_string() }
}

pub struct Gallery<'a> {
    pub db: &'a Db,
    pub guild: &'a str,
}
impl Gallery<'_> {
    pub fn dir(&self) -> Option<PathBuf> {
        Some(self.db.get().path().parent()?.join("files").join(MODULE).join(self.guild))
    }
    fn meta_key(id: &str) -> String { format!("name:{id}") }
    fn name_of(&self, id: &str) -> Option<String> {
        let v = self.db.get().data_get(self.guild, MODULE, &Self::meta_key(id)).ok().flatten()?;
        v["name"].as_str().map(str::to_string)
    }
    /// Everything kept, oldest first.
    pub fn list(&self) -> Vec<Picture> {
        let Some(dir) = self.dir() else { return Vec::new() };
        let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut out: Vec<Picture> = rd.filter_map(|e| e.ok()).filter_map(|e| {
            let id = e.file_name().to_string_lossy().to_string();
            if !ok_file(&id) { return None; }
            let size = e.metadata().ok()?.len();
            let at = id.split('-').next()?.parse::<i64>().ok()?;
            Some(Picture { name: self.name_of(&id).unwrap_or_else(|| "Picture".into()), id, size, at })
        }).collect();
        out.sort_by_key(|p| (p.at, p.id.clone()));
        out
    }
    /// Keeps a picture. Returns its id.
    pub fn add(&self, name: &str, bytes: &[u8], at_ms: i64) -> Result<String, String> {
        let ext = crate::welcome::image_ext(name, bytes)?;
        if self.list().len() >= MAX_PICTURES { return Err(format!("The gallery is full ({MAX_PICTURES} pictures). Remove one first.")); }
        let dir = self.dir().ok_or("The data folder is not ready yet.")?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("The picture could not be saved ({e})."))?;
        let mut n = 0;
        let id = loop {
            let id = format!("{at_ms}-{n}.{ext}");
            if !dir.join(&id).exists() { break id; }
            n += 1;
        };
        std::fs::write(dir.join(&id), bytes).map_err(|e| format!("The picture could not be saved ({e})."))?;
        self.db.get().data_set(self.guild, MODULE, &Self::meta_key(&id), &json!({ "name": clean_name(name) })).map_err(|e| e.to_string())?;
        Ok(id)
    }
    /// Notes a picture that is being downloaded into the gallery from Discord (the file arrives a moment later).
    pub fn name_upload(&self, id: &str, name: &str) {
        if ok_file(id) { let _ = self.db.get().data_set(self.guild, MODULE, &Self::meta_key(id), &json!({ "name": clean_name(name) })); }
    }
    pub fn bytes(&self, id: &str) -> Option<Vec<u8>> {
        if !ok_file(id) { return None; }
        std::fs::read(self.dir()?.join(id)).ok()
    }
    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        if self.bytes(id).is_none() { return Err("That picture is not in the gallery.".into()); }
        self.db.get().data_set(self.guild, MODULE, &Self::meta_key(id), &json!({ "name": clean_name(name) })).map_err(|e| e.to_string())
    }
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if !ok_file(id) { return Err("That picture is not in the gallery.".into()); }
        let dir = self.dir().ok_or("The data folder is not ready yet.")?;
        std::fs::remove_file(dir.join(id)).map_err(|_| "That picture is not in the gallery.".to_string())?;
        let _ = self.db.get().data_delete(self.guild, MODULE, &Self::meta_key(id));
        let _ = std::fs::remove_file(dir.join("thumbs").join(format!("{id}.png")));
        Ok(())
    }
    /// The picture at a place in the list (1 is the oldest), as people count them in Discord.
    pub fn nth(&self, n: i64) -> Option<Picture> {
        if n < 1 { return None; }
        self.list().into_iter().nth(n as usize - 1)
    }
}
/// A summary the dashboard and `/images` show: a size in words.
pub fn size_words(bytes: u64) -> String {
    if bytes >= 1 << 20 { format!("{:.1} MB", bytes as f64 / (1 << 20) as f64) } else { format!("{} KB", (bytes / 1024).max(1)) }
}

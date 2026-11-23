//! Settings: what each module can be told, with the same keys and stored values as Good Boy 3.
//!
//! Settings are read on every message, so they are kept in memory. A server's settings for a module are read
//! from the database once and reused until one of them changes.

use crate::Db;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Toggle,
    Number { min: i64, max: i64 },
    Text { max_len: usize },
    Channel,
    /// A category of channels.
    Category,
    Role,
    /// A list of short texts (ids, words, lines).
    List,
    Select(&'static [&'static str]),
    /// A colour, kept as "#rrggbb". The dashboard shows a colour picker.
    Colour,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fallback {
    None,
    Bool(bool),
    Int(i64),
    Str(&'static str),
}
/// One setting a module has.
#[derive(Debug, Clone, Copy)]
pub struct Def {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub default: Fallback,
}
impl Def {
    pub fn default_value(&self) -> Value {
        match self.default {
            Fallback::Bool(b) => json!(b),
            Fallback::Int(n) => json!(n),
            Fallback::Str(s) => json!(s),
            Fallback::None => if self.kind == Kind::List { json!([]) } else { Value::Null },
        }
    }
}

/// Which heading a setting sits under in the launcher, for modules with many settings. Empty means no heading.
pub fn group(module: &str, key: &str) -> &'static str {
    match module {
        "moderation" => match key {
            "logChannel" | "dmOnAction" => "Basics",
            "leaveRecords" | "leaveRecordDays" | "leaveAlerts" => "Who leaves",
            k if k.starts_with("log") || k == "serverLogChannel" => "Server logs",
            k if k.starts_with("warn") || k.starts_with("strike") => "Warnings and strikes",
            "appealChannel" | "appealVotes" | "reportChannel" | "needApproval" | "banEvasionAlerts" => "Appeals, reports and approvals",
            "automodAction" | "automodTimeoutMinutes" | "automodKeepSnippets" => "AutoMod: how it acts",
            "automodScams" | "scamsAction" => "AutoMod: scam links",
            "automodSpam" | "spamMaxMessages" | "spamWindowSeconds" | "spamAction" => "AutoMod: spam",
            "automodWords" | "bannedWords" | "wordsAction" => "AutoMod: word filter",
            "automodLinks" | "allowedDomains" | "linksAction" => "AutoMod: links and invites",
            "maxMentions" | "mentionsAction" => "AutoMod: mass mentions",
            "automodRepeat" | "repeatMax" | "repeatWindowSeconds" | "repeatAction" => "AutoMod: repeated messages",
            "automodCaps" | "capsPercent" | "capsMinLetters" | "capsAction" => "AutoMod: capital letters",
            "automodEmoji" | "emojiMax" | "emojiAction" => "AutoMod: emoji",
            _ => "Other",
        },
        "economy" => match key {
            "workMin" | "workMax" | "workCooldownMinutes" => "Work",
            "dailyBase" => "Daily reward",
            _ => "Basics",
        },
        "community" => match key {
            k if k.starts_with("xp") || k == "noXpChannels" => "Earning XP",
            k if k.starts_with("reactionXp") || k.starts_with("voiceXp") => "Reaction and voice XP",
            k if k.starts_with("rep") => "Reputation",
            k if k.starts_with("liveBoard") => "Live leaderboard",
            "statsChannel" | "statsFormat" => "Member counter",
            "rankCards" | "cardBackgrounds" => "Rank cards",
            _ => "Level-ups",
        },
        "music" => match key {
            "volume" | "smooth" | "idleMinutes" => "Sound",
            "djRole" | "maxQueue" | "maxPerMember" => "Who can do what",
            _ => "Where songs come from",
        },
        "member-management" => match key {
            k if k.starts_with("welcome") => "Welcome",
            k if k.starts_with("goodbye") => "Goodbye",
            _ => "Verification",
        },
        "support" => match key {
            "ticketCategory" | "staffRole" | "logChannel" => "Basics",
            _ => "Limits and clean-up",
        },
        _ => "",
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SettingsError {
    #[error("\"{0}\" has no setting called \"{1}\".")]
    Unknown(String, String),
    #[error("\"{0}\" must be on or off.")]
    NotToggle(&'static str),
    #[error("\"{label}\" must be a number between {min} and {max}.")]
    NotNumber { label: &'static str, min: i64, max: i64 },
    #[error("\"{label}\" is limited to {max} characters.")]
    TooLong { label: &'static str, max: usize },
    #[error("That is not a valid {0}.")]
    NotId(&'static str),
    #[error("Choose one of: {0}")]
    NotChoice(String),
    #[error("\"{0}\" is not a colour. Use a code like #5865F2.")]
    NotColour(&'static str),
    #[error("Lists are limited to 100 entries of up to 200 characters.")]
    BadList,
    #[error("The setting could not be saved: {0}")]
    Save(String),
}

fn is_snowflake(s: &str) -> bool {
    (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

type Key = (String, String); // (server, module)

pub struct Settings {
    db: Db,
    defs: HashMap<&'static str, &'static [Def]>,
    held: RwLock<HashMap<Key, Arc<BTreeMap<String, Value>>>>,
}

impl Settings {
    pub fn new(db: Db) -> Settings {
        Settings { db, defs: HashMap::new(), held: RwLock::new(HashMap::new()) }
    }
    /// Tells the settings what a module can be told.
    pub fn register(&mut self, module: &'static str, defs: &'static [Def]) {
        self.defs.insert(module, defs);
    }
    pub fn defs(&self, module: &str) -> &'static [Def] {
        self.defs.get(module).copied().unwrap_or(&[])
    }

    fn stored(&self, guild: &str, module: &str) -> Arc<BTreeMap<String, Value>> {
        let key = (guild.to_string(), module.to_string());
        if let Some(hit) = self.held.read().unwrap_or_else(|p| p.into_inner()).get(&key) {
            return hit.clone();
        }
        let fresh = Arc::new(self.db.get().config_all(guild, module).unwrap_or_default());
        self.held.write().unwrap_or_else(|p| p.into_inner()).insert(key, fresh.clone());
        fresh
    }
    /// A setting's value: what the server chose, or the setting's default.
    pub fn get(&self, guild: &str, module: &str, key: &str) -> Value {
        if let Some(v) = self.stored(guild, module).get(key) {
            return v.clone();
        }
        self.defs(module).iter().find(|d| d.key == key).map(Def::default_value).unwrap_or(Value::Null)
    }
    /// True when the server chose a value for this setting (rather than it being the default).
    pub fn is_saved(&self, guild: &str, module: &str, key: &str) -> bool {
        self.stored(guild, module).contains_key(key)
    }
    pub fn bool(&self, guild: &str, module: &str, key: &str) -> bool {
        self.get(guild, module, key).as_bool().unwrap_or(false)
    }
    pub fn int(&self, guild: &str, module: &str, key: &str) -> i64 {
        let v = self.get(guild, module, key);
        v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).unwrap_or(0)
    }
    pub fn text(&self, guild: &str, module: &str, key: &str) -> Option<String> {
        self.get(guild, module, key).as_str().filter(|s| !s.is_empty()).map(str::to_string)
    }
    pub fn list(&self, guild: &str, module: &str, key: &str) -> Vec<String> {
        self.get(guild, module, key).as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
    }
    /// The channels (and categories) where a module is switched off, the same list `/channel` edits in 3.x.
    pub fn off_channels(&self, guild: &str, module: &str) -> Vec<String> {
        self.stored(guild, module).get("__offChannels").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str()).filter(|s| is_snowflake(s)).map(str::to_string).collect()).unwrap_or_default()
    }

    /// Checks a new value against the setting's rules, saves it, and makes the next read see it.
    pub fn set(&self, guild: &str, module: &str, key: &str, raw: &Value) -> Result<Value, SettingsError> {
        let def = self.defs(module).iter().find(|d| d.key == key).ok_or_else(|| SettingsError::Unknown(module.to_string(), key.to_string()))?;
        let value = check(def, raw)?;
        self.db.get().config_set(guild, module, key, &value).map_err(|e| SettingsError::Save(e.to_string()))?;
        self.forget(guild, module);
        Ok(value)
    }
    /// Switches a module off in these channels or categories (everywhere else it keeps working).
    pub fn set_off_channels(&self, guild: &str, module: &str, channels: &[String]) -> Result<(), SettingsError> {
        let mut seen: Vec<String> = Vec::new();
        for c in channels { if is_snowflake(c) && !seen.contains(c) { seen.push(c.clone()); } }
        self.db.get().config_set(guild, module, "__offChannels", &serde_json::json!(seen)).map_err(|e| SettingsError::Save(e.to_string()))?;
        self.forget(guild, module);
        Ok(())
    }
    /// Drops what is held for a server's module (something outside changed it, such as an import).
    pub fn forget(&self, guild: &str, module: &str) {
        self.held.write().unwrap_or_else(|p| p.into_inner()).remove(&(guild.to_string(), module.to_string()));
    }
}

fn check(def: &Def, raw: &Value) -> Result<Value, SettingsError> {
    match def.kind {
        Kind::Toggle => match raw {
            Value::Bool(b) => Ok(json!(b)),
            Value::String(s) if ["true", "on", "yes", "1"].contains(&s.to_lowercase().as_str()) => Ok(json!(true)),
            Value::String(s) if ["false", "off", "no", "0"].contains(&s.to_lowercase().as_str()) => Ok(json!(false)),
            _ => Err(SettingsError::NotToggle(def.label)),
        },
        Kind::Number { min, max } => {
            let n = raw.as_i64().or_else(|| raw.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)).or_else(|| raw.as_str().and_then(|s| s.trim().parse().ok()));
            match n {
                Some(n) if (min..=max).contains(&n) => Ok(json!(n)),
                _ => Err(SettingsError::NotNumber { label: def.label, min, max }),
            }
        }
        Kind::Text { max_len } => {
            let s = raw.as_str().unwrap_or_default();
            if s.chars().count() > max_len { Err(SettingsError::TooLong { label: def.label, max: max_len }) } else { Ok(json!(s)) }
        }
        Kind::Channel | Kind::Category | Kind::Role => {
            let what = match def.kind { Kind::Channel => "channel", Kind::Category => "category", _ => "role" };
            match raw {
                Value::Null => Ok(Value::Null),
                Value::String(s) if s.is_empty() || s.eq_ignore_ascii_case("none") => Ok(Value::Null),
                Value::String(s) => {
                    let id: String = s.chars().filter(|c| !"<>#@&!".contains(*c)).collect();
                    if is_snowflake(&id) { Ok(json!(id)) } else { Err(SettingsError::NotId(what)) }
                }
                _ => Err(SettingsError::NotId(what)),
            }
        }
        Kind::List => {
            let items: Vec<String> = match raw {
                Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect(),
                Value::String(s) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                _ => return Err(SettingsError::BadList),
            };
            let mut unique: Vec<String> = Vec::with_capacity(items.len());
            for item in items {
                if item.chars().count() > 200 { return Err(SettingsError::BadList); }
                if !unique.contains(&item) { unique.push(item); }
            }
            if unique.len() > 100 { return Err(SettingsError::BadList); }
            Ok(json!(unique))
        }
        Kind::Colour => match crate::colours::normalize(raw.as_str().unwrap_or_default()) {
            Some(c) => Ok(json!(c)),
            None => Err(SettingsError::NotColour(def.label)),
        },
        Kind::Select(options) => match raw.as_str() {
            Some(s) if options.contains(&s) => Ok(json!(s)),
            _ => Err(SettingsError::NotChoice(options.join(", "))),
        },
    }
}

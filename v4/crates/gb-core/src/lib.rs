//! Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! The bot's brain, kept apart from Discord. Things that happen arrive as plain events (`event`), modules decide
//! what to do, and what they want done comes back as plain actions. The Discord connection is a thin layer
//! around this (the `gb-discord` crate), which is what lets every rule here be tested without Discord.

pub mod activity;
pub mod colours;
pub mod roster;
pub mod automod;
pub mod backup;
pub mod bot;
pub mod card;
pub mod botnews;
pub mod clips;
pub mod counting;
pub mod critters;
pub mod altwatch;
pub mod plural;
pub mod timezones;
pub mod deadchat;
pub mod eclipseid;
pub mod achievements;
pub mod economy;
pub mod engagement;
pub mod family;
pub mod notify;
pub mod panels;
pub mod pulse;
pub mod partyfinder;
pub mod quotes;
pub mod event;
pub mod folds;
pub mod forms;
pub mod integrations;
pub mod invites;
pub mod fish;
pub mod fishchallenges;
pub mod fishing;
pub mod fishing_data;
pub mod fun;
pub mod giveaways;
pub mod arcade;
pub mod arcade_data;
pub mod casino;
pub mod community;
pub mod gallery;
pub mod setup;
pub mod guide;
pub mod levels;
pub mod logs;
pub mod messages;
pub mod moderation;
pub mod modplus;
pub mod modmail;
pub mod money;
pub mod music;
pub mod perms;
pub mod reminders;
pub mod roleplay;
pub mod roles;
pub mod settings;
pub mod shield;
pub mod store;
pub mod streaming;
pub mod tags;
pub mod tagscript;
pub mod ticketrules;
pub mod tickets;
pub mod utility;
pub mod time;
pub mod stats;
pub mod tempvoice;
pub mod tts;
pub mod welcome;

pub use bot::Bot;
pub use card::{Area, Art, Button, ButtonStyle, Card, CardFile, GreetingArt, RankArt, Select};
pub use event::{SetupJob, SetupStep, Action, ButtonEvent, CommandEvent, Field, FieldKind, FormEvent, KeepFile, Member, MessageEvent, Place, TranscriptHead, TranscriptTo};
pub use settings::{Def, Kind, Settings, SettingsError};

use gb_data::Store;
use std::sync::{Arc, Mutex, MutexGuard};

/// The open database, shared by every part of the bot. One thing uses it at a time; each use takes microseconds.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Store>>, Arc<activity::Activity>);
impl Db {
    pub fn new(store: Store) -> Db {
        Db(Arc::new(Mutex::new(store)), Arc::default())
    }
    /// What the bot has just seen (the launcher's Activity page). Kept in memory, never in the database.
    pub fn seen(&self) -> &activity::Activity {
        &self.1
    }
    pub fn get(&self) -> DbGuard<'_> {
        // taking the database twice on one thread would wait forever: in test builds that is a clear panic instead
        #[cfg(debug_assertions)]
        HELD.with(|h| assert!(!h.get(), "the database was taken while this thread already holds it (let go of the first `db.get()` before reading settings or the database again)"));
        // a panic elsewhere must not stop the bot answering: the data itself is protected by SQLite
        let guard = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(debug_assertions)]
        HELD.with(|h| h.set(true));
        DbGuard(guard)
    }
}
#[cfg(debug_assertions)]
thread_local! { static HELD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
/// The database while it is held (`Db::get`).
pub struct DbGuard<'a>(MutexGuard<'a, Store>);
impl std::ops::Deref for DbGuard<'_> {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.0
    }
}
impl std::ops::DerefMut for DbGuard<'_> {
    fn deref_mut(&mut self) -> &mut Store {
        &mut self.0
    }
}
impl Drop for DbGuard<'_> {
    fn drop(&mut self) {
        #[cfg(debug_assertions)]
        HELD.with(|h| h.set(false));
    }
}

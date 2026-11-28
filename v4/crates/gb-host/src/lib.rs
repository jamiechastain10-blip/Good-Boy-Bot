//! Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! What a program that hosts the bot needs, shared by the launcher and the command line:
//! where things are kept, the first run, the saved secrets, and starting and stopping the bot.

pub mod access;
pub mod brand;
pub mod desk;
pub mod handoff;
pub mod licence;
pub mod runner;
pub mod secrets;
pub mod setup;
pub mod update;
pub mod web;

pub use desk::{Desk, Prefs};
pub use runner::{Live, Phase, Runner};
pub use secrets::Secret;
pub use setup::{folders, prepare_data, Folders, Prepared};

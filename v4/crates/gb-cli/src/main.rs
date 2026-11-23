//! Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! `goodboy`: the command line for Good Boy 4. It runs the bot, checks a Good Boy database and brings 3.x data across.
//!   goodboy                                         first run and every run: get the data ready, ask for the token once, start
//!   goodboy token forget                            remove the saved bot token from this computer
//!   goodboy run <data folder>                       run the bot on that data (the token comes from DISCORD_TOKEN)
//!   goodboy data check  <folder or eclipse.db>      what is in it, and whether it is sound
//!   goodboy data find   <app data folder>           where Good Boy 3 keeps its data on this computer
//!   goodboy data import <3.x data folder> <v4 data folder>   copy it across (the 3.x data is never changed)
//! Add --json for machine-readable output (the launcher uses that).

use gb_host::{secrets, setup, Secret};
use gb_data::{find_3x_data, import_3x, Store, Summary};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn db_path(arg: &str) -> PathBuf {
    let p = Path::new(arg);
    if p.is_dir() { p.join("eclipse.db") } else { p.to_path_buf() }
}

fn print_summary(s: &Summary) {
    println!("  Servers: {}", s.servers);
    println!("  Modules turned on: {}", s.modules_on);
    println!("  Settings: {}", s.settings);
    println!("  Records (levels, playlists, tickets and more): {}", s.records);
    let extra: Vec<String> = s
        .tables
        .iter()
        .filter(|(name, n)| *n > 0 && !name.contains("_fts") && !["guilds", "module_state", "module_config", "module_data", "schema_meta", "v4_meta", "logs", "module_migrations"].contains(&name.as_str()))
        .map(|(name, n)| format!("{name} ({n})"))
        .collect();
    if !extra.is_empty() {
        println!("  Other tables with data: {}", extra.join(", "));
    }
}

/// On a web host: the bot and the web app (for phones and other computers) together. Asked for with GOODBOY_WEB_ADDRESS
/// (the public https link) and, if wanted, GOODBOY_WEB_PORT. The token is read the same way as without the web app.
fn start_with_web(data: &std::path::Path, address: &str) -> Result<(), String> {
    use std::sync::Arc;
    let desk = Arc::new(gb_host::Desk::new(gb_host::Folders { data: data.to_path_buf(), old_app_data: None }));
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        desk.capture_runtime();
        let port: u64 = std::env::var("GOODBOY_WEB_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47890);
        desk.prefs_set(&serde_json::json!({ "setup_done": true, "web_on": true, "web_all": true, "web_address": address, "web_port": port }))?;
        desk.web_apply();
        println!("Web app at {address} (port {port}). Add {address}/auth/callback under OAuth2 Redirects in the Discord Developer Portal.");
        desk.start()?;
        let _ = tokio::signal::ctrl_c().await;
        println!("Stopping.");
        desk.stop().await;
        Ok(())
    })
}

fn start(token: String, data: &std::path::Path) -> Result<(), String> {
    if let Some(address) = std::env::var("GOODBOY_WEB_ADDRESS").ok().filter(|a| !a.trim().is_empty()) {
        std::env::set_var("DISCORD_TOKEN", &token);
        return start_with_web(data, address.trim());
    }
    let store = Store::open(data.join("eclipse.db")).map_err(|e| e.to_string())?;
    store.integrity_ok().map_err(|e| e.to_string())?;
    let bot = gb_core::Bot::new(store);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let (stop, stop_rx) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            println!("Stopping.");
            let _ = stop.send(true);
            // keep the sender alive until the program ends
            std::future::pending::<()>().await;
        });
        let report = std::sync::Arc::new(|s: gb_discord::Status| match s {
            gb_discord::Status::Connecting => println!("Good Boy 4 is connecting to Discord..."),
            gb_discord::Status::Online { name, servers } => println!("Online as {name} in {servers} server(s)."),
            gb_discord::Status::Hiccup(why) => eprintln!("Connection hiccup: {why}"),
            gb_discord::Status::Notice(what) => println!("Note: {what}"),
        });
        // extra music bots: DISCORD_HELPER_TOKENS=token1,token2
        let helpers: Vec<(usize, String)> = std::env::var("DISCORD_HELPER_TOKENS").unwrap_or_default().split(',').map(str::trim).filter(|t| !t.is_empty()).enumerate().map(|(n, t)| (n + 1, t.to_string())).collect();
        gb_discord::run(token, std::sync::Arc::new(bot), gb_discord::Control { stop: stop_rx, report, act: None, helpers }).await
    })
}

fn ask(question: &str) -> String {
    print!("{question}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    line.trim().to_string()
}

/// Double-clicking the program lands here: get the data ready, get the token, start.
fn guided() -> Result<(), String> {
    println!("Good Boy {}\n", env!("CARGO_PKG_VERSION"));
    let folders = setup::folders(&|k| std::env::var(k).ok(), std::env::consts::OS)?;
    match setup::prepare_data(&folders)? {
        setup::Prepared::AlreadyHere(s) => {
            println!("Using Good Boy 4's data in {}.", setup::describe(&folders.data));
            print_summary(&s);
        }
        setup::Prepared::CameFromGoodBoy3 { from, summary, files } => {
            println!("Found your Good Boy 3 data and copied it to {}.", setup::describe(&folders.data));
            print_summary(&summary);
            println!("  Other files copied: {files}");
            println!("Your Good Boy 3 data in {} was not changed, so Good Boy 3 still works as before.", setup::describe(&from));
        }
        setup::Prepared::StartedFresh => println!("No Good Boy 3 data was found on this computer, so Good Boy 4 starts fresh in {}.", setup::describe(&folders.data)),
    }
    println!();
    let token = match std::env::var("DISCORD_TOKEN").ok().filter(|t| !t.trim().is_empty()).or_else(|| secrets::read(Secret::BotToken)) {
        Some(t) => t,
        None => {
            println!("Good Boy 4 needs a bot token. Use a TEST bot, not your real Good Boy:");
            println!("  - two programs cannot run the same bot at once, and");
            println!("  - this build replaces the bot's command list with its own short one.");
            println!("Make one at https://discord.com/developers/applications (New Application, then Bot, then Reset Token).\n");
            if !ask("Is the token you are about to paste from a test bot? Type yes to go on: ").eq_ignore_ascii_case("yes") {
                return Err("Stopped. Nothing was saved.".into());
            }
            let token = rpassword::prompt_password("Paste the test bot's token and press Enter (it is not shown): ").map_err(|e| e.to_string())?;
            if !secrets::looks_like_a_token(&token) {
                return Err("That does not look like a bot token (it has three parts separated by dots). Copy it again from the Bot page and run Good Boy 4 again.".into());
            }
            match secrets::write(Secret::BotToken, token.trim()) {
                Ok(()) => println!("Saved in this computer's own credential store. Remove it any time with: goodboy token forget"),
                Err(why) => println!("The token was not saved ({why}). It will be asked for again next time."),
            }
            token
        }
    };
    println!();
    start(token.trim().to_string(), &folders.data)
}

fn run(args: &[String]) -> Result<(), String> {
    let json = args.iter().any(|a| a == "--json");
    let args: Vec<&str> = args.iter().map(String::as_str).filter(|a| *a != "--json").collect();
    match args.as_slice() {
        [] => guided(),
        ["token", "forget"] => {
            secrets::forget(Secret::BotToken)?;
            println!("The saved bot token was removed from this computer.");
            Ok(())
        }
        ["data", "check", target] => {
            let store = Store::open_read_only(db_path(target)).map_err(|e| e.to_string())?;
            store.integrity_ok().map_err(|e| e.to_string())?;
            let s = store.summary().map_err(|e| e.to_string())?;
            if json {
                println!("{}", serde_json::to_string(&s).unwrap());
            } else {
                println!("This Good Boy database is sound (made by schema {}).", s.schema);
                print_summary(&s);
            }
            Ok(())
        }
        ["data", "find", app_data] => {
            let found = find_3x_data(Path::new(app_data));
            if json {
                println!("{}", serde_json::to_string(&found).unwrap());
            } else if found.is_empty() {
                println!("No Good Boy 3 data was found under {app_data}.");
            } else {
                for dir in found {
                    println!("{}", dir.display());
                }
            }
            Ok(())
        }
        ["data", "import", from, to] => {
            let report = import_3x(Path::new(from), Path::new(to)).map_err(|e| e.to_string())?;
            if json {
                println!("{}", serde_json::to_string(&report).unwrap());
            } else if report.already_there {
                println!("Good Boy 4 already has data in {}. It was kept, and nothing was copied over it.", report.to.display());
                print_summary(&report.summary);
            } else {
                println!("Your Good Boy 3 data was copied to {}.", report.to.display());
                print_summary(&report.summary);
                println!("  Other files copied: {} ({} KB)", report.files, report.bytes / 1024);
                println!("The Good Boy 3 data in {} was not changed.", report.from.display());
            }
            Ok(())
        }
        ["run", data] => {
            // the token is read from the environment, never from the command line, where other programs could see it
            let token = std::env::var("DISCORD_TOKEN").ok().filter(|t| !t.trim().is_empty()).ok_or("Set DISCORD_TOKEN to your bot's token first. It is never passed on the command line.")?;
            let dir = db_path(data);
            start(token.trim().to_string(), dir.parent().unwrap_or(std::path::Path::new(".")))
        }
        _ => Err("Usage:\n  goodboy                      (first run, and every run after)\n  goodboy token forget\n  goodboy run <data folder>\n  goodboy data check <folder or eclipse.db>\n  goodboy data find <app data folder>\n  goodboy data import <3.x data folder> <v4 data folder>\nAdd --json for machine-readable output.".into()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            if args.is_empty() {
                // double-clicked: keep the window open so the message can be read
                let _ = ask("\nPress Enter to close.");
            }
            ExitCode::FAILURE
        }
    }
}

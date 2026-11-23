//! Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! The launcher: one window that sets Good Boy up, runs the bot inside this same program and is its dashboard.
//! There is no web server and no browser tab. The screens (launcher/ui) ask for things by name and this file
//! passes each request to the desk (gb-host), which holds all the rules and is tested without a window.
//!
//! The bot token and client secret only ever travel one way: from the screen to the operating system's
//! credential store. No command here hands one back.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use gb_host::Desk;
use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, State};

type Held<'a> = State<'a, Arc<Desk>>;

#[tauri::command]
fn update_status(desk: Held) -> Value {
    desk.update_status()
}
#[tauri::command]
async fn update_check(desk: Held<'_>) -> Result<Value, String> {
    desk.update_check().await
}
/// Downloads, checks and swaps in the update, starts the new program, and closes this one.
#[tauri::command]
async fn update_install(app: tauri::AppHandle, desk: Held<'_>) -> Result<Value, String> {
    let out = desk.update_install().await?;
    // the new program is already starting; closing this one lets it take over (only one copy may run)
    app.exit(0);
    Ok(out)
}
#[tauri::command]
fn overview(desk: Held) -> Value {
    desk.overview()
}
#[tauri::command]
fn licence_set(desk: Held, key: String) -> Result<Value, String> {
    desk.licence_set(&key)
}
#[tauri::command]
async fn licence_refresh(desk: Held<'_>) -> Result<Value, String> {
    // a list that cannot be reached is not an error worth showing: the saved one keeps working
    let _ = desk.licence_refresh().await;
    Ok(desk.licence_view())
}
#[tauri::command]
fn prefs_set(desk: Held, patch: Value) -> Result<Value, String> {
    let out = desk.prefs_set(&patch).map(|p| serde_json::to_value(p).unwrap_or_default())?;
    // choices about the web app take effect at once
    if patch.as_object().is_some_and(|o| o.keys().any(|k| k.starts_with("web_"))) { desk.inner().web_apply(); }
    Ok(out)
}
#[tauri::command]
async fn setup_data(desk: Held<'_>, copy: bool) -> Result<Value, String> {
    let desk = desk.inner().clone();
    // copying a large Good Boy 3 database takes a moment, so it is kept off the window's own thread
    tauri::async_runtime::spawn_blocking(move || desk.setup_data(copy)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn health(desk: Held) -> Value {
    desk.health()
}
#[tauri::command]
fn v3_folder_set(desk: Held, path: String) -> Result<Value, String> {
    desk.v3_folder_set(&path)
}
#[tauri::command]
fn v3_status(desk: Held) -> Value {
    desk.v3_status()
}
#[tauri::command]
async fn v3_recopy(desk: Held<'_>) -> Result<Value, String> {
    let desk = desk.inner().clone();
    tauri::async_runtime::spawn_blocking(move || desk.v3_recopy()).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn v3_check(desk: Held<'_>) -> Result<Value, String> {
    let desk = desk.inner().clone();
    tauri::async_runtime::spawn_blocking(move || desk.v3_check()).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn token_test(desk: Held<'_>, token: Option<String>) -> Result<Value, String> {
    desk.token_test(token).await
}
#[tauri::command]
async fn token_save(desk: Held<'_>, token: String) -> Result<Value, String> {
    desk.token_save(&token).await
}
#[tauri::command]
async fn helpers_list(desk: Held<'_>) -> Result<Value, String> {
    desk.helpers_list().await
}
#[tauri::command]
async fn helper_add(desk: Held<'_>, token: String) -> Result<Value, String> {
    desk.helper_add(&token).await
}
#[tauri::command]
async fn helper_remove(desk: Held<'_>, slot: usize) -> Result<(), String> {
    desk.helper_remove(slot).await
}
#[tauri::command]
async fn token_forget(desk: Held<'_>) -> Result<(), String> {
    desk.token_forget().await
}
#[tauri::command]
fn secret_save(desk: Held, secret: String) -> Result<(), String> {
    desk.secret_save(&secret)
}
#[tauri::command]
fn secret_forget(desk: Held) -> Result<(), String> {
    desk.secret_forget()
}
#[tauri::command]
async fn bot_start(desk: Held<'_>) -> Result<(), String> {
    desk.start()
}
#[tauri::command]
async fn bot_stop(desk: Held<'_>) -> Result<(), String> {
    desk.stop().await;
    Ok(())
}
#[tauri::command]
async fn bot_restart(desk: Held<'_>) -> Result<(), String> {
    desk.restart().await
}
#[tauri::command]
fn servers(desk: Held) -> Result<Value, String> {
    desk.servers()
}
#[tauri::command]
fn module_set(desk: Held, guild: String, module: String, on: bool) -> Result<(), String> {
    desk.module_set(&guild, &module, on)
}
#[tauri::command]
fn settings(desk: Held, guild: String, module: String) -> Result<Value, String> {
    desk.settings(&guild, &module)
}
#[tauri::command]
fn off_channels_set(desk: Held, guild: String, module: String, channels: Vec<String>) -> Result<Vec<String>, String> {
    desk.off_channels_set(&guild, &module, &channels)
}
#[tauri::command]
fn commands_view(desk: Held) -> Result<Value, String> {
    desk.commands_view()
}
#[tauri::command]
fn directory(desk: Held, guild: String) -> Result<Value, String> {
    desk.directory_view(&guild)
}
#[tauri::command]
fn command_run(desk: Held, guild: String, name: String, sub: Option<String>, values: std::collections::BTreeMap<String, String>) -> Result<Value, String> {
    desk.command_run(&guild, &name, sub.as_deref(), &values)
}
#[tauri::command]
fn images_view(desk: Held, guild: String) -> Result<Value, String> {
    desk.images_view(&guild)
}
#[tauri::command]
fn greeting_image_set(desk: Held, guild: String, kind: String, name: String, data: String) -> Result<(), String> {
    desk.greeting_image_set(&guild, &kind, &name, &data)
}
#[tauri::command]
fn greeting_image_clear(desk: Held, guild: String, kind: String) -> Result<(), String> {
    desk.greeting_image_clear(&guild, &kind)
}
#[tauri::command]
fn critters_view(desk: Held, guild: String) -> Result<Value, String> {
    desk.critters_view(&guild)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn critter_save(desk: Held, guild: String, editing: Option<String>, name: String, element: String, rarity: String, hp: i64, atk: i64, def: i64, spd: i64, picture: Option<String>, link: Option<String>, file_name: Option<String>, data: Option<String>) -> Result<String, String> {
    desk.critter_save(&guild, editing.as_deref(), &name, &element, &rarity, [hp, atk, def, spd], picture.as_deref().unwrap_or("keep"), link.as_deref().unwrap_or(""), file_name.as_deref().unwrap_or(""), data.as_deref().unwrap_or(""))
}
#[tauri::command]
fn critter_remove(desk: Held, guild: String, id: String) -> Result<String, String> {
    desk.critter_remove(&guild, &id)
}
#[tauri::command]
fn setting_set(desk: Held, guild: String, module: String, key: String, value: Value) -> Result<Value, String> {
    desk.setting_set(&guild, &module, &key, &value)
}
#[tauri::command]
fn dashboard(desk: Held, guild: String) -> Result<Value, String> {
    desk.dashboard(&guild)
}
#[tauri::command]
fn cases(desk: Held, guild: String, limit: Option<usize>) -> Result<Value, String> {
    desk.cases(&guild, limit.unwrap_or(50))
}
#[tauri::command]
fn tickets(desk: Held, guild: String, limit: Option<usize>, find: Option<String>) -> Result<Value, String> {
    desk.tickets_find(&guild, limit.unwrap_or(100), find.as_deref())
}
#[tauri::command]
async fn music_api(desk: Held<'_>, guild: String, kind: String, name: String, args: Option<Value>) -> Result<Value, String> {
    let desk = desk.inner().clone();
    desk.music_api(&guild, &kind, &name, &args.unwrap_or(Value::Null), None).await
}
#[tauri::command]
fn inactive_scan(desk: Held, guild: String, days: Option<i64>) -> Result<(), String> {
    desk.inactive_scan(&guild, days)
}
#[tauri::command]
fn inactive_view(desk: Held, guild: String) -> Result<Value, String> {
    desk.inactive_view(&guild)
}
#[tauri::command]
fn inactive_kick(desk: Held, guild: String, ids: Vec<String>, days: Option<i64>) -> Result<usize, String> {
    desk.inactive_kick(&guild, ids, days)
}
#[tauri::command]
fn inactive_keep(desk: Held, guild: String, user: String, keep: bool) -> Result<(), String> {
    desk.inactive_keep(&guild, &user, keep)
}
#[tauri::command]
fn economy(desk: Held, guild: String) -> Result<Value, String> {
    desk.economy(&guild)
}
#[tauri::command]
fn treasury_give(desk: Held, guild: String, user: String, amount: i64, reason: String) -> Result<i64, String> {
    desk.treasury_give(&guild, &user, amount, &reason)
}
#[tauri::command]
fn members_lookup(desk: Held, guild: String, ids: Vec<String>) -> Result<Value, String> {
    desk.members_lookup(&guild, ids)
}
#[tauri::command]
fn members_search(desk: Held, guild: String, q: Option<String>, bots: Option<bool>) -> Result<Value, String> {
    desk.members_search(&guild, q.as_deref().unwrap_or(""), bots.unwrap_or(false))
}
#[tauri::command]
fn leavers(desk: Held, guild: String, days: Option<i64>, q: Option<String>) -> Result<Value, String> {
    desk.leavers(&guild, days.unwrap_or(60), q.as_deref().unwrap_or(""))
}
#[tauri::command]
fn leaver_forget(desk: Held, guild: String, user: String) -> Result<usize, String> {
    desk.leaver_forget(&guild, &user)
}
#[tauri::command]
fn ticket_action(desk: Held, guild: String, number: i64, what: String, text: Option<String>) -> Result<String, String> {
    desk.ticket_action(&guild, number, &what, text.as_deref().unwrap_or(""), None)
}
#[tauri::command]
async fn brand_status(desk: Held<'_>) -> Result<Value, String> {
    desk.brand_status().await
}
#[tauri::command]
async fn brand_keep(desk: Held<'_>, force: Option<bool>) -> Result<Value, String> {
    desk.brand_keep(force.unwrap_or(false)).await
}
#[tauri::command]
async fn brand_custom(desk: Held<'_>, name: Option<String>, description: Option<String>, image: Option<String>, banner: Option<String>) -> Result<(), String> {
    desk.brand_custom(name, description, image, banner).await
}
#[tauri::command]
fn whatsnew(desk: Held) -> Value {
    desk.whatsnew()
}
#[tauri::command]
fn announce_restart(desk: Held, minutes: Option<u64>) -> Result<usize, String> {
    desk.announce_restart(minutes.unwrap_or(5))
}
#[tauri::command]
fn ticket_transcript(desk: Held, guild: String, number: i64, html: Option<bool>) -> Result<Value, String> {
    desk.ticket_transcript(&guild, number, html.unwrap_or(true))
}
#[tauri::command]
fn ticket_view(desk: Held, guild: String, number: i64) -> Result<Value, String> {
    desk.ticket_view(&guild, number)
}
#[tauri::command]
fn pulse(desk: Held, guild: String) -> Result<Value, String> {
    desk.pulse(&guild)
}
#[tauri::command]
fn panel(desk: Held, guild: String, panel: String) -> Result<Value, String> {
    desk.panel(&guild, &panel)
}
#[tauri::command]
fn panel_action(desk: Held, guild: String, panel: String, row: String, action: String) -> Result<(), String> {
    desk.panel_action(&guild, &panel, &row, &action)
}
#[tauri::command]
fn permissions(desk: Held, guild: String) -> Result<Value, String> {
    desk.permissions(&guild)
}
#[tauri::command]
fn permission_set(desk: Held, guild: String, key: String, roles: Vec<String>) -> Result<(), String> {
    desk.permission_set(&guild, &key, &roles)
}
#[tauri::command]
fn role_menus(desk: Held, guild: String) -> Result<Value, String> {
    desk.role_menus(&guild)
}
#[tauri::command]
fn role_menu_delete(desk: Held, guild: String, message: String) -> Result<(), String> {
    desk.role_menu_delete(&guild, &message)
}
#[tauri::command]
fn shop(desk: Held, guild: String) -> Result<Value, String> {
    desk.shop(&guild)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn shop_save(desk: Held, guild: String, name: String, price: i64, emoji: Option<String>, role: Option<String>, hours: Option<i64>, stock: Option<i64>, text: Option<String>, consumable: Option<bool>) -> Result<String, String> {
    desk.shop_save(&guild, &name, price, emoji.as_deref().unwrap_or(""), role.as_deref(), hours.unwrap_or(0), stock, text.as_deref().unwrap_or(""), consumable.unwrap_or(false))
}
#[tauri::command]
fn shop_remove(desk: Held, guild: String, id: String) -> Result<(), String> {
    desk.shop_remove(&guild, &id)
}
#[tauri::command]
fn boards(desk: Held, guild: String, limit: Option<usize>) -> Result<Value, String> {
    desk.boards(&guild, limit.unwrap_or(10))
}
#[tauri::command]
fn staff_action(desk: Held, guild: String, kind: String, user: String, name: Option<String>, reason: String, duration: Option<String>) -> Result<String, String> {
    desk.staff_action(&guild, &kind, &user, name.as_deref().unwrap_or(""), &reason, duration.as_deref())
}
#[tauri::command]
fn activity(desk: Held, guild: String, since_id: Option<u64>) -> Result<Value, String> {
    desk.activity(&guild, since_id.unwrap_or(0))
}
#[tauri::command]
fn economy_reset(desk: Held, guild: String) -> Result<usize, String> {
    desk.economy_reset(&guild)
}
#[tauri::command]
fn backup_now(desk: Held, stamp: String) -> Result<String, String> {
    desk.backup_now(&stamp)
}

/// Hands an address or folder to the system to open. Only the places named here can be opened: the screen
/// chooses by name and never supplies an address of its own.
/// Opens a web link in the default browser, or a folder in the file manager.
fn open_with_system(target: &str) -> Result<(), String> {
    let web = target.starts_with("https://") || target.starts_with("http://");
    let mut cmd = if cfg!(windows) {
        if web {
            // File Explorer turns links with "&" or "=" in them (such as the invite link) into a folder window,
            // so web links go to Windows' own link handler, which passes the whole link to the default browser
            let mut c = std::process::Command::new("rundll32.exe");
            c.arg("url.dll,FileProtocolHandler").arg(target);
            c
        } else {
            let mut c = std::process::Command::new("explorer");
            c.arg(target);
            c
        }
    } else {
        let mut c = std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
        c.arg(target);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("That could not be opened: {e}"))
}
#[tauri::command]
fn post_panel(desk: Held<'_>, guild: String, module: String, channel: String, title: Option<String>, text: Option<String>, pin: Option<bool>) -> Result<(), String> {
    desk.post_panel(&guild, &module, &channel, title.as_deref().filter(|t| !t.trim().is_empty()), text.as_deref().filter(|t| !t.trim().is_empty()), pin.unwrap_or(false))
}
#[tauri::command]
fn panel_preview(desk: Held<'_>, guild: String, module: String, title: Option<String>, text: Option<String>) -> Result<serde_json::Value, String> {
    desk.panel_preview(&guild, &module, title.as_deref().filter(|t| !t.trim().is_empty()), text.as_deref().filter(|t| !t.trim().is_empty()))
}
#[tauri::command]
async fn open(desk: Held<'_>, what: String) -> Result<(), String> {
    match what.as_str() {
        "developers" => open_with_system("https://discord.com/developers/applications"),
        "data" => {
            std::fs::create_dir_all(&desk.folders.data).map_err(|e| e.to_string())?;
            open_with_system(&desk.folders.data.display().to_string())
        }
        "invite" => {
            // the bot's own id comes from Discord, so the invite is always for the bot whose token is saved
            let who = desk.token_test(None).await?;
            let id = who["id"].as_str().filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).ok_or("Discord did not say which bot this is.")?;
            // kick (2), ban (4), manage channels (16, for ticket channels), manage server (32, to read invites for invite tracking), add reactions (64), view audit log (128, anti-nuke), see channels (1024), send messages (2048), manage messages (8192),
            // embed links (16384), attach files (32768), read history (65536), connect and speak in voice (for music),
            // manage roles, send in threads, time out members
            const PERMISSIONS: u64 = 2 | 4 | 16 | 32 | 64 | 128 | 1024 | 2048 | 8192 | 16384 | 32768 | 65536 | (1 << 20) | (1 << 21) | 268_435_456 | 274_877_906_944 | (1 << 40);
            open_with_system(&format!("https://discord.com/oauth2/authorize?client_id={id}&scope=bot+applications.commands&permissions={PERMISSIONS}"))
        }
        _ => Err("That cannot be opened from here.".into()),
    }
}

fn main() {
    let folders = match gb_host::folders(&|k| std::env::var(k).ok(), std::env::consts::OS) {
        Ok(f) => f,
        Err(why) => {
            eprintln!("{why}");
            std::process::exit(1);
        }
    };
    // started by an update: wait for the program that started it to close, so the one-copy check does not turn this one away
    if let Some(pid) = std::env::args().skip_while(|a| a != "--updated").nth(1).and_then(|p| p.parse::<u32>().ok()) {
        gb_host::update::wait_for_exit(pid, 30);
    }
    // what an earlier update left behind (the replaced program) is removed
    if let Ok(exe) = std::env::current_exe() { gb_host::update::clean_up(&exe); }
    gb_host::update::note_version(env!("CARGO_PKG_VERSION"));
    let desk = Arc::new(Desk::new(folders));
    // started by the last Good Boy 3 to take over from it: `--from-v3 <handover file>`
    let handoff = std::env::args().skip_while(|a| a != "--from-v3").nth(1);
    let at_start = desk.clone();
    let at_exit = desk.clone();
    let app = tauri::Builder::default()
        // a second copy would run the same bot twice, so opening Good Boy again just shows the window that is open
        .plugin(tauri_plugin_single_instance::init(|app, _args, _dir| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(desk)
        .invoke_handler(tauri::generate_handler![
            overview, update_status, update_check, update_install, whatsnew, announce_restart, brand_status, brand_keep, brand_custom, prefs_set, licence_set, licence_refresh, setup_data, pulse, panel, panel_action, permissions, permission_set, role_menus, role_menu_delete, health, v3_status, v3_folder_set, v3_recopy, v3_check, token_test, token_save, token_forget, helpers_list, helper_add, helper_remove, secret_save, secret_forget, bot_start, bot_stop, bot_restart, servers, module_set, settings, setting_set, off_channels_set, ticket_view, ticket_transcript, commands_view, directory, command_run, images_view, greeting_image_set, greeting_image_clear, critters_view, critter_save, critter_remove, dashboard, cases, tickets, music_api, inactive_scan, inactive_view, inactive_kick, inactive_keep, economy, treasury_give, members_lookup, members_search, leavers, leaver_forget, ticket_action, shop, shop_save, shop_remove, boards, staff_action, activity, economy_reset, post_panel, panel_preview, backup_now, open
        ])
        .setup(move |_app| {
            let prefs = at_start.prefs();
            let for_web = at_start.clone();
            let for_look = at_start.clone();
            tauri::async_runtime::spawn(async move {
                // the web app (for phones) starts with the program when it was switched on
                for_web.capture_runtime();
                for_web.web_apply();
            });
            // without a licence the bot keeps the Good Boy look: a part that is missing or was changed is put back, a
            // little after start and then every six hours (a licence means the look is the owner's, and nothing is touched)
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(45)).await;
                loop {
                    if for_look.prefs().setup_done { let _ = for_look.brand_keep(false).await; }
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                }
            });
            // look for a newer Good Boy 4 a little after start, then every six hours; the Updates page and Home show what it finds
            let for_update = at_start.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                loop {
                    let _ = for_update.update_check().await;
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                }
            });
            if let Some(file) = handoff {
                tauri::async_runtime::spawn(async move {
                    if let Err(why) = at_start.adopt_handoff(std::path::Path::new(&file)).await {
                        eprintln!("The move from Good Boy 3 did not finish: {why}");
                    }
                });
            } else if prefs.setup_done && prefs.start_with_app {
                tauri::async_runtime::spawn(async move {
                    let _ = at_start.start(); // with no token saved this does nothing; Home says what is missing
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Good Boy could not open its window");
    app.run(move |_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // let go of Discord cleanly so the bot shows as offline straight away
            tauri::async_runtime::block_on(at_exit.stop());
        }
    });
}

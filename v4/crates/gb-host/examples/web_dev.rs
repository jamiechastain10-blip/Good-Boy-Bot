//! Starts the web app on a scratch folder with a little data and prints a sign-in cookie, so the screens can be looked at
//! in a browser (or a phone-sized window) without Discord. Usage: cargo run -p gb-host --example web_dev -- <port>
use gb_host::{web, Desk, Folders};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(47890);
    let tmp = std::env::temp_dir().join(format!("gb-web-dev-{port}"));
    let _ = std::fs::remove_dir_all(&tmp);
    let desk = Arc::new(Desk::new(Folders { data: tmp.join("data"), old_app_data: None }));
    desk.setup_data(false).unwrap();
    let bot = desk.bot().unwrap();
    bot.on_server("700000000000000001", "Ghost Town");
    bot.on_server("700000000000000002", "Other Place");
    for m in ["levels", "money", "moderation", "giveaways", "roles", "tags"] { bot.db.get().set_module_enabled("700000000000000001", m, true).unwrap(); }
    let mut roles = std::collections::HashMap::new();
    roles.insert("600000000000000001".to_string(), gb_core::bot::RoleFacts { name: "Staff".into(), position: 5, managed: false, perms: 0, mentionable: true });
    roles.insert("600000000000000002".to_string(), gb_core::bot::RoleFacts { name: "Helpers".into(), position: 3, managed: false, perms: 0, mentionable: true });
    bot.directory.set_role_facts("700000000000000001", roles, Some(10));
    bot.directory.set_bot_owner(Some("42".into()));
    let w = web::Web::new(desk, &format!("http://127.0.0.1:{port}"));
    let cookie = w.sign_in(web::Session { user: "42".into(), name: "Basic".into(), owner: true, guilds: vec!["700000000000000001".into(), "700000000000000002".into()], staff: Vec::new(), expires: 0 });
    println!("COOKIE {cookie}");
    web::serve(w, port, false).await.unwrap();
}

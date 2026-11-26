//! Starting and stopping the bot from inside another program (the launcher), and saying how it is doing.

use gb_core::Bot;
use gb_discord::{Control, Status};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Stopped,
    Starting,
    Online,
    /// It stopped by itself. `problem` says why.
    Problem,
}
/// How the bot is doing right now.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Live {
    pub phase: Phase,
    pub name: Option<String>,
    pub servers: usize,
    /// When it came online (milliseconds since 1970), for "online for 3 hours".
    pub online_since_ms: Option<i64>,
    /// How long the last start took, from pressing Start to being online.
    pub start_took_ms: Option<i64>,
    pub problem: Option<String>,
    /// Something worth knowing while the bot runs fine (a switch on the bot's page that is off).
    pub notice: Option<String>,
}
impl Live {
    fn stopped() -> Live {
        Live { phase: Phase::Stopped, name: None, servers: 0, online_since_ms: None, start_took_ms: None, problem: None, notice: None }
    }
}
fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

struct Running {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}
pub struct Runner {
    live: Arc<Mutex<Live>>,
    running: Mutex<Option<Running>>,
    /// Where the launcher hands the running bot things to do.
    act: Mutex<Option<tokio::sync::mpsc::UnboundedSender<(String, gb_core::Action)>>>,
}
impl Default for Runner {
    fn default() -> Self {
        Runner { live: Arc::new(Mutex::new(Live::stopped())), running: Mutex::new(None), act: Mutex::new(None) }
    }
}
impl Runner {
    pub fn live(&self) -> Live {
        self.live.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn is_running(&self) -> bool {
        matches!(self.live().phase, Phase::Starting | Phase::Online)
    }
    /// Starts the bot. Must be called from inside a tokio runtime. Does nothing when it is already running.
    pub fn start(&self, token: String, helpers: Vec<(usize, String)>, bot: Arc<Bot>, dashboard_url: Option<String>) {
        let mut running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        if self.is_running() {
            return;
        }
        let (stop, stop_rx) = watch::channel(false);
        let pressed = now_ms();
        let live = self.live.clone();
        *live.lock().unwrap() = Live { phase: Phase::Starting, ..Live::stopped() };
        let report_to = live.clone();
        let report: Arc<dyn Fn(Status) + Send + Sync> = Arc::new(move |status| {
            let mut l = report_to.lock().unwrap_or_else(|p| p.into_inner());
            match status {
                Status::Connecting => {}
                Status::Online { name, servers } => {
                    let now = now_ms();
                    // a reconnect keeps the first start's timing
                    if l.phase != Phase::Online {
                        l.start_took_ms = Some(now - pressed);
                        l.online_since_ms = Some(now);
                    }
                    l.phase = Phase::Online;
                    l.name = Some(name);
                    l.servers = servers;
                    l.problem = None;
                }
                Status::Notice(what) => l.notice = Some(what),
                Status::Hiccup(why) => l.problem = Some(format!("The connection dropped for a moment and is being restored ({why}).")),
            }
        });
        let (act_tx, act_rx) = tokio::sync::mpsc::unbounded_channel();
        *self.act.lock().unwrap_or_else(|p| p.into_inner()) = Some(act_tx);
        let task = tokio::spawn(async move {
            let result = gb_discord::run(token, bot, Control { stop: stop_rx, report, act: Some(act_rx), helpers, dashboard_url }).await;
            let mut l = live.lock().unwrap_or_else(|p| p.into_inner());
            *l = match result {
                Ok(()) => Live::stopped(),
                Err(why) => Live { phase: Phase::Problem, problem: Some(why), ..Live::stopped() },
            };
        });
        *running = Some(Running { stop, task });
    }
    /// Hands the running bot things to do in a server. Err when it is not running.
    pub fn act(&self, guild: &str, actions: Vec<gb_core::Action>) -> Result<(), String> {
        if !self.is_running() { return Err("Start the bot first: it posts this in Discord.".into()); }
        let held = self.act.lock().unwrap_or_else(|p| p.into_inner());
        let tx = held.as_ref().ok_or("Start the bot first: it posts this in Discord.")?;
        for a in actions { tx.send((guild.to_string(), a)).map_err(|_| "The bot is not running.".to_string())?; }
        Ok(())
    }
    /// Stops the bot and waits until it has let go of Discord (a few seconds at most).
    pub async fn stop(&self) {
        let running = self.running.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(Running { stop, mut task }) = running {
            let _ = stop.send(true);
            if tokio::time::timeout(std::time::Duration::from_secs(5), &mut task).await.is_err() {
                task.abort();
            }
        }
        *self.live.lock().unwrap_or_else(|p| p.into_inner()) = Live::stopped();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_refused_token_ends_as_a_problem_with_a_reason_and_can_be_started_again() {
        // no network is needed: an unreachable proxy makes the very first request fail
        let tmp = tempfile::tempdir().unwrap();
        let store = gb_data::Store::create(tmp.path().join("eclipse.db")).unwrap();
        let bot = Arc::new(Bot::new(store));
        let runner = Runner::default();
        assert_eq!(runner.live().phase, Phase::Stopped);
        runner.stop().await; // stopping a stopped bot is fine
        std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:1");
        runner.start("not.a.token".into(), Vec::new(), bot.clone(), None);
        for _ in 0..200 {
            if runner.live().phase == Phase::Problem { break; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let live = runner.live();
        assert_eq!(live.phase, Phase::Problem, "{live:?}");
        assert!(live.problem.is_some());
        assert!(!runner.is_running());
        runner.stop().await;
        assert_eq!(runner.live().phase, Phase::Stopped);
    }
}

//! Every command and every part of it, run once with everything filled in, by an admin with every module on:
//! none may crash, answer nothing, or say this version doesn't have it.
use gb_core::{Action, Bot, CommandEvent, Member, Place};
use gb_core::bot::Takes;
use gb_data::Store;
const G: &str = "700000000000000001";
const CH: &str = "800000000000000001";
fn val(t: Takes) -> String { match t { Takes::Member => "900000000000000002".into(), Takes::Text => "hello there 10m".into(), Takes::Whole { min, max } => ((min.max(1)).min(max)).to_string(), Takes::Role => "600000000000000003".into(), Takes::Channel | Takes::Category | Takes::AnyChannel => CH.into(), Takes::YesNo => "true".into(), Takes::Choice(l) => l[0].1.into() } }
fn text(a: &Action) -> String { format!("{a:?}") }
#[test]
fn every_command() {
    let tmp = tempfile::tempdir().unwrap();
    let bot = Bot::new(Store::create(tmp.path().join("eclipse.db")).unwrap());
    bot.on_server(G, "Ghost Town");
    for m in gb_core::bot::MODULES { let _ = bot.set_module(G, m.id, true, 1_800_000_000_000); }
    let admin = Member { id: "900000000000000001".into(), name: "Owner".into(), perms: 8 | 0x20 | 0x2 | 0x4 | 0x10000000000, ..Default::default() };
    let target = Member { id: "900000000000000002".into(), name: "Kai".into(), ..Default::default() };
    let mut report = Vec::new();
    for spec in gb_core::bot::commands() {
        let subs: Vec<(Option<&str>, &[gb_core::bot::Opt])> = if spec.subs.is_empty() { vec![(None, spec.options)] } else { spec.subs.iter().map(|s| (Some(s.name), s.options)).collect() };
        for (sub, opts) in subs {
            let args = opts.iter().map(|o| (o.name.to_string(), val(o.takes))).collect();
            let ev = CommandEvent { guild: G.into(), place: Place::channel(CH), member: admin.clone(), name: spec.name.into(), sub: sub.map(str::to_string), target: Some(target.clone()), args, at_ms: 1_800_000_000_000, from_form: true, ..Default::default() };
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bot.on_command(&ev, &|_| None, &mut |lo, _| lo)));
            let what = format!("/{}{}", spec.name, sub.map(|s| format!(" {s}")).unwrap_or_default());
            match r {
                Err(_) => report.push(format!("PANIC {what}")),
                Ok(out) if out.is_empty() => report.push(format!("EMPTY {what}")),
                Ok(out) => { let t = text(&out[0]); if spec.name != "whatsnew" && (t.contains("does not have") || t.contains("went wrong")) { report.push(format!("BAD {what} :: {}", t.chars().take(220).collect::<String>())); } }
            }
        }
    }
    assert!(report.is_empty(), "commands that crash, answer nothing or are not there:\n{}", report.join("\n"));
}

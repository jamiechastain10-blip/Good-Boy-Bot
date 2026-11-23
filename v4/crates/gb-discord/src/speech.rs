//! Making speech for text-to-speech: Windows' own offline voices (System.Speech, no internet or ffmpeg needed) or
//! Google Translate's speech service, the same two providers as Good Boy 3, each falling back to the other.
//! The words are passed to PowerShell through environment variables, never spliced into the script.

use std::path::{Path, PathBuf};
use std::time::Duration;

const PS_SPEAK: &str = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($env:GB_TTS_VOICE) { try { $s.SelectVoice($env:GB_TTS_VOICE) } catch {} }; $s.Rate = [int]$env:GB_TTS_RATE; $s.Volume = 100; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Stereo); $s.SetOutputToWaveFile($env:GB_TTS_OUT, $f); $s.Speak($env:GB_TTS_TEXT); $s.Dispose()";
const PS_VOICES: &str = "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }";

/// "auto" is Windows' voices on Windows and Google elsewhere.
pub fn chosen(setting: &str) -> &'static str {
    match setting { "windows" => "windows", "google" => "google", _ => if cfg!(windows) { "windows" } else { "google" } }
}
async fn powershell(script: &str, env: &[(&str, String)], seconds: u64) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    for (k, v) in env { cmd.env(k, v); }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    match tokio::time::timeout(Duration::from_secs(seconds), cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(Ok(o)) => Err(format!("Windows speech failed: {}", String::from_utf8_lossy(&o.stderr).trim().chars().take(200).collect::<String>())),
        Ok(Err(e)) => Err(format!("could not start PowerShell: {e}")),
        Err(_) => Err("Windows speech timed out".into()),
    }
}
/// The voices installed on this computer (Windows only).
pub async fn voices() -> Vec<String> {
    if !cfg!(windows) { return Vec::new(); }
    powershell(PS_VOICES, &[], 15).await.map(|o| o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()).unwrap_or_default()
}
fn new_file(cache: &Path, ext: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(cache).map_err(|e| format!("the speech folder could not be made ({e})"))?;
    Ok(cache.join(format!("tts-{}-{:x}.{ext}", super::now_ms(), fastrand::u32(..))))
}
async fn windows(cache: &Path, text: &str, voice: Option<&str>, rate: i64) -> Result<PathBuf, String> {
    let file = new_file(cache, "wav")?;
    let env = [("GB_TTS_TEXT", text.to_string()), ("GB_TTS_OUT", file.to_string_lossy().into_owned()), ("GB_TTS_VOICE", voice.unwrap_or("").to_string()), ("GB_TTS_RATE", rate.to_string())];
    match powershell(PS_SPEAK, &env, 20).await {
        Ok(_) if std::fs::metadata(&file).is_ok_and(|m| m.len() > 44) => Ok(file),
        Ok(_) => { let _ = std::fs::remove_file(&file); Err("the speech engine produced no audio".into()) }
        Err(e) => { let _ = std::fs::remove_file(&file); Err(e) }
    }
}
/// Text cut into pieces Google's service accepts (about 190 characters), at punctuation or spaces.
pub fn pieces(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text.trim();
    while rest.chars().count() > 190 {
        let head: String = rest.chars().take(190).collect();
        let cut = head.rfind([',', '.', '?', '!', ';', ':']).filter(|n| *n > 60).or_else(|| head.rfind(' ')).map(|n| n + 1).unwrap_or(head.len());
        out.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim();
    }
    if !rest.is_empty() { out.push(rest.to_string()); }
    out
}
async fn google(web: &reqwest::Client, cache: &Path, text: &str, lang: &str, slow: bool) -> Result<PathBuf, String> {
    let mut bytes = Vec::new();
    let parts = pieces(text);
    for (idx, part) in parts.iter().enumerate() {
        let r = web.get("https://translate.google.com/translate_tts").query(&[("ie", "UTF-8"), ("q", part.as_str()), ("tl", lang), ("client", "tw-ob"), ("ttsspeed", if slow { "0.24" } else { "1" }), ("total", &parts.len().to_string()), ("idx", &idx.to_string()), ("textlen", &part.chars().count().to_string())])
            .header("User-Agent", "Mozilla/5.0").timeout(Duration::from_secs(10)).send().await.map_err(|_| "I couldn't reach Google's speech service".to_string())?;
        if !r.status().is_success() { return Err(format!("Google's speech service answered {}", r.status().as_u16())); }
        bytes.extend_from_slice(&r.bytes().await.map_err(|_| "Google's speech answer was cut off".to_string())?);
    }
    if bytes.is_empty() { return Err("the speech engine produced no audio".into()); }
    let file = new_file(cache, "mp3")?;
    std::fs::write(&file, bytes).map_err(|e| format!("the speech could not be saved ({e})"))?;
    Ok(file)
}
/// Speech as an audio file, with the chosen provider first and the other as a fallback.
#[allow(clippy::too_many_arguments)]
pub async fn synth(web: &reqwest::Client, cache: &Path, provider: &str, text: &str, lang: &str, voice: Option<&str>, rate: i64, slow: bool) -> Result<(PathBuf, &'static str), String> {
    let first = chosen(provider);
    let order = if first == "windows" { ["windows", "google"] } else { ["google", "windows"] };
    let mut last = String::from("no speech provider is available on this system");
    for p in order {
        if p == "windows" && !cfg!(windows) { continue; }
        let got = if p == "windows" { windows(cache, text, voice, rate).await } else { google(web, cache, text, lang, slow).await };
        match got { Ok(f) => return Ok((f, if p == "windows" { "windows" } else { "google" })), Err(e) => { eprintln!("TTS provider {p} failed: {e}"); last = e; } }
    }
    Err(last)
}
/// `/tts diagnose`: every step, with what is wrong.
pub async fn diagnose(web: &reqwest::Client, cache: &Path, provider: &str, voice: Option<&str>, lang: &str) -> String {
    let mut lines = vec!["✅ voice support is built in".to_string(), format!("Provider: **{}** (setting: {provider}, platform: {})", chosen(provider), std::env::consts::OS)];
    if cfg!(windows) {
        let v = voices().await;
        lines.push(if v.is_empty() { "⚠️ no Windows voices found (or PowerShell is blocked)".into() } else { format!("Windows voices: {}", v.join(", ").chars().take(300).collect::<String>()) });
    }
    let t = std::time::Instant::now();
    match synth(web, cache, provider, "Testing one two three.", lang, voice, 0, false).await {
        Ok((f, via)) => { lines.push(format!("✅ speech test OK via **{via}**: {} bytes in {} ms", std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0), t.elapsed().as_millis())); let _ = std::fs::remove_file(f); }
        Err(e) => lines.push(format!("❌ speech test FAILED: {e}")),
    }
    lines.join("\n")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_text_is_cut_into_pieces_google_accepts() {
        let t = format!("{}. {}", "a".repeat(150), "b".repeat(150));
        let p = pieces(&t);
        assert_eq!(p.len(), 2);
        assert!(p.iter().all(|x| x.chars().count() <= 190));
        assert_eq!(pieces("short"), ["short"]);
        assert_eq!(pieces(&"x".repeat(400)).len(), 3);
    }
}

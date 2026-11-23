//! Sound filters for a downloaded song (bass boost, nightcore, slowed). The song is decoded, changed a little at a time (so a
//! long mix never sits in memory whole) and written as a WAV file that is played in its place. No outside program is needed.
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    Off,
    /// More low end.
    BassBoost,
    /// Faster and higher, by a quarter.
    Nightcore,
    /// Slower and lower.
    Slowed,
}
impl Filter {
    pub fn parse(name: &str) -> Filter {
        match name {
            "bassboost" => Filter::BassBoost,
            "nightcore" => Filter::Nightcore,
            "slowed" => Filter::Slowed,
            _ => Filter::Off,
        }
    }
}

/// A low shelf (RBJ cookbook): `gain_db` more (or less) below `freq` Hz.
#[derive(Clone, Copy)]
struct Shelf {
    b: [f32; 3],
    a: [f32; 2],
    z: [[f32; 2]; 2], // one pair of memory cells for each side
}
impl Shelf {
    fn low(rate: f32, freq: f32, gain_db: f32) -> Shelf {
        let a = 10f32.powf(gain_db / 40.0);
        let w = 2.0 * std::f32::consts::PI * freq / rate;
        let (sin, cos) = (w.sin(), w.cos());
        let alpha = sin / 2.0 * 2f32.sqrt();
        let sa = 2.0 * a.sqrt() * alpha;
        let b0 = a * ((a + 1.0) - (a - 1.0) * cos + sa);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cos - sa);
        let a0 = (a + 1.0) + (a - 1.0) * cos + sa;
        let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos);
        let a2 = (a + 1.0) + (a - 1.0) * cos - sa;
        Shelf { b: [b0 / a0, b1 / a0, b2 / a0], a: [a1 / a0, a2 / a0], z: [[0.0; 2]; 2] }
    }
    fn run(&mut self, side: usize, x: f32) -> f32 {
        let z = &mut self.z[side];
        let y = self.b[0] * x + z[0];
        z[0] = self.b[1] * x - self.a[0] * y + z[1];
        z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}
/// Loud peaks are rounded off instead of cracking.
fn soft(x: f32) -> f32 {
    let t = 0.8;
    if x.abs() <= t { x } else { x.signum() * (t + (1.0 - t) * ((x.abs() - t) / (1.0 - t)).tanh()) }
}

/// Plays the frames back faster (`speed` above 1) or slower, reading between frames.
struct Speed {
    step: f64,
    at: f64,
    held: Vec<[f32; 2]>,
}
impl Speed {
    fn feed(&mut self, frames: &[[f32; 2]], out: &mut Vec<[f32; 2]>) {
        self.held.extend_from_slice(frames);
        while self.at + 1.0 < self.held.len() as f64 {
            let i = self.at.floor() as usize;
            let f = (self.at - i as f64) as f32;
            let (p, q) = (self.held[i], self.held[i + 1]);
            out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
            self.at += self.step;
        }
        let gone = (self.at.floor() as usize).min(self.held.len());
        self.held.drain(..gone);
        self.at -= gone as f64;
    }
}

struct Wav {
    out: BufWriter<File>,
    frames: u64,
}
impl Wav {
    fn create(path: &Path, rate: u32) -> std::io::Result<Wav> {
        let mut out = BufWriter::new(File::create(path)?);
        out.write_all(b"RIFF\0\0\0\0WAVEfmt ")?;
        out.write_all(&16u32.to_le_bytes())?;
        out.write_all(&1u16.to_le_bytes())?; // plain PCM
        out.write_all(&2u16.to_le_bytes())?; // stereo
        out.write_all(&rate.to_le_bytes())?;
        out.write_all(&(rate * 4).to_le_bytes())?;
        out.write_all(&4u16.to_le_bytes())?;
        out.write_all(&16u16.to_le_bytes())?;
        out.write_all(b"data\0\0\0\0")?;
        Ok(Wav { out, frames: 0 })
    }
    fn push(&mut self, frames: &[[f32; 2]]) -> std::io::Result<()> {
        for f in frames {
            for s in f {
                self.out.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
            }
        }
        self.frames += frames.len() as u64;
        Ok(())
    }
    fn finish(mut self) -> std::io::Result<u64> {
        let bytes = (self.frames * 4) as u32;
        self.out.flush()?;
        let f = self.out.get_mut();
        f.seek(SeekFrom::Start(4))?;
        f.write_all(&(36 + bytes).to_le_bytes())?;
        f.seek(SeekFrom::Start(40))?;
        f.write_all(&bytes.to_le_bytes())?;
        f.flush()?;
        Ok(self.frames)
    }
}

/// Reads `src`, applies `filter` and writes `dst` (a WAV). Blocking: run it where blocking is fine.
pub fn apply_file(src: &Path, dst: &Path, filter: Filter) -> Result<(), String> {
    if filter == Filter::Off { return Err("no filter".into()); }
    let file = File::open(src).map_err(|e| format!("the song could not be opened ({e})"))?;
    let mut hint = Hint::new();
    if let Some(ext) = src.extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
    let probed = symphonia::default::get_probe()
        .format(&hint, MediaSourceStream::new(Box::new(file), Default::default()), &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|_| "that song's format cannot be filtered".to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("that song has no sound")?.clone();
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|_| "that song's sound cannot be read for filtering".to_string())?;
    let rate = track.codec_params.sample_rate.ok_or("that song does not say its sample rate")?;
    let mut wav = Wav::create(dst, rate).map_err(|e| e.to_string())?;
    let mut shelf = Shelf::low(rate as f32, 100.0, 11.0);
    let mut speed = match filter { Filter::Nightcore => Some(Speed { step: 1.25, at: 0.0, held: Vec::new() }), Filter::Slowed => Some(Speed { step: 0.85, at: 0.0, held: Vec::new() }), _ => None };
    let mut samples: Option<SampleBuffer<f32>> = None;
    let (mut frames, mut moved): (Vec<[f32; 2]>, Vec<[f32; 2]>) = (Vec::new(), Vec::new());
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(format!("the song could not be read to the end ({e})")),
        };
        if packet.track_id() != track.id { continue; }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue, // one bad packet is skipped
            Err(e) => return Err(format!("the song could not be decoded ({e})")),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let buf = samples.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        if buf.capacity() < decoded.capacity() * channels { *buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec); }
        buf.copy_interleaved_ref(decoded);
        frames.clear();
        for chunk in buf.samples().chunks_exact(channels) {
            let (l, r) = (chunk[0], if channels > 1 { chunk[1] } else { chunk[0] });
            frames.push([l, r]);
        }
        if filter == Filter::BassBoost {
            for f in frames.iter_mut() { *f = [soft(shelf.run(0, f[0] * 0.8)), soft(shelf.run(1, f[1] * 0.8))]; }
        }
        match speed.as_mut() {
            Some(s) => { moved.clear(); s.feed(&frames, &mut moved); wav.push(&moved).map_err(|e| e.to_string())?; }
            None => wav.push(&frames).map_err(|e| e.to_string())?,
        }
    }
    let n = wav.finish().map_err(|e| e.to_string())?;
    if n == 0 { return Err("that song had no sound to filter".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stereo WAV of one steady tone, `secs` long.
    fn tone(path: &Path, hz: f32, secs: f32, rate: u32) {
        let mut w = Wav::create(path, rate).unwrap();
        let n = (secs * rate as f32) as usize;
        let frames: Vec<[f32; 2]> = (0..n).map(|i| { let s = (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin() * 0.3; [s, s] }).collect();
        w.push(&frames).unwrap();
        w.finish().unwrap();
    }
    /// (length in seconds, the loudest part) of a WAV this module wrote.
    fn measure(path: &Path) -> (f32, f32) {
        let b = std::fs::read(path).unwrap();
        let rate = u32::from_le_bytes(b[24..28].try_into().unwrap()) as f32;
        let data = &b[44..];
        let peak = data.chunks_exact(2).map(|c| (i16::from_le_bytes([c[0], c[1]]) as f32 / 32767.0).abs()).fold(0.0, f32::max);
        (data.len() as f32 / 4.0 / rate, peak)
    }

    #[test]
    fn bass_gets_louder_the_highs_do_not_and_nothing_cracks() {
        let tmp = tempfile::tempdir().unwrap();
        let (low, high) = (tmp.path().join("low.wav"), tmp.path().join("high.wav"));
        tone(&low, 50.0, 2.0, 44_100);
        tone(&high, 4000.0, 2.0, 44_100);
        let (low_out, high_out) = (tmp.path().join("low-out.wav"), tmp.path().join("high-out.wav"));
        apply_file(&low, &low_out, Filter::BassBoost).unwrap();
        apply_file(&high, &high_out, Filter::BassBoost).unwrap();
        let (lo_len, lo_peak) = measure(&low_out);
        let (hi_len, hi_peak) = measure(&high_out);
        assert!((lo_len - 2.0).abs() < 0.01 && (hi_len - 2.0).abs() < 0.01, "same length: {lo_len} {hi_len}");
        // the 50 Hz tone came in at 0.3, was lowered to 0.24 before the shelf and is now clearly louder than that
        assert!(lo_peak > 0.55, "the low tone got louder: {lo_peak}");
        assert!(hi_peak > 0.2 && hi_peak < 0.3, "the high tone is as it was (a little lower): {hi_peak}");
        assert!(lo_peak <= 1.0 && hi_peak <= 1.0);
    }

    #[test]
    fn nightcore_is_shorter_and_slowed_is_longer() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("a.wav");
        tone(&src, 440.0, 4.0, 48_000);
        let (fast, slow) = (tmp.path().join("fast.wav"), tmp.path().join("slow.wav"));
        apply_file(&src, &fast, Filter::Nightcore).unwrap();
        apply_file(&src, &slow, Filter::Slowed).unwrap();
        let (f, _) = measure(&fast);
        let (s, _) = measure(&slow);
        assert!((f - 4.0 / 1.25).abs() < 0.05, "a quarter faster: {f}");
        assert!((s - 4.0 / 0.85).abs() < 0.05, "slower: {s}");
    }

    #[test]
    fn what_cannot_be_filtered_says_so_and_leaves_the_song_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let junk = tmp.path().join("junk.mp3");
        std::fs::write(&junk, b"not a song at all").unwrap();
        assert!(apply_file(&junk, &tmp.path().join("o.wav"), Filter::Nightcore).is_err());
        assert!(apply_file(&tmp.path().join("missing.mp3"), &tmp.path().join("o.wav"), Filter::Slowed).is_err());
        assert_eq!(Filter::parse("nightcore"), Filter::Nightcore);
        assert_eq!(Filter::parse("whatever"), Filter::Off);
    }

    #[test]
    fn real_compressed_songs_filter_too() {
        let tmp = tempfile::tempdir().unwrap();
        for (ext, codec) in [("mp3", "libmp3lame"), ("ogg", "libvorbis"), ("flac", "flac"), ("m4a", "aac")] {
            let src = tmp.path().join(format!("s.{ext}"));
            let made = std::process::Command::new("ffmpeg").args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ac", "2", "-ar", "44100", "-c:a", codec]).arg(&src).status();
            if !made.is_ok_and(|s| s.success()) { eprintln!("no ffmpeg or no {codec} here: skipping {ext}"); continue; }
            let out = tmp.path().join(format!("o-{ext}.wav"));
            apply_file(&src, &out, Filter::Nightcore).unwrap_or_else(|e| panic!("{ext}: {e}"));
            let (secs, peak) = measure(&out);
            assert!((secs - 3.0 / 1.25).abs() < 0.15, "{ext}: {secs}");
            assert!(peak > 0.05, "{ext} has sound: {peak}");
        }
    }
}

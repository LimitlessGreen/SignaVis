// ═══════════════════════════════════════════════════════════════════════
// xc_rank.rs — Xeno-canto references ranked by similarity to the own clip
// (Lite panel "Reference", sort "similar to clip"; Annotate v2 mockup R1)
//
// xc_embed: the app sends the XC audio it already has (raw body, headers
//   x-root / x-id); its first 60 s are embedded with Perch 2 in 5-s windows,
//   hop 2.5 s, and kept in <project>/.signavis/xc-cache/<id>.emb
//   ("XCE1", u32 windows, f32 hop, windows × 1536 f16, L2-normalised).
// xc_rank: embeds one 5-s window around the own clip (decoded from the
//   project file around that time only) and scores every cached XC
//   recording by its best window (cosine), with that window's start.
// The embedder is opened once and kept.
// ═══════════════════════════════════════════════════════════════════════

use half::f16;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use aw_embed::{DIM, SAMPLE_RATE, WINDOW};

const CACHE_DIR: &str = ".signavis/xc-cache";
const MAGIC: &[u8; 4] = b"XCE1";
const HOP_S: f32 = 2.5;
const MAX_S: f64 = 60.0;
const BATCH: usize = 16;

static EMBEDDER: OnceLock<Mutex<Option<(PathBuf, aw_embed::Embedder)>>> = OnceLock::new();

fn with_embedder<T>(app: &tauri::AppHandle, f: impl FnOnce(&mut aw_embed::Embedder) -> Result<T, String>) -> Result<T, String> {
    let model = crate::embeddings::model_path(app)?;
    if !model.is_file() {
        return Err("model-missing".into());
    }
    let lock = EMBEDDER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|_| "embedder lock poisoned".to_string())?;
    if guard.as_ref().map(|(p, _)| p != &model).unwrap_or(true) {
        let (e, _) = crate::embeddings::open_embedder(&model)?;
        *guard = Some((model, e));
    }
    f(&mut guard.as_mut().unwrap().1)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit())
}

fn cache_file(root: &str, id: &str) -> PathBuf {
    Path::new(root).join(CACHE_DIR).join(format!("{id}.emb"))
}

/// Mono f32 + sample rate of `[from_s, from_s + len_s)` of any audio source (Symphonia, seeking when from_s > 0).
pub(crate) fn decode_range(
    source: Box<dyn symphonia::core::io::MediaSource>,
    ext: Option<&str>,
    from_s: f64,
    len_s: f64,
) -> Result<(Vec<f32>, u32), String> {
    use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SErr,
                          formats::{FormatOptions, SeekMode, SeekTo}, io::MediaSourceStream, meta::MetadataOptions,
                          probe::Hint, units::Time};
    let mss = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    if let Some(e) = ext {
        hint.with_extension(e);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Format: {e}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("no audio track")?;
    let track_id = track.id;
    let sr = track.codec_params.sample_rate.ok_or("unknown sample rate")?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Codec: {e}"))?;
    let mut skip = 0usize;
    if from_s > 0.0 {
        let to = format
            .seek(SeekMode::Accurate, SeekTo::Time { time: Time::from(from_s), track_id: Some(track_id) })
            .map_err(|e| format!("Seek: {e}"))?;
        decoder.reset();
        skip = to.required_ts.saturating_sub(to.actual_ts) as usize;
    }
    let want = (len_s * sr as f64).ceil() as usize;
    let mut mono = Vec::with_capacity(want.min(sr as usize * 120));
    let mut buf: Option<SampleBuffer<f32>> = None;
    while mono.len() < want {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SErr::ResetRequired) => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SErr::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        let sb = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if sb.capacity() < decoded.capacity() * ch {
            *sb = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        sb.copy_interleaved_ref(decoded);
        for f in sb.samples().chunks(ch) {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            mono.push(f.iter().sum::<f32>() / ch as f32);
        }
    }
    mono.truncate(want);
    Ok((mono, sr))
}

fn write_cache(path: &Path, vecs: &[f32], hop: f32) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("bad cache path")?).map_err(|e| e.to_string())?;
    let n = (vecs.len() / DIM) as u32;
    let tmp = path.with_extension("part");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(MAGIC).and_then(|_| f.write_all(&n.to_le_bytes())).and_then(|_| f.write_all(&hop.to_le_bytes()))
        .and_then(|_| f.write_all(&crate::embeddings::to_f16_bytes(vecs)))
        .map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// (windows × DIM normalised vectors, hop in s) of a cached recording.
fn read_cache(path: &Path) -> Option<(Vec<f32>, f32)> {
    let b = std::fs::read(path).ok()?;
    if b.len() < 12 || &b[..4] != MAGIC {
        return None;
    }
    let n = u32::from_le_bytes(b[4..8].try_into().ok()?) as usize;
    let hop = f32::from_le_bytes(b[8..12].try_into().ok()?);
    let body = &b[12..];
    if body.len() != n * DIM * 2 {
        return None;
    }
    let v = body.chunks_exact(2).map(|c| f16::from_le_bytes([c[0], c[1]]).to_f32()).collect();
    Some((v, hop))
}

/// 5-s windows of `x` (32 kHz) → normalised embeddings.
fn embed_windows(e: &mut aw_embed::Embedder, x: &[f32], hop_s: f32) -> Result<Vec<f32>, String> {
    let hop = (hop_s * SAMPLE_RATE as f32).round() as usize;
    let windows = aw_embed::frame(x, hop, false);
    let mut v = e.embed(&windows, BATCH).map_err(|e| e.to_string())?;
    for row in v.chunks_exact_mut(DIM) {
        crate::embeddings::normalize(row);
    }
    Ok(v)
}

fn header<'a>(req: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("missing header {name}"))
}

/// Header values are ASCII: the project path comes percent-encoded (encodeURIComponent).
fn pct_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()).ok_or("bad escape")?;
            out.push(h);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Embed one Xeno-canto recording (raw audio body; headers x-root, x-id, x-ext). Returns its window count.
#[tauri::command]
pub async fn xc_embed(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<usize, String> {
    let root = pct_decode(header(&request, "x-root")?)?;
    let id = header(&request, "x-id")?.to_string();
    let ext = header(&request, "x-ext").unwrap_or("mp3").to_string();
    if !valid_id(&id) || !Path::new(&root).is_dir() {
        return Err("bad id or project".into());
    }
    let path = cache_file(&root, &id);
    if let Some((v, _)) = read_cache(&path) {
        return Ok(v.len() / DIM);
    }
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("expected raw audio".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (x, sr) = decode_range(Box::new(std::io::Cursor::new(bytes)), Some(&ext), 0.0, MAX_S)?;
        let x = aw_embed::resample_to_32k(&x, sr).map_err(|e| e.to_string())?;
        let vecs = with_embedder(&app, |e| embed_windows(e, &x, HOP_S))?;
        write_cache(&path, &vecs, HOP_S)?;
        Ok(vecs.len() / DIM)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankHit {
    id: String,
    score: f32,
    /// Start (s) of the best 5-s window in the XC recording.
    start: f64,
}

/// Best cosine of each cached XC recording to the 5-s window around the own clip (`path` in the project, seconds).
#[tauri::command]
pub async fn xc_rank(app: tauri::AppHandle, root: String, path: String, start: f64, end: f64, ids: Vec<String>) -> Result<Vec<RankHit>, String> {
    let file = crate::embed_map::safe_join(&root, &path).ok_or("path outside the project")?;
    tauri::async_runtime::spawn_blocking(move || {
        let win_s = WINDOW as f64 / SAMPLE_RATE as f64;
        let from = ((start + end) / 2.0 - win_s / 2.0).max(0.0);
        let ext = file.extension().and_then(|x| x.to_str()).map(str::to_string);
        let src = std::fs::File::open(&file).map_err(|e| e.to_string())?;
        let (x, sr) = decode_range(Box::new(src), ext.as_deref(), from, win_s)?;
        let x = aw_embed::resample_to_32k(&x, sr).map_err(|e| e.to_string())?;
        let q = with_embedder(&app, |e| embed_windows(e, &x, win_s as f32))?;
        let q = &q[..DIM];
        Ok(ids
            .iter()
            .filter(|id| valid_id(id))
            .filter_map(|id| {
                let (v, hop) = read_cache(&cache_file(&root, id))?;
                let (best, score) = v
                    .chunks_exact(DIM)
                    .map(|w| w.iter().zip(q).map(|(a, b)| a * b).sum::<f32>())
                    .enumerate()
                    .max_by(|a, b| a.1.total_cmp(&b.1))?;
                Some(RankHit { id: id.clone(), score, start: best as f64 * hop as f64 })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which of `ids` are embedded already (no audio needed for them).
#[tauri::command]
pub fn xc_cached(root: String, ids: Vec<String>) -> Vec<String> {
    ids.into_iter().filter(|id| valid_id(id) && cache_file(&root, id).is_file()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trip() {
        let dir = std::env::temp_dir().join(format!("signavis-xc-cache-{}", std::process::id()));
        let p = dir.join("1.emb");
        let mut v = vec![0f32; 2 * DIM];
        v[0] = 1.0;
        v[DIM + 1] = 0.5;
        write_cache(&p, &v, 2.5).unwrap();
        let (r, hop) = read_cache(&p).unwrap();
        assert_eq!(hop, 2.5);
        assert_eq!(r.len(), 2 * DIM);
        assert_eq!(r[0], 1.0);
        assert_eq!(r[DIM + 1], 0.5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(pct_decode("%2Fhome%2Fgr%C3%BCn%20x").unwrap(), "/home/grün x");
        assert_eq!(pct_decode("plain").unwrap(), "plain");
    }

    #[test]
    fn ids_are_digits_only() {
        assert!(valid_id("912340"));
        assert!(!valid_id("../x"));
        assert!(!valid_id(""));
    }

    #[test]
    fn decode_range_skips_to_the_start() {
        // 1 s of a ramp at 8 kHz as WAV; from 0.5 s the first sample is ~0.5
        let sr = 8000u32;
        let n = sr as usize;
        let mut wav = Vec::new();
        let data: Vec<u8> = (0..n).flat_map(|i| (((i as f32 / n as f32) * 30000.0) as i16).to_le_bytes()).collect();
        wav.extend(b"RIFF");
        wav.extend(((36 + data.len()) as u32).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(sr.to_le_bytes());
        wav.extend((sr * 2).to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend((data.len() as u32).to_le_bytes());
        wav.extend(data);
        let (x, got_sr) = decode_range(Box::new(std::io::Cursor::new(wav)), Some("wav"), 0.5, 0.25).unwrap();
        assert_eq!(got_sr, sr);
        assert_eq!(x.len(), 2000);
        assert!((x[0] - 0.5 * 30000.0 / 32768.0).abs() < 0.01, "first sample {}", x[0]);
    }
}

//! cargo run --release --example embed_bench -- <model.onnx> <audio.wav> [out.f32] [threads] [batch] [norm]
use std::time::Instant;

fn main() -> Result<(), aw_embed::Error> {
    let a: Vec<String> = std::env::args().collect();
    let model = &a[1];
    let wav = &a[2];
    let out = a.get(3).cloned();
    let threads: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(4);
    let batch: usize = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(4);
    let norm = a.get(6).map(|s| s == "1").unwrap_or(false);

    let t = Instant::now();
    let mut emb = aw_embed::Embedder::new(model, threads)?;
    println!("load: {:.2} s", t.elapsed().as_secs_f64());

    let t = Instant::now();
    let (x, sr) = aw_embed::read_wav_mono(wav)?;
    let y = aw_embed::resample_to_32k(&x, sr)?;
    let w = aw_embed::frame(&y, aw_embed::WINDOW, norm);
    let n = w.len() / aw_embed::WINDOW;
    let audio_s = x.len() as f64 / sr as f64;
    println!("decode+resample {sr}->32000: {:.3} s, {audio_s:.1} s Audio, {n} Fenster", t.elapsed().as_secs_f64());

    emb.embed(&w[..aw_embed::WINDOW], 1)?; // Warmup
    let t = Instant::now();
    let e = emb.embed(&w, batch)?;
    let dt = t.elapsed().as_secs_f64();
    println!(
        "inferenz: {dt:.2} s, {:.1} ms/Fenster, Echtzeitfaktor {:.0}x (threads={threads}, batch={batch})",
        dt * 1000.0 / n as f64,
        audio_s / dt
    );
    if let Some(p) = out {
        let bytes: Vec<u8> = y.iter().chain(e.iter()).flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(&p, bytes)?;
        println!("geschrieben: {p} ({} Samples 32k + {} Embedding-Werte)", y.len(), e.len());
    }
    Ok(())
}

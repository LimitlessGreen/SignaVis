// Dump a v2 spectrogram of a WAV file: <wav> <out.f32> <params.json>
// Writes raw f32 (frames × bins) and prints {frames, bins, stats} as JSON.
use aw_dsp::v2::{display_stats, Stft, StftParams};
use aw_dsp::WavSource;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut src = WavSource::open(&a[1]).expect("wav");
    let mut p: StftParams = serde_json::from_str(&std::fs::read_to_string(&a[3]).unwrap()).expect("params");
    p.sample_rate = src.sample_rate();
    let e = Stft::new(p.clone()).expect("params");
    let t = std::time::Instant::now();
    let mut out = Vec::new();
    e.run(&mut src, 4096, |_, v| { out.extend_from_slice(v); Ok(()) }).unwrap();
    let ms = t.elapsed().as_secs_f64() * 1e3;
    let bins = p.out_bins();
    let st = display_stats(&out, bins);
    std::fs::write(&a[2], out.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    println!("{}", serde_json::json!({ "frames": out.len() / bins, "bins": bins, "ms": ms,
        "median": st.median, "p999": st.p99_9, "freqs": p.bin_frequencies() }));
}

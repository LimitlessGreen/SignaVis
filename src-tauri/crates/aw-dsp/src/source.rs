// Random-access mono sample sources. Only the requested range is decoded,
// so memory stays bounded regardless of recording length.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

pub trait SampleSource {
    /// Total length in samples (mono).
    fn len(&self) -> u64;
    /// Fill `out` starting at sample `start`; returns samples actually read
    /// (less than `out.len()` at end of stream).
    fn read(&mut self, start: u64, out: &mut [f32]) -> io::Result<usize>;
}

pub struct MemSource<'a>(pub &'a [f32]);

impl SampleSource for MemSource<'_> {
    fn len(&self) -> u64 { self.0.len() as u64 }
    fn read(&mut self, start: u64, out: &mut [f32]) -> io::Result<usize> {
        let s = (start as usize).min(self.0.len());
        let n = out.len().min(self.0.len() - s);
        out[..n].copy_from_slice(&self.0[s..s + n]);
        Ok(n)
    }
}

/// WAV file, channel 0 only (same as JS `getChannelData(0)`).
pub struct WavSource {
    reader: hound::WavReader<BufReader<File>>,
    spec: hound::WavSpec,
    len: u64,
}

fn to_io(e: hound::Error) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, e) }

impl WavSource {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let reader = hound::WavReader::open(path).map_err(to_io)?;
        let spec = reader.spec();
        let len = reader.duration() as u64;
        Ok(Self { reader, spec, len })
    }
    pub fn sample_rate(&self) -> u32 { self.spec.sample_rate }
    pub fn channels(&self) -> u16 { self.spec.channels }
}

impl SampleSource for WavSource {
    fn len(&self) -> u64 { self.len }

    fn read(&mut self, start: u64, out: &mut [f32]) -> io::Result<usize> {
        if start >= self.len { return Ok(0); }
        self.reader.seek(start as u32)?;
        let ch = self.spec.channels as usize;
        let n = out.len().min((self.len - start) as usize);
        let total = n * ch;
        match self.spec.sample_format {
            hound::SampleFormat::Float => {
                for (i, s) in self.reader.samples::<f32>().take(total).enumerate() {
                    if i % ch == 0 { out[i / ch] = s.map_err(to_io)?; }
                }
            }
            hound::SampleFormat::Int => {
                let scale = 1.0 / (1u64 << (self.spec.bits_per_sample - 1)) as f32;
                for (i, s) in self.reader.samples::<i32>().take(total).enumerate() {
                    if i % ch == 0 { out[i / ch] = s.map_err(to_io)? as f32 * scale; }
                }
            }
        }
        Ok(n)
    }
}

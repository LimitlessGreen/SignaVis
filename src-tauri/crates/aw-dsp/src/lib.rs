// ═══════════════════════════════════════════════════════════════════════
// aw-dsp — native spectrogram core for the SignaVis desktop shell
//
// The engine lives in `v2` (STFT → linear/mel/log bands → dBFS or PCEN,
// centred frames). Audio is pulled block-wise from a `SampleSource`, so
// very long recordings stream through `pyramid` into an on-disk store.
// ═══════════════════════════════════════════════════════════════════════

pub mod detector;
pub mod display;
pub mod pyramid;
pub mod source;
pub mod v2;

pub use pyramid::{Pyramid, PyramidMeta, build_pyramid};
pub use source::{SampleSource, WavSource, MemSource};

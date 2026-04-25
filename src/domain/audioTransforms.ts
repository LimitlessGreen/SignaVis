// Small helper functions to make ultrasonic audio audible
// Exports: heterodyneDownmix(audioBuffer, carrierHz, lowpassHz)
//          resampleDivider(audioBuffer, divisor)
//          audioBufferToWav(audioBuffer)

export async function heterodyneDownmix(audioBuffer: AudioBuffer, carrierHz = 20000, lowpassHz = 8000): Promise<AudioBuffer> {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const offline = new OfflineAudioContext(numChannels, audioBuffer.length, sampleRate);

  const src = offline.createBufferSource();
  src.buffer = audioBuffer;

  // Gain node whose AudioParam.gain will be modulated by an oscillator
  const gain = offline.createGain();
  // Base value 0 so only the modulating signal affects output
  gain.gain.value = 0;

  src.connect(gain);

  // Optional lowpass after multiplication to retain difference components
  const lp = offline.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lowpassHz || 8000;
  gain.connect(lp);
  lp.connect(offline.destination);

  const osc = offline.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = carrierHz || 20000;

  // Connect oscillator to gain.gain AudioParam (audio-rate modulation)
  osc.connect(gain.gain);

  src.start(0);
  osc.start(0);

  const rendered = await offline.startRendering();
  return rendered;
}

export async function resampleDivider(audioBuffer: AudioBuffer, divisor = 8): Promise<AudioBuffer> {
  if (divisor <= 1) return audioBuffer;
  const newSampleRate = Math.max(8000, Math.floor(audioBuffer.sampleRate / divisor));
  const newLength = Math.ceil(audioBuffer.duration * newSampleRate);
  const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, newLength, newSampleRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered as AudioBuffer;
}

// Convert an AudioBuffer to a WAV Blob (16-bit PCM)
export function audioBufferToWav(audioBuffer: AudioBuffer): Blob {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const samples = audioBuffer.length;
  const blockAlign = numChannels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(view: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  let offset = 0;
  writeString(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeString(view, offset, 'WAVE'); offset += 4;
  writeString(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4; // Subchunk1Size
  view.setUint16(offset, format, true); offset += 2;
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, bitDepth, true); offset += 2;
  writeString(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;

  // Interleave
  const channels = [];
  for (let i = 0; i < numChannels; i++) channels.push(audioBuffer.getChannelData(i));

  let pos = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      pos += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

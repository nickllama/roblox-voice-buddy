/**
 * Runs on the audio thread: collects the microphone into 100 ms frames of 16-bit PCM
 * and posts each frame with its RMS level. Used by hands-free mode (handsfree.js).
 */
class PcmFrames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(Math.round(sampleRate / 10));
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n < this.buf.length) continue;
      const pcm = new Int16Array(this.n);
      let sum = 0;
      for (let j = 0; j < this.n; j++) {
        const s = Math.max(-1, Math.min(1, this.buf[j]));
        sum += s * s;
        pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / this.n) }, [pcm.buffer]);
      this.n = 0;
    }
    return true;
  }
}
registerProcessor("pcm-frames", PcmFrames);

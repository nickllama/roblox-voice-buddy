/**
 * Cuts speech out of an open microphone by loudness, so only speech leaves the PC.
 * Frames are fixed-length chunks of PCM with their RMS level (0..1). A segment starts when
 * two frames in a row are louder than the room, and ends after pauseMs of quiet.
 * The frames before the start are kept and sent first: recognition needs a moment of room sound
 * before the first word, or it drops that word.
 *
 * The room's noise level is learned from quiet frames. A sound that never pauses (a TV, a fan)
 * hits the length limit, and the level is raised to it so it stops opening segments.
 */
export const FRAME_MS = 100;
const PRE_FRAMES = 7;        // 0.7 s kept from before the start: half a second of room sound plus the frames that started it
const START_FRAMES = 2;      // frames in a row louder than the room
const MIN_LEVEL = 0.01;      // never treat anything quieter than this as speech
const LOUDER_THAN_ROOM = 3;  // speech is at least this many times the room level
const MIN_VOICED_MS = 300;   // shorter than this is a click or a cough
const MAX_SEGMENT_MS = 30000;

export function createSegmenter({ pauseMs, onStart, onChunk, onStop, onCancel }) {
  let seg = null;
  let pre = [];
  let hot = 0;
  let noise = MIN_LEVEL / LOUDER_THAN_ROOM;

  return {
    /** One frame from the microphone: pcm is an ArrayBuffer of 16-bit samples, rms its level. */
    frame(pcm, rms) {
      const loud = rms > Math.max(MIN_LEVEL, noise * LOUDER_THAN_ROOM);
      if (!seg) {
        pre.push(pcm);
        if (pre.length > PRE_FRAMES) pre.shift();
        if (!loud) { hot = 0; noise += (rms - noise) * 0.05; return; }
        if (++hot < START_FRAMES) return;
        seg = { ms: 0, voiced: hot * FRAME_MS, quiet: 0, sum: 0, n: 0 };
        onStart();
        for (const f of pre.splice(0)) onChunk(f);
        return;
      }
      onChunk(pcm);
      seg.ms += FRAME_MS; seg.sum += rms; seg.n += 1;
      if (loud) { seg.voiced += FRAME_MS; seg.quiet = 0; } else seg.quiet += FRAME_MS;
      const tooLong = seg.ms >= MAX_SEGMENT_MS;
      if (seg.quiet < pauseMs() && !tooLong) return;
      if (tooLong) noise = Math.max(noise, (seg.sum / seg.n) * 0.8);
      const voiced = seg.voiced;
      seg = null; hot = 0;
      if (voiced < MIN_VOICED_MS) onCancel(); else onStop();
    },
    /** Drops the segment in progress, if any. Returns true when there was one. */
    reset() {
      const open = seg !== null;
      seg = null; pre = []; hot = 0;
      return open;
    },
    get open() { return seg !== null; },
  };
}

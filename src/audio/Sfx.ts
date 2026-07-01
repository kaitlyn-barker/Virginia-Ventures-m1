/**
 * Sfx.ts — tiny procedural sound-effects helper for Virginia Ventures.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY PROCEDURAL (no .mp3 files)
 * ─────────────────────────────────────────────────────────────────────────
 * A 5th-grade game wants "juice": a click that clicks, a coin that chimes, a
 * little fanfare when you do well. Shipping a pile of audio files means asset
 * sourcing, licensing, loading, and cache headaches. Instead we synthesize each
 * cue with the Web Audio API (a few oscillators + an envelope). It's a handful
 * of bytes of code, works identically in the desktop browser and in a WebXR
 * headset (same page, same AudioContext), needs no network, and never 404s.
 *
 * USAGE
 *   import { sfx } from '../audio/Sfx.js';
 *   sfx.click();      // UI press
 *   sfx.plant();      // sow a crop
 *   sfx.coin();       // a trade / money
 *   sfx.success();    // a good outcome
 *   sfx.error();      // a blocked / invalid action
 *   sfx.chime();      // a phase / chapter change
 *   sfx.fanfare();    // a celebration (end of a season, great score)
 *
 * The AudioContext starts SUSPENDED until a user gesture (a browser rule). The
 * first cue is fired from the welcome "Enter the Colony" click, which unlocks
 * it; every call also resume()s defensively, so later non-gesture cues (a phase
 * change) play fine once the page has had its first click.
 *
 * Everything is wrapped in try/catch and no-ops if Web Audio is unavailable or
 * the user has muted (see setMuted), so a sound never throws into gameplay.
 */

type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

/** Lazily create (and resume) the shared AudioContext + master gain. */
function audio(): { ctx: AudioContext; master: GainNode } | null {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5; // headroom so layered cues don't clip
      master.connect(ctx.destination);
    }
    // Browsers suspend the context until a gesture; nudge it on every play.
    if (ctx.state === 'suspended') void ctx.resume();
    return { ctx, master: master! };
  } catch {
    return null;
  }
}

/**
 * Play one enveloped note. `t0` is an offset (seconds) from "now" so cues can
 * sequence several notes. The envelope is a quick attack + exponential decay,
 * which reads as a soft "pluck"/"blip" rather than a harsh beep.
 */
function note(
  freq: number,
  dur: number,
  opts?: { wave?: Wave; gain?: number; t0?: number; glideTo?: number },
): void {
  const a = audio();
  if (!a || muted) return;
  const { ctx: c, master: m } = a;
  const start = c.currentTime + (opts?.t0 ?? 0);
  const peak = opts?.gain ?? 0.3;

  const osc = c.createOscillator();
  osc.type = opts?.wave ?? 'triangle';
  osc.frequency.setValueAtTime(freq, start);
  if (opts?.glideTo) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, opts.glideTo),
      start + dur,
    );
  }

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.008); // fast attack
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur); // decay to silence

  osc.connect(g);
  g.connect(m);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Public, named cues. Each is a tiny composition tuned to feel right. */
export const sfx = {
  /** Mute/unmute every cue (e.g. for a settings toggle). */
  setMuted(value: boolean): void {
    muted = value;
  },
  isMuted(): boolean {
    return muted;
  },

  /** Soft UI press. */
  click(): void {
    note(420, 0.08, { wave: 'square', gain: 0.18 });
  },

  /** Picking up / selecting a tool or crop — a friendly little "boop". */
  select(): void {
    note(523, 0.09, { wave: 'triangle', gain: 0.22 });
    note(784, 0.09, { wave: 'triangle', gain: 0.16, t0: 0.05 });
  },

  /** Sowing a seed into a plot — a soft earthy pluck. */
  plant(): void {
    note(330, 0.12, { wave: 'triangle', gain: 0.26, glideTo: 392 });
  },

  /** A coin / a trade landing — bright two-note "ka-ching". */
  coin(): void {
    note(988, 0.07, { wave: 'square', gain: 0.16 });
    note(1319, 0.12, { wave: 'square', gain: 0.16, t0: 0.06 });
  },

  /** A good outcome — a quick rising major arpeggio (C-E-G). */
  success(): void {
    note(523, 0.12, { wave: 'triangle', gain: 0.26 });
    note(659, 0.12, { wave: 'triangle', gain: 0.26, t0: 0.1 });
    note(784, 0.18, { wave: 'triangle', gain: 0.28, t0: 0.2 });
  },

  /** A blocked / invalid action — a soft low "uh-uh". */
  error(): void {
    note(180, 0.14, { wave: 'sawtooth', gain: 0.16, glideTo: 120 });
  },

  /** A phase / chapter change — a calm bell-like chime. */
  chime(): void {
    note(659, 0.5, { wave: 'sine', gain: 0.28 });
    note(988, 0.5, { wave: 'sine', gain: 0.14, t0: 0.02 });
  },

  /** A celebration — an ascending fanfare for finishing a season / a high score. */
  fanfare(): void {
    const seq: [number, number][] = [
      [523, 0],
      [659, 0.12],
      [784, 0.24],
      [1047, 0.38],
    ];
    for (const [f, t] of seq) {
      note(f, 0.28, { wave: 'triangle', gain: 0.3, t0: t });
    }
    note(1319, 0.5, { wave: 'sine', gain: 0.16, t0: 0.5 });
  },
};

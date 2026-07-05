/**
 * Ambient.ts — a procedural ambient sound bed for the settlement (P2.3).
 *
 * Same philosophy as Sfx.ts (no .mp3 files — synthesize everything with the Web
 * Audio API): a soft, endless outdoor bed that makes the colony feel alive.
 *   • WIND  — filtered noise with a slow gust LFO on the cutoff (always there).
 *   • RIVER — a quieter band-passed noise "rush" (the waterfront to the north).
 *   • GULLS — occasional descending seabird cries, randomly spaced.
 *
 * It's a single, non-positional bed (a whole-scene ambience reads fine mono —
 * wind has no location), started on the first user gesture (the welcome
 * button, which also unlocks Sfx). It honors the audio setting: muting in
 * Settings ramps the whole bed to silence, so `gameSettings.muted` controls
 * both the cues and this bed. Everything is wrapped so it never throws into
 * gameplay and no-ops where Web Audio is unavailable.
 */

import { gameSettings } from '../game/GameSettings.js';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let started = false;
/** The target bed volume when unmuted (kept low so it never fights dialogue). */
const BED_VOLUME = 0.32;

/** Build a looping noise AudioBufferSourceNode (a few seconds of white noise). */
function makeNoise(context: AudioContext): AudioBufferSourceNode {
  const seconds = 3;
  const buffer = context.createBuffer(
    1,
    context.sampleRate * seconds,
    context.sampleRate,
  );
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = context.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

/** Wire up the wind + river beds under the master gain. */
function buildBed(context: AudioContext, out: GainNode): void {
  // ── WIND: heavily low-passed noise with a slow "gust" LFO on the cutoff. ──
  const wind = makeNoise(context);
  const windFilter = context.createBiquadFilter();
  windFilter.type = 'lowpass';
  windFilter.frequency.value = 420;
  windFilter.Q.value = 0.6;
  const windGain = context.createGain();
  windGain.gain.value = 0.28;

  // LFO gusts: slowly sweep the cutoff so the wind swells and eases.
  const gust = context.createOscillator();
  gust.type = 'sine';
  gust.frequency.value = 0.08; // ~one gust every 12s
  const gustDepth = context.createGain();
  gustDepth.gain.value = 180; // ± cutoff Hz
  gust.connect(gustDepth);
  gustDepth.connect(windFilter.frequency);

  wind.connect(windFilter);
  windFilter.connect(windGain);
  windGain.connect(out);

  // ── RIVER: quieter band-passed noise "rush" from the northern waterfront. ─
  const river = makeNoise(context);
  const riverFilter = context.createBiquadFilter();
  riverFilter.type = 'bandpass';
  riverFilter.frequency.value = 900;
  riverFilter.Q.value = 0.8;
  const riverGain = context.createGain();
  riverGain.gain.value = 0.1;
  river.connect(riverFilter);
  riverFilter.connect(riverGain);
  riverGain.connect(out);

  wind.start();
  river.start();
  gust.start();
}

/** Play a single descending gull cry (two short glided chirps). */
function gullCry(context: AudioContext, out: GainNode): void {
  const now = context.currentTime;
  const cries = 1 + Math.floor(Math.random() * 2); // 1–2 chirps
  for (let c = 0; c < cries; c++) {
    const t0 = now + c * 0.22;
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    const f = 1300 + Math.random() * 300;
    osc.frequency.setValueAtTime(f, t0);
    osc.frequency.exponentialRampToValueAtTime(f * 0.55, t0 + 0.18);
    const g = context.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    // Soften the sawtooth into more of a bird timbre.
    const lp = context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    osc.connect(lp);
    lp.connect(g);
    g.connect(out);
    osc.start(t0);
    osc.stop(t0 + 0.24);
  }
}

/** Schedule the next gull cry at a random interval (recursively). */
function scheduleGulls(context: AudioContext, out: GainNode): void {
  const next = 7000 + Math.random() * 14000; // every 7–21s
  setTimeout(() => {
    // Only cry while unmuted (and the tab is audible) — cheap gate.
    if (!gameSettings.current.muted && context.state === 'running') {
      try {
        gullCry(context, out);
      } catch {
        /* ignore a single failed cry */
      }
    }
    scheduleGulls(context, out);
  }, next);
}

export const ambient = {
  /**
   * Start the ambient bed. Safe to call more than once (only the first builds
   * the graph). Must be triggered from a user gesture so the AudioContext can
   * resume — the welcome "Enter the Colony" click is the intended trigger.
   */
  start(): void {
    try {
      if (started) {
        void ctx?.resume();
        return;
      }
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      // Start silent and fade in (or stay silent if muted at launch).
      master.gain.value = 0;
      master.connect(ctx.destination);
      buildBed(ctx, master);
      scheduleGulls(ctx, master);
      started = true;

      void ctx.resume();
      this.applyMute(gameSettings.current.muted);

      // Keep the bed in sync with the audio setting for the rest of the session.
      gameSettings.subscribe((s) => this.applyMute(s.muted));
    } catch {
      /* Web Audio unavailable — the game is silent but fully playable. */
    }
  },

  /** Ramp the whole bed to silence (muted) or its target volume (unmuted). */
  applyMute(muted: boolean): void {
    if (!ctx || !master) return;
    const target = muted ? 0 : BED_VOLUME;
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(target, ctx.currentTime, 0.4);
    } catch {
      master.gain.value = target;
    }
  },
};

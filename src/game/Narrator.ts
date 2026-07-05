/**
 * Narrator.ts — plain-words tradeoff callouts (P2.4 feedback juice).
 *
 * The three prosperity meters ARE the curriculum, so the game must make
 * cause-and-effect unmistakable. After each major decision a one-line callout
 * names the tradeoff in kid-plain words — "More tobacco means more to trade, but
 * less to eat this winter." It deliberately never uses the words "scarcity" or
 * "opportunity cost" (per the design intent); it just makes the mechanic legible.
 *
 * Same tiny module-singleton + emitter pattern as GameState/ColonyScore: any
 * system calls `narrator.say(...)`, and NarratorSystem (the view) shows it. The
 * player can turn these off in Settings (gameSettings.narration) — the system
 * checks that flag, so this emitter stays a dumb pipe.
 */

/** Which pillar a callout is about — tints the callout's accent (optional). */
export type NarratorTone = 'food' | 'wealth' | 'crown' | 'neutral';

export interface NarratorMessage {
  text: string;
  tone: NarratorTone;
}

export type NarratorListener = (msg: NarratorMessage) => void;

const listeners = new Set<NarratorListener>();

export interface Narrator {
  /** Speak a one-line callout. `tone` optionally tints it toward a pillar. */
  say(text: string, tone?: NarratorTone): void;
  /** Subscribe to callouts. Returns an unsubscribe function. */
  subscribe(cb: NarratorListener): () => void;
}

export const narrator: Narrator = {
  say(text: string, tone: NarratorTone = 'neutral'): void {
    const msg: NarratorMessage = { text, tone };
    for (const cb of [...listeners]) cb(msg);
  },
  subscribe(cb: NarratorListener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

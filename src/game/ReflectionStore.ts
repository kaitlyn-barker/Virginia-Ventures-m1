/**
 * ReflectionStore.ts — where the end-of-year Reflection answers are saved.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE STORE (and not the decision log)?
 * ─────────────────────────────────────────────────────────────────────────
 * `gameState.decisionLog` records what the student DID during the year
 * (planted, traded, smuggled, …). The Reflection sequence READS that log to
 * personalize its questions, but it must never write back into it — mixing the
 * after-the-fact reflections into the gameplay record would corrupt the data
 * the reflection itself reads. So the answers live here instead, in a brand-new
 * session-long singleton (same module-level pattern as GameState / ColonyScore).
 *
 * SHAPE: deliberately tiny and READABLE for the teacher's later review — just a
 * plain object mapping each question's id to the answer text the student chose:
 *     { land: "I grew mostly food...", tax: "No - ...", risk: "..." }
 * There is NO scoring here — reflection has no right or wrong answers.
 */

export interface ReflectionStore {
  /** questionId → the exact answer text the student picked. */
  answers: Record<string, string>;

  /** Save (or overwrite) the chosen answer for a question. */
  record(questionId: string, answer: string): void;

  /** A defensive copy of the answers object (safe for the caller to keep). */
  getAnswers(): Record<string, string>;

  /** Clear everything (used by a fresh game start). */
  reset(): void;
}

/**
 * THE singleton. Every `import { reflectionStore }` gets this same object.
 */
export const reflectionStore: ReflectionStore = {
  answers: {},

  record(questionId: string, answer: string): void {
    // Keyed by questionId, so re-answering a question simply overwrites it.
    this.answers[questionId] = answer;
  },

  getAnswers(): Record<string, string> {
    // Return a shallow COPY so callers can't mutate our stored answers.
    return { ...this.answers };
  },

  reset(): void {
    // Delete every key in place so any held reference sees the cleared object.
    for (const key of Object.keys(this.answers)) {
      delete this.answers[key];
    }
  },
};

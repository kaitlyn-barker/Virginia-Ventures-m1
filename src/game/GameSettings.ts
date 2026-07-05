/**
 * GameSettings.ts — session-long player comfort & accessibility settings.
 *
 * Same module-singleton pattern as GameState/ColonyScore (see GameState.ts for
 * the Unity→web "DontDestroyOnLoad singleton" explanation): one object, imported
 * everywhere, alive for the whole tab session. A hand-rolled emitter lets any
 * system react when a setting changes (the SettingsSystem applies them to the
 * locomotion engine, the sfx mute flag, panel scale, etc.).
 *
 * WHY THIS EXISTS
 *   A classroom VR deployment for 5th graders needs comfort controls the teacher
 *   (or the student) can reach without editing code: teleport vs. smooth-slide
 *   movement, snap vs. smooth turning, an audio mute, a narration toggle, and a
 *   readable-text size. These live here so every system reads one source of
 *   truth, and the choices PERSIST across a page reload (localStorage) — a kid
 *   who gets motion-sick and switches to teleport shouldn't have to redo it if
 *   the tab reloads mid-lesson.
 */

/** How the player moves in XR. Teleport is the comfort default (no vection). */
export type LocomotionMode = 'teleport' | 'free';
/** How the player turns. Snap is the comfort default (discrete 45° steps). */
export type TurnMode = 'snap' | 'smooth';
/** Readable-text size. Multiplies world-space panel scale (see textScale). */
export type TextSize = 'S' | 'M' | 'L';

export interface Settings {
  locomotionMode: LocomotionMode;
  turnMode: TurnMode;
  muted: boolean;
  /** Whether spoken/on-screen narrator callouts are shown. */
  narration: boolean;
  textSize: TextSize;
}

/** The multiplier each text size maps to (applied to world-space panel scale). */
export const TEXT_SIZE_SCALE: Record<TextSize, number> = {
  S: 0.85,
  M: 1.0,
  L: 1.25,
};

/** A settings-changed listener. Receives the full current settings snapshot. */
export type SettingsListener = (settings: Readonly<Settings>) => void;

const LS_KEY = 'vv-settings-v1';

/** Comfort-first defaults: teleport + snap turn, sound on, narration on. */
const DEFAULTS: Settings = {
  locomotionMode: 'teleport',
  turnMode: 'snap',
  muted: false,
  narration: true,
  textSize: 'M',
};

/** Private subscriber set (see GameState.ts for why a Set, not an array). */
const listeners = new Set<SettingsListener>();

/** Load persisted settings, falling back to defaults for anything missing. */
function load(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    // Private-mode / disabled storage / corrupt JSON — just use defaults.
    return { ...DEFAULTS };
  }
}

/** Persist the current settings (best-effort; never throws into gameplay). */
function save(s: Settings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — settings still work for this session */
  }
}

const state: Settings = load();

function emit(): void {
  const snapshot = Object.freeze({ ...state });
  for (const cb of [...listeners]) cb(snapshot);
}

export interface GameSettings {
  /** Read a live (mutable-internally, read-only-externally) view of settings. */
  readonly current: Readonly<Settings>;
  /** The world-space panel-scale multiplier for the current text size. */
  textScale(): number;

  setLocomotionMode(mode: LocomotionMode): void;
  setTurnMode(mode: TurnMode): void;
  setMuted(muted: boolean): void;
  setNarration(on: boolean): void;
  setTextSize(size: TextSize): void;

  /**
   * Subscribe to any settings change. Fires immediately with the current
   * snapshot (so a system can apply the persisted values on init), then again
   * on every change. Returns an unsubscribe function.
   */
  subscribe(cb: SettingsListener): () => void;
}

/** THE settings singleton. Every `import { gameSettings }` shares this object. */
export const gameSettings: GameSettings = {
  get current(): Readonly<Settings> {
    return state;
  },

  textScale(): number {
    return TEXT_SIZE_SCALE[state.textSize];
  },

  setLocomotionMode(mode: LocomotionMode): void {
    if (state.locomotionMode === mode) return;
    state.locomotionMode = mode;
    save(state);
    emit();
  },

  setTurnMode(mode: TurnMode): void {
    if (state.turnMode === mode) return;
    state.turnMode = mode;
    save(state);
    emit();
  },

  setMuted(muted: boolean): void {
    if (state.muted === muted) return;
    state.muted = muted;
    save(state);
    emit();
  },

  setNarration(on: boolean): void {
    if (state.narration === on) return;
    state.narration = on;
    save(state);
    emit();
  },

  setTextSize(size: TextSize): void {
    if (state.textSize === size) return;
    state.textSize = size;
    save(state);
    emit();
  },

  subscribe(cb: SettingsListener): () => void {
    listeners.add(cb);
    // Replay current state immediately so subscribers apply persisted values.
    cb(Object.freeze({ ...state }));
    return () => {
      listeners.delete(cb);
    };
  },
};

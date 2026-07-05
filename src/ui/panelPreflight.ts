/**
 * panelPreflight.ts — make the UI resilient to a missing/transient panel config.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM (P2.5 robustness)
 * ─────────────────────────────────────────────────────────────────────────
 * Every panel loads its layout from a compiled `./ui/*.json` file. IWSDK's
 * PanelUISystem fetches that file exactly ONCE with no retry; if the fetch fails
 * (a 404 on a bad deploy, or a transient network blip on a school Wi-Fi), it
 * logs a console error and never attaches the PanelDocument — so the panel's
 * system never qualifies and that whole PHASE can silently die. In a classroom
 * that reads as "the game is broken," with no clue why.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIX
 * ─────────────────────────────────────────────────────────────────────────
 * Before we build the scene, PREFLIGHT every UI config: fetch each one with a
 * few retries + backoff. This (a) warms the browser cache so the SDK's own
 * fetch a moment later succeeds from cache, and (b) confirms reachability up
 * front. If any config is still unreachable after retries, we surface a clear,
 * friendly full-screen message with a Refresh button instead of leaving a dead
 * season — a loud, actionable failure the teacher can act on.
 *
 * The config list is derived from the compiled `public/ui/*.json` panels via
 * import.meta.glob, so it can never drift out of sync with the actual panels.
 * (We glob the compiled JSON, not the `.uikitml` sources — pulling raw markup
 * into the module graph would break the production Rollup build. Reading only
 * the glob KEYS means nothing is actually imported or bundled.)
 */

/** Project-root glob of every compiled panel config → keys only, not loaded. */
const PANEL_CONFIGS = import.meta.glob('/public/ui/*.json');

/** Every runtime panel-config URL the app will ask the SDK to fetch. */
export function panelConfigUrls(): string[] {
  return Object.keys(PANEL_CONFIGS).map((path) => {
    const base = path.split('/').pop()!;
    return `./ui/${base}`;
  });
}

/** Fetch one URL, retrying with backoff. Resolves true if it ever succeeds. */
async function fetchWithRetry(url: string, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) return true;
      // A real 404/500 won't fix itself, but a 5xx blip might — keep trying.
    } catch {
      // Network error (offline, TLS handshake) — retry after a beat.
    }
    // Exponential-ish backoff: 150ms, 300ms, 600ms… (skip the wait on the last).
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
  return false;
}

/**
 * Preflight every panel config. Returns the list of configs that could NOT be
 * loaded (empty = all good). On failure, also shows the friendly overlay so a
 * broken deploy is visible to a teacher rather than a silently dead phase.
 */
export async function preflightPanels(): Promise<string[]> {
  const urls = panelConfigUrls();
  const results = await Promise.all(
    urls.map(async (url) => ({ url, ok: await fetchWithRetry(url) })),
  );
  const missing = results.filter((r) => !r.ok).map((r) => r.url);

  if (missing.length > 0) {
    console.error(
      `[Preflight] ${missing.length} UI config(s) unreachable after retries:`,
      missing,
    );
    showFailureOverlay(missing);
  } else {
    console.log(`[Preflight] All ${urls.length} UI configs reachable.`);
  }
  return missing;
}

/**
 * A friendly, full-screen "couldn't load" card with a Refresh button. Plain DOM
 * (not a UIKit panel — the point is that UIKit configs failed to load), styled
 * to match the game's parchment palette so it doesn't look like a crash.
 */
function showFailureOverlay(missing: string[]): void {
  if (document.getElementById('vv-preflight-overlay')) return; // once only
  const overlay = document.createElement('div');
  overlay.id = 'vv-preflight-overlay';
  overlay.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:16px',
      'background:rgba(30,24,18,0.92)',
      'color:#f1e7cf',
      'font-family:system-ui,-apple-system,sans-serif',
      'text-align:center',
      'padding:24px',
    ].join(';'),
  );

  const title = document.createElement('div');
  title.textContent = 'Some content didn’t load';
  title.setAttribute('style', 'font-size:26px;font-weight:700;');

  const body = document.createElement('div');
  body.textContent =
    'The connection may have hiccuped. Please refresh to try again.';
  body.setAttribute('style', 'font-size:16px;max-width:420px;opacity:0.85;');

  const btn = document.createElement('button');
  btn.textContent = 'Refresh';
  btn.setAttribute(
    'style',
    [
      'margin-top:8px',
      'padding:10px 28px',
      'font-size:18px',
      'font-weight:600',
      'color:#241a12',
      'background:#d4af37',
      'border:none',
      'border-radius:8px',
      'cursor:pointer',
    ].join(';'),
  );
  btn.addEventListener('click', () => window.location.reload());

  overlay.append(title, body, btn);

  // In DEV, list exactly which files failed to speed up debugging.
  if (import.meta.env.DEV) {
    const detail = document.createElement('div');
    detail.textContent = `Missing: ${missing.join(', ')}`;
    detail.setAttribute(
      'style',
      'font-size:12px;opacity:0.6;max-width:520px;word-break:break-all;',
    );
    overlay.append(detail);
  }

  document.body.appendChild(overlay);
}

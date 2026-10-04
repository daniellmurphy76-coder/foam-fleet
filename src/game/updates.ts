/**
 * "A new version is ready!" banner.
 *
 * The build bakes its id into the code (__BUILD_ID__) and writes the same id to version.json beside
 * index.html. When the game opens, when it comes back into view, and every few minutes, we fetch
 * version.json straight from the site (never from a cache). If it names a different build, a banner offers
 * to load it. The banner only shows while the app allows it (the menus), never in the middle of a game.
 *
 * "Update" loads the page again with a fresh ?v= in the address: a different address can't be answered from
 * the browser's cache, so even an iPad home-screen app gets the new version.
 */

/** How often to look for a new version while the game stays open. */
const CHECK_EVERY_MS = 5 * 60 * 1000;

export interface UpdateWatcher {
  /** May the banner show right now? (true on the menus, false during a game) */
  setAllowed(allowed: boolean): void;
  dispose(): void;
}

export function watchForUpdates(root: HTMLElement): UpdateWatcher {
  const current = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
  // `npm run dev` has no version.json (and reloads itself anyway).
  if (current === 'dev') return { setAllowed() {}, dispose() {} };

  let latest: string | null = null;
  let allowed = false;
  let checking = false;
  let disposed = false;
  let banner: HTMLElement | null = null;

  async function check(): Promise<void> {
    if (disposed || checking || latest !== null) return;
    checking = true;
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data: unknown = await res.json();
        const id = (data as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && id !== '' && id !== current) {
          latest = id;
          refresh();
        }
      }
    } catch {
      // Offline or the site is busy: just try again later.
    } finally {
      checking = false;
    }
  }

  function update(): void {
    const url = new URL(window.location.href);
    url.searchParams.set('v', latest ?? String(Date.now()));
    window.location.replace(url.toString());
  }

  function build(): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:absolute;left:50%;bottom:max(16px,env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
      'z-index:1500;display:flex;align-items:center;gap:14px;max-width:min(94vw,620px);padding:10px 12px 10px 20px;' +
      'border-radius:22px;border:3px solid #fff;background:#0b2a3a;color:#fff;' +
      'font:700 20px/1.2 Fredoka,system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:auto';
    const text = document.createElement('span');
    text.textContent = '✨ A new version of Foam Fleet is ready!';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Update';
    btn.style.cssText =
      'flex:none;min-height:48px;padding:6px 22px;border:0;border-radius:16px;background:#ff8a1f;color:#1d2b3a;' +
      'font:700 22px/1 Fredoka,system-ui,sans-serif;cursor:pointer;touch-action:manipulation';
    btn.addEventListener('click', update);
    el.append(text, btn);
    root.appendChild(el);
    return el;
  }

  function refresh(): void {
    const show = allowed && latest !== null && !disposed;
    if (show && !banner) banner = build();
    if (banner) banner.style.display = show ? 'flex' : 'none';
  }

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void check();
  };
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
  void check();

  return {
    setAllowed(next: boolean): void {
      if (next === allowed) return;
      allowed = next;
      refresh();
      if (allowed) void check();
    },
    dispose(): void {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      banner?.remove();
      banner = null;
    },
  };
}

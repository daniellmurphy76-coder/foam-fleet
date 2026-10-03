/**
 * Safety nets so one broken module can't freeze the whole game.
 *
 *  - guard():           wraps a service so every method call is try/catch'd.
 *  - buildOrFallback(): if a module's create function throws, use a stand-in instead.
 *
 * Everything that goes wrong lands in `__foam.errors` (see debug.ts).
 */
import { foam, reportError } from './debug';

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Wrap an object so that calling any of its methods can never throw. `safeReturns`
 * says what to hand back for methods that return something (default: undefined).
 *
 * Only used for services whose methods return nothing important (sound, effects,
 * HUD, menu, input). Hot objects like boats and the world are NOT proxied, because
 * every other module reads them thousands of times per frame.
 */
export function guard<T extends object>(
  label: string,
  target: T,
  safeReturns: Record<string, () => unknown> = {},
): T {
  const cache = new Map<PropertyKey, { orig: unknown; wrapped: AnyFn }>();
  return new Proxy(target, {
    get(obj, prop) {
      let value: unknown;
      try {
        value = Reflect.get(obj, prop, obj);
      } catch (e) {
        reportError(`${label}.${String(prop)}`, e);
        return safeReturns[String(prop)]?.();
      }
      if (typeof value !== 'function') return value;
      const hit = cache.get(prop);
      if (hit && hit.orig === value) return hit.wrapped;
      const fn = value as AnyFn;
      const name = `${label}.${String(prop)}`;
      // Fixed arity (no rest args) so a call allocates nothing. Six is more than any service method takes
      // (the widest is input.rumble with four), and passing the extras along as undefined is harmless.
      const wrapped: AnyFn = (a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown, f?: unknown) => {
        try {
          return fn.call(obj, a, b, c, d, e, f);
        } catch (e) {
          reportError(name, e);
          return safeReturns[String(prop)]?.();
        }
      };
      cache.set(prop, { orig: value, wrapped });
      return wrapped;
    },
  });
}

/** Run `make()`; if it throws, log it and use `fallback()` so the game keeps going. */
export function buildOrFallback<T>(label: string, make: () => T, fallback: () => T): T {
  try {
    return make();
  } catch (e) {
    reportError(`${label} failed, using a stand-in`, e);
    if (!foam.fallbacks.includes(label)) foam.fallbacks.push(label);
    return fallback();
  }
}

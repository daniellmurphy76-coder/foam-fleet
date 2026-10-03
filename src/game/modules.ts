/**
 * The one place the game core imports the other builders' modules from.
 * If a module's file moves, fix its line here and nothing else changes.
 */
export { createWorld } from '../world/world';
export { createPickups } from '../world/pickups';
export { createBalloons } from '../world/balloons';
export { createSharks } from '../sharks/sharks';
export { createBoat, resolveBoatCollisions } from '../entities/boat';
export { createDartSystem } from '../combat/darts';
export { createEffects } from '../fx/effects';
export { createInput } from '../input/input';
export { createBotController } from '../ai/bot';
export { createHud } from '../ui/hud';
export { createMenu } from '../ui/menu';
export { createSfx } from '../audio/sfx';
export { awardTrophies } from '../ui/trophies';

/**
 * Online play loads on demand (v5), so offline players never download the net code (or PeerJS), and a
 * broken net module can only break "Play Online", never the game's start-up.
 */
export const loadHostNet = () => import('../net/host');
export const loadGuestNet = () => import('../net/guest');

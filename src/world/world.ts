import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Checkpoint, ModeId, Obstacle, SpawnPoint, World } from '../types';
import { createCourse, type Course } from './course';
import { battleSpawns, buildLayout, findSafeSpot, raceSpawns, teamSpawns } from './layout';
import { createProps } from './props';
import { createSky } from './sky';
import { Bag } from './util';
import { createWater } from './water';
import { waveHeight, waveNormal } from './waves';

/**
 * Builds the lagoon (water, sky, lights, islands, race gates) into `scene`.
 *
 * The pieces, each in its own file:
 *   waves.ts   the wave table shared by the CPU and the water shader
 *   layout.ts  where everything goes (islands, rocks, duck, gates, spawn spots, rescue spots)
 *   water.ts   the water mesh and shader
 *   sky.ts     sky picture, sun, shadows, fog, clouds
 *   props.ts   islands, palms, rocks, lighthouse, rubber duck, edge buoys
 *   course.ts  race gates (only built for 'race')
 *
 * Only 'race' is special. 'battle', 'team' and 'practice' all get the same open lagoon with
 * the gates hidden (the gate data is still filled in).
 */
export function createWorld(scene: THREE.Scene, mode: ModeId): World {
  const layout = buildLayout(CONFIG.arena.radius);
  const bag = new Bag();
  const isRace = mode === 'race';

  // Everything we add goes under one group, so dispose() can lift it all out in one go.
  const root = new THREE.Group();
  root.name = 'foam-fleet-world';
  scene.add(root);

  const sky = createSky(scene, root, bag, layout.arenaRadius);
  const water = createWater(root, bag, layout);
  const props = createProps(root, bag, layout);
  const course: Course | null = isRace ? createCourse(root, bag, layout) : null;

  // The race data is always filled in, even when the gates are not drawn (every mode but race).
  const checkpoints: readonly Checkpoint[] = layout.gates.map((g) => ({
    position: new THREE.Vector3(g.x, 0, g.z),
    heading: g.heading,
    radius: g.radius,
  }));
  const obstacles: readonly Obstacle[] = layout.obstacles;

  let disposed = false;

  return {
    waveHeight,
    waveNormal,
    obstacles,
    arenaRadius: layout.arenaRadius,
    checkpoints,

    spawnPoints(count: number, spawnMode: ModeId): SpawnPoint[] {
      const n = Math.max(0, Math.floor(count));
      // Battle, team and practice boats all start on the battle ring.
      return spawnMode === 'race' ? raceSpawns(layout, n) : battleSpawns(layout, n);
    },

    teamSpawnPoints(countA: number, countB: number): [SpawnPoint[], SpawnPoint[]] {
      return teamSpawns(layout, countA, countB);
    },

    safeSpot(x: number, z: number, heading: number): SpawnPoint {
      return findSafeSpot(layout, x, z, heading);
    },

    update(t: number, dt: number): void {
      if (disposed) return;
      water.update(t);
      sky.update(t, dt);
      props.update(t, dt);
      course?.update(t);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      sky.dispose(); // puts scene.fog / background / environment back
      scene.remove(root);
      bag.disposeAll();
    },
  };
}

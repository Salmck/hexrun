// Comparison-experiment mode ("对比试验") - decoupled the same way agent2/3/4
// are: game.js keeps only the thin dispatch hooks, all the actual logic lives
// here.
//
// The map is generated exactly like agent2's (a scattered goal cluster, one
// goal per racer, on a plain generated obstacle field) - see
// Game#_setupMapMode, which calls generateObstacleGrid/pickScatteredGoals
// with this mode's own map size and seeded RNG (game.compareRng) instead of
// agent2's fixed size and Math.random, so a run here is reproducible the
// same way agent4's is.
//
// What's actually being compared is routing LOGIC: game.compareMode selects
// one of four "logics" (a/b/c/d, picked in the panel) that every racer in the
// session uses.
//
// - C, D delegate to agent2's own routing verbatim, unchanged (fully shared
//   field of view from the very first tick, yielding enabled) - D exists
//   specifically as that untouched baseline to compare A against; C is still
//   the same placeholder seam as D until it gets its own distinct logic.
// - A withholds the shared field of view: each racer only "knows" what it
//   personally has sensed, so goal-discovery doesn't instantly propagate to
//   the whole swarm. The moment any racer actually reaches (settles on) a
//   goal, every racer's private view is folded into one shared pool and
//   vision behaves exactly like C/D from then on.
// - B disables the endgame yield mechanism entirely (agent2ChainYield/
//   agent2ForceYield never run): a racer that settles on a goal stays there
//   no matter who else wants it. Its routing (treatReachedAsObstacle, passed
//   to agent2ChooseMove below) treats every settled racer as a real
//   obstacle, same as a wall, so it still routes AROUND one if a walkable
//   detour exists - only when every route to every goal it knows of is
//   truly sealed off does it never finish. compareCheckStuckRacers detects
//   that exactly (a flood-fill, not a guess) and marks it, so the round
//   counter still stops instead of running forever waiting on something
//   that provably can't happen.
import { agent2SetupState, agent2ChooseMove, agent2Sense } from './agent2.js?v=90';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function compareSetupState(game, starts) {
  agent2SetupState(game, starts);
  // Only meaningful for mode A (see compareChooseMove) - harmlessly unused
  // by B/C/D, which always pass agent2ChooseMove its default (game.agent2Sensed).
  game.compareVisionShared = false;
}

// Mode A's private-vision phase ends the instant any racer has actually
// reached a goal. At that moment, fold every racer's own private sensed
// cells into the one shared pool (game.agent2Sensed) so nothing anyone
// already found on their own has to be rediscovered from scratch.
//
// Game#_applyMapMove calls this directly, right where it sets a racer's
// status to 'reached', so the unlock lands on the exact same round as the
// arrival - a racer only calls back into compareChooseMove (which used to be
// the sole place this ran) once its roll animation finishes and it's ready
// for its NEXT decision, which can trail the actual arrival by several
// rounds while every other racer is mid-animation. Kept idempotent (the
// early return) so the redundant check compareChooseMove still does for
// mode A is a no-op once this has already fired.
export function compareUnlockSharedVision(game) {
  if (game.compareVisionShared) return;
  if (!game.mapRacers.some((r) => r.status === 'reached')) return;
  game.compareVisionShared = true;
  for (const r of game.mapRacers) {
    if (!r.comparePrivateSensed) continue;
    for (const key of r.comparePrivateSensed) game.agent2Sensed.add(key);
  }
}

// Game#_applyMapMove senses from a racer's newly-arrived cell right after
// moving it there (separately from the sensing agent2ChooseMove already does
// at decision time) - that call needs the same private-until-unlock routing
// as compareChooseMove, or a racer arriving on a cell (rather than merely
// deciding to head there) would leak straight into the shared pool even
// during mode A's private phase.
export function compareSense(game, racer) {
  if (game.compareMode !== 'a' || game.compareVisionShared) {
    agent2Sense(game, racer);
    return;
  }
  racer.comparePrivateSensed = racer.comparePrivateSensed || new Set();
  agent2Sense(game, racer, racer.comparePrivateSensed);
}

// Whether any racer - via the shared pool, or (mode A, pre-unlock) its own
// private view - has ever sensed at least one of the map's goal cells. Used
// for the "发现目标轮数" stat, which should reflect the first time ANYONE
// became aware of a goal, not just the first time that awareness was shared.
export function compareAnyGoalSensed(game) {
  if (game.mapGoals.some((g) => game.agent2Sensed.has(`${g.bx},${g.by}`))) return true;
  return game.mapRacers.some((r) => r.comparePrivateSensed &&
    game.mapGoals.some((g) => r.comparePrivateSensed.has(`${g.bx},${g.by}`)));
}

export function compareChooseMove(game, racer) {
  switch (game.compareMode) {
    case 'a': {
      compareUnlockSharedVision(game);
      if (game.compareVisionShared) return agent2ChooseMove(game, racer);
      racer.comparePrivateSensed = racer.comparePrivateSensed || new Set();
      return agent2ChooseMove(game, racer, { sensedSet: racer.comparePrivateSensed });
    }
    case 'b': return agent2ChooseMove(game, racer, { allowYield: false, treatReachedAsObstacle: true });
    case 'c': return agent2ChooseMove(game, racer);
    case 'd':
    default: return agent2ChooseMove(game, racer);
  }
}

// True if some UNOCCUPIED cell in `goalKeys` is reachable from (sx, sy)
// through `open` cells alone (plain BFS/flood-fill, walls + permanently-
// parked racers as the only obstacles - see compareCheckStuckRacers).
function bfsCanReachAGoal(open, sx, sy, goalKeys) {
  if (goalKeys.has(`${sx},${sy}`)) return true;
  const seen = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      const k = `${nx},${ny}`;
      if (seen.has(k) || !open(nx, ny)) continue;
      if (goalKeys.has(k)) return true;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return false;
}

// Mode B only (no yielding - see above): a racer settling on a goal is a
// PERMANENT obstacle from then on, since nothing will ever move it again.
// Rather than guess from symptoms (like "hasn't moved in a while" - which a
// racer stuck in a sealed-off pocket won't even show, since it can still
// wander freely within that pocket forever without ever finding a way out),
// this checks the actual ground truth directly: treating every 'reached'
// racer's cell as a wall (plus the real walls), is there still a path from
// this racer's current position to some goal nobody's sitting on? If not, no
// amount of further exploring or waiting will ever change that - it's
// PROVABLY stuck, immediately, not just probably stuck after a long wait.
//
// The only thing that can ever newly seal off a route is another racer
// freshly becoming 'reached' (walls never change), so Game#_applyMapMove
// calls this right there, once per new arrival, instead of every tick -
// recomputing from scratch each time is cheap (a single flood-fill per
// still-solving racer) and exact, so there's no threshold to tune and no
// window where a truly-stuck racer keeps counting as still trying.
export function compareCheckStuckRacers(game) {
  if (game.compareMode !== 'b' || !game.compareStats) return;
  const blockedByRacer = new Set(
    game.mapRacers.filter((r) => r.status === 'reached').map((r) => `${r.bx},${r.by}`));
  const open = (x, y) => game.blockGrid.blockOpen(x, y) && !blockedByRacer.has(`${x},${y}`);
  const openGoalKeys = new Set(
    game.mapGoals.filter((g) => !blockedByRacer.has(`${g.bx},${g.by}`)).map((g) => `${g.bx},${g.by}`));
  for (const r of game.mapRacers) {
    if (r.status !== 'solving' || r.compareStuck) continue;
    if (!bfsCanReachAGoal(open, r.bx, r.by, openGoalKeys)) {
      r.compareStuck = true;
      r.path = null;
      game._updateMapPathDots(r, null); // settling for good - no line left to show
      game.compareStats.stuckRacerIds.push(r.id);
    }
  }
  // Same "everyone's done, stop the clock" rule as a normal finish - a
  // permanently-stuck racer counts as done for THIS purpose (nothing further
  // will ever happen to it), even though it never reached a goal.
  if (game.compareStats.completedAt === null &&
      game.mapRacers.every((r) => r.status === 'reached' || r.compareStuck)) {
    game.compareStats.completedAt = game.compareStats.tickCount;
  }
}

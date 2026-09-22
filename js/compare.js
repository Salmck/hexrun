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
// Routing is agent4's: frontier-directed exploration (head straight for the
// nearest actual edge of known territory, racers claiming different
// frontiers instead of dithering step-by-step over "most unseen neighbour"
// like agent2 does) plus agent4's "no real progress toward a known target"
// deadlock breaker, reused directly from js/agent4.js (agent4ExploreStep) so
// this isn't a second, divergence-prone copy of it. The one thing NOT
// reused from agent4.js is its goal/target selection, which is built around
// concepts (robot types, goal LINES, per-line reservations) that don't
// exist here - compare mode's goals are a flat, ungrouped list, one per
// racer, exactly like agent2's, so compareChooseMove below keeps that
// simpler target selection (see agent2ChooseMove's own history for it)
// while swapping in agent4's exploration for the "don't know where to go
// yet" case.
//
// What's actually being compared is routing BEHAVIOR on top of that shared
// engine: game.compareMode selects one of four variants (a/b/c/d, picked in
// the panel) that every racer in the session uses.
//
// - C, D run the engine unchanged (fully shared field of view from the very
//   first tick, yielding enabled) - D exists specifically as that untouched
//   baseline to compare A against; C is still the same placeholder seam as
//   D until it gets its own distinct logic.
// - A withholds the shared field of view: each racer only "knows" what it
//   personally has sensed (including which frontiers it's found), so
//   goal-discovery doesn't instantly propagate to the whole swarm. The
//   moment any racer actually reaches (settles on) a goal, every racer's
//   private view is folded into one shared pool and vision behaves exactly
//   like C/D from then on.
// - B disables the endgame yield mechanism entirely (agent2ChainYield/
//   agent2ForceYield never run): a racer that settles on a goal stays there
//   no matter who else wants it. Its routing (treatReachedAsObstacle, passed
//   through to both the known-goal A* below and agent4ExploreStep) treats
//   every settled racer as a real obstacle, same as a wall, so it still
//   routes AROUND one if a walkable detour exists (during exploration too,
//   not just once a goal is known) - only when every route to every goal it
//   knows of is truly sealed off does it never finish. compareCheckStuckRacers
//   detects that exactly (a flood-fill, not a guess) and marks it, so the
//   round counter still stops instead of running forever waiting on
//   something that provably can't happen.
import { agent2SetupState, agent2Sense, agent2ChainYield, agent2ForceYield } from './agent2.js?v=91';
import { agent4ExploreStep } from './agent4.js?v=17';
import { findPath } from './maze.js?v=26';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function compareSetupState(game, starts) {
  agent2SetupState(game, starts);
  // Only meaningful for mode A (see compareChooseMove) - harmlessly unused
  // by B/C/D, which always pass compareChooseMoveImpl the shared pool
  // (game.agent2Sensed) directly.
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
// moving it there (separately from the sensing compareChooseMoveImpl already
// does at decision time) - that call needs the same private-until-unlock
// routing as compareChooseMove, or a racer arriving on a cell (rather than
// merely deciding to head there) would leak straight into the shared pool
// even during mode A's private phase.
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
      if (game.compareVisionShared) return compareChooseMoveImpl(game, racer, game.agent2Sensed, true, false);
      racer.comparePrivateSensed = racer.comparePrivateSensed || new Set();
      return compareChooseMoveImpl(game, racer, racer.comparePrivateSensed, true, false);
    }
    case 'b': return compareChooseMoveImpl(game, racer, game.agent2Sensed, false, true);
    case 'c': return compareChooseMoveImpl(game, racer, game.agent2Sensed, true, false);
    case 'd':
    default: return compareChooseMoveImpl(game, racer, game.agent2Sensed, true, false);
  }
}

// One decision for one racer, agent4's routing engine adapted for compare
// mode's flat (ungrouped) goal list - see this file's own top comment for
// exactly what's reused from js/agent4.js (agent4ExploreStep) versus what's
// necessarily different (target selection has no robot-type/goal-line
// concepts to consider here).
function compareChooseMoveImpl(game, racer, sensedSet, allowYield, treatReachedAsObstacle) {
  agent2Sense(game, racer, sensedSet);

  const pool = DIRS
    .map(([dx, dy]) => ({ fx: racer.bx + dx, fy: racer.by + dy }))
    .filter((cell) => game._mapCellAvailable(cell.fx, cell.fy, racer));

  const adjGoal = pool.find((cell) => game._isMapGoal(cell.fx, cell.fy));
  if (adjGoal) return adjGoal;

  // Checked first, same as agent4ChooseMove, so a scatter set by the
  // no-progress breaker below actually gets to run for the several ticks
  // it's meant to last - otherwise a fresh A* replan immediately re-finds
  // the exact same jammed route and the flag never gets consumed.
  if ((racer.scatterSteps || 0) > 0 && pool.length) {
    racer.scatterSteps -= 1;
    racer.path = null;
    game._updateMapPathDots(racer, null);
    const fwd = pool.filter((c) => !racer.previousCell || c.fx !== racer.previousCell.bx || c.fy !== racer.previousCell.by);
    const cands = fwd.length ? fwd : pool;
    return cands[Math.floor(Math.random() * cands.length)];
  }

  // Only a goal that is both known AND currently free is a usable target -
  // unlike agent2's own fallback-to-a-taken-goal, this never plans toward
  // one it can't actually land on; if none of the known ones are free,
  // exploring is guaranteed to eventually turn one up (goals == racer count
  // always, so some goal somewhere is free while this racer hasn't reached
  // one yet).
  const knownGoals = game.mapGoals.filter((g) => sensedSet.has(`${g.bx},${g.by}`));
  const isTaken = (g) => game.mapRacers.some(
    (o) => o !== racer && o.status === 'reached' && o.bx === g.bx && o.by === g.by);
  const freeKnownGoals = knownGoals.filter((g) => !isTaken(g));

  if (freeKnownGoals.length) {
    let target = null, bestD = Infinity;
    for (const g of freeKnownGoals) {
      const d = Math.abs(g.bx - racer.bx) + Math.abs(g.by - racer.by);
      if (d < bestD) { bestD = d; target = g; }
    }

    // Tracks real progress toward `target`, separately from idleTicks (which
    // only catches a racer that couldn't move AT ALL). A racer wedged in a
    // tight multi-racer knot can keep successfully taking a step most ticks
    // - resetting idleTicks every time - while net distance to its own
    // target never actually improves, shuffling sideways within the same
    // pocket forever. That never trips the idle-based scatter breaker below,
    // so it's tracked here instead.
    const distToTarget = Math.abs(target.bx - racer.bx) + Math.abs(target.by - racer.by);
    const targetKey = `${target.bx},${target.by}`;
    if (racer._progressTargetKey === targetKey && distToTarget >= (racer._progressDist ?? Infinity)) {
      racer.noProgressTicks = (racer.noProgressTicks || 0) + 1;
    } else {
      racer.noProgressTicks = 0;
    }
    racer._progressTargetKey = targetKey;
    racer._progressDist = distToTarget;
    if ((racer.noProgressTicks || 0) > 40) {
      racer.noProgressTicks = 0;
      racer.scatterSteps = 5; // one step consumed right here
      racer.path = null;
      game._updateMapPathDots(racer, null);
      const fwd = pool.filter((c) => !racer.previousCell || c.fx !== racer.previousCell.bx || c.fy !== racer.previousCell.by);
      const cands = fwd.length ? fwd : pool;
      return cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
    }

    // A* plans over this racer's sensed map using WALLS ONLY, UNLESS
    // treatReachedAsObstacle is set (mode B, no yielding), in which case a
    // settled racer's cell is excluded from the routable map entirely too,
    // so the route bends around it (or gives up and falls through to
    // exploring) instead of planning straight through/at something that
    // will never move.
    const sensedOpen = (x, y) => {
      if (!sensedSet.has(`${x},${y}`) || !game.blockGrid.blockOpen(x, y)) return false;
      if (treatReachedAsObstacle && game.mapRacers.some(
        (o) => o !== racer && o.status === 'reached' && o.bx === x && o.by === y)) return false;
      return true;
    };
    const route = findPath(sensedOpen, game.blockGrid.blocksX, { fx: racer.bx, fy: racer.by }, { fx: target.bx, fy: target.by });
    if (route && route.length >= 2) {
      racer.path = route;
      racer.pathIndex = 0;
      racer.exploreTarget = null; // no longer exploring - free up the frontier claim for others
      game._updateMapPathDots(racer, route);
      const next = route[1];
      const parked = game.mapRacers.find((o) => o !== racer && o.status === 'reached' && o.bx === next.fx && o.by === next.fy);
      if (allowYield && parked && !agent2ChainYield(game, parked) && (racer.idleTicks || 0) >= 3) {
        agent2ForceYield(game, parked);
      }
      if (game._tryClearWayFor(racer, next)) return next;
      return null;
    }
    // Target not reachable over sensed ground yet - fall through to explore.
  }

  racer.path = null;
  game._updateMapPathDots(racer, null);
  if (!pool.length) return null;

  // Deadlock breaker for a racer with no usable route at all (a route-
  // following racer that's merely stuck gets its own no-progress trigger
  // above instead).
  if ((racer.idleTicks || 0) > 20) { racer.scatterSteps = 6; racer.idleTicks = 0; }
  if ((racer.scatterSteps || 0) > 0) {
    racer.scatterSteps -= 1;
    const fwd = pool.filter((c) => !racer.previousCell || c.fx !== racer.previousCell.bx || c.fy !== racer.previousCell.by);
    const cands = fwd.length ? fwd : pool;
    return cands[Math.floor(Math.random() * cands.length)];
  }

  return agent4ExploreStep(game, racer, pool, sensedSet, treatReachedAsObstacle);
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

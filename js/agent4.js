// Agent mode 4 - kept as its own decoupled module (own state, own exported
// hooks) so it can diverge from agent mode 3 without touching agent3's code
// or state. The movement AI (blind exploration, A*-to-goal, BFS chain-yield)
// is agent3's, unchanged, for type-A racers - see js/agent3.js for the full
// rationale behind that part.
//
// What's different from agent3 is the map, the racers' cosmetic split into
// two "robot types", and one small routing rule for type B:
// - Driven by a task COUNT (1-4, one task = one goal line), not a target
//   racer-count total to partition - see agent4GenerateMap. The session's
//   actual racer count is whatever those lines add up to, read back by the
//   caller once the map is built.
// - Every goal line is odd-length (3 or 5 goals), and its cargo is kept
//   centered on the line - see pickLineSizes and pickCenteredCargoIndices.
// - Racers are split into two "robot types", A and B, told apart by their 8
//   triangular faces (white vs black - see game.js's _setTriangleColor) as
//   well as by a solid, per-racer body color; the number of type-B racers
//   always equals the number of goal lines (one B's worth per task) - a
//   population count only, assigned once at setup, so which specific racer
//   lands on B is an otherwise-meaningless random pick.
// - Type B won't target a goal on a line that already has a type-B racer
//   settled on it - see the lineHasReachedB check in agent4ChooseMove for
//   why this is a soft preference (no claim/commit bookkeeping), not a hard
//   reservation: nothing stops two B's converging on the same still-open
//   line at once.
// - Type A chases goals exactly like agent3, EXCEPT it will not take a
//   line's last remaining empty cell while that line still has zero type-B
//   racers settled on it - that one cell is left for a B to claim instead.
//   This is enforced at the movement level too (game._agent4ReservedForB,
//   gating game._mapCellAvailable) so a type-A racer can never end up there
//   by exploration/scatter wandering either, not just by deliberate
//   targeting. Because type-B convergence above is only a soft preference,
//   it is possible (if rare) for every remaining un-reached B to already be
//   piled onto other lines while some other line sits at "one cell left,
//   still zero B" - in that specific case this one cell would stay
//   permanently unfillable. Accepted for now as a known edge case rather
//   than adding reservation/claim machinery to close it.

import { findPath, generateObstacleGrid } from './maze.js?v=26';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Goal lines must stay at least this many cells apart (Manhattan, nearest
// cell to nearest cell) so carving cargo and the open side into the base
// maze around one line can never reach into another line's territory, and
// so the endgame's per-line congestion never bleeds across lines. This is a
// calibration reference, not used directly - computeLineGap scales it to
// whatever map size is actually configured, so a small custom map doesn't
// need lines a fixed 10 cells apart to fit any goal at all.
const MIN_LINE_GAP_AT_REFERENCE_SIZE = 10;
const REFERENCE_MAP_SIZE = 21;
const MAX_MAP_SIZE = 61;

// generateObstacleGrid's default "at least 14 separate obstacle components"
// requirement is tuned for the game's normal ~21-cell maps - a small custom
// agent4 map can never reach 14 components at all (there just aren't enough
// cells), so every call here scales that requirement down to the actual
// generated size instead of relying on the default. Verified empirically
// down to a 6x6 grid (still succeeds reliably scaled this way) - the real
// lower bound on map size ends up being how big a single goal line needs
// (see neededMapSize), not this.
const REFERENCE_MIN_COMPONENTS = 14;
function scaledMinComponents(size) {
  return Math.max(1, Math.round((REFERENCE_MIN_COMPONENTS * size * size) / (REFERENCE_MAP_SIZE * REFERENCE_MAP_SIZE)));
}

// A tiny deterministic PRNG (mulberry32): given the same integer seed, this
// produces the exact same sequence of [0,1) floats every time, in every
// browser. Used to make a whole agent-4 run - map layout, spawn positions,
// robot-type assignment, and every routing tie-break during play - fully
// reproducible from just (seed, map size, task count): see
// Game#_setupMapMode, which creates one of these per reset and threads it
// through both map generation (agent4GenerateMap) and every Math.random()
// call in the movement AI below.
export function agent4CreateRng(seed) {
  let a = seed >>> 0;
  return function agent4Rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------------
// Shared state + vision (identical shape to agent3's, kept in separate
// game.agent4Visited / game.agent4Sensed fields so the two modes never
// share or clobber each other's memory).
// --------------------------------------------------------------------------

export function agent4SetupState(game, starts) {
  game.agent4Visited = new Set(starts.map((s) => `${s.fx},${s.fy}`));
  game.agent4Sensed = new Set();
}

export function agent4Sense(game, racer) {
  markSensed(game, racer.bx, racer.by);
  for (const [dx, dy] of DIRS) markSensed(game, racer.bx + dx, racer.by + dy);
}

// Records one cell as newly seen and, the first time only, tells game.js to
// paint the "explored" highlight there - a per-cell flag rather than a
// per-frame redraw, so lighting up the shared map costs nothing beyond the
// one instant a cell first enters anyone's vision.
function markSensed(game, x, y) {
  const k = `${x},${y}`;
  if (game.agent4Sensed.has(k)) return;
  game.agent4Sensed.add(k);
  if (game._markMapExplored) game._markMapExplored(x, y);
}

// --------------------------------------------------------------------------
// Movement AI
// --------------------------------------------------------------------------

export function agent4ChooseMove(game, racer) {
  agent4Sense(game, racer);
  const rng = game.agent4Rng || Math.random;

  const pool = DIRS
    .map(([dx, dy]) => ({ fx: racer.bx + dx, fy: racer.by + dy }))
    .filter((cell) => game._mapCellAvailable(cell.fx, cell.fy, racer));

  // A type-B racer's only routing difference from type A (and from plain
  // agent3): it won't target a goal line that already has a type-B racer
  // settled on it - it just keeps looking elsewhere instead, exactly as if
  // that whole line weren't known/free yet. This is a soft preference, not
  // a reservation - nothing stops two B's converging on the same still-open
  // line at once, and nothing guarantees every line ends up with one - so
  // there's no claim/commit bookkeeping needed, and the existing "no known
  // free goal -> keep exploring" fallback below already covers a B that
  // temporarily has nowhere it's willing to go.
  const lineHasReachedB = (groupId) => game.mapRacers.some((o) => {
    if (o.robotType !== 'B' || o.status !== 'reached') return false;
    const og = game.mapGoals.find((gg) => gg.bx === o.bx && gg.by === o.by);
    return og && og.groupId === groupId;
  });

  const adjGoal = pool.find((cell) => {
    if (!game._isMapGoal(cell.fx, cell.fy)) return false;
    if (racer.robotType !== 'B') return true;
    const g = game.mapGoals.find((gg) => gg.bx === cell.fx && gg.by === cell.fy);
    return !g || !lineHasReachedB(g.groupId);
  });
  if (adjGoal) return adjGoal;

  // Deadlock/congestion breaker, checked first so it actually gets to run
  // for the several ticks it's meant to last: a racer stuck despite having
  // a live route (see the no-progress tracking below) sets this, and it
  // needs to take priority over route-following on the very next ticks too
  // - otherwise a fresh A* replan just re-finds the same jammed route
  // immediately and the flag never gets consumed.
  if ((racer.scatterSteps || 0) > 0 && pool.length) {
    racer.scatterSteps -= 1;
    racer.path = null;
    game._updateMapPathDots(racer, null);
    const fwd = pool.filter((c) => !racer.previousCell || c.fx !== racer.previousCell.bx || c.fy !== racer.previousCell.by);
    const cands = fwd.length ? fwd : pool;
    return cands[Math.floor(rng() * cands.length)];
  }

  const knownGoals = game.mapGoals.filter((g) => game.agent4Sensed.has(`${g.bx},${g.by}`));
  const isTaken = (g) => game.mapRacers.some(
    (o) => o !== racer && o.status === 'reached' && o.bx === g.bx && o.by === g.by);
  // Only a goal that is both known AND currently free is a usable target.
  // With several separate lines, "nearest known" can easily be a line that
  // filled up while a farther, unsensed line still has room - routing there
  // anyway (agent2's fallback) would mean permanently fighting a full line.
  // Total goals == racer count always, so while this racer hasn't reached
  // one yet, some goal somewhere is free; if none of the KNOWN ones are,
  // exploring is guaranteed to eventually turn one up.
  // Mirrors game._mapCellAvailable's own reservation gate below (which
  // physically blocks type A from ever stepping onto such a cell) - without
  // this, a type-A racer could still pick a reserved cell as `target`, A*
  // would happily route it there, and it would then stall forever one step
  // short since the final move keeps getting refused.
  const freeKnownGoals = knownGoals.filter((g) => !isTaken(g)
    && (racer.robotType !== 'B' || !lineHasReachedB(g.groupId))
    && (racer.robotType === 'B' || !game._agent4ReservedForB(g.bx, g.by)));

  if (freeKnownGoals.length) {
    let target = null;
    let bestD = Infinity;
    for (const g of freeKnownGoals) {
      const d = Math.abs(g.bx - racer.bx) + Math.abs(g.by - racer.by);
      if (d < bestD) { bestD = d; target = g; }
    }

    // Track real progress toward `target`, separately from idleTicks (which
    // only catches a racer that couldn't move AT ALL). A racer wedged in a
    // tight multi-racer knot can keep successfully taking a step most ticks
    // - resetting idleTicks every time via game._applyMapMove - while net
    // distance to its own target never actually improves, shuffling
    // sideways within the same pocket forever. That never trips the
    // idle-based scatter breaker below, so it's tracked here instead.
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
      // Genuinely stuck despite having a route - drop it and let the
      // scatter check at the top of the function take over for the next
      // several ticks, exactly like a racer that never found a route at
      // all, so the tight knot it's wedged in gets a real chance to shake
      // loose instead of shuffling in place forever.
      racer.noProgressTicks = 0;
      racer.scatterSteps = 5; // one step consumed right here
      racer.path = null;
      game._updateMapPathDots(racer, null);
      const fwd = pool.filter((c) => !racer.previousCell || c.fx !== racer.previousCell.bx || c.fy !== racer.previousCell.by);
      const cands = fwd.length ? fwd : pool;
      return cands.length ? cands[Math.floor(rng() * cands.length)] : null;
    }

    // A* plans over sensed WALLS only - except a cell held by a settled
    // racer on a DIFFERENT goal line is excluded too. Evicting such a racer
    // has nowhere good to send it (its own line isn't the one this racer is
    // entering), so it would immediately want its old cell back the moment
    // this racer moves off it - the two then swap that one cell back and
    // forth forever. Excluding it here instead means A* simply never plans
    // through it in the first place: it finds whatever real alternate route
    // exists over currently sensed ground, or (if none is known yet) comes
    // back null and this racer goes exploring instead - which resolves
    // itself the instant enough of the map is sensed to reveal a bypass, no
    // timer or retry bookkeeping needed. A racer queueing to enter its OWN
    // target's line is unaffected - chain-yield/force-yield below still
    // handle that shuffle exactly as before.
    const sensedOpen = (x, y) => {
      if (!game.agent4Sensed.has(`${x},${y}`) || !game.blockGrid.blockOpen(x, y)) return false;
      const occ = game.mapRacers.find((o) => o !== racer && o.status === 'reached' && o.bx === x && o.by === y);
      if (!occ) return true;
      const occGoal = game.mapGoals.find((g) => g.bx === x && g.by === y);
      return !occGoal || occGoal.groupId === target.groupId;
    };
    const route = findPath(sensedOpen, game.blockGrid.blocksX, { fx: racer.bx, fy: racer.by }, { fx: target.bx, fy: target.by });
    if (route && route.length >= 2) {
      racer.path = route;
      racer.pathIndex = 0;
      racer.exploreTarget = null; // no longer exploring - free up the frontier claim for others
      game._updateMapPathDots(racer, route);
      const next = route[1];
      const parked = game.mapRacers.find((o) => o !== racer && o.status === 'reached' && o.bx === next.fx && o.by === next.fy);
      if (parked && !agent4ChainYield(game, parked) && (racer.idleTicks || 0) >= 3) {
        agent4ForceYield(game, parked);
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
  // above instead, which won't false-fire on a frontrunner legitimately
  // waiting its turn near a goal - see agent2.js for that rationale).
  if ((racer.idleTicks || 0) > 20) { racer.scatterSteps = 6; racer.idleTicks = 0; }
  if ((racer.scatterSteps || 0) > 0) {
    racer.scatterSteps -= 1;
    const fwd = pool.filter((c) => !racer.previousCell || c.fx !== racer.previousCell.bx || c.fy !== racer.previousCell.by);
    const cands = fwd.length ? fwd : pool;
    return cands[Math.floor(rng() * cands.length)];
  }

  return agent4ExploreStep(game, racer, pool);
}

// Frontier-directed exploration: a racer heads straight for the nearest
// FRONTIER cell - open, sensed ground that still borders something unsensed,
// i.e. the nearest actual edge of the known map - rather than a step-by-step
// greedy "most unseen neighbour" walk. Racers coordinate so they don't all
// beeline the same patch of unknown territory: each remembers the frontier
// cell it's currently heading for (racer.exploreTarget), and a racer picking
// a NEW target excludes whatever every other still-exploring racer is
// already claiming, only falling back to a claimed one if nothing else is
// reachable. The route there passes through the intervening known ground
// anyway, so nearby unvisited cells still get swept up along the way - nothing
// is skipped, the racer just doesn't dither over which nearby cell to take
// first.
function agent4ExploreStep(game, racer, pool) {
  if (racer.exploreTarget && isFrontierCell(game, racer.exploreTarget.fx, racer.exploreTarget.fy)) {
    const next = routeToward(game, racer, racer.exploreTarget);
    if (next) return next;
  }
  racer.exploreTarget = null;

  const claimed = new Set(
    game.mapRacers
      .filter((o) => o !== racer && o.status === 'solving' && o.exploreTarget)
      .map((o) => `${o.exploreTarget.fx},${o.exploreTarget.fy}`)
  );
  const all = collectFrontierCells(game);
  const unclaimed = all.filter((c) => !claimed.has(`${c.fx},${c.fy}`));
  const candidates = unclaimed.length ? unclaimed : all;

  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c.fx - racer.bx) + Math.abs(c.fy - racer.by);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best) {
    const next = routeToward(game, racer, best);
    if (next) { racer.exploreTarget = best; return next; }
  }

  // No known frontier at all (fully explored, or momentarily unreachable) -
  // fall back to the plain avoid-doubling-back walk.
  return pickTowardUnseen(game, racer, pool);
}

function routeToward(game, racer, target) {
  const sensedOpen = (x, y) => game.agent4Sensed.has(`${x},${y}`) && game.blockGrid.blockOpen(x, y);
  const route = findPath(sensedOpen, game.blockGrid.blocksX, { fx: racer.bx, fy: racer.by }, target);
  if (!route || route.length < 2) return null;
  const next = route[1];
  return game._mapCellAvailable(next.fx, next.fy, racer) ? next : null;
}

function isFrontierCell(game, x, y) {
  if (!game.agent4Sensed.has(`${x},${y}`) || !game.blockGrid.blockOpen(x, y)) return false;
  return DIRS.some(([dx, dy]) => !game.agent4Sensed.has(`${x + dx},${y + dy}`));
}

function collectFrontierCells(game) {
  const cells = [];
  for (const key of game.agent4Sensed) {
    const sep = key.indexOf(',');
    const x = Number(key.slice(0, sep)), y = Number(key.slice(sep + 1));
    if (game.blockGrid.blockOpen(x, y) && isFrontierCell(game, x, y)) cells.push({ fx: x, fy: y });
  }
  return cells;
}

function pickTowardUnseen(game, racer, pool) {
  if (racer.previousCell) {
    const notBack = pool.filter((cell) => cell.fx !== racer.previousCell.bx || cell.fy !== racer.previousCell.by);
    if (notBack.length) pool = notBack;
  }

  const unseenAround = (cell) => DIRS
    .filter(([dx, dy]) => !game.agent4Sensed.has(`${cell.fx + dx},${cell.fy + dy}`)).length;
  const most = Math.max(...pool.map(unseenAround));
  pool = pool.filter((cell) => unseenAround(cell) === most);

  const rng = game.agent4Rng || Math.random;
  return pool[Math.floor(rng() * pool.length)];
}

// BFS chain-yield within one goal line's 4-connected run (lines are >=10
// apart, so this can never reach across into a different line). Identical
// mechanics to agent2's version - see js/agent2.js for the full rationale.
function agent4ChainYield(game, parked) {
  const goalAt = (x, y) => game.mapGoals.some((g) => g.bx === x && g.by === y);
  const racerOn = (x, y) => game.mapRacers.find((r) => r.bx === x && r.by === y);

  const startK = `${parked.bx},${parked.by}`;
  const prev = new Map([[startK, null]]);
  const queue = [{ bx: parked.bx, by: parked.by }];
  let head = 0;
  let free = null;
  while (head < queue.length) {
    const cur = queue[head++];
    const isStart = cur.bx === parked.bx && cur.by === parked.by;
    if (!isStart && !racerOn(cur.bx, cur.by)) { free = cur; break; }
    for (const [dx, dy] of DIRS) {
      const nx = cur.bx + dx, ny = cur.by + dy;
      if (!goalAt(nx, ny)) continue;
      const k = `${nx},${ny}`;
      if (prev.has(k)) continue;
      prev.set(k, cur);
      queue.push({ bx: nx, by: ny });
    }
  }
  if (!free) return false;

  const chain = [];
  for (let c = free; c; c = prev.get(`${c.bx},${c.by}`)) chain.push(c);
  chain.reverse();

  for (let i = 0; i < chain.length - 1; i++) {
    const r = racerOn(chain[i].bx, chain[i].by);
    if (!r || r.status !== 'reached' || r.shape.isBusy() || r.pendingDir) return false;
  }

  for (let i = chain.length - 2; i >= 0; i--) {
    const r = racerOn(chain[i].bx, chain[i].by);
    r.path = null;
    game._applyMapMove(r, { fx: chain[i + 1].bx, fy: chain[i + 1].by });
  }
  const gi = game.mapGoals.findIndex((g) => g.bx === chain[0].bx && g.by === chain[0].by);
  if (gi >= 0) game.mapGoalMarkers[gi].material.color.setHex(0x35b88a);
  return true;
}

// Last-resort yield when chain-yield can't run this round (a link is
// mid-animation). Identical mechanics to agent2's version.
function agent4ForceYield(game, parked) {
  if (parked.shape.isBusy() || parked.pendingDir) return false;
  const dest = DIRS
    .map(([dx, dy]) => ({ fx: parked.bx + dx, fy: parked.by + dy }))
    .find((c) => game._mapCellAvailable(c.fx, c.fy, parked));
  if (!dest) return false;
  const gi = game.mapGoals.findIndex((g) => g.bx === parked.bx && g.by === parked.by);
  if (gi >= 0) game.mapGoalMarkers[gi].material.color.setHex(0x35b88a);
  parked.path = null;
  parked.status = 'solving';
  game._applyMapMove(parked, dest);
  return true;
}

// --------------------------------------------------------------------------
// Map generation: several separate goal lines + one-sided cargo.
// --------------------------------------------------------------------------

// One size (3 or 5, picked independently at random) per task/goal line -
// unlike agent3's partitionGoalCounts, agent4 is driven by a task COUNT
// (see agent4GenerateMap), not a target racer-count total to partition, and
// every line must come out odd-length so it always has an exact center cell
// for pickCenteredCargoIndices below to anchor on.
function pickLineSizes(taskCount, rng) {
  return Array.from({ length: taskCount }, () => (rng() < 0.5 ? 3 : 5));
}

// Chooses which `cargoCount` of a (always odd-length) line's `n` cells sit
// beside cargo, kept centered on the line: a single crate goes exactly in
// the middle cell; two or more put the farthest-apart pair symmetrically
// around the center (as far out as the line allows) and scatter any
// remaining crates randomly in the span between them.
function pickCenteredCargoIndices(n, cargoCount, rng) {
  const center = (n - 1) / 2;
  if (cargoCount <= 0) return new Set();
  if (cargoCount === 1) return new Set([center]);
  const spread = Math.floor(n / 2);
  const idxs = new Set([center - spread, center + spread]);
  if (cargoCount > 2) {
    const interior = [];
    for (let i = center - spread + 1; i < center + spread; i++) {
      if (!idxs.has(i)) interior.push(i);
    }
    for (let i = interior.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [interior[i], interior[j]] = [interior[j], interior[i]];
    }
    for (const idx of interior.slice(0, cargoCount - 2)) idxs.add(idx);
  }
  return idxs;
}

// Scales the reference gap (10 cells, tuned for the original fixed 21-cell
// map) down for a smaller custom map size, so a small map doesn't need
// lines a fixed 10 cells apart to fit any goal line at all. Floored at 2 so
// it never collapses to "any distance is fine" on a tiny map.
function computeLineGap(mapSize) {
  return Math.max(2, Math.round((mapSize * MIN_LINE_GAP_AT_REFERENCE_SIZE) / REFERENCE_MAP_SIZE));
}

// A working map big enough that `lineCount` goal lines can actually find
// mutually-`gap`-apart placements, that a single max-length (5-cell) line
// can be placed at all past its margin. A handful of lines fit `baseSize`
// easily; many lines need a visibly larger map, scaled by how many
// roughly-gap-apart slots have to fit on each axis.
function neededMapSize(lineCount, baseSize, gap) {
  const minForOneLine = 2 * 2 + 5; // margin (2 each side) + longest line (5)
  if (lineCount <= 1) return Math.max(baseSize, minForOneLine);
  const perAxis = Math.ceil(Math.sqrt(lineCount));
  return Math.min(MAX_MAP_SIZE, Math.max(baseSize, minForOneLine, perAxis * gap + 8));
}

// generateObstacleGrid's "every open cell is one connected region" check gets
// unreliable well before canvasSize reaches MAX_MAP_SIZE (an isolated open
// pocket becomes likely as the area grows), so a big canvas is never
// generated directly at full size. Instead, tile several independent
// baseSize x baseSize patches - each individually cheap and reliable to
// generate - across the canvas. This stays one connected region by
// construction: every generateObstacleGrid patch already has its whole
// border ring open, so adjacent patches always meet along an open seam, and
// each patch's own interior already connects out to that open border.
//
// When the canvas is no bigger than one tile (the common case for a small
// custom map size, or a single goal line on any size), skip tiling
// entirely and generate the canvas directly at its exact size instead -
// cropping a smaller canvas out of one bigger generated tile would only
// keep that corner's OWN connectivity by luck, not by construction, since
// generateObstacleGrid only guarantees the full tile it was asked for is
// one connected region.
function buildTiledGrid(canvasSize, baseSize, rng) {
  if (canvasSize <= baseSize) {
    return generateObstacleGrid(canvasSize, canvasSize, rng, 0.32, scaledMinComponents(canvasSize)).grid;
  }
  const tilesPerSide = Math.ceil(canvasSize / baseSize);
  const tiles = Array.from({ length: tilesPerSide }, () =>
    Array.from({ length: tilesPerSide }, () => generateObstacleGrid(baseSize, baseSize, rng, 0.32, scaledMinComponents(baseSize)).grid)
  );
  const grid = Array.from({ length: canvasSize }, (_, y) =>
    Array.from({ length: canvasSize }, (_, x) => {
      const ty = Math.floor(y / baseSize), tx = Math.floor(x / baseSize);
      return tiles[ty][tx][y % baseSize][x % baseSize];
    })
  );
  // Force the assembled canvas's own outer edge open too, matching the same
  // invariant every individual tile already carries on its own border.
  for (let x = 0; x < canvasSize; x++) { grid[0][x] = true; grid[canvasSize - 1][x] = true; }
  for (let y = 0; y < canvasSize; y++) { grid[y][0] = true; grid[y][canvasSize - 1] = true; }
  return grid;
}

function inBounds(x, y, width, height) {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function minCellDistance(a, b) {
  let min = Infinity;
  for (const p of a) for (const q of b) {
    const d = Math.abs(p.fx - q.fx) + Math.abs(p.fy - q.fy);
    if (d < min) min = d;
  }
  return min;
}

// Finds one straight run of `n` cells (horizontal or vertical, orientation
// picked at random) that (a) stays clear of the map edge by enough margin to
// carve cargo and the open side around it, and (b) sits at least `gap` away
// from every already-placed line. Purely random trial and error over the
// whole grid - simple, and the map is generated fresh on failure anyway (see
// agent4GenerateMap), so no fancier packing is needed.
function placeOneLine(width, height, n, existingLines, gap, rng) {
  const margin = 2;
  for (let tries = 0; tries < 500; tries++) {
    const horizontal = rng() < 0.5;
    let cells;
    if (horizontal) {
      const fy = margin + Math.floor(rng() * Math.max(1, height - 2 * margin));
      const fxRange = width - 2 * margin - (n - 1);
      if (fxRange <= 0) continue;
      const fx = margin + Math.floor(rng() * fxRange);
      cells = Array.from({ length: n }, (_, i) => ({ fx: fx + i, fy }));
    } else {
      const fx = margin + Math.floor(rng() * Math.max(1, width - 2 * margin));
      const fyRange = height - 2 * margin - (n - 1);
      if (fyRange <= 0) continue;
      const fy = margin + Math.floor(rng() * fyRange);
      cells = Array.from({ length: n }, (_, i) => ({ fx, fy: fy + i }));
    }
    if (cells.some((c) => c.fx < margin || c.fx >= width - margin || c.fy < margin || c.fy >= height - margin)) continue;
    if (existingLines.some((line) => minCellDistance(line.cells, cells) < gap)) continue;
    return { cells, horizontal };
  }
  return null;
}

// Carves one line's cargo side and open side into `grid` (mutated in place,
// true = open). The whole cargo-side edge (one cell out from every goal in
// the line) is forced closed - some of those cells become actual cargo
// crates (one type, at most floor(n/2) of them, kept centered on the line
// via pickCenteredCargoIndices), the rest become plain forced wall - so the
// barrier reads as solid with crates set into it, never a stray open gap
// next to a crate. Each crate's outward-facing cell (one further out) is
// forced closed too, so no crate ever backs onto open ground either.
//
// The opposite (entrance) side is forced OPEN for a yellow line, exactly as
// before - clear approach ground. For a BLUE line it's forced CLOSED
// instead, built up into a solid, wall-height "platform" (platformList) -
// the racer never actually reaches that cell during the finish celebration
// (its blue-cargo flick only ever covers half the distance to it, by
// design - see game.js's _startAgent3Celebration), so the platform is safe
// to butt right up against the goal with no special-cased collision check
// needed at that point.
function carveCargoAndEmptySide(grid, width, height, line, cargoList, platformList, rng) {
  const n = line.cells.length;
  const perpPair = line.horizontal ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  const side = rng() < 0.5 ? perpPair[0] : perpPair[1];
  const otherSide = side === perpPair[0] ? perpPair[1] : perpPair[0];
  const [pdx, pdy] = side;
  const [odx, ody] = otherSide;
  // Remembered on the line (and copied onto every goal it produces) so the
  // post-solve celebration knows which way is "the open entrance side" to
  // roll the finished line toward - see agent4GenerateMap and
  // game.js's _startAgent3Celebration.
  line.openDir = { dx: odx, dy: ody };

  const maxCargo = Math.floor(n / 2);
  const cargoCount = maxCargo > 0 ? 1 + Math.floor(rng() * maxCargo) : 0;
  const cargoIdxs = pickCenteredCargoIndices(n, cargoCount, rng);
  const kind = rng() < 0.5 ? 0 : 1;
  line.kind = kind;

  for (let i = 0; i < n; i++) {
    const cell = line.cells[i];
    grid[cell.fy][cell.fx] = true; // goal cell itself is always walkable

    const ex = cell.fx + odx, ey = cell.fy + ody;
    if (inBounds(ex, ey, width, height)) {
      if (kind === 1) {
        grid[ey][ex] = false; // blue line: entrance side becomes a solid platform
        platformList.push({ bx: ex, by: ey, groupId: line.groupId });
        // Platform runs two cells deep, not one - the extra cell gives the
        // finish celebration's dropped crate somewhere to land beyond the
        // racer's own reach (see game.js's blue-cargo drop-and-tip animation).
        const ex2 = ex + odx, ey2 = ey + ody;
        if (inBounds(ex2, ey2, width, height)) {
          grid[ey2][ex2] = false;
          platformList.push({ bx: ex2, by: ey2, groupId: line.groupId });
        }
      } else {
        grid[ey][ex] = true; // yellow line: entrance side stays clear approach ground
      }
    }

    const wx = cell.fx + pdx, wy = cell.fy + pdy;
    if (!inBounds(wx, wy, width, height)) continue;
    grid[wy][wx] = false; // cargo-side edge, forced closed (crate or plain wall)
    if (cargoIdxs.has(i)) {
      // goalBx/goalBy: the specific goal cell this crate sits beside, so the
      // celebration can drag exactly this crate along when that cell's
      // racer rolls out of it.
      cargoList.push({ bx: wx, by: wy, groupId: line.groupId, kind, goalBx: cell.fx, goalBy: cell.fy });
      const fx2 = wx + pdx, fy2 = wy + pdy;
      if (inBounds(fx2, fy2, width, height)) grid[fy2][fx2] = false; // behind the crate, forced closed
    }
  }
}

function isSingleComponent(grid, width, height, openCells) {
  if (!openCells.length) return false;
  const key = (x, y) => y * width + x;
  const seen = new Set([key(openCells[0].fx, openCells[0].fy)]);
  const queue = [openCells[0]];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const [dx, dy] of DIRS) {
      const nx = cur.fx + dx, ny = cur.fy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || !grid[ny][nx]) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ fx: nx, fy: ny });
    }
  }
  return seen.size === openCells.length;
}

// Groups 4-connected closed cells into wall components for rendering, the
// same way generateObstacleGrid does internally - but skipping cargo cells
// and platform cells, which are rendered separately (smaller tinted crates,
// full-height flat "platforms") rather than as full-size generic wall boxes.
function computeObstacleComponents(grid, width, height, cargoSet, platformSet) {
  const seen = new Set();
  const components = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const k = `${x},${y}`;
      if (grid[y][x] || seen.has(k) || cargoSet.has(k) || platformSet.has(k)) continue;
      const component = [];
      const queue = [{ x, y }];
      seen.add(k);
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head];
        component.push(cur);
        for (const [dx, dy] of DIRS) {
          const nx = cur.x + dx, ny = cur.y + dy;
          const nk = `${nx},${ny}`;
          if (nx <= 0 || ny <= 0 || nx >= width - 1 || ny >= height - 1 || grid[ny][nx] || seen.has(nk) || cargoSet.has(nk) || platformSet.has(nk)) continue;
          seen.add(nk);
          queue.push({ x: nx, y: ny });
        }
      }
      components.push(component);
    }
  }
  return components;
}

// Builds a full agent4 map: a connected base obstacle field (reusing the
// same generator every other strategy uses) with `taskCount` separate goal
// lines carved in, one per task, each an odd length (3 or 5 goals) with its
// cargo centered on the line, lined with one-type cargo on a random side and
// left fully open on the other, all lines kept a gap apart that's scaled to
// `baseSize` (see computeLineGap). Retries from a fresh random layout
// (re-rolling the line sizes too) until every constraint holds, including -
// critically - that the WHOLE map stays one connected region, so no racer
// can ever be sealed off from every goal.
//
// `baseSize` is the user's preferred map edge length (Game#agent4MapSize) -
// a floor, not a hard cap: neededMapSize silently grows the actual canvas
// beyond it when the requested task count needs more room than that to fit
// every line with its gap. `rng` (from Game#agent4Rng, made by
// agent4CreateRng) makes the whole thing - this map, plus every subsequent
// spawn position, robot-type assignment, and movement tie-break during play
// - fully reproducible from just (seed, baseSize, taskCount).
export function agent4GenerateMap(baseSize, taskCount, rng = Math.random) {
  const base = Math.max(4, Math.round(baseSize) || 4);
  const gap = computeLineGap(base);
  for (let attempt = 0; attempt < 60; attempt++) {
    const sizes = pickLineSizes(Math.max(1, Math.round(taskCount)), rng);
    if (!sizes.length) continue;
    const size = neededMapSize(sizes.length, base, gap);
    const grid = buildTiledGrid(size, base, rng);

    const lines = [];
    let ok = true;
    for (let gi = 0; gi < sizes.length; gi++) {
      const placed = placeOneLine(size, size, sizes[gi], lines, gap, rng);
      if (!placed) { ok = false; break; }
      placed.groupId = gi;
      lines.push(placed);
    }
    if (!ok) continue;

    const cargo = [];
    const platforms = [];
    for (const line of lines) carveCargoAndEmptySide(grid, size, size, line, cargo, platforms, rng);

    const openCells = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (grid[y][x]) openCells.push({ fx: x, fy: y });
    if (!isSingleComponent(grid, size, size, openCells)) continue;

    const cargoSet = new Set(cargo.map((c) => `${c.bx},${c.by}`));
    const platformSet = new Set(platforms.map((p) => `${p.bx},${p.by}`));
    const obstacleComponents = computeObstacleComponents(grid, size, size, cargoSet, platformSet);
    const blockOpen = (x, y) => inBounds(x, y, size, size) && grid[y][x];

    const goals = [];
    for (const line of lines) for (const c of line.cells) goals.push({ bx: c.fx, by: c.fy, groupId: line.groupId, openDir: line.openDir });

    return { blocksX: size, blocksY: size, blockOpen, openCells, obstacleComponents, goals, cargo, platforms };
  }
  throw new Error('agent4: failed to generate a valid goal-line layout after many attempts');
}

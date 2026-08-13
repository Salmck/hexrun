// Agent mode 4 - a variant of agent mode 2's swarm brain (shared vision,
// blind exploration, A*-to-goal, BFS chain-yield) run against a very
// different map: instead of one scattered goal cluster, the map carries
// several separate GOAL LINES, one per "task" (straight runs of an ODD
// length - 3 or 5 goals), each lined on one side with cargo crates (an
// obstacle, one type per line, centred on the line - see
// pickCenteredCargoIndices) and left completely open on the other side.
// Every line's exact centre goal is a type-B slot, every other goal on it
// is type-A - see the slotType field agent4GenerateMap puts on each goal
// and how agent4ChooseMove uses it. Goal lines are kept well apart so
// carving cargo into the base maze can never wall two of them together.
//
// The one real behavioural difference from agent2: with several separate
// lines, a racer's nearest KNOWN goal can legitimately be a line that has
// already filled up entirely while a different, not-yet-sensed line still
// has room. So target selection here only ever routes toward a known goal
// that is currently FREE; if every known goal is taken, it does NOT fall
// back to fighting a full line (agent2 does) - it keeps exploring instead,
// which is guaranteed to eventually turn up a line with room, since total
// goals always equal the racer count.
//
// These are free functions taking the Game instance as `game`, exactly like
// agent2.js; game.js keeps only the thin hooks that call into here.

import { findPath, generateObstacleGrid } from './maze.js?v=25';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Goal lines must stay at least this many cells apart (Manhattan, nearest
// cell to nearest cell) so carving cargo and the open side into the base
// maze around one line can never reach into another line's territory, and
// so the endgame's per-line congestion never bleeds across lines.
const MIN_LINE_GAP = 10;
const MAX_MAP_SIZE = 61;

// --------------------------------------------------------------------------
// Shared state + vision (identical shape to agent2's, kept in separate
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

  const pool = DIRS
    .map(([dx, dy]) => ({ fx: racer.bx + dx, fy: racer.by + dy }))
    .filter((cell) => game._mapCellAvailable(cell.fx, cell.fy, racer));

  // A racer just force-yielded out of its own slot (see agent4ForceYield)
  // stays off it for a few ticks rather than immediately routing straight
  // back in. Without this, a racer with no alternate slot to retreat to -
  // the type-B centre slot has no sibling to swap into, unlike type-A's
  // several per line - would dash back the instant it's evicted, racing
  // whoever displaced it for the same cell and often winning, which turns
  // one crossing attempt into a permanent back-and-forth instead of the
  // brief, one-time detour it's meant to be.
  if ((racer._yieldCooldown || 0) > 0) {
    racer._yieldCooldown -= 1;
    if (pool.length) return agent4ExploreStep(game, racer, pool);
  }

  // Every line has exactly one type-B slot (its centre goal - see
  // agent4GenerateMap) and the rest are type-A slots. A racer only ever
  // treats a goal as "arrived" if its own robotType matches that goal's
  // slotType, so a type-A racer can walk straight through the centre goal
  // of a line without mistakenly stopping there, and vice versa.
  const ownGoalAt = (x, y) => game.mapGoals.find((g) => g.bx === x && g.by === y && g.slotType === racer.robotType);
  const adjGoal = pool.find((cell) => ownGoalAt(cell.fx, cell.fy));
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
    return cands[Math.floor(Math.random() * cands.length)];
  }

  // Only a goal matching this racer's own robotType is ever a usable
  // target - a type-A racer never routes toward a line's centre (type-B)
  // slot, and a type-B racer never routes toward anything but a centre
  // slot. Combined with there being exactly one type-B racer per line (see
  // game.js's per-setup assignment), this is what actually makes each line
  // end up with exactly one type-B occupant - it's not just a population
  // count coincidence.
  const knownGoals = game.mapGoals.filter((g) =>
    g.slotType === racer.robotType && game.agent4Sensed.has(`${g.bx},${g.by}`));
  const isTaken = (g) => game.mapRacers.some(
    (o) => o !== racer && o.status === 'reached' && o.bx === g.bx && o.by === g.by);
  // Only a goal that is both known AND currently free is a usable target.
  // With several separate lines, "nearest known" can easily be a line that
  // filled up while a farther, unsensed line still has room - routing there
  // anyway (agent2's fallback) would mean permanently fighting a full line.
  // Total goals == racer count always, so while this racer hasn't reached
  // one yet, some goal somewhere is free; if none of the KNOWN ones are,
  // exploring is guaranteed to eventually turn one up.
  const freeKnownGoals = knownGoals.filter((g) => !isTaken(g));

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
      return cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
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
    return cands[Math.floor(Math.random() * cands.length)];
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

  return pool[Math.floor(Math.random() * pool.length)];
}

// BFS chain-yield within one goal line's 4-connected run (lines are >=10
// apart, so this can never reach across into a different line). Identical
// mechanics to agent2's version - see js/agent2.js for the full rationale,
// with one addition: the search can walk across ANY goal in the line (not
// just `parked`'s own slot type - restricting that too would refuse most
// ordinary same-type shuffles too, any time the shortest chain happens to
// pass a slot of the other type along the way), but each link in the found
// chain is only actually taken if the cell that racer would slide into is
// a slot its own type is allowed to settle on - so a chain that would
// require bumping some racer onto the line's other type of slot is
// rejected outright rather than executed.
function agent4ChainYield(game, parked) {
  const goalAt = (x, y) => game.mapGoals.some((g) => g.bx === x && g.by === y);
  const racerOn = (x, y) => game.mapRacers.find((r) => r.bx === x && r.by === y);
  const slotTypeAt = (x, y) => game.mapGoals.find((g) => g.bx === x && g.by === y)?.slotType;

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
    if (slotTypeAt(chain[i + 1].bx, chain[i + 1].by) !== r.robotType) return false;
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
// mid-animation), or - the case that matters most here - when there's no
// alternate same-type slot for chain-yield to shuffle `parked` into at all
// (always true for a type-B racer, since its line has only the one centre
// slot). Recurses through whoever is blocking `parked`'s own neighbours
// first if none of them is immediately free, which becomes the common case
// once a line is mostly full - by then every neighbour is likely occupied
// by some OTHER already-reached racer too, and a version that only ever
// looked at direct neighbours would just permanently fail from that point
// on. Every racer this displaces (not just `parked` itself) gets the
// yield-cooldown stamp agent4ChooseMove reads, so none of them race back
// into place before the original crossing racer has actually gotten past.
function agent4ForceYield(game, parked, visited) {
  visited = visited || new Set();
  if (parked.shape.isBusy() || parked.pendingDir || visited.has(parked.id) || visited.size > 6) return false;
  visited.add(parked.id);
  const wasReached = parked.status === 'reached';

  const neighbors = DIRS
    .map(([dx, dy]) => ({ fx: parked.bx + dx, fy: parked.by + dy }))
    .filter((c) => game.blockGrid.blockOpen(c.fx, c.fy));

  let dest = neighbors.find((c) => !game.mapRacers.some((o) => o.bx === c.fx && o.by === c.fy));
  if (!dest) {
    for (const c of neighbors) {
      const occupant = game.mapRacers.find((o) => o.bx === c.fx && o.by === c.fy);
      // Recurse through whatever's in the way regardless of its own status -
      // a 'solving' racer sitting in the corridor is just as much a
      // temporary obstacle here as an already-'reached' one.
      if (occupant && agent4ForceYield(game, occupant, visited)) {
        dest = c;
        break;
      }
    }
  }
  if (!dest) return false;

  if (wasReached) {
    const gi = game.mapGoals.findIndex((g) => g.bx === parked.bx && g.by === parked.by);
    if (gi >= 0) game.mapGoalMarkers[gi].material.color.setHex(0x35b88a);
  }
  parked.path = null;
  parked.status = 'solving';
  parked._yieldCooldown = 8;
  game._applyMapMove(parked, dest);
  return true;
}

// --------------------------------------------------------------------------
// Map generation: several separate goal lines + one-sided cargo.
// --------------------------------------------------------------------------

// One random size (3 or 5) per line, `taskCount` lines total - the UI's
// "task count" IS the line count directly here, not something derived by
// partitioning a target racer total the way agent3 does it. Total racer
// count for the session falls out afterward as whatever the sum of these
// sizes comes to (see agent4GenerateMap's return value).
function pickLineSizes(taskCount) {
  return Array.from({ length: taskCount }, () => (Math.random() < 0.5 ? 3 : 5));
}

// A working map big enough that `lineCount` goal lines can actually find
// mutually-10-apart placements. A handful of lines fit the default size
// easily; many small lines (a high racer count split into lots of 2-runs)
// need a visibly larger map, scaled by how many roughly-10-apart slots have
// to fit on each axis.
function neededMapSize(lineCount, baseSize) {
  if (lineCount <= 4) return baseSize;
  const perAxis = Math.ceil(Math.sqrt(lineCount));
  return Math.min(MAX_MAP_SIZE, Math.max(baseSize, perAxis * MIN_LINE_GAP + 8));
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
function buildTiledGrid(canvasSize, baseSize, rng) {
  const tilesPerSide = Math.ceil(canvasSize / baseSize);
  const tiles = Array.from({ length: tilesPerSide }, () =>
    Array.from({ length: tilesPerSide }, () => generateObstacleGrid(baseSize, baseSize, rng).grid)
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
// carve cargo and the open side around it, and (b) sits at least
// MIN_LINE_GAP away from every already-placed line. Purely random trial and
// error over the whole grid - simple, and the map is generated fresh on
// failure anyway (see agent4GenerateMap), so no fancier packing is needed.
function placeOneLine(width, height, n, existingLines) {
  const margin = 2;
  for (let tries = 0; tries < 500; tries++) {
    const horizontal = Math.random() < 0.5;
    let cells;
    if (horizontal) {
      const fy = margin + Math.floor(Math.random() * Math.max(1, height - 2 * margin));
      const fxRange = width - 2 * margin - (n - 1);
      if (fxRange <= 0) continue;
      const fx = margin + Math.floor(Math.random() * fxRange);
      cells = Array.from({ length: n }, (_, i) => ({ fx: fx + i, fy }));
    } else {
      const fx = margin + Math.floor(Math.random() * Math.max(1, width - 2 * margin));
      const fyRange = height - 2 * margin - (n - 1);
      if (fyRange <= 0) continue;
      const fy = margin + Math.floor(Math.random() * fyRange);
      cells = Array.from({ length: n }, (_, i) => ({ fx, fy: fy + i }));
    }
    if (cells.some((c) => c.fx < margin || c.fx >= width - margin || c.fy < margin || c.fy >= height - margin)) continue;
    if (existingLines.some((line) => minCellDistance(line.cells, cells) < MIN_LINE_GAP)) continue;
    return { cells, horizontal };
  }
  return null;
}

function shuffleIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Picks which of a line's `n` goal indices (n always odd) get cargo, kept
// centred on the line rather than scattered anywhere along it:
// - 1 cargo sits beside the line's exact middle goal.
// - 2+ cargo: the two farthest-apart pieces are placed symmetrically about
//   the centre (how far out is randomised, anywhere from adjacent-to-centre
//   out to the line's own ends), and any remaining interior cargo is
//   scattered randomly within that centred span - so the overall footprint
//   is always centred even though the exact interior positions aren't.
function pickCenteredCargoIndices(n, cargoCount) {
  if (cargoCount <= 0) return new Set();
  const center = (n - 1) / 2; // integer - n is always odd
  if (cargoCount === 1) return new Set([center]);

  const dMin = Math.ceil((cargoCount - 1) / 2); // enough interior room for the rest
  const dMax = center; // the line's own ends
  const d = dMin + Math.floor(Math.random() * (dMax - dMin + 1));
  const idxs = new Set([center - d, center + d]);

  const interiorPool = [];
  for (let idx = center - d + 1; idx < center + d; idx++) interiorPool.push(idx);
  const picks = shuffleIndices(interiorPool.length).slice(0, cargoCount - 2);
  for (const p of picks) idxs.add(interiorPool[p]);
  return idxs;
}

// Carves one line's cargo side and open side into `grid` (mutated in place,
// true = open). The whole cargo-side edge (one cell out from every goal in
// the line) is forced closed - some of those cells become actual cargo
// crates (one type, at most floor(n/2) of them, at random positions along
// the line), the rest become plain forced wall - so the barrier reads as
// solid with crates set into it, never a stray open gap next to a crate.
// Each crate's outward-facing cell (one further out) is forced closed too,
// so no crate ever backs onto open ground either.
//
// The opposite (entrance) side is forced OPEN for a yellow line, exactly as
// before - clear approach ground. For a BLUE line it's forced CLOSED
// instead, built up into a solid, wall-height "platform" (platformList) -
// the racer never actually reaches that cell during the finish celebration
// (its blue-cargo flick only ever covers half the distance to it, by
// design - see game.js's _startAgent3Celebration), so the platform is safe
// to butt right up against the goal with no special-cased collision check
// needed at that point.
function carveCargoAndEmptySide(grid, width, height, line, cargoList, platformList) {
  const n = line.cells.length;
  const perpPair = line.horizontal ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  const side = Math.random() < 0.5 ? perpPair[0] : perpPair[1];
  const otherSide = side === perpPair[0] ? perpPair[1] : perpPair[0];
  const [pdx, pdy] = side;
  const [odx, ody] = otherSide;
  // Remembered on the line (and copied onto every goal it produces) so the
  // post-solve celebration knows which way is "the open entrance side" to
  // roll the finished line toward - see agent4GenerateMap and
  // game.js's _startAgent3Celebration.
  line.openDir = { dx: odx, dy: ody };

  const maxCargo = Math.floor(n / 2);
  const cargoCount = maxCargo > 0 ? 1 + Math.floor(Math.random() * maxCargo) : 0;
  const cargoIdxs = pickCenteredCargoIndices(n, cargoCount);
  const kind = Math.random() < 0.5 ? 0 : 1;
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
// same generator every other strategy uses) with `taskCount` separate
// straight goal lines carved in (each an odd length, 3 or 5 goals - see
// pickLineSizes), each lined with one-type cargo centred on the line and
// left fully open on the other side, all lines kept >=MIN_LINE_GAP apart.
// Unlike agent3, `taskCount` IS the number of lines directly, not a racer
// total to be partitioned - total racer count for the session is simply
// however many goals fall out of the chosen line sizes (goals.length on
// the returned object). Retries from a fresh random layout (re-rolling the
// line sizes too) until every constraint holds, including - critically -
// that the WHOLE map stays one connected region, so no racer can ever be
// sealed off from every goal.
export function agent4GenerateMap(baseSize, taskCount, rng = Math.random) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const sizes = pickLineSizes(Math.max(1, Math.round(taskCount)));
    const size = neededMapSize(sizes.length, baseSize);
    const grid = buildTiledGrid(size, baseSize, rng);

    const lines = [];
    let ok = true;
    for (let gi = 0; gi < sizes.length; gi++) {
      const placed = placeOneLine(size, size, sizes[gi], lines);
      if (!placed) { ok = false; break; }
      placed.groupId = gi;
      lines.push(placed);
    }
    if (!ok) continue;

    const cargo = [];
    const platforms = [];
    for (const line of lines) carveCargoAndEmptySide(grid, size, size, line, cargo, platforms);

    const openCells = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (grid[y][x]) openCells.push({ fx: x, fy: y });
    if (!isSingleComponent(grid, size, size, openCells)) continue;

    const cargoSet = new Set(cargo.map((c) => `${c.bx},${c.by}`));
    const platformSet = new Set(platforms.map((p) => `${p.bx},${p.by}`));
    const obstacleComponents = computeObstacleComponents(grid, size, size, cargoSet, platformSet);
    const blockOpen = (x, y) => inBounds(x, y, size, size) && grid[y][x];

    // Exactly one goal per line is the type-B slot; every other goal on
    // the line is type-A. Which one is picked at random along the line for
    // now (not pinned to the centre) - see agent4ChooseMove/agent4ChainYield
    // for how slotType keeps each robot type on its own kind of goal.
    const goals = [];
    for (const line of lines) {
      const bIdx = Math.floor(Math.random() * line.cells.length);
      line.cells.forEach((c, idx) => {
        goals.push({
          bx: c.fx, by: c.fy, groupId: line.groupId, openDir: line.openDir,
          slotType: idx === bIdx ? 'B' : 'A',
        });
      });
    }

    return { blocksX: size, blocksY: size, blockOpen, openCells, obstacleComponents, goals, cargo, platforms };
  }
  throw new Error('agent4: failed to generate a valid goal-line layout after many attempts');
}

// Agent mode 3 - a variant of agent mode 2's swarm brain (shared vision,
// blind exploration, A*-to-goal, BFS chain-yield) run against a very
// different map: instead of one scattered goal cluster, the map carries
// several separate GOAL LINES (straight runs of 2-5 goals), each lined on
// one side with cargo crates (an obstacle, one type per line) and left
// completely open on the other side. Goal lines are kept well apart so
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
// game.agent3Visited / game.agent3Sensed fields so the two modes never
// share or clobber each other's memory).
// --------------------------------------------------------------------------

export function agent3SetupState(game, starts) {
  game.agent3Visited = new Set(starts.map((s) => `${s.fx},${s.fy}`));
  game.agent3Sensed = new Set();
}

export function agent3Sense(game, racer) {
  markSensed(game, racer.bx, racer.by);
  for (const [dx, dy] of DIRS) markSensed(game, racer.bx + dx, racer.by + dy);
}

// Records one cell as newly seen and, the first time only, tells game.js to
// paint the "explored" highlight there - a per-cell flag rather than a
// per-frame redraw, so lighting up the shared map costs nothing beyond the
// one instant a cell first enters anyone's vision.
function markSensed(game, x, y) {
  const k = `${x},${y}`;
  if (game.agent3Sensed.has(k)) return;
  game.agent3Sensed.add(k);
  if (game._markMapExplored) game._markMapExplored(x, y);
}

// --------------------------------------------------------------------------
// Movement AI
// --------------------------------------------------------------------------

export function agent3ChooseMove(game, racer) {
  agent3Sense(game, racer);

  const pool = DIRS
    .map(([dx, dy]) => ({ fx: racer.bx + dx, fy: racer.by + dy }))
    .filter((cell) => game._mapCellAvailable(cell.fx, cell.fy, racer));

  const adjGoal = pool.find((cell) => game._isMapGoal(cell.fx, cell.fy));
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

  const knownGoals = game.mapGoals.filter((g) => game.agent3Sensed.has(`${g.bx},${g.by}`));
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
      if (!game.agent3Sensed.has(`${x},${y}`) || !game.blockGrid.blockOpen(x, y)) return false;
      const occ = game.mapRacers.find((o) => o !== racer && o.status === 'reached' && o.bx === x && o.by === y);
      if (!occ) return true;
      const occGoal = game.mapGoals.find((g) => g.bx === x && g.by === y);
      return !occGoal || occGoal.groupId === target.groupId;
    };
    const route = findPath(sensedOpen, game.blockGrid.blocksX, { fx: racer.bx, fy: racer.by }, { fx: target.bx, fy: target.by });
    if (route && route.length >= 2) {
      racer.path = route;
      racer.pathIndex = 0;
      game._updateMapPathDots(racer, route);
      const next = route[1];
      const parked = game.mapRacers.find((o) => o !== racer && o.status === 'reached' && o.bx === next.fx && o.by === next.fy);
      if (parked && !agent3ChainYield(game, parked) && (racer.idleTicks || 0) >= 3) {
        agent3ForceYield(game, parked);
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

  return agent3ExploreStep(game, racer, pool);
}

function agent3ExploreStep(game, racer, pool) {
  const fresh = pool.filter((cell) => !game.agent3Visited.has(`${cell.fx},${cell.fy}`));
  if (fresh.length) return pickTowardUnseen(game, racer, fresh);

  // Every immediate neighbour here is already-covered ground - a true local
  // dead end (or a fully-explored pocket). The greedy "most unseen around"
  // rule has nothing to prefer among already-visited cells, so left on its
  // own it just wanders the covered ground at random until luck carries it
  // back out. Instead, actively route to the nearest FRONTIER cell - open,
  // sensed ground that still has at least one unsensed neighbour, i.e. the
  // nearest actual edge of the known map - and follow that route straight
  // back out, like a proper depth-first-search backtrack.
  const route = findNearestFrontierRoute(game, racer);
  if (route && route.length >= 2) {
    const next = route[1];
    if (game._mapCellAvailable(next.fx, next.fy, racer)) return next;
  }
  // No known frontier left to route to (or it's momentarily blocked) - fall
  // back to the plain avoid-doubling-back walk over covered ground.
  return pickTowardUnseen(game, racer, pool);
}

function pickTowardUnseen(game, racer, pool) {
  if (racer.previousCell) {
    const notBack = pool.filter((cell) => cell.fx !== racer.previousCell.bx || cell.fy !== racer.previousCell.by);
    if (notBack.length) pool = notBack;
  }

  const unseenAround = (cell) => DIRS
    .filter(([dx, dy]) => !game.agent3Sensed.has(`${cell.fx + dx},${cell.fy + dy}`)).length;
  const most = Math.max(...pool.map(unseenAround));
  pool = pool.filter((cell) => unseenAround(cell) === most);

  return pool[Math.floor(Math.random() * pool.length)];
}

// BFS over sensed-open ground from the racer's own cell, stopping at the
// first cell that still has an unsensed neighbour - the nearest point where
// the shared known map actually ends - then A*-routes there over that same
// sensed ground. Cheap: only ever called once the immediate neighbourhood is
// fully covered, not on every tick.
function findNearestFrontierRoute(game, racer) {
  const sensedOpen = (x, y) => game.agent3Sensed.has(`${x},${y}`) && game.blockGrid.blockOpen(x, y);
  const isFrontier = (x, y) => DIRS.some(([dx, dy]) => !game.agent3Sensed.has(`${x + dx},${y + dy}`));
  const key = (x, y) => `${x},${y}`;
  const seen = new Set([key(racer.bx, racer.by)]);
  const queue = [{ fx: racer.bx, fy: racer.by }];
  let head = 0;
  let target = null;
  while (head < queue.length) {
    const cur = queue[head++];
    if (!(cur.fx === racer.bx && cur.fy === racer.by) && isFrontier(cur.fx, cur.fy)) { target = cur; break; }
    for (const [dx, dy] of DIRS) {
      const nx = cur.fx + dx, ny = cur.fy + dy;
      if (!sensedOpen(nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ fx: nx, fy: ny });
    }
  }
  if (!target) return null;
  return findPath(sensedOpen, game.blockGrid.blocksX, { fx: racer.bx, fy: racer.by }, target);
}

// BFS chain-yield within one goal line's 4-connected run (lines are >=10
// apart, so this can never reach across into a different line). Identical
// mechanics to agent2's version - see js/agent2.js for the full rationale.
function agent3ChainYield(game, parked) {
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
function agent3ForceYield(game, parked) {
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

// Random group sizes in [2,5] summing exactly to `total`, never leaving an
// invalid size-1 remainder. A pure random pick can walk itself into a corner
// where only 1 is left; when that happens the last pick is nudged so the
// remainder becomes 2 (or the leftover 1 is folded into the previous group)
// instead of ever emitting a line shorter than 2.
function partitionGoalCounts(total) {
  if (total <= 1) return total === 1 ? [1] : [];
  const sizes = [];
  let remaining = total;
  while (remaining >= 2) {
    const maxS = Math.min(5, remaining);
    let s = 2 + Math.floor(Math.random() * (maxS - 1));
    if (remaining - s === 1) s = s > 2 ? s - 1 : Math.min(3, maxS);
    sizes.push(s);
    remaining -= s;
  }
  if (remaining === 1) {
    if (sizes.length && sizes[sizes.length - 1] < 5) sizes[sizes.length - 1] += 1;
    else sizes.push(1);
  }
  return sizes;
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
// failure anyway (see agent3GenerateMap), so no fancier packing is needed.
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

// Carves one line's cargo side and open side into `grid` (mutated in place,
// true = open). The whole cargo-side edge (one cell out from every goal in
// the line) is forced closed - some of those cells become actual cargo
// crates (one type, at most floor(n/2) of them, at random positions along
// the line), the rest become plain forced wall - so the barrier reads as
// solid with crates set into it, never a stray open gap next to a crate.
// Each crate's outward-facing cell (one further out) is forced closed too,
// so no crate ever backs onto open ground either. The opposite side's
// immediate neighbour of every goal cell is forced OPEN, so that whole side
// is clear approach ground.
function carveCargoAndEmptySide(grid, width, height, line, cargoList) {
  const n = line.cells.length;
  const perpPair = line.horizontal ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  const side = Math.random() < 0.5 ? perpPair[0] : perpPair[1];
  const otherSide = side === perpPair[0] ? perpPair[1] : perpPair[0];
  const [pdx, pdy] = side;
  const [odx, ody] = otherSide;

  const maxCargo = Math.floor(n / 2);
  const cargoCount = maxCargo > 0 ? 1 + Math.floor(Math.random() * maxCargo) : 0;
  const cargoIdxs = new Set(shuffleIndices(n).slice(0, cargoCount));
  const kind = Math.random() < 0.5 ? 0 : 1;

  for (let i = 0; i < n; i++) {
    const cell = line.cells[i];
    grid[cell.fy][cell.fx] = true; // goal cell itself is always walkable

    const ex = cell.fx + odx, ey = cell.fy + ody;
    if (inBounds(ex, ey, width, height)) grid[ey][ex] = true; // empty side, forced open

    const wx = cell.fx + pdx, wy = cell.fy + pdy;
    if (!inBounds(wx, wy, width, height)) continue;
    grid[wy][wx] = false; // cargo-side edge, forced closed (crate or plain wall)
    if (cargoIdxs.has(i)) {
      cargoList.push({ bx: wx, by: wy, groupId: line.groupId, kind });
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
// same way generateObstacleGrid does internally - but skipping cargo cells,
// which are rendered separately as their own smaller, tinted crates rather
// than full-size generic wall boxes.
function computeObstacleComponents(grid, width, height, cargoSet) {
  const seen = new Set();
  const components = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const k = `${x},${y}`;
      if (grid[y][x] || seen.has(k) || cargoSet.has(k)) continue;
      const component = [];
      const queue = [{ x, y }];
      seen.add(k);
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head];
        component.push(cur);
        for (const [dx, dy] of DIRS) {
          const nx = cur.x + dx, ny = cur.y + dy;
          const nk = `${nx},${ny}`;
          if (nx <= 0 || ny <= 0 || nx >= width - 1 || ny >= height - 1 || grid[ny][nx] || seen.has(nk) || cargoSet.has(nk)) continue;
          seen.add(nk);
          queue.push({ x: nx, y: ny });
        }
      }
      components.push(component);
    }
  }
  return components;
}

// Builds a full agent3 map: a connected base obstacle field (reusing the
// same generator every other strategy uses) with `racerCount` goals carved
// in as several separate straight lines (2-5 goals each), each lined with
// one-type cargo on a random side and left fully open on the other, all
// lines kept >=MIN_LINE_GAP apart. Retries from a fresh random layout
// (re-rolling the line-size partition too) until every constraint holds,
// including - critically - that the WHOLE map stays one connected region,
// so no racer can ever be sealed off from every goal.
export function agent3GenerateMap(baseSize, racerCount, rng = Math.random) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const sizes = partitionGoalCounts(Math.max(0, Math.round(racerCount)));
    if (!sizes.length) continue;
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
    for (const line of lines) carveCargoAndEmptySide(grid, size, size, line, cargo);

    const openCells = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (grid[y][x]) openCells.push({ fx: x, fy: y });
    if (!isSingleComponent(grid, size, size, openCells)) continue;

    const cargoSet = new Set(cargo.map((c) => `${c.bx},${c.by}`));
    const obstacleComponents = computeObstacleComponents(grid, size, size, cargoSet);
    const blockOpen = (x, y) => inBounds(x, y, size, size) && grid[y][x];

    const goals = [];
    for (const line of lines) for (const c of line.cells) goals.push({ bx: c.fx, by: c.fy, groupId: line.groupId });

    return { blocksX: size, blocksY: size, blockOpen, openCells, obstacleComponents, goals, cargo };
  }
  throw new Error('agent3: failed to generate a valid goal-line layout after many attempts');
}

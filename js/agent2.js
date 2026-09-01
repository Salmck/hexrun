// Agent mode 2 - decoupled from game.js.
//
// Blind swarm exploration with a shared field of view: each racer explores on
// its own, one big cell (4 tumbles) per step, until any goal turns up in the
// pooled vision; then everyone heads for the cluster, A*-routing over sensed
// WALLS ONLY (no racer, moving or stopped, is ever an obstacle to the route),
// and a BFS chain-yield shuffles arrivals onto free goals. Goals are generated
// as a thin, non-enclosing cluster so every one stays reachable.
//
// These are free functions that take the Game instance as `game`; game.js
// keeps only the thin hooks (dispatch, goal generation, arrival sensing) that
// call into here, and the shared machinery they lean on: game._mapCellAvailable,
// game._isMapGoal, game._tryClearWayFor, game._updateMapPathDots,
// game._applyMapMove, plus game.mapRacers / mapGoals / mapGoalMarkers /
// blockGrid and the shared sets game.agent2Visited / agent2Sensed.

import { findPath } from './maze.js?v=26';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// --------------------------------------------------------------------------
// Shared state + vision
// --------------------------------------------------------------------------

// agent2Visited: the one common record of every cell any racer has stood on
// (so the swarm avoids retracing covered ground - "尽量不走回头路").
// agent2Sensed: the one shared field of view - every ±1 sense any racer makes
// is pooled here, so what one racer sees, all "know" ("视野共享").
export function agent2SetupState(game, starts) {
  game.agent2Visited = new Set(starts.map((s) => `${s.fx},${s.fy}`));
  game.agent2Sensed = new Set();
}

// Adds the racer's own cell and its four neighbours to the shared view.
export function agent2Sense(game, racer) {
  game.agent2Sensed.add(`${racer.bx},${racer.by}`);
  for (const [dx, dy] of DIRS) game.agent2Sensed.add(`${racer.bx + dx},${racer.by + dy}`);
}

// --------------------------------------------------------------------------
// Movement AI
// --------------------------------------------------------------------------

// One decision for one racer. Returns the next cell to step onto, or null to
// stay put this round. One returned move = one big cell.
export function agent2ChooseMove(game, racer) {
  agent2Sense(game, racer);

  // Open, unoccupied neighbouring cells it could step onto.
  const pool = DIRS
    .map(([dx, dy]) => ({ fx: racer.bx + dx, fy: racer.by + dy }))
    .filter((cell) => game._mapCellAvailable(cell.fx, cell.fy, racer));

  // Right next to a free goal? Step straight onto it and stop there.
  const adjGoal = pool.find((cell) => game._isMapGoal(cell.fx, cell.fy));
  if (adjGoal) return adjGoal;

  // Vision is shared, so a goal counts as KNOWN the moment any racer has
  // sensed it. Until at least one is known, keep exploring.
  const knownGoals = game.mapGoals.filter((g) => game.agent2Sensed.has(`${g.bx},${g.by}`));
  if (knownGoals.length) {
    // Once a goal is known, EVERY still-searching racer heads for the cluster.
    // Aim at the nearest goal NOBODY is stopped on so queuing racers spread
    // across free goals instead of all piling onto the same occupied one and
    // fighting a boxed-in occupant (which is what jammed the endgame). Only if
    // every known goal is already taken do we fall back to the nearest of them
    // and let the arrival yield sort it out.
    const isTaken = (g) => game.mapRacers.some(
      (o) => o !== racer && o.status === 'reached' && o.bx === g.bx && o.by === g.by);
    const freeGoals = knownGoals.filter((g) => !isTaken(g));
    const candidates = freeGoals.length ? freeGoals : knownGoals;
    let target = null;
    let bestD = Infinity;
    for (const g of candidates) {
      const d = Math.abs(g.bx - racer.bx) + Math.abs(g.by - racer.by);
      if (d < bestD) { bestD = d; target = g; }
    }

    // A* plans over the shared sensed map using WALLS ONLY - no racer,
    // stationary or moving, is ever treated as an obstacle, so the line is
    // never bent or held up by another object. Occupancy of the single next
    // cell is the only thing resolved locally (chain-yield for a racer stopped
    // on a goal in the way, progress-based yield for a moving one).
    const sensedOpen = (x, y) => game.agent2Sensed.has(`${x},${y}`) && game.blockGrid.blockOpen(x, y);
    const route = findPath(sensedOpen, game.blockGrid.blocksX, { fx: racer.bx, fy: racer.by }, { fx: target.bx, fy: target.by });
    if (route && route.length >= 2) {
      // Publish remaining distance so _tryClearWayFor's yield is decided by
      // PROGRESS, not id: a moving racer farther from its own goal (or just
      // exploring, path === null) steps aside for one closer to finishing.
      racer.path = route;
      racer.pathIndex = 0;
      // Draw the line and keep it up steadily, even on a round it can't
      // advance, so it doesn't blink off whenever it's momentarily blocked.
      game._updateMapPathDots(racer, route);
      const next = route[1];
      // Almost there and the goal is taken? BFS chain-yield slides the parked
      // racer (and any behind it) along to the nearest empty goal, freeing this
      // cell for the arriver.
      const parked = game.mapRacers.find((o) => o !== racer && o.status === 'reached' && o.bx === next.fx && o.by === next.fy);
      if (parked && !agent2ChainYield(game, parked) && (racer.idleTicks || 0) >= 3) {
        // Chain-yield couldn't slide it cleanly this round (a link in the chain
        // is mid-animation) and the arriver has already waited a few rounds -
        // so bump the occupant off directly instead of letting the wait build
        // up until the scatter kicks the arriver into a retreat/return
        // oscillation. The bumped racer re-plans straight back onto a free goal.
        agent2ForceYield(game, parked);
      }
      // A racer on a live route NEVER scatters: it keeps its path (and thus its
      // finishing priority) and leans on _tryClearWayFor to shuffle whoever
      // holds the next cell out of the way - force-vacating a chain of solvers
      // if need be, even when every immediate neighbour is occupied. It only
      // WAITS (line stays up) when a racer even closer to finishing legitimately
      // holds the cell this round, advancing the moment that clears. So a
      // frontrunner wedged at the mouth of the goal cluster keeps pressing in
      // instead of abandoning its route and drifting backward on a scatter.
      if (game._tryClearWayFor(racer, next)) return next;
      return null;
    }
    // Target not reachable over sensed ground yet - keep exploring to open it
    // up (no route, so no line to show).
  }
  // Not following a route this round (still exploring, or the target can't be
  // reached over sensed ground yet). Drop any stale route so this racer counts
  // as lowest priority and yields to racers that ARE finishing.
  racer.path = null;
  game._updateMapPathDots(racer, null);
  if (!pool.length) return null;

  // Deadlock breaker for the EXPLORATION phase only. A racer with no usable
  // route to a goal that has been wedged for a long stretch random-walks a
  // handful of steps to shake the configuration loose, then re-plans. Racers
  // that DO have a route break jams through the yield above instead, so this
  // never derails one that was about to finish.
  if ((racer.idleTicks || 0) > 20) { racer.scatterSteps = 6; racer.idleTicks = 0; }
  if ((racer.scatterSteps || 0) > 0) {
    racer.scatterSteps -= 1;
    const fwd = pool.filter((c) => !racer.previousCell || c.fx !== racer.previousCell.bx || c.fy !== racer.previousCell.by);
    const cands = fwd.length ? fwd : pool;
    return cands[Math.floor(Math.random() * cands.length)];
  }

  return agent2ExploreStep(game, racer, pool);
}

// One blind-exploration step: prefer ground nobody has stood on (shared
// visited), don't immediately double back, and head toward the least-seen
// direction so the shared map keeps growing outward.
function agent2ExploreStep(game, racer, pool) {
  const fresh = pool.filter((cell) => !game.agent2Visited.has(`${cell.fx},${cell.fy}`));
  if (fresh.length) pool = fresh;

  if (racer.previousCell) {
    const notBack = pool.filter((cell) => cell.fx !== racer.previousCell.bx || cell.fy !== racer.previousCell.by);
    if (notBack.length) pool = notBack;
  }

  const unseenAround = (cell) => DIRS
    .filter(([dx, dy]) => !game.agent2Sensed.has(`${cell.fx + dx},${cell.fy + dy}`)).length;
  const most = Math.max(...pool.map(unseenAround));
  pool = pool.filter((cell) => unseenAround(cell) === most);

  return pool[Math.floor(Math.random() * pool.length)];
}

// Endgame BFS chain-yield ("连锁让位"). When an arriving racer wants the goal
// `parked` is stopped on, `parked` slides one cell to an adjacent goal; if that
// goal is taken too its occupant slides on in turn - a BFS across the
// 4-connected goal cluster ending at the nearest goal nobody stands on, freeing
// the cell the arriver needs. Every shifted racer stays 'reached' (it only hops
// goal->adjacent goal and re-settles at once), so the cluster shuffles over by
// one. Returns true if parked's cell was freed.
function agent2ChainYield(game, parked) {
  const goalAt = (x, y) => game.mapGoals.some((g) => g.bx === x && g.by === y);
  const racerOn = (x, y) => game.mapRacers.find((r) => r.bx === x && r.by === y);

  // BFS over goal cells from parked's cell to the nearest goal nobody is on.
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

  // Reconstruct the chain: chain[0] = parked's cell, chain[last] = free goal.
  const chain = [];
  for (let c = free; c; c = prev.get(`${c.bx},${c.by}`)) chain.push(c);
  chain.reverse();

  // Every racer that must slide has to be a settled racer standing still.
  for (let i = 0; i < chain.length - 1; i++) {
    const r = racerOn(chain[i].bx, chain[i].by);
    if (!r || r.status !== 'reached' || r.shape.isBusy() || r.pendingDir) return false;
  }

  // Slide from the free end backward so each target cell is empty in turn.
  for (let i = chain.length - 2; i >= 0; i--) {
    const r = racerOn(chain[i].bx, chain[i].by);
    r.path = null;
    game._applyMapMove(r, { fx: chain[i + 1].bx, fy: chain[i + 1].by });
  }
  // chain[0] is now empty - reset its marker to neutral until someone lands.
  const gi = game.mapGoals.findIndex((g) => g.bx === chain[0].bx && g.by === chain[0].by);
  if (gi >= 0) game.mapGoalMarkers[gi].material.color.setHex(0x35b88a);
  return true;
}

// Last-resort yield when the clean chain-yield can't run (a link is
// mid-animation). Bumps `parked` straight off its goal into any free
// neighbour so the waiting arriver can take the cell now instead of livelocking
// into a retreat. `parked` becomes a free solver again and re-plans back onto a
// free goal (re-settling the moment it lands on one). Returns true if it moved.
function agent2ForceYield(game, parked) {
  if (parked.shape.isBusy() || parked.pendingDir) return false;
  const dest = DIRS
    .map(([dx, dy]) => ({ fx: parked.bx + dx, fy: parked.by + dy }))
    .find((c) => game._mapCellAvailable(c.fx, c.fy, parked));
  if (!dest) return false; // fully boxed in - nothing to do, arriver waits
  // Release its goal: neutral marker, back to solving so it heads for a free one.
  const gi = game.mapGoals.findIndex((g) => g.bx === parked.bx && g.by === parked.by);
  if (gi >= 0) game.mapGoalMarkers[gi].material.color.setHex(0x35b88a);
  parked.path = null;
  parked.status = 'solving';
  game._applyMapMove(parked, dest);
  return true;
}

// --------------------------------------------------------------------------
// Goal generation
// --------------------------------------------------------------------------

// Count goals with NO open, non-goal neighbour - i.e. fully walled in by walls
// and other goals. Such a goal can't be reached without crossing another, so
// once its neighbours fill it becomes unreachable and the endgame deadlocks.
// Convergence is reliable exactly when this is zero.
function countEnclosedGoals(game, goals) {
  const gs = new Set(goals.map((g) => `${g.fx},${g.fy}`));
  return goals.filter((g) => !DIRS.some(([dx, dy]) => {
    const nx = g.fx + dx, ny = g.fy + dy;
    return game.blockGrid.blockOpen(nx, ny) && !gs.has(`${nx},${ny}`);
  })).length;
}

// Grow N clustered goals, retrying from fresh random seeds until the layout has
// zero enclosed goals (every goal reachable from the surrounding open map
// without crossing another). The maze is far larger than the handful of goals,
// so a valid thin cluster almost always turns up in a few tries; the best-so-far
// is kept as a fallback in the rare case none is perfect.
export function pickScatteredGoals(game, openCells, count) {
  let best = null, bestEnclosed = Infinity;
  for (let attempt = 0; attempt < 80; attempt++) {
    const goals = growGoalCluster(openCells, count);
    if (goals.length < count) continue;
    const enclosed = countEnclosedGoals(game, goals);
    if (enclosed === 0) return goals;
    if (enclosed < bestEnclosed) { bestEnclosed = enclosed; best = goals; }
  }
  return best || growGoalCluster(openCells, count);
}

// N goals clustered together (4-connected) but deliberately NOT a solid blob.
// Start from one goal and grow one 4-adjacent cell at a time, refusing any cell
// that would leave some goal (or the new cell itself) fully surrounded by other
// goals. Keeping every goal with at least one open non-goal neighbour means
// each is reachable from the open map around the cluster without crossing
// another goal - so the last racers can always fill even the innermost goal.
function growGoalCluster(openCells, count) {
  const goals = [];
  const goalSet = new Set();
  const openSet = new Set(openCells.map((c) => `${c.fx},${c.fy}`));
  if (openCells.length === 0) return goals;

  const nbrKeys = (x, y) => DIRS.map(([dx, dy]) => `${x + dx},${y + dy}`);
  // Would adding `cellKey` keep every affected goal (and cellKey itself) with
  // at least one open, non-goal neighbour?
  const keepsSideAccess = (cellKey) => {
    const prospective = new Set(goalSet);
    prospective.add(cellKey);
    const hasFreeNbr = (k) => {
      const [x, y] = k.split(',').map(Number);
      return nbrKeys(x, y).some((nk) => openSet.has(nk) && !prospective.has(nk));
    };
    if (!hasFreeNbr(cellKey)) return false;
    const [cx, cy] = cellKey.split(',').map(Number);
    for (const nk of nbrKeys(cx, cy)) {
      if (goalSet.has(nk) && !hasFreeNbr(nk)) return false;
    }
    return true;
  };

  const first = openCells[Math.floor(Math.random() * openCells.length)];
  goals.push(first);
  goalSet.add(`${first.fx},${first.fy}`);

  const goalNbrCount = (cellKey) => {
    const [x, y] = cellKey.split(',').map(Number);
    return nbrKeys(x, y).filter((nk) => goalSet.has(nk)).length;
  };

  for (let i = 1; i < count; i++) {
    const adjacent = new Set();
    for (const goal of goals) {
      for (const nk of nbrKeys(goal.fx, goal.fy)) {
        if (openSet.has(nk) && !goalSet.has(nk)) adjacent.add(nk);
      }
    }
    // Grow like a thin snake, not a blob: among cells that keep every goal
    // side-accessible, always pick one touching the FEWEST existing goals (a
    // pure 1-neighbour tip extension), which keeps the shape a line/branch -
    // clustered ("挨在一起") but never enclosing.
    let pool = [...adjacent].filter(keepsSideAccess);
    if (!pool.length) pool = [...adjacent];
    if (pool.length) {
      const minTouch = Math.min(...pool.map(goalNbrCount));
      pool = pool.filter((k) => goalNbrCount(k) === minTouch);
    }
    if (!pool.length) {
      for (const k of openSet) if (!goalSet.has(k)) pool.push(k);
    }
    if (!pool.length) break;

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const [fx, fy] = chosen.split(',').map(Number);
    goals.push({ fx, fy });
    goalSet.add(chosen);
  }

  return goals;
}

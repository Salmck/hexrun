// Maze generation, fine-grid conversion, and A* pathfinding for map mode.
//
// The maze is generated on a coarse room grid (randomized depth-first
// "recursive backtracker", producing a perfect maze - exactly one path
// between any two rooms). Each room and each passage between adjacent
// rooms is then expanded into a RATIO x RATIO block of "fine" cells,
// where one fine cell equals one of the rolling shape's actual double-
// tumble steps. That's what guarantees every corridor is a uniform
// RATIO-cells wide, not just one cell with occasional pinch points.

export function generateMaze(coarseW, coarseH, rng = Math.random) {
  const visited = Array.from({ length: coarseH }, () => new Array(coarseW).fill(false));
  const hOpen = Array.from({ length: coarseH }, () => new Array(coarseW - 1).fill(false));
  const vOpen = Array.from({ length: coarseH - 1 }, () => new Array(coarseW).fill(false));

  const stack = [[0, 0]];
  visited[0][0] = true;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const neighbors = [];
    if (cx > 0 && !visited[cy][cx - 1]) neighbors.push(['W', cx - 1, cy]);
    if (cx < coarseW - 1 && !visited[cy][cx + 1]) neighbors.push(['E', cx + 1, cy]);
    if (cy > 0 && !visited[cy - 1][cx]) neighbors.push(['N', cx, cy - 1]);
    if (cy < coarseH - 1 && !visited[cy + 1][cx]) neighbors.push(['S', cx, cy + 1]);
    if (neighbors.length === 0) {
      stack.pop();
      continue;
    }
    const [dir, nx, ny] = neighbors[Math.floor(rng() * neighbors.length)];
    if (dir === 'E') hOpen[cy][cx] = true;
    if (dir === 'W') hOpen[cy][nx] = true;
    if (dir === 'S') vOpen[cy][cx] = true;
    if (dir === 'N') vOpen[ny][cx] = true;
    visited[ny][nx] = true;
    stack.push([nx, ny]);
  }
  return { coarseW, coarseH, hOpen, vOpen };
}

export function buildFineGrid(maze, ratio) {
  const { coarseW, coarseH, hOpen, vOpen } = maze;
  const blocksX = 2 * coarseW - 1;
  const blocksY = 2 * coarseH - 1;
  const fineW = blocksX * ratio;
  const fineH = blocksY * ratio;

  function blockOpen(bx, by) {
    if (bx < 0 || by < 0 || bx >= blocksX || by >= blocksY) return false;
    const bxEven = bx % 2 === 0;
    const byEven = by % 2 === 0;
    if (bxEven && byEven) return true; // room
    if (!bxEven && byEven) {
      const rx = (bx - 1) / 2, ry = by / 2;
      return hOpen[ry][rx]; // horizontal passage
    }
    if (bxEven && !byEven) {
      const rx = bx / 2, ry = (by - 1) / 2;
      return vOpen[ry][rx]; // vertical passage
    }
    return false; // diagonal corner between four rooms - always a wall
  }

  function fineOpen(fx, fy) {
    if (fx < 0 || fy < 0 || fx >= fineW || fy >= fineH) return false;
    return blockOpen(Math.floor(fx / ratio), Math.floor(fy / ratio));
  }

  function roomCenter(rx, ry) {
    return {
      fx: 2 * rx * ratio + Math.floor(ratio / 2),
      fy: 2 * ry * ratio + Math.floor(ratio / 2),
    };
  }

  return { fineW, fineH, ratio, fineOpen, roomCenter, blocksX, blocksY, blockOpen };
}

export function findPath(fineOpen, fineW, start, goal) {
  const key = (x, y) => y * fineW + x;
  const heuristic = (x, y) => Math.abs(x - goal.fx) + Math.abs(y - goal.fy);
  const gScore = new Map();
  const cameFrom = new Map();
  const startKey = key(start.fx, start.fy);
  gScore.set(startKey, 0);
  const open = new Map();
  open.set(startKey, heuristic(start.fx, start.fy));
  const closed = new Set();

  while (open.size) {
    let curKey = null, curF = Infinity;
    for (const [k, f] of open) {
      if (f < curF) { curF = f; curKey = k; }
    }
    const cx = curKey % fineW, cy = Math.floor(curKey / fineW);
    if (cx === goal.fx && cy === goal.fy) {
      const path = [{ fx: cx, fy: cy }];
      let k = curKey;
      while (cameFrom.has(k)) {
        k = cameFrom.get(k);
        path.push({ fx: k % fineW, fy: Math.floor(k / fineW) });
      }
      path.reverse();
      return path;
    }
    open.delete(curKey);
    closed.add(curKey);

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!fineOpen(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentativeG = gScore.get(curKey) + 1;
      if (!gScore.has(nk) || tentativeG < gScore.get(nk)) {
        gScore.set(nk, tentativeG);
        cameFrom.set(nk, curKey);
        open.set(nk, tentativeG + heuristic(nx, ny));
      }
    }
  }
  return null;
}

// Breadth-first search returning the single cell farthest (in steps) from
// `start`. Calling this twice - once from an arbitrary room, once from the
// result - gives a good approximation of the maze's two most distant
// points, which makes for a more interesting start/goal pair than two
// arbitrary corners.
export function bfsFarthest(fineOpen, fineW, start) {
  const dist = new Map();
  const key = (x, y) => y * fineW + x;
  dist.set(key(start.fx, start.fy), 0);
  const queue = [start];
  let head = 0;
  let farthest = start, maxDist = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(key(cur.fx, cur.fy));
    if (d > maxDist) { maxDist = d; farthest = cur; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.fx + dx, ny = cur.fy + dy;
      if (!fineOpen(nx, ny)) continue;
      const nk = key(nx, ny);
      if (dist.has(nk)) continue;
      dist.set(nk, d + 1);
      queue.push({ fx: nx, fy: ny });
    }
  }
  return { point: farthest, dist: maxDist };
}

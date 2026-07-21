// Maze generation, block-grid connectivity, and A* pathfinding for map mode.
//
// The maze is generated on a coarse room grid (randomized depth-first
// "recursive backtracker", producing a perfect maze - exactly one path
// between any two rooms). Rooms and the passages between adjacent rooms
// are addressed on a single doubled "block" grid (blockOpen), where every
// other row/column is a passage slot that's open only if the recursive
// backtracker carved it, and diagonal corner blocks between four rooms are
// always closed. The rolling shape moves one block per logical step - it
// only ever rests at a block's true center, never partway across one.

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

export function buildBlockGrid(maze) {
  const { coarseW, coarseH, hOpen, vOpen } = maze;
  const blocksX = 2 * coarseW - 1;
  const blocksY = 2 * coarseH - 1;

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

  return { blocksX, blocksY, blockOpen };
}

export function findPath(isOpen, gridW, start, goal) {
  const key = (x, y) => y * gridW + x;
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
    const cx = curKey % gridW, cy = Math.floor(curKey / gridW);
    if (cx === goal.fx && cy === goal.fy) {
      const path = [{ fx: cx, fy: cy }];
      let k = curKey;
      while (cameFrom.has(k)) {
        k = cameFrom.get(k);
        path.push({ fx: k % gridW, fy: Math.floor(k / gridW) });
      }
      path.reverse();
      return path;
    }
    open.delete(curKey);
    closed.add(curKey);

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!isOpen(nx, ny)) continue;
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
export function bfsFarthest(isOpen, gridW, start) {
  const dist = new Map();
  const key = (x, y) => y * gridW + x;
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
      if (!isOpen(nx, ny)) continue;
      const nk = key(nx, ny);
      if (dist.has(nk)) continue;
      dist.set(nk, d + 1);
      queue.push({ fx: nx, fy: ny });
    }
  }
  return { point: farthest, dist: maxDist };
}

// Builds a large obstacle field with loops and alternate routes rather than
// a perfect maze. Random wall segments create structure, then only the
// largest connected open component is kept so every selected start can reach
// the shared goal.
export function generateObstacleGrid(width, height, rng = Math.random, obstacleProbability = 0.32) {
  const key = (x, y) => y * width + x;
  for (let attempt = 0; attempt < 300; attempt++) {
    // Phase 1: the map-sized 2D array. true = open, false = obstacle point.
    const grid = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
        return rng() >= obstacleProbability;
      })
    );

    const openCells = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (grid[y][x]) openCells.push({ fx: x, fy: y });
    }
    if (!openCells.length) continue;

    // Require every open point to belong to one connected walkable region.
    const openSeen = new Set([key(openCells[0].fx, openCells[0].fy)]);
    const openQueue = [{ x: openCells[0].fx, y: openCells[0].fy }];
    for (let head = 0; head < openQueue.length; head++) {
      const cur = openQueue[head];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
        const nk = key(nx, ny);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !grid[ny][nx] || openSeen.has(nk)) continue;
        openSeen.add(nk);
        openQueue.push({ x: nx, y: ny });
      }
    }
    if (openSeen.size !== openCells.length) continue;

    // Phase 2: group four-directionally adjacent obstacle points. Each group
    // becomes one orthogonal wall-enclosed island in the 3D/2D map.
    const obstacleSeen = new Set();
    const obstacleComponents = [];
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const startKey = key(x, y);
        if (grid[y][x] || obstacleSeen.has(startKey)) continue;
        const component = [];
        const queue = [{ x, y }];
        obstacleSeen.add(startKey);
        for (let head = 0; head < queue.length; head++) {
          const cur = queue[head];
          component.push(cur);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cur.x + dx, ny = cur.y + dy;
            const nk = key(nx, ny);
            if (nx <= 0 || ny <= 0 || nx >= width - 1 || ny >= height - 1 || grid[ny][nx] || obstacleSeen.has(nk)) continue;
            obstacleSeen.add(nk);
            queue.push({ x: nx, y: ny });
          }
        }
        obstacleComponents.push(component);
      }
    }
    const blockedCount = width * height - openCells.length;
    if (obstacleComponents.length < 14 || blockedCount < width * height * 0.16) continue;

    const blockOpen = (x, y) => x >= 0 && y >= 0 && x < width && y < height && grid[y][x];
    return { blocksX: width, blocksY: height, grid, blockOpen, openCells, obstacleComponents };
  }
  throw new Error('Unable to generate a connected probability obstacle map');
}

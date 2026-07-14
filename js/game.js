import * as THREE from 'three';
import { buildRhombicuboctahedron, buildMesh } from './geometry.js';
import { RollingShape } from './roller.js';
import { generateMaze, buildBlockGrid, findPath, bfsFarthest } from './maze.js';
import { Renderer2D } from './renderer2d.js';

const FORWARD = new THREE.Vector3(0, 0, -1);
const BACKWARD = new THREE.Vector3(0, 0, 1);
const LEFT = new THREE.Vector3(-1, 0, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const PITCH_AXIS = new THREE.Vector3(1, 0, 0);

// fx/fy deltas for each move kind, shared by manual input validation and
// by the auto A* stepper in map mode.
const MAP_DIR_DELTAS = {
  forward: { dx: 0, dy: -1, vec: FORWARD },
  back: { dx: 0, dy: 1, vec: BACKWARD },
  left: { dx: -1, dy: 0, vec: LEFT },
  right: { dx: 1, dy: 0, vec: RIGHT },
};

const SPEED_PRESETS = {
  slow: { tumbleDuration: 400, pauseBetween: 100, moveGap: 300 },
  normal: { tumbleDuration: 260, pauseBetween: 60, moveGap: 150 },
  fast: { tumbleDuration: 150, pauseBetween: 30, moveGap: 60 },
};

const LANES = [-1, 0, 1];
// A curated "caution" family (warm, saturated) so obstacles always pop
// against both the pastel shape and the light road, instead of a
// narrow-hue random HSL that read as muddy on a dark background.
const OBSTACLE_COLORS = [0xe8604f, 0xf0a03c, 0xd94f7a];
const OBSTACLE_CHANCE = 0.6;
const SAFE_START_ROWS = 4;
const GEN_BATCH = 30;
const MIN_OBSTACLE_EDGE_GAP = 4; // obstacles kept >= 4 edge-lengths apart

// Each maze room/passage is expanded into MAZE_RATIO x MAZE_RATIO movement
// cells, so every corridor is MAZE_RATIO steps wide - at MAZE_RATIO=2 that's
// 2x the forward step, i.e. 4 edge-lengths, since one step is always
// exactly 2 edge-lengths.
const MAZE_COARSE_SIZE = 5;
const MAZE_RATIO = 2;

const CAMERA_RADIUS_MIN = 7;
const CAMERA_RADIUS_MAX = 140;
const CAMERA_RADIUS_DEFAULT = 25;
const CAMERA_ELEVATION_DEFAULT = 0.5; // radians above horizontal
const CAMERA_ELEVATION_MIN = 0.06; // just above ground level
const CAMERA_ELEVATION_MAX = 1.48; // near-overhead, high-angle view
const ORBIT_SPEED = 0.006;
const TILT_SPEED = 0.006;
const ZOOM_LOG_SPEED = 0.0022; // multiplicative zoom - constant feel across the whole range
const CAMERA_FOLLOW_TAU_MS = 190; // exponential smoothing time-constant
const CAMERA_DRAG_TAU_MS = 40;

export class Game {
  constructor(canvas, { onStats } = {}) {
    this.canvas = canvas;
    this.canvas2d = document.getElementById('scene2d');
    this.onStats = onStats || (() => {});
    this.running = true;
    this.mode = 'auto';
    this.gameType = 'track';
    this.view = '3d';
    this.pendingGapMs = 0;
    this.manualDir = null;

    this._setupScene();
    this._setupShape();
    this._setupCameraControls();
    this.renderer2d = this.canvas2d ? new Renderer2D(this.canvas2d, this) : null;
    this._setupTrackMode();

    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);
    this._onResize();

    this._keyHandler = (e) => this._onKeyDown(e);
    window.addEventListener('keydown', this._keyHandler);

    this._lastT = performance.now();
    this._rafId = requestAnimationFrame((t) => this._tick(t));
  }

  setSpeed(name) {
    const preset = SPEED_PRESETS[name] || SPEED_PRESETS.normal;
    this.shape.tumbleDuration = preset.tumbleDuration;
    this.shape.pauseBetween = preset.pauseBetween;
    this.moveGap = preset.moveGap;
  }

  toggle() {
    this.running = !this.running;
    return this.running;
  }

  // Swaps between the 3D WebGL view and the flat 2D top-down view. Both draw
  // the same underlying game state; only the render target changes.
  toggleView() {
    if (!this.renderer2d) return this.view;
    this.view = this.view === '3d' ? '2d' : '3d';
    const is2d = this.view === '2d';
    this.canvas.style.display = is2d ? 'none' : 'block';
    this.canvas2d.style.display = is2d ? 'block' : 'none';
    this._onResize();
    return this.view;
  }

  toggleMode() {
    this.mode = this.mode === 'auto' ? 'manual' : 'auto';
    this.pendingGapMs = 0;
    if (this.gameType === 'map' && this.mode === 'auto') this.mapPath = null;
    return this.mode;
  }

  // Switches between the endless-runner "track" mode and the maze-goal
  // "map" mode, tearing down whichever mode's scene objects are currently
  // present and building the other's fresh.
  switchGameType(type) {
    if (type === this.gameType) return this.gameType;
    if (this.gameType === 'track') this._teardownTrackMode();
    else this._teardownMapMode();

    this.gameType = type;
    this.pendingGapMs = 0;
    this.manualDir = null;

    if (type === 'track') this._setupTrackMode();
    else this._setupMapMode();

    this._camTarget.set(0, this.apothem, 0);
    this._reportStats();
    return this.gameType;
  }

  reset() {
    this.pendingGapMs = 0;
    this.manualDir = null;
    if (this.gameType === 'track') {
      this._teardownTrackMode();
      this._setupTrackMode();
    } else {
      this._teardownMapMode();
      this._setupMapMode();
    }
    this._camTarget.set(0, this.apothem, 0);
    this._reportStats();
  }

  dispose() {
    cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._resizeHandler);
    window.removeEventListener('keydown', this._keyHandler);
    this._teardownCameraControls();
    this.renderer.dispose();
  }

  _reportStats() {
    if (this.gameType === 'track') {
      this.onStats({
        gameType: 'track',
        distance: this.distance,
        dodges: this.dodges,
        mode: this.mode,
      });
    } else {
      this.onStats({
        gameType: 'map',
        steps: this.mapSteps,
        status: this.mapStatus,
        mode: this.mode,
      });
    }
  }

  _setupScene() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    // A soft daylight sky rather than a night backdrop - the previous
    // near-black background/fog and modest light levels made the whole
    // scene read as dim regardless of any one object's color.
    const skyColor = 0xdbe7f0;
    scene.background = new THREE.Color(skyColor);
    scene.fog = new THREE.Fog(skyColor, 40, 260);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 320);
    this.camera = camera;

    const hemi = new THREE.HemisphereLight(0xfff8ee, 0xaab2c0, 0.95);
    scene.add(hemi);

    // A real-time shadow map re-projected every frame from a light that
    // keeps translating with the shape produces visible swimming/flicker
    // (especially from oblique angles, where the ground fills the view).
    // Soft round "contact shadow" decals underneath the shape and each
    // obstacle look just as good here and are perfectly stable.
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
    sun.position.set(-6, 12, 8);
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    const fill = new THREE.DirectionalLight(0xcfe0ee, 0.55);
    fill.position.set(8, 6, -6);
    scene.add(fill);

    this.shadowTexture = this._createBlobShadowTexture();
  }

  _createBlobShadowTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0.5)');
    gradient.addColorStop(0.7, 'rgba(0,0,0,0.28)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  _makeBlobShadow(radius) {
    const geo = new THREE.PlaneGeometry(radius * 2, radius * 2);
    const mat = new THREE.MeshBasicMaterial({
      map: this.shadowTexture,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }

  _setupShape() {
    this.rhombi = buildRhombicuboctahedron(1.4);
    this.apothem = this.rhombi.apothem;

    const meshGroup = buildMesh(this.rhombi);
    meshGroup.position.set(0, this.apothem, 0);
    this.scene.add(meshGroup);

    this.shapeShadow = this._makeBlobShadow(this.apothem * 1.15);
    this.shapeShadow.position.set(0, 0.02, 0);
    this.scene.add(this.shapeShadow);

    this.shape = new RollingShape(this.rhombi, meshGroup);
    this.setSpeed('normal');

    this.shape.onMoveComplete = () => {
      this.pendingGapMs = this.moveGap;
    };

    // Measure the real forward step and lane width from the physics itself
    // (rather than hardcoding a value) by dry-running a couple of moves on a
    // throwaway transform. Forward/back/left/right all cover the same
    // distance per double-tumble, by the shape's symmetry.
    this.forwardStep = this._measureStep(FORWARD, 'z');
    this.laneWidth = this._measureStep(RIGHT, 'x');

    const primary = this.rhombi.faces.find((f) => f.type === 'primary');
    const v0 = this.rhombi.vertices[primary.idxs[0]];
    const v1 = this.rhombi.vertices[primary.idxs[1]];
    this.edgeLength = v0.distanceTo(v1);
    this.minObstacleRowGap = Math.max(
      1,
      Math.ceil((MIN_OBSTACLE_EDGE_GAP * this.edgeLength) / this.forwardStep)
    );
  }

  _measureStep(dir, axis) {
    const probe = {
      position: new THREE.Vector3(0, this.apothem, 0),
      quaternion: new THREE.Quaternion(),
    };
    const shape = new RollingShape(this.rhombi, probe, {
      tumbleDuration: 1,
      pauseBetween: 0,
    });
    shape.startMove(dir);
    for (let i = 0; i < 8 && shape.isBusy(); i++) shape.update(10);
    return Math.abs(probe.position[axis]);
  }

  // ---------------------------------------------------------------------
  // Track mode: endless straight run with random obstacles to dodge.
  // ---------------------------------------------------------------------

  _setupTrackMode() {
    this.distance = 0;
    this.dodges = 0;
    this.rowIndex = 0;
    this.laneIndex = 0;
    this.obstaclesByRow = new Map(); // row -> { lane, mesh, shadow }
    this.generatedUntilRow = 0;
    this.lastObstacleRow = -Infinity;

    const laneCount = LANES.length;
    // Dividers sit at +-0.5 lane-widths, so the road needs to be exactly
    // laneCount lane-widths wide for all three strips (including the two
    // outer ones) to come out equal.
    const trackWidth = (this.laneWidth || 4) * laneCount;
    const groundGeo = new THREE.PlaneGeometry(trackWidth, 4000, 1, 1);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xa3aab8,
      roughness: 0.95,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -1900);
    this.scene.add(ground);
    this.ground = ground;

    const dividerGeo = new THREE.BoxGeometry(0.08, 0.02, 4000);
    const dividerMat = new THREE.MeshStandardMaterial({
      color: 0xf6f3ec,
      roughness: 0.8,
    });
    this.trackDividers = [-0.5, 0.5].map((offset) => {
      const divider = new THREE.Mesh(dividerGeo, dividerMat);
      divider.position.set(offset * this.laneWidth, 0.011, -1900);
      this.scene.add(divider);
      return divider;
    });

    this._ensureObstaclesGenerated(this.rowIndex + GEN_BATCH);

    this.shape.group.position.set(0, this.apothem, 0);
    this.shape.group.quaternion.identity();
    this.shape.phase = 'idle';
  }

  _teardownTrackMode() {
    this.scene.remove(this.ground);
    for (const d of this.trackDividers) this.scene.remove(d);
    for (const { mesh, shadow } of this.obstaclesByRow.values()) {
      this.scene.remove(mesh);
      this.scene.remove(shadow);
    }
    this.obstaclesByRow.clear();
  }

  _ensureObstaclesGenerated(untilRow) {
    const laneWidth = this.laneWidth;
    const obstacleHeight = 2 * this.apothem;
    // Square footprint, and narrow enough that its inner edge clears the
    // rolling shape's own resting bounding width (2x apothem) with a
    // visible gap - at 0.8 lane-widths it was wide enough to graze the
    // shape as it rolled past in an adjacent lane.
    const obstacleSize = laneWidth * 0.5;
    const boxGeo = new THREE.BoxGeometry(obstacleSize, obstacleHeight, obstacleSize);
    for (let row = this.generatedUntilRow + 1; row <= untilRow; row++) {
      const farEnoughFromLast = row - this.lastObstacleRow >= this.minObstacleRowGap;
      if (row > SAFE_START_ROWS && farEnoughFromLast && Math.random() < OBSTACLE_CHANCE) {
        const lane = LANES[Math.floor(Math.random() * LANES.length)];
        const base = OBSTACLE_COLORS[Math.floor(Math.random() * OBSTACLE_COLORS.length)];
        const color = new THREE.Color(base);
        const jitter = 0.9 + Math.random() * 0.2;
        color.multiplyScalar(jitter);
        const mat = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.45,
        });
        const mesh = new THREE.Mesh(boxGeo, mat);
        const z = -row * this.forwardStep;
        mesh.position.set(lane * laneWidth, obstacleHeight / 2, z);
        this.scene.add(mesh);

        const shadow = this._makeBlobShadow(obstacleSize * 0.7);
        shadow.position.set(lane * laneWidth, 0.02, z);
        this.scene.add(shadow);

        this.obstaclesByRow.set(row, { lane, mesh, shadow });
        this.lastObstacleRow = row;
      }
    }
    this.generatedUntilRow = untilRow;

    // cull obstacles well behind the shape
    for (const [row, entry] of this.obstaclesByRow.entries()) {
      if (row < this.rowIndex - 6) {
        this.scene.remove(entry.mesh);
        this.scene.remove(entry.shadow);
        this.obstaclesByRow.delete(row);
      }
    }
  }

  _isTrackBlocked(row, lane) {
    const entry = this.obstaclesByRow.get(row);
    return !!entry && entry.lane === lane;
  }

  _decideNextMoveTrack() {
    const nextRow = this.rowIndex + 1;
    const blocked = this.obstaclesByRow.get(nextRow);

    if (blocked && blocked.lane === this.laneIndex) {
      // A sideways tumble doesn't change row, so the only thing that can
      // stop it is an obstacle sitting in the destination lane at the
      // *current* row - check both candidate lanes rather than assuming
      // whichever one isn't the forced "toward center" choice is clear.
      const candidates =
        this.laneIndex === -1
          ? [{ dir: RIGHT, lane: 0 }]
          : this.laneIndex === 1
          ? [{ dir: LEFT, lane: 0 }]
          : Math.random() < 0.5
          ? [{ dir: LEFT, lane: -1 }, { dir: RIGHT, lane: 1 }]
          : [{ dir: RIGHT, lane: 1 }, { dir: LEFT, lane: -1 }];
      const choice = candidates.find((c) => !this._isTrackBlocked(this.rowIndex, c.lane));
      if (!choice) return; // boxed in on both sides - sit tight

      this.laneIndex = choice.lane;
      this.dodges += 1;
      this.shape.startMove(choice.dir);
      return;
    }

    this.rowIndex += 1;
    this.distance += 1;
    this.shape.startMove(FORWARD);
    this._ensureObstaclesGenerated(this.rowIndex + GEN_BATCH);
  }

  // ---------------------------------------------------------------------
  // Map mode: procedurally generated maze, start-to-goal, A* in auto mode.
  // ---------------------------------------------------------------------

  // Movement operates directly on the block grid (one room/passage/corner
  // block = one graph node), not on a further fine subdivision inside each
  // block. Each logical step crosses exactly one block via two chained
  // tumbles (matching the block's full MAZE_RATIO*cellSize width), so the
  // shape only ever comes to rest at a block's true center - a full block
  // half-width (2 edge-lengths) from every wall, comfortably clear of its
  // ~1.207 edge-length apothem. Flush, uniform walls are then always safe,
  // with no per-side inset or corner special-casing required.
  _setupMapMode() {
    this.maze = generateMaze(MAZE_COARSE_SIZE, MAZE_COARSE_SIZE, Math.random);
    this.blockGrid = buildBlockGrid(this.maze);
    const { blockOpen, blocksX, blocksY } = this.blockGrid;

    const pass1 = bfsFarthest(blockOpen, blocksX, { fx: 0, fy: 0 });
    const pass2 = bfsFarthest(blockOpen, blocksX, pass1.point);
    this.mapStart = { bx: pass1.point.fx, by: pass1.point.fy };
    this.mapGoal = { bx: pass2.point.fx, by: pass2.point.fy };

    this.bx = this.mapStart.bx;
    this.by = this.mapStart.by;
    this.mapPath = null;
    this.mapPathIndex = 0;
    this.mapPendingDir = null;
    this.mapSteps = 0;
    this.mapStatus = 'solving';

    const cellSize = this.forwardStep;
    const blockStep = MAZE_RATIO * cellSize; // world distance between adjacent block centers
    this._mapWorldX = (bx) => (bx - this.mapStart.bx) * blockStep;
    this._mapWorldZ = (by) => (by - this.mapStart.by) * blockStep;

    const minX = this._mapWorldX(0) - blockStep / 2;
    const maxX = this._mapWorldX(blocksX - 1) + blockStep / 2;
    const minZ = this._mapWorldZ(0) - blockStep / 2;
    const maxZ = this._mapWorldZ(blocksY - 1) + blockStep / 2;

    const groundGeo = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xa3aab8,
      roughness: 0.95,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    this.scene.add(ground);
    this.mapGround = ground;

    // Walls are rendered as thin partitions sitting exactly on the boundary
    // between an open block and a closed neighbor - not as a box filling
    // the closed block's whole footprint. A filled block would either have
    // to match the corridor's width (reading as just as "wide" as the
    // path) or leave a visible, illogical gap around a thinner box (open-
    // looking floor that's actually still blocked).
    this.mapWalls = [];
    const wallHeight = 2 * this.apothem;
    const wallThickness = cellSize * 0.16;
    // Extend each segment by one full thickness along its length (half past
    // each end, since a BoxGeometry is centered on its position), so
    // perpendicular segments meeting at a corner overlap into the shared
    // corner square instead of leaving a hairline notch.
    const segmentLength = blockStep + wallThickness;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a8fa6, roughness: 0.85 });
    const hWallGeo = new THREE.BoxGeometry(wallThickness, wallHeight, segmentLength);
    const vWallGeo = new THREE.BoxGeometry(segmentLength, wallHeight, wallThickness);

    const addWallSegment = (geo, x, z) => {
      const wall = new THREE.Mesh(geo, wallMat);
      wall.position.set(x, wallHeight / 2, z);
      this.scene.add(wall);
      this.mapWalls.push(wall);
    };

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        if (!blockOpen(bx, by)) continue;
        const cx = this._mapWorldX(bx);
        const cz = this._mapWorldZ(by);

        for (const [dx, dy] of [[1, 0], [-1, 0]]) {
          if (blockOpen(bx + dx, by + dy)) continue;
          addWallSegment(hWallGeo, (cx + this._mapWorldX(bx + dx)) / 2, cz);
        }
        for (const [dx, dy] of [[0, 1], [0, -1]]) {
          if (blockOpen(bx + dx, by + dy)) continue;
          addWallSegment(vWallGeo, cx, (cz + this._mapWorldZ(by + dy)) / 2);
        }
      }
    }

    const goalGeo = new THREE.CircleGeometry(cellSize * 0.32, 24);
    const goalMat = new THREE.MeshBasicMaterial({ color: 0x35b88a });
    const goalMarker = new THREE.Mesh(goalGeo, goalMat);
    goalMarker.rotation.x = -Math.PI / 2;
    goalMarker.position.set(
      this._mapWorldX(this.mapGoal.bx),
      0.03,
      this._mapWorldZ(this.mapGoal.by)
    );
    this.scene.add(goalMarker);
    this.mapGoalMarker = goalMarker;

    this.shape.group.position.set(0, this.apothem, 0);
    this.shape.group.quaternion.identity();
    this.shape.phase = 'idle';
  }

  _teardownMapMode() {
    this.scene.remove(this.mapGround);
    for (const w of this.mapWalls) this.scene.remove(w);
    this.mapWalls = [];
    this.scene.remove(this.mapGoalMarker);
  }

  _decideNextMoveMap() {
    if (this.mapStatus !== 'solving') return;

    if (!this.mapPath || this.mapPathIndex >= this.mapPath.length - 1) {
      this.mapPath = findPath(
        this.blockGrid.blockOpen,
        this.blockGrid.blocksX,
        { fx: this.bx, fy: this.by },
        { fx: this.mapGoal.bx, fy: this.mapGoal.by }
      );
      this.mapPathIndex = 0;
      if (!this.mapPath) {
        this.mapStatus = 'stuck';
        return;
      }
    }

    const next = this.mapPath[this.mapPathIndex + 1];
    const dx = next.fx - this.bx;
    const dy = next.fy - this.by;
    const dir = dx === 1 ? RIGHT : dx === -1 ? LEFT : dy === 1 ? BACKWARD : FORWARD;
    this.bx = next.fx;
    this.by = next.fy;
    this.mapPathIndex += 1;
    this.mapSteps += 1;
    this.shape.startMove(dir);
    this.mapPendingDir = dir;
    if (this.bx === this.mapGoal.bx && this.by === this.mapGoal.by) {
      this.mapStatus = 'reached';
    }
  }

  // ---------------------------------------------------------------------
  // Camera, input, and the render loop (shared by both modes).
  // ---------------------------------------------------------------------

  _setupCameraControls() {
    this.cameraOrbit = {
      theta: 0,
      elevation: CAMERA_ELEVATION_DEFAULT,
      radius: CAMERA_RADIUS_DEFAULT,
    };
    // A smoothed follow anchor, separate from the shape's raw (jerky,
    // stop-start) tumble position - both the camera position and its
    // look-at point are derived from this so they never disagree about
    // where "here" is, which is what made the view shudder.
    this._camTarget = new THREE.Vector3(0, this.apothem, 0);
    this._dragging = false;
    this._lastPointerX = 0;
    this._lastPointerY = 0;

    this._onPointerDown = (e) => {
      this._dragging = true;
      this._lastPointerX = e.clientX;
      this._lastPointerY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    };
    this._onPointerMove = (e) => {
      if (!this._dragging) return;
      const deltaX = e.clientX - this._lastPointerX;
      const deltaY = e.clientY - this._lastPointerY;
      this._lastPointerX = e.clientX;
      this._lastPointerY = e.clientY;
      this.cameraOrbit.theta -= deltaX * ORBIT_SPEED;
      this.cameraOrbit.elevation = Math.min(
        CAMERA_ELEVATION_MAX,
        Math.max(CAMERA_ELEVATION_MIN, this.cameraOrbit.elevation - deltaY * TILT_SPEED)
      );
    };
    this._onPointerUp = (e) => {
      this._dragging = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    };
    this._onWheel = (e) => {
      e.preventDefault();
      // Multiplicative zoom keeps each notch feeling the same size whether
      // you're zoomed in close or all the way out across the wide range.
      const factor = Math.exp(e.deltaY * ZOOM_LOG_SPEED);
      this.cameraOrbit.radius = Math.min(
        CAMERA_RADIUS_MAX,
        Math.max(CAMERA_RADIUS_MIN, this.cameraOrbit.radius * factor)
      );
    };

    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _teardownCameraControls() {
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
  }

  _onKeyDown(e) {
    // Alt+3 toggles between the 3D and 2D views.
    if (e.altKey && (e.key === '3' || e.code === 'Digit3')) {
      e.preventDefault();
      this.toggleView();
      return;
    }

    const key = e.key;
    let kind = null;
    if (key === 'ArrowUp' || key === 'w' || key === 'W') kind = 'forward';
    else if (key === 'ArrowDown' || key === 's' || key === 'S') kind = 'back';
    else if (key === 'ArrowLeft' || key === 'a' || key === 'A') kind = 'left';
    else if (key === 'ArrowRight' || key === 'd' || key === 'D') kind = 'right';
    if (!kind) return;

    if (this.gameType === 'track') {
      if (kind === 'back') return; // the track only ever runs one way
      if (kind === 'left' && this.laneIndex <= -1) return;
      if (kind === 'right' && this.laneIndex >= 1) return;
      if (kind === 'forward' && this._isTrackBlocked(this.rowIndex + 1, this.laneIndex)) return;
      if (kind === 'left' && this._isTrackBlocked(this.rowIndex, this.laneIndex - 1)) return;
      if (kind === 'right' && this._isTrackBlocked(this.rowIndex, this.laneIndex + 1)) return;
    } else {
      const { dx, dy } = MAP_DIR_DELTAS[kind];
      if (!this.blockGrid.blockOpen(this.bx + dx, this.by + dy)) return;
    }

    e.preventDefault();
    this.manualDir = kind;
  }

  _applyManualMove(kind) {
    if (this.gameType === 'track') {
      if (kind === 'forward') {
        this.rowIndex += 1;
        this.distance += 1;
        this.shape.startMove(FORWARD);
        this._ensureObstaclesGenerated(this.rowIndex + GEN_BATCH);
      } else if (kind === 'left') {
        this.laneIndex -= 1;
        this.shape.startMove(LEFT);
      } else if (kind === 'right') {
        this.laneIndex += 1;
        this.shape.startMove(RIGHT);
      }
      return;
    }

    const { dx, dy, vec } = MAP_DIR_DELTAS[kind];
    this.bx += dx;
    this.by += dy;
    this.mapSteps += 1;
    this.shape.startMove(vec);
    this.mapPendingDir = vec;
    // The cached A* path no longer starts where the shape actually is.
    this.mapPath = null;
    if (this.bx === this.mapGoal.bx && this.by === this.mapGoal.by) {
      this.mapStatus = 'reached';
    }
  }

  _decideNextMove() {
    if (this.gameType === 'track') this._decideNextMoveTrack();
    else this._decideNextMoveMap();
  }

  _updateCamera(dt) {
    const p = this.shape.group.position;
    // Follow the shape's horizontal motion but pin the vertical anchor to its
    // resting height, so the arc it traces mid-tumble doesn't pitch the camera.
    const anchorY = this.apothem;

    // Exponential smoothing keyed to elapsed time (not a fixed per-frame
    // factor) so the follow speed stays consistent even when frame times
    // are uneven. Smoothing the anchor itself - rather than smoothing the
    // camera position while pointing it straight at the shape's raw,
    // stop-start tumble position every frame - is what actually stops the
    // view from shuddering: position and look-at now always agree on
    // where "here" is.
    const tau = this._dragging ? CAMERA_DRAG_TAU_MS : CAMERA_FOLLOW_TAU_MS;
    const alpha = 1 - Math.exp(-dt / tau);
    this._camTarget.lerp(new THREE.Vector3(p.x, anchorY, p.z), alpha);

    // The orbit offset itself (theta/elevation/radius) is applied exactly,
    // not lerped - it's already-smoothed motion (from _camTarget) plus an
    // exact user-controlled offset, so there's nothing left to smooth.
    // Lerping the final position *again* here used to let it lag behind
    // the offset that the orientation (below) assumes it's already at,
    // which is exactly what made dragging the view feel like it swam -
    // position trailing while orientation snapped straight to the new
    // angle every frame, most visible while theta/elevation keep changing.
    const { theta, elevation, radius } = this.cameraOrbit;
    const horizontalRadius = radius * Math.cos(elevation);
    this.camera.position.set(
      this._camTarget.x + horizontalRadius * Math.sin(theta),
      this._camTarget.y + radius * Math.sin(elevation),
      this._camTarget.z + horizontalRadius * Math.cos(theta)
    );
    // Deriving orientation from lookAt(target) recomputes it from a
    // position-to-target vector every frame; once that vector points
    // nearly straight down (high elevation) a tiny horizontal nudge from
    // the shape moving swings the implied "roll" wildly, which read as
    // the view snapping to an angle and back. theta/elevation are already
    // exact, so build the quaternion from them directly instead - roll is
    // never introduced in the first place, at any tilt.
    const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, theta);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(PITCH_AXIS, -elevation);
    this.camera.quaternion.copy(qYaw.multiply(qPitch));

    this.sun.position.set(p.x - 6, anchorY + 12, p.z + 8);
    this.sun.target.position.set(p.x, anchorY, p.z);
    this.sun.target.updateMatrixWorld();

    this.shapeShadow.position.set(p.x, 0.02, p.z);
    if (this.gameType === 'track') this.ground.position.z = p.z - 1900 + 40;
  }

  _onResize() {
    // Measure the container rather than a canvas, since the hidden view's
    // canvas reports a zero client size.
    const host = this.canvas.parentElement || this.canvas;
    const rect = host.getBoundingClientRect();
    const w = Math.round(rect.width) || window.innerWidth;
    const h = Math.round(rect.height) || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.renderer2d) this.renderer2d.resize(w, h);
  }

  _tick(now) {
    this._rafId = requestAnimationFrame((t) => this._tick(t));
    const dt = Math.min(48, now - this._lastT);
    this._lastT = now;

    if (this.running) {
      if (!this.shape.isBusy()) {
        if (this.mapPendingDir) {
          // Second half of a one-block crossing (see _setupMapMode) -
          // chains immediately, with no gap, so the two tumbles read as one
          // continuous motion across the block rather than a mid-corridor
          // pause.
          const dir = this.mapPendingDir;
          this.mapPendingDir = null;
          this.shape.startMove(dir);
        } else if (this.manualDir) {
          this._applyManualMove(this.manualDir);
          this.manualDir = null;
        } else if (this.mode === 'auto') {
          if (this.pendingGapMs > 0) {
            this.pendingGapMs -= dt;
          } else {
            this._decideNextMove();
          }
        }
      }
      this.shape.update(dt);
      this._reportStats();
    }

    if (this.view === '2d' && this.renderer2d) {
      this.renderer2d.render();
    } else {
      this._updateCamera(dt);
      this.renderer.render(this.scene, this.camera);
    }
  }
}

import * as THREE from 'three';
import { buildRhombicuboctahedron, buildMesh } from './geometry.js';
import { RollingShape } from './roller.js';
import { findPath, generateObstacleGrid } from './maze.js?v=25';
import { Renderer2D } from './renderer2d.js?v=30';

const FORWARD = new THREE.Vector3(0, 0, -1);
const BACKWARD = new THREE.Vector3(0, 0, 1);
const LEFT = new THREE.Vector3(-1, 0, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const PITCH_AXIS = new THREE.Vector3(1, 0, 0);

const MAP_DIR_DELTAS = {
  forward: { dx: 0, dy: -1, vec: FORWARD },
  back: { dx: 0, dy: 1, vec: BACKWARD },
  left: { dx: -1, dy: 0, vec: LEFT },
  right: { dx: 1, dy: 0, vec: RIGHT },
};

const SPEED_PRESETS = {
  slow: { tumbleDuration: 130, pauseBetween: 25, moveGap: 45 },
  normal: { tumbleDuration: 80, pauseBetween: 14, moveGap: 22 },
  fast: { tumbleDuration: 45, pauseBetween: 7, moveGap: 9 },
};

const TRACK_LANE_COUNT = 16;
const MAX_RACERS = Math.floor(TRACK_LANE_COUNT / 2);
const MAP_MAX_RACERS = 20;
const TRACK_LENGTH = 120;
const TRACK_LANES = Array.from({ length: TRACK_LANE_COUNT }, (_, i) => i);
// A curated "caution" family (warm, saturated) so obstacles always pop
// against both the pastel shape and the light road, instead of a
// narrow-hue random HSL that read as muddy on a dark background.
const OBSTACLE_COLORS = [0xe8604f, 0xf0a03c, 0xd94f7a];
const SAFE_START_ROWS = 8;
const SAFE_FINISH_ROWS = 6;
const RACER_COLORS = [0xf28b82, 0xfbbc04, 0xffd666, 0x81c995, 0x78d9ec, 0x8ab4f8, 0xc58af9, 0xf07bb5];

// Each maze room/passage is expanded into MAZE_RATIO x MAZE_RATIO movement
// cells, so every corridor is MAZE_RATIO steps wide - at MAZE_RATIO=2 that's
// 2x the forward step, i.e. 4 edge-lengths, since one step is always
// exactly 2 edge-lengths.
const MAZE_RATIO = 2;
const MAP_SIZE = 21;

const CAMERA_RADIUS_MIN = 3;
const CAMERA_RADIUS_MAX = 420;
const CAMERA_RADIUS_DEFAULT = 25;
const CAMERA_ELEVATION_DEFAULT = 0.5; // radians above horizontal
const CAMERA_ELEVATION_MIN = 0.06; // just above ground level
const CAMERA_ELEVATION_MAX = 1.48; // near-overhead, high-angle view
const ORBIT_SPEED = 0.006;
const TILT_SPEED = 0.006;
const ZOOM_LOG_SPEED = 0.0022; // multiplicative zoom - constant feel across the whole range
const CAMERA_FOLLOW_TAU_MS = 190; // exponential smoothing time-constant
const CAMERA_DRAG_TAU_MS = 40;
const CAMERA_RETURN_DELAY_MS = 5000;
const CAMERA_LOOK_AHEAD_ROWS = 4;

export class Game {
  constructor(canvas, { onStats } = {}) {
    this.canvas = canvas;
    this.canvas2d = document.getElementById('scene2d');
    this.onStats = onStats || (() => {});
    this.running = true;
    this.gameType = 'track';
    this.view = '3d';
    this.pendingGapMs = 0;
    this.racerCount = 4;
    this.mapStrategy = 'path';
    this._cameraManualUntil = 0;

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
    this.speedName = name;
    const preset = SPEED_PRESETS[name] || SPEED_PRESETS.normal;
    this.shape.tumbleDuration = preset.tumbleDuration;
    this.shape.pauseBetween = preset.pauseBetween;
    this.moveGap = preset.moveGap;
    if (this.trackRacers) {
      for (const racer of this.trackRacers) {
        racer.shape.tumbleDuration = preset.tumbleDuration;
        racer.shape.pauseBetween = preset.pauseBetween;
      }
    }
    if (this.mapRacers) {
      for (const racer of this.mapRacers) {
        racer.shape.tumbleDuration = preset.tumbleDuration;
        racer.shape.pauseBetween = preset.pauseBetween;
      }
    }
  }

  setRacerCount(count) {
    const nextCount = Math.max(1, Math.min(this.getMaxRacers(), Math.round(count) || 1));
    if (nextCount === this.racerCount) return this.racerCount;
    this.racerCount = nextCount;
    this.reset();
    return this.racerCount;
  }

  getMaxRacers() {
    return this.gameType === 'map' ? MAP_MAX_RACERS : MAX_RACERS;
  }

  toggle() {
    this.running = !this.running;
    return this.running;
  }

  toggleMapStrategy() {
    this.mapStrategy = this.mapStrategy === 'path' ? 'explore' : 'path';
    if (this.gameType === 'map') {
      for (const racer of this.mapRacers) {
        racer.path = null;
        racer.pathIndex = 0;
        racer.blockedAttempts = 0;
        racer.avoidCell = null;
        racer.avoidSteps = 0;
        racer.visitCounts = new Map([[`${racer.bx},${racer.by}`, 1]]);
        this._updateMapPathDots(racer, null);
      }
    }
    return this.mapStrategy;
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

  // Switches between the endless-runner "track" mode and the maze-goal
  // "map" mode, tearing down whichever mode's scene objects are currently
  // present and building the other's fresh.
  switchGameType(type) {
    if (type === this.gameType) return this.gameType;
    if (this.gameType === 'track') this._teardownTrackMode();
    else this._teardownMapMode();

    this.gameType = type;
    this.racerCount = Math.min(this.racerCount, this.getMaxRacers());
    this.pendingGapMs = 0;

    if (type === 'track') this._setupTrackMode();
    else this._setupMapMode();

    this._cameraManualUntil = 0;
    if (type === 'map') this._camTarget.set(0, this.apothem, 0);
    this._reportStats();
    return this.gameType;
  }

  reset() {
    this.pendingGapMs = 0;
    if (this.gameType === 'track') {
      this._teardownTrackMode();
      this._setupTrackMode();
    } else {
      this._teardownMapMode();
      this._setupMapMode();
    }
    this._cameraManualUntil = 0;
    if (this.gameType === 'map') this._camTarget.set(0, this.apothem, 0);
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
        leaderDistance: Math.max(0, ...this.trackRacers.map((r) => r.row)),
        trackLength: TRACK_LENGTH,
        finished: this.trackRacers.filter((r) => r.finished).length,
        racers: this.trackRacers.length,
      });
    } else {
      this.onStats({
        gameType: 'map',
        steps: this.mapRacers.reduce((sum, racer) => sum + racer.steps, 0),
        finished: this.mapRacers.filter((racer) => racer.status === 'reached').length,
        racers: this.mapRacers.length,
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
    scene.fog = new THREE.Fog(skyColor, 70, 700);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 1400);
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
    // One unit is exactly four solid edge lengths expressed as logical rows.
    this.obstacleGapUnitRows = Math.max(1, Math.round((4 * this.edgeLength) / this.forwardStep));
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
  // Track mode: a finite 16-lane autonomous race.
  // ---------------------------------------------------------------------

  _setupTrackMode() {
    if (this.cameraOrbit) {
      this.cameraOrbit.theta = 0;
      this.cameraOrbit.elevation = 0.46;
      this.cameraOrbit.radius = 168;
    }
    this.finishOrder = [];
    this.trackLength = TRACK_LENGTH;
    this.obstacles = [];
    this.trackRacers = [];
    const trackWidth = this.laneWidth * TRACK_LANE_COUNT;
    const trackWorldLength = TRACK_LENGTH * this.forwardStep;
    const groundGeo = new THREE.PlaneGeometry(trackWidth, trackWorldLength + this.forwardStep * 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xa3aab8,
      roughness: 0.95,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -trackWorldLength / 2);
    this.scene.add(ground);
    this.ground = ground;

    const dividerGeo = new THREE.BoxGeometry(0.08, 0.02, trackWorldLength);
    const dividerMat = new THREE.MeshStandardMaterial({
      color: 0xf6f3ec,
      roughness: 0.8,
    });
    this.trackDividers = Array.from({ length: TRACK_LANE_COUNT - 1 }, (_, i) => i + 0.5).map((boundary) => {
      const divider = new THREE.Mesh(dividerGeo, dividerMat);
      divider.position.set(this._laneX(boundary), 0.011, -trackWorldLength / 2);
      this.scene.add(divider);
      return divider;
    });

    this._addRaceLine(0, false);
    this._addRaceLine(TRACK_LENGTH, true);
    this._generateTrackObstacles();

    const startLanes = Array.from({ length: this.racerCount }, (_, i) =>
      Math.round(i * (TRACK_LANE_COUNT - 1) / Math.max(1, this.racerCount - 1))
    );
    for (let i = 0; i < this.racerCount; i++) {
      let group;
      let shadow;
      let rolling;
      if (i === 0) {
        group = this.shape.group;
        shadow = this.shapeShadow;
        rolling = this.shape;
      } else {
        group = buildMesh(this.rhombi);
        this._tintShape(group, RACER_COLORS[i % RACER_COLORS.length]);
        this.scene.add(group);
        shadow = this._makeBlobShadow(this.apothem * 1.15);
        this.scene.add(shadow);
        rolling = new RollingShape(this.rhombi, group);
      }
      const racer = {
        id: i,
        shape: rolling,
        shadow,
        lane: startLanes[i],
        row: 0,
        dodges: 0,
        // All racers line up on the same start line, then launch in short
        // waves. The gap lets the previous racer clear the full 3x3 safety
        // envelope before the next one begins moving.
        pendingGapMs: 0,
        finished: false,
        place: null,
        target: null,
        avoidDirection: 0,
        lastBlocked: null,
        stuckFrames: 0,
        finishLane: null,
      };
      rolling.onMoveComplete = () => { racer.pendingGapMs = this.moveGap; racer.target = null; };
      group.position.set(this._laneX(racer.lane), this.apothem, 0);
      group.quaternion.identity();
      rolling.phase = 'idle';
      shadow.position.set(group.position.x, 0.02, 0);
      this.trackRacers.push(racer);
    }
    this._camTarget.set(0, this.apothem, -CAMERA_LOOK_AHEAD_ROWS * this.forwardStep);
    this.setSpeed(this.speedName || 'normal');
  }

  _laneX(lane) {
    return (lane - (TRACK_LANE_COUNT - 1) / 2) * this.laneWidth;
  }

  _tintShape(group, hex) {
    const mesh = group.children[0];
    if (!mesh?.geometry?.attributes?.color) return;
    const base = new THREE.Color(hex);
    const attr = mesh.geometry.attributes.color.clone();
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.setAttribute('color', attr);
    for (let i = 0; i < attr.count; i++) {
      const variation = 0.78 + (i % 7) * 0.035;
      attr.setXYZ(i, base.r * variation, base.g * variation, base.b * variation);
    }
    attr.needsUpdate = true;
  }

  _addRaceLine(row, checker) {
    const width = this.laneWidth * TRACK_LANE_COUNT;
    const depth = this.forwardStep * 0.34;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const cells = 40;
    for (let i = 0; i < cells; i++) {
      ctx.fillStyle = checker && i % 2 ? '#15181f' : '#ffffff';
      ctx.fillRect((i * canvas.width) / cells, 0, canvas.width / cells + 1, canvas.height);
    }
    const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas) });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.035, -row * this.forwardStep);
    this.scene.add(line);
    if (!this.raceLines) this.raceLines = [];
    this.raceLines.push(line);
  }

  _teardownTrackMode() {
    this.scene.remove(this.ground);
    for (const d of this.trackDividers) this.scene.remove(d);
    for (const line of this.raceLines || []) this.scene.remove(line);
    this.raceLines = [];
    for (const { mesh, shadow } of this.obstacles) {
      this.scene.remove(mesh);
      this.scene.remove(shadow);
    }
    for (const racer of this.trackRacers.slice(1)) {
      this.scene.remove(racer.shape.group);
      this.scene.remove(racer.shadow);
    }
  }

  _generateTrackObstacles() {
    const obstacleHeight = 2 * this.apothem;
    for (
      let row = SAFE_START_ROWS;
      row < TRACK_LENGTH - SAFE_FINISH_ROWS;
      row += this.obstacleGapUnitRows * (2 + Math.floor(Math.random() * 2))
    ) {
      const occupied = new Set();
      const count = 1 + Math.floor(Math.random() * 2);
      for (let k = 0; k < count; k++) {
        const span = 1 + Math.floor(Math.random() * 4);
        const starts = TRACK_LANES.filter((lane) => lane + span <= TRACK_LANE_COUNT &&
          Array.from({ length: span }, (_, n) => lane + n).every((l) => !occupied.has(l)));
        if (!starts.length || occupied.size + span > TRACK_LANE_COUNT - 4) continue;
        const laneStart = starts[Math.floor(Math.random() * starts.length)];
        for (let n = 0; n < span; n++) occupied.add(laneStart + n);
        const width = this.laneWidth * 0.5 + (span - 1) * this.laneWidth;
        const depth = this.forwardStep * (0.28 + Math.random() * 0.24);
        const boxGeo = new THREE.BoxGeometry(width, obstacleHeight, depth);
        const base = OBSTACLE_COLORS[Math.floor(Math.random() * OBSTACLE_COLORS.length)];
        const color = new THREE.Color(base);
        color.multiplyScalar(0.9 + Math.random() * 0.2);
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
        const mesh = new THREE.Mesh(boxGeo, mat);
        const laneCenter = laneStart + (span - 1) / 2;
        const z = -row * this.forwardStep;
        mesh.position.set(this._laneX(laneCenter), obstacleHeight / 2, z);
        this.scene.add(mesh);
        const shadow = this._makeBlobShadow(Math.max(width, depth) * 0.58);
        shadow.scale.set(width / Math.max(width, depth), depth / Math.max(width, depth), 1);
        shadow.position.set(mesh.position.x, 0.02, z);
        this.scene.add(shadow);
        this.obstacles.push({ laneStart, laneEnd: laneStart + span - 1, rowStart: row, rowEnd: row, mesh, shadow });
      }
    }
  }

  _isTrackBlocked(row, lane) {
    return this.obstacles.some((o) => row >= o.rowStart && row <= o.rowEnd && lane >= o.laneStart && lane <= o.laneEnd);
  }

  _racerOccupies(row, lane, except) {
    return this.trackRacers.some((r) => r !== except &&
      ((Math.abs(r.row - row) <= 1 && Math.abs(r.lane - lane) <= 1) ||
       (r.target && Math.abs(r.target.row - row) <= 1 && Math.abs(r.target.lane - lane) <= 1)));
  }

  _sideHasEscape(racer, sign) {
    for (let lane = racer.lane + sign; lane >= 0 && lane < TRACK_LANE_COUNT; lane += sign) {
      if (this._isTrackBlocked(racer.row, lane)) return -1;
      if (!this._isTrackBlocked(racer.row + 1, lane)) return Math.abs(lane - racer.lane);
    }
    return -1;
  }

  _assignFinishLane(racer) {
    if (racer.finishLane !== null) return racer.finishLane;
    const reserved = this.trackRacers
      .filter((other) => other !== racer && other.finishLane !== null)
      .map((other) => other.finishLane);
    const candidates = TRACK_LANES
      .filter((lane) => reserved.every((taken) => Math.abs(taken - lane) > 1))
      .sort((a, b) => Math.abs(a - racer.lane) - Math.abs(b - racer.lane));
    racer.finishLane = candidates[0] ?? racer.lane;
    return racer.finishLane;
  }

  _decideNextMoveTrack(racer) {
    if (racer.finished) return;
    if (racer.row >= TRACK_LENGTH) {
      racer.finished = true;
      racer.place = this.finishOrder.length + 1;
      this.finishOrder.push(racer.id);
      return;
    }
    if (racer.row >= TRACK_LENGTH - SAFE_FINISH_ROWS) {
      const finishLane = this._assignFinishLane(racer);
      if (racer.lane !== finishLane) {
        const sign = Math.sign(finishLane - racer.lane);
        const lane = racer.lane + sign;
        if (!this._isTrackBlocked(racer.row, lane) && !this._racerOccupies(racer.row, lane, racer)) {
          racer.target = { row: racer.row, lane };
          racer.lane = lane;
          racer.avoidDirection = sign;
          racer.stuckFrames = 0;
          racer.shape.startMove(sign < 0 ? LEFT : RIGHT);
        }
        return;
      }
    }
    const nextRow = racer.row + 1;
    if (!this._isTrackBlocked(nextRow, racer.lane) && !this._racerOccupies(nextRow, racer.lane, racer)) {
      racer.target = { row: nextRow, lane: racer.lane };
      racer.row = nextRow;
      racer.avoidDirection = 0;
      racer.lastBlocked = null;
      racer.stuckFrames = 0;
      racer.shape.startMove(FORWARD);
      return;
    }
    const obstacleAhead = this._isTrackBlocked(nextRow, racer.lane);
    if (!obstacleAhead) {
      const preferred = racer.id % 2 === 0 ? 1 : -1;
      const yieldDirections = racer.avoidDirection ? [racer.avoidDirection] : [preferred, -preferred];
      for (const sign of yieldDirections) {
        const lane = racer.lane + sign;
        if (lane < 0 || lane >= TRACK_LANE_COUNT) continue;
        if (this._isTrackBlocked(racer.row, lane) || this._racerOccupies(racer.row, lane, racer)) continue;
        racer.target = { row: racer.row, lane };
        racer.lane = lane;
        racer.avoidDirection = sign;
        racer.stuckFrames = 0;
        racer.shape.startMove(sign < 0 ? LEFT : RIGHT);
        return;
      }
      racer.stuckFrames += 1;
      return;
    }
    if (obstacleAhead && !racer.lastBlocked) {
      racer.lastBlocked = { row: nextRow, lane: racer.lane };
      const leftDistance = this._sideHasEscape(racer, -1);
      const rightDistance = this._sideHasEscape(racer, 1);
      if (leftDistance < 0) racer.avoidDirection = 1;
      else if (rightDistance < 0) racer.avoidDirection = -1;
      else racer.avoidDirection = leftDistance <= rightDistance ? -1 : 1;
    }
    const directions = racer.avoidDirection
      ? [racer.avoidDirection]
      : (Math.random() < 0.5 ? [-1, 1] : [1, -1]);
    for (const sign of directions) {
      const lane = racer.lane + sign;
      if (lane < 0 || lane >= TRACK_LANE_COUNT) continue;
      if (this._isTrackBlocked(racer.row, lane) || this._racerOccupies(racer.row, lane, racer)) continue;
      racer.target = { row: racer.row, lane };
      racer.lane = lane;
      racer.dodges += 1;
      racer.shape.startMove(sign < 0 ? LEFT : RIGHT);
      racer.stuckFrames = 0;
      return;
    }
    racer.stuckFrames += 1;
    // Preserve the selected side during short traffic delays. If that side
    // remains unavailable, deliberately re-plan once instead of reversing
    // every frame and oscillating in front of the same obstacle.
    if (racer.stuckFrames > 30) {
      const opposite = -racer.avoidDirection;
      if (opposite && this._sideHasEscape(racer, opposite) >= 0) {
        racer.avoidDirection = opposite;
      }
      racer.stuckFrames = 0;
    }
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
    if (this.cameraOrbit) {
      this.cameraOrbit.theta = 0;
      this.cameraOrbit.elevation = 1.02;
      this.cameraOrbit.radius = 190;
    }
    this.blockGrid = generateObstacleGrid(MAP_SIZE, MAP_SIZE, Math.random);
    const { blockOpen, blocksX, blocksY, openCells, obstacleComponents } = this.blockGrid;
    const center = { fx: (blocksX - 1) / 2, fy: (blocksY - 1) / 2 };
    const goalCell = [...openCells].sort((a, b) =>
      (Math.abs(a.fx - center.fx) + Math.abs(a.fy - center.fy)) -
      (Math.abs(b.fx - center.fx) + Math.abs(b.fy - center.fy))
    )[0];
    this.mapGoal = { bx: goalCell.fx, by: goalCell.fy };

    const starts = [];
    for (let i = 0; i < this.racerCount; i++) {
      let best = null;
      let bestScore = -Infinity;
      for (const cell of openCells) {
        if (cell.fx === goalCell.fx && cell.fy === goalCell.fy) continue;
        if (starts.some((start) => Math.abs(cell.fx - start.fx) + Math.abs(cell.fy - start.fy) <= 1)) continue;
        const distances = [Math.abs(cell.fx - goalCell.fx) + Math.abs(cell.fy - goalCell.fy)];
        for (const start of starts) distances.push(Math.abs(cell.fx - start.fx) + Math.abs(cell.fy - start.fy));
        const score = Math.min(...distances);
        if (score > bestScore) { bestScore = score; best = cell; }
      }
      starts.push({ fx: best.fx, fy: best.fy });
    }

    const cellSize = this.forwardStep;
    const blockStep = MAZE_RATIO * cellSize; // world distance between adjacent block centers
    this._mapWorldX = (bx) => (bx - (blocksX - 1) / 2) * blockStep;
    this._mapWorldZ = (by) => (by - (blocksY - 1) / 2) * blockStep;

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

    this.mapWalls = [];
    const wallHeight = 2 * this.apothem;
    const wallThickness = cellSize * 0.15;
    const wallPalette = [0x747b8e, 0x7f788c, 0x6f7f82, 0x85796f];
    obstacleComponents.forEach((component, componentIndex) => {
      const cells = new Set(component.map((p) => `${p.x},${p.y}`));
      const mat = new THREE.MeshStandardMaterial({
        color: wallPalette[componentIndex % wallPalette.length],
        roughness: 0.86,
      });
      for (const cell of component) {
        const cx = this._mapWorldX(cell.x);
        const cz = this._mapWorldZ(cell.y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (cells.has(`${cell.x + dx},${cell.y + dy}`)) continue;
          const geo = dx
            ? new THREE.BoxGeometry(wallThickness, wallHeight, blockStep + wallThickness)
            : new THREE.BoxGeometry(blockStep + wallThickness, wallHeight, wallThickness);
          const wall = new THREE.Mesh(geo, mat);
          wall.position.set(cx + dx * blockStep / 2, wallHeight / 2, cz + dy * blockStep / 2);
          this.scene.add(wall);
          this.mapWalls.push(wall);
        }
      }
    });

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

    this.mapRacers = [];
    for (let i = 0; i < this.racerCount; i++) {
      let group, shadow, rolling;
      if (i === 0) {
        group = this.shape.group;
        shadow = this.shapeShadow;
        rolling = this.shape;
      } else {
        group = buildMesh(this.rhombi);
        this._tintShape(group, RACER_COLORS[i % RACER_COLORS.length]);
        this.scene.add(group);
        shadow = this._makeBlobShadow(this.apothem * 1.15);
        this.scene.add(shadow);
        rolling = new RollingShape(this.rhombi, group);
      }
      const start = starts[i];
      const pathColor = new THREE.Color().setHSL((i * 0.61803398875) % 1, 0.78, 0.52);
      const pathDots = new THREE.InstancedMesh(
        new THREE.CircleGeometry(cellSize * 0.16, 14),
        new THREE.MeshBasicMaterial({ color: pathColor, transparent: true, opacity: 0.96, depthWrite: false }),
        blocksX * blocksY
      );
      const pathGlow = new THREE.InstancedMesh(
        new THREE.CircleGeometry(cellSize * 0.27, 16),
        new THREE.MeshBasicMaterial({ color: pathColor, transparent: true, opacity: 0.24, depthWrite: false }),
        blocksX * blocksY
      );
      pathDots.count = 0;
      pathGlow.count = 0;
      pathDots.frustumCulled = false;
      pathGlow.frustumCulled = false;
      pathDots.renderOrder = 2;
      pathGlow.renderOrder = 1;
      this.scene.add(pathGlow);
      this.scene.add(pathDots);
      const racer = {
        id: i,
        shape: rolling,
        shadow,
        bx: start.fx,
        by: start.fy,
        path: null,
        pathIndex: 0,
        pendingDir: null,
        pendingGapMs: 0,
        blockedAttempts: 0,
        previousCell: null,
        avoidCell: null,
        avoidSteps: 0,
        steps: 0,
        status: 'solving',
        visitCounts: new Map([[`${start.fx},${start.fy}`, 1]]),
        pathColor,
        pathDots,
        pathGlow,
      };
      rolling.onMoveComplete = () => { racer.pendingGapMs = this.moveGap; };
      group.position.set(this._mapWorldX(racer.bx), this.apothem, this._mapWorldZ(racer.by));
      group.quaternion.identity();
      rolling.phase = 'idle';
      shadow.position.set(group.position.x, 0.02, group.position.z);
      this.mapRacers.push(racer);
    }
    this._camTarget.set(0, this.apothem, 0);
    this.setSpeed(this.speedName || 'normal');
  }

  _teardownMapMode() {
    this.scene.remove(this.mapGround);
    for (const wall of this.mapWalls) this.scene.remove(wall);
    this.mapWalls = [];
    this.scene.remove(this.mapGoalMarker);
    for (const racer of (this.mapRacers || [])) {
      this.scene.remove(racer.pathDots);
      this.scene.remove(racer.pathGlow);
      racer.pathDots?.geometry.dispose();
      racer.pathDots?.material.dispose();
      racer.pathGlow?.geometry.dispose();
      racer.pathGlow?.material.dispose();
      if (racer.id > 0) {
        this.scene.remove(racer.shape.group);
        this.scene.remove(racer.shadow);
      }
    }
    this.mapRacers = [];
  }

  _decideNextMoveMap(racer) {
    if (racer.status !== 'solving') return;

    const next = this.mapStrategy === 'explore'
      ? this._chooseExplorationMove(racer)
      : this._choosePathMove(racer);
    if (!next) return;

    const dx = next.fx - racer.bx;
    const dy = next.fy - racer.by;
    const dir = dx === 1 ? RIGHT : dx === -1 ? LEFT : dy === 1 ? BACKWARD : FORWARD;
    racer.previousCell = { bx: racer.bx, by: racer.by };
    racer.bx = next.fx;
    racer.by = next.fy;
    racer.steps += 1;
    racer.visitCounts.set(`${racer.bx},${racer.by}`, (racer.visitCounts.get(`${racer.bx},${racer.by}`) || 0) + 1);
    racer.shape.startMove(dir);
    racer.pendingDir = dir;
    if (racer.bx === this.mapGoal.bx && racer.by === this.mapGoal.by) {
      racer.status = 'reached';
      this._updateMapPathDots(racer, null);
    }
  }

  _isMapGoal(x, y) {
    return x === this.mapGoal.bx && y === this.mapGoal.by;
  }

  _mapCellAvailable(x, y, racer) {
    if (!this.blockGrid.blockOpen(x, y)) return false;
    if (this._isMapGoal(x, y)) return true;
    return !this.mapRacers.some((other) =>
      other !== racer &&
      other.status !== 'reached' &&
      Math.abs(other.bx - x) + Math.abs(other.by - y) <= 1
    );
  }

  _choosePathMove(racer) {
    // Global planning uses only the fixed obstacle map. Other racers are a
    // local scheduling concern and must not distort or temporarily erase the
    // true shortest path.
    if (!racer.path || racer.pathIndex >= racer.path.length - 1) {
      const staticOpen = (x, y) => this.blockGrid.blockOpen(x, y) &&
        !(racer.avoidSteps > 0 && racer.avoidCell && x === racer.avoidCell.bx && y === racer.avoidCell.by);
      racer.path = findPath(
        staticOpen,
        this.blockGrid.blocksX,
        { fx: racer.bx, fy: racer.by },
        { fx: this.mapGoal.bx, fy: this.mapGoal.by }
      );
      if (!racer.path && racer.avoidSteps > 0) {
        racer.avoidSteps = 0;
        racer.avoidCell = null;
        racer.path = findPath(
          this.blockGrid.blockOpen,
          this.blockGrid.blocksX,
          { fx: racer.bx, fy: racer.by },
          { fx: this.mapGoal.bx, fy: this.mapGoal.by }
        );
      }
      racer.pathIndex = 0;
      this._updateMapPathDots(racer, racer.path);
    }
    if (!racer.path || racer.path.length < 2) return null;

    const next = racer.path[racer.pathIndex + 1];
    if (this._mapCellAvailable(next.fx, next.fy, racer)) {
      racer.blockedAttempts = 0;
      if (racer.avoidSteps > 0) {
        racer.avoidSteps -= 1;
        if (!racer.avoidSteps) racer.avoidCell = null;
      }
      racer.pathIndex += 1;
      this._updateMapPathDots(racer, racer.path.slice(racer.pathIndex));
      return next;
    }

    // Usually a moving blocker clears by itself, so wait without changing the
    // planned line. Only a persistent mutual block triggers a one-cell local
    // yield; A* then computes a fresh static shortest path from that new cell.
    racer.blockedAttempts += 1;
    if (racer.blockedAttempts < 30) return null;
    return this._chooseLocalYieldMove(racer, next);
  }

  _chooseLocalYieldMove(racer, blockedNext) {
    const blockers = this.mapRacers.filter((other) =>
      other !== racer && other.status !== 'reached' &&
      Math.abs(other.bx - blockedNext.fx) + Math.abs(other.by - blockedNext.fy) <= 1
    );
    const forceYield = racer.blockedAttempts >= 180;
    if (!forceYield && blockers.some((other) => other.shape.isBusy())) return null;
    const myRemaining = racer.path ? racer.path.length - racer.pathIndex : Infinity;
    const shouldYield = blockers.some((other) => {
      const otherRemaining = other.path ? other.path.length - other.pathIndex : Infinity;
      return otherRemaining < myRemaining || (otherRemaining === myRemaining && other.id < racer.id);
    });
    if (!shouldYield && !forceYield) return null;

    let candidates = Object.values(MAP_DIR_DELTAS)
      .map(({ dx, dy }) => ({ fx: racer.bx + dx, fy: racer.by + dy }))
      .filter((cell) =>
        !(cell.fx === blockedNext.fx && cell.fy === blockedNext.fy) &&
        this._mapCellAvailable(cell.fx, cell.fy, racer)
      );
    const fresh = candidates.filter((cell) =>
      !racer.previousCell || cell.fx !== racer.previousCell.bx || cell.fy !== racer.previousCell.by
    );
    if (fresh.length) candidates = fresh;
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const clearance = (cell) => Math.min(...this.mapRacers
        .filter((other) => other !== racer && other.status !== 'reached')
        .map((other) => Math.abs(other.bx - cell.fx) + Math.abs(other.by - cell.fy)), 99);
      const score = (cell) => clearance(cell) * 100 -
        Math.abs(cell.fx - this.mapGoal.bx) - Math.abs(cell.fy - this.mapGoal.by);
      return score(b) - score(a);
    });
    racer.blockedAttempts = 0;
    racer.avoidCell = { bx: racer.bx, by: racer.by };
    racer.avoidSteps = 3;
    racer.path = null;
    racer.pathIndex = 0;
    this._updateMapPathDots(racer, null);
    return candidates[0];
  }

  _updateMapPathDots(racer, path) {
    if (!racer.pathDots) return;
    if (this.mapStrategy !== 'path' || !path || path.length < 2) {
      racer.pathDots.count = 0;
      racer.pathGlow.count = 0;
      racer.pathDots.instanceMatrix.needsUpdate = true;
      racer.pathGlow.instanceMatrix.needsUpdate = true;
      return;
    }
    const rotation = new THREE.Quaternion().setFromAxisAngle(PITCH_AXIS, -Math.PI / 2);
    const scale = new THREE.Vector3(1, 1, 1);
    const matrix = new THREE.Matrix4();
    const remaining = path.slice(1);
    remaining.forEach((cell, index) => {
      matrix.compose(
        new THREE.Vector3(this._mapWorldX(cell.fx), 0.055, this._mapWorldZ(cell.fy)),
        rotation,
        scale
      );
      racer.pathDots.setMatrixAt(index, matrix);
      racer.pathGlow.setMatrixAt(index, matrix);
    });
    racer.pathDots.count = remaining.length;
    racer.pathGlow.count = remaining.length;
    racer.pathDots.instanceMatrix.needsUpdate = true;
    racer.pathGlow.instanceMatrix.needsUpdate = true;
  }

  _chooseExplorationMove(racer) {
    const candidates = Object.values(MAP_DIR_DELTAS)
      .map(({ dx, dy }) => ({ fx: racer.bx + dx, fy: racer.by + dy }))
      .filter((cell) => this._mapCellAvailable(cell.fx, cell.fy, racer));
    if (!candidates.length) return null;

    // Discovery comes first; visit count prevents short back-and-forth loops.
    // Distance to the visible goal is only a tie-breaker, not a path search.
    candidates.sort((a, b) => {
      const visitsA = racer.visitCounts.get(`${a.fx},${a.fy}`) || 0;
      const visitsB = racer.visitCounts.get(`${b.fx},${b.fy}`) || 0;
      if (visitsA !== visitsB) return visitsA - visitsB;
      const goalA = Math.abs(a.fx - this.mapGoal.bx) + Math.abs(a.fy - this.mapGoal.by);
      const goalB = Math.abs(b.fx - this.mapGoal.bx) + Math.abs(b.fy - this.mapGoal.by);
      return goalA - goalB || Math.random() - 0.5;
    });
    return candidates[0];
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
    this._dragMode = 'orbit';
    this._lastPointerX = 0;
    this._lastPointerY = 0;

    this._onPointerDown = (e) => {
      this._dragging = true;
      this._dragMode = e.shiftKey ? 'pan' : 'orbit';
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
      if (deltaX || deltaY) this._cameraManualUntil = performance.now() + CAMERA_RETURN_DELAY_MS;
      if (this._dragMode === 'pan') {
        const scale = this.cameraOrbit.radius * 0.0024;
        const theta = this.cameraOrbit.theta;
        const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
        const forward = new THREE.Vector3(-Math.sin(theta), 0, -Math.cos(theta));
        this._camTarget.addScaledVector(right, -deltaX * scale);
        this._camTarget.addScaledVector(forward, deltaY * scale);
        return;
      }
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
      this._cameraManualUntil = performance.now() + CAMERA_RETURN_DELAY_MS;
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
    if (this.gameType === 'track' && performance.now() >= this._cameraManualUntil) {
      const leader = this.trackRacers.reduce(
        (best, racer) => racer.row > best.row ? racer : best,
        this.trackRacers[0]
      );
      const leaderPos = leader.shape.group.position;
      const lookAheadZ = leaderPos.z - CAMERA_LOOK_AHEAD_ROWS * this.forwardStep;
      const alpha = 1 - Math.exp(-dt / CAMERA_FOLLOW_TAU_MS);
      this._camTarget.lerp(new THREE.Vector3(0, anchorY, lookAheadZ), alpha);
    }

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

    if (this.gameType === 'map') this.shapeShadow.position.set(p.x, 0.02, p.z);
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
      if (this.gameType === 'track') {
        for (const racer of this.trackRacers) {
          if (!racer.shape.isBusy() && !racer.finished) {
            if (racer.pendingGapMs > 0) racer.pendingGapMs -= dt;
            else this._decideNextMoveTrack(racer);
          }
          racer.shape.update(dt);
          const p = racer.shape.group.position;
          racer.shadow.position.set(p.x, 0.02, p.z);
        }
      } else {
        for (const racer of this.mapRacers) {
          if (!racer.shape.isBusy()) {
            if (racer.pendingDir) {
              const dir = racer.pendingDir;
              racer.pendingDir = null;
              racer.shape.startMove(dir);
            } else if (racer.pendingGapMs > 0) {
              racer.pendingGapMs -= dt;
            } else {
              this._decideNextMoveMap(racer);
            }
          }
          racer.shape.update(dt);
          const p = racer.shape.group.position;
          racer.shadow.position.set(p.x, 0.02, p.z);
        }
      }
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

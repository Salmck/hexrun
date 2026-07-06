import * as THREE from 'three';
import { buildRhombicuboctahedron, buildMesh } from './geometry.js';
import { RollingShape } from './roller.js';

const FORWARD = new THREE.Vector3(0, 0, -1);
const LEFT = new THREE.Vector3(-1, 0, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const PITCH_AXIS = new THREE.Vector3(1, 0, 0);

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
    this.onStats = onStats || (() => {});
    this.running = true;
    this.mode = 'auto';
    this.distance = 0;
    this.dodges = 0;

    this._setupScene();
    this._setupShape();
    this._setupTrack();

    this.obstaclesByRow = new Map(); // row -> { lane, mesh }
    this.generatedUntilRow = 0;
    this.lastObstacleRow = -Infinity;
    this.rowIndex = 0;
    this.laneIndex = 0;
    this.pendingGapMs = 0;
    this.manualDir = null;

    this._ensureObstaclesGenerated(this.rowIndex + GEN_BATCH);

    this._setupCameraControls();

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

  toggleMode() {
    this.mode = this.mode === 'auto' ? 'manual' : 'auto';
    this.pendingGapMs = 0;
    return this.mode;
  }

  reset() {
    this.distance = 0;
    this.dodges = 0;
    this.rowIndex = 0;
    this.laneIndex = 0;
    this.pendingGapMs = 0;
    this.manualDir = null;

    for (const { mesh, shadow } of this.obstaclesByRow.values()) {
      this.scene.remove(mesh);
      this.scene.remove(shadow);
    }
    this.obstaclesByRow.clear();
    this.generatedUntilRow = 0;
    this.lastObstacleRow = -Infinity;
    this._ensureObstaclesGenerated(this.rowIndex + GEN_BATCH);

    this.shape.group.position.set(0, this.apothem, 0);
    this.shape.group.quaternion.identity();
    this.shape.phase = 'idle';
    this._camTarget.set(0, this.apothem, 0);

    this.onStats({ distance: this.distance, dodges: this.dodges });
  }

  dispose() {
    cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._resizeHandler);
    window.removeEventListener('keydown', this._keyHandler);
    this._teardownCameraControls();
    this.renderer.dispose();
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
    // throwaway transform.
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

  _setupTrack() {
    const laneCount = LANES.length;
    // Dividers sit at +-0.5 lane-widths, so the road needs to be exactly
    // laneCount lane-widths wide for all three strips (including the two
    // outer ones) to come out equal - it was a full lane-width too wide
    // before, which padded the outer lanes visibly wider than the middle.
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
    for (const offset of [-0.5, 0.5]) {
      const divider = new THREE.Mesh(dividerGeo, dividerMat);
      divider.position.set(offset * this.laneWidth, 0.011, -1900);
      this.scene.add(divider);
    }
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

  _isBlocked(row, lane) {
    const entry = this.obstaclesByRow.get(row);
    return !!entry && entry.lane === lane;
  }

  _decideNextMove() {
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
      const choice = candidates.find((c) => !this._isBlocked(this.rowIndex, c.lane));
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
    const key = e.key;
    let kind = null;
    if (key === 'ArrowUp' || key === 'w' || key === 'W') kind = 'forward';
    else if (key === 'ArrowLeft' || key === 'a' || key === 'A') kind = 'left';
    else if (key === 'ArrowRight' || key === 'd' || key === 'D') kind = 'right';
    if (!kind) return;
    e.preventDefault();

    if (kind === 'left' && this.laneIndex <= -1) return;
    if (kind === 'right' && this.laneIndex >= 1) return;
    if (kind === 'forward' && this._isBlocked(this.rowIndex + 1, this.laneIndex)) return;
    if (kind === 'left' && this._isBlocked(this.rowIndex, this.laneIndex - 1)) return;
    if (kind === 'right' && this._isBlocked(this.rowIndex, this.laneIndex + 1)) return;
    this.manualDir = kind;
  }

  _applyManualMove(kind) {
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
    this.ground.position.z = p.z - 1900 + 40;
  }

  _onResize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick(now) {
    this._rafId = requestAnimationFrame((t) => this._tick(t));
    const dt = Math.min(48, now - this._lastT);
    this._lastT = now;

    if (this.running) {
      if (!this.shape.isBusy()) {
        if (this.manualDir) {
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
      this.onStats({ distance: this.distance, dodges: this.dodges, mode: this.mode });
    }

    this._updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

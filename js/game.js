import * as THREE from 'three';
import { buildRhombicuboctahedron, buildMesh } from './geometry.js';
import { RollingShape } from './roller.js';

const FORWARD = new THREE.Vector3(0, 0, -1);
const LEFT = new THREE.Vector3(-1, 0, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

const SPEED_PRESETS = {
  slow: { tumbleDuration: 400, pauseBetween: 100, moveGap: 300 },
  normal: { tumbleDuration: 260, pauseBetween: 60, moveGap: 150 },
  fast: { tumbleDuration: 150, pauseBetween: 30, moveGap: 60 },
};

const LANES = [-1, 0, 1];
const OBSTACLE_CHANCE = 0.6;
const SAFE_START_ROWS = 4;
const GEN_BATCH = 30;
const MIN_OBSTACLE_EDGE_GAP = 4; // obstacles kept >= 4 edge-lengths apart

const CAMERA_RADIUS_MIN = 12;
const CAMERA_RADIUS_MAX = 48;
const CAMERA_RADIUS_DEFAULT = 25;
const CAMERA_ELEVATION_DEFAULT = 0.5; // radians above horizontal
const CAMERA_ELEVATION_MIN = 0.06; // just above ground level
const CAMERA_ELEVATION_MAX = 1.48; // near-overhead, high-angle view
const ORBIT_SPEED = 0.006;
const TILT_SPEED = 0.006;
const ZOOM_SPEED = 0.03;

export class Game {
  constructor(canvas, { onStats } = {}) {
    this.canvas = canvas;
    this.onStats = onStats || (() => {});
    this.running = true;
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

  reset() {
    this.distance = 0;
    this.dodges = 0;
    this.rowIndex = 0;
    this.laneIndex = 0;
    this.pendingGapMs = 0;
    this.manualDir = null;

    for (const { mesh } of this.obstaclesByRow.values()) {
      this.scene.remove(mesh);
    }
    this.obstaclesByRow.clear();
    this.generatedUntilRow = 0;
    this.lastObstacleRow = -Infinity;
    this._ensureObstaclesGenerated(this.rowIndex + GEN_BATCH);

    this.shape.group.position.set(0, this.apothem, 0);
    this.shape.group.quaternion.identity();
    this.shape.phase = 'idle';

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
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14181f);
    scene.fog = new THREE.Fog(0x14181f, 20, 90);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 300);
    this.camera = camera;

    const hemi = new THREE.HemisphereLight(0xfff3e0, 0x1a1e26, 0.65);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff3e0, 1.1);
    sun.position.set(-6, 12, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.camera.far = 60;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    const fill = new THREE.DirectionalLight(0xb9c4d6, 0.35);
    fill.position.set(8, 6, -6);
    scene.add(fill);
  }

  _setupShape() {
    this.rhombi = buildRhombicuboctahedron(1.4);
    this.apothem = this.rhombi.apothem;

    const meshGroup = buildMesh(this.rhombi);
    meshGroup.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = false;
      }
    });
    meshGroup.position.set(0, this.apothem, 0);
    this.scene.add(meshGroup);

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
    const trackWidth = (this.laneWidth || 4) * (laneCount + 1);
    const groundGeo = new THREE.PlaneGeometry(trackWidth, 4000, 1, 1);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x232a35,
      roughness: 0.95,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -1900);
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;

    const dividerGeo = new THREE.BoxGeometry(0.08, 0.02, 4000);
    const dividerMat = new THREE.MeshStandardMaterial({
      color: 0x4a5468,
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
    const boxGeo = new THREE.BoxGeometry(laneWidth * 0.8, obstacleHeight, 2.2);
    for (let row = this.generatedUntilRow + 1; row <= untilRow; row++) {
      const farEnoughFromLast = row - this.lastObstacleRow >= this.minObstacleRowGap;
      if (row > SAFE_START_ROWS && farEnoughFromLast && Math.random() < OBSTACLE_CHANCE) {
        const lane = LANES[Math.floor(Math.random() * LANES.length)];
        const hue = (Math.random() < 0.5 ? 0.0 : 0.08) + Math.random() * 0.03;
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(hue, 0.72, 0.52),
          roughness: 0.45,
        });
        const mesh = new THREE.Mesh(boxGeo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(
          lane * laneWidth,
          obstacleHeight / 2,
          -row * this.forwardStep
        );
        this.scene.add(mesh);
        this.obstaclesByRow.set(row, { lane, mesh });
        this.lastObstacleRow = row;
      }
    }
    this.generatedUntilRow = untilRow;

    // cull obstacles well behind the shape
    for (const [row, entry] of this.obstaclesByRow.entries()) {
      if (row < this.rowIndex - 6) {
        this.scene.remove(entry.mesh);
        this.obstaclesByRow.delete(row);
      }
    }
  }

  _decideNextMove() {
    const nextRow = this.rowIndex + 1;
    const blocked = this.obstaclesByRow.get(nextRow);

    if (blocked && blocked.lane === this.laneIndex) {
      let dodgeDir;
      let newLane;
      if (this.laneIndex === -1) {
        dodgeDir = RIGHT;
        newLane = 0;
      } else if (this.laneIndex === 1) {
        dodgeDir = LEFT;
        newLane = 0;
      } else {
        const goLeft = Math.random() < 0.5;
        dodgeDir = goLeft ? LEFT : RIGHT;
        newLane = goLeft ? -1 : 1;
      }
      this.laneIndex = newLane;
      this.dodges += 1;
      this.shape.startMove(dodgeDir);
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
      this.cameraOrbit.radius = Math.min(
        CAMERA_RADIUS_MAX,
        Math.max(CAMERA_RADIUS_MIN, this.cameraOrbit.radius + e.deltaY * ZOOM_SPEED)
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
    if (kind === 'forward') {
      const blocked = this.obstaclesByRow.get(this.rowIndex + 1);
      if (blocked && blocked.lane === this.laneIndex) return;
    }
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

  _updateCamera() {
    const p = this.shape.group.position;
    // Follow the shape's horizontal motion but pin the vertical anchor to its
    // resting height, so the arc it traces mid-tumble doesn't pitch the camera.
    const anchorY = this.apothem;
    const { theta, elevation, radius } = this.cameraOrbit;
    const horizontalRadius = radius * Math.cos(elevation);
    const targetCamPos = new THREE.Vector3(
      p.x + horizontalRadius * Math.sin(theta),
      anchorY + radius * Math.sin(elevation),
      p.z + horizontalRadius * Math.cos(theta)
    );
    this.camera.position.lerp(targetCamPos, this._dragging ? 0.35 : 0.12);
    this.camera.lookAt(p.x, anchorY, p.z);

    this.sun.position.set(p.x - 6, anchorY + 12, p.z + 8);
    this.sun.target.position.set(p.x, anchorY, p.z);
    this.sun.target.updateMatrixWorld();

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
        } else if (this.pendingGapMs > 0) {
          this.pendingGapMs -= dt;
        } else {
          this._decideNextMove();
        }
      }
      this.shape.update(dt);
      this.onStats({ distance: this.distance, dodges: this.dodges });
    }

    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
  }
}

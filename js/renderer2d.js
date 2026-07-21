// A flat, top-down 2D renderer that draws the *same* live game state as the
// 3D scene - it reads the shape's world position, the wall/obstacle meshes'
// positions and sizes, and the goal marker straight off the Game object, so
// the 2D and 3D views can never disagree about the layout. No game logic
// lives here: this only paints. Toggled on/off by the Game (Alt+3).
import * as THREE from 'three';

// Matches the 3D face palette (geometry.js PALETTE_HUES) so the shape reads as
// the same object in both views.
const PALETTE_HUES = [12, 38, 65, 150, 190, 222, 265, 320];
const SKY = '#dbe7f0';
const GROUND = '#a3aab8';
const WALL = '#8a8fa6';
const WALL_EDGE = '#6f7488';
const DIVIDER = '#f6f3ec';
const GOAL = '#35b88a';

export class Renderer2D {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    // Pixels per world unit. Map mode zooms out a touch so more of the maze
    // is visible around the shape.
    this.trackScale = 11;
    this.mapScale = 9;
    this._w = 0;
    this._h = 0;
    // Scratch objects reused each frame for the shape projection.
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._n = new THREE.Vector3();
    // Per-face fill, matching the 3D per-face palette (buildMesh in
    // geometry.js: hue = PALETTE_HUES[faceIndex % 8]).
    this._faceColors = null;
  }

  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;
  }

  render() {
    const g = this.game;
    const ctx = this.ctx;
    const W = this._w;
    const H = this._h;
    if (!W || !H) return;

    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, W, H);

    const isTrack = g.gameType === 'track';
    const leader = isTrack
      ? g.trackRacers.reduce((best, racer) => racer.row > best.row ? racer : best, g.trackRacers[0])
      : null;
    const shape = leader ? leader.shape : g.shape;
    const p = shape.group.position;
    const scale = isTrack
      ? Math.min(this.trackScale, (W * 0.92) / (g.laneWidth * 16))
      : Math.min(this.mapScale, (Math.min(W, H) * 0.86) / Math.max(
          g.mapGround?.geometry?.parameters?.width || 1,
          g.mapGround?.geometry?.parameters?.height || 1
        ));
    const originX = W / 2;
    // In track mode keep the shape low on screen so the road ahead is visible.
    const originY = isTrack ? H * 0.68 - p.z * scale : H / 2;
    const toX = (wx) => originX + wx * scale;
    const toY = (wz) => originY + wz * scale;

    if (isTrack) this._renderTrack(ctx, g, toX, toY, scale);
    else this._renderMap(ctx, g, toX, toY, scale);

    if (isTrack) {
      for (const racer of g.trackRacers) {
        const rp = racer.shape.group.position;
        this._drawShape(ctx, toX(rp.x), toY(rp.z), scale, racer.shape);
      }
    } else {
      for (const racer of g.mapRacers) {
        const rp = racer.shape.group.position;
        this._drawShape(ctx, toX(rp.x), toY(rp.z), scale, racer.shape);
      }
    }
  }

  _renderTrack(ctx, g, toX, toY, scale) {
    const W = this._w;
    const H = this._h;
    const laneWidth = g.laneWidth || 4;
    const halfRoad = (laneWidth * 16) / 2;

    // Road band (extends full height - the track is effectively endless).
    const roadL = toX(-halfRoad);
    const roadR = toX(halfRoad);
    ctx.fillStyle = GROUND;
    ctx.fillRect(roadL, 0, roadR - roadL, H);

    // Fifteen dividers form sixteen equal racing lanes.
    ctx.strokeStyle = DIVIDER;
    ctx.lineWidth = Math.max(1.5, scale * 0.14);
    ctx.setLineDash([scale * 1.6, scale * 1.1]);
    for (let i = 1; i < 16; i++) {
      const x = toX((i - 8) * laneWidth);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Obstacles - read position, size and colour straight off the 3D meshes.
    for (const { mesh } of g.obstacles) {
      const width = mesh.geometry.parameters.width * scale;
      const depth = mesh.geometry.parameters.depth * scale;
      const cx = toX(mesh.position.x);
      const cy = toY(mesh.position.z);
      if (cx < -width || cx > W + width || cy < -depth || cy > H + depth) continue;
      ctx.fillStyle = '#' + mesh.material.color.getHexString();
      this._roundRect(ctx, cx - width / 2, cy - depth / 2, width, depth, Math.min(width, depth) * 0.16);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,30,30,0.28)';
      ctx.lineWidth = Math.max(1, scale * 0.05);
      ctx.stroke();
    }

    for (const row of [0, g.trackLength]) {
      const y = toY(-row * g.forwardStep);
      ctx.strokeStyle = row === 0 ? '#ffffff' : '#222831';
      ctx.lineWidth = Math.max(3, scale * 0.3);
      ctx.setLineDash(row === 0 ? [] : [scale, scale]);
      ctx.beginPath();
      ctx.moveTo(roadL, y);
      ctx.lineTo(roadR, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _renderMap(ctx, g, toX, toY, scale) {
    // Ground rectangle (the maze floor).
    if (g.mapGround) {
      const gp = g.mapGround.geometry.parameters;
      const cx = toX(g.mapGround.position.x);
      const cy = toY(g.mapGround.position.z);
      ctx.fillStyle = GROUND;
      ctx.fillRect(cx - (gp.width * scale) / 2, cy - (gp.height * scale) / 2, gp.width * scale, gp.height * scale);
    }

    // Thin orthogonal walls outline many separate connected obstacle islands.
    ctx.strokeStyle = WALL_EDGE;
    ctx.lineWidth = 0.8;
    for (const wall of g.mapWalls) {
      const wp = wall.geometry.parameters;
      const w = wp.width * scale;
      const d = wp.depth * scale;
      const x = toX(wall.position.x) - w / 2;
      const y = toY(wall.position.z) - d / 2;
      ctx.fillStyle = '#' + wall.material.color.getHexString();
      ctx.fillRect(x, y, w, d);
      ctx.strokeRect(x, y, w, d);
    }

    // A* planned routes: one dotted colour per racer. Exploration mode has
    // no precomputed route, so it intentionally draws no dots.
    if (g.mapStrategy === 'path') {
      for (const racer of g.mapRacers) {
        if (!racer.path || racer.status === 'reached') continue;
        const color = '#' + racer.pathColor.getHexString();
        const radius = Math.max(3, g.forwardStep * scale * 0.16);
        for (const cell of racer.path.slice(1)) {
          const x = toX(g._mapWorldX(cell.fx));
          const y = toY(g._mapWorldZ(cell.fy));
          ctx.globalAlpha = 0.22;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, radius * 1.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.96;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // Goal marker.
    if (g.mapGoalMarker) {
      const r = g.mapGoalMarker.geometry.parameters.radius * scale;
      const cx = toX(g.mapGoalMarker.position.x);
      const cy = toY(g.mapGoalMarker.position.z);
      ctx.fillStyle = GOAL;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = Math.max(1.5, scale * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Draws the true top-down orthographic projection of the 3D shape at its
  // current orientation: every face's vertices are rotated by the live
  // quaternion, projected onto the ground plane (x, z), and the faces pointing
  // up toward the overhead camera are painted with their real colours. This
  // reproduces the exact pattern seen from directly above - all 72 resting
  // patterns (18 square faces x 4 rotations) plus every in-between tumble
  // frame - with no sprite table.
  _drawShape(ctx, cx, cy, scale, rollingShape) {
    const g = this.game;
    const rhombi = g.rhombi;
    if (!rhombi) return;

    if (!this._faceColors) {
      const c = new THREE.Color();
      this._faceColors = rhombi.faces.map((_, fi) => {
        c.setHSL(PALETTE_HUES[fi % PALETTE_HUES.length] / 360, 0.62, 0.72);
        return '#' + c.getHexString();
      });
    }

    const q = this._q.copy(rollingShape.group.quaternion);
    const apothem = g.apothem;

    // Contact shadow (roughly the resting silhouette footprint).
    ctx.beginPath();
    ctx.ellipse(cx, cy + apothem * scale * 0.12, apothem * scale * 1.05, apothem * scale * 0.98, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,30,45,0.14)';
    ctx.fill();

    // Collect the faces whose transformed normal points up (+y = toward the
    // overhead camera); for a convex solid these tile the silhouette exactly.
    const visible = [];
    for (let fi = 0; fi < rhombi.faces.length; fi++) {
      const face = rhombi.faces[fi];
      const ny = this._n.copy(face.normal).applyQuaternion(q).y;
      if (ny <= 0.0001) continue;
      const pts = face.idxs.map((vi) => {
        const v = this._v.copy(rhombi.vertices[vi]).applyQuaternion(q);
        return [cx + v.x * scale, cy + v.z * scale];
      });
      // Depth = transformed centroid height; draw lowest first so the topmost
      // faces land on top if any projected overlap occurs.
      const cyd = this._v.copy(face.centroid).applyQuaternion(q).y;
      visible.push({ pts, fi, depth: cyd });
    }
    visible.sort((a, b) => a.depth - b.depth);

    for (const { pts, fi } of visible) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.closePath();
      ctx.fillStyle = this._faceColors[fi];
      ctx.fill();
      ctx.lineWidth = Math.max(0.6, scale * 0.03);
      ctx.strokeStyle = 'rgba(55,55,70,0.32)';
      ctx.stroke();
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

// A flat, top-down 2D renderer that draws the *same* live game state as the
// 3D scene - it reads the shape's world position, the wall/obstacle meshes'
// positions and sizes, and the goal marker straight off the Game object, so
// the 2D and 3D views can never disagree about the layout. No game logic
// lives here: this only paints. Toggled on/off by the Game (Alt+3).

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
    this._roll = 0;
    this._lastX = null;
    this._lastZ = null;
    this._w = 0;
    this._h = 0;
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

    const p = g.shape.group.position;
    // Accumulate a "rolling" angle from the shape's horizontal travel - purely
    // cosmetic, so the top-down icon visibly spins as it crosses cells.
    if (this._lastX !== null) {
      this._roll += Math.hypot(p.x - this._lastX, p.z - this._lastZ);
    }
    this._lastX = p.x;
    this._lastZ = p.z;

    const isTrack = g.gameType === 'track';
    const scale = isTrack ? this.trackScale : this.mapScale;
    const originX = W / 2 - p.x * scale;
    // In track mode keep the shape low on screen so the road ahead is visible.
    const originY = (isTrack ? H * 0.68 : H / 2) - p.z * scale;
    const toX = (wx) => originX + wx * scale;
    const toY = (wz) => originY + wz * scale;

    if (isTrack) this._renderTrack(ctx, g, toX, toY, scale);
    else this._renderMap(ctx, g, toX, toY, scale);

    // Roll a quarter turn per double-tumble (one cell), matching the 3D motion.
    const rollAngle = (this._roll / g.forwardStep) * (Math.PI / 2);
    this._drawShape(ctx, toX(p.x), toY(p.z), g.apothem * scale, rollAngle);
  }

  _renderTrack(ctx, g, toX, toY, scale) {
    const W = this._w;
    const H = this._h;
    const laneWidth = g.laneWidth || 4;
    const halfRoad = (laneWidth * 3) / 2; // LANES = [-1, 0, 1]

    // Road band (extends full height - the track is effectively endless).
    const roadL = toX(-halfRoad);
    const roadR = toX(halfRoad);
    ctx.fillStyle = GROUND;
    ctx.fillRect(roadL, 0, roadR - roadL, H);

    // Lane dividers at +-0.5 lane-widths.
    ctx.strokeStyle = DIVIDER;
    ctx.lineWidth = Math.max(1.5, scale * 0.14);
    ctx.setLineDash([scale * 1.6, scale * 1.1]);
    for (const off of [-0.5, 0.5]) {
      const x = toX(off * laneWidth);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Obstacles - read position, size and colour straight off the 3D meshes.
    for (const { mesh } of g.obstaclesByRow.values()) {
      const size = mesh.geometry.parameters.width * scale;
      const cx = toX(mesh.position.x);
      const cy = toY(mesh.position.z);
      if (cx < -size || cx > W + size || cy < -size || cy > H + size) continue;
      ctx.fillStyle = '#' + mesh.material.color.getHexString();
      this._roundRect(ctx, cx - size / 2, cy - size / 2, size, size, size * 0.16);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,30,30,0.28)';
      ctx.lineWidth = Math.max(1, scale * 0.05);
      ctx.stroke();
    }
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

    // Walls - each mesh's top-down footprint is (width x depth) at (x, z).
    ctx.fillStyle = WALL;
    ctx.strokeStyle = WALL_EDGE;
    ctx.lineWidth = 1;
    for (const wall of g.mapWalls) {
      const wp = wall.geometry.parameters;
      const w = wp.width * scale;
      const d = wp.depth * scale;
      const x = toX(wall.position.x) - w / 2;
      const y = toY(wall.position.z) - d / 2;
      ctx.fillRect(x, y, w, d);
      ctx.strokeRect(x, y, w, d);
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

  _drawShape(ctx, cx, cy, r, rot) {
    // Contact shadow.
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.12, r * 1.04, r * 0.98, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,30,45,0.14)';
    ctx.fill();

    const N = 8;
    const base = rot + Math.PI / 8; // flat edge faces forward
    // Rainbow wedges, echoing the 3D per-face palette.
    for (let i = 0; i < N; i++) {
      const a0 = base + (i * 2 * Math.PI) / N;
      const a1 = base + ((i + 1) * 2 * Math.PI) / N;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
      ctx.lineTo(cx + r * Math.cos(a1), cy + r * Math.sin(a1));
      ctx.closePath();
      ctx.fillStyle = `hsl(${PALETTE_HUES[i]}, 62%, 72%)`;
      ctx.fill();
    }

    // Octagon outline.
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const a = base + (i * 2 * Math.PI) / N;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.strokeStyle = 'rgba(55,55,70,0.4)';
    ctx.stroke();
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

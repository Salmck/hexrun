import * as THREE from 'three';

const DOWN = new THREE.Vector3(0, -1, 0);

// Drives a rhombicuboctahedron mesh through physically-derived tumbles: each
// tumble pivots the solid about the ground-contact edge that faces the given
// direction, rotating exactly far enough to bring the next face flat against
// the ground. Two tumbles in the same direction always land back on one of
// the 6 axis-aligned "primary" squares (never a diagonal square or a
// triangle) - that's what keeps the shape looking upright every other step.
export class RollingShape {
  constructor(rhombi, group, { tumbleDuration = 260, pauseBetween = 60 } = {}) {
    this.rhombi = rhombi;
    this.group = group;
    this.tumbleDuration = tumbleDuration;
    this.pauseBetween = pauseBetween;

    this.phase = 'idle'; // 'idle' | 'tumbling' | 'pausing'
    this.tip = null;
    this.tipStartPos = new THREE.Vector3();
    this.tipStartQuat = new THREE.Quaternion();
    this.elapsed = 0;
    this.tumblesRemaining = 0;
    this.dir = null;
    this.pauseElapsed = 0;
    this.onMoveComplete = null;
    this.onTumble = null;
  }

  isBusy() {
    return this.phase !== 'idle';
  }

  worldNormal(faceIdx, quat) {
    return this.rhombi.faces[faceIdx].normal.clone().applyQuaternion(quat);
  }

  bottomFaceIndex(quat) {
    let best = -1;
    let bestDot = -Infinity;
    this.rhombi.faces.forEach((f, fi) => {
      const d = this.worldNormal(fi, quat).dot(DOWN);
      if (d > bestDot) {
        bestDot = d;
        best = fi;
      }
    });
    return best;
  }

  leadingEdge(faceIdx, pos, quat, dir) {
    const { vertices, faces, edgeKey } = this.rhombi;
    const f = faces[faceIdx];
    const worldCentroid = f.centroid.clone().applyQuaternion(quat).add(pos);
    let best = null;
    let bestScore = -Infinity;
    for (let k = 0; k < f.idxs.length; k++) {
      const i = f.idxs[k];
      const j = f.idxs[(k + 1) % f.idxs.length];
      const pi = vertices[i].clone().applyQuaternion(quat).add(pos);
      const pj = vertices[j].clone().applyQuaternion(quat).add(pos);
      const mid = pi.add(pj).multiplyScalar(0.5);
      const score = mid.sub(worldCentroid).dot(dir);
      if (score > bestScore) {
        bestScore = score;
        best = { i, j, key: edgeKey(i, j) };
      }
    }
    return best;
  }

  // Computes the rotation (axis, pivot point, angle) for a single tumble
  // starting from the given pos/quat, tipping toward world-space `dir`.
  computeTip(pos, quat, dir) {
    const bottomIdx = this.bottomFaceIndex(quat);
    const edge = this.leadingEdge(bottomIdx, pos, quat, dir);
    const candidates = this.rhombi.edgeAdjacency
      .get(edge.key)
      .filter((fi) => fi !== bottomIdx);
    const newFaceIdx = candidates[0];

    const n1 = this.worldNormal(bottomIdx, quat);
    const n2 = this.worldNormal(newFaceIdx, quat);

    const { vertices } = this.rhombi;
    const pi = vertices[edge.i].clone().applyQuaternion(quat).add(pos);
    const pj = vertices[edge.j].clone().applyQuaternion(quat).add(pos);
    const axis = pj.sub(pi).normalize();
    const pivot = pi;

    const cross = n2.clone().cross(n1);
    const angle = Math.atan2(axis.dot(cross), n2.dot(n1));

    return { axis, pivot, angle, bottomIdx, newFaceIdx };
  }

  applyTipFraction(startPos, startQuat, tip, t) {
    const q = new THREE.Quaternion().setFromAxisAngle(tip.axis, tip.angle * t);
    const pos = tip.pivot
      .clone()
      .add(startPos.clone().sub(tip.pivot).applyQuaternion(q));
    const quat = q.clone().multiply(startQuat);
    return { pos, quat };
  }

  // Kicks off a move of `tumbleCount` tumbles (two by default, the normal
  // one-block-step move) in world-space direction `dir` (must be a
  // horizontal unit vector). No-op if a move is already playing.
  startMove(dir, tumbleCount = 2) {
    if (this.isBusy()) return false;
    this.dir = dir.clone();
    this.tumblesRemaining = tumbleCount;
    this._beginTumble();
    return true;
  }

  _beginTumble() {
    this.tipStartPos.copy(this.group.position);
    this.tipStartQuat.copy(this.group.quaternion);
    this.tip = this.computeTip(this.tipStartPos, this.tipStartQuat, this.dir);
    this.phase = 'tumbling';
    this.elapsed = 0;
  }

  update(dt) {
    if (this.phase === 'tumbling') {
      this.elapsed += dt;
      const t = Math.min(1, this.elapsed / this.tumbleDuration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const { pos, quat } = this.applyTipFraction(
        this.tipStartPos,
        this.tipStartQuat,
        this.tip,
        eased
      );
      this.group.position.copy(pos);
      this.group.quaternion.copy(quat);

      if (t >= 1) {
        this.tumblesRemaining -= 1;
        if (this.onTumble) this.onTumble();
        if (this.tumblesRemaining > 0) {
          this.phase = 'pausing';
          this.pauseElapsed = 0;
        } else {
          this.phase = 'idle';
          if (this.onMoveComplete) this.onMoveComplete();
        }
      }
    } else if (this.phase === 'pausing') {
      this.pauseElapsed += dt;
      if (this.pauseElapsed >= this.pauseBetween) {
        this._beginTumble();
      }
    }
  }
}

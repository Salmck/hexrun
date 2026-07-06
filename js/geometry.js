import * as THREE from 'three';

// Builds a small rhombicuboctahedron: 24 vertices, 26 faces
// (6 axis-aligned "primary" squares, 12 diagonal "small" squares, 8 triangles),
// 48 edges. Construction follows the canonical vertex set: all permutations
// of (+-1, +-1, +-(1+sqrt(2))).
//
// Returns face polygons already wound counter-clockwise as seen from outside,
// plus a vertex-pair -> [faceIndex, faceIndex] adjacency map used by the
// rolling logic to find the face on the other side of any edge.
export function buildRhombicuboctahedron(scale = 1) {
  const t = 1 + Math.SQRT2;

  const rawVerts = [];
  for (let largeAxis = 0; largeAxis < 3; largeAxis++) {
    const others = [0, 1, 2].filter((a) => a !== largeAxis);
    for (const largeSign of [1, -1]) {
      for (const s0 of [1, -1]) {
        for (const s1 of [1, -1]) {
          const signs = [0, 0, 0];
          signs[largeAxis] = largeSign;
          signs[others[0]] = s0;
          signs[others[1]] = s1;
          const coords = [0, 0, 0];
          coords[largeAxis] = largeSign * t;
          coords[others[0]] = s0;
          coords[others[1]] = s1;
          rawVerts.push({ coords, largeAxis, signs });
        }
      }
    }
  }

  function findVertex(largeAxis, signs) {
    const idx = rawVerts.findIndex(
      (v) =>
        v.largeAxis === largeAxis &&
        v.signs[0] === signs[0] &&
        v.signs[1] === signs[1] &&
        v.signs[2] === signs[2]
    );
    if (idx < 0) throw new Error('vertex lookup failed');
    return idx;
  }

  const rawFaces = [];

  // 6 primary squares: one axis pinned to +-t, the other two range over +-1.
  for (let a = 0; a < 3; a++) {
    const others = [0, 1, 2].filter((x) => x !== a);
    for (const sa of [1, -1]) {
      const idxs = new Set();
      for (const s0 of [1, -1]) {
        for (const s1 of [1, -1]) {
          const signs = [0, 0, 0];
          signs[a] = sa;
          signs[others[0]] = s0;
          signs[others[1]] = s1;
          idxs.add(findVertex(a, signs));
        }
      }
      rawFaces.push({ type: 'primary', idxs: [...idxs] });
    }
  }

  // 12 small (diagonal) squares: bridge two axes a<b at fixed signs sa, sb.
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const c = [0, 1, 2].find((x) => x !== a && x !== b);
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          const idxs = new Set();
          for (const sc of [1, -1]) {
            const signs = [0, 0, 0];
            signs[a] = sa;
            signs[b] = sb;
            signs[c] = sc;
            idxs.add(findVertex(a, signs));
            idxs.add(findVertex(b, signs));
          }
          rawFaces.push({ type: 'small', idxs: [...idxs] });
        }
      }
    }
  }

  // 8 triangles: one per octant sign-combo, one vertex per choice of large axis.
  for (const s0 of [1, -1]) {
    for (const s1 of [1, -1]) {
      for (const s2 of [1, -1]) {
        const signs = [s0, s1, s2];
        const idxs = [0, 1, 2].map((k) => findVertex(k, signs));
        rawFaces.push({ type: 'triangle', idxs });
      }
    }
  }

  const vertices = rawVerts.map(
    (v) => new THREE.Vector3(...v.coords).multiplyScalar(scale)
  );

  // Order each face's vertices into a proper CCW (outward-facing) loop and
  // compute its plane normal + centroid.
  const faces = rawFaces.map((f) => {
    const pts = f.idxs.map((i) => vertices[i]);
    const centroid = new THREE.Vector3();
    pts.forEach((p) => centroid.add(p));
    centroid.divideScalar(pts.length);

    const planeNormalGuess = new THREE.Vector3()
      .subVectors(pts[1], pts[0])
      .cross(new THREE.Vector3().subVectors(pts[2], pts[0]))
      .normalize();
    const u = new THREE.Vector3().subVectors(pts[0], centroid).normalize();
    const v = new THREE.Vector3().crossVectors(planeNormalGuess, u);

    const ordered = f.idxs
      .map((idx, k) => {
        const rel = new THREE.Vector3().subVectors(pts[k], centroid);
        return { idx, ang: Math.atan2(rel.dot(v), rel.dot(u)) };
      })
      .sort((a, b) => a.ang - b.ang)
      .map((o) => o.idx);

    let normal = new THREE.Vector3();
    for (let k = 0; k < ordered.length; k++) {
      const p1 = vertices[ordered[k]];
      const p2 = vertices[ordered[(k + 1) % ordered.length]];
      normal.x += (p1.y - p2.y) * (p1.z + p2.z);
      normal.y += (p1.z - p2.z) * (p1.x + p2.x);
      normal.z += (p1.x - p2.x) * (p1.y + p2.y);
    }
    normal.normalize();
    if (normal.dot(centroid) < 0) {
      ordered.reverse();
      normal.negate();
    }

    return { type: f.type, idxs: ordered, normal, centroid };
  });

  const edgeAdjacency = new Map();
  const edgeKey = (i, j) => (i < j ? `${i}_${j}` : `${j}_${i}`);
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.idxs.length; k++) {
      const i = f.idxs[k];
      const j = f.idxs[(k + 1) % f.idxs.length];
      const key = edgeKey(i, j);
      if (!edgeAdjacency.has(key)) edgeAdjacency.set(key, []);
      edgeAdjacency.get(key).push(fi);
    }
  });

  const apothem = faces.find((f) => f.type === 'primary').centroid.length();

  return { vertices, faces, edgeAdjacency, edgeKey, apothem };
}

// Palette loosely inspired by the reference small-rhombicuboctahedron
// illustration: soft, slightly desaturated pastels.
const PALETTE = [
  0xe8b7a0, // peach
  0xd9c9e6, // lavender
  0xf3ead2, // cream
  0xc9b8d8, // mauve
  0xb9c4d6, // powder blue
  0xead9c9, // sand
  0xd8c3cf, // dusty pink
  0xc7d3c0, // sage
];

export function buildMesh(rhombi) {
  const { vertices, faces } = rhombi;
  const positions = [];
  const normals = [];
  const colors = [];
  const color = new THREE.Color();

  faces.forEach((f, fi) => {
    const tris = f.idxs.length === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
    color.setHex(PALETTE[fi % PALETTE.length]);
    for (const tri of tris) {
      for (const localIdx of tri) {
        const p = vertices[f.idxs[localIdx]];
        positions.push(p.x, p.y, p.z);
        normals.push(f.normal.x, f.normal.y, f.normal.z);
        colors.push(color.r, color.g, color.b);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.6,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geometry, material);

  const edgeGeom = new THREE.EdgesGeometry(geometry, 1);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x2b2320 });
  const edges = new THREE.LineSegments(edgeGeom, edgeMat);

  const group = new THREE.Group();
  group.add(mesh);
  group.add(edges);
  return group;
}

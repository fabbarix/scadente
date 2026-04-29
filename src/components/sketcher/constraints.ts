// 2D constraint system for the sketcher.
//
// Parameter encoding: shapes are flattened into one Float64Array `x`. Each
// shape's parameters land at a fixed offset stored in the layout map:
//   line:     [x1, y1, x2, y2]
//   circle:   [cx, cy, radius]
//   rect:     [x, y, width, height]
//   polyline: [v0.x, v0.y, v1.x, v1.y, ...]
//
// Constraints contribute scalar residuals. The solver runs Levenberg-Marquardt
// over (J^T J + λI) Δx = -J^T f using a finite-difference Jacobian. Sufficient
// for v1 sketches (≤ 30 entities, ≤ 20 constraints). When budget bites, swap in
// analytic Jacobians per constraint.
//
// P1 implements: horizontal, vertical, fix, coincident, distance, length.

import type { SketcherShape } from '../Sketcher';

export type EntityRef =
  | {
      kind: 'point';
      shapeId: string;
      role: 'p1' | 'p2' | 'tl' | 'tr' | 'br' | 'bl' | 'center' | 'vertex';
      vertexIdx?: number;
    }
  | { kind: 'line'; shapeId: string }
  | { kind: 'edge'; shapeId: string; edge: 'top' | 'bottom' | 'left' | 'right' }
  | { kind: 'circle'; shapeId: string };

export type ConstraintType =
  | 'horizontal'
  | 'vertical'
  | 'fix'
  | 'coincident'
  | 'parallel'
  | 'perpendicular'
  | 'equal-length'
  | 'equal-radius'
  | 'concentric'
  | 'tangent'
  | 'symmetry'
  | 'midpoint'
  | 'distance'
  | 'length'
  | 'radius'
  | 'angle'
  // Pin a single coordinate of a point. Used by the property-panel
  // auto-locking flow so the user can lock just X or just Y.
  | 'coord-x'
  | 'coord-y';

export interface DimensionAnnotation {
  /** Perpendicular offset from the entity-pair midline to where the dimension
   *  line is drawn, in plane-local mm. Sign determines side. */
  offset: number;
  /** Position of the value label along the dimension line, 0..1 fraction
   *  (0 = near a-end, 0.5 = middle, 1 = near b-end). May exceed [0,1]
   *  to push the label outside the extension lines. */
  labelT: number;
  /** Perpendicular offset of the label from the dimension line, in mm.
   *  Lets the user nudge the value text off the line so it doesn't overlap. */
  labelP?: number;
}

interface ConstraintBase {
  /** Optional user-provided label, shown in the constraints panel. */
  name?: string;
  /** When set, identifies the property-panel field this constraint locks
   *  (e.g. `r1.width`, `c1.cx`). The field-locking UI uses it to detect
   *  whether a NumField is locked and to update / remove the right
   *  constraint when the user types a new value or unlocks. */
  field?: string;
}

export type Constraint =
  // Geometric (single-entity)
  | (ConstraintBase & { id: string; type: 'horizontal' | 'vertical'; ref: EntityRef })
  | (ConstraintBase & { id: string; type: 'fix'; ref: EntityRef; value: { x: number; y: number } })
  // Geometric (pair)
  | (ConstraintBase & {
      id: string;
      type:
        | 'coincident'
        | 'parallel'
        | 'perpendicular'
        | 'equal-length'
        | 'equal-radius'
        | 'concentric'
        | 'tangent';
      a: EntityRef;
      b: EntityRef;
    })
  | (ConstraintBase & { id: string; type: 'midpoint'; point: EntityRef; line: EntityRef })
  | (ConstraintBase & { id: string; type: 'symmetry'; a: EntityRef; b: EntityRef; axis: EntityRef })
  // Dimensional
  | (ConstraintBase & {
      id: string;
      type: 'distance';
      // Supported pairings:
      //   line/edge + line/edge (must be parallel — perpendicular distance)
      //   point + line/edge (any direction — perpendicular distance from
      //   point to the line carrying the segment)
      a: EntityRef;
      b: EntityRef;
      value: number;
      /** Optional. Missing means a sensible default is computed at render time. */
      annotation?: DimensionAnnotation;
    })
  | (ConstraintBase & { id: string; type: 'length' | 'radius'; ref: EntityRef; value: number })
  | (ConstraintBase & { id: string; type: 'angle'; a: EntityRef; b: EntityRef; value: number })
  | (ConstraintBase & {
      id: string;
      type: 'coord-x' | 'coord-y';
      ref: EntityRef;
      value: number;
    });

// ────────────────────────────────────────────────────────────────────────────
// Parameter layout
// ────────────────────────────────────────────────────────────────────────────

interface ShapeBlock {
  shape: SketcherShape;
  offset: number;
  count: number;
}

export interface Layout {
  blocks: Map<string, ShapeBlock>;
  totalParams: number;
}

const blockSize = (s: SketcherShape): number => {
  if (s.type === 'rect') return 4;
  if (s.type === 'rounded-rect') return 5; // x, y, w, h, cornerRadius
  if (s.type === 'circle') return 3;
  if (s.type === 'arc') return 5; // cx, cy, radius, startAngle, endAngle
  if (s.type === 'line') return 4;
  return s.points.length * 2;
};

export const makeLayout = (shapes: SketcherShape[]): Layout => {
  const blocks = new Map<string, ShapeBlock>();
  let offset = 0;
  for (const s of shapes) {
    const count = blockSize(s);
    blocks.set(s.id, { shape: s, offset, count });
    offset += count;
  }
  return { blocks, totalParams: offset };
};

export const packShapes = (shapes: SketcherShape[], layout: Layout): Float64Array => {
  const x = new Float64Array(layout.totalParams);
  for (const s of shapes) {
    const b = layout.blocks.get(s.id)!;
    const o = b.offset;
    if (s.type === 'rect') {
      x[o] = s.x;
      x[o + 1] = s.y;
      x[o + 2] = s.width;
      x[o + 3] = s.height;
    } else if (s.type === 'rounded-rect') {
      x[o] = s.x;
      x[o + 1] = s.y;
      x[o + 2] = s.width;
      x[o + 3] = s.height;
      x[o + 4] = s.cornerRadius;
    } else if (s.type === 'circle') {
      x[o] = s.cx;
      x[o + 1] = s.cy;
      x[o + 2] = s.radius;
    } else if (s.type === 'arc') {
      x[o] = s.cx;
      x[o + 1] = s.cy;
      x[o + 2] = s.radius;
      x[o + 3] = s.startAngle;
      x[o + 4] = s.endAngle;
    } else if (s.type === 'line') {
      x[o] = s.x1;
      x[o + 1] = s.y1;
      x[o + 2] = s.x2;
      x[o + 3] = s.y2;
    } else {
      for (let i = 0; i < s.points.length; i++) {
        x[o + i * 2] = s.points[i].x;
        x[o + i * 2 + 1] = s.points[i].y;
      }
    }
  }
  return x;
};

export const unpackShapes = (x: Float64Array, layout: Layout): SketcherShape[] => {
  const out: SketcherShape[] = [];
  for (const b of layout.blocks.values()) {
    const o = b.offset;
    const s = b.shape;
    if (s.type === 'rect') {
      out.push({ ...s, x: x[o], y: x[o + 1], width: x[o + 2], height: x[o + 3] });
    } else if (s.type === 'rounded-rect') {
      out.push({
        ...s,
        x: x[o],
        y: x[o + 1],
        width: x[o + 2],
        height: x[o + 3],
        cornerRadius: x[o + 4],
      });
    } else if (s.type === 'circle') {
      out.push({ ...s, cx: x[o], cy: x[o + 1], radius: x[o + 2] });
    } else if (s.type === 'arc') {
      out.push({
        ...s,
        cx: x[o],
        cy: x[o + 1],
        radius: x[o + 2],
        startAngle: x[o + 3],
        endAngle: x[o + 4],
      });
    } else if (s.type === 'line') {
      out.push({ ...s, x1: x[o], y1: x[o + 1], x2: x[o + 2], y2: x[o + 3] });
    } else {
      const points = s.points.map((_, i) => ({ x: x[o + i * 2], y: x[o + i * 2 + 1] }));
      out.push({ ...s, points });
    }
  }
  return out;
};

// ────────────────────────────────────────────────────────────────────────────
// Reading entities out of x
// ────────────────────────────────────────────────────────────────────────────

interface Pt2 {
  x: number;
  y: number;
}

const blockOf = (ref: EntityRef, layout: Layout): ShapeBlock | null =>
  layout.blocks.get(ref.shapeId) ?? null;

const getPoint = (ref: EntityRef, x: Float64Array, layout: Layout): Pt2 | null => {
  if (ref.kind !== 'point') return null;
  const b = blockOf(ref, layout);
  if (!b) return null;
  const o = b.offset;
  const s = b.shape;
  if (s.type === 'line') {
    if (ref.role === 'p1') return { x: x[o], y: x[o + 1] };
    if (ref.role === 'p2') return { x: x[o + 2], y: x[o + 3] };
  } else if (s.type === 'circle') {
    if (ref.role === 'center') return { x: x[o], y: x[o + 1] };
  } else if (s.type === 'arc') {
    const acx = x[o];
    const acy = x[o + 1];
    const ar = x[o + 2];
    const sA = x[o + 3];
    const eA = x[o + 4];
    if (ref.role === 'center') return { x: acx, y: acy };
    if (ref.role === 'p1') return { x: acx + ar * Math.cos(sA), y: acy + ar * Math.sin(sA) };
    if (ref.role === 'p2') return { x: acx + ar * Math.cos(eA), y: acy + ar * Math.sin(eA) };
  } else if (s.type === 'rect' || s.type === 'rounded-rect') {
    const rx = x[o];
    const ry = x[o + 1];
    const w = x[o + 2];
    const h = x[o + 3];
    if (ref.role === 'tl') return { x: rx, y: ry + h };
    if (ref.role === 'tr') return { x: rx + w, y: ry + h };
    if (ref.role === 'br') return { x: rx + w, y: ry };
    if (ref.role === 'bl') return { x: rx, y: ry };
    if (ref.role === 'center') return { x: rx + w / 2, y: ry + h / 2 };
  } else if (s.type === 'polyline' && ref.role === 'vertex' && ref.vertexIdx != null) {
    return { x: x[o + ref.vertexIdx * 2], y: x[o + ref.vertexIdx * 2 + 1] };
  }
  return null;
};

const getLineEnds = (
  ref: EntityRef,
  x: Float64Array,
  layout: Layout
): { p1: Pt2; p2: Pt2 } | null => {
  const b = blockOf(ref, layout);
  if (!b) return null;
  const o = b.offset;
  const s = b.shape;
  if (ref.kind === 'line' && s.type === 'line') {
    return {
      p1: { x: x[o], y: x[o + 1] },
      p2: { x: x[o + 2], y: x[o + 3] },
    };
  }
  if (ref.kind === 'edge' && (s.type === 'rect' || s.type === 'rounded-rect')) {
    const rx = x[o];
    const ry = x[o + 1];
    const w = x[o + 2];
    const h = x[o + 3];
    if (ref.edge === 'top') return { p1: { x: rx, y: ry + h }, p2: { x: rx + w, y: ry + h } };
    if (ref.edge === 'bottom') return { p1: { x: rx, y: ry }, p2: { x: rx + w, y: ry } };
    if (ref.edge === 'left') return { p1: { x: rx, y: ry }, p2: { x: rx, y: ry + h } };
    if (ref.edge === 'right') return { p1: { x: rx + w, y: ry }, p2: { x: rx + w, y: ry + h } };
  }
  return null;
};

// ────────────────────────────────────────────────────────────────────────────
// Distance helpers (cover all entity pair combos: point/line/edge/circle)
// ────────────────────────────────────────────────────────────────────────────

const signedPerpDist = (
  p: Pt2,
  line: { p1: Pt2; p2: Pt2 }
): number => {
  const dx = line.p2.x - line.p1.x;
  const dy = line.p2.y - line.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x - line.p1.x, p.y - line.p1.y);
  // (p - p1) × (p2 - p1) / |p2 - p1|
  return ((p.x - line.p1.x) * dy - (p.y - line.p1.y) * dx) / len;
};

/** Read (center, radius) for a `circle` ref. Treats `arc` shapes as circles
 *  for tangency / radius constraints — they share the center + radius
 *  parameters. Returns null when the ref doesn't point at a circle / arc. */
const getCircle = (
  ref: EntityRef,
  x: Float64Array,
  layout: Layout
): { center: Pt2; radius: number } | null => {
  if (ref.kind !== 'circle') return null;
  const b = blockOf(ref, layout);
  if (!b) return null;
  const o = b.offset;
  if (b.shape.type === 'circle') {
    return { center: { x: x[o], y: x[o + 1] }, radius: x[o + 2] };
  }
  if (b.shape.type === 'arc') {
    return { center: { x: x[o], y: x[o + 1] }, radius: x[o + 2] };
  }
  return null;
};

// ────────────────────────────────────────────────────────────────────────────
// Residuals
// ────────────────────────────────────────────────────────────────────────────

const residualOf = (c: Constraint, x: Float64Array, layout: Layout): number[] => {
  switch (c.type) {
    case 'horizontal': {
      const e = getLineEnds(c.ref, x, layout);
      return e ? [e.p2.y - e.p1.y] : [];
    }
    case 'vertical': {
      const e = getLineEnds(c.ref, x, layout);
      return e ? [e.p2.x - e.p1.x] : [];
    }
    case 'fix': {
      const p = getPoint(c.ref, x, layout);
      if (!p) return [];
      return [p.x - c.value.x, p.y - c.value.y];
    }
    case 'coincident': {
      const a = getPoint(c.a, x, layout);
      const b = getPoint(c.b, x, layout);
      if (!a || !b) return [];
      return [a.x - b.x, a.y - b.y];
    }
    case 'distance': {
      // Three pairings are supported:
      //   line + line: perpendicular distance from midpoint(a) onto b. The
      //     creator enforces parallelism so this matches the gap.
      //   point + line: perpendicular distance from the point onto the line.
      //   point + point: euclidean distance between the two points.
      const lineA = getLineEnds(c.a, x, layout);
      const lineB = getLineEnds(c.b, x, layout);
      if (lineA && lineB) {
        const midA = {
          x: (lineA.p1.x + lineA.p2.x) / 2,
          y: (lineA.p1.y + lineA.p2.y) / 2,
        };
        return [Math.abs(signedPerpDist(midA, lineB)) - c.value];
      }
      const pointA = getPoint(c.a, x, layout);
      const pointB = getPoint(c.b, x, layout);
      if (pointA && pointB) {
        const dx = pointA.x - pointB.x;
        const dy = pointA.y - pointB.y;
        return [Math.hypot(dx, dy) - c.value];
      }
      if (pointA && lineB) {
        return [Math.abs(signedPerpDist(pointA, lineB)) - c.value];
      }
      if (lineA && pointB) {
        return [Math.abs(signedPerpDist(pointB, lineA)) - c.value];
      }
      return [];
    }
    case 'length': {
      const e = getLineEnds(c.ref, x, layout);
      if (!e) return [];
      const dx = e.p2.x - e.p1.x;
      const dy = e.p2.y - e.p1.y;
      return [dx * dx + dy * dy - c.value * c.value];
    }
    case 'radius': {
      // Pin a circle's (or arc's) radius. Layout: [cx, cy, r, …].
      const b = blockOf(c.ref, layout);
      if (
        !b ||
        c.ref.kind !== 'circle' ||
        (b.shape.type !== 'circle' && b.shape.type !== 'arc')
      )
        return [];
      return [x[b.offset + 2] - c.value];
    }
    case 'tangent': {
      // Tangency between a line/edge and a circle/arc: the perpendicular
      // distance from the circle center to the line equals the radius.
      // The Sketcher normalizes refs so `a` is the line/edge and `b` is
      // the circle, but we accept either ordering for robustness.
      let lineRef: EntityRef = c.a;
      let circleRef: EntityRef = c.b;
      if (lineRef.kind === 'circle') {
        lineRef = c.b;
        circleRef = c.a;
      }
      const line = getLineEnds(lineRef, x, layout);
      const cir = getCircle(circleRef, x, layout);
      if (!line || !cir) return [];
      const d = Math.abs(signedPerpDist(cir.center, line));
      return [d - cir.radius];
    }
    case 'coord-x': {
      const p = getPoint(c.ref, x, layout);
      return p ? [p.x - c.value] : [];
    }
    case 'coord-y': {
      const p = getPoint(c.ref, x, layout);
      return p ? [p.y - c.value] : [];
    }
    default:
      return []; // unimplemented in P1
  }
};

const residualVector = (
  constraints: Constraint[],
  x: Float64Array,
  layout: Layout
): Float64Array => {
  const out: number[] = [];
  for (const c of constraints) {
    const r = residualOf(c, x, layout);
    for (const v of r) out.push(v);
  }
  return Float64Array.from(out);
};

const residualNormSq = (f: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return s;
};

// ────────────────────────────────────────────────────────────────────────────
// Finite-difference Jacobian and LM step
// ────────────────────────────────────────────────────────────────────────────

const EPS = 1e-6;

const jacobian = (
  constraints: Constraint[],
  x: Float64Array,
  layout: Layout,
  baseF: Float64Array
): Float64Array => {
  const n = x.length;
  const m = baseF.length;
  const J = new Float64Array(m * n);
  const xp = x.slice();
  for (let j = 0; j < n; j++) {
    const orig = xp[j];
    const h = Math.max(EPS, EPS * Math.abs(orig));
    xp[j] = orig + h;
    const fp = residualVector(constraints, xp, layout);
    xp[j] = orig;
    for (let i = 0; i < m; i++) {
      J[i * n + j] = (fp[i] - baseF[i]) / h;
    }
  }
  return J;
};

const buildNormalEquations = (
  J: Float64Array,
  f: Float64Array,
  n: number,
  m: number,
  lambda: number
): { A: number[][]; b: number[] } => {
  // A = JᵀJ + λ diag(JᵀJ)   (Marquardt's variant for scaling)
  // b = -Jᵀ f
  const A: number[][] = [];
  for (let i = 0; i < n; i++) A.push(new Array(n).fill(0));
  const b: number[] = new Array(n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let r = 0; r < n; r++) {
      const Jir = J[i * n + r];
      if (Jir === 0) continue;
      b[r] -= Jir * f[i];
      for (let c = 0; c < n; c++) {
        A[r][c] += Jir * J[i * n + c];
      }
    }
  }
  for (let r = 0; r < n; r++) {
    A[r][r] += lambda * (A[r][r] || 1);
  }
  return { A, b };
};

const solveLinear = (A: number[][], b: number[]): number[] | null => {
  const n = b.length;
  if (n === 0) return [];
  const M: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pi = i;
    let pivot = Math.abs(M[i][i]);
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(M[k][i]);
      if (v > pivot) {
        pivot = v;
        pi = k;
      }
    }
    if (pivot < 1e-14) return null;
    if (pi !== i) [M[i], M[pi]] = [M[pi], M[i]];
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i];
      if (factor === 0) continue;
      for (let j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
};

// ────────────────────────────────────────────────────────────────────────────
// Public solver
// ────────────────────────────────────────────────────────────────────────────

export interface SolveResult {
  shapes: SketcherShape[];
  converged: boolean;
  iters: number;
  residual: number;
}

const MAX_ITERS = 50;
const TOL = 1e-7;

export const solve = (
  shapes: SketcherShape[],
  constraints: Constraint[],
  /** Shape ids whose parameters must stay fixed during solving. Used for
   *  imported face geometry — the user can constrain to face edges, but the
   *  edges themselves can't move. */
  lockedShapeIds?: ReadonlySet<string>
): SolveResult => {
  if (constraints.length === 0) {
    return { shapes, converged: true, iters: 0, residual: 0 };
  }
  const layout = makeLayout(shapes);
  let x = packShapes(shapes, layout);
  // Indices in the parameter vector that should not be modified.
  const lockedParams = new Set<number>();
  if (lockedShapeIds && lockedShapeIds.size > 0) {
    for (const id of lockedShapeIds) {
      const block = layout.blocks.get(id);
      if (!block) continue;
      for (let i = 0; i < block.count; i++) lockedParams.add(block.offset + i);
    }
  }
  let f = residualVector(constraints, x, layout);
  let normSq = residualNormSq(f);
  if (normSq < TOL * TOL) {
    return { shapes, converged: true, iters: 0, residual: Math.sqrt(normSq) };
  }
  let lambda = 1e-3;
  let iters = 0;
  while (iters < MAX_ITERS) {
    iters++;
    const J = jacobian(constraints, x, layout, f);
    const { A, b } = buildNormalEquations(J, f, x.length, f.length, lambda);
    const dx = solveLinear(A, b);
    if (!dx) {
      lambda *= 10;
      if (lambda > 1e12) break;
      continue;
    }
    // Project the step onto the free subspace by zeroing locked params.
    if (lockedParams.size > 0) {
      for (const i of lockedParams) dx[i] = 0;
    }
    const xNew = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) xNew[i] = x[i] + dx[i];
    const fNew = residualVector(constraints, xNew, layout);
    const normNew = residualNormSq(fNew);
    if (normNew < normSq) {
      x = xNew;
      f = fNew;
      normSq = normNew;
      lambda = Math.max(1e-9, lambda / 10);
      if (normSq < TOL * TOL) break;
    } else {
      lambda *= 10;
      if (lambda > 1e12) break;
    }
  }
  return {
    shapes: unpackShapes(x, layout),
    converged: normSq < TOL * TOL,
    iters,
    residual: Math.sqrt(normSq),
  };
};

/**
 * Compute the L2 norm of each constraint's residual vector at the current
 * shape state. Used by the constraints panel to surface which specific
 * constraints are unsatisfied (residual ≫ TOL) after a solve. The order of
 * the returned array matches `constraints`.
 */
export const constraintResiduals = (
  shapes: SketcherShape[],
  constraints: Constraint[]
): { id: string; residual: number }[] => {
  const layout = makeLayout(shapes);
  const x = packShapes(shapes, layout);
  return constraints.map((c) => {
    const r = residualOf(c, x, layout);
    let s = 0;
    for (const v of r) s += v * v;
    return { id: c.id, residual: Math.sqrt(s) };
  });
};

/** Tolerance below which a constraint is considered satisfied. Mirrors the
 *  solver's internal tolerance, exposed for UI checks. */
export const RESIDUAL_TOL = TOL;

// ────────────────────────────────────────────────────────────────────────────
// Selection-validity helpers (used by the toolbar to enable/disable buttons)
// ────────────────────────────────────────────────────────────────────────────

const isPoint = (r: EntityRef) => r.kind === 'point';
const isLineish = (r: EntityRef) => r.kind === 'line' || r.kind === 'edge';

export const arity = (type: ConstraintType): number => {
  switch (type) {
    case 'horizontal':
    case 'vertical':
    case 'fix':
    case 'length':
    case 'radius':
      return 1;
    case 'midpoint':
    case 'symmetry':
      return type === 'midpoint' ? 2 : 3;
    default:
      return 2;
  }
};

export const canCreate = (type: ConstraintType, refs: EntityRef[]): boolean => {
  if (refs.length !== arity(type)) return false;
  switch (type) {
    case 'horizontal':
    case 'vertical':
    case 'length':
      return isLineish(refs[0]);
    case 'fix':
      return isPoint(refs[0]);
    case 'radius':
      return refs[0].kind === 'circle';
    case 'coincident':
      return isPoint(refs[0]) && isPoint(refs[1]);
    case 'distance': {
      // Three valid pairings (Sketcher enforces parallelism for line+line):
      //   line + line   → perpendicular distance between parallel lines
      //   point + point → euclidean distance
      //   point + line  → perpendicular distance from point onto line
      const a = refs[0];
      const b = refs[1];
      const aL = isLineish(a);
      const bL = isLineish(b);
      const aP = isPoint(a);
      const bP = isPoint(b);
      return (aL && bL) || (aP && bP) || (aP && bL) || (aL && bP);
    }
    case 'tangent': {
      // Tangent needs exactly one line/edge + one circle (or arc).
      const a = refs[0];
      const b = refs[1];
      const aL = isLineish(a);
      const bL = isLineish(b);
      const aC = a.kind === 'circle';
      const bC = b.kind === 'circle';
      return (aL && bC) || (aC && bL);
    }
    default:
      return false;
  }
};

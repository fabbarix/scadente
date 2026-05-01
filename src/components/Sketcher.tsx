import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Stage,
  Layer,
  Rect,
  Circle as KCircle,
  Arc as KArc,
  Line as KLine,
  Text,
} from 'react-konva';
import {
  Square,
  Circle as CircleIcon,
  MousePointer2,
  Save,
  Slash,
  Spline,
  Trash2,
  Lock,
  LockOpen,
  Link,
  Ruler,
  MoveHorizontal,
  MoveVertical,
  Triangle,
  Info,
} from 'lucide-react';
import { solve, canCreate, arity, constraintResiduals, RESIDUAL_TOL } from './sketcher/constraints';
import type { Constraint, ConstraintType, EntityRef } from './sketcher/constraints';

type Pt = { x: number; y: number };
type Tool = 'select' | 'rect' | 'rounded-rect' | 'circle' | 'arc' | 'line' | 'polyline';

type BoolOp = 'add' | 'subtract';
interface RectShape {
  id: string;
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in radians, around the rect's center. Defaults to 0
   *  (axis-aligned) when undefined. The (x, y) anchor stays at the
   *  pre-rotation bottom-left corner; rotation is purely visual /
   *  exporting. */
  angle?: number;
  operation: BoolOp;
}
interface RoundedRectShape {
  id: string;
  type: 'rounded-rect';
  x: number;
  y: number;
  width: number;
  height: number;
  cornerRadius: number;
  /** Rotation in radians, around the rect's center. See RectShape.angle. */
  angle?: number;
  operation: BoolOp;
}
interface CircleShape { id: string; type: 'circle'; cx: number; cy: number; radius: number; operation: BoolOp; }
interface ArcShape {
  id: string;
  type: 'arc';
  cx: number;
  cy: number;
  radius: number;
  /** Start / end angles in radians (counter-clockwise from +X). The arc
   *  sweeps from `startAngle` to `endAngle` in the direction set by
   *  `ccw` — positive (CCW) or negative (CW). Construction-only — arcs
   *  aren't extruded, but participate in snap and constraints. */
  startAngle: number;
  endAngle: number;
  /** Sweep direction: true = CCW (start → end going counter-clockwise),
   *  false = CW. Set when the arc is created from three points so the
   *  on-curve reference point disambiguates which half of the circle. */
  ccw: boolean;
}
interface LineShape {
  id: string;
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Marks the line as a non-editable construction line — typically a face
   *  edge imported when sketching on a face. The user can pick it for snap
   *  and constraints, but can't move or delete it; the solver also leaves
   *  its parameters fixed. Filtered out on save (regenerated on re-open). */
  frozen?: boolean;
}
interface PolylineShape { id: string; type: 'polyline'; points: Pt[]; closed: boolean; operation: BoolOp; }
type Shape = RectShape | RoundedRectShape | CircleShape | ArcShape | LineShape | PolylineShape;
export type SketcherShape = Shape;
export type { BoolOp as SketcherBoolOp };

/**
 * Convert the operation's saved shape format back into Sketcher's internal format.
 * Saved rects use center-based coords; internal rects use top-left. Saved polygons
 * become closed polylines.
 */
export function opShapesToSketcher(savedShapes: any[]): SketcherShape[] {
  const out: SketcherShape[] = [];
  for (const s of savedShapes) {
    const id = typeof s.id === 'string' ? s.id : Math.random().toString(36).slice(2, 11);
    const op: BoolOp = s.operation === 'subtract' ? 'subtract' : 'add';
    if (s.type === 'rect') {
      out.push({
        id,
        type: 'rect',
        x: s.x - s.width / 2,
        y: s.y - s.height / 2,
        width: s.width,
        height: s.height,
        angle: typeof s.angle === 'number' ? s.angle : 0,
        operation: op,
      });
    } else if (s.type === 'rounded-rect') {
      out.push({
        id,
        type: 'rounded-rect',
        x: s.x - s.width / 2,
        y: s.y - s.height / 2,
        width: s.width,
        height: s.height,
        cornerRadius: typeof s.cornerRadius === 'number' ? s.cornerRadius : 0,
        angle: typeof s.angle === 'number' ? s.angle : 0,
        operation: op,
      });
    } else if (s.type === 'circle') {
      out.push({
        id,
        type: 'circle',
        cx: s.x,
        cy: s.y,
        radius: s.radius,
        operation: op,
      });
    } else if (s.type === 'polygon' && Array.isArray(s.points) && s.points.length >= 3) {
      out.push({
        id,
        type: 'polyline',
        points: s.points.map((p: any) => ({ x: p.x, y: p.y })),
        closed: true,
        operation: op,
      });
    } else if (s.type === 'compound' && Array.isArray(s.segments) && s.segments.length >= 2) {
      // Restore the line / arc segments as separate sketcher shapes so the
      // user can edit them individually. The save-time detector will
      // re-stitch them when the sketch is committed again.
      for (const seg of s.segments) {
        if (seg.type === 'line') {
          out.push({
            id: Math.random().toString(36).slice(2, 11),
            type: 'line',
            x1: seg.p1.x,
            y1: seg.p1.y,
            x2: seg.p2.x,
            y2: seg.p2.y,
          });
        } else if (seg.type === 'arc') {
          const arc = arcFromThreePoints(seg.p1, seg.pMid, seg.p2);
          if (arc) {
            out.push({
              id: Math.random().toString(36).slice(2, 11),
              type: 'arc',
              ...arc,
            });
          }
        }
      }
    }
  }
  return out;
}

interface SketcherProps {
  onSave: (shapes: any[], constraints: Constraint[]) => void;
  onCancel: () => void;
  initialShapes?: Shape[];
  initialConstraints?: Constraint[];
  plane?: {
    preset: 'XY' | 'XZ' | 'YZ' | 'FACE' | 'EDGE_START';
    origin: [number, number, number];
    /** Plane-local +x direction in world coords. Used to draw world axis
     *  indicators in the sketcher. Optional for back-compat. */
    xDir?: [number, number, number];
    /** Plane normal in world coords. Used with xDir to derive yDir for the
     *  world axis indicators. */
    normal?: [number, number, number];
  };
  /** Plane-local 2D segments (flat array x1,y1,x2,y2,...) drawn behind the canvas as a non-editable guide. */
  referenceOutline?: number[];
  /** When set, the Sketcher draws a prominent marker at the origin
   *  labelled with this string. Used by the sweep flow to point out
   *  where the picked edge intersects the perpendicular sketch plane —
   *  the profile gets swept in / around that point. */
  originMarker?: { label: string; color?: string };
}

const PX_PER_MM = 5;
const SNAP_MM = 1;
const HANDLE_PX = 8;
// Reserved ids for the local sketch axes — long frozen lines along plane +x
// and +y through the origin, used as constraint targets (parallel, distance,
// etc.). Filtered out of the saved shapes; regenerated each time the sketcher
// opens so the ids stay stable across sessions.
const AXIS_X_ID = '_axis_x';
const AXIS_Y_ID = '_axis_y';
const AXIS_HALF_LENGTH_MM = 100000;
const CLOSE_THRESHOLD_MM = 2;
const SNAP_RADIUS_PX = 12;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 50;

const newId = () => Math.random().toString(36).slice(2, 11);
const snapTo = (v: number, step: number) => Math.round(v / step) * step;
const snap = (v: number) => snapTo(v, SNAP_MM);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

// Parallel offset of a closed polygon's vertex ring. `outward` is positive to
// grow, negative to shrink. Each vertex moves along the angle bisector of its
// two incident edges, scaled so the offset edges sit exactly `outward` mm away
// from the originals (no rounded corners — sharp miters). Returns null when
// the result collapses (inset distance too large) or the polygon is degenerate.
const offsetPolygon = (pts: Pt[], outward: number): Pt[] | null => {
  const n = pts.length;
  if (n < 3) return null;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  if (Math.abs(area2) < 1e-12) return null;
  const ccw = area2 > 0;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const e1x = cur.x - prev.x;
    const e1y = cur.y - prev.y;
    const L1 = Math.hypot(e1x, e1y) || 1;
    const e2x = next.x - cur.x;
    const e2y = next.y - cur.y;
    const L2 = Math.hypot(e2x, e2y) || 1;
    // Outward unit normals. CCW polygon: outward = (dy, -dx). CW: (-dy, dx).
    const n1x = ccw ? e1y / L1 : -e1y / L1;
    const n1y = ccw ? -e1x / L1 : e1x / L1;
    const n2x = ccw ? e2y / L2 : -e2y / L2;
    const n2y = ccw ? -e2x / L2 : e2x / L2;
    const bx = n1x + n2x;
    const by = n1y + n2y;
    const blen = Math.hypot(bx, by);
    if (blen < 1e-9) {
      // Near-180° turn — fall back to one of the normals to avoid blow-up.
      out.push({ x: cur.x + outward * n1x, y: cur.y + outward * n1y });
      continue;
    }
    const bnx = bx / blen;
    const bny = by / blen;
    const cosHalf = bnx * n1x + bny * n1y;
    if (cosHalf < 1e-6) return null; // ~degenerate, skip
    const scale = outward / cosHalf;
    out.push({ x: cur.x + scale * bnx, y: cur.y + scale * bny });
  }
  // Inset can flip the polygon if the distance exceeds its inradius. Detect
  // by signed-area sign change.
  let newArea2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    newArea2 += out[i].x * out[j].y - out[j].x * out[i].y;
  }
  if (Math.sign(newArea2) !== Math.sign(area2)) return null;
  return out;
};

/**
 * Rotate a 2D point around a pivot by `angle` radians (CCW).
 */
const rotatePoint = (
  p: { x: number; y: number },
  pivot: { x: number; y: number },
  angle: number
): { x: number; y: number } => {
  if (Math.abs(angle) < 1e-12) return p;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return {
    x: pivot.x + dx * c - dy * s,
    y: pivot.y + dx * s + dy * c,
  };
};

/**
 * Center of a rect / rounded-rect's pre-rotation bbox — the pivot used by
 * its `angle` field. Convenient for snap / pointAt / lineEndsOf which all
 * rotate corner positions around this same point.
 */
const rectCenter = (s: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } => ({
  x: s.x + s.width / 2,
  y: s.y + s.height / 2,
});

/**
 * Circumscribe a circle through three points and return the arc that goes
 * from `p1` to `p2` passing through `pOnArc`. Uses the perpendicular-
 * bisector intersection of (p1, pOnArc) and (pOnArc, p2) to find the
 * center, then sets `startAngle` = angle(p1) and `endAngle` = angle(p2),
 * with the sweep direction chosen so `pOnArc`'s angle lies inside it.
 *
 * Angles are stored in radians, normalized to [-π, π]. Returns null when
 * the three points are colinear (no finite radius).
 */
const arcFromThreePoints = (
  p1: { x: number; y: number },
  pOnArc: { x: number; y: number },
  p2: { x: number; y: number }
): {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  ccw: boolean;
} | null => {
  const ax = p1.x;
  const ay = p1.y;
  const bx = pOnArc.x;
  const by = pOnArc.y;
  const cx = p2.x;
  const cy = p2.y;
  // Standard circumcenter formula (avoids the perpendicular-bisector
  // intersection rounding when one of the segments is near vertical).
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d;
  const radius = Math.hypot(ax - ux, ay - uy);
  if (!Number.isFinite(radius) || radius < 1e-6) return null;
  const startAngle = Math.atan2(ay - uy, ax - ux);
  const endAngle = Math.atan2(cy - uy, cx - ux);
  const midAngle = Math.atan2(by - uy, bx - ux);
  // Pick CCW direction iff the on-arc point lies inside the CCW span.
  const sweep = arcSweep(startAngle, endAngle, midAngle);
  return {
    cx: ux,
    cy: uy,
    radius,
    startAngle,
    endAngle,
    ccw: sweep >= 0,
  };
};

/**
 * Signed CCW sweep (in radians) from `start` to `end` for an arc that also
 * passes through angle `mid`. Positive = CCW, negative = CW. The midpoint
 * disambiguates which half of the circle the arc occupies.
 */
const arcSweep = (start: number, end: number, mid: number): number => {
  const TAU = 2 * Math.PI;
  const wrap = (d: number) => ((d % TAU) + TAU) % TAU;
  const ccwTotal = wrap(end - start); // 0..2π
  const midOff = wrap(mid - start);
  return midOff < ccwTotal ? ccwTotal : -(TAU - ccwTotal);
};

/** Signed sweep angle for an `ArcShape` derived from its `ccw` flag. */
const arcShapeSweep = (s: {
  startAngle: number;
  endAngle: number;
  ccw: boolean;
}): number => {
  const TAU = 2 * Math.PI;
  const wrap = (d: number) => ((d % TAU) + TAU) % TAU;
  const ccwTotal = wrap(s.endAngle - s.startAngle);
  return s.ccw ? ccwTotal : -(TAU - ccwTotal);
};

type SnapKind =
  | 'origin'
  | 'x-axis'
  | 'y-axis'
  | 'rect-corner'
  | 'rect-edge-mid'
  | 'rect-center'
  | 'circle-center'
  | 'circle-cardinal'
  | 'line-end'
  | 'line-mid'
  | 'poly-vertex'
  | 'poly-edge-mid'
  | 'face-vertex'
  | 'face-edge-mid';

interface SnapTarget {
  pt: Pt;
  kind: SnapKind;
  /** When the snap target corresponds to a specific feature point on an
   *  existing shape (rect corner, circle center, line endpoint, polyline
   *  vertex, …), this carries the EntityRef so callers can wire up a
   *  coincident constraint when the user uses this snap to start a new
   *  segment. Midpoint / cardinal / origin / axis snaps don't have a
   *  matching ref and leave this undefined. */
  ref?: EntityRef;
}

/**
 * Walk lines + arcs and stitch them into closed-loop "compound" shapes that
 * the worker can extrude. Connectivity comes from `coincident` constraints,
 * NOT geometric proximity — two endpoints are "the same vertex" only when
 * they're explicitly tied by a coincident in the constraint set. The
 * sketcher auto-creates these when the user starts / ends a segment on an
 * existing feature snap, so the natural drawing flow produces chains
 * without the user having to add constraints by hand.
 *
 * Algorithm:
 *   1. Build a union-find over every endpoint ref (line.p1, line.p2,
 *      arc.p1, arc.p2). For each `coincident` constraint, union its two
 *      endpoints.
 *   2. For each line/arc, find the equivalence class of each endpoint.
 *   3. Greedy chain walk from each unconsumed segment: at the current
 *      tail's class, look for another segment whose own endpoint shares
 *      the class. Stop when we return to the seed's start class (closed →
 *      emit) or run out of matches (open → leave as construction).
 *
 * Frozen geometry (face edges) is excluded — never extrude imported faces.
 */
interface CompoundSegmentLine {
  type: 'line';
  p1: { x: number; y: number };
  p2: { x: number; y: number };
}
interface CompoundSegmentArc {
  type: 'arc';
  p1: { x: number; y: number };
  /** A point on the arc between p1 and p2 — used by replicad's
   *  `threePointsArcTo`. */
  pMid: { x: number; y: number };
  p2: { x: number; y: number };
}
type CompoundSegment = CompoundSegmentLine | CompoundSegmentArc;

interface CompoundLoop {
  id: string;
  segmentIds: string[];
  segments: CompoundSegment[];
}

const arcMidPoint = (s: {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  ccw: boolean;
}): { x: number; y: number } => {
  const TAU = 2 * Math.PI;
  const wrap = (d: number) => ((d % TAU) + TAU) % TAU;
  const ccwTotal = wrap(s.endAngle - s.startAngle);
  const sweep = s.ccw ? ccwTotal : -(TAU - ccwTotal);
  const a = s.startAngle + sweep / 2;
  return { x: s.cx + s.radius * Math.cos(a), y: s.cy + s.radius * Math.sin(a) };
};

/** Stable string key for a `point` EntityRef — used as the union-find node id. */
const refKey = (r: EntityRef): string | null => {
  if (r.kind !== 'point') return null;
  if (r.role === 'vertex') return `${r.shapeId}:vertex:${r.vertexIdx ?? 0}`;
  return `${r.shapeId}:${r.role}`;
};

const detectClosedCompounds = (
  shapes: { id: string; type: string; [k: string]: any }[],
  constraints: Constraint[]
): CompoundLoop[] => {
  // Union-find over endpoint refs. Each node is the stable key of a
  // `point` EntityRef. Coincident constraints union their two refs.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let p: string | undefined = parent.get(k);
    if (p === undefined) {
      parent.set(k, k);
      return k;
    }
    // Walk to root with path compression. `parent.get(p)` is always defined
    // because we only insert keys that point to themselves (or to keys we
    // already inserted), so the chain terminates at a self-reference.
    while (p !== parent.get(p)) {
      const gp: string = parent.get(p) as string;
      parent.set(p, gp);
      p = gp;
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of constraints) {
    if (c.type !== 'coincident') continue;
    const ka = refKey(c.a);
    const kb = refKey(c.b);
    if (ka && kb) union(ka, kb);
  }

  // Collect candidate segments: non-frozen lines + arcs. Each carries the
  // class of its two endpoints (after union) for chain matching.
  type Cand = {
    id: string;
    p1: { x: number; y: number };
    p2: { x: number; y: number };
    classA: string; // class of p1
    classB: string; // class of p2
    asSegment: (reversed: boolean) => CompoundSegment;
  };
  const cands: Cand[] = [];
  for (const s of shapes) {
    if (s.type === 'line' && !s.frozen) {
      const p1 = { x: s.x1, y: s.y1 };
      const p2 = { x: s.x2, y: s.y2 };
      cands.push({
        id: s.id,
        p1,
        p2,
        classA: find(`${s.id}:p1`),
        classB: find(`${s.id}:p2`),
        asSegment: (rev) =>
          rev
            ? { type: 'line', p1: p2, p2: p1 }
            : { type: 'line', p1, p2 },
      });
    } else if (s.type === 'arc') {
      const p1 = {
        x: s.cx + s.radius * Math.cos(s.startAngle),
        y: s.cy + s.radius * Math.sin(s.startAngle),
      };
      const p2 = {
        x: s.cx + s.radius * Math.cos(s.endAngle),
        y: s.cy + s.radius * Math.sin(s.endAngle),
      };
      const pMid = arcMidPoint(s as any);
      cands.push({
        id: s.id,
        p1,
        p2,
        classA: find(`${s.id}:p1`),
        classB: find(`${s.id}:p2`),
        asSegment: (rev) =>
          rev
            ? { type: 'arc', p1: p2, pMid, p2: p1 }
            : { type: 'arc', p1, pMid, p2 },
      });
    }
  }
  if (cands.length < 2) return [];
  const consumed = new Set<string>();
  const loops: CompoundLoop[] = [];
  for (const seed of cands) {
    if (consumed.has(seed.id)) continue;
    // Greedy chain walk. Track which class we're currently at (tailClass)
    // and which class we started at (startClass). Loop closes when tailClass
    // returns to startClass after consuming ≥ 2 segments.
    const segments: CompoundSegment[] = [seed.asSegment(false)];
    const ids = [seed.id];
    const localConsumed = new Set<string>([seed.id]);
    let tailClass = seed.classB;
    const startClass = seed.classA;
    let closed = false;
    while (true) {
      if (tailClass === startClass && segments.length >= 2) {
        closed = true;
        break;
      }
      let next: { cand: Cand; reversed: boolean } | null = null;
      for (const c of cands) {
        if (localConsumed.has(c.id) || consumed.has(c.id)) continue;
        if (c.classA === tailClass) {
          next = { cand: c, reversed: false };
          break;
        }
        if (c.classB === tailClass) {
          next = { cand: c, reversed: true };
          break;
        }
      }
      if (!next) break;
      segments.push(next.cand.asSegment(next.reversed));
      ids.push(next.cand.id);
      localConsumed.add(next.cand.id);
      tailClass = next.reversed ? next.cand.classA : next.cand.classB;
    }
    if (closed) {
      for (const id of ids) consumed.add(id);
      loops.push({
        id: 'cmp_' + seed.id,
        segmentIds: ids,
        segments,
      });
    }
  }
  return loops;
};

/**
 * Rounded-rect glyph drawn as an inline SVG. Lucide's `Square` is shared
 * with the plain rect tool; this variant uses an `rx` corner so the
 * rounded-rect tool reads distinct in the toolbar.
 */
const RoundedRectIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x={3} y={3} width={18} height={18} rx={6} ry={6} />
  </svg>
);

/**
 * Quarter-arc glyph drawn as an inline SVG. Lucide doesn't ship a "circular
 * arc" icon, and reusing `Circle` made the Arc tool indistinguishable from
 * Circle in the toolbar. Stroke / size match Lucide's defaults so it sits
 * cleanly next to the other tool icons.
 */
const ArcIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Open arc from top-left to bottom-right + small endpoint dots so the
        glyph reads as "arc with endpoints" at a glance. */}
    <path d="M3 21 A18 18 0 0 1 21 3" />
    <circle cx={3} cy={21} r={1.5} fill="currentColor" />
    <circle cx={21} cy={3} r={1.5} fill="currentColor" />
  </svg>
);

export function Sketcher({
  onSave,
  onCancel,
  initialShapes = [],
  initialConstraints = [],
  plane,
  referenceOutline,
  originMarker,
}: SketcherProps) {
  // Initial frozen lines built from the face boundary (when sketching on a
  // face). They're plain LineShapes flagged `frozen` — pickable for snap
  // and constraints but locked against editing. IDs are deterministic from
  // the segment index so constraints referencing them survive save / re-open
  // as long as the underlying face geometry doesn't change.
  const initialFrozen = useMemo<LineShape[]>(() => {
    if (!referenceOutline || referenceOutline.length < 4) return [];
    const out: LineShape[] = [];
    for (let i = 0; i + 3 < referenceOutline.length; i += 4) {
      out.push({
        id: `face_${i / 4}`,
        type: 'line',
        x1: referenceOutline[i],
        y1: referenceOutline[i + 1],
        x2: referenceOutline[i + 2],
        y2: referenceOutline[i + 3],
        frozen: true,
      });
    }
    return out;
    // Only re-derive if the outline reference changes (one snapshot per open).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceOutline]);
  // Long frozen lines that represent the local sketch axes — pickable for
  // constraints (parallel, distance, etc.) but locked. They render as the
  // gray crosshair the user already sees and only "win" the picker tie when
  // no closer shape entity exists, so they don't get in the way of selecting
  // real geometry that lies on or near an axis.
  const axisShapes = useMemo<LineShape[]>(
    () => [
      {
        id: AXIS_X_ID,
        type: 'line',
        x1: -AXIS_HALF_LENGTH_MM,
        y1: 0,
        x2: AXIS_HALF_LENGTH_MM,
        y2: 0,
        frozen: true,
      },
      {
        id: AXIS_Y_ID,
        type: 'line',
        x1: 0,
        y1: -AXIS_HALF_LENGTH_MM,
        x2: 0,
        y2: AXIS_HALF_LENGTH_MM,
        frozen: true,
      },
    ],
    []
  );
  const [shapes, setShapes] = useState<Shape[]>(() => {
    // Drop any persisted shape that collides with a generated frozen id —
    // safety against an older save that happened to use the same id.
    const frozenIds = new Set([
      ...axisShapes.map((s) => s.id),
      ...initialFrozen.map((s) => s.id),
    ]);
    const userShapes = initialShapes.filter((s) => !frozenIds.has(s.id));
    return [...axisShapes, ...initialFrozen, ...userShapes];
  });
  const [constraints, setConstraints] = useState<Constraint[]>(initialConstraints);
  const [pendingConstraint, setPendingConstraint] = useState<ConstraintType | null>(null);
  const [pendingRefs, setPendingRefs] = useState<EntityRef[]>([]);
  const [pendingHover, setPendingHover] = useState<EntityRef | null>(null);
  const [pendingHint, setPendingHint] = useState<string | null>(null);
  const pendingHintTimer = useRef<number | null>(null);
  const lastCursorMmRef = useRef<Pt | null>(null);

  const flashHint = (msg: string) => {
    setPendingHint(msg);
    if (pendingHintTimer.current != null) {
      window.clearTimeout(pendingHintTimer.current);
    }
    pendingHintTimer.current = window.setTimeout(() => {
      setPendingHint(null);
      pendingHintTimer.current = null;
    }, 3500);
  };
  // Active drag of a dimension graphic — dim line slide, or label move (along
  // the dim line + perpendicular off it).
  const [dimDrag, setDimDrag] = useState<
    | {
        constraintId: string;
        kind: 'offset';
        baseValue: number;
        baseScreenX: number;
        baseScreenY: number;
        /** Unit vector the dim line slides along (parallel to the features). */
        offsetDir: Pt;
      }
    | {
        constraintId: string;
        kind: 'label';
        baseT: number;
        baseP: number;
        baseScreenX: number;
        baseScreenY: number;
        /** Unit vector along the dim line, in the direction labelT increases. */
        alongDir: Pt;
        /** Unit vector perpendicular to the dim line — moves labelP. */
        perpDir: Pt;
        /** Dim line length in mm — used to convert mm drag → labelT fraction. */
        alongLenMm: number;
      }
    | null
  >(null);
  const constraintsRef = useRef(constraints);
  useEffect(() => {
    constraintsRef.current = constraints;
  }, [constraints]);
  // Mirror of `shapes` for synchronous reads during a Konva drag — the
  // dragBoundFunc closure runs on every mouse move and needs the freshest
  // shape data without waiting for React's render cycle.
  const shapesRef = useRef<Shape[]>(shapes);
  useEffect(() => {
    shapesRef.current = shapes;
  }, [shapes]);

  // Wrap a setShapes update through the constraint solver. Used by drag and
  // inline-edit paths so the user's edit is reconciled with the constraint set
  // before being committed to state.
  // Last solve outcome — read by callers (e.g. the field-locking flow) to
  // surface a "could not solve" toast when the user's last edit conflicts
  // with existing constraints.
  const lastSolveRef = useRef<{ converged: boolean; residual: number } | null>(null);
  // Per-constraint residual norms after the most recent solve. Lets the
  // constraints panel highlight which specific constraint(s) the solver
  // couldn't satisfy (residual ≫ tolerance).
  const [solveDiagnostics, setSolveDiagnostics] = useState<{
    converged: boolean;
    residual: number;
    perConstraint: Record<string, number>;
  } | null>(null);
  const applyShapes = (
    next: Shape[] | ((prev: Shape[]) => Shape[]),
    extraConstraints?: Constraint[]
  ) => {
    setShapes((prev) => {
      const candidate = typeof next === 'function' ? (next as any)(prev) : next;
      const all = extraConstraints
        ? [...constraintsRef.current, ...extraConstraints]
        : constraintsRef.current;
      if (all.length === 0) {
        lastSolveRef.current = { converged: true, residual: 0 };
        setSolveDiagnostics({ converged: true, residual: 0, perConstraint: {} });
        return candidate;
      }
      const lockedIds = new Set<string>();
      for (const s of candidate) {
        if (s.type === 'line' && s.frozen) lockedIds.add(s.id);
      }
      const result = solve(candidate, all, lockedIds);
      lastSolveRef.current = {
        converged: result.converged,
        residual: result.residual,
      };
      // Compute per-constraint residuals on the post-solve shapes for the
      // diagnostics panel.
      const perConstraint: Record<string, number> = {};
      for (const r of constraintResiduals(result.shapes, all)) {
        perConstraint[r.id] = r.residual;
      }
      setSolveDiagnostics({
        converged: result.converged,
        residual: result.residual,
        perConstraint,
      });
      return result.shapes as Shape[];
    });
  };

  // Re-run the solver against the current shapes + constraints and refresh
  // diagnostics. Wired to the "Re-solve" button in the constraints panel —
  // useful after manual edits, to verify the sketch still satisfies its
  // constraints, or to retry after fixing a conflict.
  const resolveAll = () => {
    applyShapes((p) => p);
    const ls = lastSolveRef.current;
    if (ls && !ls.converged) {
      flashHint(
        'Could not fully solve — see the constraints panel for which constraints are unsatisfied.'
      );
    }
  };

  // Compute the constrained world position for a body-drag of the given
  // shape — runs snap + solve and returns the position the shape should
  // actually be at after the constraints have their say. Called from
  // `dragBoundFunc` so Konva's drag tracker sees the post-solve position
  // and stops fighting React state. Only `rect` and `circle` body-drag
  // today; lines / polylines drag via individual vertex handles.
  const constrainBodyDrag = (
    shapeId: string,
    target: Pt,
    kind: 'rect' | 'rounded-rect' | 'circle'
  ): Pt => {
    const snapped = snapPoint(target);
    const candidate = shapesRef.current.map((sh) => {
      if (sh.id !== shapeId) return sh;
      if (kind === 'rect' && sh.type === 'rect')
        return { ...sh, x: snapped.x, y: snapped.y } as Shape;
      if (kind === 'rounded-rect' && sh.type === 'rounded-rect')
        return { ...sh, x: snapped.x, y: snapped.y } as Shape;
      if (kind === 'circle' && sh.type === 'circle')
        return { ...sh, cx: snapped.x, cy: snapped.y } as Shape;
      return sh;
    });
    const all = constraintsRef.current;
    if (all.length === 0) return snapped;
    const lockedIds = new Set<string>();
    for (const csh of candidate) {
      if (csh.type === 'line' && csh.frozen) lockedIds.add(csh.id);
    }
    const result = solve(candidate, all, lockedIds);
    const solved = result.shapes.find((sh) => sh.id === shapeId);
    if (kind === 'rect' && solved && solved.type === 'rect')
      return { x: solved.x, y: solved.y };
    if (kind === 'rounded-rect' && solved && solved.type === 'rounded-rect')
      return { x: solved.x, y: solved.y };
    if (kind === 'circle' && solved && solved.type === 'circle')
      return { x: solved.cx, y: solved.cy };
    return snapped;
  };

  // Layer transform for converting Konva absolute (screen-px) positions to
  // / from world (mm). Layer transform: x_screen = w/2 + panX + x_world *
  // screenScale, y_screen = h/2 + panY - y_world * screenScale (Y flipped).
  const absToWorld = (p: { x: number; y: number }): Pt => ({
    x: (p.x - (size.w / 2 + view.panX)) / screenScale,
    y: -(p.y - (size.h / 2 + view.panY)) / screenScale,
  });
  const worldToAbs = (p: Pt): { x: number; y: number } => ({
    x: size.w / 2 + view.panX + p.x * screenScale,
    y: size.h / 2 + view.panY - p.y * screenScale,
  });
  const [tool, setTool] = useState<Tool>('select');
  const [panelTab, setPanelTab] = useState<'properties' | 'constraints'>(
    'properties'
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [polyDraft, setPolyDraft] = useState<{ points: Pt[]; preview: Pt } | null>(null);
  // Three-click arc drafting state. Click 1 sets `start`, click 2 sets `end`,
  // click 3 supplies the on-curve point that defines the radius / sweep
  // direction. Hover preview during clicks 2 / 3 uses the cursor as the
  // missing point so the user sees a live arc as they move.
  const [arcDraft, setArcDraft] = useState<{ start: Pt; end: Pt | null } | null>(null);
  // Cursor position in mm for arc-draft preview. We need state (not just the
  // ref) so the preview re-renders as the user moves between clicks.
  const [arcCursor, setArcCursor] = useState<Pt | null>(null);
  // Most recent snap target from `pointerToWorld` / `snapPoint`. Used to
  // wire up auto-coincident constraints when the user starts (or ends) a
  // line / arc segment on top of an existing feature point. Updated
  // synchronously inside the snap helpers so callers can read it on
  // mousedown / mouseup without a re-render delay.
  const lastSnapRefRef = useRef<EntityRef | null>(null);
  // Captured snap refs for the in-progress draft. Filled at draft start
  // (lineStart, arcStart) and consumed at draft commit to add coincident
  // constraints between the new segment's endpoints and whatever existing
  // feature points the user snapped to.
  const draftSnapRefsRef = useRef<{
    lineStart?: EntityRef;
    arcStart?: EntityRef;
    arcEnd?: EntityRef;
  }>({});
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ panX: 0, panY: 0, zoom: 1 });
  const [snapHint, setSnapHint] = useState<SnapTarget | null>(null);
  const [inlineEditor, setInlineEditor] = useState<
    | {
        target: 'shape';
        shapeId: string;
        kind: 'length' | 'radius' | 'rect-width' | 'rect-height';
        sx: number;
        sy: number;
        value: string;
      }
    | {
        target: 'constraint';
        constraintId: string;
        kind: 'distance-value';
        sx: number;
        sy: number;
        value: string;
      }
    | null
  >(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ cx: number; cy: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Zoom-to-fit when the sketcher opens with a referenceOutline (sketching on
  // a face): frame the face's outline with margin so the user starts oriented
  // around the feature. Fires once per outline identity, after the canvas has
  // a meaningful size.
  const fittedForRef = useRef<number[] | null>(null);
  useEffect(() => {
    if (!referenceOutline || referenceOutline.length < 4) return;
    if (size.w < 100 || size.h < 100) return;
    if (fittedForRef.current === referenceOutline) return;
    let umin = Infinity,
      umax = -Infinity,
      vmin = Infinity,
      vmax = -Infinity;
    for (let i = 0; i + 1 < referenceOutline.length; i += 2) {
      const u = referenceOutline[i];
      const v = referenceOutline[i + 1];
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    const w = Math.max(0.01, umax - umin);
    const h = Math.max(0.01, vmax - vmin);
    const margin = 0.7;
    const targetScale = Math.min((size.w * margin) / w, (size.h * margin) / h);
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetScale / PX_PER_MM));
    const scale = PX_PER_MM * zoom;
    const ucenter = (umin + umax) / 2;
    const vcenter = (vmin + vmax) / 2;
    setView({ panX: -ucenter * scale, panY: vcenter * scale, zoom });
    fittedForRef.current = referenceOutline;
  }, [referenceOutline, size.w, size.h]);

  const screenScale = PX_PER_MM * view.zoom;
  // Snap radius in mm at the current zoom — fixed in pixels so it feels consistent.
  const snapRadiusMm = SNAP_RADIUS_PX / screenScale;

  // Build snap targets from current shapes + face reference, optionally excluding the in-progress shape.
  const snapTargets = useMemo<SnapTarget[]>(() => {
    const out: SnapTarget[] = [{ pt: { x: 0, y: 0 }, kind: 'origin' }];
    const skipId = draft?.id;
    const cornerRef = (id: string, role: 'tl' | 'tr' | 'br' | 'bl' | 'center'): EntityRef => ({
      kind: 'point',
      shapeId: id,
      role,
    });
    for (const s of shapes) {
      if (s.id === skipId) continue;
      if (s.type === 'rect' || s.type === 'rounded-rect') {
        const x0 = s.x, y0 = s.y, x1 = s.x + s.width, y1 = s.y + s.height;
        const c = rectCenter(s);
        const a = s.angle ?? 0;
        const rot = (p: Pt) => rotatePoint(p, c, a);
        // Corner roles match the convention used elsewhere: bl is the
        // (x,y) anchor; tl is at (x, y+h); etc. Rotation is applied
        // around the rect's center so all snap points follow the
        // visible orientation.
        out.push({ pt: rot({ x: x0, y: y0 }), kind: 'rect-corner', ref: cornerRef(s.id, 'bl') });
        out.push({ pt: rot({ x: x1, y: y0 }), kind: 'rect-corner', ref: cornerRef(s.id, 'br') });
        out.push({ pt: rot({ x: x1, y: y1 }), kind: 'rect-corner', ref: cornerRef(s.id, 'tr') });
        out.push({ pt: rot({ x: x0, y: y1 }), kind: 'rect-corner', ref: cornerRef(s.id, 'tl') });
        out.push({ pt: rot({ x: (x0 + x1) / 2, y: y0 }), kind: 'rect-edge-mid' });
        out.push({ pt: rot({ x: x1, y: (y0 + y1) / 2 }), kind: 'rect-edge-mid' });
        out.push({ pt: rot({ x: (x0 + x1) / 2, y: y1 }), kind: 'rect-edge-mid' });
        out.push({ pt: rot({ x: x0, y: (y0 + y1) / 2 }), kind: 'rect-edge-mid' });
        out.push({
          pt: c,
          kind: 'rect-center',
          ref: cornerRef(s.id, 'center'),
        });
      } else if (s.type === 'circle') {
        out.push({
          pt: { x: s.cx, y: s.cy },
          kind: 'circle-center',
          ref: { kind: 'point', shapeId: s.id, role: 'center' },
        });
        out.push({ pt: { x: s.cx + s.radius, y: s.cy }, kind: 'circle-cardinal' });
        out.push({ pt: { x: s.cx - s.radius, y: s.cy }, kind: 'circle-cardinal' });
        out.push({ pt: { x: s.cx, y: s.cy + s.radius }, kind: 'circle-cardinal' });
        out.push({ pt: { x: s.cx, y: s.cy - s.radius }, kind: 'circle-cardinal' });
      } else if (s.type === 'arc') {
        // Snap to the arc's center, its two endpoints, and the on-arc midpoint.
        out.push({
          pt: { x: s.cx, y: s.cy },
          kind: 'circle-center',
          ref: { kind: 'point', shapeId: s.id, role: 'center' },
        });
        out.push({
          pt: {
            x: s.cx + s.radius * Math.cos(s.startAngle),
            y: s.cy + s.radius * Math.sin(s.startAngle),
          },
          kind: 'line-end',
          ref: { kind: 'point', shapeId: s.id, role: 'p1' },
        });
        out.push({
          pt: {
            x: s.cx + s.radius * Math.cos(s.endAngle),
            y: s.cy + s.radius * Math.sin(s.endAngle),
          },
          kind: 'line-end',
          ref: { kind: 'point', shapeId: s.id, role: 'p2' },
        });
        const midA = s.startAngle + arcShapeSweep(s) / 2;
        out.push({
          pt: {
            x: s.cx + s.radius * Math.cos(midA),
            y: s.cy + s.radius * Math.sin(midA),
          },
          kind: 'line-mid',
        });
      } else if (s.type === 'line') {
        // Axes don't contribute snap points: their endpoints are at ±100km
        // and their midpoint duplicates the origin snap.
        if (s.id === AXIS_X_ID || s.id === AXIS_Y_ID) continue;
        const isFrozen = !!s.frozen;
        out.push({
          pt: { x: s.x1, y: s.y1 },
          kind: isFrozen ? 'face-vertex' : 'line-end',
          ref: { kind: 'point', shapeId: s.id, role: 'p1' },
        });
        out.push({
          pt: { x: s.x2, y: s.y2 },
          kind: isFrozen ? 'face-vertex' : 'line-end',
          ref: { kind: 'point', shapeId: s.id, role: 'p2' },
        });
        out.push({
          pt: { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 },
          kind: isFrozen ? 'face-edge-mid' : 'line-mid',
        });
      } else if (s.type === 'polyline') {
        for (let i = 0; i < s.points.length; i++) {
          out.push({
            pt: s.points[i],
            kind: 'poly-vertex',
            ref: { kind: 'point', shapeId: s.id, role: 'vertex', vertexIdx: i },
          });
        }
        const lastIdx = s.closed ? s.points.length : s.points.length - 1;
        for (let i = 0; i < lastIdx; i++) {
          const a = s.points[i];
          const b = s.points[(i + 1) % s.points.length];
          out.push({ pt: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'poly-edge-mid' });
        }
      }
    }
    return out;
  }, [shapes, draft?.id]);

  const snapPoint = (raw: Pt): Pt => {
    const hit = findSnap(raw);
    if (hit) {
      setSnapHint(hit);
      lastSnapRefRef.current = hit.ref ?? null;
      return hit.pt;
    }
    setSnapHint(null);
    lastSnapRefRef.current = null;
    return { x: snap(raw.x), y: snap(raw.y) };
  };

  const findSnap = (pt: Pt): SnapTarget | null => {
    // Phase 1: real feature points (corners, centers, endpoints, midpoints,
    // origin). These always beat axis snaps when within range.
    let best: SnapTarget | null = null;
    let bestD = snapRadiusMm;
    for (const t of snapTargets) {
      const d = Math.hypot(t.pt.x - pt.x, t.pt.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best) return best;
    // Phase 2: axis projection — only when no feature point was in range.
    // Snaps the perpendicular distance to the axis line and grid-snaps the
    // on-axis coord.
    let axisBest: SnapTarget | null = null;
    let axisD = snapRadiusMm;
    const dy = Math.abs(pt.y);
    const dx = Math.abs(pt.x);
    if (dy < axisD) {
      axisD = dy;
      axisBest = { pt: { x: snap(pt.x), y: 0 }, kind: 'x-axis' };
    }
    if (dx < axisD) {
      axisBest = { pt: { x: 0, y: snap(pt.y) }, kind: 'y-axis' };
    }
    return axisBest;
  };

  // Convert pointer to world (mm). Applies feature snap if a target is within snap radius,
  // otherwise falls back to the 1mm grid. Updates `snapHint` for visual feedback.
  const pointerToWorld = (stage: any): Pt | null => {
    const p = stage.getPointerPosition();
    if (!p) return null;
    const rawX = (p.x - size.w / 2 - view.panX) / screenScale;
    const rawY = (size.h / 2 + view.panY - p.y) / screenScale;
    const hit = findSnap({ x: rawX, y: rawY });
    if (hit) {
      setSnapHint(hit);
      lastSnapRefRef.current = hit.ref ?? null;
      return hit.pt;
    }
    setSnapHint(null);
    lastSnapRefRef.current = null;
    return { x: snap(rawX), y: snap(rawY) };
  };

  const selectedShape = useMemo(
    () => shapes.find((s) => s.id === selectedId) ?? null,
    [shapes, selectedId]
  );

  /**
   * Snap the polyline's next vertex so the new segment lands at a 5°
   * multiple relative to the previous segment's direction. The cursor
   * length (from the last placed vertex) is preserved — only the
   * direction is rounded. Returns the cursor unchanged when there isn't
   * a previous segment, when shift overrides snapping, or when a feature
   * snap already claimed the point.
   */
  const POLY_ANGLE_SNAP_RAD = (5 * Math.PI) / 180;
  const applyPolyAngleSnap = (
    points: Pt[],
    cursor: Pt
  ): { pt: Pt; angleDeg: number | null } => {
    if (points.length < 2) return { pt: cursor, angleDeg: null };
    const prev = points[points.length - 1];
    const prev2 = points[points.length - 2];
    const prevDx = prev.x - prev2.x;
    const prevDy = prev.y - prev2.y;
    if (Math.hypot(prevDx, prevDy) < 1e-6) {
      return { pt: cursor, angleDeg: null };
    }
    const prevAngle = Math.atan2(prevDy, prevDx);
    const dx = cursor.x - prev.x;
    const dy = cursor.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { pt: cursor, angleDeg: 0 };
    const cursorAngle = Math.atan2(dy, dx);
    let rel = cursorAngle - prevAngle;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel <= -Math.PI) rel += 2 * Math.PI;
    const snappedRel = Math.round(rel / POLY_ANGLE_SNAP_RAD) * POLY_ANGLE_SNAP_RAD;
    const snappedAngle = prevAngle + snappedRel;
    return {
      pt: {
        x: prev.x + len * Math.cos(snappedAngle),
        y: prev.y + len * Math.sin(snappedAngle),
      },
      angleDeg: (snappedRel * 180) / Math.PI,
    };
  };

  const switchTool = (next: Tool) => {
    setTool(next);
    setDraft(null);
    setPolyDraft(null);
    setArcDraft(null);
    setArcCursor(null);
    // Picking a drawing / selection tool also exits any sticky
    // constraint pick mode — same effect as Esc.
    setPendingConstraint(null);
    setPendingRefs([]);
    setPendingHover(null);
  };

  const updateShape = (id: string, patch: Partial<Shape> | any) => {
    applyShapes((prev) => prev.map((s) => (s.id === id ? ({ ...s, ...patch } as Shape) : s)));
  };

  // Translate every defining coord of a shape by (dx, dy) without changing
  // its size or orientation. Used by the coincident-constraint flow to move
  // the first-clicked point's shape so the picked point lands on the
  // second-clicked one.
  /**
   * Rotate a shape in place by `deltaRad` radians around its own
   * centroid. Used by the property-panel rotate control for shapes
   * whose rotation isn't captured by an explicit `angle` field
   * (lines / polylines / arcs).
   *
   * - line: rotate p1, p2 around the segment midpoint.
   * - polyline: rotate every vertex around the average vertex.
   * - arc: bump startAngle / endAngle by the delta — the arc's center
   *   stays put, which matches "rotate about the arc's pivot".
   * - rect / rounded-rect: bump the explicit `angle` field.
   * - circle: no-op (rotation has no visible effect).
   */
  const rotateShapeBy = (s: Shape, deltaRad: number): Shape => {
    if (Math.abs(deltaRad) < 1e-9) return s;
    if (s.type === 'rect' || s.type === 'rounded-rect') {
      return { ...s, angle: (s.angle ?? 0) + deltaRad } as Shape;
    }
    if (s.type === 'line') {
      const mid = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
      const p1 = rotatePoint({ x: s.x1, y: s.y1 }, mid, deltaRad);
      const p2 = rotatePoint({ x: s.x2, y: s.y2 }, mid, deltaRad);
      return { ...s, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    if (s.type === 'polyline') {
      const cx = s.points.reduce((a, p) => a + p.x, 0) / s.points.length;
      const cy = s.points.reduce((a, p) => a + p.y, 0) / s.points.length;
      const pivot = { x: cx, y: cy };
      const next = s.points.map((p) => rotatePoint(p, pivot, deltaRad));
      return { ...s, points: next };
    }
    if (s.type === 'arc') {
      return {
        ...s,
        startAngle: s.startAngle + deltaRad,
        endAngle: s.endAngle + deltaRad,
      };
    }
    return s;
  };

  const translateShape = (s: Shape, dx: number, dy: number): Shape => {
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return s;
    if (s.type === 'rect') return { ...s, x: s.x + dx, y: s.y + dy };
    if (s.type === 'rounded-rect') return { ...s, x: s.x + dx, y: s.y + dy };
    if (s.type === 'circle') return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    if (s.type === 'arc') return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    if (s.type === 'line')
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
    if (s.type === 'polyline')
      return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    return s;
  };

  // Build the auto-lock constraint that pins a property-panel field. The
  // field marker (`${shapeId}.${field}`) lets the UI tell whether a field
  // is locked and which constraint to update / remove later.
  const buildFieldConstraint = (
    shape: Shape,
    field: string,
    value: number,
    id: string
  ): Constraint | null => {
    const fieldKey = `${shape.id}.${field}`;
    const point = (
      role: 'tl' | 'tr' | 'br' | 'bl' | 'center' | 'p1' | 'p2' | 'vertex',
      vertexIdx?: number
    ): EntityRef => ({
      kind: 'point',
      shapeId: shape.id,
      role,
      ...(vertexIdx != null ? { vertexIdx } : {}),
    });
    if (shape.type === 'rect' || shape.type === 'rounded-rect') {
      if (field === 'width')
        return {
          id,
          type: 'length',
          ref: { kind: 'edge', shapeId: shape.id, edge: 'bottom' },
          value,
          field: fieldKey,
        };
      if (field === 'height')
        return {
          id,
          type: 'length',
          ref: { kind: 'edge', shapeId: shape.id, edge: 'left' },
          value,
          field: fieldKey,
        };
      if (field === 'x')
        return { id, type: 'coord-x', ref: point('bl'), value, field: fieldKey };
      if (field === 'y')
        return { id, type: 'coord-y', ref: point('bl'), value, field: fieldKey };
    }
    if (shape.type === 'circle') {
      if (field === 'cx')
        return { id, type: 'coord-x', ref: point('center'), value, field: fieldKey };
      if (field === 'cy')
        return { id, type: 'coord-y', ref: point('center'), value, field: fieldKey };
      if (field === 'radius')
        return {
          id,
          type: 'radius',
          ref: { kind: 'circle', shapeId: shape.id },
          value,
          field: fieldKey,
        };
    }
    if (shape.type === 'line') {
      if (field === 'x1')
        return { id, type: 'coord-x', ref: point('p1'), value, field: fieldKey };
      if (field === 'y1')
        return { id, type: 'coord-y', ref: point('p1'), value, field: fieldKey };
      if (field === 'x2')
        return { id, type: 'coord-x', ref: point('p2'), value, field: fieldKey };
      if (field === 'y2')
        return { id, type: 'coord-y', ref: point('p2'), value, field: fieldKey };
    }
    if (shape.type === 'polyline') {
      const m = /^v(\d+)\.(x|y)$/.exec(field);
      if (m) {
        const idx = parseInt(m[1], 10);
        return {
          id,
          type: m[2] === 'x' ? 'coord-x' : 'coord-y',
          ref: point('vertex', idx),
          value,
          field: fieldKey,
        };
      }
    }
    return null;
  };

  // Apply a numeric edit from the property panel to a shape's field. If the
  // field already has an auto-lock constraint, update its value; otherwise
  // create one. Then patch the shape so the geometry starts at the new value
  // (helps the solver converge) and run a solve. If the solve fails, surface
  // a "could not solve" toast — the constraint set is conflicting.
  const setShapeField = (shape: Shape, field: string, value: number) => {
    const fieldKey = `${shape.id}.${field}`;
    const existing = constraints.find((c) => c.field === fieldKey);
    let updated: Constraint[];
    if (existing) {
      updated = constraints.map((c) =>
        c.id === existing.id &&
        (c.type === 'length' ||
          c.type === 'radius' ||
          c.type === 'coord-x' ||
          c.type === 'coord-y' ||
          c.type === 'distance' ||
          c.type === 'angle')
          ? { ...c, value }
          : c
      );
    } else {
      const newCon = buildFieldConstraint(shape, field, value, newConstraintId());
      updated = newCon ? [...constraints, newCon] : constraints;
    }
    setConstraints(updated);
    constraintsRef.current = updated;
    // Patch the geometry too so the user's edit takes effect immediately and
    // the solver starts close to the desired state.
    const patch = fieldPatch(shape, field, value);
    if (patch) {
      applyShapes((prev) =>
        prev.map((s) => (s.id === shape.id ? ({ ...s, ...patch } as Shape) : s))
      );
    } else {
      applyShapes((p) => p);
    }
    // setShapes (and thus solve) ran synchronously inside applyShapes — check
    // the result for convergence.
    const ls = lastSolveRef.current;
    if (ls && !ls.converged) {
      flashHint(
        'Could not solve — the new constraint conflicts with another. Unlock a field to relax.'
      );
    }
  };

  const unlockShapeField = (shape: Shape, field: string) => {
    const fieldKey = `${shape.id}.${field}`;
    const updated = constraints.filter((c) => c.field !== fieldKey);
    setConstraints(updated);
    constraintsRef.current = updated;
    applyShapes((p) => p);
  };

  // Translate a (shape, field, value) into a shape-state patch. Mirrors the
  // mapping inside `buildFieldConstraint` — they describe two views of the
  // same field. Returns null for unknown fields (caller falls back to a
  // re-solve only).
  const fieldPatch = (
    shape: Shape,
    field: string,
    value: number
  ): Partial<Shape> | null => {
    if (shape.type === 'rect') {
      if (field === 'x') return { x: value };
      if (field === 'y') return { y: value };
      if (field === 'width') return { width: Math.max(0, value) };
      if (field === 'height') return { height: Math.max(0, value) };
    }
    if (shape.type === 'rounded-rect') {
      if (field === 'x') return { x: value };
      if (field === 'y') return { y: value };
      if (field === 'width') return { width: Math.max(0, value) };
      if (field === 'height') return { height: Math.max(0, value) };
      if (field === 'cornerRadius')
        return {
          cornerRadius: Math.max(
            0,
            Math.min(value, Math.min(shape.width, shape.height) / 2)
          ),
        };
    }
    if (shape.type === 'circle') {
      if (field === 'cx') return { cx: value };
      if (field === 'cy') return { cy: value };
      if (field === 'radius') return { radius: Math.max(0, value) };
    }
    if (shape.type === 'line') {
      if (field === 'x1') return { x1: value };
      if (field === 'y1') return { y1: value };
      if (field === 'x2') return { x2: value };
      if (field === 'y2') return { y2: value };
    }
    if (shape.type === 'polyline') {
      const m = /^v(\d+)\.(x|y)$/.exec(field);
      if (m) {
        const idx = parseInt(m[1], 10);
        const axis = m[2] as 'x' | 'y';
        const next = shape.points.map((pp, j) =>
          j === idx ? { ...pp, [axis]: value } : pp
        );
        return { points: next };
      }
    }
    return null;
  };

  // Set of field markers that currently have an auto-lock constraint.
  // Computed from the constraint list — a constraint with `field` set
  // counts; manual constraints (no field marker) don't lock the UI.
  const lockedFields = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const c of constraints) if (c.field) out.add(c.field);
    return out;
  }, [constraints]);

  // Build an inset / outset copy of a closed shape. The new shape's boolean
  // operation is flipped so the pair forms a wall (e.g. additive rect + inset
  // subtractive rect = annular wall). Returns null on degenerate offsets.
  const offsetShape = (
    src: Shape,
    distance: number,
    kind: 'inset' | 'outset'
  ): Shape | null => {
    if (distance <= 0) return null;
    const outward = kind === 'outset' ? distance : -distance;
    const flipOp = (op: BoolOp): BoolOp => (op === 'add' ? 'subtract' : 'add');
    if (src.type === 'rect') {
      const newW = src.width + 2 * outward;
      const newH = src.height + 2 * outward;
      if (newW <= 1e-6 || newH <= 1e-6) return null;
      return {
        ...src,
        id: newId(),
        x: src.x - outward,
        y: src.y - outward,
        width: newW,
        height: newH,
        operation: flipOp(src.operation),
      };
    }
    if (src.type === 'rounded-rect') {
      const newW = src.width + 2 * outward;
      const newH = src.height + 2 * outward;
      if (newW <= 1e-6 || newH <= 1e-6) return null;
      const newR = Math.max(0, src.cornerRadius + outward);
      return {
        ...src,
        id: newId(),
        x: src.x - outward,
        y: src.y - outward,
        width: newW,
        height: newH,
        cornerRadius: Math.min(newR, Math.min(newW, newH) / 2),
        operation: flipOp(src.operation),
      };
    }
    if (src.type === 'circle') {
      const newR = src.radius + outward;
      if (newR <= 1e-6) return null;
      return {
        ...src,
        id: newId(),
        radius: newR,
        operation: flipOp(src.operation),
      };
    }
    if (src.type === 'polyline' && src.closed) {
      const pts = offsetPolygon(src.points, outward);
      if (!pts) return null;
      return { ...src, id: newId(), points: pts, operation: flipOp(src.operation) };
    }
    return null;
  };

  const applyOffset = (kind: 'inset' | 'outset', distance: number) => {
    if (!selectedShape) return;
    const next = offsetShape(selectedShape, distance, kind);
    if (!next) {
      flashHint(
        kind === 'inset'
          ? 'Inset distance too large — shape would collapse.'
          : 'Outset failed.'
      );
      return;
    }
    applyShapes((prev) => [...prev, next]);
    setSelectedId(next.id);
  };

  // ─── Constraint creation flow ──────────────────────────────────────────
  const beginConstraint = (type: ConstraintType) => {
    if (pendingConstraint === type) {
      setPendingConstraint(null);
      setPendingRefs([]);
      return;
    }
    setPendingConstraint(type);
    setPendingRefs([]);
    setTool('select');
  };

  const newConstraintId = () =>
    'c_' + Math.random().toString(36).slice(2, 11);

  /**
   * Build coincident constraints binding a freshly-created segment's
   * endpoints (`p1`, `p2`) to existing feature points the user snapped to
   * while drawing. `startRef` and `endRef` are the snap refs captured at
   * draft-start / draft-end; either may be undefined when the user drew
   * onto open space rather than an existing feature. We skip self-refs to
   * the just-created shape (same id) — those would be no-op constraints.
   */
  const buildAutoCoincidents = (
    newShapeId: string,
    startRef: EntityRef | undefined,
    endRef: EntityRef | undefined
  ): Constraint[] => {
    const out: Constraint[] = [];
    if (startRef && startRef.shapeId !== newShapeId) {
      out.push({
        id: newConstraintId(),
        type: 'coincident',
        a: { kind: 'point', shapeId: newShapeId, role: 'p1' },
        b: startRef,
      });
    }
    if (endRef && endRef.shapeId !== newShapeId) {
      out.push({
        id: newConstraintId(),
        type: 'coincident',
        a: { kind: 'point', shapeId: newShapeId, role: 'p2' },
        b: endRef,
      });
    }
    return out;
  };

  const finalizeConstraint = (type: ConstraintType, refs: EntityRef[]) => {
    let next: Constraint | null = null;
    const id = newConstraintId();
    if (type === 'horizontal' || type === 'vertical') {
      // Two-point form: align first picked to second's x (vertical) or
      // y (horizontal). Pre-translate the first point's shape so its
      // picked coord matches the second's, exactly like the coincident
      // pre-shift, so the user sees an immediate snap on creation.
      if (
        refs.length === 2 &&
        refs[0].kind === 'point' &&
        refs[1].kind === 'point'
      ) {
        const a = refs[0];
        const b = refs[1];
        const sa = shapes.find((s) => s.id === a.shapeId);
        const sb = shapes.find((s) => s.id === b.shapeId);
        const pa = sa ? pointAt(sa, a) : null;
        const pb = sb ? pointAt(sb, b) : null;
        next = { id, type, a, b };
        if (pa && pb && sa && !(sa.type === 'line' && sa.frozen)) {
          const dx = type === 'vertical' ? pb.x - pa.x : 0;
          const dy = type === 'horizontal' ? pb.y - pa.y : 0;
          applyShapes(
            (prev) =>
              prev.map((s) =>
                s.id === a.shapeId ? translateShape(s, dx, dy) : s
              ),
            [next]
          );
          setConstraints((p) => [...p, next!]);
          // Sticky tool: keep `pendingConstraint` set so the user can
          // chain more H/V constraints. ESC or another tool clears it.
          setPendingRefs([]);
          setPendingHover(null);
          return;
        }
      } else {
        next = { id, type, ref: refs[0] };
      }
    } else if (type === 'fix') {
      const p = refs[0];
      // Capture current world position as the fix value.
      const layoutShape = shapes.find((s) => s.id === p.shapeId);
      const value = layoutShape ? pointAt(layoutShape, p) : { x: 0, y: 0 };
      if (p.kind === 'point' && value) next = { id, type: 'fix', ref: p, value };
    } else if (type === 'coincident') {
      // Order matters: the first-clicked point is the one that moves to
      // match the second-clicked point. Pre-translate the first point's
      // shape so its picked point lands exactly on the second point's
      // position; the constraint itself is symmetric, so the solver
      // treats both equally on later edits.
      const a = refs[0];
      const b = refs[1];
      const sa = shapes.find((s) => s.id === a.shapeId);
      const sb = shapes.find((s) => s.id === b.shapeId);
      const pa = sa ? pointAt(sa, a) : null;
      const pb = sb ? pointAt(sb, b) : null;
      next = { id, type: 'coincident', a, b };
      if (pa && pb && sa && !(sa.type === 'line' && sa.frozen)) {
        // Skip the shift when the source is frozen (axis line, face edge) —
        // we can't move it; the solver will pull `b`'s shape to it instead.
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        applyShapes(
          (prev) => prev.map((s) => (s.id === a.shapeId ? translateShape(s, dx, dy) : s)),
          [next]
        );
        setConstraints((p) => [...p, next!]);
        // Sticky tool: keep pendingConstraint set; ESC or different
        // toolbar pick exits.
        setPendingRefs([]);
        setPendingHover(null);
        return;
      }
    } else if (type === 'tangent') {
      // One ref must be a line/edge, the other a circle. Order doesn't
      // matter for the solver — normalize to (a = line, b = circle) so the
      // residual code can rely on it.
      let a = refs[0];
      let b = refs[1];
      if (a.kind === 'circle') {
        const tmp = a;
        a = b;
        b = tmp;
      }
      next = { id, type: 'tangent', a, b };
      // Tangency alone is one residual — the solver is otherwise free to
      // stretch the line to any length that satisfies it. Auto-add a
      // `length` constraint at the line's current length so the line keeps
      // its drawn size; user can unlock it if they want a sliding endpoint.
      // (Skipped for rect edges and frozen lines: rect width/height is
      // already a stable parameter, and frozen lines never move.)
      if (a.kind === 'line') {
        const lineShape = shapes.find((s) => s.id === a.shapeId);
        if (lineShape && lineShape.type === 'line' && !lineShape.frozen) {
          const curLen = Math.hypot(
            lineShape.x2 - lineShape.x1,
            lineShape.y2 - lineShape.y1
          );
          if (curLen > 1e-6) {
            const lengthCon: Constraint = {
              id: newConstraintId(),
              type: 'length',
              ref: { kind: 'line', shapeId: a.shapeId },
              value: curLen,
            };
            // Append both at once so they apply together on the first solve.
            const all = [...constraints, next, lengthCon];
            setConstraints(all);
            constraintsRef.current = all;
            applyShapes((p) => p);
            // Sticky tool — see other branches for the rationale.
            setPendingRefs([]);
            setPendingHover(null);
            return;
          }
        }
      }
    } else if (type === 'angle') {
      // Two lines (or rect edges, or axes — all are line-ish refs).
      // Capture the current angle between them as the initial value,
      // signed in radians, A relative to B. Editing the value via the
      // constraints panel pre-rotates line A around its midpoint by the
      // delta so the first-clicked entity is the one that visibly
      // moves to satisfy the new target.
      const a = refs[0];
      const b = refs[1];
      const dirA = lineDirection(a);
      const dirB = lineDirection(b);
      if (!dirA || !dirB) {
        flashHint('Angle: both picks must be lines or rect edges.');
        setPendingRefs([]);
        return;
      }
      let diff = Math.atan2(dirA.y, dirA.x) - Math.atan2(dirB.y, dirB.x);
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff <= -Math.PI) diff += 2 * Math.PI;
      next = { id, type: 'angle', a, b, value: diff };
    } else if (type === 'distance') {
      let a = refs[0];
      let b = refs[1];
      const isLineish = (r: EntityRef) => r.kind === 'line' || r.kind === 'edge';
      const aL = isLineish(a);
      const bL = isLineish(b);
      const aP = a.kind === 'point';
      const bP = b.kind === 'point';
      if (aL && bL) {
        if (!areParallel(a, b)) {
          flashHint('Lines must be parallel — add a parallel constraint first.');
          // Keep the tool sticky on validation hint — clear partial picks.
          setPendingRefs([]);
          return;
        }
      } else if (aP && bP) {
        // Point + point: euclidean distance. No normalization needed.
      } else if ((aP && bL) || (aL && bP)) {
        // Normalize so `a` is the point — the dim line will be drawn
        // perpendicular from the point onto `b`.
        if (aL) {
          const tmp = a;
          a = b;
          b = tmp;
        }
      } else {
        flashHint('Pick two points, two parallel lines, or a point and a line.');
        setPendingRefs([]);
        return;
      }
      const value = currentDistanceBetween(a, b);
      next = { id, type: 'distance', a, b, value, annotation: { offset: 5, labelT: 0.5 } };
    }
    if (next) {
      setConstraints((prev) => [...prev, next!]);
      // Re-solve the current shapes against the new constraint set.
      applyShapes((p) => p, [next]);
    }
    // Sticky tool: keep `pendingConstraint` set so the user can chain
    // multiple constraints. ESC or selecting a different toolbar button
    // exits — both already handled by the existing keyboard / button logic.
    setPendingRefs([]);
    setPendingHover(null);
  };

  const nearestRectEdge = (
    r: { x: number; y: number; width: number; height: number; angle?: number },
    p: Pt
  ): 'top' | 'bottom' | 'left' | 'right' => {
    // The cursor is in world coords; transform it into the rect's
    // pre-rotation frame so the edge comparisons are axis-aligned.
    const c = rectCenter(r);
    const local = rotatePoint(p, c, -(r.angle ?? 0));
    const dTop = Math.abs(local.y - (r.y + r.height));
    const dBot = Math.abs(local.y - r.y);
    const dLeft = Math.abs(local.x - r.x);
    const dRight = Math.abs(local.x - (r.x + r.width));
    const m = Math.min(dTop, dBot, dLeft, dRight);
    if (m === dTop) return 'top';
    if (m === dBot) return 'bottom';
    if (m === dLeft) return 'left';
    return 'right';
  };

  // Direction vector of a line / rect-edge in plane-local mm. Used for
  // parallelism checks and for orienting the dim graphic.
  const lineDirection = (ref: EntityRef): Pt | null => {
    const s = shapes.find((sh) => sh.id === ref.shapeId);
    if (!s) return null;
    if (ref.kind === 'line' && s.type === 'line') {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const L = Math.hypot(dx, dy);
      if (L < 1e-6) return null;
      return { x: dx / L, y: dy / L };
    }
    if (ref.kind === 'edge' && (s.type === 'rect' || s.type === 'rounded-rect')) {
      if (ref.edge === 'top' || ref.edge === 'bottom') return { x: 1, y: 0 };
      return { x: 0, y: 1 };
    }
    return null;
  };

  // Two line / rect-edge refs are parallel when their direction vectors have
  // a near-zero cross-product (within ~0.6°).
  const areParallel = (a: EntityRef, b: EntityRef): boolean => {
    const da = lineDirection(a);
    const db = lineDirection(b);
    if (!da || !db) return false;
    return Math.abs(da.x * db.y - da.y * db.x) < 0.01;
  };

  // Squared distance from a point to a finite segment in plane-local mm.
  const pointToSegmentDist = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    return Math.hypot(p.x - px, p.y - py);
  };

  // Find the closest pickable line / rect-edge to a cursor position, ignoring
  // Konva's z-ordered hit test. Critical for concentric rectangles where the
  // inner edge is geometrically closest but the outer rect's body wins
  // Konva's hit test.
  const nearestPickableLine = (
    cursor: Pt
  ): { ref: EntityRef; dist: number } | null => {
    let best: { ref: EntityRef; dist: number } | null = null;
    const consider = (ref: EntityRef, dist: number) => {
      if (!best || dist < best.dist) best = { ref, dist };
    };
    for (const s of shapes) {
      if (s.type === 'line') {
        const d = pointToSegmentDist(
          cursor,
          { x: s.x1, y: s.y1 },
          { x: s.x2, y: s.y2 }
        );
        consider({ kind: 'line', shapeId: s.id }, d);
      } else if (s.type === 'rect' || s.type === 'rounded-rect') {
        const c = rectCenter(s);
        const a = s.angle ?? 0;
        const rot = (p: Pt) => rotatePoint(p, c, a);
        const tl = rot({ x: s.x, y: s.y + s.height });
        const tr = rot({ x: s.x + s.width, y: s.y + s.height });
        const br = rot({ x: s.x + s.width, y: s.y });
        const bl = rot({ x: s.x, y: s.y });
        const dT = pointToSegmentDist(cursor, tl, tr);
        const dB = pointToSegmentDist(cursor, bl, br);
        const dL = pointToSegmentDist(cursor, bl, tl);
        const dR = pointToSegmentDist(cursor, br, tr);
        consider({ kind: 'edge', shapeId: s.id, edge: 'top' }, dT);
        consider({ kind: 'edge', shapeId: s.id, edge: 'bottom' }, dB);
        consider({ kind: 'edge', shapeId: s.id, edge: 'left' }, dL);
        consider({ kind: 'edge', shapeId: s.id, edge: 'right' }, dR);
      }
    }
    return best;
  };

  // Distance from a point to the nearest spot on a circle of radius r centered
  // at c. The straight line from cursor to circle through center has length
  // |dist(cursor, c) - r| (negative inside the disk, but we take the absolute
  // value so picking an interior click on the curve still works).
  const pointToCircleDist = (p: Pt, c: Pt, r: number): number =>
    Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r);

  // Find the closest pickable circle/arc edge to the cursor — returned as a
  // `circle` EntityRef. Used by the tangent picker so the user can grab a
  // circle even when its body is overlapping other shapes in z-order.
  const nearestPickableCircle = (
    cursor: Pt
  ): { ref: EntityRef; dist: number } | null => {
    let best: { ref: EntityRef; dist: number } | null = null;
    for (const s of shapes) {
      if (s.type === 'circle') {
        const d = pointToCircleDist(cursor, { x: s.cx, y: s.cy }, s.radius);
        if (!best || d < best.dist) best = { ref: { kind: 'circle', shapeId: s.id }, dist: d };
      } else if (s.type === 'arc') {
        const d = pointToCircleDist(cursor, { x: s.cx, y: s.cy }, s.radius);
        if (!best || d < best.dist) best = { ref: { kind: 'circle', shapeId: s.id }, dist: d };
      }
    }
    return best;
  };

  /**
   * Picker for the tangent constraint: returns the closest of (line/edge,
   * circle/arc) within tolerance. Tangent always pairs one of each, so the
   * raw closest match is enough.
   */
  const nearestPickableForTangent = (
    cursor: Pt
  ): { ref: EntityRef; dist: number } | null => {
    const lineHit = nearestPickableLine(cursor);
    const circleHit = nearestPickableCircle(cursor);
    const isAxis = (h: { ref: EntityRef } | null) =>
      !!h && (h.ref.shapeId === AXIS_X_ID || h.ref.shapeId === AXIS_Y_ID);
    // Skip the axis lines for tangent — tangency to an axis would be useful
    // but in practice the user is picking a real line.
    const lineNonAxis = isAxis(lineHit) ? null : lineHit;
    if (lineNonAxis && circleHit) {
      return lineNonAxis.dist <= circleHit.dist ? lineNonAxis : circleHit;
    }
    return lineNonAxis ?? circleHit;
  };

  // Find the closest pickable point (vertex / center) to the cursor, returned
  // as a `point` EntityRef. Used by the distance picker so the user can grab
  // a vertex as one end of a point-to-line distance.
  const nearestPickablePoint = (
    cursor: Pt
  ): { ref: EntityRef; dist: number } | null => {
    let best: { ref: EntityRef; dist: number } | null = null;
    const d = (p: Pt) => Math.hypot(p.x - cursor.x, p.y - cursor.y);
    const consider = (ref: EntityRef, dist: number) => {
      if (!best || dist < best.dist) best = { ref, dist };
    };
    for (const s of shapes) {
      if (s.type === 'rect' || s.type === 'rounded-rect') {
        const c = rectCenter(s);
        const a = s.angle ?? 0;
        const rot = (p: Pt) => rotatePoint(p, c, a);
        consider({ kind: 'point', shapeId: s.id, role: 'tl' }, d(rot({ x: s.x, y: s.y + s.height })));
        consider({ kind: 'point', shapeId: s.id, role: 'tr' }, d(rot({ x: s.x + s.width, y: s.y + s.height })));
        consider({ kind: 'point', shapeId: s.id, role: 'br' }, d(rot({ x: s.x + s.width, y: s.y })));
        consider({ kind: 'point', shapeId: s.id, role: 'bl' }, d(rot({ x: s.x, y: s.y })));
        consider({ kind: 'point', shapeId: s.id, role: 'center' }, d(c));
      } else if (s.type === 'circle') {
        consider({ kind: 'point', shapeId: s.id, role: 'center' }, d({ x: s.cx, y: s.cy }));
      } else if (s.type === 'arc') {
        consider({ kind: 'point', shapeId: s.id, role: 'center' }, d({ x: s.cx, y: s.cy }));
        const sp = { x: s.cx + s.radius * Math.cos(s.startAngle), y: s.cy + s.radius * Math.sin(s.startAngle) };
        const ep = { x: s.cx + s.radius * Math.cos(s.endAngle), y: s.cy + s.radius * Math.sin(s.endAngle) };
        consider({ kind: 'point', shapeId: s.id, role: 'p1' }, d(sp));
        consider({ kind: 'point', shapeId: s.id, role: 'p2' }, d(ep));
      } else if (s.type === 'line') {
        // Axis endpoints sit ±100km away — never useful as pick points.
        if (s.id === AXIS_X_ID || s.id === AXIS_Y_ID) continue;
        consider({ kind: 'point', shapeId: s.id, role: 'p1' }, d({ x: s.x1, y: s.y1 }));
        consider({ kind: 'point', shapeId: s.id, role: 'p2' }, d({ x: s.x2, y: s.y2 }));
      } else if (s.type === 'polyline') {
        for (let i = 0; i < s.points.length; i++) {
          consider({ kind: 'point', shapeId: s.id, role: 'vertex', vertexIdx: i }, d(s.points[i]));
        }
      }
    }
    return best;
  };

  /**
   * Best entity to pick for the Distance tool: closest of
   * (vertex / center / line / edge). Points get priority within `pointTolMm`
   * so a vertex "wins" when the cursor is on top of one; otherwise the
   * underlying line wins (feels right when the cursor is mid-segment).
   *
   * The local sketch axes are pickable too, but only "win" when no real
   * shape entity is closer — otherwise clicking near the axis would steal
   * the pick from a nearby vertex/edge.
   */
  const nearestPickableForDistance = (
    cursor: Pt,
    pointTolMm: number
  ): { ref: EntityRef; dist: number } | null => {
    const isAxisHit = (h: { ref: EntityRef } | null) =>
      !!h && (h.ref.shapeId === AXIS_X_ID || h.ref.shapeId === AXIS_Y_ID);
    const lineHit = nearestPickableLine(cursor);
    const pointHit = nearestPickablePoint(cursor);
    // If the line hit is an axis, defer to a closer non-axis line/point.
    const axisHit = isAxisHit(lineHit) ? lineHit : null;
    const lineNonAxis = isAxisHit(lineHit) ? null : lineHit;
    if (pointHit && pointHit.dist <= pointTolMm) {
      if (!lineNonAxis || pointHit.dist <= lineNonAxis.dist) return pointHit;
    }
    if (lineNonAxis) return lineNonAxis;
    return axisHit;
  };

  // Short human-readable label for an entity ref, used in the constraints
  // panel ("Rect#a4f3 right edge", "Line#7e2 p1", …). Falls back to a short
  // hash so a missing shape still displays.
  const describeEntityRef = (ref: EntityRef): string => {
    const s = shapes.find((sh) => sh.id === ref.shapeId);
    const stub = ref.shapeId.slice(0, 4);
    if (!s) return `${ref.kind}#${stub}`;
    const typeLabel =
      s.type === 'rect'
        ? 'Rect'
        : s.type === 'rounded-rect'
        ? 'RRect'
        : s.type === 'circle'
        ? 'Circle'
        : s.type === 'arc'
        ? 'Arc'
        : s.type === 'line'
        ? s.frozen
          ? 'Face edge'
          : 'Line'
        : 'Polyline';
    if (ref.kind === 'point') {
      const role =
        ref.role === 'vertex' && ref.vertexIdx != null
          ? `v${ref.vertexIdx}`
          : ref.role;
      return `${typeLabel}#${stub} ${role}`;
    }
    if (ref.kind === 'edge') {
      return `${typeLabel}#${stub} ${ref.edge}`;
    }
    if (ref.kind === 'circle') return `${typeLabel}#${stub}`;
    return `${typeLabel}#${stub}`;
  };

  // Endpoints of a line / rect-edge in plane-local mm.
  const lineEndsOf = (ref: EntityRef): { p1: Pt; p2: Pt } | null => {
    const s = shapes.find((sh) => sh.id === ref.shapeId);
    if (!s) return null;
    if (ref.kind === 'line' && s.type === 'line') {
      return { p1: { x: s.x1, y: s.y1 }, p2: { x: s.x2, y: s.y2 } };
    }
    if (ref.kind === 'edge' && (s.type === 'rect' || s.type === 'rounded-rect')) {
      const w = s.width, h = s.height;
      const c = rectCenter(s);
      const a = s.angle ?? 0;
      const rot = (p: Pt) => rotatePoint(p, c, a);
      if (ref.edge === 'top') return { p1: rot({ x: s.x, y: s.y + h }), p2: rot({ x: s.x + w, y: s.y + h }) };
      if (ref.edge === 'bottom') return { p1: rot({ x: s.x, y: s.y }), p2: rot({ x: s.x + w, y: s.y }) };
      if (ref.edge === 'left') return { p1: rot({ x: s.x, y: s.y }), p2: rot({ x: s.x, y: s.y + h }) };
      if (ref.edge === 'right') return { p1: rot({ x: s.x + w, y: s.y }), p2: rot({ x: s.x + w, y: s.y + h }) };
    }
    return null;
  };

  // Compute the current geometric distance between two entity refs. Mirrors
  // the solver's residual logic: line refs use perpendicular distance from
  // the other entity, circle refs subtract their radius, points are direct.
  // Perpendicular distance between two parallel line / rect-edge entities,
  // measured from a's midpoint to b. Used as the initial value of a fresh
  // distance constraint so the solver doesn't snap geometry to 0.
  const currentDistanceBetween = (a: EntityRef, b: EntityRef): number => {
    const perpDist = (p: Pt, line: { p1: Pt; p2: Pt }) => {
      const dx = line.p2.x - line.p1.x;
      const dy = line.p2.y - line.p1.y;
      const len = Math.hypot(dx, dy) || 1;
      return Math.abs(((p.x - line.p1.x) * dy - (p.y - line.p1.y) * dx) / len);
    };
    const ptOf = (r: EntityRef) => {
      if (r.kind !== 'point') return null;
      const s = shapes.find((sh) => sh.id === r.shapeId);
      return s ? pointAt(s, r) : null;
    };
    const lineA = lineEndsOf(a);
    const lineB = lineEndsOf(b);
    if (lineA && lineB) {
      const midA = {
        x: (lineA.p1.x + lineA.p2.x) / 2,
        y: (lineA.p1.y + lineA.p2.y) / 2,
      };
      return perpDist(midA, lineB);
    }
    if (a.kind === 'point' && b.kind === 'point') {
      const pa = ptOf(a);
      const pb = ptOf(b);
      if (pa && pb) return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    }
    if (a.kind === 'point' && lineB) {
      const pa = ptOf(a);
      if (pa) return perpDist(pa, lineB);
    }
    if (b.kind === 'point' && lineA) {
      const pb = ptOf(b);
      if (pb) return perpDist(pb, lineA);
    }
    return 0;
  };

  // Lookup the world position (in plane-local mm) of a Point ref on a shape.
  const pointAt = (s: Shape, ref: EntityRef): Pt | null => {
    if (ref.kind !== 'point') return null;
    if (s.type === 'line') {
      if (ref.role === 'p1') return { x: s.x1, y: s.y1 };
      if (ref.role === 'p2') return { x: s.x2, y: s.y2 };
    } else if (s.type === 'circle') {
      if (ref.role === 'center') return { x: s.cx, y: s.cy };
    } else if (s.type === 'arc') {
      if (ref.role === 'center') return { x: s.cx, y: s.cy };
      if (ref.role === 'p1')
        return {
          x: s.cx + s.radius * Math.cos(s.startAngle),
          y: s.cy + s.radius * Math.sin(s.startAngle),
        };
      if (ref.role === 'p2')
        return {
          x: s.cx + s.radius * Math.cos(s.endAngle),
          y: s.cy + s.radius * Math.sin(s.endAngle),
        };
    } else if (s.type === 'rect' || s.type === 'rounded-rect') {
      const c = rectCenter(s);
      const a = s.angle ?? 0;
      const rot = (p: Pt) => rotatePoint(p, c, a);
      if (ref.role === 'tl') return rot({ x: s.x, y: s.y + s.height });
      if (ref.role === 'tr') return rot({ x: s.x + s.width, y: s.y + s.height });
      if (ref.role === 'br') return rot({ x: s.x + s.width, y: s.y });
      if (ref.role === 'bl') return rot({ x: s.x, y: s.y });
      if (ref.role === 'center') return c;
    } else if (s.type === 'polyline' && ref.role === 'vertex' && ref.vertexIdx != null) {
      return s.points[ref.vertexIdx] ?? null;
    }
    return null;
  };

  // Pick an EntityRef while a constraint is pending. Decides what role the
  // shape contributes (point, line, circle, edge) based on the constraint's
  // needs.
  // Closest point-role on a rect to the cursor. Considers all four corners
  // plus the center so the picker matches what the user clicked instead of
  // always returning 'tl'.
  const nearestRectPointRole = (
    s: { x: number; y: number; width: number; height: number; angle?: number },
    cursor: Pt
  ): 'tl' | 'tr' | 'br' | 'bl' | 'center' => {
    const c = rectCenter(s);
    const a = s.angle ?? 0;
    const rot = (p: Pt) => rotatePoint(p, c, a);
    const cands: { role: 'tl' | 'tr' | 'br' | 'bl' | 'center'; pt: Pt }[] = [
      { role: 'tl', pt: rot({ x: s.x, y: s.y + s.height }) },
      { role: 'tr', pt: rot({ x: s.x + s.width, y: s.y + s.height }) },
      { role: 'br', pt: rot({ x: s.x + s.width, y: s.y }) },
      { role: 'bl', pt: rot({ x: s.x, y: s.y }) },
      { role: 'center', pt: c },
    ];
    let best = cands[0];
    let bestD = Infinity;
    for (const cand of cands) {
      const d = Math.hypot(cand.pt.x - cursor.x, cand.pt.y - cursor.y);
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
    return best.role;
  };

  const pickRefForConstraint = (s: Shape, cursor: Pt | null): EntityRef | null => {
    if (!pendingConstraint) return null;
    const needsLineish =
      pendingConstraint === 'horizontal' ||
      pendingConstraint === 'vertical' ||
      pendingConstraint === 'distance';
    const needsPoint =
      pendingConstraint === 'fix' || pendingConstraint === 'coincident';
    // Tangent needs one line/edge + one circle (or arc, treated as a circle).
    if (pendingConstraint === 'tangent') {
      if (s.type === 'line') return { kind: 'line', shapeId: s.id };
      if (s.type === 'rect' || s.type === 'rounded-rect') {
        const edge: 'top' | 'bottom' | 'left' | 'right' = cursor
          ? nearestRectEdge(s, cursor)
          : 'top';
        return { kind: 'edge', shapeId: s.id, edge };
      }
      if (s.type === 'circle' || s.type === 'arc') return { kind: 'circle', shapeId: s.id };
      return null;
    }
    if (needsLineish) {
      if (s.type === 'line') return { kind: 'line', shapeId: s.id };
      if (s.type === 'rect' || s.type === 'rounded-rect') {
        // Edge nearest to the cursor in plane-local mm. Falls back to top if
        // cursor info isn't available.
        const edge: 'top' | 'bottom' | 'left' | 'right' = cursor
          ? nearestRectEdge(s, cursor)
          : 'top';
        return { kind: 'edge', shapeId: s.id, edge };
      }
      return null;
    }
    if (needsPoint) {
      if (s.type === 'line') {
        // Nearest endpoint to the cursor (or p1 as fallback).
        if (cursor) {
          const d1 = Math.hypot(s.x1 - cursor.x, s.y1 - cursor.y);
          const d2 = Math.hypot(s.x2 - cursor.x, s.y2 - cursor.y);
          return { kind: 'point', shapeId: s.id, role: d2 < d1 ? 'p2' : 'p1' };
        }
        return { kind: 'point', shapeId: s.id, role: 'p1' };
      }
      if (s.type === 'circle') return { kind: 'point', shapeId: s.id, role: 'center' };
      if (s.type === 'arc') {
        // Nearest of center / start / end to the cursor.
        if (cursor) {
          const sp = { x: s.cx + s.radius * Math.cos(s.startAngle), y: s.cy + s.radius * Math.sin(s.startAngle) };
          const ep = { x: s.cx + s.radius * Math.cos(s.endAngle), y: s.cy + s.radius * Math.sin(s.endAngle) };
          const dC = Math.hypot(s.cx - cursor.x, s.cy - cursor.y);
          const d1 = Math.hypot(sp.x - cursor.x, sp.y - cursor.y);
          const d2 = Math.hypot(ep.x - cursor.x, ep.y - cursor.y);
          const m = Math.min(dC, d1, d2);
          if (m === dC) return { kind: 'point', shapeId: s.id, role: 'center' };
          return { kind: 'point', shapeId: s.id, role: m === d1 ? 'p1' : 'p2' };
        }
        return { kind: 'point', shapeId: s.id, role: 'center' };
      }
      if (s.type === 'rect' || s.type === 'rounded-rect') {
        const role = cursor ? nearestRectPointRole(s, cursor) : 'tl';
        return { kind: 'point', shapeId: s.id, role };
      }
      if (s.type === 'polyline') {
        // Nearest vertex to the cursor (or vertex 0 as fallback).
        let bestIdx = 0;
        if (cursor) {
          let bestD = Infinity;
          for (let i = 0; i < s.points.length; i++) {
            const p = s.points[i];
            const d = Math.hypot(p.x - cursor.x, p.y - cursor.y);
            if (d < bestD) {
              bestD = d;
              bestIdx = i;
            }
          }
        }
        return { kind: 'point', shapeId: s.id, role: 'vertex', vertexIdx: bestIdx };
      }
    }
    return null;
  };

  /**
   * Effective arity for the current constraint pick. `horizontal` and
   * `vertical` accept two shapes:
   *   - a single line / rect-edge → orient that segment
   *   - two points → align them so they share an x or y coord (first
   *     point moves to satisfy)
   * The picker promotes the arity to 2 once the first ref is a point.
   */
  const effectiveArity = (type: ConstraintType, refs: EntityRef[]): number => {
    if ((type === 'horizontal' || type === 'vertical') && refs.length >= 1) {
      return refs[0].kind === 'point' ? 2 : 1;
    }
    return arity(type);
  };

  const offerRef = (ref: EntityRef) => {
    if (!pendingConstraint) return;
    const refs = [...pendingRefs, ref];
    if (
      refs.length >= effectiveArity(pendingConstraint, refs) &&
      canCreate(pendingConstraint, refs)
    ) {
      finalizeConstraint(pendingConstraint, refs);
    } else {
      setPendingRefs(refs);
    }
  };

  const projectToScreen = (p: Pt) => ({
    sx: size.w / 2 + view.panX + p.x * screenScale,
    sy: size.h / 2 + view.panY - p.y * screenScale,
  });

  const openLengthEditor = (s: LineShape) => {
    const mid = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
    const { sx, sy } = projectToScreen(mid);
    const len = dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
    setInlineEditor({ target: 'shape', shapeId: s.id, kind: 'length', sx, sy, value: len.toFixed(2) });
  };

  const openRadiusEditor = (s: CircleShape) => {
    const { sx, sy } = projectToScreen({ x: s.cx + s.radius, y: s.cy });
    setInlineEditor({ target: 'shape', shapeId: s.id, kind: 'radius', sx, sy, value: s.radius.toFixed(2) });
  };

  // Pick the nearest edge of the rect to the world-space click point and open
  // an editor anchored to that edge's midpoint. Top/bottom edges edit width,
  // left/right edit height. The (x, y) top-left corner stays put.
  const openRectEdgeEditor = (s: RectShape, click: Pt) => {
    const top = s.y + s.height;
    const bot = s.y;
    const left = s.x;
    const right = s.x + s.width;
    const dTop = Math.abs(click.y - top);
    const dBot = Math.abs(click.y - bot);
    const dLeft = Math.abs(click.x - left);
    const dRight = Math.abs(click.x - right);
    const dMin = Math.min(dTop, dBot, dLeft, dRight);
    let kind: 'rect-width' | 'rect-height';
    let value: number;
    let edgeMid: Pt;
    if (dMin === dTop) {
      kind = 'rect-width';
      value = s.width;
      edgeMid = { x: s.x + s.width / 2, y: top };
    } else if (dMin === dBot) {
      kind = 'rect-width';
      value = s.width;
      edgeMid = { x: s.x + s.width / 2, y: bot };
    } else if (dMin === dLeft) {
      kind = 'rect-height';
      value = s.height;
      edgeMid = { x: left, y: s.y + s.height / 2 };
    } else {
      kind = 'rect-height';
      value = s.height;
      edgeMid = { x: right, y: s.y + s.height / 2 };
    }
    const { sx, sy } = projectToScreen(edgeMid);
    setInlineEditor({ target: 'shape', shapeId: s.id, kind, sx, sy, value: value.toFixed(2) });
  };

  const commitInlineEditor = () => {
    if (!inlineEditor) return;
    const evaluated = evalNumExpression(inlineEditor.value);
    if (evaluated === null) {
      setInlineEditor(null);
      return;
    }
    const v = evaluated;
    if (inlineEditor.target === 'constraint') {
      // Update the targeted distance constraint's value, then resolve. Push
      // into the ref synchronously so applyShapes sees the new set on the
      // next render (constraintsRef otherwise updates one tick late).
      const id = inlineEditor.constraintId;
      const next = constraints.map((c) =>
        c.id === id && c.type === 'distance' ? ({ ...c, value: v } as Constraint) : c
      );
      setConstraints(next);
      constraintsRef.current = next;
      applyShapes((p) => p);
      setInlineEditor(null);
      return;
    }
    const shape = shapes.find((sh) => sh.id === inlineEditor.shapeId);
    if (!shape) {
      setInlineEditor(null);
      return;
    }
    if (inlineEditor.kind === 'length' && shape.type === 'line') {
      const dx = shape.x2 - shape.x1;
      const dy = shape.y2 - shape.y1;
      const cur = Math.hypot(dx, dy);
      if (cur > 1e-9 && v >= 0) {
        const k = v / cur;
        updateShape(shape.id, { x2: shape.x1 + dx * k, y2: shape.y1 + dy * k });
        // Persist as a length constraint so subsequent edits respect this value.
        const ref: EntityRef = { kind: 'line', shapeId: shape.id };
        upsertLengthConstraint(ref, v);
      }
    } else if (inlineEditor.kind === 'radius' && shape.type === 'circle') {
      updateShape(shape.id, { radius: Math.max(0, v) });
      // (radius constraint persistence comes in P3)
    } else if (inlineEditor.kind === 'rect-width' && shape.type === 'rect') {
      updateShape(shape.id, { width: Math.max(0, v) });
    } else if (inlineEditor.kind === 'rect-height' && shape.type === 'rect') {
      updateShape(shape.id, { height: Math.max(0, v) });
    }
    setInlineEditor(null);
  };

  // If a length constraint already exists on this entity, update its value.
  // Otherwise add a new one. Keeps inline-edits idempotent.
  const upsertLengthConstraint = (ref: EntityRef, value: number) => {
    setConstraints((prev) => {
      const existing = prev.find(
        (c) => c.type === 'length' && sameRef(c.ref, ref)
      );
      if (existing) {
        return prev.map((c) =>
          c === existing ? ({ ...c, value } as Constraint) : c
        );
      }
      return [...prev, { id: 'c_' + Math.random().toString(36).slice(2, 11), type: 'length', ref, value } as Constraint];
    });
  };

  const sameRef = (a: EntityRef, b: EntityRef): boolean => {
    if (a.kind !== b.kind || a.shapeId !== b.shapeId) return false;
    if (a.kind === 'point' && b.kind === 'point') {
      return a.role === b.role && (a.vertexIdx ?? -1) === (b.vertexIdx ?? -1);
    }
    if (a.kind === 'edge' && b.kind === 'edge') return a.edge === b.edge;
    return true;
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setShapes((prev) => prev.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  };

  const commitPolyline = (points: Pt[], closed: boolean) => {
    if (points.length < 2) return;
    const id = newId();
    setShapes((prev) => [...prev, { id, type: 'polyline', points, closed, operation: 'add' }]);
    setPolyDraft(null);
    setSelectedId(id);
    // Sticky tool: stay on the polyline tool so the user can draw
    // another. Esc or picking a different tool exits.
  };

  // ---- Pan / zoom ----
  const onWheel = (e: any) => {
    e.evt.preventDefault?.();
    const stage = e.target.getStage();
    const p = stage.getPointerPosition();
    if (!p) return;
    const oldZoom = view.zoom;
    const factor = Math.exp(-e.evt.deltaY * 0.0015);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
    if (newZoom === oldZoom) return;
    // Anchor world point under cursor: pick world coords pre-zoom, then solve pan to keep them put.
    const wx = (p.x - size.w / 2 - view.panX) / (PX_PER_MM * oldZoom);
    const wy = (size.h / 2 + view.panY - p.y) / (PX_PER_MM * oldZoom);
    const newPanX = p.x - size.w / 2 - wx * PX_PER_MM * newZoom;
    const newPanY = -(size.h / 2 - p.y - wy * PX_PER_MM * newZoom);
    setView({ panX: newPanX, panY: newPanY, zoom: newZoom });
  };

  // ---- Pointer handlers ----
  // Unified pointer handlers — fire for mouse, touch, and pen (Apple
  // Pencil included). iOS Safari does NOT fire mouse events for pen
  // input, so handling `onPointerDown` is required for iPad usage.
  const onPointerDown = (e: any) => {
    const stage = e.target.getStage();
    // Middle-button pan (or right-button as a fallback for trackpad users)
    if (e.evt?.button === 1 || e.evt?.button === 2) {
      e.evt.preventDefault?.();
      isPanningRef.current = true;
      panStartRef.current = {
        cx: e.evt.clientX,
        cy: e.evt.clientY,
        panX: view.panX,
        panY: view.panY,
      };
      return;
    }
    const pt = pointerToWorld(stage);
    if (!pt) return;
    const onEmpty = e.target === stage;

    // Distance pick: prefer geometry-based picking so concentric / overlapping
    // rects don't fight Konva's z-order, AND so vertices win when the cursor
    // is parked on one (point-to-line distance is supported).
    if (pendingConstraint === 'distance') {
      const tolMm = 8 / screenScale; // hit tolerance in screen px → mm
      const pointTolMm = 6 / screenScale; // tighter tolerance for snap-to-vertex
      const hit = nearestPickableForDistance(pt, pointTolMm);
      if (hit && hit.dist <= tolMm) {
        const dup = pendingRefs.some((r) => sameRef(r, hit.ref));
        if (!dup) {
          e.cancelBubble = true;
          offerRef(hit.ref);
        }
      }
      return;
    }

    // Tangent: pick a line/edge or circle/arc. Like distance, route through
    // the geometry-based picker so overlapping shapes don't depend on
    // Konva's z-order.
    if (pendingConstraint === 'tangent') {
      const tolMm = 8 / screenScale;
      const hit = nearestPickableForTangent(pt);
      if (hit && hit.dist <= tolMm) {
        const dup = pendingRefs.some((r) => sameRef(r, hit.ref));
        // Tangent needs one line + one circle — reject duplicates of the
        // same kind so a stray second click on a line doesn't overwrite the
        // first pick.
        const sameKind = pendingRefs.some(
          (r) =>
            (r.kind === 'circle') === (hit.ref.kind === 'circle')
        );
        if (!dup && !sameKind) {
          e.cancelBubble = true;
          offerRef(hit.ref);
        } else if (sameKind) {
          flashHint(
            hit.ref.kind === 'circle'
              ? 'Tangent: pick a line/edge for the second target.'
              : 'Tangent: pick a circle / arc for the second target.'
          );
        }
      }
      return;
    }

    // Angle: two lines / rect-edges (or axes — all are line-like). The
    // lines don't need to be near each other — we just look up the
    // nearest line under the cursor for each click.
    if (pendingConstraint === 'angle') {
      const tolMm = 8 / screenScale;
      const hit = nearestPickableLine(pt);
      if (hit && hit.dist <= tolMm) {
        const dup = pendingRefs.some((r) => sameRef(r, hit.ref));
        if (!dup) {
          e.cancelBubble = true;
          offerRef(hit.ref);
        }
      }
      return;
    }

    // Horizontal / vertical: accept either a line / rect-edge (orient that
    // segment) OR a pair of points (align them). We use the same hybrid
    // picker as Distance for the first click — it returns whichever is
    // closer, line-like or point. Once the first ref is a point we
    // require the second to be a point too.
    if (pendingConstraint === 'horizontal' || pendingConstraint === 'vertical') {
      const tolMm = 8 / screenScale;
      const pointTolMm = 6 / screenScale;
      const havePoint =
        pendingRefs.length === 1 && pendingRefs[0].kind === 'point';
      let hit: { ref: EntityRef; dist: number } | null = null;
      if (havePoint) {
        // Second click must be a point.
        const ph = nearestPickablePoint(pt);
        if (ph && ph.dist <= 12 / screenScale) hit = ph;
      } else {
        // First click — prefer line/edge but accept a point too.
        hit = nearestPickableForDistance(pt, pointTolMm);
      }
      if (hit && hit.dist <= tolMm) {
        const dup = pendingRefs.some((r) => sameRef(r, hit.ref));
        if (!dup) {
          e.cancelBubble = true;
          offerRef(hit.ref);
        }
      }
      return;
    }

    // Point-only picks (coincident, fix): geometry-based search across every
    // shape's vertices / centers. The per-shape select handler skips for
    // these now too, so the Stage handler is the single source of truth and
    // a click anywhere within `tolMm` of a feature point will register —
    // no need to land exactly on the shape's fill.
    if (pendingConstraint === 'coincident' || pendingConstraint === 'fix') {
      const tolMm = 12 / screenScale;
      const hit = nearestPickablePoint(pt);
      if (hit && hit.dist <= tolMm) {
        const dup = pendingRefs.some((r) => sameRef(r, hit.ref));
        if (!dup) {
          e.cancelBubble = true;
          offerRef(hit.ref);
        }
      }
      return;
    }

    if (tool === 'select') {
      if (onEmpty) setSelectedId(null);
      return;
    }
    if (tool === 'rect') {
      setDraft({ id: newId(), type: 'rect', x: pt.x, y: pt.y, width: 0, height: 0, operation: 'add' });
      return;
    }
    if (tool === 'rounded-rect') {
      // Default cornerRadius is set on commit (proportional to the smaller
      // dimension) so the visible corner curvature scales with the box.
      setDraft({
        id: newId(),
        type: 'rounded-rect',
        x: pt.x,
        y: pt.y,
        width: 0,
        height: 0,
        cornerRadius: 0,
        operation: 'add',
      });
      return;
    }
    if (tool === 'circle') {
      setDraft({ id: newId(), type: 'circle', cx: pt.x, cy: pt.y, radius: 0, operation: 'add' });
      return;
    }
    if (tool === 'arc') {
      // 3-click flow: click 1 sets START, click 2 sets END, click 3 sets a
      // "point on arc" that defines the curve. We track snap refs at
      // clicks 1 and 2 so the committed arc gets coincident constraints to
      // any existing endpoints it landed on.
      if (!arcDraft) {
        setArcDraft({ start: pt, end: null });
        setArcCursor(pt);
        draftSnapRefsRef.current = {
          arcStart: lastSnapRefRef.current ?? undefined,
        };
      } else if (arcDraft.end === null) {
        setArcDraft({ start: arcDraft.start, end: pt });
        draftSnapRefsRef.current.arcEnd = lastSnapRefRef.current ?? undefined;
      } else {
        // Third click — `pt` is the "on-curve" point. Args: (start, on-arc, end).
        const arc = arcFromThreePoints(arcDraft.start, pt, arcDraft.end);
        if (arc) {
          const newArcId = newId();
          const startRef = draftSnapRefsRef.current.arcStart;
          const endRef = draftSnapRefsRef.current.arcEnd;
          const newCons = buildAutoCoincidents(newArcId, startRef, endRef);
          applyShapes(
            (prev) => [...prev, { id: newArcId, type: 'arc', ...arc }],
            newCons.length > 0 ? newCons : undefined
          );
          if (newCons.length > 0) {
            const updated = [...constraintsRef.current, ...newCons];
            setConstraints(updated);
            constraintsRef.current = updated;
          }
        }
        setArcDraft(null);
        setArcCursor(null);
        draftSnapRefsRef.current = {};
      }
      return;
    }
    if (tool === 'line') {
      setDraft({ id: newId(), type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
      draftSnapRefsRef.current = {
        lineStart: lastSnapRefRef.current ?? undefined,
      };
      return;
    }
    if (tool === 'polyline') {
      if (!polyDraft) {
        setPolyDraft({ points: [pt], preview: pt });
      } else {
        const first = polyDraft.points[0];
        if (polyDraft.points.length >= 2 && dist(first, pt) <= CLOSE_THRESHOLD_MM) {
          commitPolyline(polyDraft.points, true);
        } else {
          // Apply 5° angle snap relative to the previous segment, unless
          // shift is held or the cursor already snapped to an existing
          // feature point (we don't want to override a snap target).
          const shiftHeld = !!e.evt?.shiftKey;
          const skipAngle = shiftHeld || lastSnapRefRef.current !== null;
          const placed = skipAngle
            ? pt
            : applyPolyAngleSnap(polyDraft.points, pt).pt;
          setPolyDraft({ points: [...polyDraft.points, placed], preview: placed });
        }
      }
    }
  };

  const onPointerMove = (e: any) => {
    if (isPanningRef.current && panStartRef.current) {
      // Snapshot before the async setView callback runs — by the time
      // React invokes the updater, the ref may have been cleared (mouse
      // released between schedule and callback).
      const start = panStartRef.current;
      const dx = e.evt.clientX - start.cx;
      const dy = e.evt.clientY - start.cy;
      setView((v) => ({
        ...v,
        panX: start.panX + dx,
        panY: start.panY + dy,
      }));
      return;
    }
    // Dim graphic drag (offset or labelT). Skip the rest so we don't fall
    // through into draft / hover handling.
    if (dimDrag) {
      const stage = e.target.getStage();
      const p = stage.getPointerPosition();
      if (!p) return;
      const dxPx = p.x - dimDrag.baseScreenX;
      const dyPx = p.y - dimDrag.baseScreenY;
      // Convert screen-px delta to mm along the chosen direction. Y is flipped
      // between screen and world (worldY = -screenY / scale), so dy is negated.
      const along = (v: Pt) =>
        (dxPx * v.x - dyPx * v.y) / screenScale;
      const id = dimDrag.constraintId;
      setConstraints((prev) =>
        prev.map((cc) => {
          if (cc.id !== id || cc.type !== 'distance') return cc;
          const cur = cc.annotation ?? { offset: 5, labelT: 0.5, labelP: 0 };
          if (dimDrag.kind === 'offset') {
            return {
              ...cc,
              annotation: {
                ...cur,
                offset: dimDrag.baseValue + along(dimDrag.offsetDir),
              },
            };
          }
          const len = Math.max(1e-6, dimDrag.alongLenMm);
          return {
            ...cc,
            annotation: {
              ...cur,
              labelT: dimDrag.baseT + along(dimDrag.alongDir) / len,
              labelP: dimDrag.baseP + along(dimDrag.perpDir),
            },
          };
        })
      );
      return;
    }
    const stage = e.target.getStage();
    const pt = pointerToWorld(stage);
    if (!pt) return;
    lastCursorMmRef.current = pt;

    // Constraint hover preview: highlight the entity that would be picked
    // if the user clicked right now. Distance accepts points OR lines;
    // coincident / fix only points.
    if (pendingConstraint === 'distance') {
      const tolMm = 8 / screenScale;
      const pointTolMm = 6 / screenScale;
      const hit = nearestPickableForDistance(pt, pointTolMm);
      const next = hit && hit.dist <= tolMm ? hit.ref : null;
      const dup = next && pendingRefs.some((r) => sameRef(r, next));
      const desired = dup ? null : next;
      if (
        (desired === null) !== (pendingHover === null) ||
        (desired && pendingHover && !sameRef(desired, pendingHover))
      ) {
        setPendingHover(desired);
      }
    } else if (
      pendingConstraint === 'coincident' ||
      pendingConstraint === 'fix'
    ) {
      const tolMm = 12 / screenScale;
      const hit = nearestPickablePoint(pt);
      const next = hit && hit.dist <= tolMm ? hit.ref : null;
      const dup = next && pendingRefs.some((r) => sameRef(r, next));
      const desired = dup ? null : next;
      if (
        (desired === null) !== (pendingHover === null) ||
        (desired && pendingHover && !sameRef(desired, pendingHover))
      ) {
        setPendingHover(desired);
      }
    } else if (pendingConstraint === 'tangent') {
      const tolMm = 8 / screenScale;
      const hit = nearestPickableForTangent(pt);
      const next = hit && hit.dist <= tolMm ? hit.ref : null;
      const dup = next && pendingRefs.some((r) => sameRef(r, next));
      const sameKind =
        next &&
        pendingRefs.some((r) => (r.kind === 'circle') === (next.kind === 'circle'));
      const desired = dup || sameKind ? null : next;
      if (
        (desired === null) !== (pendingHover === null) ||
        (desired && pendingHover && !sameRef(desired, pendingHover))
      ) {
        setPendingHover(desired);
      }
    } else if (pendingConstraint === 'angle') {
      const tolMm = 8 / screenScale;
      const hit = nearestPickableLine(pt);
      const next = hit && hit.dist <= tolMm ? hit.ref : null;
      const dup = next && pendingRefs.some((r) => sameRef(r, next));
      const desired = dup ? null : next;
      if (
        (desired === null) !== (pendingHover === null) ||
        (desired && pendingHover && !sameRef(desired, pendingHover))
      ) {
        setPendingHover(desired);
      }
    } else if (
      pendingConstraint === 'horizontal' ||
      pendingConstraint === 'vertical'
    ) {
      const tolMm = 8 / screenScale;
      const pointTolMm = 6 / screenScale;
      const havePoint =
        pendingRefs.length === 1 && pendingRefs[0].kind === 'point';
      let hit: { ref: EntityRef; dist: number } | null = null;
      if (havePoint) {
        const ph = nearestPickablePoint(pt);
        if (ph && ph.dist <= 12 / screenScale) hit = ph;
      } else {
        hit = nearestPickableForDistance(pt, pointTolMm);
      }
      const next = hit && hit.dist <= tolMm ? hit.ref : null;
      const dup = next && pendingRefs.some((r) => sameRef(r, next));
      const desired = dup ? null : next;
      if (
        (desired === null) !== (pendingHover === null) ||
        (desired && pendingHover && !sameRef(desired, pendingHover))
      ) {
        setPendingHover(desired);
      }
    } else if (pendingHover) {
      setPendingHover(null);
    }

    if (draft) {
      if (draft.type === 'rect') {
        setDraft({ ...draft, width: pt.x - draft.x, height: pt.y - draft.y });
      } else if (draft.type === 'rounded-rect') {
        setDraft({ ...draft, width: pt.x - draft.x, height: pt.y - draft.y });
      } else if (draft.type === 'circle') {
        setDraft({ ...draft, radius: dist({ x: draft.cx, y: draft.cy }, pt) });
      } else if (draft.type === 'line') {
        setDraft({ ...draft, x2: pt.x, y2: pt.y });
      }
    }
    if (arcDraft) {
      setArcCursor(pt);
    }
    if (polyDraft) {
      const shiftHeld = !!e.evt?.shiftKey;
      const skipAngle = shiftHeld || lastSnapRefRef.current !== null;
      const preview = skipAngle
        ? pt
        : applyPolyAngleSnap(polyDraft.points, pt).pt;
      setPolyDraft({ ...polyDraft, preview });
    }
  };

  const onPointerUp = () => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
      return;
    }
    if (dimDrag) {
      setDimDrag(null);
      return;
    }
    if (!draft) return;
    let s = draft;
    let valid = false;
    if (s.type === 'rect') {
      const x = s.width < 0 ? s.x + s.width : s.x;
      const y = s.height < 0 ? s.y + s.height : s.y;
      const w = Math.abs(s.width);
      const h = Math.abs(s.height);
      s = { ...s, x, y, width: w, height: h };
      valid = w > 0 && h > 0;
    } else if (s.type === 'rounded-rect') {
      const x = s.width < 0 ? s.x + s.width : s.x;
      const y = s.height < 0 ? s.y + s.height : s.y;
      const w = Math.abs(s.width);
      const h = Math.abs(s.height);
      // Default cornerRadius = 10% of the smaller side, capped, snapped to 1mm.
      const r = Math.max(1, snap(Math.min(w, h) * 0.1));
      s = { ...s, x, y, width: w, height: h, cornerRadius: Math.min(r, Math.min(w, h) / 2) };
      valid = w > 0 && h > 0;
    } else if (s.type === 'circle') {
      valid = s.radius > 0;
    } else if (s.type === 'line') {
      valid = dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) > 0;
    }
    if (valid) {
      // For lines we also wire up coincident constraints to any existing
      // feature points the start / end snapped to, so chain-detection at
      // save time can see them as connected. Run through `applyShapes` so
      // the solver gets a chance to honor the new constraints (the user
      // already snapped to the points so they're typically satisfied
      // already, but we want a consistent solve path).
      if (s.type === 'line') {
        const startRef = draftSnapRefsRef.current.lineStart;
        const endRef = lastSnapRefRef.current ?? undefined;
        const newCons = buildAutoCoincidents(s.id, startRef, endRef);
        if (newCons.length > 0) {
          const updated = [...constraintsRef.current, ...newCons];
          setConstraints(updated);
          constraintsRef.current = updated;
          applyShapes((prev) => [...prev, s as Shape]);
        } else {
          setShapes((prev) => [...prev, s]);
        }
      } else {
        setShapes((prev) => [...prev, s]);
      }
      setSelectedId(s.id);
      // Sticky tool: stay on the active drawing tool so the user can
      // draw another of the same kind. Esc or picking a different tool
      // exits back to select.
    }
    setDraft(null);
    draftSnapRefsRef.current = {};
  };

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (pendingConstraint) {
          setPendingConstraint(null);
          setPendingRefs([]);
          setPendingHint(null);
        }
        else if (polyDraft) setPolyDraft(null);
        else if (arcDraft) {
          setArcDraft(null);
          setArcCursor(null);
        }
        else if (draft) setDraft(null);
        // Sticky drawing tool with nothing in flight → exit back to
        // select. Without this the user couldn't get out of e.g. the
        // rect tool except by clicking the select button.
        else if (tool !== 'select') setTool('select');
        else if (selectedId) setSelectedId(null);
        else onCancel();
      } else if (e.key === 'Enter' && polyDraft && polyDraft.points.length >= 2) {
        commitPolyline(polyDraft.points, false);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !inField) {
        deleteSelected();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [polyDraft, arcDraft, draft, selectedId, tool, onCancel]);

  // ---- Save ----
  const handleSave = () => {
    const out: any[] = [];
    // Lines + arcs that aren't part of a recognized closed loop stay
    // construction-only. Detect closed chains first so segments that ARE part
    // of a loop get emitted as a single compound shape.
    const compounds = detectClosedCompounds(shapes, constraints);
    const consumedIds = new Set<string>();
    for (const c of compounds) {
      for (const segId of c.segmentIds) consumedIds.add(segId);
      out.push({
        id: c.id,
        type: 'compound',
        segments: c.segments,
        operation: 'add',
      });
    }
    for (const s of shapes) {
      if (consumedIds.has(s.id)) continue;
      if (s.type === 'rect' && s.width > 0 && s.height > 0) {
        out.push({
          id: s.id,
          type: 'rect',
          x: s.x + s.width / 2,
          y: s.y + s.height / 2,
          width: s.width,
          height: s.height,
          angle: s.angle ?? 0,
          operation: s.operation,
        });
      } else if (s.type === 'rounded-rect' && s.width > 0 && s.height > 0) {
        out.push({
          id: s.id,
          type: 'rounded-rect',
          x: s.x + s.width / 2,
          y: s.y + s.height / 2,
          width: s.width,
          height: s.height,
          cornerRadius: Math.max(0, Math.min(s.cornerRadius, Math.min(s.width, s.height) / 2)),
          angle: s.angle ?? 0,
          operation: s.operation,
        });
      } else if (s.type === 'circle' && s.radius > 0) {
        out.push({ id: s.id, type: 'circle', x: s.cx, y: s.cy, radius: s.radius, operation: s.operation });
      } else if (s.type === 'polyline' && s.closed && s.points.length >= 3) {
        out.push({ id: s.id, type: 'polygon', points: s.points, operation: s.operation });
      }
      // Open lines, open polylines, and arcs that aren't part of a closed
      // chain stay construction-only — not extruded.
    }
    // Constraints reference shape ids that survive the save (any shape we
    // round-trip — closed shapes — and lines / open polylines too since they
    // stay live inside the sketcher even though they're not extruded). All
    // current shape ids are live for this purpose.
    const liveShapeIds = new Set(shapes.map((s) => s.id));
    const cleaned = constraints.filter((c) =>
      refsOf(c).every((r) => liveShapeIds.has(r.shapeId))
    );
    onSave(out, cleaned);
  };

  // Helper: list of refs on a constraint, regardless of shape.
  const refsOf = (c: Constraint): EntityRef[] => {
    switch (c.type) {
      case 'horizontal':
      case 'vertical':
        // Two equally-valid shapes for these: single line/edge ref, or
        // a pair of points. Discriminate at runtime.
        return 'a' in c && 'b' in c ? [c.a, c.b] : [(c as { ref: EntityRef }).ref];
      case 'fix':
      case 'length':
      case 'radius':
      case 'coord-x':
      case 'coord-y':
        return [c.ref];
      case 'midpoint':
        return [c.point, c.line];
      case 'symmetry':
        return [c.a, c.b, c.axis];
      default:
        return [c.a, c.b];
    }
  };

  // Shape ids that have ANY constraint referencing them — used for the
  // "this shape is constrained" visual cue (a green-tinged stroke).
  const constrainedShapeIds = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const c of constraints) {
      for (const ref of refsOf(c)) out.add(ref.shapeId);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constraints]);
  // Shape ids whose translation is FULLY pinned (both x and y).
  // - `coincident` / `fix` / `midpoint` / `concentric` pin both axes of a
  //   point, so any of them on a shape fully pins translation (in 2D
  //   without rotation, pinning one point pins the whole shape's body).
  // - `coord-x` and `coord-y` each pin one axis. Both must be present on
  //   the same shape to pin translation.
  // - `distance` (line/edge or point/line) leaves translation along the
  //   parallel direction free → still draggable.
  // - `length` / `radius` only pin shape size, not translation → draggable.
  // - `parallel` / `perpendicular` / `equal-*` / `tangent` / `angle` /
  //   `horizontal` / `vertical` constrain orientation or sizes, not
  //   translation → draggable.
  const pinnedShapeIds = useMemo<Set<string>>(() => {
    const fully = new Set<string>();
    const xPinned = new Set<string>();
    const yPinned = new Set<string>();
    for (const c of constraints) {
      if (
        c.type === 'coincident' ||
        c.type === 'fix' ||
        c.type === 'midpoint' ||
        c.type === 'concentric'
      ) {
        for (const ref of refsOf(c)) fully.add(ref.shapeId);
      } else if (c.type === 'coord-x') {
        xPinned.add(c.ref.shapeId);
      } else if (c.type === 'coord-y') {
        yPinned.add(c.ref.shapeId);
      }
    }
    for (const id of xPinned) if (yPinned.has(id)) fully.add(id);
    return fully;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [constraints]);

  // ---- Render ----

  // World-space layer: origin at center of canvas (plus pan), Y up, scale = px/mm * zoom.
  const layerProps = {
    x: size.w / 2 + view.panX,
    y: size.h / 2 + view.panY,
    scaleX: screenScale,
    scaleY: -screenScale,
  };

  // World axis indicators (X red, Y green, Z blue) — drawn in screen-pixel
  // space at the sketch origin, projected onto the plane. Out-of-plane axes
  // (parallel to the plane normal) are skipped. Helps the user see which
  // world axis each in-plane direction corresponds to without guessing.
  const renderWorldAxes = () => {
    const xD = plane?.xDir;
    const n = plane?.normal;
    if (!xD || !n) return null;
    const yD: [number, number, number] = [
      n[1] * xD[2] - n[2] * xD[1],
      n[2] * xD[0] - n[0] * xD[2],
      n[0] * xD[1] - n[1] * xD[0],
    ];
    const originSx = size.w / 2 + view.panX;
    const originSy = size.h / 2 + view.panY;
    const ARROW_PX = 28;
    const HEAD_PX = 6;
    const axes: { name: string; color: string; vec: [number, number, number] }[] = [
      { name: 'X', color: '#ef4444', vec: [1, 0, 0] },
      { name: 'Y', color: '#22c55e', vec: [0, 1, 0] },
      { name: 'Z', color: '#3b82f6', vec: [0, 0, 1] },
    ];
    const out: any[] = [];
    for (const ax of axes) {
      const u = ax.vec[0] * xD[0] + ax.vec[1] * xD[1] + ax.vec[2] * xD[2];
      const v = ax.vec[0] * yD[0] + ax.vec[1] * yD[1] + ax.vec[2] * yD[2];
      const len = Math.hypot(u, v);
      if (len < 1e-3) continue; // axis is along the plane normal
      // Plane y maps to screen-up (the layer scales y by -1), so flip v.
      const dirSx = u / len;
      const dirSy = -v / len;
      const tipSx = originSx + dirSx * ARROW_PX;
      const tipSy = originSy + dirSy * ARROW_PX;
      const perpSx = -dirSy;
      const perpSy = dirSx;
      out.push(
        <KLine
          key={`wa-${ax.name}`}
          points={[originSx, originSy, tipSx, tipSy]}
          stroke={ax.color}
          strokeWidth={1.5}
          listening={false}
          opacity={0.85}
        />,
        <KLine
          key={`wa-h-${ax.name}`}
          points={[
            tipSx,
            tipSy,
            tipSx - dirSx * HEAD_PX + perpSx * HEAD_PX * 0.5,
            tipSy - dirSy * HEAD_PX + perpSy * HEAD_PX * 0.5,
            tipSx - dirSx * HEAD_PX - perpSx * HEAD_PX * 0.5,
            tipSy - dirSy * HEAD_PX - perpSy * HEAD_PX * 0.5,
          ]}
          closed
          fill={ax.color}
          listening={false}
          opacity={0.85}
        />,
        <Text
          key={`wa-l-${ax.name}`}
          x={tipSx + dirSx * 4 - 3}
          y={tipSy + dirSy * 4 - 6}
          text={ax.name}
          fontSize={11}
          fontFamily="ui-monospace, monospace"
          fontStyle="bold"
          fill={ax.color}
          listening={false}
        />
      );
    }
    return out;
  };


  const isSubtract = (s: Shape) =>
    (s.type === 'rect' ||
      s.type === 'rounded-rect' ||
      s.type === 'circle' ||
      (s.type === 'polyline' && s.closed)) &&
    (s as any).operation === 'subtract';

  const fillFor = (s: Shape, isSelected: boolean) => {
    if (isSubtract(s)) return isSelected ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.08)';
    return isSelected ? 'rgba(59,130,246,0.15)' : 'rgba(148,163,184,0.06)';
  };
  const isAxisShape = (s: Shape) =>
    s.type === 'line' && (s.id === AXIS_X_ID || s.id === AXIS_Y_ID);
  const strokeFor = (s: Shape, isSelected: boolean) => {
    if (isAxisShape(s)) return isSelected ? '#94a3b8' : '#475569';
    if (s.type === 'line' && s.frozen) return isSelected ? '#fde68a' : '#fbbf24';
    if (isSubtract(s)) return isSelected ? '#f87171' : '#ef4444';
    if (isSelected) return '#3b82f6';
    // Constrained user shape — give it a green tint so the user can tell
    // at a glance which shapes have constraints attached.
    if (constrainedShapeIds.has(s.id)) return '#34d399';
    if (s.type === 'line') return '#94a3b8';
    if (s.type === 'polyline' && !s.closed) return '#94a3b8';
    return '#cbd5e1';
  };
  const dashFor = (s: Shape) =>
    isSubtract(s) ? [3 / screenScale, 2 / screenScale] : undefined;

  const renderShape = (s: Shape) => {
    const isSelected = s.id === selectedId;
    const sw = (isSelected ? 2 : 1) / screenScale;
    const select = (e: any) => {
      if (pendingConstraint) {
        // Distance / coincident / fix all use geometry-based Stage-level
        // pickers so the user can click anywhere near a feature (line,
        // vertex, center) and have it register reliably. Letting the
        // per-shape handler eat the click would short-circuit that —
        // e.g., for coincident, a click that grazes a rect would always
        // pick something on THAT rect even if a closer vertex of another
        // shape was nearer the cursor.
        if (
          pendingConstraint === 'distance' ||
          pendingConstraint === 'coincident' ||
          pendingConstraint === 'fix' ||
          pendingConstraint === 'tangent' ||
          pendingConstraint === 'horizontal' ||
          pendingConstraint === 'vertical' ||
          pendingConstraint === 'angle'
        ) {
          return;
        }
        // Other constraint picks (horizontal, vertical) still go through
        // the per-shape route since they're trivially line-only.
        const stage = e.target.getStage();
        const cursor = stage ? pointerToWorld(stage) : null;
        const ref = pickRefForConstraint(s, cursor);
        if (ref) {
          e.cancelBubble = true;
          offerRef(ref);
        }
        return;
      }
      if (tool !== 'select') return;
      // Frozen face geometry can't be edited — don't enter the regular
      // selection state so the properties panel and drag handles stay clear.
      if (s.type === 'line' && s.frozen) return;
      e.cancelBubble = true;
      setSelectedId(s.id);
    };

    if (s.type === 'rect') {
      // Rotation is around the rect's center. Konva's `rotation` rotates
      // around (x, y); to rotate around center we move x/y to the center
      // and use offset = (w/2, h/2) so the visual top-left lands back at
      // the original (s.x, s.y) when angle=0.
      const angleDeg = ((s.angle ?? 0) * 180) / Math.PI;
      return (
        <Rect
          key={s.id}
          x={s.x + s.width / 2}
          y={s.y + s.height / 2}
          offsetX={s.width / 2}
          offsetY={s.height / 2}
          rotation={angleDeg}
          width={s.width}
          height={s.height}
          fill={fillFor(s, isSelected)}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={sw}
          dash={dashFor(s)}
          onPointerDown={select}
          onTap={select}
          draggable={tool === 'select' && !pinnedShapeIds.has(s.id)}
          onDragStart={() => setSelectedId(s.id)}
          // Konva reports position as the rect's center because of our
          // offset trick. Convert it back to the bottom-left anchor we
          // store before running the constraint solver, and likewise
          // back to a center for the value Konva needs.
          dragBoundFunc={(absPos) => {
            const target = absToWorld(absPos);
            const cornerTarget = {
              x: target.x - s.width / 2,
              y: target.y - s.height / 2,
            };
            const corner = constrainBodyDrag(s.id, cornerTarget, 'rect');
            return worldToAbs({
              x: corner.x + s.width / 2,
              y: corner.y + s.height / 2,
            });
          }}
          onDragMove={(e) => {
            updateShape(s.id, {
              x: e.target.x() - s.width / 2,
              y: e.target.y() - s.height / 2,
            });
          }}
          onDragEnd={() => setSnapHint(null)}
          onDblClick={(e: any) => {
            e.cancelBubble = true;
            const stage = e.target.getStage();
            const p = stage?.getPointerPosition();
            if (!p) return;
            const wx = (p.x - size.w / 2 - view.panX) / screenScale;
            const wy = (size.h / 2 + view.panY - p.y) / screenScale;
            openRectEdgeEditor(s, { x: wx, y: wy });
          }}
        />
      );
    }
    if (s.type === 'rounded-rect') {
      // Konva clamps cornerRadius at min(width, height) / 2.
      const cap = Math.max(0, Math.min(s.cornerRadius, Math.min(s.width, s.height) / 2));
      const angleDeg = ((s.angle ?? 0) * 180) / Math.PI;
      return (
        <Rect
          key={s.id}
          x={s.x + s.width / 2}
          y={s.y + s.height / 2}
          offsetX={s.width / 2}
          offsetY={s.height / 2}
          rotation={angleDeg}
          width={s.width}
          height={s.height}
          cornerRadius={cap}
          fill={fillFor(s, isSelected)}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={sw}
          dash={dashFor(s)}
          onPointerDown={select}
          onTap={select}
          draggable={tool === 'select' && !pinnedShapeIds.has(s.id)}
          onDragStart={() => setSelectedId(s.id)}
          dragBoundFunc={(absPos) => {
            const target = absToWorld(absPos);
            const cornerTarget = {
              x: target.x - s.width / 2,
              y: target.y - s.height / 2,
            };
            const corner = constrainBodyDrag(s.id, cornerTarget, 'rounded-rect');
            return worldToAbs({
              x: corner.x + s.width / 2,
              y: corner.y + s.height / 2,
            });
          }}
          onDragMove={(e) => {
            updateShape(s.id, {
              x: e.target.x() - s.width / 2,
              y: e.target.y() - s.height / 2,
            });
          }}
          onDragEnd={() => setSnapHint(null)}
        />
      );
    }
    if (s.type === 'circle') {
      return (
        <KCircle
          key={s.id}
          x={s.cx}
          y={s.cy}
          radius={s.radius}
          fill={fillFor(s, isSelected)}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={sw}
          dash={dashFor(s)}
          onPointerDown={select}
          onTap={select}
          draggable={tool === 'select' && !pinnedShapeIds.has(s.id)}
          onDragStart={() => setSelectedId(s.id)}
          dragBoundFunc={(absPos) => {
            const target = absToWorld(absPos);
            const constrained = constrainBodyDrag(s.id, target, 'circle');
            return worldToAbs(constrained);
          }}
          onDragMove={(e) => {
            updateShape(s.id, { cx: e.target.x(), cy: e.target.y() });
          }}
          onDragEnd={() => setSnapHint(null)}
          onDblClick={(e: any) => {
            e.cancelBubble = true;
            openRadiusEditor(s);
          }}
        />
      );
    }
    if (s.type === 'arc') {
      // Konva's <Arc> is filled-ring by default; we want only the curve.
      // `innerRadius === outerRadius` makes the fill area degenerate; use
      // a hollow look by rendering as a filled ring with `fill` left empty
      // and a thin radial difference. Konva exposes a `dashEnabled` etc.
      // but the simplest path is `clockwise` flag + zero fill.
      const sweep = arcShapeSweep(s);
      // Konva uses degrees for `angle` and `rotation`; arc is drawn from
      // rotation, sweeping CCW by `angle` (when clockwise=false).
      const sweepDeg = (Math.abs(sweep) * 180) / Math.PI;
      const startDeg = (s.startAngle * 180) / Math.PI;
      return (
        <KArc
          key={s.id}
          x={s.cx}
          y={s.cy}
          innerRadius={s.radius}
          outerRadius={s.radius}
          angle={sweepDeg}
          rotation={startDeg}
          clockwise={!s.ccw}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={sw}
          dash={dashFor(s)}
          // The body is open (innerR === outerR) so Konva's fill is empty;
          // hit detection still works on the stroke.
          hitStrokeWidth={6 / screenScale}
          onPointerDown={select}
          onTap={select}
        />
      );
    }
    if (s.type === 'line') {
      const isFrozen = !!s.frozen;
      return (
        <KLine
          key={s.id}
          points={[s.x1, s.y1, s.x2, s.y2]}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={isFrozen ? 1.5 / screenScale : sw}
          dash={isFrozen ? undefined : [2 / screenScale, 2 / screenScale]}
          opacity={isFrozen ? 0.85 : 1}
          hitStrokeWidth={6 / screenScale}
          onPointerDown={select}
          onTap={select}
          onDblClick={
            isFrozen
              ? undefined
              : (e: any) => {
                  e.cancelBubble = true;
                  openLengthEditor(s);
                }
          }
        />
      );
    }
    if (s.type === 'polyline') {
      const pts: number[] = [];
      for (const p of s.points) pts.push(p.x, p.y);
      const closedDash = isSubtract(s) ? dashFor(s) : undefined;
      return (
        <KLine
          key={s.id}
          points={pts}
          closed={s.closed}
          fill={s.closed ? fillFor(s, isSelected) : undefined}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={sw}
          dash={s.closed ? closedDash : [2 / screenScale, 2 / screenScale]}
          hitStrokeWidth={6 / screenScale}
          onPointerDown={select}
          onTap={select}
        />
      );
    }
    return null;
  };

  // Drag handles for the selected shape
  const renderHandles = () => {
    if (!selectedShape || tool !== 'select') return null;
    const s = selectedShape;
    if (s.type === 'line' && s.frozen) return null;
    const handleSize = HANDLE_PX / screenScale;
    const half = handleSize / 2;

    const Handle = (key: string, p: Pt, onDrag: (np: Pt) => void) => (
      <Rect
        key={key}
        x={p.x - half}
        y={p.y - half}
        width={handleSize}
        height={handleSize}
        fill="#fff"
        stroke="#3b82f6"
        strokeWidth={1 / screenScale}
        draggable
        onPointerDown={(e: any) => {
          e.cancelBubble = true;
        }}
        onDragMove={(e) => {
          const raw = { x: e.target.x() + half, y: e.target.y() + half };
          const sp = snapPoint(raw);
          e.target.position({ x: sp.x - half, y: sp.y - half });
          onDrag({ x: sp.x, y: sp.y });
        }}
        onDragEnd={() => setSnapHint(null)}
      />
    );

    if (s.type === 'rect') {
      // Local corner positions in the rect's pre-rotation frame; we
      // render them at world-space rotated positions, but the user's
      // drag deltas are interpreted in local space so resizing still
      // behaves like a normal axis-aligned rect.
      const center = rectCenter(s);
      const angle = s.angle ?? 0;
      const corners: { key: 'tl' | 'tr' | 'br' | 'bl'; local: Pt }[] = [
        { key: 'tl', local: { x: s.x, y: s.y } },
        { key: 'tr', local: { x: s.x + s.width, y: s.y } },
        { key: 'br', local: { x: s.x + s.width, y: s.y + s.height } },
        { key: 'bl', local: { x: s.x, y: s.y + s.height } },
      ];
      const opps = {
        tl: { x: s.x + s.width, y: s.y + s.height },
        tr: { x: s.x, y: s.y + s.height },
        br: { x: s.x, y: s.y },
        bl: { x: s.x + s.width, y: s.y },
      } as const;
      return corners.map((c) => {
        const world = rotatePoint(c.local, center, angle);
        return Handle(c.key, world, (np) => {
          // Convert world drag back to local space.
          const localNp = rotatePoint(np, center, -angle);
          const opp = opps[c.key];
          const nx = Math.min(localNp.x, opp.x);
          const ny = Math.min(localNp.y, opp.y);
          const nw = Math.abs(localNp.x - opp.x);
          const nh = Math.abs(localNp.y - opp.y);
          updateShape(s.id, { x: nx, y: ny, width: nw, height: nh });
        });
      });
    }
    if (s.type === 'rounded-rect') {
      const center = rectCenter(s);
      const angle = s.angle ?? 0;
      const corners: { key: 'tl' | 'tr' | 'br' | 'bl'; local: Pt }[] = [
        { key: 'tl', local: { x: s.x, y: s.y } },
        { key: 'tr', local: { x: s.x + s.width, y: s.y } },
        { key: 'br', local: { x: s.x + s.width, y: s.y + s.height } },
        { key: 'bl', local: { x: s.x, y: s.y + s.height } },
      ];
      const opps = {
        tl: { x: s.x + s.width, y: s.y + s.height },
        tr: { x: s.x, y: s.y + s.height },
        br: { x: s.x, y: s.y },
        bl: { x: s.x + s.width, y: s.y },
      } as const;
      const cap = Math.max(0, Math.min(s.cornerRadius, Math.min(s.width, s.height) / 2));
      const cornerHandles = corners.map((c) => {
        const world = rotatePoint(c.local, center, angle);
        return Handle(c.key, world, (np) => {
          const localNp = rotatePoint(np, center, -angle);
          const opp = opps[c.key];
          const nx = Math.min(localNp.x, opp.x);
          const ny = Math.min(localNp.y, opp.y);
          const nw = Math.abs(localNp.x - opp.x);
          const nh = Math.abs(localNp.y - opp.y);
          updateShape(s.id, { x: nx, y: ny, width: nw, height: nh });
        });
      });
      // Radius control handle: drag along the (rotated) top edge from
      // the TL corner. Distance from TL along the rotated +X controls
      // cornerRadius (clamped to half the smaller side).
      const radiusHandleLocal: Pt = { x: s.x + cap, y: s.y };
      const radiusHandlePos = rotatePoint(radiusHandleLocal, center, angle);
      const radiusHandle = Handle('rr-radius', radiusHandlePos, (np) => {
        const localNp = rotatePoint(np, center, -angle);
        const r = Math.max(0, Math.min(localNp.x - s.x, Math.min(s.width, s.height) / 2));
        updateShape(s.id, { cornerRadius: r });
      });
      return [...cornerHandles, radiusHandle];
    }
    if (s.type === 'circle') {
      const cardinals: { key: string; p: Pt }[] = [
        { key: 'r-e', p: { x: s.cx + s.radius, y: s.cy } },
        { key: 'r-w', p: { x: s.cx - s.radius, y: s.cy } },
        { key: 'r-n', p: { x: s.cx, y: s.cy + s.radius } },
        { key: 'r-s', p: { x: s.cx, y: s.cy - s.radius } },
      ];
      return cardinals.map((d) =>
        Handle(d.key, d.p, (np) => {
          const r = Math.max(SNAP_MM, snap(dist({ x: s.cx, y: s.cy }, np)));
          updateShape(s.id, { radius: r });
        })
      );
    }
    if (s.type === 'arc') {
      // Three handles: start endpoint, end endpoint, and on-curve midpoint.
      // Dragging any of them re-computes (cx, cy, radius, angles) via
      // `arcFromThreePoints`.
      const sweep = arcShapeSweep(s);
      const midA = s.startAngle + sweep / 2;
      const startPt: Pt = {
        x: s.cx + s.radius * Math.cos(s.startAngle),
        y: s.cy + s.radius * Math.sin(s.startAngle),
      };
      const endPt: Pt = {
        x: s.cx + s.radius * Math.cos(s.endAngle),
        y: s.cy + s.radius * Math.sin(s.endAngle),
      };
      const midPt: Pt = {
        x: s.cx + s.radius * Math.cos(midA),
        y: s.cy + s.radius * Math.sin(midA),
      };
      const recompute = (np1: Pt, npMid: Pt, np2: Pt) => {
        const arc = arcFromThreePoints(np1, npMid, np2);
        if (arc) updateShape(s.id, arc);
      };
      return [
        Handle('arc-start', startPt, (np) => recompute(np, midPt, endPt)),
        Handle('arc-mid', midPt, (np) => recompute(startPt, np, endPt)),
        Handle('arc-end', endPt, (np) => recompute(startPt, midPt, np)),
      ];
    }
    if (s.type === 'line') {
      return [
        Handle('p1', { x: s.x1, y: s.y1 }, (np) => updateShape(s.id, { x1: np.x, y1: np.y })),
        Handle('p2', { x: s.x2, y: s.y2 }, (np) => updateShape(s.id, { x2: np.x, y2: np.y })),
      ];
    }
    if (s.type === 'polyline') {
      return s.points.map((pt, i) =>
        Handle(`v${i}`, pt, (np) => {
          const next = s.points.map((p, j) => (j === i ? np : p));
          updateShape(s.id, { points: next });
        })
      );
    }
    return null;
  };

  // Dimension callouts (drawn in unflipped layer, screen coords)
  // While a constraint pick is in progress: highlight the already-chosen
  // entities in solid yellow, plus the would-be-picked one (under the
  // cursor) in a lighter yellow as a hover preview.
  const renderPickedEntities = () => {
    if (!pendingConstraint) return null;
    const out: any[] = [];
    const renderRef = (ref: EntityRef, key: string, locked: boolean) => {
      const ends = lineEndsOf(ref);
      if (ends) {
        out.push(
          <KLine
            key={key}
            points={[ends.p1.x, ends.p1.y, ends.p2.x, ends.p2.y]}
            stroke={locked ? '#fbbf24' : '#fde68a'}
            strokeWidth={3 / screenScale}
            listening={false}
            opacity={locked ? 0.9 : 0.6}
            dash={locked ? undefined : [4 / screenScale, 3 / screenScale]}
          />
        );
        return;
      }
      if (ref.kind === 'point') {
        const sa = shapes.find((s) => s.id === ref.shapeId);
        const p = sa ? pointAt(sa, ref) : null;
        if (!p) return;
        out.push(
          <KCircle
            key={key}
            x={p.x}
            y={p.y}
            radius={6 / screenScale}
            stroke={locked ? '#fbbf24' : '#fde68a'}
            strokeWidth={2 / screenScale}
            fill={locked ? 'rgba(251,191,36,0.4)' : 'rgba(253,230,138,0.25)'}
            listening={false}
          />
        );
      }
      if (ref.kind === 'circle') {
        // Highlight the curve itself as a thicker yellow outline.
        const sa = shapes.find((s) => s.id === ref.shapeId);
        if (!sa) return;
        if (sa.type === 'circle') {
          out.push(
            <KCircle
              key={key}
              x={sa.cx}
              y={sa.cy}
              radius={sa.radius}
              stroke={locked ? '#fbbf24' : '#fde68a'}
              strokeWidth={3 / screenScale}
              listening={false}
              opacity={locked ? 0.9 : 0.6}
              dash={locked ? undefined : [4 / screenScale, 3 / screenScale]}
            />
          );
        } else if (sa.type === 'arc') {
          const sweep = arcShapeSweep(sa);
          out.push(
            <KArc
              key={key}
              x={sa.cx}
              y={sa.cy}
              innerRadius={sa.radius}
              outerRadius={sa.radius}
              angle={(Math.abs(sweep) * 180) / Math.PI}
              rotation={(sa.startAngle * 180) / Math.PI}
              clockwise={!sa.ccw}
              stroke={locked ? '#fbbf24' : '#fde68a'}
              strokeWidth={3 / screenScale}
              listening={false}
              opacity={locked ? 0.9 : 0.6}
              dash={locked ? undefined : [4 / screenScale, 3 / screenScale]}
            />
          );
        }
      }
    };
    pendingRefs.forEach((ref, i) => renderRef(ref, `pick-${i}`, true));
    if (pendingHover) renderRef(pendingHover, 'pick-hover', false);
    return out;
  };

  // Point-to-point dimension: dim line drawn directly between the two
  // points, arrowheads at both ends, value label centered (lifted off the
  // dim line in screen-perp so it stays readable). No extension lines.
  const renderPointPointDim = (
    c: Constraint & { type: 'distance' },
    pA: Pt,
    pB: Pt
  ): any[] => {
    const out: any[] = [];
    const sA = projectToScreen(pA);
    const sB = projectToScreen(pB);
    const dx = sB.sx - sA.sx;
    const dy = sB.sy - sA.sy;
    const dLen = Math.hypot(dx, dy) || 1;
    const ux = dx / dLen;
    const uy = dy / dLen;
    const arrow = 7;
    const arrowSpread = 3;
    const stroke = '#7dd3fc';
    const widthSel = 1.2;
    const labelT = c.annotation?.labelT ?? 0.5;

    out.push(
      <KLine
        key={`${c.id}-dim`}
        points={[sA.sx, sA.sy, sB.sx, sB.sy]}
        stroke={stroke}
        strokeWidth={widthSel}
        listening={false}
      />,
      <KLine
        key={`${c.id}-arrA`}
        points={[
          sA.sx + ux * arrow + uy * arrowSpread,
          sA.sy + uy * arrow - ux * arrowSpread,
          sA.sx,
          sA.sy,
          sA.sx + ux * arrow - uy * arrowSpread,
          sA.sy + uy * arrow + ux * arrowSpread,
        ]}
        stroke={stroke}
        strokeWidth={widthSel}
        listening={false}
      />,
      <KLine
        key={`${c.id}-arrB`}
        points={[
          sB.sx - ux * arrow + uy * arrowSpread,
          sB.sy - uy * arrow - ux * arrowSpread,
          sB.sx,
          sB.sy,
          sB.sx - ux * arrow - uy * arrowSpread,
          sB.sy - uy * arrow + ux * arrowSpread,
        ]}
        stroke={stroke}
        strokeWidth={widthSel}
        listening={false}
      />
    );

    const TEXT_W = 60;
    const TEXT_H = 14;
    let perpSX = -uy;
    let perpSY = ux;
    if (perpSY > 0 || (Math.abs(perpSY) < 1e-9 && perpSX < 0)) {
      perpSX = -perpSX;
      perpSY = -perpSY;
    }
    const LIFT_PX = 4 + TEXT_H / 2;
    const labelCx = sA.sx + dx * labelT + perpSX * LIFT_PX;
    const labelCy = sA.sy + dy * labelT + perpSY * LIFT_PX;
    out.push(
      <Text
        key={`${c.id}-label`}
        x={labelCx - TEXT_W / 2}
        y={labelCy - TEXT_H / 2}
        width={TEXT_W}
        height={TEXT_H}
        align="center"
        verticalAlign="middle"
        text={`${c.value.toFixed(1)} mm`}
        fontSize={11}
        fontFamily="ui-monospace, monospace"
        fill={stroke}
        onDblClick={(e: any) => {
          e.cancelBubble = true;
          setInlineEditor({
            target: 'constraint',
            constraintId: c.id,
            kind: 'distance-value',
            sx: labelCx,
            sy: labelCy,
            value: c.value.toFixed(2),
          });
        }}
      />
    );
    return out;
  };

  // Point-to-line dimension: dim line is the perpendicular from the point
  // onto the line (the geometric quantity the constraint enforces). Renders
  // the dim line as P → foot, with arrowheads at both ends and the value
  // centered along it. A short tick at the foot marks the perpendicular.
  const renderPointLineDim = (
    c: Constraint & { type: 'distance' },
    pPt: Pt,
    line: { p1: Pt; p2: Pt }
  ): any[] => {
    const out: any[] = [];
    const lx = line.p2.x - line.p1.x;
    const ly = line.p2.y - line.p1.y;
    const lLen = Math.hypot(lx, ly) || 1;
    const ux = lx / lLen;
    const uy = ly / lLen;
    // Foot of perpendicular from pPt onto the infinite line through p1, p2.
    const t = (pPt.x - line.p1.x) * ux + (pPt.y - line.p1.y) * uy;
    const foot = { x: line.p1.x + t * ux, y: line.p1.y + t * uy };

    const sFoot = projectToScreen(foot);
    const sPt = projectToScreen(pPt);

    const dx = sPt.sx - sFoot.sx;
    const dy = sPt.sy - sFoot.sy;
    const dLen = Math.hypot(dx, dy) || 1;
    const dux = dx / dLen;
    const duy = dy / dLen;
    const arrow = 7;
    const arrowSpread = 3;
    const stroke = '#7dd3fc';
    const widthSel = 1.2;
    const labelT = c.annotation?.labelT ?? 0.5;

    out.push(
      // Tick mark on the line at the foot of the perpendicular (~6 px each side).
      <KLine
        key={`${c.id}-tick`}
        points={[
          sFoot.sx - 6 * (lx / lLen),
          sFoot.sy + 6 * (ly / lLen),
          sFoot.sx + 6 * (lx / lLen),
          sFoot.sy - 6 * (ly / lLen),
        ]}
        stroke={stroke}
        strokeWidth={widthSel}
        opacity={0.85}
        listening={false}
      />,
      // Dim line — from foot to point, draggable label.
      <KLine
        key={`${c.id}-dim`}
        points={[sFoot.sx, sFoot.sy, sPt.sx, sPt.sy]}
        stroke={stroke}
        strokeWidth={widthSel}
        hitStrokeWidth={8}
        listening={false}
      />,
      // Arrowhead at foot.
      <KLine
        key={`${c.id}-arrA`}
        points={[
          sFoot.sx + dux * arrow + duy * arrowSpread,
          sFoot.sy + duy * arrow - dux * arrowSpread,
          sFoot.sx,
          sFoot.sy,
          sFoot.sx + dux * arrow - duy * arrowSpread,
          sFoot.sy + duy * arrow + dux * arrowSpread,
        ]}
        stroke={stroke}
        strokeWidth={widthSel}
        listening={false}
      />,
      // Arrowhead at point.
      <KLine
        key={`${c.id}-arrB`}
        points={[
          sPt.sx - dux * arrow + duy * arrowSpread,
          sPt.sy - duy * arrow - dux * arrowSpread,
          sPt.sx,
          sPt.sy,
          sPt.sx - dux * arrow - duy * arrowSpread,
          sPt.sy - duy * arrow + dux * arrowSpread,
        ]}
        stroke={stroke}
        strokeWidth={widthSel}
        listening={false}
      />
    );

    // Value label, centered along dim line, lifted toward screen up.
    const TEXT_W = 60;
    const TEXT_H = 14;
    let perpSX = -duy;
    let perpSY = dux;
    if (perpSY > 0 || (Math.abs(perpSY) < 1e-9 && perpSX < 0)) {
      perpSX = -perpSX;
      perpSY = -perpSY;
    }
    const LIFT_PX = 4 + TEXT_H / 2;
    const labelCx = sFoot.sx + dx * labelT + perpSX * LIFT_PX;
    const labelCy = sFoot.sy + dy * labelT + perpSY * LIFT_PX;
    out.push(
      <Text
        key={`${c.id}-label`}
        x={labelCx - TEXT_W / 2}
        y={labelCy - TEXT_H / 2}
        width={TEXT_W}
        height={TEXT_H}
        align="center"
        verticalAlign="middle"
        text={`${c.value.toFixed(1)} mm`}
        fontSize={11}
        fontFamily="ui-monospace, monospace"
        fill={stroke}
        onDblClick={(e: any) => {
          e.cancelBubble = true;
          setInlineEditor({
            target: 'constraint',
            constraintId: c.id,
            kind: 'distance-value',
            sx: labelCx,
            sy: labelCy,
            value: c.value.toFixed(2),
          });
        }}
      />
    );
    return out;
  };

  // Render dimension graphics for every distance constraint. Drawn in screen
  // px in the unflipped annotation layer so arrows / text stay sized
  // consistently regardless of zoom. Geometry is computed in plane-local mm
  // then projected through `projectToScreen`.
  // Build a CAD-style perpendicular dimension between two parallel lines:
  //   - dim line is **perpendicular** to the features, spanning from line A
  //     to line B (so its length equals the constraint value)
  //   - extension lines are **parallel** to the features, going from each
  //     line's midpoint outward to the dim line's perpendicular projection
  //   - arrows live at the dim line endpoints, pointing along the dim line
  //   - value label sits along the dim line at `annotation.labelT` (0..1)
  //
  // `annotation.offset` slides the dim line along the feature direction
  // (so the user can place it above / below / outside the feature run).
  const renderDimensions = () => {
    const out: any[] = [];
    for (const c of constraints) {
      if (c.type !== 'distance') continue;
      // Point + point distance: dim line drawn directly between the two
      // points with arrowheads at each end. No extension lines.
      if (c.a.kind === 'point' && c.b.kind === 'point') {
        const sa = shapes.find((s) => s.id === c.a.shapeId);
        const sb = shapes.find((s) => s.id === c.b.shapeId);
        const pa = sa ? pointAt(sa, c.a) : null;
        const pb = sb ? pointAt(sb, c.b) : null;
        if (!pa || !pb) continue;
        out.push(...renderPointPointDim(c, pa, pb));
        continue;
      }
      // Point + line distance: dim line is perpendicular from the point onto
      // the line. Drawn from the foot of the perpendicular to the point with
      // arrowheads at each end and the value centered along it.
      if (c.a.kind === 'point') {
        const sa = shapes.find((s) => s.id === c.a.shapeId);
        const pPt = sa ? pointAt(sa, c.a) : null;
        const line = lineEndsOf(c.b);
        if (!pPt || !line) continue;
        out.push(...renderPointLineDim(c, pPt, line));
        continue;
      }
      const lineA = lineEndsOf(c.a);
      const lineB = lineEndsOf(c.b);
      if (!lineA || !lineB) continue;
      // Direction along the features. Both lines parallel by precondition,
      // so either's direction works.
      const featDir = lineDirection(c.a) ?? lineDirection(c.b);
      if (!featDir) continue;
      const dimDir = { x: -featDir.y, y: featDir.x }; // perpendicular = dim line direction

      // Project a point onto (t along featDir, p along dimDir).
      const projT = (p: Pt) => p.x * featDir.x + p.y * featDir.y;
      const projP = (p: Pt) => p.x * dimDir.x + p.y * dimDir.y;
      const fromTP = (t: number, p: number): Pt => ({
        x: t * featDir.x + p * dimDir.x,
        y: t * featDir.y + p * dimDir.y,
      });

      const aT1 = projT(lineA.p1);
      const aT2 = projT(lineA.p2);
      const bT1 = projT(lineB.p1);
      const bT2 = projT(lineB.p2);
      const aMidT = (aT1 + aT2) / 2;
      const bMidT = (bT1 + bT2) / 2;
      // Center of overlap along feature axis. Default offset slides from here.
      const centerT = (aMidT + bMidT) / 2;
      const aPerp = projP(lineA.p1); // constant for parallel lines
      const bPerp = projP(lineB.p1);

      const offset = c.annotation?.offset ?? 5;
      const labelT = c.annotation?.labelT ?? 0.5;
      const labelP = c.annotation?.labelP ?? 0;
      const tDim = centerT + offset;

      // Dim line endpoints (mm) — perpendicular to features.
      const dimA = fromTP(tDim, aPerp);
      const dimB = fromTP(tDim, bPerp);
      // Direction along the dim line in the order labelT increases (A → B).
      const dimVec = { x: dimB.x - dimA.x, y: dimB.y - dimA.y };
      const dimLenMm = Math.hypot(dimVec.x, dimVec.y);
      const dimLenSafe = dimLenMm || 1e-6;
      const alongDir = { x: dimVec.x / dimLenSafe, y: dimVec.y / dimLenSafe };
      // Stable perpendicular to the dim line. Dim line is perpendicular to
      // features, so the perpendicular direction is ±featDir. Pick the sign
      // so it points toward screen "up" (positive plane-y → screen-y up after
      // the y-flip). This makes labelP drag direction order-independent.
      let perpDir = { ...featDir };
      if (perpDir.y < 0 || (Math.abs(perpDir.y) < 1e-9 && perpDir.x < 0)) {
        perpDir = { x: -perpDir.x, y: -perpDir.y };
      }
      // Label anchor: along the dim line by labelT, then perpendicular by labelP.
      const labelMm = {
        x: dimA.x + alongDir.x * dimLenSafe * labelT + perpDir.x * labelP,
        y: dimA.y + alongDir.y * dimLenSafe * labelT + perpDir.y * labelP,
      };

      // Extension lines per ANSI / McGill: a 1 mm gap between feature and the
      // start of the extension, and ~2 mm overshoot past the dim line. Skipped
      // when the dim line is closer than the gap to the feature midpoint
      // (degenerate — dim line passing through the feature).
      const EXT_GAP_MM = 1;
      const EXT_OVERSHOOT_MM = 2;
      const aSign = Math.sign(tDim - aMidT);
      const bSign = Math.sign(tDim - bMidT);
      const aExt =
        aSign !== 0 && Math.abs(tDim - aMidT) > EXT_GAP_MM
          ? {
              close: fromTP(aMidT + aSign * EXT_GAP_MM, aPerp),
              far: fromTP(tDim + aSign * EXT_OVERSHOOT_MM, aPerp),
            }
          : null;
      const bExt =
        bSign !== 0 && Math.abs(tDim - bMidT) > EXT_GAP_MM
          ? {
              close: fromTP(bMidT + bSign * EXT_GAP_MM, bPerp),
              far: fromTP(tDim + bSign * EXT_OVERSHOOT_MM, bPerp),
            }
          : null;

      const sA = projectToScreen(dimA);
      const sB = projectToScreen(dimB);
      const sLabel = projectToScreen(labelMm);
      const sAExtClose = aExt ? projectToScreen(aExt.close) : null;
      const sAExtFar = aExt ? projectToScreen(aExt.far) : null;
      const sBExtClose = bExt ? projectToScreen(bExt.close) : null;
      const sBExtFar = bExt ? projectToScreen(bExt.far) : null;

      // Arrow direction in screen px.
      const adx = sB.sx - sA.sx;
      const ady = sB.sy - sA.sy;
      const aLen = Math.hypot(adx, ady) || 1;
      const ux = adx / aLen;
      const uy = ady / aLen;
      const arrow = 7;
      const arrowSpread = 3;
      const stroke = '#7dd3fc';
      const widthSel = 1.2;

      // Screen-px direction perpendicular to the dim line, oriented toward
      // screen "up". Used to lift the value text above the dim line so it
      // never sits on top of it, regardless of dim line orientation.
      let perpSX = -ady / aLen;
      let perpSY = adx / aLen;
      if (perpSY > 0 || (Math.abs(perpSY) < 1e-9 && perpSX < 0)) {
        perpSX = -perpSX;
        perpSY = -perpSY;
      }
      const TEXT_W = 60;
      const TEXT_H = 14;
      // Text centerline ~4 px above the dim line.
      const LIFT_PX = 4 + TEXT_H / 2;
      const labelText = `${c.value.toFixed(1)} mm`;
      const labelCx = sLabel.sx + perpSX * LIFT_PX;
      const labelCy = sLabel.sy + perpSY * LIFT_PX;

      out.push(
        // Extension lines — solid per ANSI, with 1 mm gap and 2 mm overshoot.
        ...(sAExtClose && sAExtFar
          ? [
              <KLine
                key={`${c.id}-extA`}
                points={[sAExtClose.sx, sAExtClose.sy, sAExtFar.sx, sAExtFar.sy]}
                stroke={stroke}
                strokeWidth={widthSel}
                opacity={0.85}
                listening={false}
              />,
            ]
          : []),
        ...(sBExtClose && sBExtFar
          ? [
              <KLine
                key={`${c.id}-extB`}
                points={[sBExtClose.sx, sBExtClose.sy, sBExtFar.sx, sBExtFar.sy]}
                stroke={stroke}
                strokeWidth={widthSel}
                opacity={0.85}
                listening={false}
              />,
            ]
          : []),
        // Dim line — draggable along feature direction to slide offset.
        <KLine
          key={`${c.id}-dim`}
          points={[sA.sx, sA.sy, sB.sx, sB.sy]}
          stroke={stroke}
          strokeWidth={widthSel}
          hitStrokeWidth={8}
          onPointerDown={(e: any) => {
            e.cancelBubble = true;
            const stage = e.target.getStage();
            const p = stage.getPointerPosition();
            if (!p) return;
            setDimDrag({
              constraintId: c.id,
              kind: 'offset',
              baseValue: offset,
              baseScreenX: p.x,
              baseScreenY: p.y,
              offsetDir: featDir,
            });
          }}
        />,
        // Arrowhead at A — points inward toward B.
        <KLine
          key={`${c.id}-arrA`}
          points={[
            sA.sx + ux * arrow + uy * arrowSpread,
            sA.sy + uy * arrow - ux * arrowSpread,
            sA.sx,
            sA.sy,
            sA.sx + ux * arrow - uy * arrowSpread,
            sA.sy + uy * arrow + ux * arrowSpread,
          ]}
          stroke={stroke}
          strokeWidth={widthSel}
          listening={false}
        />,
        // Arrowhead at B — points inward toward A.
        <KLine
          key={`${c.id}-arrB`}
          points={[
            sB.sx - ux * arrow + uy * arrowSpread,
            sB.sy - uy * arrow - ux * arrowSpread,
            sB.sx,
            sB.sy,
            sB.sx - ux * arrow - uy * arrowSpread,
            sB.sy - uy * arrow + ux * arrowSpread,
          ]}
          stroke={stroke}
          strokeWidth={widthSel}
          listening={false}
        />,
        // Value label — centered horizontally on the anchor, lifted above the
        // dim line in screen px so it never overlaps. Drag to reposition,
        // dbl-click to edit. Unidirectional (always horizontal).
        <Text
          key={`${c.id}-label`}
          x={labelCx - TEXT_W / 2}
          y={labelCy - TEXT_H / 2}
          width={TEXT_W}
          height={TEXT_H}
          align="center"
          verticalAlign="middle"
          text={labelText}
          fontSize={11}
          fontFamily="ui-monospace, monospace"
          fill={stroke}
          onPointerDown={(e: any) => {
            e.cancelBubble = true;
            const stage = e.target.getStage();
            const p = stage.getPointerPosition();
            if (!p) return;
            setDimDrag({
              constraintId: c.id,
              kind: 'label',
              baseT: labelT,
              baseP: labelP,
              baseScreenX: p.x,
              baseScreenY: p.y,
              alongDir,
              perpDir,
              alongLenMm: dimLenMm,
            });
          }}
          onDblClick={(e: any) => {
            e.cancelBubble = true;
            setInlineEditor({
              target: 'constraint',
              constraintId: c.id,
              kind: 'distance-value',
              sx: labelCx,
              sy: labelCy,
              value: c.value.toFixed(2),
            });
          }}
          onTap={(e: any) => {
            e.cancelBubble = true;
          }}
        />
      );
    }
    return out;
  };

  const renderCallouts = () => {
    if (!selectedShape) return null;
    const s = selectedShape;
    const project = (p: Pt) => ({
      sx: size.w / 2 + view.panX + p.x * screenScale,
      sy: size.h / 2 + view.panY - p.y * screenScale,
    });
    const labels: { sx: number; sy: number; text: string }[] = [];

    if (s.type === 'rect') {
      const top = project({ x: s.x + s.width / 2, y: s.y + s.height });
      const right = project({ x: s.x + s.width, y: s.y + s.height / 2 });
      labels.push({ sx: top.sx - 30, sy: top.sy - 18, text: `W ${s.width.toFixed(1)} mm` });
      labels.push({ sx: right.sx + 8, sy: right.sy - 6, text: `H ${s.height.toFixed(1)} mm` });
    } else if (s.type === 'rounded-rect') {
      const top = project({ x: s.x + s.width / 2, y: s.y + s.height });
      const right = project({ x: s.x + s.width, y: s.y + s.height / 2 });
      labels.push({ sx: top.sx - 30, sy: top.sy - 18, text: `W ${s.width.toFixed(1)} mm` });
      labels.push({ sx: right.sx + 8, sy: right.sy - 6, text: `H ${s.height.toFixed(1)} mm` });
      const cornerLabel = project({ x: s.x + s.cornerRadius, y: s.y });
      labels.push({
        sx: cornerLabel.sx + 4,
        sy: cornerLabel.sy + 6,
        text: `R ${s.cornerRadius.toFixed(1)} mm`,
      });
    } else if (s.type === 'arc') {
      const right = project({ x: s.cx + s.radius, y: s.cy });
      labels.push({ sx: right.sx + 8, sy: right.sy - 6, text: `R ${s.radius.toFixed(1)} mm` });
    } else if (s.type === 'circle') {
      const right = project({ x: s.cx + s.radius, y: s.cy });
      labels.push({ sx: right.sx + 8, sy: right.sy - 6, text: `R ${s.radius.toFixed(1)} mm` });
    } else if (s.type === 'line') {
      const mid = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
      const m = project(mid);
      const len = dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
      labels.push({ sx: m.sx + 8, sy: m.sy - 6, text: `${len.toFixed(1)} mm` });
    } else if (s.type === 'polyline') {
      const lastIdx = s.closed ? s.points.length : s.points.length - 1;
      for (let i = 0; i < lastIdx; i++) {
        const a = s.points[i];
        const b = s.points[(i + 1) % s.points.length];
        const m = project({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        labels.push({ sx: m.sx + 4, sy: m.sy - 6, text: `${dist(a, b).toFixed(1)}` });
      }
    }
    return labels.map((l, i) => (
      <Text
        key={i}
        x={l.sx}
        y={l.sy}
        text={l.text}
        fontSize={11}
        fontFamily="ui-monospace, monospace"
        fill="#3b82f6"
      />
    ));
  };

  // Live dimensions while drawing — placed in the annotation (unflipped) layer.
  const renderDraftCallout = () => {
    if (!draft) return null;
    if (draft.type === 'rect' || draft.type === 'rounded-rect') {
      const cx = draft.x + draft.width / 2;
      const cy = draft.y + draft.height / 2;
      const m = projectToScreen({ x: cx, y: cy });
      return (
        <Text
          key="draft-rect"
          x={m.sx + 10}
          y={m.sy - 6}
          text={`${Math.abs(draft.width).toFixed(1)} × ${Math.abs(draft.height).toFixed(1)} mm`}
          fontSize={11}
          fontFamily="ui-monospace, monospace"
          fill="#fbbf24"
          listening={false}
        />
      );
    }
    if (draft.type === 'circle') {
      const m = projectToScreen({ x: draft.cx + draft.radius, y: draft.cy });
      return (
        <Text
          key="draft-circle"
          x={m.sx + 8}
          y={m.sy - 6}
          text={`R ${draft.radius.toFixed(1)} mm`}
          fontSize={11}
          fontFamily="ui-monospace, monospace"
          fill="#fbbf24"
          listening={false}
        />
      );
    }
    if (draft.type === 'line') {
      const mid = { x: (draft.x1 + draft.x2) / 2, y: (draft.y1 + draft.y2) / 2 };
      const m = projectToScreen(mid);
      const len = dist({ x: draft.x1, y: draft.y1 }, { x: draft.x2, y: draft.y2 });
      return (
        <Text
          key="draft-line"
          x={m.sx + 8}
          y={m.sy - 6}
          text={`${len.toFixed(1)} mm`}
          fontSize={11}
          fontFamily="ui-monospace, monospace"
          fill="#fbbf24"
          listening={false}
        />
      );
    }
    return null;
  };

  const renderPolyDraftCallout = () => {
    if (!polyDraft || polyDraft.points.length === 0) return null;
    const pts = polyDraft.points;
    const last = pts[pts.length - 1];
    const mid = { x: (last.x + polyDraft.preview.x) / 2, y: (last.y + polyDraft.preview.y) / 2 };
    const m = projectToScreen(mid);
    const len = dist(last, polyDraft.preview);
    // Angle of the *new* segment relative to the previous one — only
    // meaningful when there's a previous segment to compare against.
    let angleStr = '';
    if (pts.length >= 2) {
      const prev2 = pts[pts.length - 2];
      const prevAngle = Math.atan2(last.y - prev2.y, last.x - prev2.x);
      const dx = polyDraft.preview.x - last.x;
      const dy = polyDraft.preview.y - last.y;
      if (Math.hypot(dx, dy) > 1e-6) {
        const curAngle = Math.atan2(dy, dx);
        let rel = curAngle - prevAngle;
        while (rel > Math.PI) rel -= 2 * Math.PI;
        while (rel <= -Math.PI) rel += 2 * Math.PI;
        const deg = (rel * 180) / Math.PI;
        angleStr = `  ·  ${deg.toFixed(deg === Math.round(deg) ? 0 : 1)}°`;
      }
    }
    return (
      <Text
        key="draft-poly"
        x={m.sx + 8}
        y={m.sy - 6}
        text={`${len.toFixed(1)} mm${angleStr}`}
        fontSize={11}
        fontFamily="ui-monospace, monospace"
        fill="#fbbf24"
        listening={false}
      />
    );
  };

  const renderDraft = () => {
    if (!draft) return null;
    const sw = 1 / screenScale;
    const dash = [4 / screenScale, 3 / screenScale];
    if (draft.type === 'rect') {
      const x = draft.width < 0 ? draft.x + draft.width : draft.x;
      const y = draft.height < 0 ? draft.y + draft.height : draft.y;
      return (
        <Rect
          x={x}
          y={y}
          width={Math.abs(draft.width)}
          height={Math.abs(draft.height)}
          stroke="#3b82f6"
          strokeWidth={sw}
          dash={dash}
        />
      );
    }
    if (draft.type === 'rounded-rect') {
      const x = draft.width < 0 ? draft.x + draft.width : draft.x;
      const y = draft.height < 0 ? draft.y + draft.height : draft.y;
      const w = Math.abs(draft.width);
      const h = Math.abs(draft.height);
      const cr = Math.min(Math.max(1, Math.min(w, h) * 0.1), Math.min(w, h) / 2);
      return (
        <Rect
          x={x}
          y={y}
          width={w}
          height={h}
          cornerRadius={cr}
          stroke="#3b82f6"
          strokeWidth={sw}
          dash={dash}
        />
      );
    }
    if (draft.type === 'circle') {
      return <KCircle x={draft.cx} y={draft.cy} radius={draft.radius} stroke="#3b82f6" strokeWidth={sw} dash={dash} />;
    }
    if (draft.type === 'line') {
      return (
        <KLine points={[draft.x1, draft.y1, draft.x2, draft.y2]} stroke="#3b82f6" strokeWidth={sw} dash={dash} />
      );
    }
    return null;
  };

  // Live preview for the 3-click arc tool — uses the cursor as the missing
  // point so the user sees the candidate arc before placing it.
  const renderArcDraft = () => {
    if (!arcDraft) return null;
    const sw = 1 / screenScale;
    const dash = [4 / screenScale, 3 / screenScale];
    const cursor = arcCursor;
    const dotR = 3 / screenScale;
    const out: any[] = [
      <KCircle
        key="arc-start"
        x={arcDraft.start.x}
        y={arcDraft.start.y}
        radius={dotR}
        fill="#3b82f6"
      />,
    ];
    if (arcDraft.end) {
      out.push(
        <KCircle
          key="arc-end"
          x={arcDraft.end.x}
          y={arcDraft.end.y}
          radius={dotR}
          fill="#3b82f6"
        />
      );
      // Click-3 preview: cursor is the on-curve point.
      if (cursor) {
        const arc = arcFromThreePoints(arcDraft.start, cursor, arcDraft.end);
        if (arc) {
          const sweep = arcShapeSweep(arc);
          out.push(
            <KArc
              key="arc-preview"
              x={arc.cx}
              y={arc.cy}
              innerRadius={arc.radius}
              outerRadius={arc.radius}
              angle={(Math.abs(sweep) * 180) / Math.PI}
              rotation={(arc.startAngle * 180) / Math.PI}
              clockwise={!arc.ccw}
              stroke="#3b82f6"
              strokeWidth={sw}
              dash={dash}
            />
          );
        } else {
          // Colinear → fall back to a chord preview.
          out.push(
            <KLine
              key="arc-chord"
              points={[arcDraft.start.x, arcDraft.start.y, arcDraft.end.x, arcDraft.end.y]}
              stroke="#3b82f6"
              strokeWidth={sw}
              dash={dash}
            />
          );
        }
      }
    } else if (cursor) {
      // Click-2 preview: just a dashed chord from start to cursor.
      out.push(
        <KLine
          key="arc-chord"
          points={[arcDraft.start.x, arcDraft.start.y, cursor.x, cursor.y]}
          stroke="#3b82f6"
          strokeWidth={sw}
          dash={dash}
        />
      );
    }
    return out;
  };

  const renderSnapHint = () => {
    if (!snapHint) return null;
    const r = SNAP_RADIUS_PX / 2 / screenScale;
    const labelMap: Record<SnapKind, string> = {
      origin: 'origin',
      'x-axis': 'x-axis',
      'y-axis': 'y-axis',
      'rect-corner': 'corner',
      'rect-edge-mid': 'midpoint',
      'rect-center': 'center',
      'circle-center': 'center',
      'circle-cardinal': 'quadrant',
      'line-end': 'endpoint',
      'line-mid': 'midpoint',
      'poly-vertex': 'vertex',
      'poly-edge-mid': 'midpoint',
      'face-vertex': 'face vertex',
      'face-edge-mid': 'face midpoint',
    };
    // Axis snaps highlight the WHOLE axis line, not a single point — they
    // represent a line entity, and showing a circle at a point would imply
    // the user is selecting one specific point.
    if (snapHint.kind === 'x-axis' || snapHint.kind === 'y-axis') {
      const isX = snapHint.kind === 'x-axis';
      const points = isX
        ? [-AXIS_HALF_LENGTH_MM, 0, AXIS_HALF_LENGTH_MM, 0]
        : [0, -AXIS_HALF_LENGTH_MM, 0, AXIS_HALF_LENGTH_MM];
      return [
        <KLine
          key="snap-axis"
          points={points}
          stroke="#fbbf24"
          strokeWidth={2 / screenScale}
          opacity={0.9}
          listening={false}
        />,
      ];
    }
    return [
      <KCircle
        key="snap-marker"
        x={snapHint.pt.x}
        y={snapHint.pt.y}
        radius={r}
        stroke="#fbbf24"
        strokeWidth={1.5 / screenScale}
        listening={false}
      />,
      <KCircle
        key="snap-dot"
        x={snapHint.pt.x}
        y={snapHint.pt.y}
        radius={1.5 / screenScale}
        fill="#fbbf24"
        listening={false}
      />,
      <Text
        key="snap-label"
        x={snapHint.pt.x + r + 1 / screenScale}
        y={snapHint.pt.y - r - 1 / screenScale}
        text={labelMap[snapHint.kind]}
        fontSize={10 / screenScale}
        fill="#fbbf24"
        scaleY={-1}
        listening={false}
      />,
    ];
  };

  const renderPolyDraft = () => {
    if (!polyDraft) return null;
    const pts: number[] = [];
    for (const p of polyDraft.points) pts.push(p.x, p.y);
    pts.push(polyDraft.preview.x, polyDraft.preview.y);
    const dotR = 3 / screenScale;
    const out: any[] = [
      <KLine
        key="poly-line"
        points={pts}
        stroke="#3b82f6"
        strokeWidth={1 / screenScale}
        dash={[4 / screenScale, 3 / screenScale]}
      />,
    ];
    polyDraft.points.forEach((p, i) => {
      out.push(<KCircle key={`pt-${i}`} x={p.x} y={p.y} radius={dotR} fill="#3b82f6" />);
    });
    return out;
  };

  const ToolBtn = ({ name, icon, label }: { name: Tool; icon: any; label: string }) => (
    <button
      onClick={() => switchTool(name)}
      className={`px-3 py-1.5 rounded-md flex items-center gap-2 text-xs font-semibold transition-colors ${
        tool === name ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-600'
      }`}
      title={label}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  const ConstraintBtn = ({
    type,
    icon,
    label,
  }: {
    type: ConstraintType;
    icon: any;
    label: string;
  }) => (
    <button
      onClick={() => beginConstraint(type)}
      className={`p-1.5 rounded-md flex items-center transition-colors ${
        pendingConstraint === type
          ? 'bg-amber-600 text-white shadow'
          : 'text-slate-300 hover:bg-slate-600'
      }`}
      title={`${label} constraint`}
    >
      {icon}
    </button>
  );

  const hint = (() => {
    if (pendingHint) return pendingHint;
    if (pendingConstraint) {
      const need = arity(pendingConstraint) - pendingRefs.length;
      if (pendingConstraint === 'horizontal' || pendingConstraint === 'vertical') {
        // Dual-mode picker: line/edge OR point pair.
        if (pendingRefs.length === 0) {
          return `${pendingConstraint}: pick a line/edge to orient, OR a point to start a pair. Esc exits.`;
        }
        if (pendingRefs.length === 1 && pendingRefs[0].kind === 'point') {
          return `${pendingConstraint}: pick the second point — first one moves to align. Esc exits.`;
        }
      }
      if (pendingConstraint === 'angle') {
        if (pendingRefs.length === 0) {
          return 'angle: pick the line that should rotate to satisfy the angle. Esc exits.';
        }
        if (pendingRefs.length === 1) {
          return 'angle: pick the reference line. Esc exits.';
        }
      }
      if (pendingConstraint === 'tangent') {
        // Tangent's two picks have different shapes (line + circle) — be
        // specific about which is still missing.
        const havePicked = (kind: 'line' | 'circle') =>
          pendingRefs.some((r) =>
            kind === 'circle' ? r.kind === 'circle' : r.kind === 'line' || r.kind === 'edge'
          );
        const needs = [
          havePicked('line') ? null : 'a line / rect edge',
          havePicked('circle') ? null : 'a circle / arc',
        ]
          .filter(Boolean)
          .join(' and ');
        return `tangent: pick ${needs}. Esc cancels.`;
      }
      const noun =
        pendingConstraint === 'horizontal' ||
        pendingConstraint === 'vertical' ||
        pendingConstraint === 'length' ||
        pendingConstraint === 'distance'
          ? 'line or rect edge'
          : pendingConstraint === 'radius'
            ? 'circle'
            : 'point';
      return `${pendingConstraint}: pick ${need} more ${noun}${need !== 1 ? 's' : ''}. Esc cancels.`;
    }
    if (tool === 'rect') return 'Drag to draw a rectangle.';
    if (tool === 'rounded-rect') return 'Drag to draw a rounded rectangle.';
    if (tool === 'circle') return 'Drag from the center outward.';
    if (tool === 'arc')
      return 'Click start, end, then a third point on the curve (3 clicks).';
    if (tool === 'line') return 'Drag from start to end.';
    if (tool === 'polyline')
      return 'Click to add points · Enter finishes open · Click first point to close · 5° angle snap (Shift to disable).';
    return selectedShape
      ? 'Drag handles to reshape · Drag body to move · Del to remove.'
      : 'Click a shape to select.';
  })();

  return (
    <div className="fixed inset-0 z-50 bg-slate-800 flex flex-col overflow-hidden">
      {/* Full-screen sketcher — the modal frame is gone so the toolbar
          has the entire viewport width to lay out tools and constraint
          buttons without wrapping. */}
        {/* Header / Toolbar */}
        <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-lg font-bold pr-3 border-r border-slate-700 whitespace-nowrap">2D Sketcher</h2>
            {plane && (
              <div className="relative group">
                {/* Info button replaces the inline plane readout. The
                    full text appears in a popover on hover / tap so it
                    only takes ~24px in the header. */}
                <button
                  type="button"
                  className="p-1.5 text-slate-400 hover:text-blue-300 hover:bg-slate-700/50 rounded transition-colors"
                  title="Sketch plane"
                  aria-label="Sketch plane info"
                >
                  <Info size={14} />
                </button>
                <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block group-focus-within:block bg-slate-900/95 border border-slate-600/40 text-[10px] font-mono text-slate-300 px-2 py-1 rounded shadow-lg whitespace-nowrap">
                  on {plane.preset} · ({plane.origin.map((n) => (Math.abs(n) < 0.001 ? '0' : n.toFixed(1))).join(', ')})
                </div>
              </div>
            )}
            <div className="flex bg-slate-700/50 rounded-md p-1 gap-1">
              <ToolBtn name="select" icon={<MousePointer2 size={14} />} label="Select" />
              <ToolBtn name="rect" icon={<Square size={14} />} label="Rect" />
              <ToolBtn name="rounded-rect" icon={<RoundedRectIcon size={14} />} label="RRect" />
              <ToolBtn name="circle" icon={<CircleIcon size={14} />} label="Circle" />
              <ToolBtn name="arc" icon={<ArcIcon size={14} />} label="Arc" />
              <ToolBtn name="line" icon={<Slash size={14} />} label="Line" />
              <ToolBtn name="polyline" icon={<Spline size={14} />} label="Polyline" />
            </div>
            <div className="flex bg-slate-700/50 rounded-md p-1 gap-1">
              <ConstraintBtn type="horizontal" icon={<MoveHorizontal size={14} />} label="H" />
              <ConstraintBtn type="vertical" icon={<MoveVertical size={14} />} label="V" />
              <ConstraintBtn type="fix" icon={<Lock size={14} />} label="Fix" />
              <ConstraintBtn type="coincident" icon={<Link size={14} />} label="Coincident" />
              <ConstraintBtn type="distance" icon={<Ruler size={14} />} label="Distance" />
              <ConstraintBtn type="angle" icon={<Triangle size={14} />} label="Angle" />
              <ConstraintBtn type="tangent" icon={<Slash size={14} />} label="Tangent" />
            </div>
            <div className="text-[11px] text-slate-500 truncate hidden md:block">{hint}</div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-xs font-semibold rounded-md hover:bg-slate-700 text-slate-300"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 text-xs font-bold rounded-md bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-2"
            >
              <Save size={14} /> Save sketch
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Canvas */}
          <div
            ref={containerRef}
            // `touch-action: none` keeps iOS Safari from hijacking
            // pen / touch events for page-scroll gestures, so the
            // Apple Pencil draws on the canvas instead of trying to
            // pan the page. Mouse and trackpad behavior unchanged.
            style={{ touchAction: 'none' }}
            className="flex-1 bg-slate-900 relative overflow-hidden"
          >
            <Stage
              width={size.w}
              height={size.h}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                isPanningRef.current = false;
                panStartRef.current = null;
                setSnapHint(null);
              }}
              onWheel={onWheel}
              onContextMenu={(e: any) => e.evt.preventDefault?.()}
            >
              <Layer {...layerProps}>
                {shapes.map(renderShape)}
                {renderDraft()}
                {renderPolyDraft()}
                {renderArcDraft()}
                {renderHandles()}
                {renderPickedEntities()}
                {renderSnapHint()}
              </Layer>
              <Layer listening={false}>
                {renderCallouts()}
                {renderDraftCallout()}
                {renderPolyDraftCallout()}
                {renderWorldAxes()}
                {originMarker && (() => {
                  // Crosshair + ring + label at the sketch origin —
                  // signals where the picked edge passes through the
                  // perpendicular sketch plane during a sweep.
                  const sx = size.w / 2 + view.panX;
                  const sy = size.h / 2 + view.panY;
                  const color = originMarker.color ?? '#22c55e';
                  const R = 12;
                  return (
                    <>
                      <KCircle
                        key="origin-marker-ring"
                        x={sx}
                        y={sy}
                        radius={R}
                        stroke={color}
                        strokeWidth={2}
                        listening={false}
                      />
                      <KLine
                        key="origin-marker-cross-h"
                        points={[sx - R - 4, sy, sx + R + 4, sy]}
                        stroke={color}
                        strokeWidth={1.5}
                        listening={false}
                      />
                      <KLine
                        key="origin-marker-cross-v"
                        points={[sx, sy - R - 4, sx, sy + R + 4]}
                        stroke={color}
                        strokeWidth={1.5}
                        listening={false}
                      />
                      <Text
                        key="origin-marker-label"
                        x={sx + R + 6}
                        y={sy - R - 14}
                        text={originMarker.label}
                        fontSize={11}
                        fontFamily="ui-monospace, monospace"
                        fontStyle="bold"
                        fill={color}
                        listening={false}
                      />
                    </>
                  );
                })()}
              </Layer>
              {/* Listening layer for dimension graphics (label dbl-click → edit value). */}
              <Layer>
                {renderDimensions()}
              </Layer>
            </Stage>
            {inlineEditor && (
              <div
                className="absolute z-10"
                style={{
                  left: inlineEditor.sx,
                  top: inlineEditor.sy,
                  transform: 'translate(8px, -50%)',
                }}
              >
                <div className="flex items-center gap-1 bg-slate-900/95 border border-blue-500 rounded-md px-2 py-1 shadow-lg">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                    {inlineEditor.kind === 'length'
                      ? 'L'
                      : inlineEditor.kind === 'radius'
                        ? 'R'
                        : inlineEditor.kind === 'rect-width'
                          ? 'W'
                          : inlineEditor.kind === 'rect-height'
                            ? 'H'
                            : 'D'}
                  </span>
                  <input
                    type="number"
                    autoFocus
                    step="0.1"
                    value={inlineEditor.value}
                    onChange={(e) =>
                      setInlineEditor({ ...inlineEditor, value: e.target.value })
                    }
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitInlineEditor();
                      else if (e.key === 'Escape') setInlineEditor(null);
                    }}
                    onBlur={commitInlineEditor}
                    className="w-20 bg-transparent text-slate-100 font-mono text-xs focus:outline-none"
                  />
                  <span className="text-[10px] text-slate-500 font-mono">mm</span>
                </div>
              </div>
            )}
            <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[10px] font-mono text-slate-500">
              <div className="bg-slate-800/70 px-2 py-1 rounded border border-slate-700">
                snap {SNAP_MM}mm · zoom {(view.zoom * 100).toFixed(0)}%
              </div>
              <button
                onClick={() => setView({ panX: 0, panY: 0, zoom: 1 })}
                className="bg-slate-800/70 hover:bg-slate-700 px-2 py-1 rounded border border-slate-700 text-slate-300"
                title="Reset view"
              >
                reset view
              </button>
              <div className="text-slate-500/80">middle-drag pan · wheel zoom</div>
            </div>
          </div>

          {/* Properties panel */}
          <div className="w-72 border-l border-slate-700 bg-slate-800/50 flex flex-col">
            <div className="flex border-b border-slate-700 text-[11px] font-bold uppercase tracking-wider">
              <button
                type="button"
                onClick={() => setPanelTab('properties')}
                className={`flex-1 px-3 py-3 transition-colors ${
                  panelTab === 'properties'
                    ? 'bg-slate-800 text-slate-200'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Properties
              </button>
              <button
                type="button"
                onClick={() => setPanelTab('constraints')}
                className={`flex-1 px-3 py-3 transition-colors ${
                  panelTab === 'constraints'
                    ? 'bg-slate-800 text-slate-200'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Constraints
                {constraints.length > 0 && (
                  <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded bg-blue-600/40 text-[10px] text-blue-200">
                    {constraints.length}
                  </span>
                )}
              </button>
            </div>
            <div className="flex-1 px-4 py-3 overflow-y-auto space-y-3">
              {panelTab === 'properties' && (
                <>
                  {!selectedShape && (
                    <div className="text-xs text-slate-500 italic">Select a shape to view properties.</div>
                  )}
                  {selectedShape && (
                    <ShapeProperties
                      shape={selectedShape}
                      onChange={(patch) => updateShape(selectedShape.id, patch)}
                      onOffset={applyOffset}
                      onSetField={(field, value) =>
                        setShapeField(selectedShape, field, value)
                      }
                      onUnlockField={(field) =>
                        unlockShapeField(selectedShape, field)
                      }
                      onRotateBy={(deltaRad) =>
                        applyShapes((prev) =>
                          prev.map((s) =>
                            s.id === selectedShape.id
                              ? rotateShapeBy(s, deltaRad)
                              : s
                          )
                        )
                      }
                      lockedFields={lockedFields}
                    />
                  )}
                  {selectedShape && (
                    <button
                      onClick={deleteSelected}
                      className="w-full mt-3 px-3 py-2 text-xs font-bold rounded-md bg-red-900/30 hover:bg-red-900/50 text-red-300 border border-red-900/40 flex items-center justify-center gap-2"
                    >
                      <Trash2 size={14} /> Delete shape
                    </button>
                  )}
                </>
              )}
              {panelTab === 'constraints' && (
                <ConstraintsPanel
                  constraints={constraints}
                  shapes={shapes}
                  describeRef={describeEntityRef}
                  onRename={(id, name) =>
                    setConstraints((prev) =>
                      prev.map((c) => (c.id === id ? { ...c, name } : c))
                    )
                  }
                  onUpdateValue={(id, value) => {
                    // Compute next constraints list and sync the ref BEFORE
                    // applyShapes — applyShapes runs solve synchronously off
                    // constraintsRef, so we'd otherwise solve against the
                    // stale value from the previous render.
                    const oldC = constraints.find((c) => c.id === id);
                    const updated = constraints.map((c) => {
                      if (c.id !== id) return c;
                      if (
                        c.type === 'distance' ||
                        c.type === 'length' ||
                        c.type === 'radius' ||
                        c.type === 'angle' ||
                        c.type === 'coord-x' ||
                        c.type === 'coord-y'
                      ) {
                        return { ...c, value };
                      }
                      return c;
                    });
                    setConstraints(updated);
                    constraintsRef.current = updated;
                    // Angle: pre-rotate the first-picked line by the
                    // delta so it visibly moves to satisfy the new
                    // target. Without this nudge the LM solver would
                    // distribute the change between A and B based on
                    // gradient — not what the user expects when they
                    // explicitly picked A as the moving entity.
                    if (
                      oldC &&
                      oldC.type === 'angle' &&
                      Math.abs(oldC.value - value) > 1e-9
                    ) {
                      const delta = value - oldC.value;
                      const aRef = oldC.a;
                      applyShapes((prev) =>
                        prev.map((s) =>
                          s.id === aRef.shapeId &&
                          s.type === 'line' &&
                          !s.frozen
                            ? (rotateShapeBy(s, delta) as Shape)
                            : s
                        )
                      );
                    } else {
                      applyShapes((p) => p);
                    }
                    const ls = lastSolveRef.current;
                    if (ls && !ls.converged) {
                      flashHint(
                        'Could not solve — the new value conflicts with another constraint.'
                      );
                    }
                  }}
                  onDelete={(id) => {
                    const updated = constraints.filter((c) => c.id !== id);
                    setConstraints(updated);
                    constraintsRef.current = updated;
                    applyShapes((p) => p);
                  }}
                  onResolve={resolveAll}
                  diagnostics={solveDiagnostics}
                />
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-700 text-[10px] text-slate-500 leading-relaxed">
              <div className="font-bold text-slate-400 mb-1">
                {shapes.length} shape{shapes.length !== 1 ? 's' : ''}
                {constraints.length > 0 && ` · ${constraints.length} constraint${constraints.length !== 1 ? 's' : ''}`}
              </div>
              Open lines and polylines are construction only — they aren't extruded.
            </div>
          </div>
        </div>
    </div>
  );
}

function ConstraintsPanel({
  constraints,
  shapes,
  describeRef,
  onRename,
  onUpdateValue,
  onDelete,
  onResolve,
  diagnostics,
}: {
  constraints: Constraint[];
  shapes: Shape[];
  describeRef: (ref: EntityRef) => string;
  onRename: (id: string, name: string) => void;
  onUpdateValue: (id: string, value: number) => void;
  onDelete: (id: string) => void;
  onResolve?: () => void;
  diagnostics?: {
    converged: boolean;
    residual: number;
    perConstraint: Record<string, number>;
  } | null;
}) {
  // "Re-solve" button + summary line. Visible even when there are no
  // constraints so the user can always trigger a recompute.
  const header = onResolve ? (
    <div className="flex items-center justify-between gap-2 mb-2">
      <button
        type="button"
        onClick={onResolve}
        className="px-2.5 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 text-white"
        title="Re-run the solver against the current constraints"
      >
        Re-solve
      </button>
      {diagnostics && (
        <div
          className={`text-[10px] font-mono ${
            diagnostics.converged ? 'text-emerald-400' : 'text-red-400'
          }`}
          title={`Total residual: ${diagnostics.residual.toExponential(2)}`}
        >
          {diagnostics.converged
            ? '✓ all satisfied'
            : `✗ residual ${diagnostics.residual.toFixed(3)}`}
        </div>
      )}
    </div>
  ) : null;
  if (constraints.length === 0) {
    return (
      <>
        {header}
        <div className="text-xs text-slate-500 italic">
          No constraints yet. Use the constraint tools in the toolbar to create some.
        </div>
      </>
    );
  }
  const refsOf = (c: Constraint): EntityRef[] => {
    switch (c.type) {
      case 'horizontal':
      case 'vertical':
        return 'a' in c && 'b' in c ? [c.a, c.b] : [(c as { ref: EntityRef }).ref];
      case 'fix':
      case 'length':
      case 'radius':
      case 'coord-x':
      case 'coord-y':
        return [c.ref];
      case 'midpoint':
        return [c.point, c.line];
      case 'symmetry':
        return [c.a, c.b, c.axis];
      case 'coincident':
      case 'parallel':
      case 'perpendicular':
      case 'equal-length':
      case 'equal-radius':
      case 'concentric':
      case 'tangent':
      case 'distance':
      case 'angle':
        return [c.a, c.b];
      default:
        return [];
    }
  };
  const isDimensional = (c: Constraint): boolean =>
    c.type === 'distance' ||
    c.type === 'length' ||
    c.type === 'radius' ||
    c.type === 'angle' ||
    c.type === 'coord-x' ||
    c.type === 'coord-y';
  const valueOf = (c: Constraint): number | null => {
    if (
      c.type === 'distance' ||
      c.type === 'length' ||
      c.type === 'radius' ||
      c.type === 'angle' ||
      c.type === 'coord-x' ||
      c.type === 'coord-y'
    ) {
      return c.value;
    }
    return null;
  };
  // Detect dangling refs (referenced shape no longer exists).
  const shapeIds = new Set(shapes.map((s) => s.id));
  return (
    <div className="space-y-2">
      {header}
      {constraints.map((c) => {
        const refs = refsOf(c);
        const dangling = refs.some((r) => !shapeIds.has(r.shapeId));
        const v = valueOf(c);
        const residual = diagnostics?.perConstraint[c.id] ?? 0;
        const unsatisfied = residual > Math.max(RESIDUAL_TOL, 1e-3);
        return (
          <div
            key={c.id}
            className={`rounded-md border p-2 space-y-1.5 ${
              dangling
                ? 'border-red-900/50 bg-red-950/20'
                : unsatisfied
                ? 'border-amber-700/60 bg-amber-950/20'
                : 'border-slate-700 bg-slate-800/60'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">
                {c.type}
              </span>
              <div className="flex items-center gap-2">
                {unsatisfied && (
                  <span
                    className="text-[10px] font-mono text-amber-400"
                    title={`Residual ${residual.toExponential(2)} — solver couldn't satisfy this constraint`}
                  >
                    Δ {residual < 1 ? residual.toExponential(1) : residual.toFixed(2)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onDelete(c.id)}
                  title="Delete constraint"
                  className="text-slate-500 hover:text-red-400"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            <input
              type="text"
              placeholder="(unnamed)"
              value={c.name ?? ''}
              onChange={(e) => onRename(c.id, e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full px-2 py-1 bg-slate-900/50 rounded text-slate-200 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-400 space-y-0.5">
              {refs.map((r, i) => (
                <div key={i} className="font-mono">
                  · {describeRef(r)}
                </div>
              ))}
            </div>
            {isDimensional(c) && v !== null && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">
                  Value
                </span>
                {c.type === 'angle' ? (
                  <NumInput
                    value={(v * 180) / Math.PI}
                    onCommit={(nv) => onUpdateValue(c.id, (nv * Math.PI) / 180)}
                    className="flex-1 px-2 py-1 bg-slate-900/50 rounded text-slate-100 font-mono text-right text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                ) : (
                  <NumInput
                    value={v}
                    onCommit={(nv) => onUpdateValue(c.id, nv)}
                    className="flex-1 px-2 py-1 bg-slate-900/50 rounded text-slate-100 font-mono text-right text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                )}
                <span className="text-[10px] text-slate-500">
                  {c.type === 'angle' ? '°' : 'mm'}
                </span>
              </div>
            )}
            {dangling && (
              <div className="text-[10px] text-red-400 italic">
                Dangling — referenced shape removed.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OperationToggle({
  value,
  onChange,
}: {
  value: BoolOp;
  onChange: (v: BoolOp) => void;
}) {
  return (
    <div>
      <div className="text-slate-400 uppercase font-medium tracking-wider text-[10px] mb-1">Operation</div>
      <div className="flex bg-slate-700/50 rounded-md p-1 gap-1">
        <button
          onClick={() => onChange('add')}
          className={`flex-1 px-2 py-1 rounded text-[11px] font-semibold transition-colors ${
            value === 'add' ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-600'
          }`}
        >
          Union
        </button>
        <button
          onClick={() => onChange('subtract')}
          className={`flex-1 px-2 py-1 rounded text-[11px] font-semibold transition-colors ${
            value === 'subtract' ? 'bg-red-600 text-white shadow' : 'text-slate-300 hover:bg-slate-600'
          }`}
        >
          Difference
        </button>
      </div>
    </div>
  );
}

/**
 * Evaluate a numeric expression. Supports `+ - * / %`, parentheses, and
 * unary +/-, so the user can type quick calculations like `23 + 4*2` or
 * `(100 - 5) / 2`. Plain numbers ("10", "-3.5") parse via `parseFloat`.
 * Returns `null` for any syntax error / unknown character — never falls
 * back to a partial result.
 */
const evalNumExpression = (input: string): number | null => {
  const s = input.replace(/\s+/g, '');
  if (!s) return null;
  // Tokenize.
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if ('+-*/()%'.includes(c)) {
      tokens.push(c);
      i++;
    } else if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      tokens.push(s.slice(i, j));
      i = j;
    } else {
      return null;
    }
  }
  // Recursive-descent parser. expr := term (('+'|'-') term)*
  //                         term := factor (('*'|'/'|'%') factor)*
  //                         factor := ('+'|'-') factor | '(' expr ')' | number
  let pos = 0;
  const peek = () => (pos < tokens.length ? tokens[pos] : null);
  const consume = () => tokens[pos++];
  const parseFactor = (): number | null => {
    const t = peek();
    if (t === null) return null;
    if (t === '+') {
      consume();
      return parseFactor();
    }
    if (t === '-') {
      consume();
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (t === '(') {
      consume();
      const v = parseExpr();
      if (v === null) return null;
      if (peek() !== ')') return null;
      consume();
      return v;
    }
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return null;
    consume();
    return n;
  };
  function parseTerm(): number | null {
    let v = parseFactor();
    if (v === null) return null;
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume();
      const rhs = parseFactor();
      if (rhs === null) return null;
      v = op === '*' ? v * rhs : op === '/' ? v / rhs : v % rhs;
    }
    return v;
  }
  function parseExpr(): number | null {
    let v = parseTerm();
    if (v === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseTerm();
      if (rhs === null) return null;
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }
  const result = parseExpr();
  if (result === null || pos !== tokens.length) return null;
  if (!Number.isFinite(result)) return null;
  return result;
};

/**
 * Bare numeric input that only commits on Enter / Tab / blur. Esc cancels and
 * reverts to the prop value. The draft is held internally so partial input
 * (e.g. "10." or "-") doesn't round-trip on every keystroke and clobber the
 * user's typing. Accepts arithmetic expressions like `23 + 4*2` so the user
 * can do quick calculations on dimensions; invalid expressions revert.
 */
function NumInput({
  value,
  onCommit,
  className,
}: {
  value: number;
  onCommit: (v: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const display =
    draft !== null ? draft : Number.isFinite(value) ? String(value) : '0';

  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed !== '') {
      const parsed = evalNumExpression(trimmed);
      if (parsed !== null && parsed !== value) onCommit(parsed);
    }
    setDraft(null);
  };
  const cancel = () => setDraft(null);

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={display}
      onFocus={(e) => {
        setDraft(Number.isFinite(value) ? String(value) : '0');
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
          inputRef.current?.blur();
        }
      }}
      className={className}
    />
  );
}

function NumField({
  label,
  value,
  onChange,
  locked,
  onLock,
  onUnlock,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
  /** When true the value is held by a constraint. The toggle button beside
   *  the input switches between locked / unlocked states. */
  locked?: boolean;
  /** Called when the user clicks the toggle while currently *unlocked* —
   *  parent should create a constraint at the current value. */
  onLock?: () => void;
  /** Called when the user clicks the toggle while currently *locked* —
   *  parent should remove the constraint. */
  onUnlock?: () => void;
}) {
  const showToggle = !!(onLock || onUnlock);
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-slate-400 uppercase font-medium tracking-wider text-[10px]">{label}</span>
      <div className="flex items-center gap-1">
        {showToggle && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              if (locked) onUnlock?.();
              else onLock?.();
            }}
            title={
              locked
                ? 'Unlock — remove the constraint pinning this value'
                : 'Lock — pin the current value with a constraint'
            }
            className={`transition-colors px-1 leading-none ${
              locked
                ? 'text-blue-400 hover:text-red-400'
                : 'text-slate-500 hover:text-blue-400'
            }`}
          >
            {locked ? <Lock size={11} /> : <LockOpen size={11} />}
          </button>
        )}
        <NumInput
          value={value}
          onCommit={onChange}
          className={`w-24 px-2 py-1 rounded text-slate-100 font-mono text-right text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 ${
            locked ? 'bg-blue-950/50 border border-blue-700/50' : 'bg-slate-700'
          }`}
        />
      </div>
    </label>
  );
}

function InsetOutsetTool({
  onApply,
}: {
  onApply: (kind: 'inset' | 'outset', d: number) => void;
}) {
  const [d, setD] = useState(2);
  return (
    <div className="space-y-2 pt-3 border-t border-slate-700">
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Wall Offset</div>
      <NumField label="Distance" value={d} onChange={(v) => setD(Math.max(0, v))} />
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={d <= 0}
          onClick={() => onApply('inset', d)}
          className="px-2 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-slate-700 disabled:text-slate-500"
          title="Create a parallel copy inside the shape"
        >
          Inset
        </button>
        <button
          type="button"
          disabled={d <= 0}
          onClick={() => onApply('outset', d)}
          className="px-2 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-slate-700 disabled:text-slate-500"
          title="Create a parallel copy outside the shape"
        >
          Outset
        </button>
      </div>
    </div>
  );
}

/**
 * Compact rotate-by widget used in the property panel for shapes whose
 * rotation isn't a single numeric field (lines / polylines / arcs).
 * `-90°` and `+90°` quick buttons + a custom-degree input.
 */
function RotateControl({ onRotateBy }: { onRotateBy: (deg: number) => void }) {
  return (
    <div className="space-y-1 pt-2 border-t border-slate-700">
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
        Rotate
      </div>
      <div className="flex gap-1 items-center">
        <button
          type="button"
          onClick={() => onRotateBy(-90)}
          className="px-2 py-1 text-[11px] font-medium rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
          title="Rotate -90°"
        >
          -90°
        </button>
        <button
          type="button"
          onClick={() => onRotateBy(90)}
          className="px-2 py-1 text-[11px] font-medium rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
          title="Rotate +90°"
        >
          +90°
        </button>
        <span className="text-[10px] text-slate-500 ml-1">by</span>
        <NumInput
          value={0}
          onCommit={(v) => v && onRotateBy(v)}
          className="w-16 px-2 py-1 bg-slate-700 rounded text-slate-100 font-mono text-right text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="text-[10px] text-slate-500">°</span>
      </div>
    </div>
  );
}

function ShapeProperties({
  shape,
  onChange,
  onOffset,
  onSetField,
  onUnlockField,
  onRotateBy,
  lockedFields,
}: {
  shape: Shape;
  onChange: (patch: any) => void;
  onOffset?: (kind: 'inset' | 'outset', d: number) => void;
  /** When provided, NumField commits route through `onSetField` so the
   *  Sketcher can auto-create a constraint that locks the value. */
  onSetField?: (field: string, value: number) => void;
  onUnlockField?: (field: string) => void;
  /** Rotate the shape in place by `deltaRad` radians around its
   *  centroid. Only used by line / polyline / arc panels — rect /
   *  rounded-rect have an explicit `angle` field instead. */
  onRotateBy?: (deltaRad: number) => void;
  lockedFields?: ReadonlySet<string>;
}) {
  // Each NumField commits via setField (auto-lock) when available, falling
  // back to plain `onChange` if the parent doesn't wire setField. The lock
  // flag is derived from `lockedFields` keyed by `${shape.id}.${field}`.
  const numField = (
    label: string,
    field: string,
    value: number,
    fallback: (v: number) => void
  ) => {
    const fieldKey = `${shape.id}.${field}`;
    const locked = lockedFields?.has(fieldKey) ?? false;
    return (
      <NumField
        label={label}
        value={value}
        onChange={(v) => (onSetField ? onSetField(field, v) : fallback(v))}
        locked={locked}
        // "Lock at current value" — call setField with the existing value;
        // the Sketcher creates an auto-lock constraint without changing
        // anything geometrically.
        onLock={onSetField ? () => onSetField(field, value) : undefined}
        onUnlock={onUnlockField ? () => onUnlockField(field) : undefined}
      />
    );
  };
  if (shape.type === 'rect') {
    const angleDeg = ((shape.angle ?? 0) * 180) / Math.PI;
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Rectangle</div>
        <OperationToggle value={shape.operation} onChange={(v) => onChange({ operation: v })} />
        <div className="space-y-2">
          {numField('X', 'x', shape.x, (v) => onChange({ x: v }))}
          {numField('Y', 'y', shape.y, (v) => onChange({ y: v }))}
          {numField('Width', 'width', shape.width, (v) => onChange({ width: Math.max(0, v) }))}
          {numField('Height', 'height', shape.height, (v) => onChange({ height: Math.max(0, v) }))}
          <NumField
            label="Rotation°"
            value={angleDeg}
            onChange={(v) => onChange({ angle: (v * Math.PI) / 180 })}
          />
        </div>
        {onOffset && <InsetOutsetTool onApply={onOffset} />}
      </div>
    );
  }
  if (shape.type === 'rounded-rect') {
    const capR = Math.min(shape.width, shape.height) / 2;
    const angleDeg = ((shape.angle ?? 0) * 180) / Math.PI;
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Rounded Rectangle</div>
        <OperationToggle value={shape.operation} onChange={(v) => onChange({ operation: v })} />
        <div className="space-y-2">
          {numField('X', 'x', shape.x, (v) => onChange({ x: v }))}
          {numField('Y', 'y', shape.y, (v) => onChange({ y: v }))}
          {numField('Width', 'width', shape.width, (v) => onChange({ width: Math.max(0, v) }))}
          {numField('Height', 'height', shape.height, (v) => onChange({ height: Math.max(0, v) }))}
          {numField('Radius', 'cornerRadius', shape.cornerRadius, (v) =>
            onChange({ cornerRadius: Math.max(0, Math.min(v, capR)) })
          )}
          <NumField
            label="Rotation°"
            value={angleDeg}
            onChange={(v) => onChange({ angle: (v * Math.PI) / 180 })}
          />
        </div>
        {onOffset && <InsetOutsetTool onApply={onOffset} />}
      </div>
    );
  }
  if (shape.type === 'arc') {
    const toDeg = (r: number) => (r * 180) / Math.PI;
    const toRad = (d: number) => (d * Math.PI) / 180;
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Arc (construction)</div>
        <div className="space-y-2">
          {numField('Cx', 'cx', shape.cx, (v) => onChange({ cx: v }))}
          {numField('Cy', 'cy', shape.cy, (v) => onChange({ cy: v }))}
          {numField('Radius', 'radius', shape.radius, (v) => onChange({ radius: Math.max(0, v) }))}
          {numField('Start°', 'startAngle', toDeg(shape.startAngle), (v) =>
            onChange({ startAngle: toRad(v) })
          )}
          {numField('End°', 'endAngle', toDeg(shape.endAngle), (v) =>
            onChange({ endAngle: toRad(v) })
          )}
        </div>
        <label className="flex items-center justify-between text-xs">
          <span className="text-slate-400 uppercase font-medium tracking-wider text-[10px]">CCW sweep</span>
          <input
            type="checkbox"
            checked={shape.ccw}
            onChange={(e) => onChange({ ccw: e.target.checked })}
            className="w-4 h-4 accent-blue-500"
          />
        </label>
        {onRotateBy && (
          <RotateControl onRotateBy={(deg) => onRotateBy((deg * Math.PI) / 180)} />
        )}
      </div>
    );
  }
  if (shape.type === 'circle') {
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Circle</div>
        <OperationToggle value={shape.operation} onChange={(v) => onChange({ operation: v })} />
        <div className="space-y-2">
          {numField('Cx', 'cx', shape.cx, (v) => onChange({ cx: v }))}
          {numField('Cy', 'cy', shape.cy, (v) => onChange({ cy: v }))}
          {numField('Radius', 'radius', shape.radius, (v) => onChange({ radius: Math.max(0, v) }))}
        </div>
        {onOffset && <InsetOutsetTool onApply={onOffset} />}
      </div>
    );
  }
  if (shape.type === 'line') {
    const len = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
    return (
      <div className="space-y-2">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Line (construction)</div>
        {numField('X1', 'x1', shape.x1, (v) => onChange({ x1: v }))}
        {numField('Y1', 'y1', shape.y1, (v) => onChange({ y1: v }))}
        {numField('X2', 'x2', shape.x2, (v) => onChange({ x2: v }))}
        {numField('Y2', 'y2', shape.y2, (v) => onChange({ y2: v }))}
        <div className="flex justify-between text-[10px] text-slate-500 pt-2 border-t border-slate-700">
          <span>Length</span>
          <span className="font-mono text-slate-300">{len.toFixed(2)} mm</span>
        </div>
        {onRotateBy && (
          <RotateControl onRotateBy={(deg) => onRotateBy((deg * Math.PI) / 180)} />
        )}
      </div>
    );
  }
  // polyline
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">
        Polyline {shape.closed ? '(closed)' : '(open · construction)'}
      </div>
      {shape.closed && (
        <OperationToggle value={shape.operation} onChange={(v) => onChange({ operation: v })} />
      )}
      <label className="flex items-center justify-between text-xs">
        <span className="text-slate-400 uppercase font-medium tracking-wider text-[10px]">Closed</span>
        <input
          type="checkbox"
          checked={shape.closed}
          onChange={(e) => onChange({ closed: e.target.checked })}
          className="w-4 h-4 accent-blue-500"
        />
      </label>
      <div className="text-[10px] text-slate-500 pt-1 border-t border-slate-700">
        {shape.points.length} vertices
      </div>
      <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
        {shape.points.map((p, i) => (
          <div key={i} className="flex gap-1 items-center text-[10px]">
            <span className="text-slate-500 w-6">#{i}</span>
            <NumInput
              value={p.x}
              onCommit={(v) => {
                const np = shape.points.map((pp, j) => (j === i ? { ...pp, x: v } : pp));
                onChange({ points: np });
              }}
              className="w-20 px-1.5 py-0.5 bg-slate-700 rounded font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <NumInput
              value={p.y}
              onCommit={(v) => {
                const np = shape.points.map((pp, j) => (j === i ? { ...pp, y: v } : pp));
                onChange({ points: np });
              }}
              className="w-20 px-1.5 py-0.5 bg-slate-700 rounded font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        ))}
      </div>
      {shape.closed && onOffset && <InsetOutsetTool onApply={onOffset} />}
      {onRotateBy && (
        <RotateControl onRotateBy={(deg) => onRotateBy((deg * Math.PI) / 180)} />
      )}
    </div>
  );
}

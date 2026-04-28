import { useState, useRef, useEffect, useMemo } from 'react';
import { Stage, Layer, Rect, Circle as KCircle, Line as KLine, Text } from 'react-konva';
import {
  Square,
  Circle as CircleIcon,
  MousePointer2,
  Save,
  Slash,
  Spline,
  Trash2,
  Lock,
  Link,
  Ruler,
  MoveHorizontal,
  MoveVertical,
} from 'lucide-react';
import { solve, canCreate, arity } from './sketcher/constraints';
import type { Constraint, ConstraintType, EntityRef } from './sketcher/constraints';

type Pt = { x: number; y: number };
type Tool = 'select' | 'rect' | 'circle' | 'line' | 'polyline';

type BoolOp = 'add' | 'subtract';
interface RectShape { id: string; type: 'rect'; x: number; y: number; width: number; height: number; operation: BoolOp; }
interface CircleShape { id: string; type: 'circle'; cx: number; cy: number; radius: number; operation: BoolOp; }
interface LineShape { id: string; type: 'line'; x1: number; y1: number; x2: number; y2: number; }
interface PolylineShape { id: string; type: 'polyline'; points: Pt[]; closed: boolean; operation: BoolOp; }
type Shape = RectShape | CircleShape | LineShape | PolylineShape;
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
    preset: 'XY' | 'XZ' | 'YZ' | 'FACE';
    origin: [number, number, number];
  };
  /** Plane-local 2D segments (flat array x1,y1,x2,y2,...) drawn behind the canvas as a non-editable guide. */
  referenceOutline?: number[];
}

const PX_PER_MM = 5;
const SNAP_MM = 1;
const HANDLE_PX = 8;
const CLOSE_THRESHOLD_MM = 2;
const SNAP_RADIUS_PX = 12;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 50;

const newId = () => Math.random().toString(36).slice(2, 11);
const snapTo = (v: number, step: number) => Math.round(v / step) * step;
const snap = (v: number) => snapTo(v, SNAP_MM);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

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
}

export function Sketcher({
  onSave,
  onCancel,
  initialShapes = [],
  initialConstraints = [],
  plane,
  referenceOutline,
}: SketcherProps) {
  const [shapes, setShapes] = useState<Shape[]>(initialShapes);
  const [constraints, setConstraints] = useState<Constraint[]>(initialConstraints);
  const [pendingConstraint, setPendingConstraint] = useState<ConstraintType | null>(null);
  const [pendingRefs, setPendingRefs] = useState<EntityRef[]>([]);
  const constraintsRef = useRef(constraints);
  useEffect(() => {
    constraintsRef.current = constraints;
  }, [constraints]);

  // Wrap a setShapes update through the constraint solver. Used by drag and
  // inline-edit paths so the user's edit is reconciled with the constraint set
  // before being committed to state.
  const applyShapes = (
    next: Shape[] | ((prev: Shape[]) => Shape[]),
    extraConstraints?: Constraint[]
  ) => {
    setShapes((prev) => {
      const candidate = typeof next === 'function' ? (next as any)(prev) : next;
      const all = extraConstraints
        ? [...constraintsRef.current, ...extraConstraints]
        : constraintsRef.current;
      if (all.length === 0) return candidate;
      const result = solve(candidate, all);
      return result.shapes as Shape[];
    });
  };
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [polyDraft, setPolyDraft] = useState<{ points: Pt[]; preview: Pt } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ panX: 0, panY: 0, zoom: 1 });
  const [snapHint, setSnapHint] = useState<SnapTarget | null>(null);
  const [inlineEditor, setInlineEditor] = useState<
    | {
        shapeId: string;
        kind: 'length' | 'radius' | 'rect-width' | 'rect-height';
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

  const screenScale = PX_PER_MM * view.zoom;
  // Snap radius in mm at the current zoom — fixed in pixels so it feels consistent.
  const snapRadiusMm = SNAP_RADIUS_PX / screenScale;

  // Build snap targets from current shapes + face reference, optionally excluding the in-progress shape.
  const snapTargets = useMemo<SnapTarget[]>(() => {
    const out: SnapTarget[] = [{ pt: { x: 0, y: 0 }, kind: 'origin' }];
    const skipId = draft?.id;
    for (const s of shapes) {
      if (s.id === skipId) continue;
      if (s.type === 'rect') {
        const x0 = s.x, y0 = s.y, x1 = s.x + s.width, y1 = s.y + s.height;
        out.push({ pt: { x: x0, y: y0 }, kind: 'rect-corner' });
        out.push({ pt: { x: x1, y: y0 }, kind: 'rect-corner' });
        out.push({ pt: { x: x1, y: y1 }, kind: 'rect-corner' });
        out.push({ pt: { x: x0, y: y1 }, kind: 'rect-corner' });
        out.push({ pt: { x: (x0 + x1) / 2, y: y0 }, kind: 'rect-edge-mid' });
        out.push({ pt: { x: x1, y: (y0 + y1) / 2 }, kind: 'rect-edge-mid' });
        out.push({ pt: { x: (x0 + x1) / 2, y: y1 }, kind: 'rect-edge-mid' });
        out.push({ pt: { x: x0, y: (y0 + y1) / 2 }, kind: 'rect-edge-mid' });
        out.push({ pt: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, kind: 'rect-center' });
      } else if (s.type === 'circle') {
        out.push({ pt: { x: s.cx, y: s.cy }, kind: 'circle-center' });
        out.push({ pt: { x: s.cx + s.radius, y: s.cy }, kind: 'circle-cardinal' });
        out.push({ pt: { x: s.cx - s.radius, y: s.cy }, kind: 'circle-cardinal' });
        out.push({ pt: { x: s.cx, y: s.cy + s.radius }, kind: 'circle-cardinal' });
        out.push({ pt: { x: s.cx, y: s.cy - s.radius }, kind: 'circle-cardinal' });
      } else if (s.type === 'line') {
        out.push({ pt: { x: s.x1, y: s.y1 }, kind: 'line-end' });
        out.push({ pt: { x: s.x2, y: s.y2 }, kind: 'line-end' });
        out.push({ pt: { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }, kind: 'line-mid' });
      } else if (s.type === 'polyline') {
        for (const p of s.points) out.push({ pt: p, kind: 'poly-vertex' });
        const lastIdx = s.closed ? s.points.length : s.points.length - 1;
        for (let i = 0; i < lastIdx; i++) {
          const a = s.points[i];
          const b = s.points[(i + 1) % s.points.length];
          out.push({ pt: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'poly-edge-mid' });
        }
      }
    }
    if (referenceOutline) {
      for (let i = 0; i + 3 < referenceOutline.length; i += 4) {
        const ax = referenceOutline[i], ay = referenceOutline[i + 1];
        const bx = referenceOutline[i + 2], by = referenceOutline[i + 3];
        out.push({ pt: { x: ax, y: ay }, kind: 'face-vertex' });
        out.push({ pt: { x: bx, y: by }, kind: 'face-vertex' });
        out.push({ pt: { x: (ax + bx) / 2, y: (ay + by) / 2 }, kind: 'face-edge-mid' });
      }
    }
    return out;
  }, [shapes, draft?.id, referenceOutline]);

  const snapPoint = (raw: Pt): Pt => {
    const hit = findSnap(raw);
    if (hit) {
      setSnapHint(hit);
      return hit.pt;
    }
    setSnapHint(null);
    return { x: snap(raw.x), y: snap(raw.y) };
  };

  const findSnap = (pt: Pt): SnapTarget | null => {
    let best: SnapTarget | null = null;
    let bestD = snapRadiusMm;
    // Point targets (origin + features).
    for (const t of snapTargets) {
      const d = Math.hypot(t.pt.x - pt.x, t.pt.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    // Axis projection: snap perpendicular distance to the line, on-axis coord
    // grid-snapped. Only fires when no nearer point target exists.
    const dx = Math.abs(pt.x);
    const dy = Math.abs(pt.y);
    if (dy < bestD) {
      bestD = dy;
      best = { pt: { x: snap(pt.x), y: 0 }, kind: 'x-axis' };
    }
    if (dx < bestD) {
      bestD = dx;
      best = { pt: { x: 0, y: snap(pt.y) }, kind: 'y-axis' };
    }
    return best;
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
      return hit.pt;
    }
    setSnapHint(null);
    return { x: snap(rawX), y: snap(rawY) };
  };

  const selectedShape = useMemo(
    () => shapes.find((s) => s.id === selectedId) ?? null,
    [shapes, selectedId]
  );

  const switchTool = (next: Tool) => {
    setTool(next);
    setDraft(null);
    setPolyDraft(null);
  };

  const updateShape = (id: string, patch: Partial<Shape> | any) => {
    applyShapes((prev) => prev.map((s) => (s.id === id ? ({ ...s, ...patch } as Shape) : s)));
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

  const finalizeConstraint = (type: ConstraintType, refs: EntityRef[]) => {
    let next: Constraint | null = null;
    const id = newConstraintId();
    if (type === 'horizontal' || type === 'vertical') {
      next = { id, type, ref: refs[0] };
    } else if (type === 'fix') {
      const p = refs[0];
      // Capture current world position as the fix value.
      const layoutShape = shapes.find((s) => s.id === p.shapeId);
      const value = layoutShape ? pointAt(layoutShape, p) : { x: 0, y: 0 };
      if (p.kind === 'point' && value) next = { id, type: 'fix', ref: p, value };
    } else if (type === 'coincident') {
      next = { id, type: 'coincident', a: refs[0], b: refs[1] };
    } else if (type === 'distance') {
      const a = refs[0];
      const b = refs[1];
      const sa = shapes.find((s) => s.id === a.shapeId);
      const sb = shapes.find((s) => s.id === b.shapeId);
      const pa = sa ? pointAt(sa, a) : null;
      const pb = sb ? pointAt(sb, b) : null;
      const value = pa && pb ? Math.hypot(pa.x - pb.x, pa.y - pb.y) : 0;
      next = { id, type: 'distance', a, b, value };
    }
    if (next) {
      setConstraints((prev) => [...prev, next!]);
      // Re-solve the current shapes against the new constraint set.
      applyShapes((p) => p, [next]);
    }
    setPendingConstraint(null);
    setPendingRefs([]);
  };

  // Lookup the world position (in plane-local mm) of a Point ref on a shape.
  const pointAt = (s: Shape, ref: EntityRef): Pt | null => {
    if (ref.kind !== 'point') return null;
    if (s.type === 'line') {
      if (ref.role === 'p1') return { x: s.x1, y: s.y1 };
      if (ref.role === 'p2') return { x: s.x2, y: s.y2 };
    } else if (s.type === 'circle') {
      if (ref.role === 'center') return { x: s.cx, y: s.cy };
    } else if (s.type === 'rect') {
      if (ref.role === 'tl') return { x: s.x, y: s.y + s.height };
      if (ref.role === 'tr') return { x: s.x + s.width, y: s.y + s.height };
      if (ref.role === 'br') return { x: s.x + s.width, y: s.y };
      if (ref.role === 'bl') return { x: s.x, y: s.y };
      if (ref.role === 'center')
        return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
    } else if (s.type === 'polyline' && ref.role === 'vertex' && ref.vertexIdx != null) {
      return s.points[ref.vertexIdx] ?? null;
    }
    return null;
  };

  // Pick an EntityRef while a constraint is pending. Decides what role the
  // shape contributes (point, line, etc.) based on the constraint's needs.
  const pickRefForConstraint = (s: Shape): EntityRef | null => {
    if (!pendingConstraint) return null;
    const needsPoint =
      pendingConstraint === 'fix' ||
      pendingConstraint === 'coincident' ||
      pendingConstraint === 'distance';
    const needsLineish =
      pendingConstraint === 'horizontal' || pendingConstraint === 'vertical';
    if (needsLineish) {
      if (s.type === 'line') return { kind: 'line', shapeId: s.id };
      // Default rect edge: top
      if (s.type === 'rect') return { kind: 'edge', shapeId: s.id, edge: 'top' };
      return null;
    }
    if (needsPoint) {
      if (s.type === 'line') return { kind: 'point', shapeId: s.id, role: 'p1' };
      if (s.type === 'circle') return { kind: 'point', shapeId: s.id, role: 'center' };
      if (s.type === 'rect') return { kind: 'point', shapeId: s.id, role: 'tl' };
      if (s.type === 'polyline')
        return { kind: 'point', shapeId: s.id, role: 'vertex', vertexIdx: 0 };
    }
    return null;
  };

  const offerRef = (ref: EntityRef) => {
    if (!pendingConstraint) return;
    const refs = [...pendingRefs, ref];
    if (refs.length >= arity(pendingConstraint) && canCreate(pendingConstraint, refs)) {
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
    setInlineEditor({ shapeId: s.id, kind: 'length', sx, sy, value: len.toFixed(2) });
  };

  const openRadiusEditor = (s: CircleShape) => {
    const { sx, sy } = projectToScreen({ x: s.cx + s.radius, y: s.cy });
    setInlineEditor({ shapeId: s.id, kind: 'radius', sx, sy, value: s.radius.toFixed(2) });
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
    setInlineEditor({ shapeId: s.id, kind, sx, sy, value: value.toFixed(2) });
  };

  const commitInlineEditor = () => {
    if (!inlineEditor) return;
    const v = parseFloat(inlineEditor.value);
    const shape = shapes.find((sh) => sh.id === inlineEditor.shapeId);
    if (!shape || !Number.isFinite(v)) {
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
    setTool('select');
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
  const onMouseDown = (e: any) => {
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

    if (tool === 'select') {
      if (onEmpty) setSelectedId(null);
      return;
    }
    if (tool === 'rect') {
      setDraft({ id: newId(), type: 'rect', x: pt.x, y: pt.y, width: 0, height: 0, operation: 'add' });
      return;
    }
    if (tool === 'circle') {
      setDraft({ id: newId(), type: 'circle', cx: pt.x, cy: pt.y, radius: 0, operation: 'add' });
      return;
    }
    if (tool === 'line') {
      setDraft({ id: newId(), type: 'line', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
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
          setPolyDraft({ points: [...polyDraft.points, pt], preview: pt });
        }
      }
    }
  };

  const onMouseMove = (e: any) => {
    if (isPanningRef.current && panStartRef.current) {
      const dx = e.evt.clientX - panStartRef.current.cx;
      const dy = e.evt.clientY - panStartRef.current.cy;
      setView((v) => ({
        ...v,
        panX: panStartRef.current!.panX + dx,
        panY: panStartRef.current!.panY + dy,
      }));
      return;
    }
    const stage = e.target.getStage();
    const pt = pointerToWorld(stage);
    if (!pt) return;

    if (draft) {
      if (draft.type === 'rect') {
        setDraft({ ...draft, width: pt.x - draft.x, height: pt.y - draft.y });
      } else if (draft.type === 'circle') {
        setDraft({ ...draft, radius: dist({ x: draft.cx, y: draft.cy }, pt) });
      } else if (draft.type === 'line') {
        setDraft({ ...draft, x2: pt.x, y2: pt.y });
      }
    }
    if (polyDraft) {
      setPolyDraft({ ...polyDraft, preview: pt });
    }
  };

  const onMouseUp = () => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
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
    } else if (s.type === 'circle') {
      valid = s.radius > 0;
    } else if (s.type === 'line') {
      valid = dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) > 0;
    }
    if (valid) {
      setShapes((prev) => [...prev, s]);
      setSelectedId(s.id);
      setTool('select');
    }
    setDraft(null);
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
        }
        else if (polyDraft) setPolyDraft(null);
        else if (draft) setDraft(null);
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
  }, [polyDraft, draft, selectedId, onCancel]);

  // ---- Save ----
  const handleSave = () => {
    const out: any[] = [];
    for (const s of shapes) {
      if (s.type === 'rect' && s.width > 0 && s.height > 0) {
        out.push({
          id: s.id,
          type: 'rect',
          x: s.x + s.width / 2,
          y: s.y + s.height / 2,
          width: s.width,
          height: s.height,
          operation: s.operation,
        });
      } else if (s.type === 'circle' && s.radius > 0) {
        out.push({ id: s.id, type: 'circle', x: s.cx, y: s.cy, radius: s.radius, operation: s.operation });
      } else if (s.type === 'polyline' && s.closed && s.points.length >= 3) {
        out.push({ id: s.id, type: 'polygon', points: s.points, operation: s.operation });
      }
      // Open lines / open polylines treated as construction; not extruded.
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
      case 'fix':
      case 'length':
      case 'radius':
        return [c.ref];
      case 'midpoint':
        return [c.point, c.line];
      case 'symmetry':
        return [c.a, c.b, c.axis];
      default:
        return [c.a, c.b];
    }
  };

  // ---- Render ----

  // World-space layer: origin at center of canvas (plus pan), Y up, scale = px/mm * zoom.
  const layerProps = {
    x: size.w / 2 + view.panX,
    y: size.h / 2 + view.panY,
    scaleX: screenScale,
    scaleY: -screenScale,
  };

  // Origin axes in world coords
  const renderAxes = () => [
    <KLine key="ax" points={[-1000, 0, 1000, 0]} stroke="#475569" strokeWidth={1 / screenScale} />,
    <KLine key="ay" points={[0, -1000, 0, 1000]} stroke="#475569" strokeWidth={1 / screenScale} />,
  ];

  // Non-editable face outline shown when sketching on a face.
  const renderReference = () => {
    if (!referenceOutline || referenceOutline.length < 4) return null;
    const out: any[] = [];
    for (let i = 0; i + 3 < referenceOutline.length; i += 4) {
      out.push(
        <KLine
          key={`ref-${i}`}
          points={[referenceOutline[i], referenceOutline[i + 1], referenceOutline[i + 2], referenceOutline[i + 3]]}
          stroke="#fbbf24"
          strokeWidth={1.5 / screenScale}
          opacity={0.75}
          listening={false}
        />
      );
    }
    return out;
  };

  const isSubtract = (s: Shape) =>
    (s.type === 'rect' || s.type === 'circle' || (s.type === 'polyline' && s.closed)) &&
    (s as any).operation === 'subtract';

  const fillFor = (s: Shape, isSelected: boolean) => {
    if (isSubtract(s)) return isSelected ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.08)';
    return isSelected ? 'rgba(59,130,246,0.15)' : 'rgba(148,163,184,0.06)';
  };
  const strokeFor = (s: Shape, isSelected: boolean) => {
    if (isSubtract(s)) return isSelected ? '#f87171' : '#ef4444';
    if (isSelected) return '#3b82f6';
    if (s.type === 'line') return '#94a3b8';
    if (s.type === 'polyline' && !s.closed) return '#94a3b8';
    return '#cbd5e1';
  };
  const dashFor = (s: Shape) => (isSubtract(s) ? [3 / screenScale, 2 / screenScale] : undefined);

  const renderShape = (s: Shape) => {
    const isSelected = s.id === selectedId;
    const sw = (isSelected ? 2 : 1) / screenScale;
    const select = (e: any) => {
      if (pendingConstraint) {
        // Constraint pick mode — use the shape as the next ref instead of
        // entering normal selection.
        const ref = pickRefForConstraint(s);
        if (ref) {
          e.cancelBubble = true;
          offerRef(ref);
        }
        return;
      }
      if (tool !== 'select') return;
      e.cancelBubble = true;
      setSelectedId(s.id);
    };

    if (s.type === 'rect') {
      return (
        <Rect
          key={s.id}
          x={s.x}
          y={s.y}
          width={s.width}
          height={s.height}
          fill={fillFor(s, isSelected)}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={sw}
          dash={dashFor(s)}
          onMouseDown={select}
          onTap={select}
          draggable={tool === 'select'}
          onDragStart={() => setSelectedId(s.id)}
          onDragMove={(e) => {
            const sp = snapPoint({ x: e.target.x(), y: e.target.y() });
            e.target.position({ x: sp.x, y: sp.y });
            updateShape(s.id, { x: sp.x, y: sp.y });
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
          onMouseDown={select}
          onTap={select}
          draggable={tool === 'select'}
          onDragStart={() => setSelectedId(s.id)}
          onDragMove={(e) => {
            const sp = snapPoint({ x: e.target.x(), y: e.target.y() });
            e.target.position({ x: sp.x, y: sp.y });
            updateShape(s.id, { cx: sp.x, cy: sp.y });
          }}
          onDragEnd={() => setSnapHint(null)}
          onDblClick={(e: any) => {
            e.cancelBubble = true;
            openRadiusEditor(s);
          }}
        />
      );
    }
    if (s.type === 'line') {
      return (
        <KLine
          key={s.id}
          points={[s.x1, s.y1, s.x2, s.y2]}
          stroke={strokeFor(s, isSelected)}
          strokeWidth={sw}
          dash={[2 / screenScale, 2 / screenScale]}
          hitStrokeWidth={6 / screenScale}
          onMouseDown={select}
          onTap={select}
          onDblClick={(e: any) => {
            e.cancelBubble = true;
            openLengthEditor(s);
          }}
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
          onMouseDown={select}
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
        onMouseDown={(e: any) => {
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
      const corners: { key: 'tl' | 'tr' | 'br' | 'bl'; p: Pt }[] = [
        { key: 'tl', p: { x: s.x, y: s.y } },
        { key: 'tr', p: { x: s.x + s.width, y: s.y } },
        { key: 'br', p: { x: s.x + s.width, y: s.y + s.height } },
        { key: 'bl', p: { x: s.x, y: s.y + s.height } },
      ];
      const opps = {
        tl: { x: s.x + s.width, y: s.y + s.height },
        tr: { x: s.x, y: s.y + s.height },
        br: { x: s.x, y: s.y },
        bl: { x: s.x + s.width, y: s.y },
      } as const;
      return corners.map((c) =>
        Handle(c.key, c.p, (np) => {
          const opp = opps[c.key];
          const nx = Math.min(np.x, opp.x);
          const ny = Math.min(np.y, opp.y);
          const nw = Math.abs(np.x - opp.x);
          const nh = Math.abs(np.y - opp.y);
          updateShape(s.id, { x: nx, y: ny, width: nw, height: nh });
        })
      );
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
    if (draft.type === 'rect') {
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
    const last = polyDraft.points[polyDraft.points.length - 1];
    const mid = { x: (last.x + polyDraft.preview.x) / 2, y: (last.y + polyDraft.preview.y) / 2 };
    const m = projectToScreen(mid);
    const len = dist(last, polyDraft.preview);
    return (
      <Text
        key="draft-poly"
        x={m.sx + 8}
        y={m.sy - 6}
        text={`${len.toFixed(1)} mm`}
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
    if (pendingConstraint) {
      const need = arity(pendingConstraint) - pendingRefs.length;
      const noun =
        pendingConstraint === 'horizontal' ||
        pendingConstraint === 'vertical' ||
        pendingConstraint === 'length'
          ? 'line or rect edge'
          : pendingConstraint === 'radius'
            ? 'circle'
            : 'point';
      return `${pendingConstraint}: pick ${need} more ${noun}${need !== 1 ? 's' : ''}. Esc cancels.`;
    }
    if (tool === 'rect') return 'Drag to draw a rectangle.';
    if (tool === 'circle') return 'Drag from the center outward.';
    if (tool === 'line') return 'Drag from start to end.';
    if (tool === 'polyline')
      return 'Click to add points · Enter to finish open · Click first point to close.';
    return selectedShape
      ? 'Drag handles to reshape · Drag body to move · Del to remove.'
      : 'Click a shape to select.';
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-md">
      <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-[92vw] h-[92vh] flex flex-col overflow-hidden">
        {/* Header / Toolbar */}
        <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-lg font-bold pr-3 border-r border-slate-700 whitespace-nowrap">2D Sketcher</h2>
            {plane && (
              <div className="text-[10px] font-mono text-slate-300 bg-slate-700/60 border border-slate-600/40 px-2 py-1 rounded">
                on {plane.preset} · ({plane.origin.map((n) => (Math.abs(n) < 0.001 ? '0' : n.toFixed(1))).join(', ')})
              </div>
            )}
            <div className="flex bg-slate-700/50 rounded-md p-1 gap-1">
              <ToolBtn name="select" icon={<MousePointer2 size={14} />} label="Select" />
              <ToolBtn name="rect" icon={<Square size={14} />} label="Rect" />
              <ToolBtn name="circle" icon={<CircleIcon size={14} />} label="Circle" />
              <ToolBtn name="line" icon={<Slash size={14} />} label="Line" />
              <ToolBtn name="polyline" icon={<Spline size={14} />} label="Polyline" />
            </div>
            <div className="flex bg-slate-700/50 rounded-md p-1 gap-1">
              <ConstraintBtn type="horizontal" icon={<MoveHorizontal size={14} />} label="H" />
              <ConstraintBtn type="vertical" icon={<MoveVertical size={14} />} label="V" />
              <ConstraintBtn type="fix" icon={<Lock size={14} />} label="Fix" />
              <ConstraintBtn type="coincident" icon={<Link size={14} />} label="Coincident" />
              <ConstraintBtn type="distance" icon={<Ruler size={14} />} label="Distance" />
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
          <div ref={containerRef} className="flex-1 bg-slate-900 relative overflow-hidden">
            <Stage
              width={size.w}
              height={size.h}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={() => {
                isPanningRef.current = false;
                panStartRef.current = null;
                setSnapHint(null);
              }}
              onWheel={onWheel}
              onContextMenu={(e: any) => e.evt.preventDefault?.()}
            >
              <Layer {...layerProps}>
                {renderAxes()}
                {renderReference()}
                {shapes.map(renderShape)}
                {renderDraft()}
                {renderPolyDraft()}
                {renderHandles()}
                {renderSnapHint()}
              </Layer>
              <Layer listening={false}>
                {renderCallouts()}
                {renderDraftCallout()}
                {renderPolyDraftCallout()}
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
                          : 'H'}
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
            <div className="px-4 py-3 border-b border-slate-700 text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Properties
            </div>
            <div className="flex-1 px-4 py-3 overflow-y-auto space-y-3">
              {!selectedShape && (
                <div className="text-xs text-slate-500 italic">Select a shape to view properties.</div>
              )}
              {selectedShape && (
                <ShapeProperties
                  shape={selectedShape}
                  onChange={(patch) => updateShape(selectedShape.id, patch)}
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
            </div>
            <div className="px-4 py-3 border-t border-slate-700 text-[10px] text-slate-500 leading-relaxed">
              <div className="font-bold text-slate-400 mb-1">
                {shapes.length} shape{shapes.length !== 1 ? 's' : ''}
              </div>
              Open lines and polylines are construction only — they aren't extruded.
            </div>
          </div>
        </div>
      </div>
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

function NumField({
  label,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-slate-400 uppercase font-medium tracking-wider text-[10px]">{label}</span>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-24 px-2 py-1 bg-slate-700 rounded text-slate-100 font-mono text-right text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </label>
  );
}

function ShapeProperties({ shape, onChange }: { shape: Shape; onChange: (patch: any) => void }) {
  if (shape.type === 'rect') {
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Rectangle</div>
        <OperationToggle value={shape.operation} onChange={(v) => onChange({ operation: v })} />
        <div className="space-y-2">
          <NumField label="X" value={shape.x} onChange={(v) => onChange({ x: v })} />
          <NumField label="Y" value={shape.y} onChange={(v) => onChange({ y: v })} />
          <NumField label="Width" value={shape.width} onChange={(v) => onChange({ width: Math.max(0, v) })} />
          <NumField label="Height" value={shape.height} onChange={(v) => onChange({ height: Math.max(0, v) })} />
        </div>
      </div>
    );
  }
  if (shape.type === 'circle') {
    return (
      <div className="space-y-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Circle</div>
        <OperationToggle value={shape.operation} onChange={(v) => onChange({ operation: v })} />
        <div className="space-y-2">
          <NumField label="Cx" value={shape.cx} onChange={(v) => onChange({ cx: v })} />
          <NumField label="Cy" value={shape.cy} onChange={(v) => onChange({ cy: v })} />
          <NumField label="Radius" value={shape.radius} onChange={(v) => onChange({ radius: Math.max(0, v) })} />
        </div>
      </div>
    );
  }
  if (shape.type === 'line') {
    const len = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
    return (
      <div className="space-y-2">
        <div className="text-[11px] font-bold uppercase tracking-wider text-blue-400">Line (construction)</div>
        <NumField label="X1" value={shape.x1} onChange={(v) => onChange({ x1: v })} />
        <NumField label="Y1" value={shape.y1} onChange={(v) => onChange({ y1: v })} />
        <NumField label="X2" value={shape.x2} onChange={(v) => onChange({ x2: v })} />
        <NumField label="Y2" value={shape.y2} onChange={(v) => onChange({ y2: v })} />
        <div className="flex justify-between text-[10px] text-slate-500 pt-2 border-t border-slate-700">
          <span>Length</span>
          <span className="font-mono text-slate-300">{len.toFixed(2)} mm</span>
        </div>
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
            <input
              type="number"
              step={1}
              value={p.x}
              onChange={(e) => {
                const v = parseFloat(e.target.value) || 0;
                const np = shape.points.map((pp, j) => (j === i ? { ...pp, x: v } : pp));
                onChange({ points: np });
              }}
              className="w-20 px-1.5 py-0.5 bg-slate-700 rounded font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="number"
              step={1}
              value={p.y}
              onChange={(e) => {
                const v = parseFloat(e.target.value) || 0;
                const np = shape.points.map((pp, j) => (j === i ? { ...pp, y: v } : pp));
                onChange({ points: np });
              }}
              className="w-20 px-1.5 py-0.5 bg-slate-700 rounded font-mono text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

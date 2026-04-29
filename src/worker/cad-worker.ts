import {
  setOC,
  drawCircle,
  drawRoundedRectangle,
  draw,
  Plane,
  measureShapeVolumeProperties,
} from "replicad";
import initOpenCascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { zipSync, strToU8 } from "fflate";

let oc: any = null;

async function init() {
  if (!oc) {
    const ocModule = await (initOpenCascade as any)({
      locateFile: () => opencascadeWasm,
    });

    oc = ocModule;
    setOC(oc);
  }
}

const GHOST_THICKNESS = 0.001;
const PLANARITY_DOT = 0.999; // ~2.5° tolerance

interface FaceMetaPayload {
  faceId: number;
  origin: [number, number, number];
  /** Plane normal sent to OpenCascade. May be flipped from the face's outward
   *  normal when needed to keep `xDir` along a positive world axis (so the
   *  sketcher feels natural to read). Use `outwardNormal` for the original
   *  outward direction. */
  normal: [number, number, number];
  /** The face's true outward normal (always points away from the solid).
   *  Equal to `normal` when no flip was applied. */
  outwardNormal: [number, number, number];
  xDir: [number, number, number];
  isPlanar: boolean;
  triangleStart: number;
  triangleCount: number;
  /** Plane-local 2D segments (flat array: x1,y1,x2,y2,...) for planar faces */
  boundary?: number[];
}

const computeFaceMeta = (faces: any): Record<number, FaceMetaPayload> => {
  const meta: Record<number, FaceMetaPayload> = {};
  const groups = faces.faceGroups ?? [];
  const triangles: number[] = faces.triangles ?? [];
  const vertices: number[] = faces.vertices ?? [];
  const normals: number[] = faces.normals ?? [];
  if (!groups.length || !triangles.length || !vertices.length) return meta;

  for (const g of groups) {
    let cx = 0, cy = 0, cz = 0;
    let nxSum = 0, nySum = 0, nzSum = 0;
    let count = 0;
    const sampleNormals: [number, number, number][] = [];

    for (let i = g.start; i < g.start + g.count; i++) {
      const vi = triangles[i];
      const px = vertices[vi * 3];
      const py = vertices[vi * 3 + 1];
      const pz = vertices[vi * 3 + 2];
      cx += px; cy += py; cz += pz;
      const nx = normals[vi * 3];
      const ny = normals[vi * 3 + 1];
      const nz = normals[vi * 3 + 2];
      nxSum += nx; nySum += ny; nzSum += nz;
      if (sampleNormals.length < 24) sampleNormals.push([nx, ny, nz]);
      count++;
    }
    if (!count) continue;

    const centroid: [number, number, number] = [cx / count, cy / count, cz / count];
    let nLen = Math.hypot(nxSum, nySum, nzSum) || 1;
    const normal: [number, number, number] = [nxSum / nLen, nySum / nLen, nzSum / nLen];

    // Sketch origin: world origin projected onto the face's plane. For a
    // face whose plane contains (0,0,0) — e.g. a side face whose bottom
    // edge sits on the floor — the origin is exactly (0,0,0), so the
    // sketcher's X axis lines up with the world ground line and the
    // face's bottom edge appears at sketch y=0. For offset faces the
    // origin is the closest point on the plane to the world origin
    // (still on the plane, just shifted).
    const dotCN = normal[0] * centroid[0] + normal[1] * centroid[1] + normal[2] * centroid[2];
    const origin: [number, number, number] = [
      normal[0] * dotCN,
      normal[1] * dotCN,
      normal[2] * dotCN,
    ];

    // Planarity check: every sampled vertex normal must be within tolerance of the average.
    let isPlanar = true;
    for (const [nx, ny, nz] of sampleNormals) {
      const len = Math.hypot(nx, ny, nz) || 1;
      const dot = (nx * normal[0] + ny * normal[1] + nz * normal[2]) / len;
      if (dot < PLANARITY_DOT) { isPlanar = false; break; }
    }

    // Sketch "up" should match the world's up direction (Z-up CAD
    // convention used everywhere else: box op extrudes in +Z, the floor
    // grid sits on the XY plane, the camera's up vector is +Z). Prefer
    // world +Z as the projection reference. For ±Z faces (top/bottom,
    // where +Z is parallel to the normal) +Z collapses to zero, so fall
    // back to world +Y.
    let upRef: [number, number, number] = [0, 0, 1];
    if (Math.abs(normal[2]) > 0.95) upRef = [0, 1, 0];
    const dUp =
      upRef[0] * normal[0] + upRef[1] * normal[1] + upRef[2] * normal[2];
    const yRaw: [number, number, number] = [
      upRef[0] - dUp * normal[0],
      upRef[1] - dUp * normal[1],
      upRef[2] - dUp * normal[2],
    ];
    const yLen = Math.hypot(yRaw[0], yRaw[1], yRaw[2]) || 1;
    const yDirWorld: [number, number, number] = [
      yRaw[0] / yLen,
      yRaw[1] / yLen,
      yRaw[2] / yLen,
    ];
    // xDir = yDir × normal so (xDir, yDir, normal) is right-handed with the
    // face's outward normal. This is the "viewer's perspective" convention:
    // looking AT the face from outside (from +normal), sketch +x points to
    // the user's right. World axis indicators in the sketcher tell the user
    // exactly which world axis each direction corresponds to.
    const outwardNormal: [number, number, number] = [...normal];
    const xDir: [number, number, number] = [
      yDirWorld[1] * normal[2] - yDirWorld[2] * normal[1],
      yDirWorld[2] * normal[0] - yDirWorld[0] * normal[2],
      yDirWorld[0] * normal[1] - yDirWorld[1] * normal[0],
    ];
    const planeNormal: [number, number, number] = [...normal];

    let boundary: number[] | undefined;
    if (isPlanar) {
      // y-axis in the plane = planeNormal × xDir (== yDirWorld by construction).
      const yDir: [number, number, number] = [
        planeNormal[1] * xDir[2] - planeNormal[2] * xDir[1],
        planeNormal[2] * xDir[0] - planeNormal[0] * xDir[2],
        planeNormal[0] * xDir[1] - planeNormal[1] * xDir[0],
      ];
      const project = (vi: number): [number, number] => {
        const dx = vertices[vi * 3] - origin[0];
        const dy = vertices[vi * 3 + 1] - origin[1];
        const dz = vertices[vi * 3 + 2] - origin[2];
        return [
          dx * xDir[0] + dy * xDir[1] + dz * xDir[2],
          dx * yDir[0] + dy * yDir[1] + dz * yDir[2],
        ];
      };
      // Count how often each undirected edge appears across the group's triangles.
      // Edges seen exactly once are boundary edges of the face.
      const edgeCount = new Map<string, number>();
      const edgeEnds = new Map<string, [number, number]>();
      for (let i = g.start; i < g.start + g.count; i += 3) {
        const a = triangles[i];
        const b = triangles[i + 1];
        const c = triangles[i + 2];
        const pairs: [number, number][] = [
          [a, b],
          [b, c],
          [c, a],
        ];
        for (const [u, v] of pairs) {
          const key = u < v ? `${u}_${v}` : `${v}_${u}`;
          edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
          if (!edgeEnds.has(key)) edgeEnds.set(key, [u, v]);
        }
      }
      const segments: number[] = [];
      for (const [key, count] of edgeCount) {
        if (count !== 1) continue;
        const [u, v] = edgeEnds.get(key)!;
        const p1 = project(u);
        const p2 = project(v);
        segments.push(p1[0], p1[1], p2[0], p2[1]);
      }
      boundary = segments;
    }

    meta[g.faceId] = {
      faceId: g.faceId,
      origin,
      normal: planeNormal,
      outwardNormal,
      xDir,
      isPlanar,
      triangleStart: g.start,
      triangleCount: g.count,
      boundary,
    };
  }
  return meta;
};

/**
 * Locate the face on the current model that matches a stored anchor
 * (origin + outward normal). Used so face-anchored sketch_extrude ops can
 * pick up live geometry when an upstream op (e.g. the box dims) changes.
 *
 * Match criteria, in order of strictness:
 *   1. Outward normal aligns within ~8° (dot ≥ 0.99).
 *   2. Anchor origin lies within `planeTolMm` of the candidate's plane.
 *   3. Tie-breaker: smallest 3D distance from anchor origin to face centroid.
 */
const resolveFaceAnchor = (
  meta: Record<number, FaceMetaPayload>,
  anchor: {
    origin: [number, number, number];
    outwardNormal: [number, number, number];
  },
  planeTolMm = 5
): FaceMetaPayload | null => {
  let best: FaceMetaPayload | null = null;
  let bestCentroidDist = Infinity;
  for (const f of Object.values(meta)) {
    if (!f.isPlanar) continue;
    const dotN =
      f.outwardNormal[0] * anchor.outwardNormal[0] +
      f.outwardNormal[1] * anchor.outwardNormal[1] +
      f.outwardNormal[2] * anchor.outwardNormal[2];
    if (dotN < 0.99) continue;
    const dx = anchor.origin[0] - f.origin[0];
    const dy = anchor.origin[1] - f.origin[1];
    const dz = anchor.origin[2] - f.origin[2];
    const planeDist = Math.abs(
      dx * f.outwardNormal[0] + dy * f.outwardNormal[1] + dz * f.outwardNormal[2]
    );
    if (planeDist > planeTolMm) continue;
    const centroidDist = Math.hypot(dx, dy, dz);
    if (centroidDist < bestCentroidDist) {
      bestCentroidDist = centroidDist;
      best = f;
    }
  }
  return best;
};

// ---- 3MF export helpers ----

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  "</Types>";

const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" Id="rel-1"/>' +
  "</Relationships>";

const buildModelXml = (vertices: number[], triangles: number[]): string => {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push(
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
  );
  parts.push("<resources>");
  parts.push('<object id="1" type="model"><mesh>');
  parts.push("<vertices>");
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    parts.push(
      `<vertex x="${vertices[i]}" y="${vertices[i + 1]}" z="${vertices[i + 2]}"/>`
    );
  }
  parts.push("</vertices>");
  parts.push("<triangles>");
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    parts.push(
      `<triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>`
    );
  }
  parts.push("</triangles>");
  parts.push("</mesh></object>");
  parts.push("</resources>");
  parts.push('<build><item objectid="1"/></build>');
  parts.push("</model>");
  return parts.join("");
};

const build3MFArchive = (
  vertices: number[],
  triangles: number[]
): ArrayBuffer => {
  const archive = zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES_XML),
      "_rels/.rels": strToU8(RELS_XML),
      "3D/3dmodel.model": strToU8(buildModelXml(vertices, triangles)),
    },
    { level: 6 }
  );
  // Copy into a fresh ArrayBuffer so the postMessage transfer is unambiguous
  // (zipSync returns a Uint8Array that may share underlying memory with internal buffers).
  const out = new ArrayBuffer(archive.byteLength);
  new Uint8Array(out).set(archive);
  return out;
};

interface EdgeMetaPayload {
  edgeId: number;
  midpoint: [number, number, number];
  vertexStart: number;
  vertexCount: number;
}

const computeEdgeMeta = (edges: any): Record<number, EdgeMetaPayload> => {
  const meta: Record<number, EdgeMetaPayload> = {};
  const groups = edges.edgeGroups ?? [];
  const lines: number[] = edges.lines ?? [];
  if (!groups.length || !lines.length) return meta;
  for (const g of groups) {
    if (!g.count) continue;
    // Pick a sampled vertex that's actually ON the edge. The previous
    // implementation averaged all sampled points — fine for straight edges
    // (the average IS on the segment) but wrong for curves: the centroid
    // of a full circle's samples is the circle's CENTER, which is off the
    // edge, so `edge.containsPoint(midpoint)` later misses for fillet /
    // chamfer. The middle vertex of the polyline is always on the edge.
    const midIdx = g.start + Math.floor(g.count / 2);
    meta[g.edgeId] = {
      edgeId: g.edgeId,
      midpoint: [
        lines[midIdx * 3],
        lines[midIdx * 3 + 1],
        lines[midIdx * 3 + 2],
      ],
      vertexStart: g.start,
      vertexCount: g.count,
    };
  }
  return meta;
};

interface SketchGhostPayload {
  id: string;
  planeOrigin: [number, number, number];
  planeNormal: [number, number, number];
  planeOutwardNormal: [number, number, number];
  planeXDir: [number, number, number];
  /** Plane preset hint used by the App when re-opening the sketch for
   *  editing — `'FACE'` means the plane was anchored to a face and the
   *  worker resolved the live geometry. */
  planePreset?: 'XY' | 'XZ' | 'YZ' | 'FACE';
  /** Live face boundary (plane-local 2D segments) when the sketch is
   *  anchored to a face. Empty / omitted otherwise. */
  referenceOutline?: number[];
  depth: number;
  faces: any;
  edges: any;
}

/**
 * Per-op outcome shipped back to the App. The sidebar uses this to badge
 * ops that the user may want to clean up after removing an upstream op:
 *   `'ok'`             — the op produced its expected effect.
 *   `'no-effect'`      — fillet/chamfer matched zero edges, or a positive-
 *                         depth sketch_extrude couldn't fuse / cut anything.
 *   `'face-missing'`   — a face-anchored sketch_extrude lost its face when
 *                         the upstream op that owned it was removed.
 *   `'invalid'`        — fillet/chamfer produced a corrupted solid (radius
 *                         too large for the geometry, self-intersecting
 *                         faces). The bad operation was reverted; the user
 *                         should reduce the radius.
 */
type OpStatus = 'ok' | 'no-effect' | 'face-missing' | 'invalid';

/**
 * Sanity check on a Solid produced by fillet/chamfer. OpenCASCADE doesn't
 * always throw on a too-large radius — it can return a body whose faces
 * self-intersect.
 *
 * The two checks we actually need:
 *
 *   1. The result has a finite, positive volume — catches NaN / zero
 *      volume from catastrophic failures.
 *   2. The result's axis-aligned bounding box doesn't grow past the
 *      input's bbox (within a small eps). A fillet only ever removes
 *      corner material, so the new envelope must fit inside the old one.
 *      A self-extending "skirt" surface caused by an over-sized radius
 *      pushes the bbox outward and gets caught here.
 *
 * Volume ratios were tried earlier and false-positived on legitimate
 * large fillets — a single fillet can remove a substantial fraction of
 * a small solid without anything being wrong.
 */
const BBOX_EPS_MM = 0.1;

const validateFilletResult = (before: any, after: any): boolean => {
  if (!after || !before) return false;
  // Volume sanity. We only require that the result has a positive finite
  // volume; we don't compare to `before` because the change is
  // geometry-dependent and any threshold has false positives.
  try {
    const vAfter = measureShapeVolumeProperties(after).volume;
    if (!Number.isFinite(vAfter) || vAfter <= 0) return false;
  } catch {
    return false;
  }
  // Bounding-box containment. After's bbox must be ≤ before's bbox in
  // every axis, with `BBOX_EPS_MM` slack for OpenCASCADE numerical noise.
  try {
    const [minB, maxB] = before.boundingBox.bounds as [
      [number, number, number],
      [number, number, number]
    ];
    const [minA, maxA] = after.boundingBox.bounds as [
      [number, number, number],
      [number, number, number]
    ];
    for (let i = 0; i < 3; i++) {
      if (minA[i] < minB[i] - BBOX_EPS_MM) return false;
      if (maxA[i] > maxB[i] + BBOX_EPS_MM) return false;
    }
  } catch {
    return false;
  }
  return true;
};

interface BuildResult {
  model: any;
  sketches: SketchGhostPayload[];
  diagnostics: Record<string, OpStatus>;
}

const drawingFromShape = (shape: any): any => {
  if (shape.type === "rect") {
    return drawRoundedRectangle(shape.width, shape.height).translate(shape.x, shape.y);
  }
  if (shape.type === "rounded-rect") {
    const r = Math.max(
      0,
      Math.min(shape.cornerRadius ?? 0, Math.min(shape.width, shape.height) / 2)
    );
    return drawRoundedRectangle(shape.width, shape.height, r).translate(
      shape.x,
      shape.y
    );
  }
  if (shape.type === "circle") {
    return drawCircle(shape.radius).translate(shape.x, shape.y);
  }
  if (
    shape.type === "polygon" &&
    Array.isArray(shape.points) &&
    shape.points.length >= 3
  ) {
    const [p0, ...rest] = shape.points;
    let pen: any = draw([p0.x, p0.y]);
    for (const p of rest) pen = pen.lineTo([p.x, p.y]);
    return pen.close();
  }
  if (
    shape.type === "compound" &&
    Array.isArray(shape.segments) &&
    shape.segments.length >= 2
  ) {
    // A compound is a closed loop of `line` / `arc` segments produced by
    // the sketcher's chain-detector. Each segment carries its endpoints
    // (and a midpoint for arcs) in walk order, so we can replay them on
    // replicad's pen API.
    const first = shape.segments[0];
    let pen: any = draw([first.p1.x, first.p1.y]);
    for (const seg of shape.segments) {
      if (seg.type === "line") {
        pen = pen.lineTo([seg.p2.x, seg.p2.y]);
      } else if (seg.type === "arc") {
        // replicad expects [endX, endY], [midX, midY] in absolute coords.
        pen = pen.threePointsArcTo(
          [seg.p2.x, seg.p2.y],
          [seg.pMid.x, seg.pMid.y]
        );
      }
    }
    return pen.close();
  }
  return null;
};

/**
 * Build the extruded shape with 3D boolean operations on individual solids,
 * applied in **declaration order**. The first additive shape seeds the
 * solid; each subsequent shape fuses or cuts depending on its operation.
 * Order matters — e.g. `rect (add) → big circle (subtract) → small circle
 * (add)` leaves an island in the middle of the hole, exactly as the user
 * arranged the layers.
 */
const buildShapes = (
  shapes: any[],
  sketchPlane: any,
  depth: number
): any => {
  let result: any = null;
  for (const shape of shapes) {
    const d = drawingFromShape(shape);
    if (!d) continue;
    let solid: any;
    try {
      solid = d.sketchOnPlane(sketchPlane).extrude(depth);
    } catch (e) {
      console.error("Sketch extrude error:", e);
      continue;
    }
    const isSubtract = shape.operation === "subtract";
    if (!result) {
      // The first shape seeds the solid. A leading subtract has nothing to
      // cut into so it's silently dropped — the user must have at least one
      // additive shape before the subtract takes effect.
      if (isSubtract) continue;
      result = solid;
      continue;
    }
    try {
      result = isSubtract ? result.cut(solid) : result.fuse(solid);
    } catch (e) {
      console.error(`Sketch ${isSubtract ? "cut" : "fuse"} error:`, e);
    }
  }
  return result;
};

// Per-op cache entry: the running model AFTER processing this op, plus the
// ghost payload it produced (for sketch_extrude ops). Lets a depth-only edit
// reuse all earlier ops' models without re-running their booleans / meshing.
interface CachedOp {
  model: any;
  sketch: SketchGhostPayload | null;
  status: OpStatus;
}

// Prefix-stable cache. On each BUILD we walk `history` and reuse cached
// entries up to the first op whose JSON differs from the previous build —
// in the common case (depth-drag on the last op) every prior op hits.
// Cleared by HMR / worker reload.
let prefixCache: { history: any[]; entries: CachedOp[] } | null = null;

const buildModel = (
  history: any[],
  _opts: { preview?: boolean } = {}
): BuildResult => {
  let model: any = null;
  const sketches: SketchGhostPayload[] = [];
  let startIdx = 0;

  // Find longest matching prefix from the previous build. Reuse the cached
  // running `model` reference (replicad solids are immutable from our side
  // once handed to fuse/cut, so the reference is safe to forward).
  if (prefixCache) {
    const cap = Math.min(prefixCache.history.length, history.length);
    for (let i = 0; i < cap; i++) {
      if (
        JSON.stringify(prefixCache.history[i]) !==
        JSON.stringify(history[i])
      ) {
        break;
      }
      model = prefixCache.entries[i].model;
      const cachedSketch = prefixCache.entries[i].sketch;
      if (cachedSketch) sketches.push(cachedSketch);
      startIdx = i + 1;
    }
  }

  const entries: CachedOp[] = prefixCache
    ? prefixCache.entries.slice(0, startIdx)
    : [];

  for (let i = startIdx; i < history.length; i++) {
    const op = history[i];
    let opSketch: SketchGhostPayload | null = null;
    let opStatus: OpStatus = 'ok';
    if (op.type === "fillet" || op.type === "chamfer") {
      // Track whether ANY edge actually changed. If none did (no model yet,
      // or every edge predicate matched zero edges), the op is a no-op.
      // If an edge produced an invalid solid (radius too large), revert
      // that edge and flag the op so the sidebar can warn the user.
      const before = model;
      let anyInvalid = false;
      if (model && Array.isArray(op.params.edgePoints)) {
        const value =
          op.type === "fillet" ? op.params.radius : op.params.distance;
        if (typeof value === "number" && value > 0) {
          for (const pt of op.params.edgePoints) {
            const previous = model;
            try {
              const next =
                op.type === "fillet"
                  ? model.fillet(value, (e: any) => e.containsPoint(pt))
                  : model.chamfer(value, (e: any) => e.containsPoint(pt));
              if (validateFilletResult(previous, next)) {
                model = next;
              } else {
                // Bad result — keep the prior model. The radius is too
                // large for the local geometry at this edge.
                anyInvalid = true;
              }
            } catch (e) {
              console.error(`${op.type} error:`, e);
              anyInvalid = true;
            }
          }
        }
      }
      if (anyInvalid) opStatus = 'invalid';
      else if (model === before) opStatus = 'no-effect';
      entries.push({ model, sketch: null, status: opStatus });
      continue;
    }

    let currentShape: any = null;

    if (op.type === "box") {
      currentShape = drawRoundedRectangle(op.params.width, op.params.height)
        .sketchOnPlane()
        .extrude(op.params.depth);
    } else if (op.type === "sketch_extrude") {
      let planeSpec = op.params.plane;
      let referenceOutline: number[] | undefined = op.params.referenceOutline;

      // Face-anchored sketches: re-resolve the plane against the current
      // model's faces so changes upstream (e.g. resizing the parent box)
      // propagate to the sketch's plane and reference outline. The stored
      // origin + outwardNormal serve as the anchor — the worker finds the
      // face whose plane still contains that anchor and uses its live
      // geometry.
      if (planeSpec?.preset === "FACE" && planeSpec.outwardNormal) {
        let matched: FaceMetaPayload | null = null;
        if (model) {
          try {
            const facesData = model.mesh({ tolerance: 0.1, angularTolerance: 30 });
            const liveMeta = computeFaceMeta(facesData);
            matched = resolveFaceAnchor(liveMeta, {
              origin: planeSpec.origin,
              outwardNormal: planeSpec.outwardNormal,
            });
          } catch (e) {
            console.error("Face anchor resolve error:", e);
          }
        }
        if (matched) {
          planeSpec = {
            ...planeSpec,
            origin: matched.origin,
            xDir: matched.xDir,
            normal: matched.normal,
            outwardNormal: matched.outwardNormal,
          };
          referenceOutline = matched.boundary ?? referenceOutline;
        } else {
          // The face the sketch was anchored to no longer exists (upstream
          // op gone or geometry changed). The stored plane is used as a
          // fallback but the user almost certainly wants to remove or
          // re-target this op.
          opStatus = 'face-missing';
        }
      }

      const sketchPlane = planeSpec
        ? new Plane(planeSpec.origin, planeSpec.xDir, planeSpec.normal)
        : undefined;
      const depth: number = op.params.depth ?? 0;

      // The plane normal sent to OpenCascade may be inverted from the face's
      // true outward direction (so xDir lands on a positive world axis). The
      // user's depth>0 should still grow the solid outward — so when the two
      // disagree, extrude in the opposite direction along the plane normal.
      const outwardN: [number, number, number] | undefined = planeSpec?.outwardNormal;
      const outwardSign =
        outwardN && planeSpec
          ? Math.sign(
              outwardN[0] * planeSpec.normal[0] +
                outwardN[1] * planeSpec.normal[1] +
                outwardN[2] * planeSpec.normal[2]
            ) || 1
          : 1;
      const extrudeDepth = depth * outwardSign;

      // Always produce a ghost mesh so the user can see where the sketch is.
      const ghost = buildShapes(op.params.shapes, sketchPlane, GHOST_THICKNESS);
      if (ghost) {
        const payload: SketchGhostPayload = {
          id: op.id,
          planeOrigin: planeSpec?.origin ?? [0, 0, 0],
          planeNormal: planeSpec?.normal ?? [0, 0, 1],
          planeXDir: planeSpec?.xDir ?? [1, 0, 0],
          planeOutwardNormal: outwardN ?? planeSpec?.normal ?? [0, 0, 1],
          planePreset: planeSpec?.preset,
          referenceOutline,
          depth,
          faces: ghost.mesh({ tolerance: 0.1, angularTolerance: 30 }),
          edges: ghost.meshEdges(),
        };
        sketches.push(payload);
        opSketch = payload;
      }

      if (Math.abs(depth) > 1e-6) {
        currentShape = buildShapes(op.params.shapes, sketchPlane, extrudeDepth);
      }
    }

    if (currentShape) {
      const isPocket =
        op.type === "sketch_extrude" && op.params.mode === "pocket";
      if (isPocket) {
        // Pockets cut from the running model. With no model yet they're a
        // no-op — the cut shape was built but had nothing to cut into.
        if (model) {
          const before = model;
          try {
            model = model.cut(currentShape);
          } catch (e) {
            console.error("Pocket cut error:", e);
          }
          if (model === before) opStatus = 'no-effect';
        } else {
          opStatus = 'no-effect';
        }
      } else if (!model) {
        model = currentShape;
      } else {
        const before = model;
        try {
          model = model.fuse(currentShape);
        } catch (e) {
          console.error("Model fuse error:", e);
        }
        if (model === before) opStatus = 'no-effect';
      }
    } else if (
      op.type === "sketch_extrude" &&
      Math.abs(op.params.depth ?? 0) > 1e-6
    ) {
      // Non-zero depth requested but `buildShapes` produced nothing —
      // probably no closed shapes in the sketch. Worth flagging.
      opStatus = 'no-effect';
    }
    entries.push({ model, sketch: opSketch, status: opStatus });
  }

  // Refresh the cache. Snapshot history (deep-clone via JSON round-trip so
  // future param mutations on the App side don't poison cached comparisons).
  prefixCache = {
    history: history.map((op) => JSON.parse(JSON.stringify(op))),
    entries,
  };

  // Build the diagnostics map (op id → status) from the entries — order
  // matches `history`, so we can pair them up.
  const diagnostics: Record<string, OpStatus> = {};
  for (let i = 0; i < history.length; i++) {
    diagnostics[history[i].id] = entries[i]?.status ?? 'ok';
  }

  return { model, sketches, diagnostics };
};

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === "INIT") {
    try {
      await init();
      self.postMessage({ type: "INITIALIZED" });
    } catch (error: any) {
      self.postMessage({ type: "INIT_ERROR", payload: error.toString() });
    }
    return;
  }

  if (type === "BUILD") {
    try {
      await init();
      const preview = !!payload.preview;
      const { model, sketches, diagnostics } = buildModel(payload.history, {
        preview,
      });

      // Preview builds: coarser tessellation + skip face/edge meta. The
      // App keeps the previous meta in state so picking still works after
      // the drag ends, and the next non-preview build refreshes them.
      const meshTol = preview ? 0.5 : 0.1;
      const faces = model
        ? model.mesh({ tolerance: meshTol, angularTolerance: 30 })
        : null;
      const edges = model ? model.meshEdges() : null;
      const faceMeta = preview || !faces ? {} : computeFaceMeta(faces);
      const edgeMeta = preview || !edges ? {} : computeEdgeMeta(edges);

      self.postMessage({
        type: "BUILD_SUCCESS",
        payload: {
          faces,
          edges,
          sketches,
          faceMeta,
          edgeMeta,
          preview,
          diagnostics,
        },
      });
    } catch (error: any) {
      console.error("Worker Build Error:", error);
      self.postMessage({ type: "BUILD_ERROR", payload: error.toString() });
    }
  }

  if (type === "EXPORT_STEP") {
    try {
      await init();
      const { model } = buildModel(payload.history);
      if (!model) {
        self.postMessage({
          type: "EXPORT_ERROR",
          payload: "Nothing to export — no extruded geometry.",
        });
        return;
      }
      const stepContent = model.exportSTEP();
      self.postMessage({ type: "EXPORT_STEP_SUCCESS", payload: stepContent });
    } catch (error: any) {
      self.postMessage({ type: "EXPORT_ERROR", payload: error.toString() });
    }
  }

  if (type === "EXPORT_3MF") {
    try {
      await init();
      const { model } = buildModel(payload.history);
      if (!model) {
        self.postMessage({
          type: "EXPORT_ERROR",
          payload: "Nothing to export — no extruded geometry.",
        });
        return;
      }
      const mesh = model.mesh({ tolerance: 0.05, angularTolerance: 15 });
      const buffer = build3MFArchive(mesh.vertices ?? [], mesh.triangles ?? []);
      (self as any).postMessage(
        { type: "EXPORT_3MF_SUCCESS", payload: buffer },
        [buffer]
      );
    } catch (error: any) {
      self.postMessage({ type: "EXPORT_ERROR", payload: error.toString() });
    }
  }

  if (type === "EXPORT_STL") {
    try {
      await init();
      const { model } = buildModel(payload.history);
      if (!model) {
        self.postMessage({
          type: "EXPORT_ERROR",
          payload: "Nothing to export — no extruded geometry.",
        });
        return;
      }
      const stlBlob: Blob = model.blobSTL({
        tolerance: 0.05,
        angularTolerance: 15,
        binary: true,
      });
      const buffer = await stlBlob.arrayBuffer();
      (self as any).postMessage(
        { type: "EXPORT_STL_SUCCESS", payload: buffer },
        [buffer]
      );
    } catch (error: any) {
      self.postMessage({ type: "EXPORT_ERROR", payload: error.toString() });
    }
  }
};

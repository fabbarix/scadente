import { setOC, drawCircle, drawRoundedRectangle, draw, Plane } from "replicad";
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
  normal: [number, number, number];
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

    const origin: [number, number, number] = [cx / count, cy / count, cz / count];
    let nLen = Math.hypot(nxSum, nySum, nzSum) || 1;
    const normal: [number, number, number] = [nxSum / nLen, nySum / nLen, nzSum / nLen];

    // Planarity check: every sampled vertex normal must be within tolerance of the average.
    let isPlanar = true;
    for (const [nx, ny, nz] of sampleNormals) {
      const len = Math.hypot(nx, ny, nz) || 1;
      const dot = (nx * normal[0] + ny * normal[1] + nz * normal[2]) / len;
      if (dot < PLANARITY_DOT) { isPlanar = false; break; }
    }

    // xDir: project world X onto plane (or world Y if X is too parallel to normal).
    let ref: [number, number, number] = [1, 0, 0];
    if (Math.abs(normal[0]) > 0.95) ref = [0, 1, 0];
    const d = ref[0] * normal[0] + ref[1] * normal[1] + ref[2] * normal[2];
    const xRaw: [number, number, number] = [
      ref[0] - d * normal[0],
      ref[1] - d * normal[1],
      ref[2] - d * normal[2],
    ];
    const xLen = Math.hypot(xRaw[0], xRaw[1], xRaw[2]) || 1;
    const xDir: [number, number, number] = [xRaw[0] / xLen, xRaw[1] / xLen, xRaw[2] / xLen];

    let boundary: number[] | undefined;
    if (isPlanar) {
      // y-axis in the plane = normal × xDir
      const yDir: [number, number, number] = [
        normal[1] * xDir[2] - normal[2] * xDir[1],
        normal[2] * xDir[0] - normal[0] * xDir[2],
        normal[0] * xDir[1] - normal[1] * xDir[0],
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
      normal,
      xDir,
      isPlanar,
      triangleStart: g.start,
      triangleCount: g.count,
      boundary,
    };
  }
  return meta;
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
    let cx = 0, cy = 0, cz = 0, count = 0;
    for (let i = g.start; i < g.start + g.count; i++) {
      cx += lines[i * 3];
      cy += lines[i * 3 + 1];
      cz += lines[i * 3 + 2];
      count++;
    }
    if (!count) continue;
    meta[g.edgeId] = {
      edgeId: g.edgeId,
      midpoint: [cx / count, cy / count, cz / count],
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
  planeXDir: [number, number, number];
  depth: number;
  faces: any;
  edges: any;
}

interface BuildResult {
  model: any;
  sketches: SketchGhostPayload[];
}

const drawingFromShape = (shape: any): any => {
  if (shape.type === "rect") {
    return drawRoundedRectangle(shape.width, shape.height).translate(shape.x, shape.y);
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
  return null;
};

/**
 * Build the extruded shape with 3D boolean operations on individual solids.
 * Each additive shape is extruded and fused into a running additive solid;
 * each subtractive shape is extruded then cut from the result. This is the
 * pattern replicad's docs recommend (e.g. `house.cut(window).fuse(door)`),
 * and unlike 2D-compound booleans it handles multiple disjoint regions
 * correctly — e.g. two pairs of concentric circles produce two tubes.
 */
const buildShapes = (
  shapes: any[],
  sketchPlane: any,
  depth: number
): any => {
  let added: any = null;
  const subtractiveSolids: any[] = [];
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
    if (shape.operation === "subtract") {
      subtractiveSolids.push(solid);
    } else if (!added) {
      added = solid;
    } else {
      try {
        added = added.fuse(solid);
      } catch (e) {
        console.error("Additive 3D fuse error:", e);
      }
    }
  }
  if (!added) return null;
  let result = added;
  for (const sub of subtractiveSolids) {
    try {
      result = result.cut(sub);
    } catch (e) {
      console.error("Subtractive 3D cut error:", e);
    }
  }
  return result;
};

const buildModel = (history: any[]): BuildResult => {
  let model: any = null;
  const sketches: SketchGhostPayload[] = [];

  for (const op of history) {
    if (op.type === "fillet" || op.type === "chamfer") {
      if (model && Array.isArray(op.params.edgePoints)) {
        const value =
          op.type === "fillet" ? op.params.radius : op.params.distance;
        if (typeof value === "number" && value > 0) {
          for (const pt of op.params.edgePoints) {
            try {
              if (op.type === "fillet") {
                model = model.fillet(value, (e: any) => e.containsPoint(pt));
              } else {
                model = model.chamfer(value, (e: any) => e.containsPoint(pt));
              }
            } catch (e) {
              console.error(`${op.type} error:`, e);
            }
          }
        }
      }
      continue;
    }

    let currentShape: any = null;

    if (op.type === "box") {
      currentShape = drawRoundedRectangle(op.params.width, op.params.height)
        .sketchOnPlane()
        .extrude(op.params.depth);
    } else if (op.type === "sketch_extrude") {
      const planeSpec = op.params.plane;
      const sketchPlane = planeSpec
        ? new Plane(planeSpec.origin, planeSpec.xDir, planeSpec.normal)
        : undefined;
      const depth: number = op.params.depth ?? 0;

      // Always produce a ghost mesh so the user can see where the sketch is.
      const ghost = buildShapes(op.params.shapes, sketchPlane, GHOST_THICKNESS);
      if (ghost) {
        sketches.push({
          id: op.id,
          planeOrigin: planeSpec?.origin ?? [0, 0, 0],
          planeNormal: planeSpec?.normal ?? [0, 0, 1],
          planeXDir: planeSpec?.xDir ?? [1, 0, 0],
          depth,
          faces: ghost.mesh({ tolerance: 0.1, angularTolerance: 30 }),
          edges: ghost.meshEdges(),
        });
      }

      if (Math.abs(depth) > 1e-6) {
        currentShape = buildShapes(op.params.shapes, sketchPlane, depth);
      }
    }

    if (currentShape) {
      const isPocket =
        op.type === "sketch_extrude" && op.params.mode === "pocket";
      if (isPocket) {
        // Pockets cut from the running model. With no model yet they're a no-op.
        if (model) {
          try {
            model = model.cut(currentShape);
          } catch (e) {
            console.error("Pocket cut error:", e);
          }
        }
      } else if (!model) {
        model = currentShape;
      } else {
        try {
          model = model.fuse(currentShape);
        } catch (e) {
          console.error("Model fuse error:", e);
        }
      }
    }
  }

  return { model, sketches };
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
      const { model, sketches } = buildModel(payload.history);

      const faces = model
        ? model.mesh({ tolerance: 0.1, angularTolerance: 30 })
        : null;
      const edges = model ? model.meshEdges() : null;
      const faceMeta = faces ? computeFaceMeta(faces) : {};
      const edgeMeta = edges ? computeEdgeMeta(edges) : {};

      self.postMessage({
        type: "BUILD_SUCCESS",
        payload: { faces, edges, sketches, faceMeta, edgeMeta },
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

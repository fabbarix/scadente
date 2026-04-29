import { useState, useEffect, useRef, useMemo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import { Layers, Box, Download, Trash2, Pencil, Move3d, Rotate3d, RefreshCw, X, Check, Save as SaveIcon, FolderOpen, Info, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Sketcher, opShapesToSketcher } from './components/Sketcher';
import type { SketcherShape } from './components/Sketcher';
import { PlanePicker } from './components/PlanePicker';
import type { PickedPlane, PlaneName } from './components/PlanePicker';
import { SketchGhost } from './components/SketchGhost';
import type { SketchData } from './components/SketchGhost';

type OperationType = 'box' | 'sketch_extrude' | 'fillet' | 'chamfer';
type Mode = 'idle' | 'pick-plane' | 'sketching';

interface Operation {
  id: string;
  type: OperationType;
  params: Record<string, any>;
}

interface FaceMeta {
  faceId: number;
  origin: [number, number, number];
  /** Plane normal sent to OpenCascade — may be flipped from the outward
   *  normal so the sketch's xDir lands on a positive world axis. */
  normal: [number, number, number];
  /** True outward normal of the face (always points away from the solid). */
  outwardNormal: [number, number, number];
  xDir: [number, number, number];
  isPlanar: boolean;
  triangleStart: number;
  triangleCount: number;
  boundary?: number[];
}

interface EdgeMeta {
  edgeId: number;
  midpoint: [number, number, number];
  vertexStart: number;
  vertexCount: number;
}

type PickHit =
  | { kind: 'edge'; meta: EdgeMeta }
  | { kind: 'face'; meta: FaceMeta };

/**
 * Resolve a click / hover against the model. Two rules:
 *
 *   1. Edges that sit behind a face are not pickable. We find the closest
 *      front-face hit and filter out any line whose `distance` is more than
 *      `OCCLUSION_TOLERANCE_MM` past it. The tolerance is needed because line
 *      hits use `Line.threshold` and may report a slightly different distance
 *      than the face the line actually lies on.
 *   2. Among the remaining (visible) line hits, the one closest to the cursor
 *      in screen space wins — that's `distanceToRay`, the perpendicular
 *      distance from the ray to the segment. This makes near-corner picks
 *      decisive: whichever edge the cursor is actually hovering over wins.
 *
 * If no visible line is hit, fall back to the closest face hit.
 */
const OCCLUSION_TOLERANCE_MM = 2;

const pickFromIntersections = (
  intersections: any[],
  meshObj: any,
  linesObj: any,
  edgeMeta: Record<number, EdgeMeta>,
  faceMeta: Record<number, FaceMeta>
): PickHit | null => {
  // Closest face along the ray — anything farther than this (plus tolerance)
  // is occluded by the model surface.
  let frontFaceDist = Infinity;
  let bestFace: any = null;
  for (const it of intersections) {
    if (it.object === meshObj && typeof it.faceIndex === 'number') {
      if (it.distance < frontFaceDist) {
        frontFaceDist = it.distance;
        bestFace = it;
      }
    }
  }

  let bestLine: any = null;
  for (const it of intersections) {
    if (it.object !== linesObj || typeof it.index !== 'number') continue;
    if (it.distance > frontFaceDist + OCCLUSION_TOLERANCE_MM) continue;
    const dr = typeof it.distanceToRay === 'number' ? it.distanceToRay : 0;
    const bestDr = bestLine
      ? typeof bestLine.distanceToRay === 'number'
        ? bestLine.distanceToRay
        : 0
      : Infinity;
    if (dr < bestDr) bestLine = it;
  }
  if (bestLine) {
    const idx = bestLine.index;
    const eMeta = Object.values(edgeMeta).find(
      (m) => idx >= m.vertexStart && idx < m.vertexStart + m.vertexCount
    );
    if (eMeta) return { kind: 'edge', meta: eMeta };
  }
  if (bestFace) {
    const tStart = bestFace.faceIndex * 3;
    const fMeta = Object.values(faceMeta).find(
      (m) => tStart >= m.triangleStart && tStart < m.triangleStart + m.triangleCount
    );
    if (fMeta) return { kind: 'face', meta: fMeta };
  }
  return null;
};

function Viewport({
  meshData,
  faceMeta,
  edgeMeta,
  onFaceSelected,
  onEdgeSelected,
  onHoverEdge,
}: {
  meshData: any;
  faceMeta: Record<number, FaceMeta>;
  edgeMeta: Record<number, EdgeMeta>;
  onFaceSelected: (face: FaceMeta | null) => void;
  onEdgeSelected: (edgeId: number, additive: boolean) => void;
  onHoverEdge: (edgeId: number | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const linesRef = useRef<THREE.LineSegments>(null);

  useEffect(() => {
    if (meshRef.current) {
      const geometry = new THREE.BufferGeometry();
      const { vertices, normals, triangles } = meshData?.faces ?? {};

      if (vertices) {
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
      }

      if (normals) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
      } else if (vertices) {
        geometry.computeVertexNormals();
      }

      if (triangles) {
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles), 1));
      }

      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      meshRef.current.geometry = geometry;
    }

    if (linesRef.current) {
      const geometry = new THREE.BufferGeometry();
      const lines = meshData?.edges?.lines;
      if (lines) {
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3));
      }
      linesRef.current.geometry = geometry;
    }
  }, [meshData]);

  return (
    <>
      <group
        onClick={(e) => {
          const hit = pickFromIntersections(e.intersections, meshRef.current, linesRef.current, edgeMeta, faceMeta);
          if (!hit) return;
          if (hit.kind === 'edge') {
            e.stopPropagation();
            onEdgeSelected(hit.meta.edgeId, e.shiftKey || e.metaKey || e.ctrlKey);
          } else {
            e.stopPropagation();
            onFaceSelected(hit.meta);
          }
        }}
        onPointerMove={(e) => {
          const hit = pickFromIntersections(e.intersections, meshRef.current, linesRef.current, edgeMeta, faceMeta);
          if (hit && hit.kind === 'edge') onHoverEdge(hit.meta.edgeId);
          else onHoverEdge(null);
        }}
        onPointerOut={() => onHoverEdge(null)}
      >
        <mesh ref={meshRef}>
          <meshStandardMaterial color="#3b82f6" side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
        </mesh>
        <lineSegments ref={linesRef}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.5} />
        </lineSegments>
      </group>
      {/* drei's Grid lies on XZ (its local Y is +world-Y) by default. Rotate
          90° around +X so the grid sits on the XY plane (Z = 0) — matching
          the Z-up CAD convention used by the plane picker labels and the
          box / sketch_extrude pipeline. */}
      <Grid
        infiniteGrid
        cellSize={1}
        sectionSize={10}
        fadeDistance={400}
        fadeStrength={1.5}
        cellColor="#334155"
        sectionColor="#3b82f6"
        rotation={[Math.PI / 2, 0, 0]}
      />
      <OrbitControls makeDefault />
    </>
  );
}

interface CameraFitTarget {
  center: [number, number, number];
  radius: number;
}

function CameraFit({
  signal,
  target,
}: {
  signal: number;
  target: CameraFitTarget | null;
}) {
  const three = useThree() as any;
  const lastSignal = useRef(-1);
  useEffect(() => {
    if (!target) return;
    if (signal === lastSignal.current) return;
    lastSignal.current = signal;
    const cam = three.camera as THREE.PerspectiveCamera;
    if (!cam) return;
    const controls = three.controls as any;
    const fovRad = (cam.fov * Math.PI) / 180;
    const radius = Math.max(1, target.radius);
    // Distance so the bounding sphere fits the vertical FOV with ~1.5× margin.
    const distance = (radius * 1.5) / Math.sin(fovRad / 2);
    const center = new THREE.Vector3(...target.center);
    let dir: THREE.Vector3;
    if (controls?.target) {
      dir = cam.position.clone().sub(controls.target);
    } else {
      dir = cam.position.clone();
    }
    if (!isFinite(dir.x) || dir.lengthSq() < 0.0001) {
      dir = new THREE.Vector3(1, 1, 1);
    }
    dir.normalize();
    cam.position.copy(center).addScaledVector(dir, distance);
    cam.near = Math.max(0.1, distance / 1000);
    cam.far = distance * 10;
    cam.updateProjectionMatrix();
    cam.lookAt(center);
    if (controls?.target) {
      controls.target.copy(center);
      controls.update?.();
    }
  }, [signal, target, three]);
  return null;
}

function computeSketchBounds(
  shapes: any[],
  plane: { origin: [number, number, number]; xDir: [number, number, number]; normal: [number, number, number] } | undefined
): CameraFitTarget | null {
  if (!shapes || shapes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    if (s.type === 'rect') {
      const hx = s.width / 2, hy = s.height / 2;
      minX = Math.min(minX, s.x - hx); maxX = Math.max(maxX, s.x + hx);
      minY = Math.min(minY, s.y - hy); maxY = Math.max(maxY, s.y + hy);
    } else if (s.type === 'circle') {
      minX = Math.min(minX, s.x - s.radius); maxX = Math.max(maxX, s.x + s.radius);
      minY = Math.min(minY, s.y - s.radius); maxY = Math.max(maxY, s.y + s.radius);
    } else if (s.type === 'polygon' && Array.isArray(s.points)) {
      for (const p of s.points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (!isFinite(minX)) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2;
  const ry = (maxY - minY) / 2;
  const radius = Math.max(2, Math.hypot(rx, ry));
  if (!plane) return { center: [cx, cy, 0], radius };
  const x = plane.xDir;
  const n = plane.normal;
  const y: [number, number, number] = [
    n[1] * x[2] - n[2] * x[1],
    n[2] * x[0] - n[0] * x[2],
    n[0] * x[1] - n[1] * x[0],
  ];
  const center: [number, number, number] = [
    plane.origin[0] + cx * x[0] + cy * y[0],
    plane.origin[1] + cx * x[1] + cy * y[1],
    plane.origin[2] + cx * x[2] + cy * y[2],
  ];
  return { center, radius };
}

function FaceHighlight({
  meshData,
  faceId,
}: {
  meshData: any;
  faceId: number | null;
}) {
  const ref = useRef<THREE.Mesh>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (faceId == null || !meshData?.faces) {
      ref.current.geometry = new THREE.BufferGeometry();
      return;
    }
    const { vertices, normals, triangles, faceGroups } = meshData.faces;
    const group = (faceGroups ?? []).find((g: any) => g.faceId === faceId);
    if (!group || !triangles || !vertices) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    if (normals) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    const idx = triangles.slice(group.start, group.start + group.count);
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    g.computeBoundingSphere();
    ref.current.geometry = g;
  }, [meshData, faceId]);

  if (faceId == null) return null;

  return (
    <mesh ref={ref} renderOrder={500}>
      <meshBasicMaterial
        color="#fbbf24"
        transparent
        opacity={0.55}
        side={THREE.DoubleSide}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

function EdgeHighlight({
  edges,
  edgeMeta,
  selectedEdgeIds,
}: {
  edges: any;
  edgeMeta: Record<number, EdgeMeta>;
  selectedEdgeIds: number[];
}) {
  const ref = useRef<THREE.LineSegments>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (!edges?.lines || selectedEdgeIds.length === 0) {
      ref.current.geometry = new THREE.BufferGeometry();
      return;
    }
    const lines: number[] = edges.lines;
    const positions: number[] = [];
    for (const id of selectedEdgeIds) {
      const meta = edgeMeta[id];
      if (!meta) continue;
      for (let i = meta.vertexStart; i < meta.vertexStart + meta.vertexCount; i++) {
        positions.push(lines[i * 3], lines[i * 3 + 1], lines[i * 3 + 2]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    g.computeBoundingSphere();
    ref.current.geometry = g;
  }, [edges, selectedEdgeIds, edgeMeta]);

  if (selectedEdgeIds.length === 0) return null;
  return (
    <lineSegments ref={ref} renderOrder={600}>
      <lineBasicMaterial color="#fbbf24" linewidth={2} depthTest={false} transparent opacity={0.95} />
    </lineSegments>
  );
}

/**
 * Hover preview: render the single edge the user would select if they
 * clicked right now. Same geometry plumbing as EdgeHighlight but a single
 * id and a less-saturated color so it visually reads as "preview".
 */
function EdgeHover({
  edges,
  edgeMeta,
  edgeId,
}: {
  edges: any;
  edgeMeta: Record<number, EdgeMeta>;
  edgeId: number;
}) {
  const ref = useRef<THREE.LineSegments>(null);
  useEffect(() => {
    if (!ref.current) return;
    const meta = edgeMeta[edgeId];
    if (!edges?.lines || !meta) {
      ref.current.geometry = new THREE.BufferGeometry();
      return;
    }
    const lines: number[] = edges.lines;
    const positions: number[] = [];
    for (let i = meta.vertexStart; i < meta.vertexStart + meta.vertexCount; i++) {
      positions.push(lines[i * 3], lines[i * 3 + 1], lines[i * 3 + 2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    g.computeBoundingSphere();
    ref.current.geometry = g;
  }, [edges, edgeMeta, edgeId]);
  return (
    <lineSegments ref={ref} renderOrder={550}>
      <lineBasicMaterial color="#7dd3fc" linewidth={2} depthTest={false} transparent opacity={0.85} />
    </lineSegments>
  );
}

function App() {
  const [history, setHistory] = useState<Operation[]>([]);
  const [meshData, setMeshData] = useState<any>(null);
  // Per-op build outcome from the worker. Lets the sidebar badge ops the
  // user may want to clean up after removing an upstream op (face anchor
  // gone, fillet/chamfer matched no edge, etc.).
  const [opDiagnostics, setOpDiagnostics] = useState<
    Record<string, 'ok' | 'no-effect' | 'face-missing' | 'invalid'>
  >({});
  const [sketches, setSketches] = useState<SketchData[]>([]);
  const [selectedSketchId, setSelectedSketchId] = useState<string | null>(null);
  const [faceMeta, setFaceMeta] = useState<Record<number, FaceMeta>>({});
  const [selectedFace, setSelectedFace] = useState<FaceMeta | null>(null);
  const [edgeMeta, setEdgeMeta] = useState<Record<number, EdgeMeta>>({});
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<number[]>([]);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<number | null>(null);
  const [filletValue, setFilletValue] = useState<number>(2);
  const [isWorkerReady, setIsWorkerReady] = useState(false);

  // Sketch flow state machine
  const [mode, setMode] = useState<Mode>('idle');
  const [selectedPlane, setSelectedPlane] = useState<PlaneName | null>(null);
  const [pickedPlane, setPickedPlane] = useState<PickedPlane | null>(null);
  const [sketchReference, setSketchReference] = useState<number[] | null>(null);
  const [editingOpId, setEditingOpId] = useState<string | null>(null);
  const [editingShapes, setEditingShapes] = useState<SketcherShape[] | null>(null);
  const [editingConstraints, setEditingConstraints] = useState<any[] | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [cameraFitTarget, setCameraFitTarget] = useState<CameraFitTarget | null>(null);
  const [cameraFitSignal, setCameraFitSignal] = useState(0);
  const [projectName, setProjectName] = useState<string>('Untitled');
  const projectNameRef = useRef(projectName);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<{ name: string; historyJSON: string }>({
    name: 'Untitled',
    historyJSON: '[]',
  });
  const isDirty = useMemo(
    () =>
      projectName !== savedSnapshot.name ||
      JSON.stringify(history) !== savedSnapshot.historyJSON,
    [projectName, history, savedSnapshot]
  );

  useEffect(() => {
    projectNameRef.current = projectName;
  }, [projectName]);

  // Warn on tab close / reload when there are unsaved changes. Setting
  // returnValue is the legacy Chrome path; preventDefault is the modern one.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  // Escape during plane picking: first press clears the selected plane (so the
  // other two planes reappear); a second press (no selection) aborts the sketch
  // flow entirely.
  useEffect(() => {
    if (mode !== 'pick-plane') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (selectedPlane) {
        e.preventDefault();
        setSelectedPlane(null);
        setPickedPlane(null);
        return;
      }
      e.preventDefault();
      cancelSketchFlow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedPlane]);

  const sanitizeName = (n: string) =>
    n.trim().replace(/[^A-Za-z0-9_\-. ]+/g, '_').replace(/\s+/g, '_') || 'untitled';

  const triggerDownload = (blob: Blob, ext: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeName(projectNameRef.current)}.${ext}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveProject = () => {
    const data = { version: 1, name: projectName, history };
    const json = JSON.stringify(data, null, 2);
    const archive = zipSync({ 'project.json': strToU8(json) }, { level: 6 });
    // Copy into a fresh ArrayBuffer so the Blob constructor doesn't choke on the
    // SharedArrayBuffer-typed view that fflate may return.
    const buf = new ArrayBuffer(archive.byteLength);
    new Uint8Array(buf).set(archive);
    triggerDownload(new Blob([buf], { type: 'application/zip' }), 'scz');
    setSavedSnapshot({ name: projectName, historyJSON: JSON.stringify(history) });
  };

  const handleLoadClick = () => fileInputRef.current?.click();

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const files = unzipSync(new Uint8Array(buf));
      const json = files['project.json'];
      if (!json) throw new Error('project.json not found in archive');
      const data = JSON.parse(strFromU8(json));
      const loaded = Array.isArray(data.history) ? data.history : [];
      const loadedName = typeof data.name === 'string' ? data.name : 'Untitled';
      setProjectName(loadedName);
      setHistory(loaded);
      setSelectedSketchId(null);
      setSelectedFace(null);
      setSavedSnapshot({ name: loadedName, historyJSON: JSON.stringify(loaded) });
      handleBuild(loaded);
    } catch (err: any) {
      console.error('Failed to load .scz:', err);
      alert('Could not open project file: ' + (err?.message ?? err));
    }
  };
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate'>('translate');
  const [resetSignal, setResetSignal] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const buildingRef = useRef(false);
  const pendingHistoryRef = useRef<{ history: Operation[]; preview: boolean } | null>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL('./worker/cad-worker.ts', import.meta.url), {
      type: 'module'
    });

    workerRef.current.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'INITIALIZED') {
        console.log('Worker Initialized');
        setIsWorkerReady(true);
        if (history.length > 0) {
          buildingRef.current = true;
          workerRef.current?.postMessage({ type: 'BUILD', payload: { history } });
        }
      } else if (type === 'BUILD_SUCCESS') {
        const isPreview = !!payload.preview;
        setMeshData({ faces: payload.faces, edges: payload.edges });
        setSketches(payload.sketches ?? []);
        // Preview builds skip face/edge meta to save time during a depth
        // drag — keep the previous meta so face/edge picking still works
        // after the drag ends without an extra build round-trip. The
        // following non-preview build refreshes them.
        if (!isPreview) {
          setFaceMeta(payload.faceMeta ?? {});
          setEdgeMeta(payload.edgeMeta ?? {});
          setOpDiagnostics(payload.diagnostics ?? {});
          // Drop the face selection if the previously selected face no longer exists.
          setSelectedFace((prev) => {
            if (!prev) return null;
            const meta = (payload.faceMeta ?? {})[prev.faceId];
            return meta ?? null;
          });
          setSelectedEdgeIds((prev) =>
            prev.filter((id) => (payload.edgeMeta ?? {})[id])
          );
        }
        buildingRef.current = false;
        if (pendingHistoryRef.current) {
          const next = pendingHistoryRef.current;
          pendingHistoryRef.current = null;
          handleBuild(next.history, { preview: next.preview });
        }
      } else if (type === 'BUILD_ERROR') {
        console.error('Build Error:', payload);
        buildingRef.current = false;
      } else if (type === 'INIT_ERROR') {
        console.error('Worker Init Error:', payload);
      } else if (type === 'EXPORT_STEP_SUCCESS') {
        triggerDownload(new Blob([payload], { type: 'text/plain' }), 'step');
      } else if (type === 'EXPORT_STL_SUCCESS') {
        triggerDownload(new Blob([payload], { type: 'application/octet-stream' }), 'stl');
      } else if (type === 'EXPORT_3MF_SUCCESS') {
        triggerDownload(
          new Blob([payload], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }),
          '3mf'
        );
      } else if (type === 'EXPORT_ERROR') {
        console.error('Export error:', payload);
      }
    };

    workerRef.current.postMessage({ type: 'INIT' });

    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const handleBuild = (
    currentHistory: Operation[],
    opts: { preview?: boolean } = {}
  ) => {
    if (!workerRef.current || !isWorkerReady) return;
    const preview = !!opts.preview;
    if (buildingRef.current) {
      // Coalesce: keep the latest pending. If a non-preview build is pending,
      // never let a preview overwrite it (we want the final crisp build to
      // reach the worker). Otherwise just store the latest history.
      const existing = pendingHistoryRef.current;
      if (existing && !existing.preview && preview) {
        existing.history = currentHistory;
      } else {
        pendingHistoryRef.current = { history: currentHistory, preview };
      }
      return;
    }
    buildingRef.current = true;
    workerRef.current.postMessage({
      type: 'BUILD',
      payload: { history: currentHistory, preview },
    });
  };

  const handleExport = (format: 'STEP' | 'STL' | '3MF') => {
    if (!workerRef.current || !isWorkerReady) return;
    const map = { STEP: 'EXPORT_STEP', STL: 'EXPORT_STL', '3MF': 'EXPORT_3MF' } as const;
    workerRef.current.postMessage({ type: map[format], payload: { history } });
  };

  const updateParam = (opId: string, param: string, value: number) => {
    const newHistory = history.map(op => {
      if (op.id === opId) {
        return { ...op, params: { ...op.params, [param]: value } };
      }
      return op;
    });
    setHistory(newHistory);
    handleBuild(newHistory);
  };

  const startNewSketch = () => {
    setSelectedPlane(null);
    setPickedPlane(null);
    setTransformMode('translate');
    setMode('pick-plane');
  };

  const continueToSketcher = () => {
    if (!pickedPlane) return;
    setMode('sketching');
  };

  const cancelSketchFlow = () => {
    setMode('idle');
    setSelectedPlane(null);
    setPickedPlane(null);
    setSketchReference(null);
    setEditingOpId(null);
    setEditingShapes(null);
    setEditingConstraints(null);
  };

  const editSketchOp = (op: Operation) => {
    if (op.type !== 'sketch_extrude') return;
    // Prefer the LIVE plane / outline resolved by the worker on the most
    // recent build. For face-anchored sketches this picks up upstream
    // edits (e.g. resized parent box) instead of using the stale snapshot
    // baked into op.params.plane.
    const live = sketches.find((s) => s.id === op.id);
    const planeSpec = op.params.plane;
    const useLive = !!live && planeSpec?.preset === 'FACE';
    if (useLive && live) {
      setPickedPlane({
        preset: 'FACE',
        origin: live.planeOrigin,
        xDir: live.planeXDir,
        normal: live.planeNormal,
        outwardNormal: live.planeOutwardNormal ?? live.planeNormal,
      });
      setSketchReference(live.referenceOutline ?? op.params.referenceOutline ?? null);
    } else if (planeSpec) {
      setPickedPlane({
        preset: planeSpec.preset ?? 'XY',
        origin: planeSpec.origin,
        xDir: planeSpec.xDir,
        normal: planeSpec.normal,
      });
      setSketchReference(op.params.referenceOutline ?? null);
    } else {
      setPickedPlane(null);
      setSketchReference(op.params.referenceOutline ?? null);
    }
    setEditingShapes(opShapesToSketcher(op.params.shapes ?? []));
    setEditingConstraints(Array.isArray(op.params.constraints) ? op.params.constraints : []);
    setEditingOpId(op.id);
    setSelectedSketchId(null);
    setSelectedFace(null);
    setMode('sketching');
  };

  const handleEdgeSelected = (edgeId: number, additive: boolean) => {
    setSelectedFace(null);
    setSelectedSketchId(null);
    setSelectedEdgeIds((prev) => {
      if (additive) {
        return prev.includes(edgeId) ? prev.filter((i) => i !== edgeId) : [...prev, edgeId];
      }
      return prev.length === 1 && prev[0] === edgeId ? [] : [edgeId];
    });
  };

  // Length of the shortest currently-selected edge — used by the EdgeHUD
  // to surface a max-radius hint. The fillet radius shouldn't exceed half
  // the shortest edge or OpenCASCADE will produce overlapping surfaces.
  // Computed by walking each selected edge's polyline samples.
  const shortestSelectedEdgeLength = useMemo<number | null>(() => {
    const lines: number[] | undefined = meshData?.edges?.lines;
    if (!lines || selectedEdgeIds.length === 0) return null;
    let best = Infinity;
    for (const id of selectedEdgeIds) {
      const meta = edgeMeta[id];
      if (!meta || meta.vertexCount < 2) continue;
      let len = 0;
      for (let i = 1; i < meta.vertexCount; i++) {
        const a = (meta.vertexStart + i - 1) * 3;
        const b = (meta.vertexStart + i) * 3;
        const dx = lines[b] - lines[a];
        const dy = lines[b + 1] - lines[a + 1];
        const dz = lines[b + 2] - lines[a + 2];
        len += Math.hypot(dx, dy, dz);
      }
      if (len > 0 && len < best) best = len;
    }
    return Number.isFinite(best) ? best : null;
  }, [selectedEdgeIds, edgeMeta, meshData]);

  const applyEdgeOp = (kind: 'fillet' | 'chamfer') => {
    if (selectedEdgeIds.length === 0 || !(filletValue > 0)) return;
    const points = selectedEdgeIds
      .map((id) => edgeMeta[id]?.midpoint)
      .filter((p): p is [number, number, number] => Array.isArray(p));
    if (!points.length) return;
    const newOp: Operation = {
      id: Math.random().toString(36).substr(2, 9),
      type: kind,
      params:
        kind === 'fillet'
          ? { radius: filletValue, edgePoints: points }
          : { distance: filletValue, edgePoints: points },
    };
    const newHistory = [...history, newOp];
    setHistory(newHistory);
    setSelectedEdgeIds([]);
    handleBuild(newHistory);
  };

  const selectEdgesOfFace = () => {
    if (!selectedFace || !selectedFace.isPlanar) return;
    // An edge belongs to the face only when *every* sampled vertex of the
    // edge lies on the face's plane. Testing only the midpoint mistakenly
    // included vertical edges of an extrusion: their start vertex sits on
    // the top plane while the end sits on the bottom, and depending on
    // sample count the "middle" sample can land near the top, slipping
    // under the eps threshold. Walking the full polyline rejects any edge
    // that leaves the plane at any point.
    const lines: number[] | undefined = meshData?.edges?.lines;
    if (!lines) return;
    const eps = 0.01;
    const nx = selectedFace.normal[0];
    const ny = selectedFace.normal[1];
    const nz = selectedFace.normal[2];
    const ox = selectedFace.origin[0];
    const oy = selectedFace.origin[1];
    const oz = selectedFace.origin[2];
    const fIds: number[] = [];
    for (const edge of Object.values(edgeMeta)) {
      let onPlane = true;
      for (let i = 0; i < edge.vertexCount; i++) {
        const idx = (edge.vertexStart + i) * 3;
        const dx = lines[idx] - ox;
        const dy = lines[idx + 1] - oy;
        const dz = lines[idx + 2] - oz;
        const d = dx * nx + dy * ny + dz * nz;
        if (Math.abs(d) > eps) {
          onPlane = false;
          break;
        }
      }
      if (onPlane) fIds.push(edge.edgeId);
    }
    setSelectedFace(null);
    setSelectedEdgeIds(fIds);
  };

  const sketchOnSelectedFace = () => {
    if (!selectedFace || !selectedFace.isPlanar) return;
    setPickedPlane({
      preset: 'FACE',
      origin: selectedFace.origin,
      xDir: selectedFace.xDir,
      normal: selectedFace.normal,
      outwardNormal: selectedFace.outwardNormal,
    });
    setSketchReference(selectedFace.boundary ?? null);
    setSelectedFace(null);
    setMode('sketching');
  };

  const addOperation = (type: OperationType) => {
    if (type === 'sketch_extrude') {
      startNewSketch();
      return;
    }

    const newOp: Operation = {
      id: Math.random().toString(36).substr(2, 9),
      type,
      params: { width: 10, height: 10, depth: 10 }
    };
    const newHistory = [...history, newOp];
    setHistory(newHistory);
    handleBuild(newHistory);
  };

  const handleSaveSketch = (shapes: any[], constraints: any[] = []) => {
    const plane = pickedPlane
      ? {
          origin: pickedPlane.origin,
          xDir: pickedPlane.xDir,
          normal: pickedPlane.normal,
          outwardNormal: pickedPlane.outwardNormal ?? pickedPlane.normal,
          preset: pickedPlane.preset,
        }
      : undefined;
    let newHistory: Operation[];
    let resultId: string;
    if (editingOpId) {
      // Update existing op — preserve its depth and plane/referenceOutline.
      newHistory = history.map((op) =>
        op.id === editingOpId
          ? { ...op, params: { ...op.params, shapes, constraints } }
          : op
      );
      resultId = editingOpId;
    } else {
      const newOp: Operation = {
        id: Math.random().toString(36).substr(2, 9),
        type: 'sketch_extrude',
        params: {
          shapes,
          constraints,
          depth: 0,
          visible: true, // visible right after sketcher closes; the first
                         // Extrude/Pocket flips this off automatically.
          plane,
          referenceOutline: sketchReference ?? undefined,
        },
      };
      newHistory = [...history, newOp];
      resultId = newOp.id;
    }
    setHistory(newHistory);
    setMode('idle');
    setSelectedPlane(null);
    setPickedPlane(null);
    setSketchReference(null);
    setEditingOpId(null);
    setEditingShapes(null);
    setEditingConstraints(null);
    setSelectedSketchId(resultId);
    // Re-frame the 3D viewport so the just-saved sketch is centered + visible
    // with margin, ready for the user's next action (extrude, pocket, etc.).
    const bounds = computeSketchBounds(shapes, plane);
    if (bounds) {
      setCameraFitTarget(bounds);
      setCameraFitSignal((s) => s + 1);
    }
    handleBuild(newHistory);
  };

  const updateSketchDepth = (opId: string, depth: number, final: boolean = true) => {
    // When the user drags the depth handle out of a fresh sketch (prev depth
    // was 0 and they haven't picked Extrude/Pocket yet), pick a sensible mode
    // automatically based on direction:
    //   • +normal → Solid extrusion
    //   • -normal AND the sketch sits on an existing face → Pocket (cut in)
    //   • -normal but not on a face → still Solid (just extruded the other way)
    // Once the op has a non-zero depth, subsequent drags just adjust depth and
    // leave the mode untouched — the user can flip via the Solid/Pocket toggle.
    const newHistory = history.map((op) => {
      if (op.id !== opId) return op;
      const prevDepth = (op.params.depth as number | undefined) ?? 0;
      const wasZero = Math.abs(prevDepth) < 1e-6;
      const params: Record<string, any> = { ...op.params, depth };
      if (wasZero && Math.abs(depth) > 1e-6) {
        const onFace = op.params.plane?.preset === 'FACE';
        params.mode = depth < 0 && onFace ? 'pocket' : 'add';
        params.visible = false;
      }
      return { ...op, params };
    });
    setHistory(newHistory);
    // Mid-drag (`final === false`): use a coarse "preview" build — the
    // worker uses a coarser tessellation tolerance and skips face/edge
    // meta. On release the SketchGhost calls us again with `final=true`,
    // triggering a full-quality build that refreshes face picking.
    handleBuild(newHistory, { preview: !final });
  };

  const startExtrudeOrPocket = (opId: string, mode: 'add' | 'pocket') => {
    // Once the sketch becomes a real extrusion / pocket, hide its ghost so it
    // doesn't overlay the resulting solid. The eye toggle in the sidebar lets
    // the user bring it back if they need to see the underlying profile.
    const newHistory = history.map((op) =>
      op.id === opId ? { ...op, params: { ...op.params, mode, depth: 10, visible: false } } : op
    );
    setHistory(newHistory);
    handleBuild(newHistory);
  };

  const toggleSketchVisibility = (opId: string) => {
    const newHistory = history.map((op) =>
      op.id === opId
        ? { ...op, params: { ...op.params, visible: !(op.params.visible === true) } }
        : op
    );
    setHistory(newHistory);
  };

  const setOpMode = (opId: string, mode: 'add' | 'pocket') => {
    const newHistory = history.map((op) =>
      op.id === opId ? { ...op, params: { ...op.params, mode } } : op
    );
    setHistory(newHistory);
    handleBuild(newHistory);
  };

  const removeOperation = (id: string) => {
    // Single-op delete. Downstream ops are NOT removed — the worker is
    // tolerant (face anchors re-resolve against the new model, fillet /
    // chamfer per-edge errors are caught) so most chains keep working.
    // Ops that genuinely depended on the removed one are flagged in the
    // sidebar via `opDiagnostics` so the user can decide what to clean up.
    const idx = history.findIndex((op) => op.id === id);
    if (idx === -1) return;
    const newHistory = history.filter((op) => op.id !== id);
    setHistory(newHistory);
    setSelectedSketchId(null);
    setSelectedFace(null);
    setSelectedEdgeIds([]);
    handleBuild(newHistory);
  };

  const fmt = (n: number) => (Math.abs(n) < 0.001 ? '0' : n.toFixed(2));

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-slate-100 font-sans text-[13px]">
      {mode === 'sketching' && (
        <Sketcher
          plane={pickedPlane ?? undefined}
          referenceOutline={sketchReference ?? undefined}
          initialShapes={editingShapes ?? undefined}
          initialConstraints={editingConstraints ?? undefined}
          onSave={handleSaveSketch}
          onCancel={cancelSketchFlow}
        />
      )}

      {/* Sidebar */}
      <div className="w-80 border-r border-slate-700 bg-slate-800 flex flex-col shadow-2xl z-10">
        <div className="p-4 border-b border-slate-700 bg-slate-800/50">
          <h1 className="text-xl font-bold flex items-center gap-2 mb-2">
            <Box size={24} className="text-blue-400" />
            Scadente
          </h1>
          <div className="relative">
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Untitled"
              className="w-full px-2 py-1 bg-slate-900/60 border border-slate-700 rounded text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500/70 focus:bg-slate-900"
              spellCheck={false}
            />
            {isDirty && (
              <span
                className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-amber-400"
                title="Unsaved changes"
              />
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!isWorkerReady && (
            <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3 text-xs text-blue-300 flex items-center gap-3 animate-pulse">
              <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
              <span>Initializing CAD Engine...</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 flex items-center gap-2">
              <Layers size={14} />
              History Tree
            </h2>
          </div>

          <div className="space-y-2">
            {history.map((op, index) => {
              // After the recent "remove only this op" change, downstream
              // ops can end up no-ops or unanchored. The worker reports
              // the per-op outcome; flag anything other than "ok" so the
              // user can decide whether to clean it up. A fresh sketch
              // with depth=0 is reported as 'ok' by the worker so we
              // don't false-positive on it.
              const status = opDiagnostics[op.id] ?? 'ok';
              const warning =
                status === 'face-missing'
                  ? "This sketch's face is gone. The op no longer has a target — remove or re-create it."
                  : status === 'no-effect'
                  ? 'This op has no effect on the current model. Likely depending on geometry that was removed upstream.'
                  : status === 'invalid'
                  ? `This ${op.type} produced invalid geometry — the radius/distance is too large for the local shape (the corner doesn't have enough material). Try reducing the value or selecting fewer edges.`
                  : null;
              return (
              <div
                key={op.id}
                className={`group rounded-lg p-3 hover:bg-slate-700/50 transition-all shadow-sm border ${
                  warning
                    ? 'bg-amber-900/15 border-amber-600/40 border-l-4 border-l-amber-500 hover:border-amber-500/60'
                    : op.type === 'sketch_extrude'
                    ? 'bg-blue-900/15 border-blue-500/30 border-l-4 border-l-blue-500/70 hover:border-blue-500/60'
                    : 'bg-slate-700/30 border-slate-700/50 hover:border-blue-500/50'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-slate-200 flex items-center gap-2">
                    <span className="w-5 h-5 bg-slate-600 rounded flex items-center justify-center text-[10px] text-slate-300">{index + 1}</span>
                    {warning && (
                      <span title={warning} className="text-amber-400">
                        <AlertTriangle size={14} />
                      </span>
                    )}
                    {op.type === 'sketch_extrude'
                      ? (op.params.depth && Math.abs(op.params.depth) > 1e-6
                          ? (op.params.mode === 'pocket'
                              ? `Pocket (${op.params.depth > 0 ? '+' : ''}${op.params.depth}mm)`
                              : `Extrusion (${op.params.depth > 0 ? '+' : ''}${op.params.depth}mm)`)
                          : 'Sketch')
                      : op.type === 'fillet'
                        ? `Fillet R${op.params.radius}mm · ${op.params.edgePoints?.length ?? 0} edges`
                        : op.type === 'chamfer'
                          ? `Chamfer ${op.params.distance}mm · ${op.params.edgePoints?.length ?? 0} edges`
                          : 'Box'}
                  </span>
                  <div className="flex items-center gap-1">
                    {op.type === 'sketch_extrude' && (
                      <button
                        onClick={() => toggleSketchVisibility(op.id)}
                        className={`p-1 rounded transition-all ${
                          op.params.visible === true
                            ? 'text-blue-300 hover:bg-blue-400/10'
                            : 'text-slate-600 hover:text-blue-300 hover:bg-blue-400/10'
                        }`}
                        title={op.params.visible === true ? 'Hide sketch' : 'Show sketch'}
                      >
                        {op.params.visible === true ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                    )}
                    {op.type === 'sketch_extrude' && (
                      <button
                        onClick={() => editSketchOp(op)}
                        className="p-1 text-slate-500 hover:text-blue-300 hover:bg-blue-400/10 rounded opacity-0 group-hover:opacity-100 transition-all"
                        title="Edit sketch"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => removeOperation(op.id)}
                      className="p-1 text-slate-600 hover:text-red-400 hover:bg-red-400/10 rounded opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  {Object.entries(op.params).map(([key, val]) => {
                    if (key === 'shapes' || key === 'plane') return null;
                    if (typeof val !== 'number') return null;
                    const isSketchDepth = op.type === 'sketch_extrude' && key === 'depth';
                    if (isSketchDepth && Math.abs(val) <= 1e-6) {
                      // depth = 0 means the op is still a sketch; offer Extrude / Pocket buttons.
                      return (
                        <div key={key} className="grid grid-cols-2 gap-1">
                          <button
                            onClick={() => startExtrudeOrPocket(op.id, 'add')}
                            className="px-2 py-1.5 bg-blue-600/80 hover:bg-blue-600 text-white text-[10px] font-bold rounded transition-colors"
                          >
                            Extrude
                          </button>
                          <button
                            onClick={() => startExtrudeOrPocket(op.id, 'pocket')}
                            className="px-2 py-1.5 bg-amber-600/80 hover:bg-amber-600 text-white text-[10px] font-bold rounded transition-colors"
                          >
                            Pocket
                          </button>
                        </div>
                      );
                    }
                    const min = isSketchDepth ? -100 : 1;
                    return (
                      <div key={key} className="space-y-1">
                        <div className="flex justify-between items-center text-[10px] text-slate-500 uppercase font-medium">
                          <span>{key}</span>
                          <input
                            type="number"
                            value={val}
                            step="1"
                            onChange={(e) =>
                              updateParam(op.id, key, parseFloat(e.target.value) || 0)
                            }
                            className="w-16 px-1.5 py-0.5 bg-slate-900/60 border border-slate-700 rounded text-slate-200 font-mono text-right text-[11px] focus:outline-none focus:border-blue-500"
                          />
                        </div>
                        <input
                          type="range"
                          min={min}
                          max="100"
                          value={val}
                          onChange={(e) => updateParam(op.id, key, parseInt(e.target.value))}
                          className="w-full h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400 transition-all"
                        />
                      </div>
                    );
                  })}
                  {op.type === 'sketch_extrude' && (
                    <div className="pt-2 border-t border-slate-700/50 text-[10px] text-slate-500 space-y-2">
                      {op.params.depth !== undefined && Math.abs(op.params.depth) > 1e-6 && (
                        <div className="flex bg-slate-700/50 rounded-md p-0.5 gap-0.5">
                          <button
                            onClick={() => setOpMode(op.id, 'add')}
                            className={`flex-1 px-2 py-1 rounded text-[10px] font-semibold transition-colors ${
                              op.params.mode !== 'pocket'
                                ? 'bg-blue-600 text-white shadow'
                                : 'text-slate-300 hover:bg-slate-600'
                            }`}
                          >
                            Solid
                          </button>
                          <button
                            onClick={() => setOpMode(op.id, 'pocket')}
                            className={`flex-1 px-2 py-1 rounded text-[10px] font-semibold transition-colors ${
                              op.params.mode === 'pocket'
                                ? 'bg-amber-600 text-white shadow'
                                : 'text-slate-300 hover:bg-slate-600'
                            }`}
                          >
                            Pocket
                          </button>
                        </div>
                      )}
                      <div className="flex items-center gap-2 italic">
                        <div className="w-1 h-1 bg-blue-500 rounded-full"></div>
                        {op.params.shapes.length} shapes in sketch
                      </div>
                      {op.params.plane && (
                        <div className="font-mono text-slate-400">
                          plane {op.params.plane.preset ?? '?'} · origin (
                          {op.params.plane.origin.map(fmt).join(', ')})
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              );
            })}
          </div>

          <button
            onClick={startNewSketch}
            className="w-full py-3 border-2 border-dashed border-slate-700 hover:border-blue-500/50 hover:bg-slate-700/30 rounded-lg flex items-center justify-center gap-2 text-slate-500 hover:text-blue-400 transition-all font-semibold"
          >
            <Pencil size={16} />
            New Sketch
          </button>
        </div>

        <div className="px-4 pt-3 pb-1 border-t border-slate-700 bg-slate-800/50 flex gap-2">
          <button
            onClick={handleSaveProject}
            className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-md flex items-center justify-center gap-2 text-xs font-semibold shadow-sm active:scale-95"
            title="Save project (.scz)"
          >
            <SaveIcon size={14} /> Save
          </button>
          <button
            onClick={handleLoadClick}
            className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 rounded-md flex items-center justify-center gap-2 text-xs font-semibold shadow-sm active:scale-95"
            title="Open project (.scz)"
          >
            <FolderOpen size={14} /> Open
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".scz,application/zip"
            onChange={handleLoadFile}
            className="hidden"
          />
        </div>
        <div className="px-4 pt-1 pb-4 bg-slate-800/50 relative">
          <button
            onClick={() => setExportMenuOpen((v) => !v)}
            disabled={!isWorkerReady}
            className="w-full py-2.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 rounded-md flex items-center justify-center gap-2 transition-all font-bold shadow-md active:scale-95"
          >
            <Download size={18} /> Export
          </button>
          {exportMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setExportMenuOpen(false)}
              />
              <div className="absolute bottom-full left-4 right-4 mb-2 z-20 bg-slate-800 border border-slate-700 rounded-md shadow-2xl overflow-hidden">
                {(
                  [
                    { fmt: 'STEP', label: 'STEP', hint: 'parametric' },
                    { fmt: 'STL', label: 'STL', hint: 'mesh · binary' },
                    { fmt: '3MF', label: '3MF', hint: 'mesh · zipped' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.fmt}
                    onClick={() => {
                      handleExport(opt.fmt);
                      setExportMenuOpen(false);
                    }}
                    className="w-full px-3 py-2 text-left hover:bg-slate-700 transition-colors flex items-center justify-between gap-3"
                  >
                    <span className="font-bold text-slate-100 text-sm">{opt.label}</span>
                    <span className="text-[10px] font-mono text-slate-500">{opt.hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main Viewport */}
      <div className="flex-1 relative bg-[#0f172a]">
        <Canvas
          camera={{ position: [30, -30, 30], up: [0, 0, 1], fov: 45 }}
          raycaster={{ params: { Line: { threshold: 1.5 }, Mesh: {}, Points: { threshold: 1 }, LOD: {}, Sprite: {} } as any }}
          onPointerMissed={() => {
            setSelectedSketchId(null);
            setSelectedFace(null);
            setSelectedEdgeIds([]);
          }}
        >
          <color attach="background" args={['#0f172a']} />
          <ambientLight intensity={0.6} />
          <pointLight position={[20, 20, 20]} intensity={1} />
          <pointLight position={[-20, -20, -20]} intensity={0.5} />
          <CameraFit signal={cameraFitSignal} target={cameraFitTarget} />
          {/* World axes: small triad at the origin (red=X, green=Y, blue=Z) so
              the user can correlate sketcher reference axes with the 3D view. */}
          <axesHelper args={[8]} renderOrder={500} />
          {/* Corner gizmo that always shows orientation regardless of pan/zoom. */}
          <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
            <GizmoViewport
              axisColors={['#ef4444', '#22c55e', '#3b82f6']}
              labelColor="#0f172a"
            />
          </GizmoHelper>
          <Viewport
            meshData={meshData}
            faceMeta={faceMeta}
            edgeMeta={edgeMeta}
            onFaceSelected={(f) => {
              setSelectedFace(f);
              setSelectedSketchId(null);
              setSelectedEdgeIds([]);
            }}
            onEdgeSelected={handleEdgeSelected}
            onHoverEdge={setHoveredEdgeId}
          />
          <FaceHighlight meshData={meshData} faceId={selectedFace?.faceId ?? null} />
          <EdgeHighlight edges={meshData?.edges} edgeMeta={edgeMeta} selectedEdgeIds={selectedEdgeIds} />
          {hoveredEdgeId != null && !selectedEdgeIds.includes(hoveredEdgeId) && (
            <EdgeHover edges={meshData?.edges} edgeMeta={edgeMeta} edgeId={hoveredEdgeId} />
          )}
          {mode === 'idle' &&
            sketches.map((s) => {
              const op = history.find((o) => o.id === s.id);
              const visible = op?.params.visible === true;
              const selected = s.id === selectedSketchId;
              // Render even when hidden as long as the user could be interacting
              // with this sketch's depth handle — unmounting mid-drag would tear
              // down the TransformControls and break the pointer capture.
              if (!visible && !selected) return null;
              return (
                <SketchGhost
                  key={s.id}
                  sketch={s}
                  visible={visible}
                  selected={selected}
                  onSelect={() => {
                    setSelectedSketchId(s.id);
                    setSelectedFace(null);
                  }}
                  onDepthCommit={(d, final) =>
                    updateSketchDepth(s.id, d, final ?? true)
                  }
                />
              );
            })}
          {mode === 'pick-plane' && (
            <PlanePicker
              selected={selectedPlane}
              onSelect={setSelectedPlane}
              transformMode={transformMode}
              onChange={setPickedPlane}
              resetSignal={resetSignal}
            />
          )}
        </Canvas>

        {/* Toolbar Overlay */}
        <div className="absolute top-6 left-6 flex gap-3">
          <div className="bg-slate-800/90 backdrop-blur-md border border-slate-700/50 rounded-lg p-1.5 flex gap-1 shadow-2xl">
            <button
              onClick={() => addOperation('box')}
              className="px-4 py-2 hover:bg-blue-600 hover:text-white rounded-md text-xs font-bold transition-all flex items-center gap-2 text-slate-300"
            >
              <Box size={14} /> Add Box
            </button>
            <div className="w-px bg-slate-700 mx-1 my-1"></div>
            <button
              onClick={startNewSketch}
              className="px-4 py-2 hover:bg-blue-600 hover:text-white rounded-md text-xs font-bold transition-all flex items-center gap-2 text-slate-300"
            >
              <Pencil size={14} /> New Sketch
            </button>
          </div>
        </div>

        {/* Selected edges HUD */}
        {mode === 'idle' && selectedEdgeIds.length > 0 && (
          <EdgeHUD
            count={selectedEdgeIds.length}
            value={filletValue}
            onValueChange={setFilletValue}
            onFillet={() => applyEdgeOp('fillet')}
            onChamfer={() => applyEdgeOp('chamfer')}
            onCancel={() => setSelectedEdgeIds([])}
            shortestEdgeLength={shortestSelectedEdgeLength}
          />
        )}

        {/* Selected face HUD */}
        {mode === 'idle' && selectedFace && (
          <FaceHUD
            face={selectedFace}
            onSketchOnFace={sketchOnSelectedFace}
            onSelectEdges={selectEdgesOfFace}
            onCancel={() => setSelectedFace(null)}
          />
        )}

        {/* Plane-pick HUD */}
        {mode === 'pick-plane' && (
          <PlanePickHUD
            selected={selectedPlane}
            picked={pickedPlane}
            transformMode={transformMode}
            onTransformMode={setTransformMode}
            onReset={() => setResetSignal((n) => n + 1)}
            onCancel={cancelSketchFlow}
            onContinue={continueToSketcher}
          />
        )}

      </div>
    </div>
  );
}

function PlanePickHUD({
  selected,
  picked,
  transformMode,
  onTransformMode,
  onReset,
  onCancel,
  onContinue,
}: {
  selected: PlaneName | null;
  picked: PickedPlane | null;
  transformMode: 'translate' | 'rotate';
  onTransformMode: (m: 'translate' | 'rotate') => void;
  onReset: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const fmt = (n: number) => (Math.abs(n) < 0.001 ? '0' : n.toFixed(2));
  return (
    <div className="absolute top-6 right-6 w-80 bg-slate-800/95 backdrop-blur-md border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
          {selected ? `Position ${selected} plane` : 'Pick a sketch plane'}
        </div>
        <button
          onClick={onCancel}
          className="p-1 text-slate-500 hover:text-slate-200 hover:bg-slate-700 rounded"
          title="Cancel"
        >
          <X size={14} />
        </button>
      </div>

      {!selected ? (
        <div className="p-4 text-xs text-slate-400 space-y-2">
          Click one of the colored planes in the viewport.
          <div className="flex flex-col gap-1 pt-2 text-[11px] font-mono">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-sm bg-blue-500" /> XY · top
            </span>
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-sm bg-green-500" /> XZ · front
            </span>
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-sm bg-red-500" /> YZ · right
            </span>
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {/* Mode toggle */}
          <div className="flex bg-slate-700/50 rounded-md p-1 gap-1">
            <button
              onClick={() => onTransformMode('translate')}
              className={`flex-1 px-3 py-1.5 rounded flex items-center justify-center gap-2 text-xs font-semibold transition-colors ${
                transformMode === 'translate' ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-600'
              }`}
            >
              <Move3d size={14} /> Translate
            </button>
            <button
              onClick={() => onTransformMode('rotate')}
              className={`flex-1 px-3 py-1.5 rounded flex items-center justify-center gap-2 text-xs font-semibold transition-colors ${
                transformMode === 'rotate' ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:bg-slate-600'
              }`}
            >
              <Rotate3d size={14} /> Rotate
            </button>
          </div>

          {/* Numeric readout */}
          <div className="space-y-2 text-[11px] font-mono">
            <div>
              <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">Origin (mm)</div>
              <div className="grid grid-cols-3 gap-1">
                <Readout label="X" value={picked ? fmt(picked.origin[0]) : '—'} />
                <Readout label="Y" value={picked ? fmt(picked.origin[1]) : '—'} />
                <Readout label="Z" value={picked ? fmt(picked.origin[2]) : '—'} />
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">Normal</div>
              <div className="grid grid-cols-3 gap-1">
                <Readout label="X" value={picked ? fmt(picked.normal[0]) : '—'} />
                <Readout label="Y" value={picked ? fmt(picked.normal[1]) : '—'} />
                <Readout label="Z" value={picked ? fmt(picked.normal[2]) : '—'} />
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">X-axis (in plane)</div>
              <div className="grid grid-cols-3 gap-1">
                <Readout label="X" value={picked ? fmt(picked.xDir[0]) : '—'} />
                <Readout label="Y" value={picked ? fmt(picked.xDir[1]) : '—'} />
                <Readout label="Z" value={picked ? fmt(picked.xDir[2]) : '—'} />
              </div>
            </div>
          </div>

          <div className="text-[10px] text-slate-500 border-t border-slate-700 pt-2 leading-relaxed">
            Snap: 1mm translate · 5° rotate. Drag the gizmo handles in the viewport.
          </div>

          <div className="flex gap-2">
            <button
              onClick={onReset}
              className="flex-1 px-3 py-2 text-xs font-semibold rounded-md bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center justify-center gap-2"
            >
              <RefreshCw size={13} /> Reset
            </button>
            <button
              onClick={onContinue}
              className="flex-1 px-3 py-2 text-xs font-bold rounded-md bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center gap-2"
            >
              <Check size={14} /> Sketch
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EdgeHUD({
  count,
  value,
  onValueChange,
  onFillet,
  onChamfer,
  onCancel,
  shortestEdgeLength,
}: {
  count: number;
  value: number;
  onValueChange: (v: number) => void;
  onFillet: () => void;
  onChamfer: () => void;
  onCancel: () => void;
  /** Length of the shortest currently-selected edge in mm. The HUD uses
   *  this to suggest a maximum safe radius; the fillet algorithm tends
   *  to fail above ~half the shortest edge. */
  shortestEdgeLength?: number | null;
}) {
  // Conservative cap. OpenCASCADE typically fails when the radius exceeds
  // the curvature limits of the local geometry; half the shortest edge is
  // a useful first-order bound. The hint is advisory — the user can still
  // try larger values; the worker will catch and revert bad results.
  const maxSuggested =
    typeof shortestEdgeLength === 'number' && shortestEdgeLength > 0
      ? shortestEdgeLength * 0.5
      : null;
  const exceedsHint =
    maxSuggested != null && value > maxSuggested;
  return (
    <div className="absolute top-6 right-6 w-72 bg-slate-800/95 backdrop-blur-md border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
          {count} edge{count > 1 ? 's' : ''} selected
        </div>
        <button
          onClick={onCancel}
          className="p-1 text-slate-500 hover:text-slate-200 hover:bg-slate-700 rounded"
          title="Deselect"
        >
          <X size={14} />
        </button>
      </div>
      <div className="p-4 space-y-3">
        <label className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
            Radius / distance (mm)
          </span>
          <input
            type="number"
            step="0.5"
            value={value}
            onChange={(e) => onValueChange(parseFloat(e.target.value) || 0)}
            className={`w-20 px-2 py-1 bg-slate-900/60 border rounded font-mono text-right text-xs focus:outline-none ${
              exceedsHint
                ? 'border-amber-500 text-amber-200 focus:border-amber-400'
                : 'border-slate-700 text-slate-200 focus:border-blue-500'
            }`}
          />
        </label>
        {maxSuggested != null && (
          <div
            className={`text-[10px] font-mono ${
              exceedsHint ? 'text-amber-400' : 'text-slate-500'
            }`}
            title="Half the shortest selected edge — beyond this OpenCASCADE often produces overlapping surfaces."
          >
            shortest edge {shortestEdgeLength!.toFixed(2)} mm · max suggested {maxSuggested.toFixed(2)} mm
            {exceedsHint && ' — value too large'}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onFillet}
            disabled={!(value > 0)}
            className="px-3 py-2 text-xs font-bold rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white"
          >
            Fillet
          </button>
          <button
            onClick={onChamfer}
            disabled={!(value > 0)}
            className="px-3 py-2 text-xs font-bold rounded-md bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 text-white"
          >
            Chamfer
          </button>
        </div>
        <div className="text-[10px] text-slate-500 leading-relaxed">
          Click an edge to select. Shift / Ctrl-click to add or remove.
        </div>
      </div>
    </div>
  );
}

function FaceHUD({
  face,
  onSketchOnFace,
  onSelectEdges,
  onCancel,
}: {
  face: FaceMeta;
  onSketchOnFace: () => void;
  onSelectEdges: () => void;
  onCancel: () => void;
}) {
  const fmt = (n: number) => (Math.abs(n) < 0.001 ? '0' : n.toFixed(2));
  return (
    <div className="absolute top-6 right-6 w-72 bg-slate-800/95 backdrop-blur-md border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-300 truncate">
          Face #{face.faceId} {face.isPlanar ? '· planar' : '· non-planar'}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative group">
            <button
              className="p-1 text-slate-500 hover:text-slate-200 hover:bg-slate-700 rounded"
              title="Show face data"
              onClick={(e) => e.preventDefault()}
            >
              <Info size={14} />
            </button>
            <div className="absolute right-0 top-full mt-1 hidden group-hover:block z-30 w-60 bg-slate-900 border border-slate-700 rounded-lg p-3 text-[11px] font-mono shadow-2xl space-y-2">
              <div>
                <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">Origin (mm)</div>
                <div className="grid grid-cols-3 gap-1">
                  <Readout label="X" value={fmt(face.origin[0])} />
                  <Readout label="Y" value={fmt(face.origin[1])} />
                  <Readout label="Z" value={fmt(face.origin[2])} />
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase font-bold tracking-wider text-slate-500 mb-1">Normal</div>
                <div className="grid grid-cols-3 gap-1">
                  <Readout label="X" value={fmt(face.normal[0])} />
                  <Readout label="Y" value={fmt(face.normal[1])} />
                  <Readout label="Z" value={fmt(face.normal[2])} />
                </div>
              </div>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1 text-slate-500 hover:text-slate-200 hover:bg-slate-700 rounded"
            title="Deselect"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="p-4 space-y-2">
        <button
          onClick={onSketchOnFace}
          disabled={!face.isPlanar}
          className="w-full py-2 text-xs font-bold rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white flex items-center justify-center gap-2"
        >
          <Pencil size={14} /> Sketch on this face
        </button>
        <button
          onClick={onSelectEdges}
          disabled={!face.isPlanar}
          className="w-full py-2 text-xs font-bold rounded-md bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 text-white flex items-center justify-center gap-2"
        >
          <Layers size={14} /> Select Edges
        </button>
        {!face.isPlanar && (
          <div className="text-[10px] text-amber-300/80 leading-relaxed">
            Sketch and edge selection are disabled because this face isn't planar.
          </div>
        )}
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/60 border border-slate-700 rounded px-2 py-1 flex items-center justify-between">
      <span className="text-slate-500 text-[10px]">{label}</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}

export default App;

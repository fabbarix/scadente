import { useEffect, useMemo, useRef, useState } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';

export interface SketchData {
  id: string;
  planeOrigin: [number, number, number];
  planeNormal: [number, number, number];
  /** True outward direction of the underlying face (when the plane was
   *  derived from one). May differ in sign from `planeNormal`. Used to keep
   *  "drag the handle outward = positive depth" consistent. */
  planeOutwardNormal?: [number, number, number];
  planeXDir: [number, number, number];
  /** The plane preset hint — `'FACE'` means the worker resolved the plane
   *  against the live model. */
  planePreset?: 'XY' | 'XZ' | 'YZ' | 'FACE';
  /** Live face boundary in plane-local mm (flat segments) when the sketch
   *  is anchored to a face. Used by the App when re-opening for editing. */
  referenceOutline?: number[];
  depth: number;
  faces: { vertices?: number[]; normals?: number[]; triangles?: number[] };
  edges: { lines?: number[] };
}

interface Props {
  sketch: SketchData;
  selected: boolean;
  visible: boolean;
  onSelect: () => void;
  /** Mid-drag depth updates (`final=false`) and the final value on release
   *  (`final=true`, rounded to whole mm). Lets the App run cheap "preview"
   *  builds during the drag and a single full build on release. */
  onDepthCommit: (depth: number, final?: boolean) => void;
}

export function SketchGhost({ sketch, visible, selected, onSelect, onDepthCommit }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const [handleObj, setHandleObj] = useState<THREE.Group | null>(null);
  const tcRef = useRef<any>(null);
  const draggingRef = useRef(false);

  // Build the world-space ghost geometry from the worker payload.
  useEffect(() => {
    if (meshRef.current) {
      const g = new THREE.BufferGeometry();
      const { vertices, normals, triangles } = sketch.faces ?? {};
      if (vertices)
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
      if (normals)
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
      else g.computeVertexNormals();
      if (triangles)
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(triangles), 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      meshRef.current.geometry = g;
    }
    if (linesRef.current && sketch.edges?.lines) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sketch.edges.lines), 3));
      linesRef.current.geometry = g;
    }
  }, [sketch]);

  // World-space anchor for the depth gizmo: bounding-box center of the
  // ghost mesh, projected onto the sketch plane. Anchoring at
  // `sketch.planeOrigin` puts the arrow at the plane origin (often the
  // face centroid or the world origin), which can sit far from the actual
  // drawn shapes — a 5×5 mm rect on a 200×200 mm face would have its
  // depth handle 100+ mm away from the visible profile. Using the ghost's
  // AABB center keeps the arrow on top of what you're extruding.
  const gizmoAnchor = useMemo<[number, number, number]>(() => {
    const verts = sketch.faces?.vertices;
    if (!verts || verts.length < 3) return sketch.planeOrigin;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < verts.length; i += 3) {
      const x = verts[i],
        y = verts[i + 1],
        z = verts[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX)) return sketch.planeOrigin;
    let cx = (minX + maxX) / 2;
    let cy = (minY + maxY) / 2;
    let cz = (minZ + maxZ) / 2;
    // Project the AABB center onto the sketch plane so the gizmo sits on
    // the plane (depth = 0) regardless of GHOST_THICKNESS sweep.
    const nx = sketch.planeNormal[0];
    const ny = sketch.planeNormal[1];
    const nz = sketch.planeNormal[2];
    const ox = sketch.planeOrigin[0];
    const oy = sketch.planeOrigin[1];
    const oz = sketch.planeOrigin[2];
    const dot = (cx - ox) * nx + (cy - oy) * ny + (cz - oz) * nz;
    cx -= dot * nx;
    cy -= dot * ny;
    cz -= dot * nz;
    return [cx, cy, cz];
  }, [sketch.faces, sketch.planeOrigin, sketch.planeNormal]);

  // Quaternion that maps local +Z → outward direction. Using `outwardNormal`
  // (rather than `planeNormal`, which can point inward for face-derived
  // planes) keeps the gizmo's blue arrow pointing the same way the user
  // would drag to grow the solid. Local +X stays along the sketch's xDir,
  // projected to the plane perpendicular to +Z.
  const planeQuat = useMemo(() => {
    const z = new THREE.Vector3(
      ...(sketch.planeOutwardNormal ?? sketch.planeNormal)
    ).normalize();
    const x = new THREE.Vector3(...sketch.planeXDir);
    x.addScaledVector(z, -x.dot(z));
    if (x.lengthSq() < 1e-9) {
      // Fallback if xDir was nearly parallel to z (degenerate case).
      x.set(1, 0, 0);
      if (Math.abs(z.x) > 0.9) x.set(0, 1, 0);
      x.addScaledVector(z, -x.dot(z));
    }
    x.normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [sketch.planeXDir, sketch.planeNormal, sketch.planeOutwardNormal]);

  // Sync handle position to current depth — but don't fight a live drag.
  useEffect(() => {
    if (!handleObj || draggingRef.current) return;
    handleObj.position.set(0, 0, sketch.depth);
  }, [handleObj, sketch.depth]);

  // Track drag state so the sync effect above doesn't snap the handle mid-drag.
  // On release, commit one final depth value rounded to the nearest mm so
  // the saved value stays clean even though the gizmo glides smoothly.
  useEffect(() => {
    if (!selected || !handleObj) return;
    const tc = tcRef.current;
    if (!tc) return;
    const onDragChanged = (event: any) => {
      const wasDragging = draggingRef.current;
      draggingRef.current = !!event.value;
      if (wasDragging && !event.value) {
        const z = handleObj.position.z;
        const snapped = Math.round(z);
        handleObj.position.z = snapped;
        onDepthCommit(snapped, true);
      }
    };
    tc.addEventListener('dragging-changed', onDragChanged);
    return () => tc.removeEventListener('dragging-changed', onDragChanged);
  }, [selected, handleObj, onDepthCommit]);

  const ghostColor = selected ? '#fbbf24' : '#3b82f6';
  const ghostOpacity = selected ? 0.4 : 0.18;
  const edgeColor = selected ? '#fde68a' : '#60a5fa';

  return (
    <>
      {visible && (
        <>
          <mesh
            ref={meshRef}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            onPointerOver={(e) => (e.object.userData.hovered = true)}
            onPointerOut={(e) => (e.object.userData.hovered = false)}
          >
            <meshBasicMaterial
              color={ghostColor}
              transparent
              opacity={ghostOpacity}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          <lineSegments ref={linesRef}>
            <lineBasicMaterial color={edgeColor} transparent opacity={0.9} />
          </lineSegments>
        </>
      )}

      {/* Selected: an empty group at planeOrigin, oriented so its local +Z points along the plane normal.
          drei's <TransformControls> will draw and drive the only handle (the blue Z arrow).
          Stays mounted while selected even when the ghost mesh is hidden so a mid-drag
          auto-hide doesn't tear down the pointer-captured TransformControls. */}
      {selected && (
        <group position={gizmoAnchor} quaternion={planeQuat}>
          <group ref={setHandleObj as any} />
        </group>
      )}

      {selected && handleObj && (
        <TransformControls
          ref={tcRef}
          object={handleObj}
          mode="translate"
          space="local"
          showX={false}
          showY={false}
          size={1.2}
          onObjectChange={() => {
            // Mid-drag: commit raw position so the gizmo glides smoothly.
            // The dragging-changed listener handles the final round-to-mm
            // on release and dispatches `final=true`.
            onDepthCommit(handleObj.position.z, false);
          }}
        />
      )}
    </>
  );
}

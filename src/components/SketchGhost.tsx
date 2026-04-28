import { useEffect, useMemo, useRef, useState } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';

export interface SketchData {
  id: string;
  planeOrigin: [number, number, number];
  planeNormal: [number, number, number];
  planeXDir: [number, number, number];
  depth: number;
  faces: { vertices?: number[]; normals?: number[]; triangles?: number[] };
  edges: { lines?: number[] };
}

interface Props {
  sketch: SketchData;
  selected: boolean;
  visible: boolean;
  onSelect: () => void;
  onDepthCommit: (depth: number) => void;
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

  // Quaternion that maps local +Z → plane normal (and local +X → plane xDir).
  const planeQuat = useMemo(() => {
    const x = new THREE.Vector3(...sketch.planeXDir).normalize();
    const z = new THREE.Vector3(...sketch.planeNormal).normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [sketch.planeXDir, sketch.planeNormal]);

  // Sync handle position to current depth — but don't fight a live drag.
  useEffect(() => {
    if (!handleObj || draggingRef.current) return;
    handleObj.position.set(0, 0, sketch.depth);
  }, [handleObj, sketch.depth]);

  // Track drag state so the sync effect above doesn't snap the handle mid-drag.
  useEffect(() => {
    if (!selected || !handleObj) return;
    const tc = tcRef.current;
    if (!tc) return;
    const onDragChanged = (event: any) => {
      draggingRef.current = !!event.value;
    };
    tc.addEventListener('dragging-changed', onDragChanged);
    return () => tc.removeEventListener('dragging-changed', onDragChanged);
  }, [selected, handleObj]);

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
        <group position={sketch.planeOrigin} quaternion={planeQuat}>
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
          translationSnap={1}
          size={1.2}
          onObjectChange={() => {
            const z = handleObj.position.z;
            onDepthCommit(Math.round(z * 100) / 100);
          }}
        />
      )}
    </>
  );
}

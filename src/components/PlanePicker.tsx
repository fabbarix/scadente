import { useRef, useState, useEffect } from 'react';
import { TransformControls } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

export type PlaneName = 'XY' | 'XZ' | 'YZ';

export interface PickedPlane {
  preset: PlaneName | 'FACE' | 'EDGE_START';
  origin: [number, number, number];
  xDir: [number, number, number];
  /** Plane normal as sent to the kernel. For face-derived planes this can
   *  point inward when needed to keep `xDir` along a positive world axis. */
  normal: [number, number, number];
  /** True outward direction (away from the solid). Optional for non-face
   *  planes; defaults to `normal` when absent. */
  outwardNormal?: [number, number, number];
}

interface Props {
  selected: PlaneName | null;
  onSelect: (name: PlaneName) => void;
  transformMode: 'translate' | 'rotate';
  onChange: (plane: PickedPlane) => void;
  resetSignal: number;
}

// Preset rotations chosen so that each plane's local +Z (which becomes the
// plane's outward normal in OpenCascade) points the way a CAD user expects:
//   XY (top):    normal = world +Z   — "top" view, looking down at the floor
//   XZ (front):  normal = world -Y   — "front" view, looking from -Y
//   YZ (right):  normal = world +X   — "right" view, looking from +X
// These pair with the canonical xDir choices in `fireChange` so that
// OpenCascade's derived yDir (= normal × xDir) ends up along world +Z (or
// world +Y for top/bottom faces) and the sketcher matches the 3D view.
const PRESET_ROT: Record<PlaneName, [number, number, number]> = {
  XY: [0, 0, 0],
  XZ: [Math.PI / 2, 0, 0],
  YZ: [0, Math.PI / 2, 0],
};

// Canonical world axis to use as the sketch's +x for each preset, before
// projection onto the (possibly rotated) plane. Top/front planes prefer +X
// as "right"; the right/left side planes prefer +Y so sketch up still maps
// to +Z (right-handed with the outward normal).
const PRESET_XAXIS: Record<PlaneName, [number, number, number]> = {
  XY: [1, 0, 0],
  XZ: [1, 0, 0],
  YZ: [0, 1, 0],
};

const COLORS: Record<PlaneName, string> = {
  XY: '#3b82f6',
  XZ: '#22c55e',
  YZ: '#ef4444',
};

const SIZE = 30;
const HALF = SIZE / 2;
const GROUND_SNAP_MM = 3;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const PLANE_LOCAL_CORNERS: THREE.Vector3[] = [
  new THREE.Vector3(-HALF, -HALF, 0),
  new THREE.Vector3(HALF, -HALF, 0),
  new THREE.Vector3(HALF, HALF, 0),
  new THREE.Vector3(-HALF, HALF, 0),
];

/**
 * If the plane's quad crosses z = 0, return the world endpoints of the line
 * where it meets the ground. Returns null otherwise (entirely above, entirely
 * below, or grazing it from one side).
 */
const computeGroundCrossing = (
  obj: THREE.Object3D
): [THREE.Vector3, THREE.Vector3] | null => {
  obj.updateWorldMatrix(true, false);
  const worldCorners = PLANE_LOCAL_CORNERS.map((c) =>
    c.clone().applyMatrix4(obj.matrixWorld)
  );
  const hits: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = worldCorners[i];
    const b = worldCorners[(i + 1) % 4];
    const sa = Math.sign(a.z);
    const sb = Math.sign(b.z);
    if (sa === 0 && sb === 0) continue;
    if (sa === sb) continue;
    const t = a.z / (a.z - b.z);
    hits.push(a.clone().lerp(b, t));
  }
  if (hits.length < 2) return null;
  // Use the two most distant intersection points (extremes of the line).
  let a = hits[0];
  let b = hits[1];
  if (hits.length > 2) {
    let bestD = a.distanceToSquared(b);
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const d = hits[i].distanceToSquared(hits[j]);
        if (d > bestD) {
          bestD = d;
          a = hits[i];
          b = hits[j];
        }
      }
    }
  }
  return [a, b];
};

/**
 * If translating brings the plane's top or bottom edge within `GROUND_SNAP_MM`
 * of the ground (z = 0), nudge the group's z so the closest parallel edge sits
 * exactly on the ground. Skipped while the plane straddles z = 0 — the user
 * presumably wants it through the ground in that case. Returns true if a snap
 * was applied so callers can re-broadcast the new origin.
 */
const snapEdgeToGround = (obj: THREE.Object3D): boolean => {
  obj.updateWorldMatrix(true, false);
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const c of PLANE_LOCAL_CORNERS) {
    const w = c.clone().applyMatrix4(obj.matrixWorld);
    if (w.z < zmin) zmin = w.z;
    if (w.z > zmax) zmax = w.z;
  }
  if (zmin > 0 && zmin < GROUND_SNAP_MM) {
    obj.position.z -= zmin;
    return true;
  }
  if (zmax < 0 && -zmax < GROUND_SNAP_MM) {
    obj.position.z -= zmax;
    return true;
  }
  return false;
};

function GroundCrossingLine({
  a,
  b,
}: {
  a: [number, number, number];
  b: [number, number, number];
}) {
  const ref = useRef<THREE.LineSegments>(null);
  useEffect(() => {
    if (!ref.current) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([...a, ...b]), 3)
    );
    ref.current.geometry = geom;
  }, [a, b]);
  return (
    <lineSegments ref={ref} renderOrder={700}>
      <lineBasicMaterial color="#fbbf24" linewidth={3} depthTest={false} transparent opacity={1} />
    </lineSegments>
  );
}

export function PlanePicker({ selected, onSelect, transformMode, onChange, resetSignal }: Props) {
  const groupRefs = useRef<Record<PlaneName, THREE.Group | null>>({ XY: null, XZ: null, YZ: null });
  const [selectedObj, setSelectedObj] = useState<THREE.Object3D | null>(null);
  const [hover, setHover] = useState<PlaneName | null>(null);
  const [groundCrossing, setGroundCrossing] = useState<{
    a: [number, number, number];
    b: [number, number, number];
  } | null>(null);

  const fireChange = (name: PlaneName, obj: THREE.Object3D) => {
    obj.updateWorldMatrix(true, false);
    const wq = obj.getWorldQuaternion(new THREE.Quaternion());
    const wPos = obj.getWorldPosition(new THREE.Vector3());

    // Plane normal is the local +Z rotated to world.
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(wq).normalize();

    // Sketch origin: the world origin projected onto the plane. For default
    // presets (planes through the world origin) this stays at (0,0,0) so the
    // sketch coordinate system anchors to the world origin. After the user
    // translates the plane, the origin tracks the closest point on the plane
    // to (0,0,0).
    const offset = normal.dot(wPos); // signed distance from world origin to plane
    const origin = new THREE.Vector3(0, 0, 0).addScaledVector(normal, offset);

    // Sketch +x: project the canonical world axis (per preset) onto the
    // plane. Falls back to a cross-product if the canonical axis is parallel
    // to the normal (defensive for user-rotated planes).
    const canonicalRaw = PRESET_XAXIS[name];
    let xDir = new THREE.Vector3(canonicalRaw[0], canonicalRaw[1], canonicalRaw[2]);
    xDir.addScaledVector(normal, -xDir.dot(normal));
    if (xDir.lengthSq() < 1e-6) {
      const fallback = Math.abs(normal.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      fallback.addScaledVector(normal, -fallback.dot(normal));
      xDir = fallback;
    }
    xDir.normalize();

    onChange({
      preset: name,
      origin: [round3(origin.x), round3(origin.y), round3(origin.z)],
      xDir: [round3(xDir.x), round3(xDir.y), round3(xDir.z)],
      normal: [round3(normal.x), round3(normal.y), round3(normal.z)],
    });

    const cross = computeGroundCrossing(obj);
    if (cross) {
      setGroundCrossing({
        a: [cross[0].x, cross[0].y, cross[0].z],
        b: [cross[1].x, cross[1].y, cross[1].z],
      });
    } else {
      setGroundCrossing(null);
    }
  };

  // Initialize each group's preset rotation imperatively so React re-renders
  // don't clobber user transforms.
  const attachRef = (name: PlaneName) => (g: THREE.Group | null) => {
    groupRefs.current[name] = g;
    if (g && !g.userData.initialized) {
      g.rotation.set(...PRESET_ROT[name]);
      g.userData.initialized = true;
    }
  };

  // When `selected` changes, latch the corresponding object for TransformControls
  // and emit an initial change so the HUD reflects current state.
  useEffect(() => {
    if (!selected) {
      setSelectedObj(null);
      setGroundCrossing(null);
      return;
    }
    const obj = groupRefs.current[selected];
    setSelectedObj(obj);
    if (obj) fireChange(selected, obj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Reset: snap selected back to its preset pose.
  useEffect(() => {
    if (!selectedObj || !selected) return;
    selectedObj.position.set(0, 0, 0);
    selectedObj.rotation.set(...PRESET_ROT[selected]);
    fireChange(selected, selectedObj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // Once a plane is picked, drop the other two from the scene entirely so the
  // user can interact with the TransformControls gizmo without accidentally
  // hitting / activating other planes' raycast targets.
  const visibleNames = (['XY', 'XZ', 'YZ'] as PlaneName[]).filter(
    (n) => selected === null || selected === n
  );

  return (
    <>
      {visibleNames.map((name) => {
        const isSel = selected === name;
        const isHov = hover === name;
        const color = COLORS[name];
        return (
          <group key={name} ref={attachRef(name)}>
            <mesh
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                onSelect(name);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                setHover(name);
              }}
              onPointerOut={() => setHover((h) => (h === name ? null : h))}
            >
              <planeGeometry args={[SIZE, SIZE]} />
              <meshBasicMaterial
                color={color}
                opacity={isSel ? 0.32 : isHov ? 0.22 : 0.1}
                transparent
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.PlaneGeometry(SIZE, SIZE)]} />
              <lineBasicMaterial color={color} transparent opacity={0.85} />
            </lineSegments>
          </group>
        );
      })}

      {groundCrossing && (
        <GroundCrossingLine a={groundCrossing.a} b={groundCrossing.b} />
      )}

      {selectedObj && selected && (
        <TransformControls
          object={selectedObj}
          mode={transformMode}
          translationSnap={1}
          rotationSnap={Math.PI / 36}
          size={0.7}
          onObjectChange={() => fireChange(selected, selectedObj)}
          onMouseUp={() => {
            // Snap on drag end. TransformControls overwrites object.position from
            // its internal _positionStart + mouse offset on every mousemove, so
            // any snap inside onObjectChange gets clobbered the next tick. Doing
            // it here, after the drag stops, makes the snap actually stick.
            if (!selectedObj || transformMode !== 'translate') return;
            if (snapEdgeToGround(selectedObj)) {
              fireChange(selected, selectedObj);
            }
          }}
        />
      )}
    </>
  );
}

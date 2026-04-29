# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server with HMR.
- `npm run build` — Type-checks (`tsc -b`) then bundles with Vite. The TS step will fail the build on any error.
- `npm run lint` — ESLint over the repo (flat config in `eslint.config.js`).
- `npm run preview` — Serves the built `dist/` for a production smoke test.

No test runner is configured.

## Architecture

Scadente is a browser-based parametric CAD app. The whole pipeline runs in the browser; there is no backend.

### Three threads, three responsibilities

1. **Main thread / UI (`src/App.tsx`)** owns the *history tree* — an array of `Operation` objects (`box` or `sketch_extrude`) that is the single source of truth for the model. Editing a parameter mutates the array and triggers a rebuild. The UI never touches the OpenCascade kernel directly.
2. **Web worker (`src/worker/cad-worker.ts`)** owns the CAD kernel. It loads `replicad` + `replicad-opencascadejs` (an Emscripten build of OpenCASCADE compiled to WASM) and exposes a small message protocol. The worker is spawned from `App.tsx` via `new Worker(new URL('./worker/cad-worker.ts', import.meta.url), { type: 'module' })`.
3. **Three.js viewport (`Viewport` component in `App.tsx`)** consumes the meshed output and renders it with `@react-three/fiber` + `drei`. Geometry is rebuilt imperatively in a `useEffect` from raw position/normal/index buffers — not via JSX props — so we avoid re-uploading buffers on unrelated re-renders.

### Sketch flow state machine

`App.tsx` runs a three-state machine for the new-sketch flow: `idle → pick-plane → sketching → idle`. "New Sketch" does **not** open the modal directly; it first switches to `pick-plane`, where `<PlanePicker>` (in `src/components/PlanePicker.tsx`) renders three colored gizmo planes (XY/XZ/YZ) inside the existing `<Canvas>` and a HUD overlay (`PlanePickHUD`) supplies translate/rotate mode toggle, numeric origin/normal/x-axis readout, reset, cancel, and continue. drei's `<TransformControls>` is attached to the selected plane group; OrbitControls is automatically suspended during gizmo drag because we set `makeDefault` on it. Translate snaps to 1 mm; rotate snaps to 5°. The picker emits `{preset, origin, xDir, normal}` in world coords, computed from the group's world quaternion applied to its local +X (xDir) and +Z (normal) — the local basis is fixed because each plane is a `planeGeometry` and the per-plane preset rotation is set imperatively *once* via a ref callback so React re-renders can't clobber user transforms. Continue forwards the plane to the Sketcher and into the resulting `sketch_extrude` op's `params.plane`.

### Worker message protocol

Main → worker: `{ type: 'INIT' | 'BUILD' | 'EXPORT_STEP' | 'EXPORT_STL' | 'EXPORT_3MF', payload }`.
Worker → main: `INITIALIZED`, `INIT_ERROR`, `BUILD_SUCCESS` (payload = `{ faces, edges, sketches, faceMeta }`), `BUILD_ERROR`, `EXPORT_STEP_SUCCESS` (payload = STEP file string), `EXPORT_STL_SUCCESS` and `EXPORT_3MF_SUCCESS` (payload = `ArrayBuffer`, transferred), `EXPORT_ERROR`.

### Project save / load

`projectName` is a state value rendered as an editable input under the sidebar header (defaults to `Untitled`). `Save` serializes `{ version: 1, name, history }` to JSON, runs it through `fflate.zipSync` as the single file `project.json`, and downloads `${sanitize(name)}.scz`. `Open` triggers a hidden `<input type="file" accept=".scz,application/zip">` that runs `unzipSync` on the chosen file, parses `project.json`, and restores `projectName + history` (validating that history is an array; bad files surface a console error + alert). `sanitizeName` collapses spaces to underscores and strips characters outside `[A-Za-z0-9_\-. ]`. The current project name is also used for export filenames — STEP, STL, 3MF all download as `${sanitize(name)}.{step,stl,3mf}`. Because the worker `onmessage` closure captures state once on mount, exports read the *current* name through `projectNameRef` (a ref kept in sync via `useEffect`).

The sidebar shows a single **Export** button that opens a small popover listing STEP / STL / 3MF (with one-line format hints). Clicking a format dispatches the matching `EXPORT_*` worker message. STEP uses replicad's `model.exportSTEP()` (string). STL uses `model.blobSTL({ binary: true, tolerance: 0.05, angularTolerance: 15 })` then `arrayBuffer()`. 3MF is hand-built (replicad has no 3MF exporter): `build3MFArchive(vertices, triangles)` meshes the model, emits `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model` (a minimal `<model unit="millimeter">` with `<vertices>`/`<triangles>`), and zips them with `fflate.zipSync`. The result is copied into a fresh `ArrayBuffer` and posted as a transferable. Main-thread wraps each export's payload in a `Blob` with the right MIME and triggers a download via an in-memory `<a download="model.{step,stl,3mf}">`.

The first `BUILD` is dispatched from the `INITIALIZED` handler — do not send `BUILD` before init completes or `setOC` will not have run.

### WASM loading (the part that breaks first)

`replicad-opencascadejs` is an Emscripten module. Its loader resolves the `.wasm` via `Module.locateFile`. In a Vite build the JS gets bundled and the relative path is wrong, so the worker imports the wasm with `?url` and passes it explicitly:

```ts
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
const ocModule = await initOpenCascade({ locateFile: () => opencascadeWasm });
```

`vite.config.ts` registers `vite-plugin-wasm` for both the main bundle *and* the worker bundle (`worker.plugins`). Both registrations are required — workers have a separate plugin pipeline. `vite-plugin-top-level-await` is in `devDependencies` but not currently wired in; add it (in both places) if you ever hit a top-level-await error from the wasm glue.

### 2D sketcher

`src/components/Sketcher.tsx` is a modal canvas built on `react-konva`. It maintains its own local `Shape[]` state and only flushes back to the history tree via `onSave`. Y is flipped at capture time (`-(pos.y - height/2)`) so coordinates handed to replicad are in CAD orientation (Y up), not screen orientation (Y down).

### Sketcher numeric editing & live dimensions

Double-clicking a line, circle, or rectangle edge in the Sketcher opens an inline DOM `<input>` overlay (positioned at the line's midpoint, the circle's east cardinal point, or the clicked rect-edge's midpoint, in screen pixels via `projectToScreen`). Enter commits, Esc cancels, blur commits. For lines, the new value is interpreted as the line's length: the second endpoint is repositioned along the existing direction so `|p2 - p1| = newLength` (first endpoint stays put). For circles, the new value sets `radius` directly. For rects, `openRectEdgeEditor` picks the nearest edge from the click (top/bottom edges → kind `'rect-width'` updates `width`; left/right edges → kind `'rect-height'` updates `height`); the top-left corner `(x, y)` stays anchored, so changing width grows or shrinks toward `+x` and changing height grows or shrinks toward `+y`. The label in the editor matches the kind: `L`, `R`, `W`, or `H`. The input's `keydown` calls `e.stopPropagation()` so Escape doesn't bubble up to the global keyboard handler and dismiss the modal. Live dimension labels are shown in the unflipped annotation layer while drawing — rect: `W × H mm`, circle: `R N mm`, line: `N mm`, polyline: length of the in-progress segment from the last placed vertex to the cursor preview.

### Sketcher pan/zoom & feature snap

The Sketcher carries a `view: { panX, panY, zoom }` state. The Konva `<Layer>` transform is `x = w/2 + panX, y = h/2 + panY, scaleX = PX_PER_MM * zoom, scaleY = -PX_PER_MM * zoom`. Wheel zoom is anchored at the cursor: pre-zoom the world point under the cursor is computed, then `panX/panY` are solved so that point keeps the same screen position post-zoom (`p - center - worldPt * PX_PER_MM * newZoom`). Pan is middle-mouse (or right-mouse fallback) drag — handled in `onMouseDown / onMouseMove / onMouseUp` with `panStartRef` + `isPanningRef`. Stroke widths, dashes and handle sizes are written as `n / screenScale` (where `screenScale = PX_PER_MM * zoom`) so they stay constant in screen pixels at any zoom; the dimension callout layer multiplies by `screenScale` and offsets by pan when projecting mm → screen px.

While drawing or dragging handles, `pointerToWorld` and `snapPoint` consult a `snapTargets` list built from the current shapes and the face `referenceOutline`: rect corners/edge midpoints/centers, circle center + 4 cardinal points, line endpoints + midpoint, every polyline vertex, polyline edge midpoints, face-boundary endpoints + segment midpoints, plus `(0,0)` origin. Within a screen-pixel snap radius (`SNAP_RADIUS_PX = 12`, converted to mm via `screenScale`) the nearest target wins; otherwise the value is rounded to the 1 mm grid. The active target is mirrored to a `snapHint` state and rendered as a yellow ring + label so the user sees what they're snapping to. The shape currently being drafted is excluded from the target list (so a new rect doesn't snap to its own starting corner). True dimensional constraints (a separate solver that re-positions geometry to maintain a fixed distance) are intentionally not implemented yet.

### Camera framing on sketch save

After `handleSaveSketch` commits a new sketch op, it computes a bounding sphere from the saved 2D shapes (rect: ±width/2, ±height/2 around its center; circle: ±radius around its center; polygon: AABB of its points), projects the 2D AABB onto the picked plane via `(plane.origin, plane.xDir, plane.normal × plane.xDir)`, and sets `cameraFitTarget = { center, radius }` along with bumping a `cameraFitSignal` counter. `<CameraFit>` lives inside the `<Canvas>` and watches the signal: on bump it keeps the current view direction (camera → controls.target), then sets `camera.position = center + dir * (radius * 1.5 / sin(fov/2))` and snaps `OrbitControls.target` to the sphere center. This re-frames the viewport so the freshly-saved sketch is centered with ~50 % margin, ready for the user's next operation. The fit only fires when the signal counter changes, so subsequent re-renders don't keep nudging the camera.

### Cascade delete

Removing an op via the trash icon drops not just that op but **every later op** in the history (`history.slice(0, idx)`). Downstream ops reference shapes / faces / edges produced by upstream ops, so we don't try to keep a partial history alive when a parent step is gone — anything depending on it would silently break or hard-error in the worker. Selection state (sketch, face, edges) is also cleared on remove.

### Face HUD (info popover + select edges)

`FaceHUD` is now action-first: just `Sketch on this face` and `Select Edges` buttons (both disabled for non-planar faces). The verbose origin/normal readout is hidden behind an `(i)` icon — hovering it reveals a small popover with the same numeric values. `Select Edges` calls `selectEdgesOfFace`: it walks `edgeMeta` and picks every edge whose midpoint lies on the face's plane (perpendicular distance `(midpoint − faceOrigin) · faceNormal` within `eps = 0.01 mm`); since each cube/extrusion edge belongs to exactly two faces, this returns exactly the bounding edges of the picked face. Selecting them clears the face selection so the EdgeHUD takes over and the user can hit `Fillet` / `Chamfer` immediately.

### Edge picking, fillet & chamfer

The worker computes `edgeMeta: { [edgeId]: { edgeId, midpoint, vertexStart, vertexCount } }` from `meshEdges()`'s `edgeGroups` and ships it on `BUILD_SUCCESS` alongside `faceMeta`. Picking is unified onto a single `onClick` handler on the `<group>` wrapping both the model `<mesh>` and the model `<lineSegments>` — splitting the handler per-object made inner edges (e.g. the rim of a pocket) unselectable, because three.js can't break ties when an edge lies exactly on a face boundary so the face's `stopPropagation` fired first. The unified handler walks `e.intersections`, picks the closest line and the closest face, and **prefers the line** when `lineDistance ≤ faceDistance + 1 mm`. For face-interior clicks (no edge within `Line.threshold = 1.5 mm`) only the face is hit, so faces still pick normally; clicks landing on a rim, corner edge, or any inner pocket edge resolve to the line. The chosen line's `intersection.index` (vertex index of the hit segment) is mapped to an `edgeId` via the `vertexStart .. vertexStart + vertexCount` window, and the edge is toggled in `selectedEdgeIds` (Shift/Ctrl/Meta-click adds to the selection; plain click replaces). `EdgeHighlight` builds a separate yellow `<lineSegments>` from the selected edges' vertex slices (with `depthTest:false` + `renderOrder:600`). When edges are selected, `EdgeHUD` shows a Radius/Distance input and `Fillet` / `Chamfer` buttons that emit a new history op with `params.edgePoints = midpoints[]` and `params.radius` (or `params.distance`). The worker's `buildModel` handles these op types by walking each `edgePoint` and applying `model.fillet(value, e => e.containsPoint(pt))` (or `model.chamfer(...)`); failures are caught per edge so one bad edge can't kill the whole build. Replicad doesn't expose edges by id at op time, so we go through `containsPoint` with the edge's centroid as the lookup — that's why `edgeMeta.midpoint` is computed and stored on the op.

### Sketch-op UX

When `op.type === 'sketch_extrude'` and `depth === 0`, the history sidebar card shows two big buttons — `Extrude` (blue) and `Pocket` (amber) — instead of the depth slider. Clicking either calls `startExtrudeOrPocket(opId, mode)`, which sets `params.mode` and bumps `params.depth` to the default `10` mm in one shot, after which the regular slider + numeric input + `Solid/Pocket` toggle take over. The depth value is now an editable `<input type="number">` next to the slider so the user can type an exact value; the slider remains for dragging. The "New Sketch & Extrude" sidebar button has been renamed to just "New Sketch" since saving no longer extrudes.

### Pocket vs solid extrusion

Each `sketch_extrude` op carries `params.mode: 'add' | 'pocket'` (default `'add'`). In `buildModel`, after the per-op `currentShape` is built (extruded with the same `buildShapes` helper used for solids), the worker checks the mode: `'add'` fuses into the running model as before, `'pocket'` calls `model.cut(currentShape)`. A pocket with no preceding model is a no-op (cuts from null are silently skipped). The sidebar history card shows a `Solid / Pocket` toggle once `|depth| > 1e-6`; flipping it calls `setOpMode(opId, mode)` which updates the op and triggers a rebuild. Sidebar label switches between `Extrusion (±Nmm)` and `Pocket (±Nmm)`. Note this mode is independent of the per-shape `operation: 'add' | 'subtract'` boolean inside the sketch profile — the latter composes the 2D sketch profile (e.g. wall = outer rect minus inner rect), the former decides what the resulting solid does to the model.

### Sketch boolean operations

Each closed sketch shape (rect, circle, closed polygon) carries `operation: 'add' | 'subtract'` (default `'add'`). The worker composes solids in 3D **in declaration order**: the first additive shape seeds the running solid, then each subsequent shape fuses or cuts depending on its operation. Order matters — `rect (add) → big circle (subtract) → small circle (add)` leaves a circular hole with a small island in the middle, because the small additive circle is fused back AFTER the cut. A leading `subtract` with no prior additive shape is silently dropped (nothing to cut from). This matches replicad's documented pattern (`house.cut(window).fuse(door)`) and — crucially — handles **multiple disjoint pairs** correctly (e.g. two sets of concentric circles produce two tubes). An earlier 2D-boolean pipeline (`Drawing.fuse` to union, then `Drawing.cut` to subtract) silently dropped pairs because compound `Drawing` objects don't always survive `cut` cleanly; doing the booleans on 3D solids avoids that. Lines and open polylines are construction-only and aren't passed to the worker. Subtractive shapes render in the Sketcher with red dashed outlines and pink fill so they're distinguishable; the properties panel exposes a `Union / Difference` toggle (`OperationToggle`) for each closed shape.

### Replicad model construction

`buildModel` in the worker walks the history sequentially: each op produces a shape, and shapes are fused into the running `model` with `model.fuse(currentShape)`. Boolean failures are caught and logged but do not abort the build — a failed fuse leaves the prior model intact. `sketch_extrude` constructs a `new Plane(origin, xDir, normal)` from `params.plane` (defaulting to XY at the origin) and translates each shape *in 2D plane-local coordinates* via `Drawing.translate(x, y)` **before** `sketchOnPlane(plane).extrude(depth)`. Doing the translate in 2D — rather than the old `.translate([x,y,0])` after extrude — is what makes sketches correctly orient when the plane is tilted or offset. Open lines and open polylines are filtered at save time (they're construction-only inside the sketcher); only `rect`, `circle`, and closed `polygon` reach the worker. There is no support yet for cuts, fillets, or per-op 3D transforms.

### Editing existing sketches

Each sketch op in the history sidebar shows a pencil-icon Edit button (next to Trash). Clicking it routes through `editSketchOp(op)` in `App.tsx`: the op's `plane` is loaded back into `pickedPlane`, its `referenceOutline` (if any) into `sketchReference`, and its saved `shapes` are converted back to the Sketcher's internal format via `opShapesToSketcher` (saved rects use center-based coords; internal rects use top-left, so the converter re-offsets) and stashed in `editingShapes`. The Sketcher receives them via `initialShapes`. On save, if `editingOpId` is set, `handleSaveSketch` patches the existing op's `shapes` in place and preserves its `depth`, `plane`, and `referenceOutline`; otherwise it appends a new op as before. Open lines and open polylines that were construction-only at save time are not round-tripped — they aren't stored on the op. The Sketcher's button label is `Save sketch` (it no longer auto-extrudes; depth still defaults to 0 for new sketches and is preserved when editing).

### Sketch visibility & sidebar accent

Each `sketch_extrude` op carries `params.visible: boolean` (default `false` — saved sketches hide their ghost from the 3D view by default). The history sidebar adds a small **eye / eye-off** icon next to the Edit button that calls `toggleSketchVisibility(opId)` to flip the flag; only ghosts whose op has `visible === true` get a `<SketchGhost>` rendered. Sketch-bearing ops are visually distinguished in the sidebar with a tinted blue background and a thicker blue left border, so you can tell at a glance which ops carry an editable sketch (sketch_extrude) vs operations that don't (fillet, chamfer, box). The `Edit` and `Trash` icons stay on hover, but the eye icon is always visible so the user can flip ghost visibility without hovering.

### Sketch ghosts & depth handle

Saving a sketch defaults `depth = 0`; extrusion is opt-in and bidirectional (negative depth extrudes in `-normal`). For every `sketch_extrude` op, the worker always emits a "ghost" — the same fused profile lightly extruded by `GHOST_THICKNESS` (0.001 mm) — into a separate `sketches: [{id, planeOrigin, planeNormal, planeXDir, depth, faces, edges}]` array on the `BUILD_SUCCESS` payload, alongside the solid `model` (built only when `Math.abs(depth) > 1e-6`). `App.tsx` renders each ghost via `<SketchGhost>` (`src/components/SketchGhost.tsx`) as a translucent mesh + outline; clicking selects it (`onPointerMissed` on `<Canvas>` deselects), and the selected ghost gets a one-axis `<TransformControls mode="translate" space="local" showX={false} showY={false}>` constrained to the plane normal — that's the only handle (no decorative knob; the gizmo's blue Z arrow is the drag target). The wrapping group at `planeOrigin` carries a quaternion built from `(planeXDir, planeNormal × planeXDir, planeNormal)` so the gizmo's local `+Z` is always along the plane normal. The knob group's `position.z` *is* the depth (no rest offset, no clamp), and depth is committed live on every TC `onObjectChange` — there's no drag-end batching. The reference to the knob group is held in `useState` (not `useRef`) so the conditional `<TransformControls>` re-renders once the group has actually mounted. A `draggingRef` (set on `dragging-changed`) gates the position-sync `useEffect` so worker-driven depth updates don't snap the handle out from under a live drag.

Live updates need build coalescing because TC fires `onObjectChange` on every mouse move. `App.tsx` keeps `buildingRef` and `pendingHistoryRef`; if a build is requested while one is in flight, only the latest pending history survives and is posted when the current build completes. There is intentionally no spinner overlay during builds.

### Face picking

The worker's `mesh()` output already groups triangles by topological face (`faceGroups: [{start, count, faceId}]`). The worker post-processes this into `faceMeta: { [faceId]: { origin, normal, xDir, isPlanar, triangleStart, triangleCount, boundary? } }` (`computeFaceMeta` in `cad-worker.ts`): origin = vertex centroid within the group, normal = normalized average vertex normal, isPlanar = every sampled vertex normal is within `~2.5°` of the average (`PLANARITY_DOT = 0.999`), xDir = world-X projected onto the plane (or world-Y when X is too parallel to the normal). The model `<mesh>` in `Viewport` has `onClick` that maps `e.faceIndex * 3 → triangleStart range → faceId → meta` and calls `onFaceSelected`. `<FaceHighlight>` builds an overlay BufferGeometry from the selected face's index slice and renders it with `polygonOffset` + `depthWrite: false` so it sits on top without z-fighting the underlying solid. The `<FaceHUD>` shows origin/normal and a "Sketch on this face" button that goes straight into the sketcher (skipping the plane picker) with `pickedPlane = { preset: 'FACE', origin, xDir, normal }`. `PickedPlane.preset` is widened to `PlaneName | 'FACE'`. Tilted/rotated faces work because `xDir` and `normal` come straight from the meshed geometry — the worker constructs `new Plane(origin, xDir, normal)` regardless of orientation.

For planar faces the worker also extracts a `boundary` array — the face's outline as plane-local 2D segments (flat `x1,y1,x2,y2,...`). It walks the triangulation inside the face group and keeps only edges used by exactly one triangle (boundary edges of the polygon), then projects each endpoint into plane-local 2D using `(p - origin) · xDir` and `(p - origin) · (normal × xDir)`. App passes that array as `referenceOutline` to the Sketcher, which renders it as yellow read-only `KLine` segments behind the editable shapes. Because the projection origin is the face centroid, the outline is centered at the sketcher's `(0, 0)` regardless of where the face lives in world space.

## Conventions worth knowing

- `src/types.d.ts` declares `replicad`, `replicad-opencascadejs`, and `opencascade.js` as untyped modules. Anything kernel-side is `any` on purpose; do not try to type it from upstream `.d.ts` files (they exist but are incomplete and will fight you).
- Tailwind v4 is wired through `@tailwindcss/vite`, not PostCSS — there is no `tailwind.config.js`. Customisations go in `src/index.css` via `@theme`.
- The `dist/` directory is checked in. Don't hand-edit it; it's a build artifact.

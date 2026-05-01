# Scadente

A browser-based parametric CAD app. Sketches in 2D, extrudes / pockets / sweeps
into 3D, runs entirely in the browser via [replicad](https://replicad.xyz/) and
the OpenCASCADE WASM kernel — no backend.

**Live: <http://scadente.orksu.com/>**

## Features

- 2D sketcher (rect / rounded-rect / circle / arc / line / polyline) with
  snapping, dimensions, and a constraint solver (horizontal, vertical,
  coincident, distance, length, angle, tangent, …).
- 3D operations: sketch + extrude / pocket, fillet, chamfer, sweep along an
  edge.
- History tree — every op is editable; downstream ops re-resolve face / edge
  anchors against the live model.
- Save / load `.scz` projects, export to STEP / STL / 3MF.

## Develop

```sh
npm install
npm run dev      # http://localhost:5173
npm run build
npm run lint
```

## Deploy

A push to `main` runs `.github/workflows/deploy.yml`, which builds the Vite
bundle and publishes it to GitHub Pages. The custom domain is set via
`public/CNAME`; the workflow expects "Source: GitHub Actions" under the repo's
Settings → Pages.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

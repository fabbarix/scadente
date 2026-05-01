import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from "vite-plugin-wasm";

// GitHub Pages serves project sites at https://<owner>.github.io/<repo>/,
// so all asset URLs need to be prefixed with /<repo>/. The CI workflow sets
// `BASE_PATH` from `${{ github.event.repository.name }}`; locally and in
// `npm run dev` the value is empty and we fall back to '/' so absolute asset
// paths still resolve at the dev server's root.
const basePath = process.env.BASE_PATH
  ? `/${process.env.BASE_PATH.replace(/^\/+|\/+$/g, '')}/`
  : '/'

// https://vite.dev/config/
export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
  ],
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
    ]
  }
})

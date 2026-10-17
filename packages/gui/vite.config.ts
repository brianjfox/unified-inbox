import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The GUI is served by the relay at the same origin (FR-24), from `dist/`.
 * Assets keep Vite's hashed names because the relay marks `/assets/*`
 * immutable. The SQLite WebAssembly module stays out of dependency
 * pre-bundling so its worker and wasm files resolve by `import.meta.url`.
 */
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});

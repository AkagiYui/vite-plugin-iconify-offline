import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: ["es2021", "node18"],
  dts: true,
  clean: true,
  shims: true,
  sourcemap: true,
  deps: {
    neverBundle: ["vite"],
  },
})

import { defineConfig } from "tsup";

export default defineConfig({
  entry: { console: "src/index.ts" },
  format: ["iife"],
  target: "es2022",
  platform: "browser",
  outDir: "dist",
  clean: true,
  minify: false,
  sourcemap: false,
  splitting: false,
  dts: false,
  outExtension() {
    return { js: ".js" };
  },
});

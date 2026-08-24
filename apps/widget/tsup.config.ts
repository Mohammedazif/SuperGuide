import { defineConfig } from "tsup";

export default defineConfig({
  entry: { widget: "src/index.ts" },
  format: ["iife"],
  target: "es2022",
  platform: "browser",
  outDir: "dist",
  clean: true,
  minify: true,
  sourcemap: false,
  treeshake: true,
  splitting: false,
  dts: false,
  outExtension() {
    return { js: ".js" };
  },
});

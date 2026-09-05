import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { rendererPlugins } from "./vite.renderer.config";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    plugins: rendererPlugins,
  },
});

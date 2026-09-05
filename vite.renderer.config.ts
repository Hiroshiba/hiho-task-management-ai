import { resolve } from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";

export const rendererPlugins = [vue(), tailwindcss()];

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: rendererPlugins,
});

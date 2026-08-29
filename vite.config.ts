import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { copyPowFiles } from "./vite-pow-plugin.js";

export default defineConfig({
  base: "./",
  plugins: [
    copyPowFiles(),
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "util"],
      globals: { Buffer: true, global: true, process: true }
    })
  ],
  optimizeDeps: {
    esbuildOptions: { define: { global: "globalThis" } },
    exclude: ["znn-typescript-sdk"]
  },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    coverage: {
      reporter: ["text", "html"]
    }
  }
});

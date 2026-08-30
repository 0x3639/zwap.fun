import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        howItWorks: new URL("./how-it-works.html", import.meta.url).pathname
      }
    }
  },
  plugins: [
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "util"],
      globals: { Buffer: true, global: true, process: true }
    })
  ],
  optimizeDeps: {
    esbuildOptions: { define: { global: "globalThis" } },
    exclude: ["znn-typescript-sdk"]
  },
  test: {
    environment: "jsdom",
    coverage: {
      reporter: ["text", "html"]
    }
  }
});

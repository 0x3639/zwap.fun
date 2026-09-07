import { defineConfig } from "vitest/config";

import { cspPlugin } from "./deploy/csp-plugin.js";

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
    cspPlugin(),
  ],
  test: {
    environment: "jsdom",
    coverage: {
      reporter: ["text", "html"]
    }
  }
});

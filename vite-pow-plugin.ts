import { copyFileSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const POW_FILES = ["pow.js", "pow.wasm"] as const;
const powSrcDir = resolve(process.cwd(), "node_modules/znn-typescript-sdk/dist/browser");

export function copyPowFiles(): Plugin {
  return {
    name: "zwap-copy-pow-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0]?.slice(1);
        if (name && (POW_FILES as readonly string[]).includes(name)) {
          res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "application/javascript");
          createReadStream(resolve(powSrcDir, name)).pipe(res);
          return;
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? resolve(process.cwd(), "dist");
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      for (const name of POW_FILES) copyFileSync(resolve(powSrcDir, name), resolve(outDir, name));
    }
  };
}

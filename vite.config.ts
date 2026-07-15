import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {version: string};

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    hmr: {port: 4100},
  },
});

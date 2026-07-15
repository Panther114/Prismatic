/**
 * Packaged / desktop entry: load TypeScript server under Electron's Node.
 * PRISMATIC_APP_ROOT (set by main) points at app.asar so `dist/` static files resolve.
 */
import {register} from "tsx/esm/api";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

register();

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "server", "index.ts");
await import(pathToFileURL(serverEntry).href);

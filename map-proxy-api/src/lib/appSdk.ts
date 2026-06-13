import { readFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Loads the official `@modelcontextprotocol/ext-apps` browser bundle and
 * rewrites its trailing ESM `export { … as App }` into a global `window.App`,
 * so it can be inlined in a **classic** `<script>` inside Cowork's widget
 * sandbox (which runs `allow-scripts` WITHOUT `allow-same-origin`, so ESM
 * `import`/module scripts fail silently). This is the exact technique the
 * draw.io MCP app server uses (`processAppBundle`) to make its widget's
 * SEP-1865 handshake byte-compatible with the host's `AppBridge` — which is why
 * its inline widget renders in Microsoft 365 Copilot / Cowork.
 *
 * Hand-rolling the JSON-RPC handshake does NOT work: the host validates the
 * `ui/initialize` exchange against the SDK's exact wire format and silently
 * drops mismatches, leaving the widget to time out ("didn't respond in time").
 */
let cached: string | null = null;

export function getAppSdkScript(): string {
  if (cached) return cached;
  // Resolve the package's main entry (its `.` export → dist/src/app.js), then
  // read the sibling `app-with-deps.js` browser bundle. Resolving the main
  // entry avoids exports-map issues (the package doesn't expose package.json).
  const mainEntry = require.resolve("@modelcontextprotocol/ext-apps");
  const bundlePath = join(dirname(mainEntry), "app-with-deps.js");
  let src = readFileSync(bundlePath, "utf8");

  // Capture the minified local name bound to `App` in the export list
  // (e.g. `eI as App`) BEFORE stripping the export statement.
  const m = src.match(/([A-Za-z0-9_$]+)\s+as\s+App\b/);
  const local = m ? m[1] : null;

  // Remove all ESM `export { … };` statements (export lists are flat — no
  // nested braces — so this is safe). Internal references use local names.
  src = src.replace(/export\s*\{[^}]*\}\s*;?/g, ";");

  if (local) {
    src += `\ntry{window.App=${local};}catch(e){}`;
  }
  cached = src;
  return cached;
}

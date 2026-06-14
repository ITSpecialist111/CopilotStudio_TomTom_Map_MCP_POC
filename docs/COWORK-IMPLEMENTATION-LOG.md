# Cowork Plugin — Implementation Log

> Running record of what was changed, why, and the evidence collected. Pairs with
> [COWORK-PLUGIN-PLAN.md](COWORK-PLUGIN-PLAN.md) (the backbone). Newest entries at the bottom.

---

## Entry 1 — Research & plan (2026-06-12)

- Reviewed the existing POC (deploy scripts, `map-proxy-api`, `interactive-map-app`,
  `power-platform`, `graph-connector`, `tests`).
- Studied the two **official** TomTom MCP repos:
  [`tomtom-maps-mcp`](https://github.com/tomtom-international/tomtom-maps-mcp) (hosted at
  `https://mcp.tomtom.com/maps`, header `tomtom-api-key`, Maps/Orbis backends) and
  [`tomtom-traffic-analytics-mcp`](https://github.com/tomtom-international/tomtom-traffic-analytics-mcp)
  (MOVE analytics, self-host, `sql_queries`).
- Studied the **Cowork plugin** docs: package = `manifest.json` (v1.28) + icons + `skills/*/SKILL.md`;
  `agentConnectors[]` for remote MCP; connector auth limited to `None` / `OAuthPluginVault` /
  `ApiKeyPluginVault`; upload via Admin Center → Manage Apps → Upload custom app; Frontier required.
- **Key decision (D1):** TomTom's custom `tomtom-api-key` header can't be expressed via Cowork's
  MCP connector auth, so we insert a **gateway** (auth `None`) that injects the key server-side.
- Authored [COWORK-PLUGIN-PLAN.md](COWORK-PLUGIN-PLAN.md).

## Entry 2 — Live infrastructure discovery (2026-06-12)

Discovered the real, already-deployed infra in **`rg-tomtom-mcp`** (ABS tenant):

| Component | Resource | URL |
|-----------|----------|-----|
| MCP server | Container App `ca-tomtom-mcp` | `https://ca-tomtom-mcp.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io` |
| Map proxy (gateway host) | **Container App** `ca-tomtom-map-proxy` (Express) | `https://ca-tomtom-map-proxy.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io` |
| Interactive map | Static Web App `swa-tomtom-map` | `https://thankful-sky-03359db03.2.azurestaticapps.net` |

- The proxy is a **Container App running Express** (`server.ts`), not a Function App ⇒ the gateway
  is a new Express route on that app.
- Live `tools/list` = **Orbis backend, 17 tools**, all already annotated `readOnlyHint: true`.
- Captured the full `tomtom-dynamic-map` schema (center/bbox, zoom, width/height, markers, routes,
  **routePlans** with per-plan `traffic`, polygons, showLabels, detail, show_ui).
- **Security finding:** upstream exposes `tomtom-get-api-key` (returns the raw key) ⇒ the gateway
  **filters it from discovery and blocks calls**.

## Entry 3 — MCP gateway built & smoke-tested (2026-06-12)

**Changed files (`map-proxy-api/`):**
- `src/lib/mcpClient.ts` — added `callMcpRpc()` (generic JSON-RPC) and `parseJsonRpcEnvelope()`
  (shared SSE/JSON parser); exported `JsonRpcResponse`. Existing `callMcpTool` untouched in behaviour.
- `src/lib/mcpGateway.ts` — **new.** Dispatches `initialize`, `tools/list`, `tools/call`, `ping`,
  notifications. Filters `tomtom-get-api-key`, guarantees `readOnlyHint`, appends synthetic
  **`render_live_map`** tool, and rewrites map-image results into hosted image URL + live link.
- `src/functions/mcpGateway.ts` — **new.** Express handler `POST /api/mcp` (+ `GET` probe);
  resolves config from env + forwarded headers; JSON-RPC batch + notification (202) handling.
- `src/server.ts` — registered `POST /api/mcp` and `GET /api/mcp`; expanded startup logging.

**Build:** `npm install` + `npm run build` → **exit 0, no TypeScript errors.**

**Live smoke test** (local server on `:3071`, wired to the real upstream MCP server):

| Check | Result |
|-------|--------|
| `GET /health` | `{"status":"ok"}` |
| `initialize` | `serverInfo = tomtom-cowork-gateway 1.0.0` ✓ |
| `tools/list` | 17 tools; **`render_live_map` present**; **`tomtom-get-api-key` filtered out** ✓ |
| `render_live_map` annotations | `readOnlyHint: true` (auto-runs, no confirmation) ✓ |
| `tomtom-geocode` (Cardiff Castle) | proxied OK (⚠ ambiguous → returned a US match; skills add city/country) |
| `render_live_map` (markers) | image URL + interactive link; **image fetch → 200, image/jpeg, 133 KB** ✓ |
| `render_live_map` (route Cardiff→London, traffic) | built `routePlans` + `traffic:true`; **image → 200, image/png, 406 KB** ✓ |
| direct `tomtom-dynamic-map` | base64 image **stripped**, replaced by hosted markdown image URL (no `image` block) ✓ |

**Conclusion:** the gateway correctly proxies the official TomTom MCP, renders dynamic maps as
inline images, and emits live interactive map links — all with the API key kept server-side.

> Next: author the 6 correlated skills, the M365 v1.28 manifest + icons + packager, deployment
> guide, and the plugin test script; then (with approval) redeploy the proxy and sideload in the
> ABS tenant.

## Entry 4 — Plugin package, skills, tooling & docs (2026-06-12)

**New `cowork-plugin/` package:**
- `manifest.json` — M365 **v1.28**, GUID id, accent `#E2231A`, **6 `agentSkills`**, **1
  `agentConnector`** (`remoteMcpServer` → the gateway `/api/mcp`, auth **`None`**).
- 6 skills (each `name` == folder, kebab-case, trigger-rich descriptions, workflow + output format,
  all handing off to `tomtom-live-map`):
  `tomtom-live-map` (centre), `tomtom-location-search`, `tomtom-route-planning`,
  `tomtom-live-traffic`, `tomtom-ev-journey`, `tomtom-traffic-analytics` (optional MOVE connector).
  Two companion refs: `tomtom-live-map/references/rendering-and-coordinates.md`,
  `tomtom-traffic-analytics/references/sql-recipes.md`.
  - The geocode ambiguity finding is baked in: `tomtom-location-search` instructs the agent to add
    city/country to disambiguate.
- `New-Icons.ps1` → generated **`color.png` (192×192)** and **`outline.png` (32×32)** (verified
  dimensions; color icon is a white map-pin on TomTom red).
- `Build-CoworkPlugin.ps1` — validates (manifest, skill folders/names/kebab-case, connector HTTPS +
  `None`⇒no `referenceId`), applies overrides (`-GatewayUrl`, `-AppId`, policy URLs), and packages
  the `.zip` with a root-level layout.
- `README.md` + `COWORK-DEPLOYMENT-GUIDE.md` (register → package → **Add agent** upload → enable →
  test, with troubleshooting + security notes).

**New `deploy/Deploy-CoworkGateway.ps1`** — `az acr build` the proxy image → `az containerapp
update` → store key as a **Container App secret** → set `MCP_SERVER_URL` / `INTERACTIVE_MAP_URL` /
`PUBLIC_BASE_URL` → verify `/health` + `GET /api/mcp`.

**New `tests/Invoke-CoworkPluginTests.ps1`** — static (validate+package) and optional live gateway
smoke (`-GatewayUrl`).

**Root `README.md`** — added the "What's New in v3.0" section, the build/deploy step, and updated
the project-structure tree.

**Static evidence:**
- `Build-CoworkPlugin.ps1` → **Validation PASSED**; produced `dist/tomtom-cowork-plugin-1.0.0.zip`.
- Zip contents verified: `manifest.json`, `color.png`, `outline.png`, and `skills/…` all at the root.
- `Invoke-CoworkPluginTests.ps1` (static) → **2 passed, 0 failed**.
- `git status` shows only intended changes; build artifacts (`dist/`, `node_modules/`) gitignored.

> Next (needs user action/approval):
> 1. **Deploy the gateway** to `ca-tomtom-map-proxy` (`Deploy-CoworkGateway.ps1`) — modifies Azure.
> 2. **Run the live plugin smoke test** against the deployed `/api/mcp`.
> 3. **Upload + enable** the plugin in the ABS tenant (Frontier) and run the Cowork prompts;
>    capture screenshots here.
> 4. **Publish** to the public repo.

## Entry 5 — Secret remediation (2026-06-12)

- A workspace-wide scan found a **hardcoded TomTom API key** in `teams-app/manifest.json`
  (`staticTabs[0].contentUrl`, pre-existing). Replaced it with `YOUR_TOMTOM_MAPS_KEY`.
- Re-scan: the key no longer appears anywhere in the working tree.
- ⚠️ **Action required:** the key was previously committed, so it remains in **git history** (and
  was shared in chat). **Rotate the TomTom API key** before/with publishing. If history must be
  scrubbed, that's a separate, destructive `git filter-repo`/BFG step (needs explicit approval).
- All new code keeps the key **server-side** (Container App secret); nothing in `cowork-plugin/`
  contains a secret.

## Entry 6 — Gateway deployed to Azure + live tests green (2026-06-12)

- Added `map-proxy-api/.dockerignore` (keeps the ACR build context lean).
- Ran `deploy/Deploy-CoworkGateway.ps1`:
  - **`az acr build`** → image `acrtomtommcp.azurecr.io/tomtom-map-proxy:cowork-gateway`
    (Run ID db3, success in ~38 s).
  - **`az containerapp update`** pointed `ca-tomtom-map-proxy` at the new image.
  - TomTom key stored as Container App **secret** `tomtom-api-key`; env set:
    `TOMTOM_API_KEY=secretref`, `MCP_SERVER_URL`, `INTERACTIVE_MAP_URL`, `PUBLIC_BASE_URL`.
  - Verify: `/health` = ok; `GET /api/mcp` probe → `service=tomtom-cowork-mcp-gateway,
    mcpServerConfigured=True, apiKeyConfigured=True`.
- **Live connector URL:** `https://ca-tomtom-map-proxy.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io/api/mcp`
- **`tests/Invoke-CoworkPluginTests.ps1 -GatewayUrl <deployed>` → 10 passed, 0 failed**
  (initialize, tools/list with `render_live_map` present + `tomtom-get-api-key` filtered + read-only,
  geocode, render_live_map imageUrl, and a live **map image fetch 200 image/***).

> Next: upload the package in the ABS Admin Center (Add agent), enable in Cowork, run the prompts,
> and capture screenshots; then publish.

## Entry 7 — Tenant upload + a real schema fix (2026-06-12)

Drove the M365 Admin Center (**Copilot → Agents → All agents → ⋯ → Add agent → Upload agent to
publish**) and uploaded the package. The live validator surfaced a requirement **not shown** in the
Cowork "build a plugin" sample manifest:

> **Manifest is not valid:** "Required properties are missing from object: **mcpToolDescription**.
> Path `agentConnectors[0].toolSource.remoteMcpServer`."

**Root cause & fix (verified against the v1.28 schema reference):** for manifest **v1.28**,
`remoteMcpServer` **requires** `mcpToolDescription.file` — a packaged JSON file of tool definitions
(static discovery), even though Cowork can also do dynamic discovery. Changes:
- Generated **`cowork-plugin/toolDescription.json`** from the **deployed gateway's** live
  `tools/list` (17 tools incl. `render_live_map`, excl. `tomtom-get-api-key`), shaped as
  `{ "tools": [...] }`.
- Added `"mcpToolDescription": { "file": "toolDescription.json" }` to the connector in
  `manifest.json`.
- Updated `Build-CoworkPlugin.ps1` to validate the file (valid JSON, has `tools`, no key leak) and
  copy it into the package; re-ran → **Validation PASSED**, zip now includes `toolDescription.json`.
- Re-uploaded → **manifest validated successfully**; wizard advanced to **Publish agent to selected
  users**, showing the agent **"TomTom Maps & Traffic"** with the custom icon.

> Next: complete the publish step (pilot scope), enable in Cowork → Sources & Skills, run prompts.

## Entry 8 — Published to the ABS tenant (2026-06-12)

Completed the Agent 365 publish wizard for **TomTom Maps & Traffic**:
- **Upload agent** ✓ (manifest validated)
- **Publish to users:** All users · **Install:** All users (user-chosen scope for the demo tenant)
- **Apply template:** Default policy template for agents
- **Review permissions:** *No required permissions* (expected — connector auth is `None`)
- **Review & finish → Publish**

> Next: confirm "Available" status in All agents, then enable in Cowork → Sources & Skills and run
> the test prompts (Cardiff Castle live map; Cardiff→London with traffic; EV chargers near Heathrow).

## Entry 9 — Maps now render in Cowork (MCP Apps / SEP‑1865 adaptation) (2026-06-12)

**Symptom:** plugin worked and tools were called, but every map showed *"TomTom Maps & Traffic
widget couldn't load."*

**Diagnosis (probe + Microsoft Learn):** Cowork renders rich output as **MCP Apps widgets
(SEP‑1865)** — it calls **`resources/read`** for a tool's declared `ui://` resource and renders the
HTML in a sandboxed iframe whose CSP honours **only `frameDomains`**. The upstream **TomTom Orbis
MCP v1.3.4** is MCP‑Apps‑enabled (advertises `resources`; `resources/list` returns
`ui://tomtom-*/app.html`), but (a) our gateway didn't advertise/handle `resources/*`, so the fetch
failed, and (b) the upstream widgets fetch tiles/SDK from `api.tomtom.com`, which Cowork's sandbox
blocks. Full write‑up: [COWORK-MCP-APPS-ADAPTATION.md](COWORK-MCP-APPS-ADAPTATION.md).

**Fix (gateway):**
- `initialize` now advertises the **`resources`** capability; added **`resources/list`**,
  **`resources/read`**, **`resources/templates/list`**.
- Serve our **own self‑contained widget** `ui://tomtom-cowork/live-map.html`
  (`text/html;profile=mcp-app`, inlined CSS/JS, `frameDomains` = proxy + SWA origins).
- **Server‑side image baking via `Mcp-Session-Id`:** `initialize` returns a session id; `tools/call`
  for `render_live_map` / `tomtom-dynamic-map` / `tomtom-data-viz` remembers the map args per
  session; `resources/read` (same session id, re‑attached by Cowork) renders the map upstream and
  inlines it as a **`data:` image** in the widget — no client key, no blocked network call. This was
  needed because Cowork mounts the widget from the **static** `tools/list` `resourceUri` (it ignores
  a per‑call URI in the result `_meta`).
- `render_live_map` declares `_meta.ui.resourceUri` + `openai/outputTemplate`; added app‑only
  **`tomtom_map_image`** (`visibility:["app"]`) as a bridge fallback; widget render order:
  inline `data:` → framed image URL → host bridge; plus an **"Open live interactive map"** button.
- **Suppress upstream widgets:** strip upstream `_meta` from `tools/list` + results so Cowork stops
  mounting the non‑loadable `ui://tomtom-*` widgets. Security: `tomtom-get-api-key` still filtered.
- Deploy: pinned `ca-tomtom-map-proxy` to **1 replica** (consistent session store);
  `MAP_CLIENT_KEY` set so the interactive SWA link renders tiles.

**Changed files:** [mcpGateway.ts (lib)](../map-proxy-api/src/lib/mcpGateway.ts),
[mcpGateway.ts (route)](../map-proxy-api/src/functions/mcpGateway.ts),
[Deploy-CoworkGateway.ps1](../deploy/Deploy-CoworkGateway.ps1). Build exit 0; redeployed (ACR Run
IDs db4/db5).

**Evidence (live ABS tenant):**
- Local + deployed gateway: `initialize` advertises `resources`; `resources/read` returns
  `text/html;profile=mcp-app` HTML that inlines a `data:image/jpeg` map; widget tests green.
- Cowork (new task, *"Show Cardiff Castle, Wales on a live map"*): the **"couldn't load"** error is
  **gone**; the widget renders the map `img` + **"Open live interactive map ↗"** button; the agent
  reply links to the interactive map.
- Container App logs, one turn, **same session id**, `baked=yes`:
  ```
  mcpGateway: tools/call render_live_map session=b767e7d9-…-68f892e71a68
  mcpGateway: resources/read uri=ui://tomtom-cowork/live-map.html session=b767e7d9-…-68f892e71a68 baked=yes
  ```

> Result: **dynamic, live TomTom maps render inside Microsoft 365 Copilot Cowork.**

## Entry 10 — Widget actually painting: three more root causes (2026-06-12)

After Entry 9 the widget *mounted* but the map image still didn't paint (loading skeleton, then a
*"widget didn't respond in time"* timeout). Guided by the **official TomTom widget** (probed via
`resources/read ui://tomtom-map/dynamic-map/app.html`) and the **SEP‑1865** spec, three further root
causes were found and fixed:

1. **Mutable image tag → deploys never rolled out (the big one).** `Deploy-CoworkGateway.ps1` pushed
   to the fixed tag `:cowork-gateway` and ran `az containerapp update --image …:cowork-gateway`.
   Because the image reference string was unchanged, **Azure Container Apps created no new revision and
   did not re‑pull** — the container kept running the *first* image (revision `0000005`) across ~7
   redeploys. Logs proved it (old log format, no new code paths). **Fix:** append a unique
   `-yyyyMMddHHmmss` suffix to the tag each deploy → a new revision rolls out every time (verified:
   revisions `0000006`/`0000007`/`0000008`).
2. **Missing SEP‑1865 handshake/size → stuck skeleton / timeout.** Cowork keeps the loading skeleton
   until the widget completes the **`ui/initialize` → `ui/notifications/initialized`** handshake and
   reports its height via **`ui/notifications/size-changed`** (ResizeObserver) over
   `window.parent.postMessage`. The widget now does both (matching the official TomTom widget's
   `sendSizeChanged` behaviour). This cleared the skeleton and the timeout.
3. **Image not painting → sandbox CSP + payload size.** Cowork's widget iframe **blocks nested
   iframes to our origin and all external `fetch`/`img`** (only `img-src data:` is allowed). Also, a
   large `data:` URL (≈175 KB from a 1000×700 map) was being truncated/rejected, leaving a broken
   `src`. **Fix:** (a) render a **smaller** map for the widget (640×400 ≈ smaller `data:` URL), and
   (b) **bake `<img src="data:…">` directly into the served HTML body** — so the map paints with
   **zero** script/postMessage/network dependency (the inline `<script>` now only *enhances*:
   handshake, size, open‑map button). `render_live_map` pre‑renders + caches the image at
   `tools/call` time, so `resources/read` returns instantly.

**Deploy hygiene:** `Deploy-CoworkGateway.ps1` pins the app to **1 replica** (consistent in‑memory
session→image cache) and now always ships a unique image tag.

**Evidence (live ABS tenant, revision `0000008`, image `cowork-gateway-20260612111302`):** in Cowork,
*"Show Cardiff Castle, Wales on a live map"* renders a **live TomTom map of the Cardiff area inside the
widget** — marker pin, *"©TomTom, ©OpenStreetMap"* attribution, the **"Open the interactive live
map"** link, and the agent's summary text. Screenshot captured. **Maps confirmed rendering in Cowork.**

## Entry 11 — The widget is a dead end; ship a markdown image + interactive link (2026-06-12)

A follow‑up request ("*it's just a map, not interactive*") led to adding inline zoom/pan controls to
the widget — which **regressed** it back to *"widget didn't respond in time."* Investigating that
regression revealed the Entry 9–10 widget success was not reproducible in the current Cowork build:
Cowork's **own** widget‑renderer host (`…widget-renderer.usercontent.microsoft/mcpwidget.html`) now
**aborts** (`net::ERR_ABORTED`) ~10 s after mount, *before* our content can paint — independent of
what we serve. We confirmed our side was fine (logs: `baked=yes hasImage=yes bytes=115268
dataUrlBytes=50467`) and that an **immediate** `ui/notifications/size-changed` at 0 ms did not help.

We then tested, live in the tenant, **all three** ways a tool can show a picture in Cowork:

| Mechanism | Result (verified in Cowork) | Verdict |
|---|---|---|
| **MCP Apps widget** (`_meta.ui`) | Host `mcpwidget.html` aborts → *"didn't respond in time"* every time; sandbox also blocks tiles | ❌ Unusable |
| **MCP `image` content block** | Not painted to the user; model assumes "map shown above" and then omits both image **and** link (Colosseum test) | ❌ Worse than nothing |
| **Markdown image** `![title](imageUrl)` in the reply | **Renders inline** (`imageUrl` = gateway `GET /api/get-map-image`, ~130 KB JPEG) | ✅ Only one that works |

**Final fix (`render_live_map`, gateway revision `0000018`, image `cowork-gateway-2026061213…`):**
- **Removed the MCP Apps widget entirely** — deleted `_meta.ui.resourceUri` / `openai/outputTemplate`
  from both the **tool definition** and the **tool result**. No more widget mount ⇒ no more
  *"didn't respond in time"* banner.
- **No image content block** (it backfires — model thinks the map is already shown).
- The result is **plain text** that instructs the agent to reply with the exact markdown
  `![<title>](<imageUrl>)` followed by `🗺️ **[Open the interactive live map](<interactiveUrl>)**`.
  `structuredContent` still carries `imageUrl` + `interactiveUrl`; the **link is always in the text**,
  so even on a run where the model drops the inline image, the interactive map is one click away.
- Strengthened the **`tomtom-live-map` skill Output format** to match (embed the markdown image +
  always include the interactive link). *(Re‑package + re‑publish to apply skill changes; the gateway
  result text already drives the behaviour, so the live plugin works without re‑publishing.)*

**Changed files:** [mcpGateway.ts (lib)](../map-proxy-api/src/lib/mcpGateway.ts) (`renderLiveMapResult`,
`RENDER_LIVE_MAP_TOOL`, `fetchMapDataUrl` gained size params),
[tomtom-live-map/SKILL.md](../cowork-plugin/skills/tomtom-live-map/SKILL.md),
[COWORK-MCP-APPS-ADAPTATION.md](COWORK-MCP-APPS-ADAPTATION.md) (dated update section). Build exit 0.

**Evidence (live ABS tenant, revision `0000018`):** new tasks for **Edinburgh Castle**, the **Eiffel
Tower**, the **Colosseum** (during testing) and finally **Sydney Opera House** were run end‑to‑end.
The Sydney run shows the intended, clean result with **no error banner**:

```
mcpGateway: tools/call render_live_map session=…   (no resources/read — widget removed)
```

> Sydney Opera House screenshot: a high‑quality inline TomTom map (marker, street labels,
> *"©TomTom, ©OpenStreetMap"*) directly in the chat, with **"Open the interactive live map"**
> beneath it. Verdict captured below.

**Interactivity — the honest conclusion:** a genuinely pan/zoom map **inline** is **not possible** in
Cowork today (its widget sandbox blocks the map‑tile network — the same reason the official TomTom
widget shows blank there). What ships is a high‑quality **inline static map** plus the **"Open the
interactive live map"** link, which opens the full **MapLibre Static Web App** (drag, zoom, live‑traffic
toggle) — that link **is** the interactive experience.

**Known separate issue:** in these runs `tomtom-geocode` / `tomtom-fuzzy-search` returned no results
and the agent fell back to well‑known coordinates (the map still rendered correctly). Worth checking
the upstream MCP server's geocode/search (key/quota/region) independently.

## Entry 12 — Correction: widgets DO work; clickable image + TomTom Orbis backend (2026-06-12, evening)

Two things this entry covers: (a) a **correction** to Entry 11's conclusion after deeper research, and
(b) implementing the **TomTom Orbis Maps backend** header.

### (a) Cowork interactive widgets — corrected findings

A LinkedIn post (draw.io MCP rendering interactive widgets in Cowork) triggered a re‑investigation that
found the **official, Cowork‑specific** doc we'd missed:
[MCP apps plugin author guide for Cowork (Frontier)](https://learn.microsoft.com/microsoft-365/copilot/cowork/mcp-apps-support).
Entry 11 was **partly wrong**:

- ❌ "Widgets are unusable in Cowork." → ✅ **Widgets mount.** With a corrected SEP‑1865 handshake the
  widget `<iframe>` renders inline (verified: real iframe + loading spinner, not the old error).
- ❌ "Inline interactivity is impossible (tile network blocked)." → ✅ **Cowork honours
  `_meta.ui.csp.frameDomains`** (→ CSP `frame-src`). The widget can **embed our interactive SWA
  (MapLibre) as a nested iframe** (its own origin, loads its own tiles) for **true inline pan/zoom**.
  Our earlier failure was simply never *declaring* `frameDomains`.

**What we rebuilt:** `buildWidgetHtml` now embeds the SWA as `<iframe class="live" src="<interactiveUrl>">`
(primary) with the pre‑rendered `data:` image as a poster/fallback behind it; `_meta.ui.csp.frameDomains`
includes the SWA origin; the widget script was rewritten to a clean, spec‑correct handshake —
`ui/initialize` (with `appInfo` + `appCapabilities`) handled in **both** directions (View‑initiated and
host‑initiated), `ping` answered, **every** host→view request acknowledged, size reported **only after**
`ui/notifications/initialized`, and the button switched to a `ui/request-display-mode` fullscreen toggle
(`ui/open-link` is unsupported in Cowork).

**Remaining blocker (verified across two serious handshake attempts, revs `0000021`/`0000022`):** the
Cowork preview **widget host** (`…widget-renderer.usercontent.microsoft/mcpwidget.html`) still **aborts
(`net::ERR_ABORTED`) ~10 s after mount**, independent of our handshake content. This points to a
host‑side readiness contract best satisfied by bundling the official
[`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) SDK (the
draw.io / Microsoft‑sample pattern), or a Cowork host fix.

**Decision — gate the widget, ship the reliable path (revision `0000024`):**
- The widget is now **gated behind `ENABLE_COWORK_WIDGET` (default `false`)**. Off ⇒ `render_live_map`
  emits **no `_meta.ui`** (so **no "didn't respond in time" banner**) and the agent relays a
  **clickable inline image** `[![title](imageUrl)](interactiveUrl)` + the **"Open the interactive live
  map"** link. On ⇒ the native widget (SWA iframe) is advertised. Deploy switch: `-EnableCoworkWidget`.
- All widget code is retained for future re‑enablement.

### (b) TomTom Orbis Maps backend

Implemented per the [Orbis Maps docs](https://developer.tomtom.com/tomtom-orbis-maps/documentation/introduction):
all upstream MCP calls now send the **`tomtom-maps-backend`** header (default **`tomtom-orbis-maps`**;
override via `MCP_MAPS_BACKEND`, deploy switch `-MapsBackend`). Threaded through `callMcpTool` /
`callMcpRpc` (`mcpClient.ts`, with `DEFAULT_MAPS_BACKEND` + `resolveBackend`), `GatewayContext.mapsBackend`,
all four gateway call sites, and `getMapImage`. Verified live: startup log shows
`MCP_MAPS_BACKEND: tomtom-orbis-maps`.

**Changed files:** [mcpClient.ts](../map-proxy-api/src/lib/mcpClient.ts),
[mcpGateway.ts (lib)](../map-proxy-api/src/lib/mcpGateway.ts),
[mcpGateway.ts (route)](../map-proxy-api/src/functions/mcpGateway.ts),
[getMapImage.ts](../map-proxy-api/src/functions/getMapImage.ts),
[server.ts](../map-proxy-api/src/server.ts),
[Deploy-CoworkGateway.ps1](../deploy/Deploy-CoworkGateway.ps1),
[tomtom-live-map/SKILL.md](../cowork-plugin/skills/tomtom-live-map/SKILL.md),
[COWORK-MCP-APPS-ADAPTATION.md](COWORK-MCP-APPS-ADAPTATION.md). Build exit 0; deployed `0000020`→`0000024`.

**Evidence (live ABS tenant):** widget‑on tests (Brandenburg Gate, Colosseum) — widget `<iframe>`
mounts + spinner, then host abort at ~10 s. Widget‑off test (Statue of Liberty, rev `0000024`) — clean
result, **no banner**, correct Orbis‑backed interactive link. `MCP_MAPS_BACKEND: tomtom-orbis-maps`
confirmed in container startup logs.

## Entry 13 — Inlined SWA HTML widget + traffic overlay fixes (2026‑06‑14)

**Objective:** Enable the interactive map widget by default in Cowork without the 10 s SDK handshake timeout.

**Root cause:** The widget was using a **nested cross-origin iframe** pointing to the Static Web App. This 
double round-trip (widget HTML → SWA HTML → MapLibre + style JSON + tiles + SDK handshake) exceeded 
Cowork's ~10 s budget and triggered "widget didn't respond in time."

**Solution:** **Inline the SWA HTML directly** into the widget response, eliminating the nested iframe and 
the extra round-trip. The interactive map app now reads its initial state from a **`window.MAP_STATE` 
global** instead of URL parameters.

**Implementation:**
- New file **`map-proxy-api/src/lib/interactiveMapHtml.ts`** — reads `interactive-map-app/index.html` 
  at startup (cached), transforms URL-param parsing to `window.MAP_STATE`, exports `getInteractiveMapAssets()` 
  with head/body HTML splits.
- **`map-proxy-api/Dockerfile`** — added `COPY interactive-map-app/ ./interactive-map-app/` so the SWA 
  is available in the container at runtime.
- **`map-proxy-api/src/lib/mcpGateway.ts`** — rewritten `buildWidgetHtml`:
  - Removed nested `<iframe class="live">` pointing to the SWA.
  - Inlined `getInteractiveMapAssets().headHtml` into `<head>`, `.bodyHtml` in place of iframe.
  - Emits `<script>window.MAP_STATE = ${stateJson};</script>` before SWA script runs.
  - App SDK handshake unchanged; on `ontoolresult`, calls `window.applyMapState(...)` to mutate map state.
  - Added traffic overlay fixes: removed invalid `&thickness` param, added `typeof map.showTrafficFlow === 
    'function'` guard for MapLibre GL fallback.
- **`deploy/Deploy-CoworkGateway.ps1`** — inverted widget enablement logic:
  - Changed parameter from `[switch]$EnableCoworkWidget` to `[switch]$DisableCoworkWidget` (default: off, 
    widget enabled).
  - Changed env-var assignment to `"ENABLE_COWORK_WIDGET=$(-not $DisableCoworkWidget.IsPresent)"` so 
    widget enabled by default on each deploy.
  - Fixed repeated deploy bug where widget was resetting to `false`.
- **`interactive-map-app/index.html`** — removed ASCII/pixel render-mode UI (button + cycling logic).

**Changed files:** `map-proxy-api/src/lib/interactiveMapHtml.ts` (new), `map-proxy-api/Dockerfile`, 
`map-proxy-api/src/lib/mcpGateway.ts`, `deploy/Deploy-CoworkGateway.ps1`, `interactive-map-app/index.html`.

**Build:** `npm run build` → exit 0, no TypeScript errors; deployed via `Deploy-CoworkGateway.ps1`.

**Verification (live Cowork):**
- **Barry Island map test:** Widget renders inline, fully interactive (pan, zoom, theme toggle works).
- **Traffic overlay:** Live traffic raster tiles render correctly; toggle works.
- **Fallback:** On error, static pre-rendered image displays instead of blank.
- **No timeout:** Widget completes SDK handshake well within 10 s budget; no "didn't respond in time" 
  banner.

**Result:** Interactive TomTom maps render reliably in Cowork with full zoom/pan/traffic interactivity 
directly in the chat panel. Confirmed working end‑to‑end with `tomtom-live-map` skill.



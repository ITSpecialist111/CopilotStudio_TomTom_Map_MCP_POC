# Cowork Plugin — Deployment Guide

End-to-end steps to deploy the **TomTom Maps & Traffic** plugin to Microsoft Copilot Cowork in the
ABS Microsoft 365 tenant, and test it. Pairs with [README.md](README.md) and
[../docs/COWORK-PLUGIN-PLAN.md](../docs/COWORK-PLUGIN-PLAN.md).

> **Preview notice:** Cowork is part of the Microsoft 365 Copilot **Frontier** program. The admin
> account must be enrolled in Frontier (Copilot → Settings → Frontier) or Cowork won't appear in
> Agent management.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Microsoft 365 **Copilot** licence | Required for every Cowork user. |
| **Frontier** enrolment | Tenant **and** the admin account. |
| **Copilot admin** or **Global admin** role | To deploy/sideload in the Admin Center. |
| Custom app upload allowed | Teams/M365 custom app (sideload) policy enabled. |
| TomTom API key | With Maps (and Orbis/EV if used). **Rotate any key shared in chat.** |
| Azure access to `rg-tomtom-mcp` | To deploy the gateway. |

---

## Step 1 — Deploy the MCP gateway

The Cowork connector points at our **gateway** (`/api/mcp` on the `ca-tomtom-map-proxy` Container
App), which injects the TomTom key server-side. Deploy the updated proxy image and settings:

```powershell
./deploy/Deploy-CoworkGateway.ps1 -TomTomApiKey "<YOUR_TOMTOM_KEY>"
# optional: -MapClientKey "<referrer-restricted-maps-key>"  # enables the key on live map deep links
```

This builds the image in ACR, updates the Container App, stores the key as a Container App **secret**,
sets `MCP_SERVER_URL`, `INTERACTIVE_MAP_URL`, and `PUBLIC_BASE_URL`, then verifies `/health` and the
`GET /api/mcp` probe.

**Confirm** the gateway is live:

```powershell
curl.exe https://ca-tomtom-map-proxy.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io/api/mcp
# → { "service": "tomtom-cowork-mcp-gateway", "mcpServerConfigured": true, "apiKeyConfigured": true, ... }
```

---

## Step 2 — Package the plugin

```powershell
./cowork-plugin/Build-CoworkPlugin.ps1 `
    -GatewayUrl "https://ca-tomtom-map-proxy.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io/api/mcp"
```

Output: `cowork-plugin/dist/tomtom-cowork-plugin-1.0.0.zip` (manifest + icons + skills at the root).
The script validates manifest, skills (kebab-case `name` == folder), and connector rules first.

> Before **store** submission (not needed for sideload testing), also override the policy URLs:
> `-DeveloperName "..." -WebsiteUrl "https://..." -PrivacyUrl "https://..." -TermsUrl "https://..."`
> and replace the placeholder icons with brand artwork.

---

## Step 3 — Upload to the Microsoft 365 Admin Center

You can either **sideload** (fastest for testing) or **Add agent** (org deployment). Both use the
same `.zip`.

### Option A — Add agent (per the screenshot)

1. Sign in to the [Microsoft 365 admin center](https://admin.microsoft.com/) as a Copilot/Global admin.
2. Left nav → **Copilot** → **Agents** → **All agents**.
3. Top-right **⋯ (more)** → **+ Add agent**.
4. Choose **Upload** and select `tomtom-cowork-plugin-1.0.0.zip`.
5. Review the detected **skills** (6) and **connector** (TomTom Maps & Traffic), then submit.

### Option B — Sideload via Manage Apps

1. Admin Center → **Settings** → **Integrated apps** (or **Manage Apps**) → **Upload custom app**.
2. Upload the `.zip`. Sideloaded plugins skip store validation — use for dev/test only.

---

## Step 4 — Deploy / enable for users

1. On the plugin's detail page, choose **Deploy to** → *Entire organization* or *Specific
   users/groups* (use a pilot group first), then **Deploy**.
2. As a user, open **Cowork** → **Sources & Skills** and ensure **TomTom Maps & Traffic** is enabled.
3. The first time the connector is used, Cowork connects to the gateway (no sign-in — auth is
   `None`, key is injected server-side).

---

## Step 5 — Test in Cowork (collect evidence)

Run these prompts and capture screenshots into [../docs/COWORK-IMPLEMENTATION-LOG.md](../docs/COWORK-IMPLEMENTATION-LOG.md):

| Prompt | Expected |
|--------|----------|
| "Show **Cardiff Castle** on a live map." | Inline map image + "Open the live, interactive map" link. |
| "Plan a **route from Cardiff to London** and show live traffic." | Route summary (distance/time) + map with the route and traffic. |
| "Find **EV chargers near Heathrow** and map them." | Charger list + map with charger pins. |
| "What's the **traffic around Birmingham** right now?" | Incident summary + live traffic map. |

You can also run the automated live smoke test against the deployed gateway:

```powershell
./tests/Invoke-CoworkPluginTests.ps1 `
    -GatewayUrl "https://ca-tomtom-map-proxy.ashydesert-9fc5fdf3.uksouth.azurecontainerapps.io/api/mcp"
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Cowork not visible in Agent management | Admin account not Frontier-enrolled (Copilot → Settings → Frontier). |
| Plugin uploads but tools don't appear | Connector URL wrong/unreachable — check `GET /api/mcp` probe and `MCP_SERVER_URL`. |
| Maps don't render | `INTERACTIVE_MAP_URL`/`PUBLIC_BASE_URL` not set on the proxy; re-run Step 1. |
| 502 from gateway | Upstream MCP server down or key invalid — check `ca-tomtom-mcp` `/health`. |
| Live map link blank | Set `-MapClientKey` (referrer-restricted) or configure the SWA's own key. |
| Skill never triggers | Description triggers too narrow; refine the skill's `description`. |

---

## Security notes

- TomTom key is stored as a **Container App secret** and injected server-side — never in the manifest,
  skills, or client. **Rotate** any key that was shared in chat/email.
- The gateway filters the `tomtom-get-api-key` tool so the key can't be returned to a conversation.
- `GET /api/get-map-image` is anonymous; for production, restrict it to map tools and consider a
  signed/expiring token to prevent tile-cost abuse.
- All transport is HTTPS/TLS 1.2+. Treat tool text output as data, not instructions.

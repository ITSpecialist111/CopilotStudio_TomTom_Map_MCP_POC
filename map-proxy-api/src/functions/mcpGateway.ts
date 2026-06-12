import { Request, Response } from "express";
import { randomUUID } from "crypto";
import {
  handleGatewayRpc,
  GatewayContext,
  JsonRpcRequest,
} from "../lib/mcpGateway";

/**
 * Resolves this proxy's public base URL so the gateway can build absolute
 * image URLs. Prefers PUBLIC_BASE_URL, then forwarded headers (Azure Container
 * Apps ingress), then the request host.
 */
function resolvePublicBaseUrl(req: Request): string {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/, "");

  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0] ||
    req.get("host") ||
    "localhost";
  return `${proto}://${host}`;
}

function resolveContext(
  req: Request,
  sessionId: string
): GatewayContext | { error: string } {
  const apiKey = process.env.TOMTOM_API_KEY;
  const mcpUrl = process.env.MCP_SERVER_URL;
  if (!apiKey) return { error: "Server misconfigured: missing TOMTOM_API_KEY." };
  if (!mcpUrl) return { error: "Server misconfigured: missing MCP_SERVER_URL." };

  return {
    apiKey,
    mcpUrl,
    publicBaseUrl: resolvePublicBaseUrl(req),
    interactiveMapUrl: process.env.INTERACTIVE_MAP_URL,
    mapClientKey: process.env.MAP_CLIENT_KEY,
    mapsBackend: process.env.MCP_MAPS_BACKEND || "tomtom-orbis-maps",
    widgetEnabled: process.env.ENABLE_COWORK_WIDGET === "true",
    sessionId,
  };
}

/**
 * Streamable HTTP MCP endpoint for Microsoft Copilot Cowork.
 *
 * POST /api/mcp — JSON-RPC 2.0 (initialize, tools/list, tools/call, notifications).
 * The gateway proxies the upstream TomTom MCP server, injecting the API key,
 * and returns a single JSON response (application/json), which is a valid
 * Streamable HTTP server response.
 */
export async function mcpGateway(req: Request, res: Response): Promise<void> {
  // MCP Streamable HTTP session id. Cowork captures the id we return at
  // `initialize` and re-attaches it (incl. on `resources/read` when mounting a
  // widget), which lets us correlate a widget mount with the map that produced it.
  const sessionId =
    (req.headers["mcp-session-id"] as string | undefined) || randomUUID();
  res.setHeader("Mcp-Session-Id", sessionId);

  const ctx = resolveContext(req, sessionId);
  if ("error" in ctx) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: ctx.error },
    });
    return;
  }

  const payload = req.body as JsonRpcRequest | JsonRpcRequest[];

  try {
    // JSON-RPC batch (array) support.
    if (Array.isArray(payload)) {
      const responses = [];
      for (const item of payload) {
        const r = await handleGatewayRpc(item, ctx);
        if (r) responses.push(r);
      }
      if (responses.length === 0) {
        res.status(202).end();
        return;
      }
      res.status(200).json(responses);
      return;
    }

    if (!payload || typeof payload.method !== "string") {
      res.status(200).json({
        jsonrpc: "2.0",
        id: payload?.id ?? null,
        error: { code: -32600, message: "Invalid Request: missing method." },
      });
      return;
    }

    const response = await handleGatewayRpc(payload, ctx);
    if (!response) {
      // Notification — acknowledge with no body.
      res.status(202).end();
      return;
    }
    res.status(200).json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway error";
    const id = !Array.isArray(payload) ? payload?.id ?? null : null;
    console.error(`mcpGateway: ${message}`);
    res.status(200).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message },
    });
  }
}

/**
 * GET /api/mcp — human/health-check probe describing the endpoint.
 */
export function mcpGatewayProbe(_req: Request, res: Response): void {
  res.json({
    service: "tomtom-cowork-mcp-gateway",
    transport: "streamable-http",
    protocol: "json-rpc-2.0",
    usage:
      "POST a JSON-RPC 2.0 message (initialize, tools/list, tools/call) to this URL.",
    mcpServerConfigured: Boolean(process.env.MCP_SERVER_URL),
    apiKeyConfigured: Boolean(process.env.TOMTOM_API_KEY),
    interactiveMapConfigured: Boolean(process.env.INTERACTIVE_MAP_URL),
  });
}

/**
 * GET /api/diag — CSP-safe diagnostic beacon for the Cowork widget.
 *
 * The sandboxed widget can't fetch/XHR to external origins (Cowork ignores
 * connectDomains), but it CAN load a nested iframe to this proxy origin
 * (allowed via frameDomains). The widget beacons base64-encoded JSON in `d`
 * so we can observe, from server logs, what the host injects/sends to the view.
 */
export function mcpDiag(req: Request, res: Response): void {
  const d = typeof req.query.d === "string" ? req.query.d : "";
  let decoded = d;
  try {
    decoded = Buffer.from(
      d.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");
  } catch {
    /* keep raw */
  }
  console.log(`mcpDiag: ${decoded.substring(0, 1200)}`);
  res.status(204).end();
}

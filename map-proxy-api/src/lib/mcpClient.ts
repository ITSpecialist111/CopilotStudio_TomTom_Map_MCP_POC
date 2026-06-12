import axios, { AxiosError } from "axios";

/**
 * The TomTom Maps backend the upstream MCP server should use, sent as the
 * `tomtom-maps-backend` header on every upstream call. Defaults to
 * `tomtom-orbis-maps` (TomTom Orbis Maps); override via the `MCP_MAPS_BACKEND`
 * environment variable. If the header is omitted, TomTom defaults to the legacy
 * "TomTom Maps" backend — we send it explicitly so Orbis is the default here.
 * See https://developer.tomtom.com/tomtom-orbis-maps/documentation/introduction
 */
export const DEFAULT_MAPS_BACKEND = "tomtom-orbis-maps";
function resolveBackend(backend?: string): string {
  return backend || process.env.MCP_MAPS_BACKEND || DEFAULT_MAPS_BACKEND;
}

/**
 * Represents a JSON-RPC 2.0 request to the MCP server.
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Represents the parsed result from an MCP tool call.
 */
export interface McpToolResult {
  /** Text content blocks returned by the tool. */
  text?: string;
  /** Base64-encoded image data, if the tool returned an image. */
  imageBase64?: string;
  /** MIME type of the image (e.g., "image/png"). */
  imageMimeType?: string;
  /** The raw parsed result object from the JSON-RPC response. */
  raw: unknown;
}

/**
 * Represents a content block in an MCP tool response.
 */
interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * Represents a JSON-RPC response envelope.
 */
export interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content?: McpContentBlock[];
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Calls a tool on the TomTom MCP server via HTTP POST to the /mcp endpoint.
 * The MCP server responds with SSE (Server-Sent Events) formatted data.
 *
 * @param toolName - The MCP tool name (e.g., "tomtom-dynamic-map", "tomtom-routing").
 * @param args - The arguments to pass to the tool.
 * @param apiKey - The TomTom API key (injected into args if not already present).
 * @param mcpUrl - The base URL of the MCP server (Azure Container App).
 * @returns The parsed tool result.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  apiKey: string,
  mcpUrl: string,
  backend?: string
): Promise<McpToolResult> {
  const url = mcpUrl.replace(/\/+$/, "") + "/mcp";

  const jsonRpcRequest: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: { ...args },
    },
  };

  try {
    const response = await axios.post(url, jsonRpcRequest, {
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        "tomtom-api-key": apiKey,
        "tomtom-maps-backend": resolveBackend(backend),
      },
      // Accept the response as text so we can parse SSE manually
      responseType: "text",
      timeout: 60000,
    });

    const responseData = response.data as string;
    return parseMcpResponse(responseData);
  } catch (error) {
    if (error instanceof AxiosError) {
      const status = error.response?.status ?? "unknown";
      const body =
        typeof error.response?.data === "string"
          ? error.response.data.substring(0, 500)
          : JSON.stringify(error.response?.data)?.substring(0, 500);
      throw new Error(
        `MCP server request failed (HTTP ${status}): ${error.message}. Body: ${body}`
      );
    }
    throw error;
  }
}

/**
 * Performs a generic JSON-RPC call against the MCP server and returns the full
 * response envelope (result or error), transparently parsing either a plain
 * JSON body or an SSE (`text/event-stream`) response.
 *
 * Used by the Cowork MCP gateway to proxy arbitrary methods
 * (`initialize`, `tools/list`, `tools/call`) on behalf of Microsoft Copilot Cowork.
 *
 * @param method - JSON-RPC method name.
 * @param params - JSON-RPC params (omitted from the body when undefined).
 * @param apiKey - The TomTom API key (sent in the `tomtom-api-key` header).
 * @param mcpUrl - The base URL of the upstream MCP server.
 * @param id - JSON-RPC request id to echo.
 * @returns The parsed JSON-RPC response envelope.
 */
export async function callMcpRpc(
  method: string,
  params: Record<string, unknown> | undefined,
  apiKey: string,
  mcpUrl: string,
  id: number | string = 1,
  backend?: string
): Promise<JsonRpcResponse> {
  const url = mcpUrl.replace(/\/+$/, "") + "/mcp";

  const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) {
    body.params = params;
  }

  try {
    const response = await axios.post(url, body, {
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        "tomtom-api-key": apiKey,
        "tomtom-maps-backend": resolveBackend(backend),
      },
      responseType: "text",
      timeout: 60000,
    });
    return parseJsonRpcEnvelope(response.data as string);
  } catch (error) {
    if (error instanceof AxiosError) {
      const status = error.response?.status ?? "unknown";
      const bodyText =
        typeof error.response?.data === "string"
          ? error.response.data.substring(0, 500)
          : JSON.stringify(error.response?.data)?.substring(0, 500);
      throw new Error(
        `MCP server request failed (HTTP ${status}): ${error.message}. Body: ${bodyText}`
      );
    }
    throw error;
  }
}

/**
 * Parses the MCP server response into a McpToolResult. The response may be:
 * 1. A plain JSON-RPC response body.
 * 2. An SSE stream with `data: {...}` lines.
 */
function parseMcpResponse(responseBody: string): McpToolResult {
  return extractResultFromJsonRpc(parseJsonRpcEnvelope(responseBody));
}

/**
 * Parses a raw MCP HTTP response body (plain JSON or SSE) into a JSON-RPC
 * response envelope. Shared by both tool-call parsing and the MCP gateway.
 *
 * @param responseBody - The raw response body string.
 * @returns The parsed JSON-RPC response envelope.
 */
export function parseJsonRpcEnvelope(responseBody: string): JsonRpcResponse {
  // First, try to parse as a plain JSON (non-SSE) response.
  const trimmed = responseBody.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      // Not valid JSON on its own; fall through to SSE parsing.
    }
  }

  // Parse as SSE: extract lines starting with "data:".
  const lines = responseBody.split("\n");
  const dataLines: string[] = [];

  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("data:")) {
      dataLines.push(stripped.replace(/^data:\s*/, ""));
    }
  }

  if (dataLines.length === 0) {
    throw new Error(
      "No data lines found in SSE response. Raw response: " +
        responseBody.substring(0, 500)
    );
  }

  // The last data line typically contains the final JSON-RPC result.
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const json = JSON.parse(dataLines[i]) as JsonRpcResponse;
      if (json.result || json.error) {
        return json;
      }
    } catch {
      // Skip non-JSON data lines (e.g., keep-alive or partial messages).
      continue;
    }
  }

  // Fallback: try concatenating all data lines.
  const concatenated = dataLines.join("");
  try {
    return JSON.parse(concatenated) as JsonRpcResponse;
  } catch {
    throw new Error(
      "Failed to parse MCP response from SSE data lines. Lines: " +
        dataLines.join(" | ").substring(0, 500)
    );
  }
}

/**
 * Extracts a McpToolResult from a parsed JSON-RPC response.
 */
function extractResultFromJsonRpc(response: JsonRpcResponse): McpToolResult {
  if (response.error) {
    throw new Error(
      `MCP tool error (${response.error.code}): ${response.error.message}`
    );
  }

  const result = response.result;
  if (!result) {
    return { raw: null };
  }

  const toolResult: McpToolResult = { raw: result };

  // Extract content blocks if present
  if (Array.isArray(result.content)) {
    const textParts: string[] = [];

    for (const block of result.content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "image" && block.data) {
        toolResult.imageBase64 = block.data;
        toolResult.imageMimeType = block.mimeType || "image/png";
      }
    }

    if (textParts.length > 0) {
      toolResult.text = textParts.join("\n");
    }
  }

  return toolResult;
}

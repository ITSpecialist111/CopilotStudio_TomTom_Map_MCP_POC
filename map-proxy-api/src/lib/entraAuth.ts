import { Request, Response, NextFunction } from "express";
import jwt, {
  JwtHeader,
  SigningKeyCallback,
  VerifyOptions,
  VerifyErrors,
  JwtPayload,
} from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";

/**
 * Microsoft Entra access-token validation for the M365 Copilot federated
 * connector route.
 *
 * When a custom federated connector uses Microsoft Entra SSO, Microsoft's
 * enterprise token store (`ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b`) acquires an
 * access token for our API (audience = the Application ID URI configured in the
 * Teams Developer Portal) and sends it as a Bearer token on every MCP request.
 * This middleware verifies that token's signature, issuer, and audience so the
 * endpoint only serves authenticated Microsoft 365 callers.
 *
 * Config (env):
 *   - REQUIRE_ENTRA_AUTH   "true" to enforce. When unset/false the middleware
 *                          passes through (lets us deploy before the audience /
 *                          Teams registration exists, and keeps dev unblocked).
 *   - ENTRA_TENANT_ID      Directory (tenant) GUID that issues the tokens.
 *   - CONNECTOR_AUDIENCE   Expected token audience = the Application ID URI from
 *                          the Teams Developer Portal SSO registration
 *                          (e.g. "api://<host>/<appId>"). Comma-separate to allow
 *                          several (e.g. both the api:// URI and the bare appId).
 *   - CONNECTOR_ALLOWED_CLIENTS  Optional comma-separated list of allowed caller
 *                          app IDs (azp/appid). Defaults to the Microsoft
 *                          enterprise token store client id.
 */

const ENTERPRISE_TOKEN_STORE_CLIENT_ID = "ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b";

function authEnforced(): boolean {
  return process.env.REQUIRE_ENTRA_AUTH === "true";
}

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let jwksClient: JwksClient | null = null;
function getJwksClient(tenantId: string): JwksClient {
  if (!jwksClient) {
    jwksClient = new JwksClient({
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 24 * 60 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }
  return jwksClient;
}

function getKey(client: JwksClient) {
  return (header: JwtHeader, callback: SigningKeyCallback): void => {
    if (!header.kid) {
      callback(new Error("Token header missing kid"));
      return;
    }
    client.getSigningKey(header.kid, (err, key) => {
      if (err || !key) {
        callback(err || new Error("Signing key not found"));
        return;
      }
      callback(null, key.getPublicKey());
    });
  };
}

function unauthorized(res: Response, detail: string): void {
  // 401 prompts the agent to (re)acquire a token / sign in.
  res
    .status(401)
    .set("WWW-Authenticate", 'Bearer error="invalid_token"')
    .json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: `Unauthorized: ${detail}` },
    });
}

/**
 * Express middleware that validates the Microsoft Entra Bearer token. No-ops
 * (calls next) when REQUIRE_ENTRA_AUTH is not "true" so the route can be
 * deployed and exercised before the Teams/Entra registration is complete.
 */
export function requireEntraAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!authEnforced()) {
    next();
    return;
  }

  const tenantId = process.env.ENTRA_TENANT_ID;
  const audiences = csv(process.env.CONNECTOR_AUDIENCE);
  if (!tenantId || audiences.length === 0) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32603,
        message:
          "Server misconfigured: REQUIRE_ENTRA_AUTH is on but ENTRA_TENANT_ID / CONNECTOR_AUDIENCE are not set.",
      },
    });
    return;
  }

  const authHeader = req.headers["authorization"] || req.headers["Authorization" as never];
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const match = /^Bearer\s+(.+)$/i.exec(raw || "");
  if (!match) {
    unauthorized(res, "missing Bearer token");
    return;
  }
  const token = match[1].trim();

  const allowedClients = csv(process.env.CONNECTOR_ALLOWED_CLIENTS);
  const allowList =
    allowedClients.length > 0 ? allowedClients : [ENTERPRISE_TOKEN_STORE_CLIENT_ID];

  const issuers = [
    `https://login.microsoftonline.com/${tenantId}/v2.0`,
    `https://sts.windows.net/${tenantId}/`,
  ];

  const verifyOptions: VerifyOptions = {
    audience: audiences as [string, ...string[]],
    issuer: issuers as [string, ...string[]],
    algorithms: ["RS256"],
  };

  jwt.verify(
    token,
    getKey(getJwksClient(tenantId)),
    verifyOptions,
    (err: VerifyErrors | null, decoded: string | JwtPayload | undefined) => {
      if (err || !decoded || typeof decoded !== "object") {
        unauthorized(res, err ? err.message : "invalid token");
        return;
      }
      // Optional caller (app) allow-list: v2 tokens use `azp`, v1 use `appid`.
      const payload = decoded as Record<string, unknown>;
      const caller =
        (typeof payload.azp === "string" && payload.azp) ||
        (typeof payload.appid === "string" && payload.appid) ||
        "";
      if (allowList.length > 0 && caller && !allowList.includes(caller)) {
        unauthorized(res, `caller ${caller} is not allowed`);
        return;
      }
      next();
    }
  );
}

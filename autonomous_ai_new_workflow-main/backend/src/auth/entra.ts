import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface EntraConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  authority: string;
  audience: string;
  defaultRole: "admin" | "user";
}

export interface EntraIdentity {
  oid: string;
  username: string;
  preferredUsername?: string;
  email?: string;
}

let jwksCache: { authority: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined;

export function isEntraEnabled(): boolean {
  return String(process.env.AZURE_ENTRA_ENABLED || "").trim().toLowerCase() === "true";
}

export function getEntraConfig(): EntraConfig {
  const tenantId = String(process.env.AZURE_ENTRA_TENANT_ID || "").trim();
  const clientId = String(process.env.AZURE_ENTRA_CLIENT_ID || "").trim();
  const authorityRaw = String(process.env.AZURE_ENTRA_AUTHORITY || "").trim();
  const authority = (authorityRaw || (tenantId ? `https://login.microsoftonline.com/${tenantId}` : ""))
    .replace(/\/+$/, "");
  const audience = String(process.env.AZURE_ENTRA_AUDIENCE || "").trim() || clientId;
  const roleRaw = String(process.env.AZURE_ENTRA_DEFAULT_ROLE || "user").trim().toLowerCase();
  const defaultRole: "admin" | "user" = roleRaw === "admin" ? "admin" : "user";

  return {
    enabled: isEntraEnabled(),
    tenantId,
    clientId,
    authority,
    audience,
    defaultRole,
  };
}

export function assertEntraConfigured(config: EntraConfig = getEntraConfig()): void {
  if (!config.enabled) {
    throw new EntraConfigError("Azure Entra ID sign-in is disabled. Set AZURE_ENTRA_ENABLED=true.");
  }
  if (!config.clientId) {
    throw new EntraConfigError("AZURE_ENTRA_CLIENT_ID is required when Azure Entra ID is enabled.");
  }
  if (!config.authority) {
    throw new EntraConfigError(
      "AZURE_ENTRA_AUTHORITY or AZURE_ENTRA_TENANT_ID is required when Azure Entra ID is enabled.",
    );
  }
  if (!config.audience) {
    throw new EntraConfigError("AZURE_ENTRA_AUDIENCE or AZURE_ENTRA_CLIENT_ID is required for token validation.");
  }
}

export class EntraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraConfigError";
  }
}

export class EntraTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraTokenError";
  }
}

function getJwks(authority: string) {
  if (!jwksCache || jwksCache.authority !== authority) {
    jwksCache = {
      authority,
      jwks: createRemoteJWKSet(new URL(`${authority}/discovery/v2.0/keys`)),
    };
  }
  return jwksCache.jwks;
}

function issuerCandidates(config: EntraConfig): string[] {
  const issuers = new Set<string>([
    `${config.authority}/v2.0`,
    config.authority,
  ]);
  if (config.tenantId) {
    issuers.add(`https://login.microsoftonline.com/${config.tenantId}/v2.0`);
    issuers.add(`https://sts.windows.net/${config.tenantId}/`);
  }
  return [...issuers];
}

function audienceCandidates(config: EntraConfig): string[] {
  const audiences = new Set<string>([config.audience, config.clientId].filter(Boolean));
  if (config.clientId) {
    audiences.add(`api://${config.clientId}`);
  }
  return [...audiences];
}

function claimString(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function usernameFromEntraClaims(input: {
  oid: string;
  preferredUsername?: string;
  email?: string;
}): string {
  const candidates = [input.preferredUsername, input.email].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const sanitized = candidate
      .replace(/@/g, ".")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 100);
    if (sanitized.length >= 3) return sanitized;
  }
  const compactOid = input.oid.replace(/-/g, "").slice(0, 20);
  return `entra_${compactOid}`;
}

export async function verifyEntraAccessToken(token: string): Promise<EntraIdentity> {
  const config = getEntraConfig();
  assertEntraConfigured(config);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getJwks(config.authority), {
      issuer: issuerCandidates(config),
      audience: audienceCandidates(config),
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Token validation failed";
    throw new EntraTokenError(detail);
  }

  const oid = claimString(payload, "oid") || claimString(payload, "sub");
  if (!oid) {
    throw new EntraTokenError("Entra token is missing the oid claim.");
  }

  const preferredUsername = claimString(payload, "preferred_username")
    || claimString(payload, "upn");
  const email = claimString(payload, "email") || preferredUsername;

  return {
    oid,
    preferredUsername,
    email,
    username: usernameFromEntraClaims({ oid, preferredUsername, email }),
  };
}

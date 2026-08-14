import crypto from "node:crypto";

export function semanticKeySlug(value: string): string {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return normalized || "connection";
}

export function semanticKeyBase(dbType: string, connectionName: string): string {
  return `${semanticKeySlug(dbType)}_${semanticKeySlug(connectionName)}`;
}

export function semanticKeyCandidate(base: string): string {
  return `${base}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}


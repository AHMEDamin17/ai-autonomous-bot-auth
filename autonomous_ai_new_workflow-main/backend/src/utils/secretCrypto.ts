import crypto from "node:crypto";

const PREFIX = "enc:v1:";
const PREFIX_V2 = "enc:v2:";
const KDF_ITERATIONS = 310_000;
const KEY_BYTES = 32;

function getSecretMaterial(): string | null {
  const material = process.env.CONNECTION_SECRET_KEY || process.env.APP_SECRET || "";
  if (!material.trim()) return null;
  return material;
}

// Startup check
if (!getSecretMaterial()) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("CRITICAL: CONNECTION_SECRET_KEY is missing in production. Refusing to store plaintext secrets.");
  } else {
    console.warn("WARNING: CONNECTION_SECRET_KEY is missing. Secrets will be stored in plaintext.");
  }
}

function deriveKey(material: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(material, salt, KDF_ITERATIONS, KEY_BYTES, "sha256");
}

function getLegacyKey(): Buffer | null {
  const material = getSecretMaterial();
  if (!material) return null;
  return crypto.createHash("sha256").update(material).digest();
}

export function encryptSecret(value?: string | null): string | null {
  if (!value) return value ?? null;
  if (value.startsWith(PREFIX) || value.startsWith(PREFIX_V2)) return value;
  const material = getSecretMaterial();
  if (!material) return value;

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(material, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX_V2}${salt.toString("base64")}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value?: string | null): string | null {
  if (!value) return value ?? null;
  if (!value.startsWith(PREFIX) && !value.startsWith(PREFIX_V2)) return value;
  const material = getSecretMaterial();
  if (!material) {
    throw new Error("CONNECTION_SECRET_KEY is required to decrypt stored connection credentials.");
  }

  if (value.startsWith(PREFIX_V2)) {
    const [saltText, ivText, tagText, encryptedText] = value.slice(PREFIX_V2.length).split(":");
    if (!saltText || !ivText || !tagText || !encryptedText) {
      throw new Error("Stored connection credential has an invalid encrypted format.");
    }

    const key = deriveKey(material, Buffer.from(saltText, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  const key = getLegacyKey();
  if (!key) {
    throw new Error("CONNECTION_SECRET_KEY is required to decrypt stored connection credentials.");
  }

  const [ivText, tagText, encryptedText] = value.slice(PREFIX.length).split(":");
  if (!ivText || !tagText || !encryptedText) {
    throw new Error("Stored connection credential has an invalid encrypted format.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function decryptConnectionSecrets<T extends { db_password?: string | null; credentials_json?: string | null }>(connection: T): T {
  return {
    ...connection,
    db_password: decryptSecret(connection.db_password) ?? undefined,
    credentials_json: decryptSecret(connection.credentials_json) ?? undefined,
  };
}

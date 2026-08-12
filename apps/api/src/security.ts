import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|credential|password|secret|token)/i;
const SENSITIVE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\bsk-[A-Za-z0-9_-]{16,})/i;

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
};

export const verifyPassword = async (password: string, encoded: string): Promise<boolean> => {
  const [algorithm, saltText, digestText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !digestText) return false;
  const expected = Buffer.from(digestText, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, Buffer.from(saltText, "base64url"), expected.length) as Buffer;
  return timingSafeEqual(actual, expected);
};

export const newSessionToken = (): string => randomBytes(32).toString("base64url");
export const hashSessionToken = (token: string): string => createHash("sha256").update(token).digest("base64url");

export const readCookie = (request: IncomingMessage, name: string): string | undefined => {
  for (const item of (request.headers.cookie ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
};

export const containsSensitiveValue = (value: unknown, key = ""): boolean => {
  if (SENSITIVE_KEY.test(key)) return true;
  if (typeof value === "string") return SENSITIVE_VALUE.test(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveValue(item));
  if (value && typeof value === "object") return Object.entries(value).some(([childKey, child]) => containsSensitiveValue(child, childKey));
  return false;
};

export const redactMetadata = (metadata: Record<string, unknown>): Record<string, string | number | boolean | null> => Object.fromEntries(
  Object.entries(metadata).map(([key, value]) => {
    if (SENSITIVE_KEY.test(key) || (typeof value === "string" && SENSITIVE_VALUE.test(value))) return [key, "[REDACTED]"];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return [key, value];
    return [key, "[REDACTED]"];
  })
);

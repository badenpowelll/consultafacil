import { createHash, randomBytes } from "node:crypto";

/**
 * Tokens opacos para sessões e links de ação. O valor em claro só existe no cookie ou no link;
 * o banco guarda apenas o SHA-256 (256 bits aleatórios dispensam sal e HMAC).
 */
export function gerarTokenOpaco(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDoToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function formatoDeTokenValido(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

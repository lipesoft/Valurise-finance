import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey() {
  const encoded = process.env.VALURISE_AI_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Criptografia da IA pessoal não está configurada.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Chave de criptografia da IA pessoal inválida.");
  return key;
}

/** AES-256-GCM envelope. The browser never receives the plaintext API key. */
export function encryptPersonalAiKey(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptPersonalAiKey(envelope: string) {
  const [ivValue, tagValue, ciphertext] = envelope.split(".");
  if (!ivValue || !tagValue || !ciphertext) throw new Error("Conexão de IA inválida.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

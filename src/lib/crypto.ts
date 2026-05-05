import { arrayBufferToBase64, base64ToArrayBuffer, bytesToText, randomBase64, textToBytes } from "./encoding";
import type { DecryptedEnvelope, DecryptedMessage, EncryptedPayload, MessageResponse } from "../types";

const AES_GCM_IV_BYTES = 12;
const PBKDF2_ITERATIONS = 310000;
const PBKDF2_SALT_BYTES = 16;

export interface GeneratedIdentity {
  publicKey: string;
  wrappedPrivateKey: string;
  pbkdf2Salt: string;
  privateKey: CryptoKey;
}

function ensureCryptoAvailable() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is not available in this browser.");
  }

  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new Error("A secure context is required. Open WhisperBox over HTTPS or localhost.");
  }
}

async function deriveWrappingKey(password: string, saltBase64: string): Promise<CryptoKey> {
  ensureCryptoAvailable();

  const baseKey = await crypto.subtle.importKey(
    "raw",
    textToBytes(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToArrayBuffer(saltBase64),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

function serializeWrappedPrivateKey(iv: Uint8Array, ciphertext: ArrayBuffer): string {
  const normalizedIv = new Uint8Array(iv.buffer, iv.byteOffset, iv.byteLength);
  return JSON.stringify({
    iv: arrayBufferToBase64(normalizedIv as unknown as BufferSource),
    ciphertext: arrayBufferToBase64(ciphertext),
  });
}

function deserializeWrappedPrivateKey(serialized: string): { iv: Uint8Array; ciphertext: ArrayBuffer } {
  const parsed = JSON.parse(serialized) as { iv?: unknown; ciphertext?: unknown };

  if (typeof parsed !== "object" || parsed === null || typeof parsed.iv !== "string" || typeof parsed.ciphertext !== "string") {
    throw new Error("Invalid wrapped private key payload.");
  }

  return {
    iv: new Uint8Array(base64ToArrayBuffer(parsed.iv)) as Uint8Array,
    ciphertext: base64ToArrayBuffer(parsed.ciphertext),
  };
}

export async function importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  ensureCryptoAvailable();

  return crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(publicKeyBase64),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
}

export async function generateIdentity(password: string): Promise<GeneratedIdentity> {
  ensureCryptoAvailable();

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const pbkdf2Salt = randomBase64(PBKDF2_SALT_BYTES);
  const wrappingKey = await deriveWrappingKey(password, pbkdf2Salt);
  const exportedPublicKey = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  const iv = new Uint8Array(AES_GCM_IV_BYTES);
  crypto.getRandomValues(iv);
  const wrappedPrivateKeyBuffer = await crypto.subtle.wrapKey(
    "pkcs8",
    keyPair.privateKey,
    wrappingKey,
    {
      name: "AES-GCM",
      iv,
    },
  );

  return {
    publicKey: arrayBufferToBase64(exportedPublicKey),
    wrappedPrivateKey: serializeWrappedPrivateKey(iv, wrappedPrivateKeyBuffer),
    pbkdf2Salt,
    privateKey: keyPair.privateKey,
  };
}

export async function unwrapPrivateKey(
  password: string,
  wrappedPrivateKeyBase64: string,
  pbkdf2SaltBase64: string,
): Promise<CryptoKey> {
  ensureCryptoAvailable();

  const wrappingKey = await deriveWrappingKey(password, pbkdf2SaltBase64);
  const { iv, ciphertext } = deserializeWrappedPrivateKey(wrappedPrivateKeyBase64);
  return crypto.subtle.unwrapKey(
    "pkcs8",
    ciphertext,
    wrappingKey,
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv.buffer, iv.byteOffset, iv.byteLength) as unknown as BufferSource,
    },
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["decrypt"],
  );
}

export async function encryptMessage(
  plaintext: string,
  recipientPublicKeyBase64: string,
  senderPublicKeyBase64: string,
): Promise<{ payload: EncryptedPayload; nonce: string }> {
  ensureCryptoAvailable();

  const messageKey = await crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const nonce = crypto.randomUUID();
  const envelope: DecryptedEnvelope = {
    version: 1,
    body: plaintext,
    nonce,
    sentAt: new Date().toISOString(),
  };
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    messageKey,
    textToBytes(JSON.stringify(envelope)),
  );
  const exportedMessageKey = await crypto.subtle.exportKey("raw", messageKey);
  const [recipientPublicKey, senderPublicKey] = await Promise.all([
    importPublicKey(recipientPublicKeyBase64),
    importPublicKey(senderPublicKeyBase64),
  ]);
  const [encryptedKey, encryptedKeyForSelf] = await Promise.all([
    crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipientPublicKey, exportedMessageKey),
    crypto.subtle.encrypt({ name: "RSA-OAEP" }, senderPublicKey, exportedMessageKey),
  ]);

  return {
    nonce,
    payload: {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv),
      encryptedKey: arrayBufferToBase64(encryptedKey),
      encryptedKeyForSelf: arrayBufferToBase64(encryptedKeyForSelf),
    },
  };
}

function parseEnvelope(value: string): DecryptedMessage {
  try {
    const parsed = JSON.parse(value) as Partial<DecryptedEnvelope>;

    if (typeof parsed.body === "string") {
      return {
        body: parsed.body,
        nonce: typeof parsed.nonce === "string" ? parsed.nonce : undefined,
        sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : undefined,
      };
    }

    // If parsed has a version field but body isn't a string, that's malformed
    if (typeof parsed.version === "number") {
      console.warn("Malformed envelope: version present but body is not a string", parsed);
      return {
        body: "[Malformed message format - invalid body type]",
      };
    }
  } catch (error) {
    // Gracefully fall back to raw text for older or malformed payloads.
    console.warn("Failed to parse envelope", error, value);
  }

  return {
    body: value,
  };
}

function isEncryptedPayload(payload: unknown): payload is EncryptedPayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const candidate = payload as Partial<EncryptedPayload>;
  return (
    typeof candidate.ciphertext === "string" &&
    typeof candidate.iv === "string" &&
    typeof candidate.encryptedKey === "string" &&
    typeof candidate.encryptedKeyForSelf === "string"
  );
}

export async function decryptMessage(
  message: MessageResponse,
  privateKey: CryptoKey,
  selfUserId: string,
): Promise<DecryptedMessage> {
  ensureCryptoAvailable();

  // Check if payload has a direct "body" field with JSON envelope (backend issue fallback)
  if (
    typeof (message.payload as any)?.body === "string" &&
    !isEncryptedPayload(message.payload)
  ) {
    console.warn(
      "Warning: Message received with plaintext body field instead of encrypted payload. " +
        "This may indicate a backend configuration issue."
    );
    const bodyText = (message.payload as any).body;
    // Try to parse it as an envelope
    try {
      const parsed = JSON.parse(bodyText) as Partial<DecryptedEnvelope>;
      if (typeof parsed.body === "string") {
        return {
          body: parsed.body,
          nonce: typeof parsed.nonce === "string" ? parsed.nonce : undefined,
          sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : undefined,
        };
      }
    } catch {
      // Not an envelope, return as-is
      return { body: bodyText };
    }
    // If it has version but invalid structure
    return { body: bodyText };
  }

  if (!isEncryptedPayload(message.payload)) {
    console.error(
      "Unsupported encrypted payload format. Payload structure:",
      message.payload
    );
    throw new Error("Unsupported encrypted payload format.");
  }

  const wrappedKey = message.from_user_id === selfUserId ? message.payload.encryptedKeyForSelf : message.payload.encryptedKey;
  const rawMessageKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, base64ToArrayBuffer(wrappedKey));
  const messageKey = await crypto.subtle.importKey(
    "raw",
    rawMessageKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["decrypt"],
  );
  const plaintextBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToArrayBuffer(message.payload.iv),
    },
    messageKey,
    base64ToArrayBuffer(message.payload.ciphertext),
  );

  return parseEnvelope(bytesToText(plaintextBuffer));
}

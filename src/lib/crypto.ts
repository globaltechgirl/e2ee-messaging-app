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

async function deriveWrappingKey(password: string, saltBase64: string): Promise<CryptoKey> {
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
    ["encrypt", "decrypt"],
  );
}

export async function importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(publicKeyBase64),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["encrypt"],
  );
}

export async function generateIdentity(password: string): Promise<GeneratedIdentity> {
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
  const exportedPrivateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const wrappedPrivateKey = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    wrappingKey,
    exportedPrivateKey,
  );

  // Prepend IV to the encrypted data
  const wrappedWithIv = new Uint8Array(iv.length + wrappedPrivateKey.byteLength);
  wrappedWithIv.set(iv);
  wrappedWithIv.set(new Uint8Array(wrappedPrivateKey), iv.length);

  return {
    publicKey: arrayBufferToBase64(exportedPublicKey),
    wrappedPrivateKey: arrayBufferToBase64(wrappedWithIv),
    pbkdf2Salt,
    privateKey: keyPair.privateKey,
  };
}

export async function unwrapPrivateKey(
  password: string,
  wrappedPrivateKeyBase64: string,
  pbkdf2SaltBase64: string,
): Promise<CryptoKey> {
  const wrappingKey = await deriveWrappingKey(password, pbkdf2SaltBase64);
  const wrappedWithIv = base64ToArrayBuffer(wrappedPrivateKeyBase64);
  const wrappedData = new Uint8Array(wrappedWithIv);

  if (wrappedData.length < AES_GCM_IV_BYTES) {
    throw new Error("Invalid wrapped private key data: too short");
  }

  const iv = wrappedData.slice(0, AES_GCM_IV_BYTES);
  const encryptedData = wrappedData.slice(AES_GCM_IV_BYTES);

  const decryptedPrivateKey = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    wrappingKey,
    encryptedData,
  );

  return crypto.subtle.importKey(
    "pkcs8",
    decryptedPrivateKey,
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
  } catch {
    // Gracefully fall back to raw text for older or malformed payloads.
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
  if (!isEncryptedPayload(message.payload)) {
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

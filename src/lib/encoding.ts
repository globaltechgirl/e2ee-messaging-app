const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function textToBytes(value: string): ArrayBuffer {
  return toArrayBuffer(encoder.encode(value));
}

export function bytesToText(value: BufferSource): string {
  return decoder.decode(toUint8Array(value));
}

export function arrayBufferToBase64(value: BufferSource): string {
  const view = toUint8Array(value);
  let binary = "";

  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return toArrayBuffer(bytes);
}

export function arrayBufferToHex(value: BufferSource): string {
  const view = toUint8Array(value);
  return Array.from(view, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomBase64(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return arrayBufferToBase64(bytes);
}

function toUint8Array(value: BufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  const copy = new Uint8Array(value.byteLength);
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return copy;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

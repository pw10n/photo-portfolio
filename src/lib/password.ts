function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function hashPassword(
  password: string,
  saltB64: string,
): Promise<string> {
  const enc = new TextEncoder();
  const pwBytes = enc.encode(password);
  const saltBytes = base64ToBytes(saltB64);
  const combined = new Uint8Array(pwBytes.length + saltBytes.length);
  combined.set(pwBytes, 0);
  combined.set(saltBytes, pwBytes.length);
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyPassword(
  attempt: string,
  saltB64: string,
  expectedHashHex: string,
): Promise<boolean> {
  const candidate = await hashPassword(attempt, saltB64);
  return timingSafeEqualHex(candidate, expectedHashHex);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

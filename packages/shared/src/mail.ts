/**
 * Minimal RFC 5322 handling for the relay's mailbox frames. The mailbox module
 * returns each message as its raw frame (base64). Protocol payloads are
 * base64url text, so the body survives any transfer encoding unchanged.
 */
export function bodyOfFrame(raw: Uint8Array | string): string {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const idx = text.indexOf("\r\n\r\n");
  const body = idx === -1 ? text.slice(text.indexOf("\n\n") + 2) : text.slice(idx + 4);
  return body.replace(/\s+/g, "");
}

export function headerOfFrame(raw: Uint8Array | string, name: string): string | undefined {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const end = text.indexOf("\r\n\r\n");
  const head = end === -1 ? text : text.slice(0, end);
  const lines = head.split(/\r?\n/);
  const lower = `${name.toLowerCase()}:`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.toLowerCase().startsWith(lower)) {
      let value = line.slice(lower.length).trim();
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1]!)) {
        value += " " + lines[++i]!.trim();
      }
      return value;
    }
  }
  return undefined;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Decodes the text of a Messages row whose `text` column is NULL.
 *
 * Since macOS 13, Messages stores the body in `message.attributedBody`, an
 * NSKeyedArchiver/typedstream blob of an NSAttributedString. The blob has no
 * public reader; this is the widely used heuristic: the string payload sits
 * right after the class name "NSString" and a short type marker ending in
 * '+' (0x2B), prefixed by its byte length. The length is one byte, or 0x81
 * followed by a little-endian uint16, or 0x82 followed by a little-endian
 * uint32, as typedstream encodes integers.
 *
 * Returns null when the blob does not follow that layout; the caller treats
 * null as "no text".
 */
const NSSTRING = Buffer.from("NSString", "latin1");
/** Bytes between "NSString" and the length prefix: 01 94 84 01 2B on every macOS seen so far. */
const MARKER_SEARCH_WINDOW = 8;
const PLUS = 0x2b;

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function decodeAttributedBody(blob: Uint8Array | Buffer | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);

  const nameAt = buf.indexOf(NSSTRING);
  if (nameAt < 0) return null;

  // Skip the type marker: scan a short window for the '+' that ends it.
  let pos = nameAt + NSSTRING.length;
  const windowEnd = Math.min(buf.length, pos + MARKER_SEARCH_WINDOW);
  let plusAt = -1;
  for (let i = pos; i < windowEnd; i++) {
    if (buf[i] === PLUS) {
      plusAt = i;
      break;
    }
  }
  if (plusAt < 0) return null;
  pos = plusAt + 1;

  // Length prefix.
  if (pos >= buf.length) return null;
  const first = buf[pos]!;
  let length: number;
  if (first === 0x81) {
    if (pos + 3 > buf.length) return null;
    length = buf.readUInt16LE(pos + 1);
    pos += 3;
  } else if (first === 0x82) {
    if (pos + 5 > buf.length) return null;
    length = buf.readUInt32LE(pos + 1);
    pos += 5;
  } else {
    length = first;
    pos += 1;
  }
  if (length === 0 || pos + length > buf.length) return null;

  try {
    return utf8.decode(buf.subarray(pos, pos + length));
  } catch {
    // Not valid UTF-8 at the position the layout predicted: the blob does not follow the layout.
    return null;
  }
}

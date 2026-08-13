/**
 * Content-based MIME detection.
 *
 * The browser-supplied `Content-Type` and the filename extension are both
 * attacker-controlled, so uploads are classified by sniffing magic bytes. A
 * file only passes when the sniffed type is in the allowlist AND matches what
 * the client claimed (a mismatch is a strong signal of an attack).
 */

export interface SniffResult {
  mime: string;
  extension: string;
  width?: number;
  height?: number;
}

/** Formats we are willing to store and serve. */
export const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Byte signatures that must never be accepted, even if the extension looks
 * benign — scripts, executables and archives.
 */
const DANGEROUS_SIGNATURES: { bytes: number[]; label: string }[] = [
  { bytes: [0x3c, 0x3f, 0x70, 0x68, 0x70], label: 'php' }, // <?php
  { bytes: [0x3c, 0x3f], label: 'xml-or-php' }, // <?
  { bytes: [0x3c, 0x21, 0x44, 0x4f, 0x43], label: 'html' }, // <!DOC
  { bytes: [0x3c, 0x68, 0x74, 0x6d, 0x6c], label: 'html' }, // <html
  { bytes: [0x3c, 0x73, 0x76, 0x67], label: 'svg' }, // <svg
  { bytes: [0x3c, 0x73, 0x63, 0x72, 0x69], label: 'script' }, // <scri
  { bytes: [0x4d, 0x5a], label: 'exe' }, // MZ
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'elf' }, // \x7FELF
  { bytes: [0x23, 0x21], label: 'shebang' }, // #!
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'zip' }, // PK..
  { bytes: [0xca, 0xfe, 0xba, 0xbe], label: 'java-class' },
  { bytes: [0x25, 0x50, 0x44, 0x46], label: 'pdf' }, // %PDF
];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** Detect a supported image type from magic bytes, or null. */
export function sniffMime(bytes: Uint8Array): SniffResult | null {
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', extension: 'jpg', ...readJpegSize(bytes) };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', extension: 'png', ...readPngSize(bytes) };
  }

  // GIF: GIF87a / GIF89a
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { mime: 'image/gif', extension: 'gif', ...readGifSize(bytes) };
  }

  // WEBP: RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mime: 'image/webp', extension: 'webp', ...readWebpSize(bytes) };
  }

  return null;
}

/** Identify obviously hostile payloads for a precise error message. */
export function detectDangerous(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 64);
  for (const sig of DANGEROUS_SIGNATURES) {
    if (startsWith(head, sig.bytes)) return sig.label;
  }
  // Leading whitespace then '<' — HTML/SVG/XML smuggling.
  let i = 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  if (head[i] === 0x3c) return 'markup';
  return null;
}

export function extensionForMime(mime: string): string {
  return EXTENSION_BY_MIME[mime] ?? 'bin';
}

export function isAllowedImageMime(mime: string, allowlist: string[]): boolean {
  return IMAGE_MIME_TYPES.has(mime) && allowlist.includes(mime);
}

// --- dimension parsers ------------------------------------------------------

function readPngSize(bytes: Uint8Array): { width?: number; height?: number } {
  if (bytes.length < 24) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readGifSize(bytes: Uint8Array): { width?: number; height?: number } {
  if (bytes.length < 10) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readJpegSize(bytes: Uint8Array): { width?: number; height?: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // SOF0..SOF15, excluding DHT(C4), JPG(C8) and DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    const length = view.getUint16(offset + 2);
    if (length <= 0) break;
    offset += 2 + length;
  }
  return {};
}

function readWebpSize(bytes: Uint8Array): { width?: number; height?: number } {
  if (bytes.length < 30) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

  if (format === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (format === 'VP8L') {
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (format === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }
  return {};
}

/** Strip directory components and dangerous characters from a client filename. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
}

/**
 * Minimal ZIP writer, STORE method only (no compression). The exports it
 * serves are a handful of small UTF-8 text files, so DEFLATE would buy
 * nothing and this keeps the app dependency-free. Filenames are written with
 * the UTF-8 flag (general-purpose bit 11) set.
 */

export interface ZipEntry {
  /** Zip-relative path, forward slashes, e.g. "folder/note.md". */
  path: string;
  data: string | Uint8Array;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time pair as stored in zip headers (2-second resolution). */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date:
      ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

export function createZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);

  interface Prepared {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }

  const prepared: Prepared[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.length;
  };

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);
    prepared.push({ nameBytes, data, crc, offset });

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flags: UTF-8 filenames
    local.setUint16(8, 0, true); // method: STORE
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // compressed size
    local.setUint32(22, data.length, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length
    push(new Uint8Array(local.buffer));
    push(nameBytes);
    push(data);
  }

  const centralStart = offset;
  for (const p of prepared) {
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central directory signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, p.crc, true);
    central.setUint32(20, p.data.length, true);
    central.setUint32(24, p.data.length, true);
    central.setUint16(28, p.nameBytes.length, true);
    // extra, comment, disk, internal attrs, external attrs all zero (30..42)
    central.setUint32(42, p.offset, true);
    push(new Uint8Array(central.buffer));
    push(p.nameBytes);
  }
  const centralSize = offset - centralStart;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central directory signature
  eocd.setUint16(8, prepared.length, true); // entries on this disk
  eocd.setUint16(10, prepared.length, true); // total entries
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  push(new Uint8Array(eocd.buffer));

  const out = new Uint8Array(offset);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

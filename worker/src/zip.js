// Streaming ZIP writer (store-only, ZIP32). Photos are already compressed, so
// no deflate: the bytes are copied through while a CRC32 is computed.
//
// Photos arrive as complete buffers, so their local header carries the real
// CRC and sizes (no data descriptor) — macOS Archive Utility needs that for
// stored entries. Videos are streamed (too big to buffer): CRC and size are
// only known at the end, so they use a trailing data descriptor.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const enc = new TextEncoder();
const MAX32 = 0xffffffff;

function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function localHeader(nameBytes, flags, crc, size, dt) {
  const h = new DataView(new ArrayBuffer(30));
  h.setUint32(0, 0x04034b50, true);
  h.setUint16(4, 20, true);              // version needed
  h.setUint16(6, flags, true);           // bit 11 = UTF-8 names, bit 3 = data descriptor
  h.setUint16(8, 0, true);               // method: stored
  h.setUint16(10, dt.time, true);
  h.setUint16(12, dt.date, true);
  h.setUint32(14, crc, true);
  h.setUint32(18, size, true);           // compressed size
  h.setUint32(22, size, true);           // uncompressed size
  h.setUint16(26, nameBytes.length, true);
  h.setUint16(28, 0, true);              // extra length
  return concat([new Uint8Array(h.buffer), nameBytes]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * entries: async iterable of {name, date?, data, size?}
 *   data: Uint8Array (whole file) | ReadableStream | async iterable of Uint8Array
 *   size: optional known byte length for streamed data (written into the header)
 * Yields Uint8Array chunks of the finished zip.
 */
export async function* zipStream(entries) {
  const central = [];
  let offset = 0;
  const advance = (chunk) => { offset += chunk.length; return chunk; };

  for await (const entry of entries) {
    if (central.length >= 0xffff) throw new Error("zip: too many entries");
    const nameBytes = enc.encode(entry.name);
    const dt = dosDateTime(entry.date || new Date());
    const headerOffset = offset;
    let crc, size, flags;

    if (entry.data instanceof Uint8Array) {
      crc = crc32(entry.data);
      size = entry.data.length;
      flags = 0x0800;
      yield advance(localHeader(nameBytes, flags, crc, size, dt));
      yield advance(entry.data);
    } else {
      flags = 0x0808;
      yield advance(localHeader(nameBytes, flags, 0, entry.size || 0, dt));
      crc = 0;
      size = 0;
      for await (const chunk of iterate(entry.data)) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        yield advance(chunk);
      }
      const d = new DataView(new ArrayBuffer(16));
      d.setUint32(0, 0x08074b50, true);
      d.setUint32(4, crc, true);
      d.setUint32(8, size, true);
      d.setUint32(12, size, true);
      yield advance(new Uint8Array(d.buffer));
    }
    if (size > MAX32 || offset > MAX32) throw new Error("zip: over 4 GiB (ZIP64 not supported)");
    central.push({ nameBytes, flags, crc, size, dt, headerOffset });
  }

  const cdStart = offset;
  for (const e of central) {
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);            // version made by
    c.setUint16(6, 20, true);            // version needed
    c.setUint16(8, e.flags, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, e.dt.time, true);
    c.setUint16(14, e.dt.date, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.size, true);
    c.setUint32(24, e.size, true);
    c.setUint16(28, e.nameBytes.length, true);
    c.setUint32(38, 0o100644 << 16 >>> 0, true); // external attrs: regular file 0644
    c.setUint32(42, e.headerOffset, true);
    yield advance(concat([new Uint8Array(c.buffer), e.nameBytes]));
  }
  const cdSize = offset - cdStart;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, cdStart, true);
  yield new Uint8Array(end.buffer);
}

async function* iterate(data) {
  if (typeof data[Symbol.asyncIterator] === "function") { yield* data; return; }
  const reader = data.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Wrap an async generator as a ReadableStream with backpressure. */
export function generatorToStream(gen) {
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await gen.return(reason);
    },
  });
}

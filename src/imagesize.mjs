/* Intrinsic pixel dimensions from an image file's header.

   Two callers need this and neither wants a dependency for it: Markdown posts
   get width/height attributes so images do not shift the layout while they
   load, and the OG card needs the aspect ratio to crop a hero image to 1200x630
   without squashing it. Returns null for anything it does not recognise, which
   callers treat as "just omit the dimensions". */

/** @returns {{width:number,height:number}|null} */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  return png(buf) || gif(buf) || webp(buf) || jpeg(buf) || null;
}

function png(b) {
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  /* IHDR is required to be the first chunk, so width/height sit at a fixed
     offset. Guard the chunk type anyway rather than trusting the signature. */
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b) {
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webp(b) {
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) {
    /* lossy: 14-bit dimensions after the 3-byte start code */
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    /* lossless: 14 bits width then 14 bits height, packed little-endian */
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    /* extended: 24-bit minus-one dimensions */
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

function jpeg(b) {
  if (b.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }        /* resync on fill bytes */
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    /* standalone markers carry no length payload */
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    /* SOF0..SOF15 hold the frame size; DHT/JPG/DAC share the range but do not */
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xda) return null;            /* scan data; no size found */
    i += 2 + len;
  }
  return null;
}

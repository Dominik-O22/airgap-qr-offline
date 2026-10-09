// Wire format and erasure code shared by the sender and the receiver.
// Expects pako to be loaded first.
//
// A transfer is one blob: gzip([u16 name length][name, UTF-8][file bytes]).
// The blob is cut into K chunks of C bytes (the last one zero padded) and
// every QR code carries one binary frame, integers big-endian:
//
//   byte 0       magic 0xA9
//   bytes 1-4    transfer id (the blob's gzip CRC32, so a re-send matches)
//   bytes 5-8    blob length
//   bytes 9-10   chunk size C
//   bytes 11-14  frame id
//   bytes 15..   C payload bytes
//
// Frames 0..K-1 carry chunk number <frame id>. Every later frame is a repair
// frame: the XOR of a pseudo-random subset of chunks derived from its id.
// The receiver solves for lost chunks by Gaussian elimination, so any K
// linearly independent frames rebuild the blob, whichever ones were missed.
//
// A QR code carries one frame and relies on QR's own error correction. A grid
// code (grid.js) has none and carries several frames at once, as a bundle:
// each frame followed by its CRC32, back to back, so damage to one part of
// the picture only costs the frames it touches.
var AirgapCodec = (function () {
  var MAGIC = 0xa9;
  var HEADER = 15;
  var MAX_CHUNKS = 200000;
  var MAX_SIZE = 64 * 1024 * 1024;
  var MAX_NAME = 5000;
  // A repair frame XORs about this many chunks (half of them for small
  // transfers), which bounds the work per frame on both sides.
  var REPAIR_DEGREE = 1024;
  // Unsolved repair frames the receiver keeps. Past this it waits for plain
  // chunks, which bounds memory and the cost of reducing each new frame.
  var MAX_ROWS = 2048;

  // Chunk numbers XORed into frame `id` of a k-chunk transfer (mulberry32
  // seeded with the id, so both sides derive the same subset).
  var sources = function (id, k) {
    if (id < k) return [id];
    var out = [];
    var limit = Math.min(0.5, REPAIR_DEGREE / k) * 4294967296;
    var a = id | 0;
    for (var i = 0; i < k; i++) {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      if (((t ^ (t >>> 14)) >>> 0) < limit) out.push(i);
    }
    if (!out.length) out.push(id % k);
    return out;
  };

  // dst ^= src[offset .. offset + dst.length), stopping at the end of src.
  var xor = function (dst, src, offset) {
    var n = Math.min(dst.length, src.length - offset);
    for (var i = 0; i < n; i++) dst[i] ^= src[offset + i];
  };

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  var crc32 = function (bytes, start, end) {
    var c = 0xffffffff;
    for (var i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  // Sender: packs frames of one size into `capacity` bytes for a grid code.
  var bundle = function (frames, capacity) {
    var out = new Uint8Array(capacity), view = new DataView(out.buffer), o = 0;
    frames.forEach(function (f) {
      out.set(f, o);
      view.setUint32(o + f.length, crc32(f, 0, f.length));
      o += f.length + 4;
    });
    return out;
  };

  // Receiver: the frames of a bundle whose checksums hold. The frame size
  // comes from the first frame's header; if that frame is damaged,
  // `known_size` (returned as `size` by an earlier call) is used instead.
  var unbundle = function (bytes, known_size) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var intact = function (o, size) {
      return size > HEADER && o + size + 4 <= bytes.length && bytes[o] === MAGIC &&
             crc32(bytes, o, o + size) === view.getUint32(o + size);
    };
    var size = bytes.length >= HEADER ? HEADER + view.getUint16(9) : 0;
    if (!intact(0, size)) size = known_size;
    var frames = [];
    if (size) {
      for (var o = 0; o + size + 4 <= bytes.length; o += size + 4) {
        if (intact(o, size)) frames.push(bytes.subarray(o, o + size));
      }
    }
    return { frames: frames, size: frames.length ? size : 0 };
  };

  // Sender: builds the blob for a named file.
  var pack = function (name, bytes) {
    var name_bytes = new TextEncoder().encode(name);
    var plain = new Uint8Array(2 + name_bytes.length + bytes.length);
    new DataView(plain.buffer).setUint16(0, name_bytes.length);
    plain.set(name_bytes, 2);
    plain.set(bytes, 2 + name_bytes.length);
    return pako.gzip(plain, { level: 9 });
  };

  // Receiver: reverses pack(). Throws on anything that is not a valid blob.
  var unpack = function (blob) {
    if (blob.length < 18) throw new Error("not a gzip stream");
    // gzip ends with the uncompressed length; refuse oversized claims up front
    var claimed = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
      .getUint32(blob.length - 4, true);
    if (claimed > MAX_SIZE + MAX_NAME + 2) throw new Error("file too large");
    var plain = pako.inflate(blob);
    if (plain.length < 2) throw new Error("missing file name");
    var name_length = new DataView(plain.buffer, plain.byteOffset).getUint16(0);
    if (name_length > MAX_NAME || 2 + name_length > plain.length) {
      throw new Error("bad file name length");
    }
    return {
      name: new TextDecoder().decode(plain.subarray(2, 2 + name_length)),
      bytes: plain.subarray(2 + name_length)
    };
  };

  // Sender: frame source for a blob, given how many bytes one QR code holds.
  // frame(id) returns the bytes to put in the code.
  var encoder = function (blob, capacity) {
    var c = Math.min(capacity - HEADER, blob.length);
    var k = Math.ceil(blob.length / c);
    var id = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
      .getUint32(blob.length - 8);
    return {
      chunks: k,
      frame_size: HEADER + c,
      frame: function (frame_id) {
        var out = new Uint8Array(HEADER + c);
        var view = new DataView(out.buffer);
        view.setUint8(0, MAGIC);
        view.setUint32(1, id);
        view.setUint32(5, blob.length);
        view.setUint16(9, c);
        view.setUint32(11, frame_id);
        var data = out.subarray(HEADER);
        sources(frame_id, k).forEach(function (i) { xor(data, blob, i * c); });
        return out;
      }
    };
  };

  // Receiver: reads one QR payload. Returns null unless it is a well-formed
  // frame within the size limits.
  var parse = function (bytes) {
    if (!bytes || bytes.length <= HEADER || bytes[0] !== MAGIC) return null;
    var raw = Uint8Array.from(bytes);
    var view = new DataView(raw.buffer);
    var size = view.getUint32(5), c = view.getUint16(9);
    if (size < 1 || size > MAX_SIZE || c < 1 || c > size) return null;
    if (raw.length !== HEADER + c) return null;
    var k = Math.ceil(size / c);
    if (k > MAX_CHUNKS) return null;
    return {
      key: view.getUint32(1) + "/" + size + "/" + c, // identifies the transfer
      size: size, chunk_size: c, chunks: k,
      frame: view.getUint32(11),
      data: raw.subarray(HEADER)
    };
  };

  // Receiver: collects the frames of the transfer `first` belongs to.
  var decoder = function (first) {
    var k = first.chunks, c = first.chunk_size;
    var store = new Uint8Array(k * c);  // chunk i lives at i * c once known
    var known = new Uint8Array(k), known_count = 0;
    // Unsolved repair frames in echelon form: pivot[i] is the row whose
    // lowest unknown chunk is i. `bits` marks the chunks still XORed into
    // `data`; bits of chunks learned later are cleared lazily.
    var pivot = new Array(k), pivot_count = 0;
    var words = Math.ceil(k / 32);

    // Eliminates known chunks and existing pivots from a row, then files it
    // under its lowest remaining chunk. A row that reduces to nothing told
    // us nothing new and is dropped.
    var reduce = function (row) {
      for (var w = 0; w < words; w++) {
        while (row.bits[w]) {
          var bit = 31 - Math.clz32(row.bits[w] & -row.bits[w]);
          var i = w * 32 + bit;
          if (known[i]) {
            xor(row.data, store, i * c);
            row.bits[w] ^= 1 << bit;
          } else if (pivot[i]) {
            for (var v = w; v < words; v++) row.bits[v] ^= pivot[i].bits[v];
            xor(row.data, pivot[i].data, 0);
          } else {
            pivot[i] = row;
            pivot_count++;
            return;
          }
        }
      }
    };

    var learn = function (i, data) {
      store.set(data, i * c);
      known[i] = 1;
      known_count++;
      var row = pivot[i];
      if (row) {
        // the row that was going to yield chunk i now constrains other chunks
        pivot[i] = null;
        pivot_count--;
        reduce(row);
      }
    };

    return {
      key: first.key,
      chunks: k,
      size: first.size,
      // Independent frames collected so far; the transfer is done at `chunks`.
      rank: function () { return known_count + pivot_count; },
      add: function (f) {
        if (f.frame < k) {
          if (!known[f.frame]) learn(f.frame, f.data);
          return;
        }
        if (pivot_count >= MAX_ROWS) return;
        var row = { bits: new Uint32Array(words), data: f.data };
        sources(f.frame, k).forEach(function (i) { row.bits[i >>> 5] |= 1 << (i & 31); });
        reduce(row);
      },
      // The reassembled blob. Only valid once rank() equals chunks: every
      // chunk is then known or a pivot, so back-substitution from the last
      // chunk down resolves each row.
      blob: function () {
        for (var p = k - 1; p >= 0; p--) {
          var row = pivot[p];
          if (!row) continue;
          for (var i = p + 1; i < k; i++) {
            if (row.bits[i >>> 5] & (1 << (i & 31))) xor(row.data, store, i * c);
          }
          store.set(row.data, p * c);
          known[p] = 1;
          known_count++;
          pivot[p] = null;
          pivot_count--;
        }
        return store.subarray(0, first.size);
      }
    };
  };

  return { MAX_SIZE: MAX_SIZE, MAX_CHUNKS: MAX_CHUNKS,
           pack: pack, unpack: unpack, encoder: encoder, parse: parse, decoder: decoder,
           bundle: bundle, unbundle: unbundle };
})();

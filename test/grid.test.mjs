// Tests for the grid code (offline/templates/grid.js) and the checksummed
// frame bundles it carries. The sender's picture is painted into a pixel
// buffer, placed on a cluttered "screen", resampled the way a capture of a
// scaled window would be, then located and read back.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { loadLibs } from "./helpers.mjs";

const { AirgapCodec, AirgapGrid } = loadLibs();

// A screen showing the picture at (left, top) on a striped background.
function screenWith(picture, lay, left, top) {
  const width = lay.width + left + 90, height = lay.height + top + 70;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = ((x >> 3) + (y >> 2)) % 2 ? 35 : 215;
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  for (let y = 0; y < lay.height; y++) {
    const row = picture.subarray(y * lay.width * 4, (y + 1) * lay.width * 4);
    data.set(row, ((y + top) * width + left) * 4);
  }
  return { data, width, height };
}

// Bilinear resample by `scale`, as a compositor or remote desktop client does.
function resample(image, scale) {
  if (scale === 1) return image;
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(image.height - 1.001, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(fy), ay = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(image.width - 1.001, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(fx), ax = fx - x0;
      for (let ch = 0; ch < 4; ch++) {
        const p = (dx, dy) => image.data[((y0 + dy) * image.width + x0 + dx) * 4 + ch];
        data[(y * width + x) * 4 + ch] =
          p(0, 0) * (1 - ax) * (1 - ay) + p(1, 0) * ax * (1 - ay) +
          p(0, 1) * (1 - ax) * ay + p(1, 1) * ax * ay;
      }
    }
  }
  return { data, width, height };
}

// Paints random bytes into a grid picture and returns what a capture sees.
function capture({ cell, colour, scale }) {
  const lay = AirgapGrid.layout(700, 520, cell);
  const picture = new Uint8ClampedArray(lay.width * lay.height * 4);
  const bytes = randomBytes(AirgapGrid.capacity(lay, colour));
  AirgapGrid.painter(lay, picture)(bytes, colour);
  return { lay, bytes, image: resample(screenWith(picture, lay, 61, 43), scale) };
}

describe("grid code", () => {
  for (const colour of [false, true]) {
    for (const [cell, scale] of [[4, 1], [4, 0.8], [3, 1], [6, 0.63], [4, 1.37], [8, 0.5]]) {
      it(`reads back ${colour ? "colour" : "black and white"} cells of ${cell}px captured at ${scale}x`, () => {
        const { lay, bytes, image } = capture({ cell, colour, scale });
        const found = AirgapGrid.locate(image);
        assert.ok(found, "grid located");
        assert.deepEqual([found.cols, found.rows], [lay.cols, lay.rows]);
        const read = AirgapGrid.read(image, found, 0, 0, colour);
        assert.ok(Buffer.from(read).equals(bytes));
      });
    }
  }

  it("reads from a crop of the located picture", () => {
    const { bytes, image } = capture({ cell: 4, colour: false, scale: 1 });
    const found = AirgapGrid.locate(image);
    const { x, y, w, h } = found.box;
    const crop = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      crop.set(image.data.subarray(((y + row) * image.width + x) * 4,
                                   ((y + row) * image.width + x + w) * 4), row * w * 4);
    }
    const read = AirgapGrid.read({ data: crop, width: w, height: h }, found, x, y, false);
    assert.ok(Buffer.from(read).equals(bytes));
  });

  it("finds nothing in a picture without a grid", () => {
    const blank = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(200) };
    assert.equal(AirgapGrid.locate(blank), null);
    const lay = AirgapGrid.layout(700, 520, 4);
    const noise = screenWith(new Uint8ClampedArray(lay.width * lay.height * 4).map(() => Math.random() * 255),
                             lay, 61, 43);
    assert.equal(AirgapGrid.locate(noise), null);
  });

  it("has no room in a tiny window", () => {
    assert.equal(AirgapGrid.layout(120, 120, 4), null);
  });
});

describe("frame bundles", () => {
  const blob = AirgapCodec.pack("a.bin", randomBytes(5000));
  const enc = AirgapCodec.encoder(blob, 400);
  const frames = [0, 1, 2, 3].map((id) => enc.frame(id));
  const capacity = 4 * (enc.frame_size + 4) + 37; // some unused cells at the end

  it("round-trips the frames it was given", () => {
    const out = AirgapCodec.unbundle(AirgapCodec.bundle(frames, capacity), 0);
    assert.equal(out.size, enc.frame_size);
    // Array.from: the sandbox's arrays have a different prototype
    assert.deepEqual(Array.from(out.frames, (f) => Buffer.from(f).toString("hex")),
                     frames.map((f) => Buffer.from(f).toString("hex")));
  });

  it("drops only the damaged frame", () => {
    const bytes = AirgapCodec.bundle(frames, capacity);
    bytes[(enc.frame_size + 4) * 2 + 100] ^= 0x10;
    const out = AirgapCodec.unbundle(bytes, 0);
    assert.deepEqual(Array.from(out.frames, (f) => AirgapCodec.parse(f).frame), [0, 1, 3]);
  });

  it("needs the known frame size once the first frame is damaged", () => {
    const bytes = AirgapCodec.bundle(frames, capacity);
    bytes[20] ^= 0x01;
    assert.equal(AirgapCodec.unbundle(bytes, 0).frames.length, 0);
    const out = AirgapCodec.unbundle(bytes, enc.frame_size);
    assert.deepEqual(Array.from(out.frames, (f) => AirgapCodec.parse(f).frame), [1, 2, 3]);
  });

  it("yields nothing from bytes that are not a bundle", () => {
    assert.equal(AirgapCodec.unbundle(randomBytes(2000), 0).frames.length, 0);
    assert.equal(AirgapCodec.unbundle(new Uint8Array(4), 0).frames.length, 0);
  });
});

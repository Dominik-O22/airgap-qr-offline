// End-to-end and adversarial tests for the QR file transfer protocol.
//
// The generator page (offline/generator.html) is driven through DOM stubs:
// pasting text / picking a file and clicking Start, then reading the bytes of
// each QR code it draws. Those payloads (or hand-crafted malicious ones) are
// fed to the scanner page (offline/scanner.html) through a stubbed jsQR,
// simulating camera frames, and the resulting download is inspected.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { loadGenerator, loadScanner, frame, readHeader, blobFor, chunkFrames,
         HEADER, SMALL_CODE } from "./helpers.mjs";

const MAX_CHUNKS = 200000; // mirrors codec MAX_CHUNKS
const MAX_SIZE = 64 * 1024 * 1024; // mirrors codec MAX_SIZE

const fakeFile = (name, bytes) => ({
  name,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

// Start a generator on pasted text or a file and return the first `count`
// QR payloads it shows (default: one full pass over the chunks).
async function send(page, { text, file }, count) {
  if (text !== undefined) page.el("text_input").value = text;
  if (file) page.el("file_input").files = [file];
  page.click("btn_start");
  await new Promise((r) => setImmediate(r)); // let arrayBuffer() resolve
  if (!page.frames.length) return page.frames;
  page.pumpTimers((count ?? readHeader(page.frames[0]).chunks) - 1);
  return page.frames;
}

// Feed frames to a started scanner and return what it downloaded.
async function receive(page, frames) {
  await page.startReceiver();
  page.feed(...frames);
  page.pumpFrames(frames.length + 1);
  return page.downloads;
}

describe("generator", () => {
  it("emits every chunk in order, then repair frames, all with one header", async () => {
    const page = loadGenerator();
    const frames = await send(page, { file: fakeFile("a.bin", randomBytes(2000)) }, 40);
    const first = readHeader(frames[0]);
    assert.ok(first.chunks >= 4);
    assert.equal(first.chunkSize, SMALL_CODE - HEADER);
    frames.forEach((f, n) => {
      const h = readHeader(f);
      assert.equal(f.length, HEADER + first.chunkSize);
      assert.deepEqual([h.size, h.chunkSize], [first.size, first.chunkSize]);
      if (n < first.chunks) assert.equal(h.frameId, n);
    });
    assert.ok(readHeader(frames[first.chunks]).frameId >= first.chunks);
  });

  it("names pastes 'Paste @ <timestamp>'", async () => {
    const frames = await send(loadGenerator(), { text: "hi" });
    const dl = await receive(loadScanner(), frames);
    assert.match(dl[0].name, /^Paste @ \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
  });

  it("prefers pasted text over a selected file", async () => {
    const frames = await send(loadGenerator(), {
      text: "pasted text",
      file: fakeFile("ignored.bin", new Uint8Array(4)),
    });
    const dl = await receive(loadScanner(), frames);
    assert.match(dl[0].name, /^Paste @ /);
  });

  it("does nothing without input", () => {
    const page = loadGenerator();
    page.click("btn_start");
    assert.equal(page.frames.length, 0);
    assert.equal(page.message, "Choose a file or paste text to get started");
  });

  it("rejects pasted text with invalid UTF-16", () => {
    const page = loadGenerator();
    page.el("text_input").value = "ends with lone high surrogate \uD800";
    page.click("btn_start");
    assert.equal(page.frames.length, 0);
    assert.equal(page.message, "Text contains an unpaired surrogate");

    page.el("text_input").value = "high surrogate before \uD800 a space";
    page.click("btn_start");
    assert.equal(page.frames.length, 0);
    assert.equal(page.message, "Text contains invalid Unicode characters");

    page.el("text_input").value = "lone low surrogate \uDC00";
    page.click("btn_start");
    assert.equal(page.frames.length, 0);
    assert.equal(page.message, "Text contains invalid Unicode characters");
  });

  it("rejects oversized pasted text", () => {
    const page = loadGenerator();
    page.el("text_input").value = "a".repeat(1000001);
    page.click("btn_start");
    assert.equal(page.frames.length, 0);
    assert.match(page.message, /^Text too long/);
  });

  it("strips path components from the sent filename", async () => {
    const frames = await send(loadGenerator(), { file: fakeFile("../../pwned.txt", new Uint8Array([1, 2, 3])) });
    const dl = await receive(loadScanner(), frames);
    assert.equal(dl[0].name, "pwned.txt");
  });
});

describe("paste and file round-trips (generator -> scanner)", () => {
  it("round-trips a pasted text containing unicode", async () => {
    const text =
      "héllo wörld 🌍 — 中文\nline2\twith \"quotes\" 'and' apostrophes\n" + "y".repeat(600);
    const frames = await send(loadGenerator(), { text });
    const dl = await receive(loadScanner(), frames);
    assert.equal(dl.length, 1);
    assert.equal(new TextDecoder().decode(dl[0].data), text);
  });

  it("round-trips a multi-chunk binary file byte-for-byte", async () => {
    const bytes = randomBytes(4096);
    const frames = await send(loadGenerator(), { file: fakeFile("report.bin", bytes) });
    assert.ok(frames.length >= 10);
    const scanner = loadScanner();
    const dl = await receive(scanner, frames);
    assert.equal(dl.length, 1);
    assert.equal(dl[0].name, "report.bin");
    assert.ok(Buffer.from(dl[0].data).equals(bytes));
    assert.equal(scanner.message, 'Received "report.bin"');
  });

  it("recovers lost chunks from repair frames", async () => {
    const bytes = randomBytes(20000);
    const gen = loadGenerator();
    const all = await send(gen, { file: fakeFile("lossy.bin", bytes) }, 400);
    const { chunks } = readHeader(all[0]);
    // lose a third of everything, including the same chunks on the second pass
    const kept = all.filter((f) => {
      const id = readHeader(f).frameId;
      return id < chunks ? id % 3 !== 0 : id % 7 !== 0;
    });
    const scanner = loadScanner();
    const dl = await receive(scanner, kept);
    assert.equal(dl.length, 1);
    assert.ok(Buffer.from(dl[0].data).equals(bytes));
  });

  it("rebuilds a file from repair frames alone", async () => {
    const bytes = randomBytes(6000);
    const gen = loadGenerator();
    const all = await send(gen, { file: fakeFile("late.bin", bytes) }, 600);
    const { chunks } = readHeader(all[0]);
    const repairs = all.filter((f) => readHeader(f).frameId >= chunks);
    assert.ok(repairs.length > chunks + 10);
    const dl = await receive(loadScanner(), repairs);
    assert.equal(dl.length, 1);
    assert.ok(Buffer.from(dl[0].data).equals(bytes));
  });
});

describe("scanner robustness against malicious QR codes", () => {
  const startScanner = async () => {
    const page = loadScanner();
    await page.startReceiver();
    return page;
  };
  const feedEach = (page, payloads) => {
    for (const p of payloads) {
      page.feed(p);
      page.pumpFrames(1);
    }
  };

  it("ignores text codes and frames with invalid headers", async () => {
    const data = Buffer.alloc(100);
    const page = await startScanner();
    feedEach(page, [
      "https://example.com",
      '{"name":"a","chunks":1}',
      frame({ size: 100, chunkSize: 100, data, magic: 0x00 }),
      frame({ size: 0, chunkSize: 100, data }),
      frame({ size: MAX_SIZE + 1, chunkSize: 100, data }),
      frame({ size: 100, chunkSize: 0, data }),
      frame({ size: 50, chunkSize: 100, data }), // chunk larger than the blob
      frame({ size: 100, chunkSize: 100, data: Buffer.alloc(99) }), // truncated payload
      frame({ size: 100, chunkSize: 100, data: Buffer.alloc(101) }), // trailing bytes
      frame({ size: (MAX_CHUNKS + 1) * 100, chunkSize: 100, data }),
      Buffer.alloc(HEADER, 0xa9), // header only
    ]);
    assert.equal(page.progress, "Progress: 0 / 0");
    assert.equal(page.downloads.length, 0);
  });

  it("fails loudly on a non-gzip blob and downloads nothing", async () => {
    const page = await startScanner();
    feedEach(page, [frame({ size: 40, chunkSize: 40, data: Buffer.alloc(40, 7) })]);
    assert.equal(page.downloads.length, 0);
    assert.match(page.message, /^Transfer failed/);
  });

  it("fails loudly when the blob's name length overruns its content", async () => {
    const lying = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from("abc")]);
    const page = await startScanner();
    feedEach(page, chunkFrames(gzipSync(lying)));
    assert.equal(page.downloads.length, 0);
    assert.equal(page.message, "Transfer failed: bad file name length");
  });

  it("keeps progress when a stray frame of another transfer shows up", async () => {
    const page = await startScanner();
    const a = chunkFrames(blobFor("a.bin", randomBytes(2000)));
    const b = chunkFrames(blobFor("b.bin", randomBytes(2000)));
    feedEach(page, [a[0], a[1], b[0], a[2], b[1], b[2]]);
    assert.equal(page.progress, "Progress: 3 / " + a.length);
  });

  it("switches to another transfer once it keeps showing up", async () => {
    const page = await startScanner();
    const a = chunkFrames(blobFor("a.bin", randomBytes(2000)));
    const b = chunkFrames(blobFor("b.bin", randomBytes(2000)));
    feedEach(page, [a[0], a[1], b[0], b[1], b[2]]);
    assert.equal(page.progress, "Progress: 1 / " + b.length); // b[2] started it
    feedEach(page, b);
    assert.equal(page.downloads.length, 1);
    assert.equal(page.downloads[0].name, "b.bin");
  });

  it("never completes while chunks are missing, however often the rest repeat", async () => {
    const page = await startScanner();
    const frames = chunkFrames(blobFor("a.bin", randomBytes(2000)));
    const partial = frames.slice(1);
    feedEach(page, [...partial, ...partial, ...partial]);
    assert.equal(page.downloads.length, 0);
    assert.equal(page.progress, `Progress: ${frames.length - 1} / ${frames.length}`);
  });

  it("downloads under a sanitized filename regardless of the claimed name", async () => {
    const cases = [
      ["../../../etc/passwd", "passwd"],
      ["..\\..\\evil.exe", "evil.exe"],
      [".", "received_file.bin"],
      ["..", "received_file.bin"],
      ["", "received_file.bin"],
      ["bad\nname\x00.txt", "badname.txt"],
      ["A".repeat(500), "A".repeat(200)],
    ];
    for (const [evil, expected] of cases) {
      const page = await startScanner();
      feedEach(page, chunkFrames(blobFor(evil, new Uint8Array([7, 7]))));
      assert.equal(page.downloads.length, 1, "case: " + JSON.stringify(evil));
      assert.equal(page.downloads[0].name, expected);
      assert.deepEqual(Array.from(page.downloads[0].data), [7, 7]);
    }
  });
});

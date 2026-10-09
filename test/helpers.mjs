// Test harness: loads the built single-file pages (offline/*.html) into a
// `vm` sandbox with DOM/camera stubs so the inline app scripts can be driven
// without a browser. Uses only Node builtins to keep the repo zero-dependency.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- fake timer / animation-frame queues (pumped manually by tests) ----

function makeQueue() {
  const q = new Map();
  let seq = 0;
  return {
    add(fn) {
      const id = ++seq;
      q.set(id, fn);
      return id;
    },
    del(id) {
      q.delete(id);
    },
    pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const it = q.entries().next();
        if (it.done) return;
        const [id, fn] = it.value;
        q.delete(id);
        fn();
      }
    },
  };
}

// ---- DOM stubs ----

function makeEl(id, downloads) {
  const el = {
    id,
    textContent: "",
    value: "",
    disabled: false,
    files: [],
    videoWidth: 64,
    videoHeight: 64,
    srcObject: null,
    download: "",
    href: "",
    style: {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    // canvas stub for the scanner's <canvas id="scan"> and the generator's QR canvas
    getContext() {
      return {
        drawImage() {},
        fillRect() {},
        getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
      };
    },
  };
  // <a> elements created by download_file(): clicking records the download
  el.click = () => {
    if (id === "a" || el.tagName === "a") {
      downloads.push({ name: el.download, data: FakeBlob.last?.parts?.[0] });
    }
  };
  return el;
}

class FakeBlob {
  constructor(parts) {
    this.parts = parts;
    FakeBlob.last = this;
  }
}
FakeBlob.last = null;

// ---- page loader ----

export function loadPage(file) {
  const html = readFileSync(path.join(ROOT, file), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1]
  );

  const downloads = [];
  const els = new Map();
  const getElementById = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id, downloads));
    return els.get(id);
  };

  // Stand-in for qrcode-generator: records the bytes of every code drawn.
  const qrFrames = [];
  const qrcode = () => ({
    addData(text) {
      qrFrames.push(Uint8Array.from(text, (ch) => ch.charCodeAt(0)));
    },
    make() {},
    getModuleCount: () => 21,
    isDark: () => false,
  });

  const timers = makeQueue(); // generator's setTimeout loop
  const raf = makeQueue(); // scanner's requestAnimationFrame loop
  const feed = []; // queued payloads returned by the jsQR stub

  const ctx = vm.createContext({
    document: {
      getElementById,
      createElement(tag) {
        const el = makeEl(tag, downloads);
        el.tagName = tag;
        return el;
      },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [] }),
      },
    },
    window: { innerWidth: 1024, innerHeight: 768 },
    qrcode,
    // Stand-in for jsQR: each camera frame "sees" the next queued payload.
    // Strings are text codes, byte arrays are binary codes.
    jsQR: () => {
      if (!feed.length) return null;
      const payload = feed.shift();
      // a located code, so the scanner tracks it instead of searching again
      const at = (x, y) => ({ x, y });
      const found = {
        version: 1,
        location: { topLeftCorner: at(8, 8), topRightCorner: at(56, 8),
                    bottomLeftCorner: at(8, 56), bottomRightCorner: at(56, 56) },
      };
      return typeof payload === "string"
        ? { ...found, data: payload, binaryData: Array.from(Buffer.from(payload)) }
        : { ...found, data: "", binaryData: Array.from(payload) };
    },
    Blob: FakeBlob,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    setTimeout: (fn) => timers.add(fn),
    clearTimeout: (id) => timers.del(id),
    requestAnimationFrame: (fn) => raf.add(fn),
    cancelAnimationFrame: (id) => raf.del(id),
    console,
  });

  // Evaluate every inline script except the vendored QR-code libraries
  // (qrcode-generator and jsQR), which the stubs above replace.
  for (const code of scripts) {
    if (code.includes("var qrcode=function") || code.includes("webpackUniversalModuleDefinition")) {
      continue;
    }
    vm.runInContext(code, ctx, { filename: file });
  }

  return {
    el: getElementById,
    click(id) {
      for (const fn of getElementById(id).listeners.click ?? []) fn({});
    },
    frames: qrFrames,
    downloads,
    feed: (...payloads) => feed.push(...payloads),
    pumpFrames: (n = 1) => raf.pump(n),
    pumpTimers: (n = 1) => timers.pump(n),
    get message() {
      return getElementById("user_message").textContent;
    },
    get progress() {
      return getElementById("progress").textContent;
    },
    // Click "Start Receiver" and let the fake getUserMedia promise settle.
    async startReceiver() {
      this.click("btn");
      await new Promise((r) => setImmediate(r));
    },
  };
}

// The generator starts on its fastest speed and smallest code size, so small
// test files still span several chunks.
export const SMALL_CODE = 367;
export function loadGenerator() {
  const page = loadPage("offline/generator.html");
  page.el("speed").value = "50";
  page.el("density").value = String(SMALL_CODE);
  return page;
}
export const loadScanner = () => loadPage("offline/scanner.html");

// ---- helpers for crafting QR payloads by hand ----

export const HEADER = 15;

// One binary frame, laid out as in offline/templates/codec.js.
export function frame({ id = 1, size, chunkSize, frameId = 0, data, magic = 0xa9 }) {
  const out = Buffer.alloc(HEADER + data.length);
  out.writeUInt8(magic, 0);
  out.writeUInt32BE(id, 1);
  out.writeUInt32BE(size, 5);
  out.writeUInt16BE(chunkSize, 9);
  out.writeUInt32BE(frameId, 11);
  out.set(data, HEADER);
  return out;
}

export const readHeader = (f) => {
  const b = Buffer.from(f);
  const size = b.readUInt32BE(5), chunkSize = b.readUInt16BE(9);
  return { size, chunkSize, chunks: Math.ceil(size / chunkSize), frameId: b.readUInt32BE(11) };
};

// The blob an honest sender builds: gzip([u16 name length][name][bytes]).
export function blobFor(name, bytes) {
  const nameBytes = Buffer.from(name, "utf8");
  const head = Buffer.alloc(2);
  head.writeUInt16BE(nameBytes.length);
  return gzipSync(Buffer.concat([head, nameBytes, Buffer.from(bytes)]));
}

// The plain (non-repair) frames an honest sender emits for a blob.
export function chunkFrames(blob, chunkSize = SMALL_CODE - HEADER) {
  const c = Math.min(chunkSize, blob.length);
  const frames = [];
  for (let i = 0; i * c < blob.length; i++) {
    const data = Buffer.alloc(c);
    blob.copy(data, 0, i * c, (i + 1) * c);
    frames.push(frame({ id: blob.readUInt32BE(blob.length - 8), size: blob.length,
                        chunkSize: c, frameId: i, data }));
  }
  return frames;
}

// ---- the shared libraries on their own, without a page ----

// Loads pako, codec.js and grid.js into a sandbox and returns their globals.
export function loadLibs() {
  const ctx = vm.createContext({ TextEncoder, TextDecoder });
  for (const file of ["offline/vendor/pako.min.js", "offline/templates/codec.js",
                      "offline/templates/grid.js"]) {
    vm.runInContext(readFileSync(path.join(ROOT, file), "utf8"), ctx, { filename: file });
  }
  return vm.runInContext("({ AirgapCodec, AirgapGrid })", ctx);
}

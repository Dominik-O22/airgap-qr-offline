// Grid code: a denser alternative to QR for flat, sharp captures (a window
// or screen capture, not a hand-held camera). It has no error correction and
// no perspective handling; the caller checksums what it reads.
//
// Layout, from the outside in, where b is the border thickness:
//
//   2b  white quiet zone
//    b  black border
//    b  white gap
//    b  timing track along the top and left: one black/white mark per
//       column or row, black first, always an odd count so it ends on black
//       data cells, `cell` pixels square, cols x rows
//    b  white gap, then the border and quiet zone again (right and bottom)
//
// The border locates the code, the timing tracks give the number of columns
// and rows and where they sit, and each data cell is read at its centre.
// A cell holds 1 bit (black = 1) or, in colour, 3 bits (one per RGB channel,
// channel off = 1). Bits fill cells row by row, most significant bit first.
var AirgapGrid = (function () {
  // Picture geometry for the largest grid of `cell`-pixel cells that fits in
  // width x height pixels, or null if there is no room for one.
  var layout = function (width, height, cell) {
    var b = cell * Math.max(2, Math.ceil(12 / cell));
    var odd = function (n) { return n % 2 ? n : n - 1; };
    var cols = odd(Math.floor((width - 9 * b) / cell));
    var rows = odd(Math.floor((height - 9 * b) / cell));
    if (cols < 9 || rows < 9) return null;
    return { cell: cell, b: b, cols: cols, rows: rows,
             width: cols * cell + 9 * b, height: rows * cell + 9 * b };
  };

  // Bytes one picture holds.
  var capacity = function (lay, colour) {
    return Math.floor(lay.cols * lay.rows * (colour ? 3 : 1) / 8);
  };

  // Sender: prepares `pixels` (RGBA, lay.width x lay.height) with the fixed
  // parts of the picture and returns draw(bytes, colour), which paints the
  // data cells.
  var painter = function (lay, pixels) {
    var px = new Uint32Array(pixels.buffer, pixels.byteOffset, lay.width * lay.height);
    var BLACK = 0xff000000, WHITE = 0xffffffff; // little-endian ABGR
    var b = lay.b, cell = lay.cell, w = lay.width, h = lay.height;
    var rect = function (x, y, rw, rh, colour) {
      for (var j = y; j < y + rh; j++) px.fill(colour, j * w + x, j * w + x + rw);
    };
    rect(0, 0, w, h, WHITE);
    rect(2 * b, 2 * b, w - 4 * b, h - 4 * b, BLACK);
    rect(3 * b, 3 * b, w - 6 * b, h - 6 * b, WHITE);
    for (var c = 0; c < lay.cols; c += 2) rect(5 * b + c * cell, 4 * b, cell, b, BLACK);
    for (var r = 0; r < lay.rows; r += 2) rect(4 * b, 5 * b + r * cell, b, cell, BLACK);

    return function (bytes, colour) {
      var bit = function (i) { return (bytes[i >> 3] >> (7 - (i & 7))) & 1; };
      for (var row = 0; row < lay.rows; row++) {
        var line = (5 * b + row * cell) * w + 5 * b;
        for (var col = 0; col < lay.cols; col++) {
          var i = row * lay.cols + col, value;
          if (colour) {
            value = 0xff000000 | (bit(3 * i) ? 0 : 0xff) | (bit(3 * i + 1) ? 0 : 0xff00) |
                    (bit(3 * i + 2) ? 0 : 0xff0000);
          } else {
            value = bit(i) ? BLACK : WHITE;
          }
          px.fill(value >>> 0, line + col * cell, line + (col + 1) * cell);
        }
        // the cell row's other scanlines are copies of its first
        for (var k = 1; k < cell; k++) {
          px.copyWithin(line + k * w, line, line + lay.cols * cell);
        }
      }
    };
  };

  var MID = 128; // luminance below this is dark

  var luma = function (image, x, y) {
    var o = (y * image.width + x) * 4;
    return (image.data[o] + 2 * image.data[o + 1] + image.data[o + 2]) >> 2;
  };

  // Walks from `from` to `to` along a row (fixed = y) or column (fixed = x)
  // and returns the positions where the picture crosses between light and
  // dark, each interpolated to a fraction of a pixel. Pixel i spans
  // [i, i + 1), so its sample sits at i + 0.5.
  var crossings = function (image, horizontal, fixed, from, to) {
    var size = horizontal ? image.width : image.height;
    var limit = horizontal ? image.height : image.width;
    var step = to >= from ? 1 : -1, out = [];
    fixed = Math.max(0, Math.min(limit - 1, Math.round(fixed)));
    from = Math.max(0, Math.min(size - 1, Math.round(from)));
    to = Math.max(0, Math.min(size - 1, Math.round(to)));
    var at = function (i) { return horizontal ? luma(image, i, fixed) : luma(image, fixed, i); };
    var prev = at(from);
    for (var i = from + step; step > 0 ? i <= to : i >= to; i += step) {
      var cur = at(i);
      if ((prev < MID) !== (cur < MID)) {
        out.push(i - step + 0.5 + step * (prev - MID) / (prev - cur));
      }
      prev = cur;
    }
    return out;
  };

  var median = function (values) {
    var v = values.slice().sort(function (a, b) { return a - b; });
    return v[v.length >> 1];
  };

  // Bounding boxes of dark shapes that look like the border: a ring whose
  // four sides are dark along nearly their whole length. Works on a coarse
  // point-sampled copy of the image; boxes are returned in image pixels,
  // largest first.
  var find_rings = function (image) {
    var s = Math.max(1, Math.round(Math.max(image.width, image.height) / 720));
    var w = Math.floor(image.width / s), h = Math.floor(image.height / s);
    var label = new Int32Array(w * h); // 0 = unvisited dark, -1 = light, >0 = shape id
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (luma(image, x * s + (s >> 1), y * s + (s >> 1)) >= MID) label[y * w + x] = -1;
      }
    }
    var stack = new Int32Array(w * h), rings = [], next = 0;
    for (var start = 0; start < w * h; start++) {
      if (label[start] !== 0) continue;
      var id = ++next, top = 0;
      var x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack[top++] = start;
      label[start] = id;
      while (top) {
        var p = stack[--top], px = p % w, py = (p - px) / w;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        if (px > 0 && label[p - 1] === 0) { label[p - 1] = id; stack[top++] = p - 1; }
        if (px < w - 1 && label[p + 1] === 0) { label[p + 1] = id; stack[top++] = p + 1; }
        if (py > 0 && label[p - w] === 0) { label[p - w] = id; stack[top++] = p - w; }
        if (py < h - 1 && label[p + w] === 0) { label[p + w] = id; stack[top++] = p + w; }
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw < 30 || bh < 30) continue;
      var horizontal = 0, vertical = 0, i;
      for (i = x0; i <= x1; i++) {
        horizontal += (label[y0 * w + i] === id) + (label[y1 * w + i] === id);
      }
      for (i = y0; i <= y1; i++) {
        vertical += (label[i * w + x0] === id) + (label[i * w + x1] === id);
      }
      if (horizontal < 1.8 * bw || vertical < 1.8 * bh) continue;
      rings.push({ x0: x0 * s, y0: y0 * s, x1: (x1 + 1) * s, y1: (y1 + 1) * s, area: bw * bh });
    }
    return rings.sort(function (a, b) { return b.area - a.area; });
  };

  // Reads one timing track: `along` is the row or column through its middle,
  // `from`..`to` spans it with some white on either side. Returns the first
  // edge, the mark pitch and the mark count, or null if it is not a clean
  // odd run of evenly sized marks.
  var read_track = function (image, horizontal, along, from, to) {
    var edges = crossings(image, horizontal, along, from, to);
    var count = edges.length - 1;
    if (count < 9 || count % 2 === 0) return null;
    var pitch = (edges[count] - edges[0]) / count;
    for (var i = 0; i < count; i++) {
      var run = edges[i + 1] - edges[i];
      if (run < pitch * 0.4 || run > pitch * 1.6) return null;
    }
    return { start: edges[0], pitch: pitch, count: count };
  };

  // Measures one candidate border: its exact outer edges, its thickness, and
  // from those the two timing tracks.
  var measure = function (image, ring) {
    var slack = Math.max(4, Math.round(Math.max(image.width, image.height) / 240));
    var w = ring.x1 - ring.x0, h = ring.y1 - ring.y0;
    var fractions = [0.3, 0.5, 0.7];
    // first crossing when walking inwards from just outside each side
    var outer = function (horizontal, from, to, span_start, span) {
      var found = [];
      fractions.forEach(function (f) {
        var e = crossings(image, horizontal, span_start + span * f, from, to);
        if (e.length) found.push(e[0]);
      });
      return found.length ? median(found) : NaN;
    };
    var left = outer(true, ring.x0 - slack, ring.x0 + slack, ring.y0, h);
    var right = outer(true, ring.x1 + slack, ring.x1 - slack, ring.y0, h);
    var top = outer(false, ring.y0 - slack, ring.y0 + slack, ring.x0, w);
    var bottom = outer(false, ring.y1 + slack, ring.y1 - slack, ring.x0, w);
    if (!(right - left > 20) || !(bottom - top > 20)) return null;

    // thickness: second crossing when walking inwards through each side
    var cx = (left + right) / 2, cy = (top + bottom) / 2, thick = [];
    [[true, cy, left - slack, cx], [true, cy, right + slack, cx],
     [false, cx, top - slack, cy], [false, cx, bottom + slack, cy]].forEach(function (a) {
      var e = crossings(image, a[0], a[1], a[2], a[3]);
      if (e.length >= 2) thick.push(Math.abs(e[1] - e[0]));
    });
    if (thick.length < 3) return null;
    var b = median(thick);
    if (b < 3) return null;

    // each track sits 2b..3b inside the border; scan from mid-gap to mid-gap
    var cols = read_track(image, true, top + 2.5 * b, left + 2.5 * b, right - 1.5 * b);
    var rows = read_track(image, false, left + 2.5 * b, top + 2.5 * b, bottom - 1.5 * b);
    if (!cols || !rows) return null;
    return { x: cols.start, y: rows.start, cw: cols.pitch, ch: rows.pitch,
             cols: cols.count, rows: rows.count,
             box: { x: Math.floor(left), y: Math.floor(top),
                    w: Math.ceil(right) - Math.floor(left), h: Math.ceil(bottom) - Math.floor(top) } };
  };

  // Receiver: finds a grid code in an RGBA image ({ data, width, height }).
  // Returns its geometry in image pixels, or null.
  var locate = function (image) {
    var rings = find_rings(image);
    for (var i = 0; i < rings.length && i < 8; i++) {
      var found = measure(image, rings[i]);
      if (found) return found;
    }
    return null;
  };

  // Receiver: reads the data cells of a located grid. `image` may be a crop
  // of the picture `geometry` was measured in, with its top left corner at
  // (offset_x, offset_y) there.
  var read = function (image, geometry, offset_x, offset_y, colour) {
    var g = geometry, bits = colour ? 3 : 1;
    var out = new Uint8Array(Math.floor(g.cols * g.rows * bits / 8));
    var total = out.length * 8, i = 0;
    for (var row = 0; row < g.rows && i < total; row++) {
      var y = Math.floor(g.y + (row + 0.5) * g.ch - offset_y);
      for (var col = 0; col < g.cols && i < total; col++) {
        var x = Math.floor(g.x + (col + 0.5) * g.cw - offset_x);
        var o = (y * image.width + x) * 4;
        if (colour) {
          for (var ch = 0; ch < 3 && i < total; ch++, i++) {
            if (image.data[o + ch] < MID) out[i >> 3] |= 0x80 >> (i & 7);
          }
        } else {
          if (((image.data[o] + 2 * image.data[o + 1] + image.data[o + 2]) >> 2) < MID) {
            out[i >> 3] |= 0x80 >> (i & 7);
          }
          i++;
        }
      }
    }
    return out;
  };

  return { layout: layout, capacity: capacity, painter: painter, locate: locate, read: read };
})();

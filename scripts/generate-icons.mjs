import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(rootDir, "public", "icons");
const sizes = [16, 32, 48, 128];

function createIconPng(size) {
  const supersample = 4;
  const canvasSize = size * supersample;
  const rgba = new Uint8Array(canvasSize * canvasSize * 4);
  const ctx = { width: canvasSize, height: canvasSize, rgba };

  fillRoundedRect(ctx, 18, 10, 92, 108, 13, rgbaColor("#0f172a"));
  fillRoundedRect(ctx, 22, 14, 84, 100, 10, rgbaColor("#fffdf6"));
  fillPolygon(
    ctx,
    [
      [82, 14],
      [106, 38],
      [82, 38],
    ],
    rgbaColor("#dbeafe"),
  );
  drawLine(ctx, 82, 38, 106, 38, 2.2, rgbaColor("#94a3b8"));
  drawLine(ctx, 82, 14, 106, 38, 2.2, rgbaColor("#94a3b8"));

  fillRoundedRect(ctx, 34, 46, 45, 5, 2.5, rgbaColor("#64748b"));
  fillRoundedRect(ctx, 34, 55, 56, 5, 2.5, rgbaColor("#64748b"));
  fillRoundedRect(ctx, 36, 63, 56, 19, 5, rgbaColor("#f6c445"));

  const ink = rgbaColor("#1f2937");
  drawBracket(ctx, 43, 67, 79, false, ink);
  drawDigitOne(ctx, 56, 67, 79, ink);
  drawDigitTwo(ctx, 67, 67, 79, ink);
  drawBracket(ctx, 84, 67, 79, true, ink);

  drawLine(ctx, 44, 93, 64, 103, 4, rgbaColor("#14b8a6"));
  drawLine(ctx, 64, 103, 88, 89, 4, rgbaColor("#14b8a6"));
  fillCircle(ctx, 44, 93, 6.5, rgbaColor("#0f766e"));
  fillCircle(ctx, 64, 103, 6.5, rgbaColor("#0f766e"));
  fillCircle(ctx, 88, 89, 6.5, rgbaColor("#0f766e"));
  fillCircle(ctx, 44, 93, 2.2, rgbaColor("#ecfeff"));
  fillCircle(ctx, 64, 103, 2.2, rgbaColor("#ecfeff"));
  fillCircle(ctx, 88, 89, 2.2, rgbaColor("#ecfeff"));

  return encodePng(size, size, downsample(rgba, canvasSize, size, supersample));
}

function drawBracket(ctx, x, y1, y2, right, color) {
  const cap = right ? -5 : 5;
  drawLine(ctx, x, y1, x, y2, 2.5, color);
  drawLine(ctx, x, y1, x + cap, y1, 2.5, color);
  drawLine(ctx, x, y2, x + cap, y2, 2.5, color);
}

function drawDigitOne(ctx, x, y1, y2, color) {
  drawLine(ctx, x, y1 + 3, x + 3, y1, 2.4, color);
  drawLine(ctx, x + 3, y1, x + 3, y2, 2.4, color);
  drawLine(ctx, x - 1, y2, x + 7, y2, 2.4, color);
}

function drawDigitTwo(ctx, x, y1, y2, color) {
  const mid = (y1 + y2) / 2;
  drawLine(ctx, x, y1, x + 9, y1, 2.4, color);
  drawLine(ctx, x + 9, y1, x + 9, mid, 2.4, color);
  drawLine(ctx, x, mid, x + 9, mid, 2.4, color);
  drawLine(ctx, x, mid, x, y2, 2.4, color);
  drawLine(ctx, x, y2, x + 9, y2, 2.4, color);
}

function fillRoundedRect(ctx, x, y, width, height, radius, color) {
  const scale = ctx.width / 128;
  const minX = Math.max(0, Math.floor(x * scale));
  const maxX = Math.min(ctx.width, Math.ceil((x + width) * scale));
  const minY = Math.max(0, Math.floor(y * scale));
  const maxY = Math.min(ctx.height, Math.ceil((y + height) * scale));

  for (let py = minY; py < maxY; py++) {
    const cy = (py + 0.5) / scale;
    for (let px = minX; px < maxX; px++) {
      const cx = (px + 0.5) / scale;
      const nearestX = clamp(cx, x + radius, x + width - radius);
      const nearestY = clamp(cy, y + radius, y + height - radius);
      if ((cx - nearestX) ** 2 + (cy - nearestY) ** 2 <= radius ** 2) {
        blendPixel(ctx, px, py, color);
      }
    }
  }
}

function fillPolygon(ctx, points, color) {
  const scale = ctx.width / 128;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.max(0, Math.floor(Math.min(...xs) * scale));
  const maxX = Math.min(ctx.width, Math.ceil(Math.max(...xs) * scale));
  const minY = Math.max(0, Math.floor(Math.min(...ys) * scale));
  const maxY = Math.min(ctx.height, Math.ceil(Math.max(...ys) * scale));

  for (let py = minY; py < maxY; py++) {
    const cy = (py + 0.5) / scale;
    for (let px = minX; px < maxX; px++) {
      const cx = (px + 0.5) / scale;
      if (pointInPolygon(cx, cy, points)) blendPixel(ctx, px, py, color);
    }
  }
}

function fillCircle(ctx, cx, cy, radius, color) {
  const scale = ctx.width / 128;
  const minX = Math.max(0, Math.floor((cx - radius) * scale));
  const maxX = Math.min(ctx.width, Math.ceil((cx + radius) * scale));
  const minY = Math.max(0, Math.floor((cy - radius) * scale));
  const maxY = Math.min(ctx.height, Math.ceil((cy + radius) * scale));

  for (let py = minY; py < maxY; py++) {
    const y = (py + 0.5) / scale;
    for (let px = minX; px < maxX; px++) {
      const x = (px + 0.5) / scale;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) {
        blendPixel(ctx, px, py, color);
      }
    }
  }
}

function drawLine(ctx, x1, y1, x2, y2, width, color) {
  const scale = ctx.width / 128;
  const half = width / 2;
  const minX = Math.max(0, Math.floor((Math.min(x1, x2) - half) * scale));
  const maxX = Math.min(ctx.width, Math.ceil((Math.max(x1, x2) + half) * scale));
  const minY = Math.max(0, Math.floor((Math.min(y1, y2) - half) * scale));
  const maxY = Math.min(ctx.height, Math.ceil((Math.max(y1, y2) + half) * scale));

  for (let py = minY; py < maxY; py++) {
    const y = (py + 0.5) / scale;
    for (let px = minX; px < maxX; px++) {
      const x = (px + 0.5) / scale;
      if (distanceToSegment(x, y, x1, y1, x2, y2) <= half) {
        blendPixel(ctx, px, py, color);
      }
    }
  }
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function blendPixel(ctx, x, y, [sr, sg, sb, sa]) {
  const index = (y * ctx.width + x) * 4;
  const sourceAlpha = sa / 255;
  const destAlpha = ctx.rgba[index + 3] / 255;
  const outAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
  if (outAlpha === 0) return;

  ctx.rgba[index] = Math.round(
    (sr * sourceAlpha + ctx.rgba[index] * destAlpha * (1 - sourceAlpha)) / outAlpha,
  );
  ctx.rgba[index + 1] = Math.round(
    (sg * sourceAlpha + ctx.rgba[index + 1] * destAlpha * (1 - sourceAlpha)) / outAlpha,
  );
  ctx.rgba[index + 2] = Math.round(
    (sb * sourceAlpha + ctx.rgba[index + 2] * destAlpha * (1 - sourceAlpha)) / outAlpha,
  );
  ctx.rgba[index + 3] = Math.round(outAlpha * 255);
}

function downsample(source, sourceSize, targetSize, factor) {
  const output = new Uint8Array(targetSize * targetSize * 4);

  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const index = ((y * factor + sy) * sourceSize + x * factor + sx) * 4;
          const a = source[index + 3] / 255;
          alpha += a;
          red += source[index] * a;
          green += source[index + 1] * a;
          blue += source[index + 2] * a;
        }
      }

      const count = factor * factor;
      const outIndex = (y * targetSize + x) * 4;
      if (alpha > 0) {
        output[outIndex] = Math.round(red / alpha);
        output[outIndex + 1] = Math.round(green / alpha);
        output[outIndex + 2] = Math.round(blue / alpha);
      }
      output[outIndex + 3] = Math.round((alpha / count) * 255);
    }
  }

  return output;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(scanlines, rowStart + 1);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function rgbaColor(hex, alpha = 255) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

mkdirSync(outputDir, { recursive: true });

for (const size of sizes) {
  writeFileSync(join(outputDir, `icon${size}.png`), createIconPng(size));
}

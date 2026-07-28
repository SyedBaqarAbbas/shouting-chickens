import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputs = [
  ["app-icon-180.png", 180],
  ["app-icon-192.png", 192],
  ["app-icon-512.png", 512],
  ["app-icon-maskable-512.png", 512],
];

const destination = resolve(process.cwd(), "public/icons");
await mkdir(destination, { recursive: true });

for (const [name, size] of outputs) {
  await writeFile(resolve(destination, name), renderIcon(size));
}

console.log(`Generated ${outputs.length} original PWA icons from scripts/generate-icons.mjs.`);

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 512;
  const sample = (x, y) => {
    let color = [8, 20, 38, 255];
    if (insideCircle(x, y, 256, 256, 174)) {
      color = [16, 46, 84, 255];
    }

    const voiceDistance = Math.hypot(x - 303, y - 258);
    const voiceAngle = Math.atan2(y - 258, x - 303);
    if (
      voiceAngle > -1.02 &&
      voiceAngle < 0.23 &&
      ((voiceDistance > 106 && voiceDistance < 128) || (voiceDistance > 158 && voiceDistance < 174))
    ) {
      color = [245, 213, 103, 255];
    }

    if (insideEllipse(x, y, 235, 329, 146, 115) || insideEllipse(x, y, 233, 194, 85, 88)) {
      color = [248, 251, 255, 255];
    }
    if (
      insidePolygon(x, y, [
        [299, 203],
        [391, 242],
        [299, 281],
      ])
    ) {
      color = [242, 170, 50, 255];
    }
    if (
      insideCircle(x, y, 187, 113, 39) ||
      insideCircle(x, y, 244, 92, 41) ||
      insideCircle(x, y, 303, 111, 40)
    ) {
      color = [239, 79, 80, 255];
    }
    if (insideEllipse(x, y, 231, 326, 66, 48)) {
      color = [214, 232, 247, 255];
    }
    if (insideCircle(x, y, 276, 191, 14)) {
      color = [8, 20, 38, 255];
    }
    if (insideCircle(x, y, 271, 186, 4)) {
      color = [255, 255, 255, 255];
    }
    if (
      insideRoundedLine(x, y, 189, 423, 189, 469, 9) ||
      insideRoundedLine(x, y, 272, 423, 272, 469, 9) ||
      insideRoundedLine(x, y, 166, 470, 215, 470, 9) ||
      insideRoundedLine(x, y, 248, 470, 297, 470, 9)
    ) {
      color = [242, 170, 50, 255];
    }
    return color;
  };

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const color = sample((px + 0.5) / scale, (py + 0.5) / scale);
      const offset = (py * size + px) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const destinationOffset = row * (size * 4 + 1);
    scanlines[destinationOffset] = 0;
    pixels.copy(scanlines, destinationOffset + 1, row * size * 4, (row + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function insideCircle(x, y, centerX, centerY, radius) {
  return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
}

function insideEllipse(x, y, centerX, centerY, radiusX, radiusY) {
  return ((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2 <= 1;
}

function insideRoundedLine(x, y, startX, startY, endX, endY, radius) {
  const lengthSquared = (endX - startX) ** 2 + (endY - startY) ** 2;
  const progress = Math.max(
    0,
    Math.min(1, ((x - startX) * (endX - startX) + (y - startY) * (endY - startY)) / lengthSquared),
  );
  return insideCircle(
    x,
    y,
    startX + progress * (endX - startX),
    startY + progress * (endY - startY),
    radius,
  );
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [currentX, currentY] = points[index];
    const [previousX, previousY] = points[previous];
    if (
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  payload.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(payload), data.length + 8);
  return chunk;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

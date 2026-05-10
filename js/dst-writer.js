/**
 * DST (Tajima) File Writer — Pure JavaScript
 * Generates machine-ready .DST files from stitch coordinates.
 * Based on the Tajima DST specification.
 */

export class DSTWriter {
  /**
   * Encode a list of stitch objects into a DST binary blob.
   * @param {Array<{x: number, y: number, cmd: string}>} stitches
   *   cmd: 'stitch' | 'jump' | 'end'
   * @returns {Uint8Array}
   */
  static encode(stitches) {
    if (!stitches || stitches.length === 0) {
      return new Uint8Array(0);
    }

    const body = [];
    let prevX = 0;
    let prevY = 0;

    for (const s of stitches) {
      if (s.cmd === 'end') {
        // End command
        body.push(0x00, 0x00, 0xF3);
        break;
      }

      const dx = Math.round(s.x - prevX);
      const dy = Math.round(s.y - prevY);

      // Split large moves into multiple stitches
      const maxStep = 121; // DST max per-stitch displacement
      let remainX = dx;
      let remainY = dy;

      while (Math.abs(remainX) > maxStep || Math.abs(remainY) > maxStep) {
        const stepX = Math.max(-maxStep, Math.min(maxStep, remainX));
        const stepY = Math.max(-maxStep, Math.min(maxStep, remainY));
        const bytes = DSTWriter._encodeStitch(stepX, stepY, s.cmd === 'jump');
        body.push(...bytes);
        remainX -= stepX;
        remainY -= stepY;
      }

      const bytes = DSTWriter._encodeStitch(remainX, remainY, s.cmd === 'jump');
      body.push(...bytes);

      prevX = s.x;
      prevY = s.y;
    }

    // Add end if not already present
    const lastThree = body.slice(-3);
    if (lastThree[2] !== 0xF3) {
      body.push(0x00, 0x00, 0xF3);
    }

    // Build header (512 bytes)
    const header = DSTWriter._buildHeader(stitches);

    // Combine
    const result = new Uint8Array(header.length + body.length);
    result.set(header, 0);
    result.set(new Uint8Array(body), header.length);
    return result;
  }

  /**
   * Encode a single stitch displacement into 3 DST bytes.
   */
  static _encodeStitch(dx, dy, isJump) {
    let b0 = 0, b1 = 0, b2 = 0x03; // bit 0 and bit 1 of b2 always set

    // Y encoding (dy: positive = down in DST)
    const absDy = Math.abs(dy);
    const negY = dy < 0;

    if (absDy & 1)   b0 |= 0x01;
    if (absDy & 2)   b0 |= 0x04;
    if (absDy & 4)   b0 |= 0x10;
    if (absDy & 8)   b0 |= 0x40;
    if (absDy & 16)  b1 |= 0x01;
    if (absDy & 32)  b1 |= 0x04;
    if (absDy & 64)  b1 |= 0x10;

    if (negY) {
      if (absDy & 1)   b0 = (b0 & ~0x01) | 0x02;
      else             b0 |= 0x02;
      if (absDy & 2)   b0 = (b0 & ~0x04) | 0x08;
      else             b0 |= 0x08;
      if (absDy & 4)   b0 = (b0 & ~0x10) | 0x20;
      else             b0 |= 0x20;
      if (absDy & 8)   b0 = (b0 & ~0x40) | 0x80;
      else             b0 |= 0x80;
      if (absDy & 16)  b1 = (b1 & ~0x01) | 0x02;
      else             b1 |= 0x02;
      if (absDy & 32)  b1 = (b1 & ~0x04) | 0x08;
      else             b1 |= 0x08;
      if (absDy & 64)  b1 = (b1 & ~0x10) | 0x20;
      else             b1 |= 0x20;
    }

    // X encoding (dx: positive = right in DST)
    const absDx = Math.abs(dx);
    const negX = dx < 0;

    // Re-encode using proper bit layout
    b0 = 0; b1 = 0; b2 = 0x03;

    // Y bits
    if (dy > 0) {
      if (absDy & 1)  b0 |= 0x01;
      if (absDy & 2)  b0 |= 0x04;
      if (absDy & 4)  b0 |= 0x10;
      if (absDy & 8)  b0 |= 0x40;
      if (absDy & 16) b1 |= 0x01;
      if (absDy & 32) b1 |= 0x04;
      if (absDy & 64) b1 |= 0x10;
    } else if (dy < 0) {
      if (absDy & 1)  b0 |= 0x02;
      if (absDy & 2)  b0 |= 0x08;
      if (absDy & 4)  b0 |= 0x20;
      if (absDy & 8)  b0 |= 0x80;
      if (absDy & 16) b1 |= 0x02;
      if (absDy & 32) b1 |= 0x08;
      if (absDy & 64) b1 |= 0x20;
    }

    // X bits  
    if (dx > 0) {
      if (absDx & 1)  b1 |= 0x40;
      if (absDx & 2)  b2 |= 0x04;
      if (absDx & 4)  b2 |= 0x10;
      if (absDx & 8)  b2 |= 0x40;
      if (absDx & 16) { /* high bit in expansion */ }
      if (absDx & 32) { /* high bit in expansion */ }
    } else if (dx < 0) {
      if (absDx & 1)  b1 |= 0x80;
      if (absDx & 2)  b2 |= 0x08;
      if (absDx & 4)  b2 |= 0x20;
      if (absDx & 8)  b2 |= 0x80;
    }

    if (isJump) {
      b2 |= 0x83; // Jump flag
    }

    return [b0, b1, b2];
  }

  /**
   * Build a 512-byte DST header.
   */
  static _buildHeader(stitches) {
    const header = new Uint8Array(512);
    header.fill(0x20); // Space fill

    // Calculate bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let stitchCount = 0;
    for (const s of stitches) {
      if (s.cmd === 'end') continue;
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
      if (s.cmd === 'stitch') stitchCount++;
    }

    const label = 'LA:SUNSTAR ';
    const stField = `ST:${String(stitchCount).padStart(7, ' ')}`;
    const coField = `CO:  1`;
    const xPlusField = `+X:${String(Math.round(Math.max(0, maxX))).padStart(5, ' ')}`;
    const xMinusField = `-X:${String(Math.round(Math.abs(Math.min(0, minX)))).padStart(5, ' ')}`;
    const yPlusField = `+Y:${String(Math.round(Math.max(0, maxY))).padStart(5, ' ')}`;
    const yMinusField = `-Y:${String(Math.round(Math.abs(Math.min(0, minY)))).padStart(5, ' ')}`;

    const headerStr = `${label}\r${stField}\r${coField}\r${xPlusField}\r${xMinusField}\r${yPlusField}\r${yMinusField}\r`;

    const encoder = new TextEncoder();
    const encoded = encoder.encode(headerStr);
    header.set(encoded, 0);

    // Pad rest with 0x20 (already done)
    // Set byte 512 marker
    return header;
  }

  /**
   * Download DST file.
   */
  static download(stitches, filename = 'PATTERN.DST') {
    const data = DSTWriter.encode(stitches);
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
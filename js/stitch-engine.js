/**
 * Stitch Engine — 오브젝트를 실제 바늘 좌표로 변환
 * Running, Satin, Fill, Chain, French Knot 스티치 지원
 */

export class StitchEngine {
  static dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  static lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  static interpolatePath(pts, step) {
    if (pts.length < 2) return [...pts];
    const result = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const d = StitchEngine.dist(pts[i - 1], pts[i]);
      if (d < 0.01) continue;
      const n = Math.max(1, Math.ceil(d / step));
      for (let j = 1; j <= n; j++) result.push(StitchEngine.lerp(pts[i - 1], pts[i], j / n));
    }
    return result;
  }

  static getCatmullRomPoint(p0, p1, p2, p3, t) {
    const v0 = (p2.x - p0.x) * 0.5;
    const v1 = (p3.x - p1.x) * 0.5;
    const t2 = t * t;
    const t3 = t * t2;
    const x = (2 * p1.x - 2 * p2.x + v0 + v1) * t3 + (-3 * p1.x + 3 * p2.x - 2 * v0 - v1) * t2 + v0 * t + p1.x;

    const w0 = (p2.y - p0.y) * 0.5;
    const w1 = (p3.y - p1.y) * 0.5;
    const y = (2 * p1.y - 2 * p2.y + w0 + w1) * t3 + (-3 * p1.y + 3 * p2.y - 2 * w0 - w1) * t2 + w0 * t + p1.y;

    return { x, y };
  }

  static interpolateSpline(pts, step) {
    if (pts.length < 2) return [...pts];
    if (pts.length < 3) return StitchEngine.interpolatePath(pts, step);

    const result = [];
    const extended = [pts[0], ...pts, pts[pts.length - 1]];

    for (let i = 1; i < extended.length - 2; i++) {
      const p0 = extended[i - 1], p1 = extended[i], p2 = extended[i + 1], p3 = extended[i + 2];
      const d = StitchEngine.dist(p1, p2);
      if (d < 0.01) continue;
      const n = Math.max(1, Math.ceil(d / step));
      for (let j = 0; j < n; j++) {
        result.push(StitchEngine.getCatmullRomPoint(p0, p1, p2, p3, j / n));
      }
    }
    result.push(pts[pts.length - 1]);
    return result;
  }

  static offsetPath(pts, offset) {
    if (pts.length < 2) return [...pts];
    const result = [];
    for (let i = 0; i < pts.length; i++) {
      let dx, dy;
      if (i === 0) { dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y; }
      else if (i === pts.length - 1) { dx = pts[i].x - pts[i - 1].x; dy = pts[i].y - pts[i - 1].y; }
      else { dx = pts[i + 1].x - pts[i - 1].x; dy = pts[i + 1].y - pts[i - 1].y; }
      const len = Math.hypot(dx, dy);
      if (len < 0.01) { result.push({ ...pts[i] }); continue; }
      const nx = -dy / len, ny = dx / len;
      result.push({ x: pts[i].x + nx * offset, y: pts[i].y + ny * offset });
    }
    return result;
  }

  static bbox(pts) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of pts) {
      if (p.x < x1) x1 = p.x; if (p.y < y1) y1 = p.y;
      if (p.x > x2) x2 = p.x; if (p.y > y2) y2 = p.y;
    }
    return { x1, y1, x2, y2 };
  }

  // ─── Stitch Generators ───

  static generateRunning(obj, maxLen = 30) {
    const step = 0.4; // 0.4mm per stitch for smoothness
    if (obj.type === 'curve') {
      return StitchEngine.interpolateSpline(obj.points, step);
    }
    return StitchEngine.interpolatePath(obj.points, step);
  }

  static generateSatin(obj, maxLen = 30) {
    const pts = obj.points;
    const density = obj.density || 2.0;
    const halfW = 4.0; // 고정된 새틴 스티치 너비 (4mm)
    
    let path = pts;
    if (obj.type === 'curve') {
      path = StitchEngine.interpolateSpline(pts, 0.4); // Smooth base path first
    }
    
    const left = StitchEngine.offsetPath(path, halfW);
    const right = StitchEngine.offsetPath(path, -halfW);
    const interpLeft = StitchEngine.interpolatePath(left, density);
    const interpRight = StitchEngine.interpolatePath(right, density);
    const n = Math.min(interpLeft.length, interpRight.length);
    const result = [];
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) { result.push(interpLeft[i]); result.push(interpRight[i]); }
      else { result.push(interpRight[i]); result.push(interpLeft[i]); }
    }
    return result;
  }

  static generateFill(obj, maxLen = 30) {
    const pts = obj.points;
    if (pts.length < 3) return StitchEngine.generateRunning(obj, maxLen);
    const density = obj.density || 2.0;
    const angle = ((obj.angle || 0) * Math.PI) / 180;
    const { x1, y1, x2, y2 } = StitchEngine.bbox(pts);
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const diag = Math.hypot(x2 - x1, y2 - y1) / 2 + 10;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const result = [];
    let row = 0, offset = -diag;
    while (offset <= diag) {
      const lx1 = cx + (-diag) * cosA - offset * sinA, ly1 = cy + (-diag) * sinA + offset * cosA;
      const lx2 = cx + diag * cosA - offset * sinA, ly2 = cy + diag * sinA + offset * cosA;
      const intersections = [];
      for (let i = 0; i < pts.length; i++) {
        const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
        const denom = (p2.x - p1.x) * (ly2 - ly1) - (p2.y - p1.y) * (lx2 - lx1);
        if (Math.abs(denom) < 1e-10) continue;
        const t = ((lx1 - p1.x) * (ly2 - ly1) - (ly1 - p1.y) * (lx2 - lx1)) / denom;
        const u = ((lx1 - p1.x) * (p2.y - p1.y) - (ly1 - p1.y) * (p2.x - p1.x)) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) intersections.push({ x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y), u });
      }
      intersections.sort((a, b) => a.u - b.u);
      for (let i = 0; i < intersections.length - 1; i += 2) {
        let s = intersections[i], e = intersections[i + 1];
        if (row % 2 === 1) [s, e] = [e, s];
        result.push(...StitchEngine.interpolatePath([s, e], 0.4));
      }
      offset += density; row++;
    }
    return result.length > 0 ? result : StitchEngine.generateRunning(obj, maxLen);
  }

  static generateChain(obj, maxLen = 30) {
    const pts = obj.points;
    const step = 8; // Chain loop size
    const result = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const d = StitchEngine.dist(pts[i], pts[i + 1]);
      const n = Math.max(1, Math.ceil(d / step));
      for (let j = 0; j < n; j++) {
        const p1 = StitchEngine.lerp(pts[i], pts[i + 1], j / n);
        const p2 = StitchEngine.lerp(pts[i], pts[i + 1], (j + 0.8) / n);
        const mid = StitchEngine.lerp(p1, p2, 0.5);
        const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len * 4, ny = dx / len * 4;
        result.push(p1, { x: mid.x + nx, y: mid.y + ny }, p2, { x: mid.x - nx, y: mid.y - ny }, p1, p2);
      }
    }
    return result;
  }

  static generateFrenchKnot(obj) {
    const pts = obj.points;
    const result = [];
    for (const p of pts) {
      const r = 3;
      for (let i = 0; i < 6; i++) {
        const t = (i / 6) * Math.PI * 2;
        result.push(p, { x: p.x + r * Math.cos(t), y: p.y + r * Math.sin(t) });
      }
      result.push(p);
    }
    return result;
  }

  static objectToStitches(obj, maxLen = 30) {
    switch (obj.stitch) {
      case 'satin': return StitchEngine.generateSatin(obj, maxLen);
      case 'fill': return StitchEngine.generateFill(obj, maxLen);
      case 'chain': return StitchEngine.generateChain(obj, maxLen);
      case 'knot': return StitchEngine.generateFrenchKnot(obj);
      default: return StitchEngine.generateRunning(obj, maxLen);
    }
  }

  static objectsToDSTStitches(objects, maxStitchLen = 30) {
    const stitches = [];
    let totalCount = 0;
    for (const obj of objects) {
      const pts = StitchEngine.objectToStitches(obj, maxStitchLen);
      if (!pts || pts.length === 0) continue;
      stitches.push({ x: pts[0].x * 10, y: pts[0].y * 10, cmd: 'jump' });
      for (let i = 1; i < pts.length; i++) { stitches.push({ x: pts[i].x * 10, y: pts[i].y * 10, cmd: 'stitch' }); totalCount++; }
    }
    stitches.push({ x: 0, y: 0, cmd: 'end' });
    return { stitches, totalCount };
  }
}

export class PatternPresets {
  static floral(cx = 0, cy = 0) {
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      for (let t = 0; t <= Math.PI; t += 0.2) {
        const r = 40 * Math.sin(t);
        const x = cx + r * Math.cos(angle + t - Math.PI/2);
        const y = cy + r * Math.sin(angle + t - Math.PI/2);
        pts.push({ x, y });
      }
      pts.push({ x: cx, y: cy });
    }
    return pts;
  }

  static bohemian(cx = 0, cy = 0) {
    const pts = [];
    for (let t = -Math.PI; t <= Math.PI; t += 0.1) {
      const r = 50 * (1 + Math.sin(t)) * (1 + 0.3 * Math.cos(8 * t));
      pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    return pts;
  }

  static geometry(cx = 0, cy = 0) {
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const s = 30 + i * 20;
      pts.push({ x: cx - s, y: cy - s }, { x: cx + s, y: cy - s }, { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s }, { x: cx - s, y: cy - s });
      pts.push({ x: cx, y: cy }); // Jump back
    }
    return pts;
  }

  static sashiko(cx = 0, cy = 0) {
    const pts = [];
    const s = 40;
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        const ox = cx + x * s, oy = cy + y * s;
        pts.push({ x: ox - 15, y: oy }, { x: ox + 15, y: oy });
        pts.push({ x: ox, y: oy - 15 }, { x: ox, y: oy + 15 });
      }
    }
    return pts;
  }

  static smocking(cx = 0, cy = 0) {
    const pts = [];
    const s = 25;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const x = cx + i * s, y = cy + j * s + (i % 2) * (s / 2);
        pts.push({ x: x - 5, y: y - 5 }, { x: x + 5, y: y + 5 });
        pts.push({ x: x + 5, y: y - 5 }, { x: x - 5, y: y + 5 });
      }
    }
    return pts;
  }

  static shiftPoints(pts, left = 200, top = 200) {
    if (!pts || pts.length === 0) return pts;
    const minX = Math.min(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y));
    return pts.map(p => ({ x: p.x - minX + left, y: p.y - minY + top }));
  }

  static paisley(cx = 0, cy = 0) {
    const pts = [];
    for (let t = 0; t <= Math.PI * 2; t += 0.1) {
      const r = 60 * Math.pow(Math.sin(t), 2) * (1 + 0.5 * Math.cos(t));
      const x = cx + r * Math.cos(t + Math.PI/4);
      const y = cy + r * Math.sin(t + Math.PI/4);
      pts.push({ x, y });
    }
    return pts;
  }

  static scroll(cx = 0, cy = 0) {
    const pts = [];
    for (let t = 0; t <= 10; t += 0.2) {
      const r = 5 * t;
      pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
    return pts;
  }
}

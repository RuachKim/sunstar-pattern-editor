/**
 * Stitch Engine — 오브젝트를 실제 바늘 좌표로 변환
 * Running, Satin, Fill/Tatami 스티치 지원
 */

export class StitchEngine {
  // ─── 유틸리티 ───
  static dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  static lerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  static interpolatePath(pts, step) {
    if (pts.length < 2) return [...pts];
    const result = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const d = StitchEngine.dist(pts[i - 1], pts[i]);
      if (d < 0.01) continue;
      const n = Math.max(1, Math.ceil(d / step));
      for (let j = 1; j <= n; j++) {
        result.push(StitchEngine.lerp(pts[i - 1], pts[i], j / n));
      }
    }
    return result;
  }

  static offsetPath(pts, offset) {
    if (pts.length < 2) return [...pts];
    const result = [];
    for (let i = 0; i < pts.length; i++) {
      let dx, dy;
      if (i === 0) {
        dx = pts[1].x - pts[0].x;
        dy = pts[1].y - pts[0].y;
      } else if (i === pts.length - 1) {
        dx = pts[i].x - pts[i - 1].x;
        dy = pts[i].y - pts[i - 1].y;
      } else {
        dx = pts[i + 1].x - pts[i - 1].x;
        dy = pts[i + 1].y - pts[i - 1].y;
      }
      const len = Math.hypot(dx, dy);
      if (len < 0.01) {
        result.push({ x: pts[i].x, y: pts[i].y });
        continue;
      }
      const nx = -dy / len;
      const ny = dx / len;
      result.push({ x: pts[i].x + nx * offset, y: pts[i].y + ny * offset });
    }
    return result;
  }

  static bbox(pts) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of pts) {
      if (p.x < x1) x1 = p.x;
      if (p.y < y1) y1 = p.y;
      if (p.x > x2) x2 = p.x;
      if (p.y > y2) y2 = p.y;
    }
    return { x1, y1, x2, y2 };
  }

  // ─── Running Stitch ───
  static generateRunning(obj, maxLen = 30) {
    return StitchEngine.interpolatePath(obj.points, maxLen / 10.0);
  }

  // ─── Satin Stitch ───
  static generateSatin(obj, maxLen = 30) {
    const pts = obj.points;
    const density = obj.density || 2.0;
    const halfW = density * 2;
    const left = StitchEngine.offsetPath(pts, halfW);
    const right = StitchEngine.offsetPath(pts, -halfW);
    const interpLeft = StitchEngine.interpolatePath(left, density);
    const interpRight = StitchEngine.interpolatePath(right, density);
    const n = Math.min(interpLeft.length, interpRight.length);
    const result = [];
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) {
        result.push(interpLeft[i]);
        result.push(interpRight[i]);
      } else {
        result.push(interpRight[i]);
        result.push(interpLeft[i]);
      }
    }
    return result;
  }

  // ─── Fill / Tatami Stitch ───
  static generateFill(obj, maxLen = 30) {
    const pts = obj.points;
    if (pts.length < 3) return StitchEngine.interpolatePath(pts, maxLen / 10.0);

    const density = obj.density || 2.0;
    const angleDeg = obj.angle || 0;
    const angle = (angleDeg * Math.PI) / 180;
    const { x1, y1, x2, y2 } = StitchEngine.bbox(pts);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const diag = Math.hypot(x2 - x1, y2 - y1) / 2 + 10;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const result = [];
    let row = 0;
    let offset = -diag;

    while (offset <= diag) {
      const lx1 = cx + (-diag) * cosA - offset * sinA;
      const ly1 = cy + (-diag) * sinA + offset * cosA;
      const lx2 = cx + diag * cosA - offset * sinA;
      const ly2 = cy + diag * sinA + offset * cosA;

      // Find intersections with polygon edges
      const intersections = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i].x, ay = pts[i].y;
        const bx = pts[i + 1].x, by = pts[i + 1].y;
        const denom = (bx - ax) * (ly2 - ly1) - (by - ay) * (lx2 - lx1);
        if (Math.abs(denom) < 1e-10) continue;
        const t = ((lx1 - ax) * (ly2 - ly1) - (ly1 - ay) * (lx2 - lx1)) / denom;
        const u = ((lx1 - ax) * (by - ay) - (ly1 - ay) * (bx - ax)) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          intersections.push({
            x: ax + t * (bx - ax),
            y: ay + t * (by - ay),
            u
          });
        }
      }

      intersections.sort((a, b) => a.u - b.u);

      for (let i = 0; i < intersections.length - 1; i += 2) {
        let segStart = intersections[i];
        let segEnd = intersections[i + 1];
        if (row % 2 === 1) [segStart, segEnd] = [segEnd, segStart];
        const seg = StitchEngine.interpolatePath([segStart, segEnd], maxLen / 10.0);
        result.push(...seg);
      }

      offset += density;
      row++;
    }

    return result.length > 0 ? result : StitchEngine.interpolatePath(pts, maxLen / 10.0);
  }

  // ─── 오브젝트 → 스티치 좌표 변환 ───
  static objectToStitches(obj, maxLen = 30) {
    const stType = obj.stitch || 'running';
    switch (stType) {
      case 'satin': return StitchEngine.generateSatin(obj, maxLen);
      case 'fill': return StitchEngine.generateFill(obj, maxLen);
      default: return StitchEngine.generateRunning(obj, maxLen);
    }
  }

  // ─── 전체 오브젝트 배열 → DST 스티치 명령 ───
  static objectsToDSTStitches(objects, maxStitchLen = 30) {
    const stitches = [];
    let totalCount = 0;

    for (const obj of objects) {
      const pts = StitchEngine.objectToStitches(obj, maxStitchLen);
      if (!pts || pts.length === 0) continue;

      // Jump to first point
      stitches.push({ x: pts[0].x * 10, y: pts[0].y * 10, cmd: 'jump' });

      for (let i = 1; i < pts.length; i++) {
        stitches.push({ x: pts[i].x * 10, y: pts[i].y * 10, cmd: 'stitch' });
        totalCount++;
      }
    }

    stitches.push({ x: 0, y: 0, cmd: 'end' });
    return { stitches, totalCount };
  }
}

// ─── 프리셋 패턴 생성기 ───
export class PatternPresets {
  static zigzag(width = 200, height = 60, repeats = 5) {
    const pts = [];
    const step = repeats > 0 ? width / (repeats * 2) : width;
    for (let i = 0; i <= repeats * 2; i++) {
      pts.push({ x: i * step, y: i % 2 === 1 ? height : 0 });
    }
    return pts;
  }

  static scallop(width = 200, height = 40, repeats = 4, ppc = 16) {
    const pts = [];
    if (repeats === 0) return [{ x: 0, y: 0 }, { x: width, y: 0 }];
    const step = width / (repeats * ppc);
    for (let i = 0; i <= repeats * ppc; i++) {
      const t = ((i % ppc) / ppc) * Math.PI;
      pts.push({ x: i * step, y: height * Math.sin(t) });
    }
    return pts;
  }

  static clover(diameter = 120, n = 80) {
    const pts = [];
    const a = diameter / 2;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      const r = a * Math.cos(2 * t);
      pts.push({ x: r * Math.cos(t) + a, y: r * Math.sin(t) + a });
    }
    return pts;
  }

  static diamond(width = 120, height = 120) {
    return [
      { x: width / 2, y: 0 },
      { x: width, y: height / 2 },
      { x: width / 2, y: height },
      { x: 0, y: height / 2 },
      { x: width / 2, y: 0 },
    ];
  }

  static rect(w = 100, h = 80) {
    return [
      { x: 0, y: 0 }, { x: w, y: 0 },
      { x: w, y: h }, { x: 0, y: h }, { x: 0, y: 0 }
    ];
  }

  static ellipse(rx = 60, ry = 60, n = 48) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      pts.push({ x: rx + rx * Math.cos(t), y: ry + ry * Math.sin(t) });
    }
    return pts;
  }

  static star(outerR = 80, innerR = 35, points = 5) {
    const pts = [];
    const total = points * 2;
    for (let i = 0; i <= total; i++) {
      const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? outerR : innerR;
      pts.push({ x: outerR + r * Math.cos(angle), y: outerR + r * Math.sin(angle) });
    }
    return pts;
  }

  static heart(size = 100) {
    const pts = [];
    const n = 60;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      pts.push({ x: (x / 16) * (size / 2) + size / 2, y: (y / 16) * (size / 2) + size / 2 });
    }
    return pts;
  }

  static shiftPoints(pts, left = 50, top = 50) {
    if (!pts || pts.length === 0) return pts;
    const mx = Math.min(...pts.map(p => p.x));
    const my = Math.min(...pts.map(p => p.y));
    return pts.map(p => ({ x: p.x - mx + left, y: p.y - my + top }));
  }
}
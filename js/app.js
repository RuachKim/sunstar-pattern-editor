import { StitchEngine, PatternPresets } from './stitch-engine.js';
import { DSTWriter } from './dst-writer.js';

const state = {
  objects: [],
  selectedIdx: -1,
  tool: 'select',
  cam: { x: 200, y: 200, z: 1 },
  undoStack: [],
  redoStack: [],
  maxStitchLen: 30,
};

let drag = null, drawPts = null, drawStart = null, tempPos = null;
let panning = false, panStart = null;
let pendingPatternObjects = []; // Stores captured objects before applying

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  const bg = type === 'error' ? 'rgba(231,76,60,0.95)' : 'rgba(46,204,113,0.95)';
  toast.style.cssText = `background:${bg}; color:#fff; padding:12px 24px; border-radius:12px; font-size:14px; font-weight:500; box-shadow:0 8px 24px rgba(0,0,0,0.2); backdrop-filter:blur(8px); transform:translateX(100%); opacity:0; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); display:flex; align-items:center; gap:8px;`;
  toast.innerHTML = `<span style="font-size:18px">${type === 'error' ? '⚠️' : '✨'}</span> ${message}`;
  container.appendChild(toast);
  
  // Trigger animation
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(0)';
    toast.style.opacity = '1';
  });
  
  setTimeout(() => {
    toast.style.transform = 'translateX(100%)';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

const guides = {
  line: "시작점과 끝점을 찍으세요.",
  arch: "양 끝점을 찍고, 굽은 정도를 정하세요.",
  circle: "중심을 찍고 크기만큼 당기세요.",
  rect: "양쪽 모서리 두 곳을 찍으세요.",
  pulse: "시작과 끝을 찍으면 계단이 생깁니다.",
  curve: "원하는 모양대로 점을 계속 찍으세요. (더블클릭/시작점 클릭으로 종료)",
  select: "오브젝트를 선택하세요.",
  hand: "화면을 드래그하여 이동하세요.",
  eraser: "지울 오브젝트를 클릭하세요.",
  node: "오브젝트의 노드를 이동하세요."
};

function getArch(p0, p1, p2) {
  let pts = [];
  for(let i=0; i<=20; i++) {
    let t = i/20, inv = 1-t;
    let x = inv*inv*p0.x + 2*inv*t*p2.x + t*t*p1.x;
    let y = inv*inv*p0.y + 2*inv*t*p2.y + t*t*p1.y;
    pts.push({x,y});
  }
  return pts;
}

function getPulse(p0, p1) {
  let dx = p1.x - p0.x, dy = p1.y - p0.y;
  let len = Math.hypot(dx, dy);
  if(len < 1) return [p0, p1];
  let ux = dx/len, uy = dy/len, nx = -uy, ny = ux;
  let pts = [];
  let steps = Math.max(3, Math.floor(len / 10));
  for(let i=0; i<steps; i++) {
    let t1 = i/steps, t2 = (i+1)/steps;
    pts.push({x: p0.x + dx*t1, y: p0.y + dy*t1});
    pts.push({x: p0.x + dx*t1 + nx*10, y: p0.y + dy*t1 + ny*10});
    pts.push({x: p0.x + dx*t2 + nx*10, y: p0.y + dy*t2 + ny*10});
    pts.push({x: p0.x + dx*t2, y: p0.y + dy*t2});
  }
  return pts;
}

// ─── DOM refs ───
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const hud = document.getElementById('hud');
const pos = document.getElementById('pos');
const objList = document.getElementById('object-list');

// ─── Canvas resize ───
function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  cv.width = wrap.clientWidth;
  cv.height = wrap.clientHeight;
  render();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Helpers ───
function uid() { return Math.random().toString(36).slice(2, 10); }
function snap(v) {
  const chk = document.getElementById('chk-snap');
  const snapVal = chk && chk.checked ? 10 : 1;
  return Math.round(v / snapVal) * snapVal;
}
function s2w(sx, sy) { return { x: (sx - cv.width / 2) / state.cam.z + state.cam.x, y: (sy - cv.height / 2) / state.cam.z + state.cam.y }; }
function w2s(wx, wy) { return { x: (wx - state.cam.x) * state.cam.z + cv.width / 2, y: (wy - state.cam.y) * state.cam.z + cv.height / 2 }; }
function bbox(pts) {
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const p of pts) { if (p.x < x1) x1 = p.x; if (p.y < y1) y1 = p.y; if (p.x > x2) x2 = p.x; if (p.y > y2) y2 = p.y; }
  return { x1, y1, x2, y2 };
}

// ─── Undo/Redo ───
function saveUndo() {
  state.undoStack.push(JSON.stringify(state.objects));
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
}

function undo() {
  if (state.undoStack.length === 0) return;
  state.redoStack.push(JSON.stringify(state.objects));
  state.objects = JSON.parse(state.undoStack.pop());
  state.selectedIdx = -1;
  render(); updateUI();
}

function redo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(JSON.stringify(state.objects));
  state.objects = JSON.parse(state.redoStack.pop());
  state.selectedIdx = -1;
  render(); updateUI();
}

// ─── RDP & Chaikin ───
function rdp(pts, e) {
  if (pts.length <= 2) return pts;
  let mx = 0, mi = 0;
  const f = pts[0], l = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const dx = l.x - f.x, dy = l.y - f.y, len = Math.hypot(dx, dy) || 1;
    const d = Math.abs((pts[i].x - f.x) * dy - (pts[i].y - f.y) * dx) / len;
    if (d > mx) { mx = d; mi = i; }
  }
  if (mx > e) {
    const a = rdp(pts.slice(0, mi + 1), e);
    const b = rdp(pts.slice(mi), e);
    return a.slice(0, -1).concat(b);
  }
  return [f, l];
}

function chaikin(pts, n) {
  let r = pts;
  for (let k = 0; k < n; k++) {
    const nw = [r[0]];
    for (let i = 0; i < r.length - 1; i++) {
      nw.push({ x: .75 * r[i].x + .25 * r[i + 1].x, y: .75 * r[i].y + .25 * r[i + 1].y });
      nw.push({ x: .25 * r[i].x + .75 * r[i + 1].x, y: .25 * r[i].y + .75 * r[i + 1].y });
    }
    nw.push(r[r.length - 1]);
    r = nw;
  }
  return r;
}

// ─── Rendering ───
function drawGrid() {
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const gz = 20 * state.cam.z;
  if (gz < 3) return;
  const ox = W / 2 - state.cam.x * state.cam.z;
  const oy = H / 2 - state.cam.y * state.cam.z;

  ctx.strokeStyle = gz > 8 ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.02)';
  ctx.lineWidth = 1;
  let sx = ox % gz; while (sx < 0) sx += gz;
  for (let x = sx; x < W; x += gz) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  let sy = oy % gz; while (sy < 0) sy += gz;
  for (let y = sy; y < H; y += gz) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const gz5 = gz * 5;
  ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1;
  let sx5 = ox % gz5; while (sx5 < 0) sx5 += gz5;
  for (let x = sx5; x < W; x += gz5) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  let sy5 = oy % gz5; while (sy5 < 0) sy5 += gz5;
  for (let y = sy5; y < H; y += gz5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Origin axes
  const o = w2s(0, 0);
  ctx.strokeStyle = 'rgba(239,68,68,.6)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, H); ctx.stroke();
  ctx.strokeStyle = 'rgba(16,185,129,.6)';
  ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(W, o.y); ctx.stroke();
}

function drawObj(o, idx) {
  const pts = o.points;
  if (!pts || !pts.length) return;
  const c = o.color || '#4361ee';

  if (['fill', 'satin'].includes(o.stitch) && pts.length > 2) {
    ctx.beginPath();
    let sp = w2s(pts[0].x, pts[0].y);
    ctx.moveTo(sp.x, sp.y);
    for (let i = 1; i < pts.length; i++) { sp = w2s(pts[i].x, pts[i].y); ctx.lineTo(sp.x, sp.y); }
    ctx.globalAlpha = 0.12; ctx.fillStyle = c; ctx.fill(); ctx.globalAlpha = 1;
  }

  // Draw Stitches
  const stitches = StitchEngine.objectToStitches(o, state.maxStitchLen);
  ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  if (stitches && stitches.length > 0) {
    let sp = w2s(stitches[0].x, stitches[0].y);
    ctx.moveTo(sp.x, sp.y);
    for (let i = 1; i < stitches.length; i++) { 
       sp = w2s(stitches[i].x, stitches[i].y); 
       ctx.lineTo(sp.x, sp.y); 
    }
  }
  ctx.stroke();

  // Label
  const b = bbox(pts);
  const bs = w2s(b.x1, b.y1);
  ctx.font = '9px sans-serif'; ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fillText({ running: 'Run', satin: 'Satin', fill: 'Fill' }[o.stitch] || '', bs.x, bs.y - 4);

  // Selection highlight / Nodes
  if (idx === state.selectedIdx) {
    if (state.tool === 'select') {
      const s1 = w2s(b.x1, b.y1), s2 = w2s(b.x2, b.y2);
      ctx.strokeStyle = '#4361ee'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(s1.x - 4, s1.y - 4, s2.x - s1.x + 8, s2.y - s1.y + 8);
      ctx.setLineDash([]);
      for (const h of [s1, { x: s2.x, y: s1.y }, s2, { x: s1.x, y: s2.y }]) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4361ee'; ctx.lineWidth = 1.5;
        ctx.fillRect(h.x - 5, h.y - 5, 10, 10);
        ctx.strokeRect(h.x - 5, h.y - 5, 10, 10);
      }
    } else if (state.tool === 'node') {
      // Draw nodes
      const nPts = o.controlPoints || pts;
      for (let j = 0; j < nPts.length; j++) {
        const p = w2s(nPts[j].x, nPts[j].y);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }
}

function render() {
  drawGrid();

  for (let i = 0; i < state.objects.length; i++) drawObj(state.objects[i], i);

  if (drawPts && drawPts.length > 0) {
    let pts = [...drawPts];
    if (tempPos && state.tool !== 'circle') pts.push(tempPos);
    ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    
    if (state.tool === 'line' || state.tool === 'curve') {
      let sp = w2s(pts[0].x, pts[0].y); ctx.moveTo(sp.x, sp.y);
      for (let i = 1; i < pts.length; i++) { let ep = w2s(pts[i].x, pts[i].y); ctx.lineTo(ep.x, ep.y); }
    } else if (state.tool === 'arch') {
      if (drawPts.length === 1 && tempPos) {
        let p0 = w2s(pts[0].x, pts[0].y), p1 = w2s(tempPos.x, tempPos.y);
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
      } else if (drawPts.length === 2 && tempPos) {
        let arch = getArch(drawPts[0], drawPts[1], tempPos);
        let s0 = w2s(arch[0].x, arch[0].y); ctx.moveTo(s0.x, s0.y);
        for(let i=1; i<arch.length; i++) { let sp = w2s(arch[i].x, arch[i].y); ctx.lineTo(sp.x, sp.y); }
      }
    } else if (state.tool === 'rect') {
      if (pts.length > 1) {
        let p0 = w2s(pts[0].x, pts[0].y), p1 = w2s(pts[1].x, pts[1].y);
        ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      }
    } else if (state.tool === 'pulse') {
      if (pts.length > 1) {
        let pulse = getPulse(pts[0], pts[1]);
        let s0 = w2s(pulse[0].x, pulse[0].y); ctx.moveTo(s0.x, s0.y);
        for(let i=1; i<pulse.length; i++) { let sp = w2s(pulse[i].x, pulse[i].y); ctx.lineTo(sp.x, sp.y); }
      }
    }
    ctx.stroke();
  }

  if (state.tool === 'circle' && drawStart) {
    ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const cx2 = drawStart.cx, cy2 = drawStart.cy;
    const r = Math.hypot(drawStart.ex - drawStart.cx, drawStart.ey - drawStart.cy);
    const c_s = w2s(cx2, cy2);
    ctx.arc(c_s.x, c_s.y, r * state.cam.z, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  let guideTxt = guides[state.tool] || '';
  hud.innerHTML = `${guideTxt} <span style="font-weight:normal;font-size:11px;color:#888;margin-left:12px">줌: ${Math.round(state.cam.z * 100)}%</span>`;

  const cursors = { select: 'default', eraser: 'pointer', hand: 'grab' };
  cv.style.cursor = cursors[state.tool] || 'crosshair';
}

// ─── Hit test ───
function hitObj(mx, my) {
  const w = s2w(mx, my);
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const b = bbox(state.objects[i].points);
    if (w.x >= b.x1 - 8 && w.x <= b.x2 + 8 && w.y >= b.y1 - 8 && w.y <= b.y2 + 8) return i;
  }
  return -1;
}

// ─── Mouse/Touch events ───
cv.addEventListener('pointerdown', e => {
  const mx = e.offsetX, my = e.offsetY;
  const w = s2w(mx, my), sw = snap(w.x), sh = snap(w.y);

  if (state.tool === 'hand' || e.button === 1 || (e.button === 2)) {
    panning = true;
    panStart = { mx, my, cx: state.cam.x, cy: state.cam.y };
    cv.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;

  if (state.tool === 'select') {
    const oi = hitObj(mx, my);
    if (oi >= 0) {
      state.selectedIdx = oi;
      const obj = state.objects[oi];
      drag = { 
        t: 'move', 
        orig: obj.points.map(p => ({ x: p.x, y: p.y })), 
        origCtrl: obj.controlPoints ? obj.controlPoints.map(p => ({ x: p.x, y: p.y })) : null,
        wx: w.x, wy: w.y 
      };
      saveUndo();
      render(); updateUI();
      return;
    }
    state.selectedIdx = -1;
    render(); updateUI();
  } else if (state.tool === 'node') {
    if (state.selectedIdx >= 0) {
      const obj = state.objects[state.selectedIdx];
      const nPts = obj.controlPoints || obj.points;
      for (let i = 0; i < nPts.length; i++) {
        const p = w2s(nPts[i].x, nPts[i].y);
        if (Math.hypot(mx - p.x, my - p.y) < 8) {
          drag = { t: 'node', nodeIdx: i };
          saveUndo();
          return;
        }
      }
    }
    const oi = hitObj(mx, my);
    state.selectedIdx = oi >= 0 ? oi : -1;
    render(); updateUI();
  } else if (state.tool === 'eraser') {
    const oi = hitObj(mx, my);
    if (oi >= 0) { saveUndo(); state.objects.splice(oi, 1); if (state.selectedIdx >= state.objects.length) state.selectedIdx = -1; render(); updateUI(); }
  } else if (['line', 'rect', 'pulse'].includes(state.tool)) {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else if (drawPts.length === 1) {
      drawPts.push({x:sw, y:sh});
      saveUndo();
      let finalPts = [];
      let name = '';
      if (state.tool === 'line') { finalPts = drawPts; name = '직선'; }
      else if (state.tool === 'rect') { 
         finalPts = [{x:drawPts[0].x, y:drawPts[0].y}, {x:drawPts[1].x, y:drawPts[0].y}, {x:drawPts[1].x, y:drawPts[1].y}, {x:drawPts[0].x, y:drawPts[1].y}, {x:drawPts[0].x, y:drawPts[0].y}]; 
         name = '사각형'; 
      }
      else if (state.tool === 'pulse') { 
         finalPts = getPulse(drawPts[0], drawPts[1]); 
         name = '펄스'; 
      }
      state.objects.push({ id: uid(), type: state.tool, points: finalPts, stitch: state.tool === 'rect' ? 'fill' : 'running', density: 2, angle: 0, color: '#4361ee', name: name });
      drawPts = null;
      updateUI();
    }
    render();
  } else if (state.tool === 'arch') {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else if (drawPts.length === 1) drawPts.push({x:sw, y:sh});
    else if (drawPts.length === 2) {
      saveUndo();
      let finalPts = getArch(drawPts[0], drawPts[1], {x:sw, y:sh});
      state.objects.push({ id: uid(), type: 'arch', points: finalPts, controlPoints: [drawPts[0], drawPts[1], {x:sw, y:sh}], stitch: 'running', density: 2, angle: 0, color: '#4361ee', name: '호' });
      drawPts = null;
      updateUI();
    }
    render();
  } else if (state.tool === 'curve') {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else {
      if (Math.hypot(sw - drawPts[0].x, sh - drawPts[0].y) < 10 && drawPts.length > 2) {
        drawPts.push({x: drawPts[0].x, y: drawPts[0].y});
        saveUndo();
        state.objects.push({ id: uid(), type: 'curve', points: drawPts, stitch: 'running', density: 2, angle: 0, color: '#4361ee', name: '자유곡선' });
        drawPts = null;
        updateUI();
      } else {
        drawPts.push({x:sw, y:sh});
      }
    }
    render();
  } else if (state.tool === 'circle') {
    drawStart = { cx: sw, cy: sh, ex: sw, ey: sh };
  }
});

cv.addEventListener('pointermove', e => {
  const mx = e.offsetX, my = e.offsetY, w = s2w(mx, my);
  tempPos = { x: snap(w.x), y: snap(w.y) };
  pos.textContent = `${(w.x / 20).toFixed(1)}, ${(-w.y / 20).toFixed(1)} cm`;

  if (panning && panStart) {
    state.cam.x = panStart.cx - (mx - panStart.mx) / state.cam.z;
    state.cam.y = panStart.cy - (my - panStart.my) / state.cam.z;
    render(); return;
  }

  if (state.tool === 'select' && drag && drag.t === 'move') {
    const dx = snap(w.x - drag.wx), dy = snap(w.y - drag.wy);
    for (let j = 0; j < drag.orig.length; j++) {
      state.objects[state.selectedIdx].points[j].x = drag.orig[j].x + dx;
      state.objects[state.selectedIdx].points[j].y = drag.orig[j].y + dy;
    }
    if (drag.origCtrl) {
      for (let j = 0; j < drag.origCtrl.length; j++) {
        state.objects[state.selectedIdx].controlPoints[j].x = drag.origCtrl[j].x + dx;
        state.objects[state.selectedIdx].controlPoints[j].y = drag.origCtrl[j].y + dy;
      }
    }
    render();
  } else if (state.tool === 'node' && drag && drag.t === 'node') {
    const obj = state.objects[state.selectedIdx];
    if (obj.controlPoints) {
      obj.controlPoints[drag.nodeIdx].x = snap(w.x);
      obj.controlPoints[drag.nodeIdx].y = snap(w.y);
      if (obj.type === 'arch') {
        obj.points = getArch(obj.controlPoints[0], obj.controlPoints[1], obj.controlPoints[2]);
      }
    } else {
      obj.points[drag.nodeIdx].x = snap(w.x);
      obj.points[drag.nodeIdx].y = snap(w.y);
    }
    render();
  } else if (state.tool === 'circle' && drawStart) {
    drawStart.ex = tempPos.x; drawStart.ey = tempPos.y;
    render();
  } else if (drawPts && drawPts.length > 0) {
    render();
  }
});

cv.addEventListener('pointerup', e => {
  if (panning) { panning = false; cv.style.cursor = state.tool === 'hand' ? 'grab' : 'default'; return; }
  if (drag) { drag = null; render(); return; }

  if (state.tool === 'circle' && drawStart) {
    saveUndo();
    const cx2 = drawStart.cx, cy2 = drawStart.cy;
    const r = Math.hypot(drawStart.ex - drawStart.cx, drawStart.ey - drawStart.cy);
    if (r > 1) {
      const pts = [];
      for (let i = 0; i <= 48; i++) { const t = i / 48 * Math.PI * 2; pts.push({ x: cx2 + r * Math.cos(t), y: cy2 + r * Math.sin(t) }); }
      state.objects.push({ id: uid(), type: 'circle', points: pts, stitch: 'satin', density: 2, angle: 0, color: '#4361ee', name: '원' });
      updateUI();
    }
    drawStart = null; render();
  }
});

cv.addEventListener('dblclick', () => {
  if (state.tool === 'curve' && drawPts && drawPts.length > 1) {
    saveUndo();
    state.objects.push({ id: uid(), type: 'curve', points: drawPts, stitch: 'running', density: 2, angle: 0, color: '#4361ee', name: '자유곡선' });
    drawPts = null; render(); updateUI();
  }
});

cv.addEventListener('wheel', e => {
  e.preventDefault();
  const w = s2w(e.offsetX, e.offsetY);
  if (e.deltaY < 0) state.cam.z = Math.min(state.cam.z * 1.15, 5);
  else state.cam.z = Math.max(state.cam.z / 1.15, 0.15);
  state.cam.x = w.x - (e.offsetX - cv.width / 2) / state.cam.z;
  state.cam.y = w.y - (e.offsetY - cv.height / 2) / state.cam.z;
  render();
}, { passive: false });

let initialPinchDist = null;
let initialCamZ = null;
let initialPinchW = null;

cv.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const t1 = e.touches[0], t2 = e.touches[1];
    initialPinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    initialCamZ = state.cam.z;
    const rect = cv.getBoundingClientRect();
    const mx = (t1.clientX + t2.clientX) / 2 - rect.left;
    const my = (t1.clientY + t2.clientY) / 2 - rect.top;
    initialPinchW = s2w(mx, my);
  }
}, {passive: false});

cv.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && initialPinchDist) {
    e.preventDefault();
    const t1 = e.touches[0], t2 = e.touches[1];
    const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    const scale = dist / initialPinchDist;
    
    state.cam.z = Math.max(0.15, Math.min(5, initialCamZ * scale));
    
    const rect = cv.getBoundingClientRect();
    const mx = (t1.clientX + t2.clientX) / 2 - rect.left;
    const my = (t1.clientY + t2.clientY) / 2 - rect.top;
    
    state.cam.x = initialPinchW.x - (mx - cv.width / 2) / state.cam.z;
    state.cam.y = initialPinchW.y - (my - cv.height / 2) / state.cam.z;
    
    render();
  }
}, {passive: false});

cv.addEventListener('touchend', e => {
  if (e.touches.length < 2) {
    initialPinchDist = null;
  }
});

cv.addEventListener('contextmenu', e => e.preventDefault());

// ─── Keyboard shortcuts ───
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'y') { e.preventDefault(); redo(); }
  }
  const keyMap = { v: 'select', h: 'hand', e: 'eraser', l: 'line', a: 'arch', c: 'circle', r: 'rect', p: 'pulse', f: 'curve' };
  if (keyMap[e.key] && !e.ctrlKey && !e.metaKey) setTool(keyMap[e.key]);
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selectedIdx >= 0) {
      saveUndo();
      state.objects.splice(state.selectedIdx, 1);
      state.selectedIdx = -1;
      render(); updateUI();
    }
  }
});

// ─── Tool selection ───
function setTool(t) {
  state.tool = t;
  drawPts = null; drawStart = null;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.getElementById('status-tool').textContent = `도구: ${ { select: '선택', node: '노드편집', hand: '이동', eraser: '지우기', line: '직선', arch: '호', curve: '자유곡선', pulse: '펄스', rect: '사각형', circle: '원' }[t] || t}`;
  render();
}

document.querySelectorAll('.tool-btn').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

// ─── Presets ───
document.querySelectorAll('.preset-btn').forEach(b => {
  b.addEventListener('click', () => {
    saveUndo();
    let pts, stitch = 'running', name = '';
    switch (b.dataset.preset) {
      case 'zigzag': pts = PatternPresets.shiftPoints(PatternPresets.zigzag(), 100, 100); name = '지그재그'; break;
      case 'scallop': pts = PatternPresets.shiftPoints(PatternPresets.scallop(), 100, 100); name = '스캘럽'; break;
      case 'clover': pts = PatternPresets.shiftPoints(PatternPresets.clover(), 100, 100); stitch = 'fill'; name = '클로버'; break;
      case 'diamond': pts = PatternPresets.shiftPoints(PatternPresets.diamond(), 100, 100); stitch = 'fill'; name = '다이아몬드'; break;
      case 'star': pts = PatternPresets.shiftPoints(PatternPresets.star(), 100, 100); stitch = 'fill'; name = '별'; break;
      case 'heart': pts = PatternPresets.shiftPoints(PatternPresets.heart(), 100, 100); stitch = 'fill'; name = '하트'; break;
      case 'rect-fill': pts = PatternPresets.shiftPoints(PatternPresets.rect(), 100, 100); stitch = 'fill'; name = '사각형'; break;
      case 'circle-satin': pts = PatternPresets.shiftPoints(PatternPresets.ellipse(), 100, 100); stitch = 'satin'; name = '원'; break;
    }
    if (pts) {
      state.objects.push({ id: uid(), type: 'preset', points: pts, stitch, density: 2, angle: 0, color: '#4361ee', name });
      render(); updateUI();
    }
  });
});

// ─── UI Updates ───
function updateUI() {
  // Object list
  objList.innerHTML = '';
  if (state.objects.length === 0) {
    objList.innerHTML = '<div class="empty-state"><span class="icon">📐</span>도형을 그리거나<br>프리셋을 추가하세요</div>';
  } else {
    state.objects.forEach((o, i) => {
      const div = document.createElement('div');
      div.className = 'obj-item' + (i === state.selectedIdx ? ' selected' : '');
      div.innerHTML = `<span class="color-dot" style="background:${o.color}"></span><span class="name">${o.name || o.type}</span><button class="del-btn" data-idx="${i}">✕</button>`;
      div.addEventListener('click', e => {
        if (e.target.classList.contains('del-btn')) {
          saveUndo(); state.objects.splice(i, 1); state.selectedIdx = -1; render(); updateUI();
          return;
        }
        state.selectedIdx = i; render(); updateUI();
      });
      objList.appendChild(div);
    });
  }

  // Property panel
  const sel = state.selectedIdx >= 0 ? state.objects[state.selectedIdx] : null;
  document.querySelectorAll('.stitch-btn').forEach(b => b.classList.toggle('active', sel && sel.stitch === b.dataset.stitch));
  if (sel) {
    document.getElementById('sl-density').value = sel.density;
    document.getElementById('val-density').textContent = sel.density.toFixed(1);
    document.getElementById('sl-angle').value = sel.angle;
    document.getElementById('val-angle').textContent = sel.angle + '°';
    document.getElementById('inp-color').value = sel.color;
    document.getElementById('val-color').textContent = sel.color;
  }

  // Export stats
  const { totalCount } = StitchEngine.objectsToDSTStitches(state.objects, state.maxStitchLen);
  document.getElementById('stat-stitches').textContent = totalCount.toLocaleString();
  document.getElementById('stat-time').textContent = `~${Math.max(1, Math.round(totalCount / 800))}분`;
  document.getElementById('btn-export').disabled = state.objects.length === 0;

  document.getElementById('status-objs').textContent = `오브젝트: ${state.objects.length}`;
}

// ─── Property controls ───
document.querySelectorAll('.stitch-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (state.selectedIdx < 0) return;
    saveUndo();
    state.objects[state.selectedIdx].stitch = b.dataset.stitch;
    render(); updateUI();
  });
});

document.getElementById('sl-density').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  document.getElementById('val-density').textContent = v.toFixed(1);
  if (state.selectedIdx >= 0) { 
    state.objects[state.selectedIdx].density = v; 
    render();
    const { totalCount } = StitchEngine.objectsToDSTStitches(state.objects, state.maxStitchLen);
    document.getElementById('stat-stitches').textContent = totalCount.toLocaleString();
    document.getElementById('stat-time').textContent = `~${Math.max(1, Math.round(totalCount / 800))}분`;
  }
});

document.getElementById('sl-angle').addEventListener('input', e => {
  const v = parseInt(e.target.value);
  document.getElementById('val-angle').textContent = v + '°';
  if (state.selectedIdx >= 0) { 
    state.objects[state.selectedIdx].angle = v; 
    render(); 
  }
});

document.getElementById('inp-color').addEventListener('input', e => {
  document.getElementById('val-color').textContent = e.target.value;
  if (state.selectedIdx >= 0) { 
    state.objects[state.selectedIdx].color = e.target.value; 
    render(); 
    const selectedDot = objList.querySelector('.obj-item.selected .color-dot');
    if (selectedDot) selectedDot.style.background = e.target.value;
  }
});

document.getElementById('sl-maxlen').addEventListener('input', e => {
  state.maxStitchLen = parseInt(e.target.value);
  document.getElementById('val-maxlen').textContent = e.target.value;
  updateUI();
});

// ─── Buttons ───
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-eraser-top').addEventListener('click', () => {
  setTool('eraser');
});
document.getElementById('btn-clear-all').addEventListener('click', () => {
  if (state.objects.length === 0) return;
  saveUndo();
  state.objects = []; state.selectedIdx = -1;
  drawPts = null; drawStart = null; tempPos = null; drag = null;
  render(); updateUI();
});

document.getElementById('btn-export').addEventListener('click', () => {
  if (state.objects.length === 0) return;
  const { stitches } = StitchEngine.objectsToDSTStitches(state.objects, state.maxStitchLen);
  DSTWriter.download(stitches, 'PATTERN.DST');
});

// ─── Transformer ───
function transformSelected(type) {
  if (state.selectedIdx < 0) return;
  saveUndo();
  const obj = state.objects[state.selectedIdx];
  const b = bbox(obj.points);
  const cx = (b.x1 + b.x2) / 2;
  const cy = (b.y1 + b.y2) / 2;

  obj.points.forEach(p => {
    let nx = p.x, ny = p.y;
    if (type === 'flip-h') {
      nx = cx - (p.x - cx);
    } else if (type === 'flip-v') {
      ny = cy - (p.y - cy);
    } else if (type === 'rot-cw') {
      nx = cx - (p.y - cy);
      ny = cy + (p.x - cx);
    } else if (type === 'rot-ccw') {
      nx = cx + (p.y - cy);
      ny = cy - (p.x - cx);
    }
    p.x = nx; p.y = ny;
  });
  if (obj.controlPoints) {
    obj.controlPoints.forEach(p => {
      let nx = p.x, ny = p.y;
      if (type === 'flip-h') {
        nx = cx - (p.x - cx);
      } else if (type === 'flip-v') {
        ny = cy - (p.y - cy);
      } else if (type === 'rot-cw') {
        nx = cx - (p.y - cy);
        ny = cy + (p.x - cx);
      } else if (type === 'rot-ccw') {
        nx = cx + (p.y - cy);
        ny = cy - (p.x - cx);
      }
      p.x = nx; p.y = ny;
    });
  }
  render(); updateUI();
}

document.getElementById('btn-flip-h').addEventListener('click', () => transformSelected('flip-h'));
document.getElementById('btn-flip-v').addEventListener('click', () => transformSelected('flip-v'));
document.getElementById('btn-rotate-cw').addEventListener('click', () => transformSelected('rot-cw'));
document.getElementById('btn-rotate-ccw').addEventListener('click', () => transformSelected('rot-ccw'));

document.getElementById('btn-mirror-copy').addEventListener('click', () => {
  if (state.selectedIdx < 0) return;
  saveUndo();
  const obj = state.objects[state.selectedIdx];
  const b = bbox(obj.points);
  
  // Clone object
  const newObj = JSON.parse(JSON.stringify(obj));
  newObj.id = uid();
  newObj.name = (obj.name || obj.type) + ' (대칭)';
  
  // Mirror across the right edge (x2)
  newObj.points.forEach(p => {
    p.x = b.x2 + (b.x2 - p.x);
  });
  
  if (newObj.controlPoints) {
    newObj.controlPoints.forEach(p => {
      p.x = b.x2 + (b.x2 - p.x);
    });
  }
  
  state.objects.push(newObj);
  state.selectedIdx = state.objects.length - 1; // select the new copy
  render(); updateUI();
});

// ─── Camera Feature ───
const btnCamera = document.getElementById('btn-camera');
const cameraModal = document.getElementById('camera-modal');
const cameraVideo = document.getElementById('camera-video');
const cameraPreview = document.getElementById('camera-preview');
const cameraGuideline = document.getElementById('camera-guideline');
const cameraMessage = document.getElementById('camera-message');
const cameraControls = document.getElementById('camera-controls');
const cameraPreviewControls = document.getElementById('camera-preview-controls');
const btnCapture = document.getElementById('btn-capture');
const btnCloseCamera = document.getElementById('btn-close-camera');
const btnApplyPattern = document.getElementById('btn-apply-pattern');
const btnRecapture = document.getElementById('btn-recapture');

let cameraStream = null;

btnCamera.addEventListener('click', async () => {
  cameraModal.style.display = 'flex';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    cameraVideo.srcObject = cameraStream;
  } catch (err) {
    alert('카메라에 접근할 수 없습니다: ' + err.message);
    cameraModal.style.display = 'none';
  }
});

btnCloseCamera.addEventListener('click', () => {
  cameraModal.style.display = 'none';
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
});

btnCapture.addEventListener('click', () => {
  if (!cameraStream) return;
  const canvas = document.createElement('canvas');
  const maxDim = 300; 
  const scale = Math.min(maxDim / cameraVideo.videoWidth, maxDim / cameraVideo.videoHeight);
  const w = Math.floor(cameraVideo.videoWidth * scale);
  const h = Math.floor(cameraVideo.videoHeight * scale);
  canvas.width = w; canvas.height = h;
  const tempCtx = canvas.getContext('2d');
  tempCtx.drawImage(cameraVideo, 0, 0, w, h);
  
  const imgData = tempCtx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
  }
  
  const S = Math.floor(w / 16);
  const intImg = new Uint32Array(w * h);
  for(let y=0; y<h; y++){
    let sumLine = 0;
    for(let x=0; x<w; x++){
      const lum = gray[y*w + x];
      sumLine += lum;
      intImg[y*w + x] = (y > 0 ? intImg[(y-1)*w + x] : 0) + sumLine;
    }
  }
  
  const getSum = (x1, y1, x2, y2) => {
    x1 = Math.max(0, x1); y1 = Math.max(0, y1);
    x2 = Math.min(w-1, x2); y2 = Math.min(h-1, y2);
    const a = (y1>0 && x1>0) ? intImg[(y1-1)*w + (x1-1)] : 0;
    const b = (y1>0) ? intImg[(y1-1)*w + x2] : 0;
    const c = (x1>0) ? intImg[y2*w + (x1-1)] : 0;
    const d = intImg[y2*w + x2];
    return d - b - c + a;
  };

  const binImg = new Uint8Array(w * h);
  const T = 0.85;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const area = (Math.min(w-1, x+S) - Math.max(0, x-S) + 1) * (Math.min(h-1, y+S) - Math.max(0, y-S) + 1);
      const localAvg = getSum(x-S, y-S, x+S, y+S) / area;
      if (gray[y*w + x] < localAvg * T - 5) {
         binImg[y*w + x] = 1;
      }
    }
  }
  
  // Zhang-Suen Thinning (Skeletonization)
  const marker = new Uint8Array(w * h);
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let p = y*w + x;
        if (binImg[p] === 1) {
          let p2 = binImg[(y-1)*w + x], p3 = binImg[(y-1)*w + x+1], p4 = binImg[y*w + x+1], p5 = binImg[(y+1)*w + x+1];
          let p6 = binImg[(y+1)*w + x], p7 = binImg[(y+1)*w + x-1], p8 = binImg[y*w + x-1], p9 = binImg[(y-1)*w + x-1];
          let A = (p2==0 && p3==1) + (p3==0 && p4==1) + (p4==0 && p5==1) + (p5==0 && p6==1) + 
                  (p6==0 && p7==1) + (p7==0 && p8==1) + (p8==0 && p9==1) + (p9==0 && p2==1);
          let B = p2+p3+p4+p5+p6+p7+p8+p9;
          if (A === 1 && B >= 2 && B <= 6 && p2*p4*p6 === 0 && p4*p6*p8 === 0) { marker[p] = 1; changed = true; } 
          else { marker[p] = 0; }
        } else { marker[p] = 0; }
      }
    }
    for (let i = 0; i < w*h; i++) if (marker[i]) binImg[i] = 0;
    
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let p = y*w + x;
        if (binImg[p] === 1) {
          let p2 = binImg[(y-1)*w + x], p3 = binImg[(y-1)*w + x+1], p4 = binImg[y*w + x+1], p5 = binImg[(y+1)*w + x+1];
          let p6 = binImg[(y+1)*w + x], p7 = binImg[(y+1)*w + x-1], p8 = binImg[y*w + x-1], p9 = binImg[(y-1)*w + x-1];
          let A = (p2==0 && p3==1) + (p3==0 && p4==1) + (p4==0 && p5==1) + (p5==0 && p6==1) + 
                  (p6==0 && p7==1) + (p7==0 && p8==1) + (p8==0 && p9==1) + (p9==0 && p2==1);
          let B = p2+p3+p4+p5+p6+p7+p8+p9;
          if (A === 1 && B >= 2 && B <= 6 && p2*p4*p8 === 0 && p2*p6*p8 === 0) { marker[p] = 1; changed = true; } 
          else { marker[p] = 0; }
        }
      }
    }
    for (let i = 0; i < w*h; i++) if (marker[i]) binImg[i] = 0;
  }

  // Trace continuous paths from skeleton
  const visited = new Uint8Array(w * h);
  const paths = [];
  const dirs = [{dx:1,dy:0}, {dx:1,dy:1}, {dx:0,dy:1}, {dx:-1,dy:1}, {dx:-1,dy:0}, {dx:-1,dy:-1}, {dx:0,dy:-1}, {dx:1,dy:-1}];
  
  let startPoints = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (binImg[y*w+x] === 1) {
        let n = 0;
        for(let d of dirs) if (binImg[(y+d.dy)*w + x+d.dx] === 1) n++;
        if (n === 1) startPoints.push({x, y});
      }
    }
  }
  
  const traceFrom = (startX, startY) => {
    let trace = [];
    let cx = startX, cy = startY;
    while (true) {
      trace.push({x: (cx - w/2)/scale, y: (cy - h/2)/scale});
      visited[cy*w + cx] = 1;
      let next = null;
      for (let d of dirs) {
        let nx = cx + d.dx, ny = cy + d.dy;
        if (binImg[ny*w + nx] === 1 && !visited[ny*w + nx]) {
          next = {x: nx, y: ny}; break;
        }
      }
      if (!next) break;
      cx = next.x; cy = next.y;
    }
    return trace;
  };

  for (let pt of startPoints) {
    if (!visited[pt.y*w + pt.x]) {
      const tr = traceFrom(pt.x, pt.y);
      if (tr.length > 3) paths.push(tr);
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (binImg[y*w+x] === 1 && !visited[y*w+x]) {
        const tr = traceFrom(x, y);
        if (tr.length > 3) paths.push(tr);
      }
    }
  }
  
  if (paths.length > 0) {
    pendingPatternObjects = [];
    
    const fitPrimitives = (pts, e) => {
      if (pts.length <= 2) return [{ type: 'line', p0: pts[0], p1: pts[pts.length-1] }];
      const f = pts[0], l = pts[pts.length - 1];
      let maxLineErr = 0, maxLineIdx = 0;
      let pathLen = 0;
      
      const dx = l.x - f.x, dy = l.y - f.y, len = Math.hypot(dx, dy) || 1;
      for (let i = 1; i < pts.length; i++) {
        pathLen += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
      }
      for (let i = 1; i < pts.length - 1; i++) {
        const d = Math.abs((pts[i].x - f.x) * dy - (pts[i].y - f.y) * dx) / len;
        if (d > maxLineErr) { maxLineErr = d; maxLineIdx = i; }
      }
      
      const isLineLike = (pathLen <= len * 1.20) || (maxLineErr <= e * 3.0);
      if (isLineLike && maxLineErr <= e * 4.0) { 
        return [{ type: 'line', p0: f, p1: l }];
      }
      
      const midPt = pts[Math.floor(pts.length / 2)];
      const cp = { x: 2 * midPt.x - 0.5 * f.x - 0.5 * l.x, y: 2 * midPt.y - 0.5 * f.y - 0.5 * l.y };
      const archPts = getArch(f, l, cp);
      let maxArchErr = 0, maxArchIdx = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        let minDist = Infinity;
        for (let j = 0; j < archPts.length; j++) {
          const d = Math.hypot(pts[i].x - archPts[j].x, pts[i].y - archPts[j].y);
          if (d < minDist) minDist = d;
        }
        if (minDist > maxArchErr) { maxArchErr = minDist; maxArchIdx = i; }
      }
      
      if (maxArchErr <= e) {
        return [{ type: 'arch', p0: f, p1: l, p2: cp }];
      }
      
      const splitIdx = maxLineErr < maxArchErr ? maxLineIdx : maxArchIdx;
      if (splitIdx === 0 || splitIdx === pts.length - 1) return [{ type: 'line', p0: f, p1: l }];
      
      return fitPrimitives(pts.slice(0, splitIdx + 1), e).concat(fitPrimitives(pts.slice(splitIdx), e));
    };

    let shapeCount = 1;
    paths.forEach(tr => {
      const rdpTr = rdp(tr, 1.0); // pre-smooth
      const primitives = fitPrimitives(rdpTr, 4.0);
      
      primitives.forEach(prim => {
        if (prim.type === 'line') {
          let dx = prim.p1.x - prim.p0.x;
          let dy = prim.p1.y - prim.p0.y;
          let angle = Math.atan2(dy, dx) * 180 / Math.PI;
          const snapAngles = [0, 45, 90, 135, 180, -45, -90, -135, -180];
          for (let s of snapAngles) {
            let dist = Math.abs(angle - s);
            if (dist > 180) dist = 360 - dist;
            if (dist < 15) { // 15 degrees snap tolerance
              let rad = s * Math.PI / 180;
              let len = Math.hypot(dx, dy);
              let cx = (prim.p0.x + prim.p1.x) / 2;
              let cy = (prim.p0.y + prim.p1.y) / 2;
              prim.p0.x = cx - Math.cos(rad) * len / 2;
              prim.p0.y = cy - Math.sin(rad) * len / 2;
              prim.p1.x = cx + Math.cos(rad) * len / 2;
              prim.p1.y = cy + Math.sin(rad) * len / 2;
              break;
            }
          }
          
          pendingPatternObjects.push({
            id: uid(), type: 'line', points: [prim.p0, prim.p1],
            stitch: 'running', density: 2, angle: 0, color: '#4361ee', name: '자동 직선 ' + shapeCount++
          });
        } else if (prim.type === 'arch') {
          pendingPatternObjects.push({
            id: uid(), type: 'arch', points: getArch(prim.p0, prim.p1, prim.p2),
            controlPoints: [prim.p0, prim.p1, prim.p2],
            stitch: 'running', density: 2, angle: 0, color: '#4361ee', name: '자동 곡선(호) ' + shapeCount++
          });
        }
      });
    });

    // Draw preview
    const prevCtx = cameraPreview.getContext('2d');
    cameraPreview.width = w; cameraPreview.height = h;
    prevCtx.drawImage(canvas, 0, 0);
    prevCtx.fillStyle = 'rgba(0,0,0,0.2)';
    prevCtx.fillRect(0,0,w,h);
    
    // Draw detected lines
    prevCtx.strokeStyle = '#2ecc71';
    prevCtx.lineWidth = 4;
    prevCtx.lineCap = 'round';
    prevCtx.lineJoin = 'round';
    
    pendingPatternObjects.forEach(obj => {
      const stitches = StitchEngine.objectToStitches(obj, state.maxStitchLen);
      prevCtx.beginPath();
      if (stitches && stitches.length > 0) {
        prevCtx.moveTo(stitches[0].x * scale + w/2, stitches[0].y * scale + h/2);
        for(let i=1; i<stitches.length; i++) {
          prevCtx.lineTo(stitches[i].x * scale + w/2, stitches[i].y * scale + h/2);
        }
      }
      prevCtx.stroke();
      
      // Draw nodes
      if (obj.controlPoints) {
        prevCtx.fillStyle = '#fff';
        obj.controlPoints.forEach(cp => {
          prevCtx.beginPath();
          prevCtx.arc(cp.x * scale + w/2, cp.y * scale + h/2, 4, 0, Math.PI*2);
          prevCtx.fill();
        });
      }
    });

    cameraVideo.style.display = 'none';
    cameraGuideline.style.display = 'none';
    cameraPreview.style.display = 'block';
    cameraControls.style.display = 'none';
    cameraPreviewControls.style.display = 'flex';
    cameraMessage.style.display = 'none';

  } else {
    cameraMessage.style.display = 'block';
    setTimeout(() => { cameraMessage.style.display = 'none'; }, 3000);
  }
});

btnApplyPattern.addEventListener('click', () => {
  if (pendingPatternObjects.length > 0) {
    saveUndo();
    state.objects.push(...pendingPatternObjects);
    pendingPatternObjects = [];
    render(); updateUI();
    showToast('패턴이 성공적으로 적용되었습니다.', 'success');
  }
  btnCloseCamera.click();
});

btnRecapture.addEventListener('click', () => {
  pendingPatternObjects = [];
  cameraPreview.style.display = 'none';
  cameraVideo.style.display = 'block';
  cameraGuideline.style.display = 'block';
  cameraPreviewControls.style.display = 'none';
  cameraControls.style.display = 'flex';
});

// ─── Init ───
updateUI();
render();

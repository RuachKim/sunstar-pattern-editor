import { StitchEngine, PatternPresets } from './stitch-engine.js';
import { DSTWriter } from './dst-writer.js';

const state = {
  objects: [],
  selectedIdx: -1,
  tool: 'select',
  cam: { x: 0, y: 0, z: 1 },
  undoStack: [],
  redoStack: [],
  maxStitchLen: 30,
  currentStitchTech: 'running',
  bgSettings: { brightness: 100, contrast: 100, opacity: 50 },
  hoopWidthMm: 100 // 실제 자수 틀 가로 폭 (mm)
};

let drag = null, drawPts = null, drawStart = null, tempPos = null;
let panning = false, panStart = null;
let pendingPatternObjects = [];
let lastRoiW = 0; // 마지막으로 처리된 이미지의 ROI 폭 (px)

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  const bg = type === 'error' ? 'rgba(231,76,60,0.95)' : 'rgba(46,204,113,0.95)';
  toast.style.cssText = `background:${bg}; color:#fff; padding:12px 24px; border-radius:12px; font-size:14px; font-weight:500; box-shadow:0 8px 24px rgba(0,0,0,0.2); backdrop-filter:blur(8px); transform:translateX(100%); opacity:0; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); display:flex; align-items:center; gap:8px;`;
  toast.innerHTML = `<span style="font-size:18px">${type === 'error' ? '⚠️' : '✨'}</span> ${message}`;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.transform = 'translateX(100%)'; toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

const guides = {
  line: "시작점과 끝점을 클릭하여 직선을 그리세요.",
  arch: "양 끝점을 클릭한 후, 곡률을 정할 중간 지점을 클릭하세요.",
  circle: "중심을 클릭한 후 원하는 크기만큼 당기세요.",
  rect: "대각선 방향의 두 모서리를 클릭하세요.",
  curve: "클릭하여 점을 이어나가고, 마지막에 더블클릭하여 종료하세요.",
  select: "오브젝트를 클릭하여 선택하거나 드래그하여 이동하세요.",
  hand: "화면을 드래그하여 시점을 이동하세요.",
  eraser: "지울 오브젝트를 클릭하세요.",
  node: "노드를 드래그하여 모양을 수정하세요."
};

const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const hud = document.getElementById('hud');
const pos = document.getElementById('pos');
const objList = document.getElementById('object-list');

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  if (!wrap) return;
  cv.width = wrap.clientWidth; cv.height = wrap.clientHeight;
  render();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function uid() { return Math.random().toString(36).slice(2, 10); }
function snap(v) {
  const chk = document.getElementById('chk-snap');
  const snapVal = chk && chk.checked ? 1 : 0.1; // 1mm or 0.1mm
  return Math.round(v / snapVal) * snapVal;
}
function s2w(sx, sy) { return { x: (sx - cv.width / 2) / state.cam.z + state.cam.x, y: (sy - cv.height / 2) / state.cam.z + state.cam.y }; }
function w2s(wx, wy) { return { x: (wx - state.cam.x) * state.cam.z + cv.width / 2, y: (wy - state.cam.y) * state.cam.z + cv.height / 2 }; }
function bbox(pts) {
// ... (omitted for brevity, will read first)

  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const p of pts) { if (p.x < x1) x1 = p.x; if (p.y < y1) y1 = p.y; if (p.x > x2) x2 = p.x; if (p.y > y2) y2 = p.y; }
  return { x1, y1, x2, y2 };
}

function saveUndo() {
  state.undoStack.push(JSON.stringify(state.objects));
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
}
function undo() {
  if (state.undoStack.length === 0) return;
  state.redoStack.push(JSON.stringify(state.objects));
  state.objects = JSON.parse(state.undoStack.pop());
  state.selectedIdx = -1; render(); updateUI();
}
function redo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(JSON.stringify(state.objects));
  state.objects = JSON.parse(state.redoStack.pop());
  state.selectedIdx = -1; render(); updateUI();
}

function drawGrid() {
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const gz = 10 * state.cam.z; // 10mm grid
  if (gz < 5) return;
  const ox = W / 2 - state.cam.x * state.cam.z, oy = H / 2 - state.cam.y * state.cam.z;
  ctx.strokeStyle = '#f1f2f6'; ctx.lineWidth = 1;
  let sx = ox % gz; while (sx < 0) sx += gz;
  for (let x = sx; x < W; x += gz) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  let sy = oy % gz; while (sy < 0) sy += gz;
  for (let y = sy; y < H; y += gz) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const o = w2s(0, 0);
  ctx.strokeStyle = 'rgba(239,68,68,.3)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, H); ctx.stroke();
  ctx.strokeStyle = 'rgba(16,185,129,.3)'; ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(W, o.y); ctx.stroke();

  // Draw Hoop Guide (100x100mm)
  const hw = state.hoopWidthMm / 2;
  const s1 = w2s(-hw, -hw), s2 = w2s(hw, hw);
  ctx.strokeStyle = 'rgba(67, 97, 238, 0.4)'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
  ctx.strokeRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(67, 97, 238, 0.1)';
  ctx.fillText(`${state.hoopWidthMm}mm`, s1.x + 5, s1.y + 15);
}

function drawStitches(pts, color, stitchType = 'running', density = 2, angle = 0, isPreview = false, type = 'line') {
  if (!pts || pts.length < 2) return;
  const tempObj = { points: pts, stitch: stitchType, density, angle, type };
  const stitches = StitchEngine.objectToStitches(tempObj, state.maxStitchLen);
  ctx.save();
  if (!isPreview) { ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'; ctx.shadowBlur = 2 * Math.max(1, state.cam.z); ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1; }
  ctx.strokeStyle = color; ctx.lineWidth = isPreview ? 1.0 : (1.8 * Math.max(0.5, state.cam.z * 0.8)); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  if (stitches.length > 0) {
    let sp = w2s(stitches[0].x, stitches[0].y); ctx.moveTo(sp.x, sp.y);
    for (let i = 1; i < stitches.length; i++) { let ep = w2s(stitches[i].x, stitches[i].y); ctx.lineTo(ep.x, ep.y); }
  }
  ctx.stroke();
  ctx.restore();
  if (!isPreview && state.cam.z > 0.6 && stitches.length < 5000) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    for (let i = 0; i < stitches.length; i++) {
      let p = w2s(stitches[i].x, stitches[i].y);
      ctx.beginPath(); ctx.arc(p.x, p.y, 0.8 * state.cam.z, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawObj(o, idx) {
  const pts = o.points; if (!pts || !pts.length) return;
  const c = o.color || '#4361ee';
  if (['fill', 'satin'].includes(o.stitch) && pts.length > 2) {
    ctx.beginPath(); let sp = w2s(pts[0].x, pts[0].y); ctx.moveTo(sp.x, sp.y);
    for (let i = 1; i < pts.length; i++) { sp = w2s(pts[i].x, pts[i].y); ctx.lineTo(sp.x, sp.y); }
    ctx.globalAlpha = 0.1; ctx.fillStyle = c; ctx.fill(); ctx.globalAlpha = 1;
  }
  drawStitches(pts, c, o.stitch, o.density, o.angle, false, o.type);
  if (idx === state.selectedIdx) {
    const b = bbox(pts);
    if (state.tool === 'select') {
      const s1 = w2s(b.x1, b.y1), s2 = w2s(b.x2, b.y2);
      ctx.strokeStyle = 'var(--accent)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.strokeRect(s1.x - 4, s1.y - 4, s2.x - s1.x + 8, s2.y - s1.y + 8);
      ctx.setLineDash([]);
    } else if (state.tool === 'node') {
      const nPts = o.controlPoints || pts;
      for (const p of nPts) {
        const s = w2s(p.x, p.y); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }
}

function render() {
  drawGrid();
  for (let i = 0; i < state.objects.length; i++) drawObj(state.objects[i], i);
  if (drawPts && drawPts.length > 0) {
    let pts = [...drawPts]; if (tempPos && state.tool !== 'circle') pts.push(tempPos);
    const color = '#2ecc71';
    if (state.tool === 'line' || state.tool === 'curve') drawStitches(pts, color, state.currentStitchTech, 2, 0, true, state.tool);
    else if (state.tool === 'arch') {
      if (drawPts.length === 1 && tempPos) {
        let p0 = w2s(drawPts[0].x, drawPts[0].y), p1 = w2s(tempPos.x, tempPos.y);
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke(); ctx.setLineDash([]);
      } else if (drawPts.length === 2 && tempPos) {
        drawStitches(getArch(drawPts[0], drawPts[1], tempPos), color, state.currentStitchTech, 2, 0, true);
      }
    } else if (state.tool === 'rect' && pts.length > 1) {
      const rpts = [{x:pts[0].x, y:pts[0].y}, {x:tempPos.x, y:pts[0].y}, {x:tempPos.x, y:tempPos.y}, {x:pts[0].x, y:tempPos.y}, {x:pts[0].x, y:pts[0].y}];
      drawStitches(rpts, color, 'fill', 2, 0, true);
    }
  }
  if (state.tool === 'circle' && drawStart) {
    const r = Math.hypot(drawStart.ex - drawStart.cx, drawStart.ey - drawStart.cy);
    if (r > 1) {
      const pts = []; for (let i = 0; i <= 48; i++) { const t = i/48 * Math.PI*2; pts.push({ x: drawStart.cx + r*Math.cos(t), y: drawStart.cy + r*Math.sin(t) }); }
      drawStitches(pts, '#2ecc71', 'satin', 2, 0, true);
    }
  }
  hud.innerHTML = `${guides[state.tool] || ''} <span style="font-size:11px;opacity:0.6;margin-left:12px">확대: ${Math.round(state.cam.z * 100)}%</span>`;
  cv.style.cursor = { select: 'default', eraser: 'pointer', hand: 'grab' }[state.tool] || 'crosshair';
}

function hitObj(mx, my) {
  const w = s2w(mx, my);
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const b = bbox(state.objects[i].points);
    if (w.x >= b.x1 - 8 && w.x <= b.x2 + 8 && w.y >= b.y1 - 8 && w.y <= b.y2 + 8) return i;
  }
  return -1;
}

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

cv.addEventListener('pointerdown', e => {
  const mx = e.offsetX, my = e.offsetY, w = s2w(mx, my), sw = snap(w.x), sh = snap(w.y);
  if (state.tool === 'hand' || e.button === 2) { panning = true; panStart = { mx, my, cx: state.cam.x, cy: state.cam.y }; return; }
  if (e.button !== 0) return;
  if (state.tool === 'select') {
    const oi = hitObj(mx, my);
    if (oi >= 0) { state.selectedIdx = oi; drag = { t: 'move', orig: state.objects[oi].points.map(p => ({...p})), origCtrl: state.objects[oi].controlPoints ? state.objects[oi].controlPoints.map(p => ({...p})) : null, wx: w.x, wy: w.y }; saveUndo(); render(); updateUI(); return; }
    state.selectedIdx = -1; render(); updateUI();
  } else if (state.tool === 'node') {
    if (state.selectedIdx >= 0) {
      const nPts = state.objects[state.selectedIdx].controlPoints || state.objects[state.selectedIdx].points;
      for (let i = 0; i < nPts.length; i++) { const p = w2s(nPts[i].x, nPts[i].y); if (Math.hypot(mx - p.x, my - p.y) < 15) { drag = { t: 'node', nodeIdx: i }; saveUndo(); return; } }
    }
    state.selectedIdx = hitObj(mx, my); render(); updateUI();
  } else if (state.tool === 'eraser') {
    const oi = hitObj(mx, my); if (oi >= 0) { saveUndo(); state.objects.splice(oi, 1); state.selectedIdx = -1; render(); updateUI(); }
  } else if (state.tool === 'line') {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else { saveUndo(); state.objects.push({ id: uid(), type: 'line', points: [...drawPts, {x:sw, y:sh}], stitch: state.currentStitchTech, density: parseFloat(document.getElementById('sl-density').value), angle: parseInt(document.getElementById('sl-angle').value), scale: 1.0, color: document.getElementById('inp-color').value, name: '직선 스티치' }); drawPts = null; updateUI(); }
  } else if (state.tool === 'arch') {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else if (drawPts.length === 1) drawPts.push({x:sw, y:sh});
    else { saveUndo(); state.objects.push({ id: uid(), type: 'arch', points: getArch(drawPts[0], drawPts[1], {x:sw, y:sh}), controlPoints: [drawPts[0], drawPts[1], {x:sw, y:sh}], stitch: state.currentStitchTech, density: parseFloat(document.getElementById('sl-density').value), angle: parseInt(document.getElementById('sl-angle').value), scale: 1.0, color: document.getElementById('inp-color').value, name: '호 스티치' }); drawPts = null; updateUI(); }
  } else if (state.tool === 'curve') {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else { if (Math.hypot(sw - drawPts[0].x, sh - drawPts[0].y) < 15 && drawPts.length > 2) { drawPts.push({...drawPts[0]}); saveUndo(); state.objects.push({ id: uid(), type: 'curve', points: drawPts, stitch: state.currentStitchTech, density: 2, angle: 0, scale: 1.0, color: document.getElementById('inp-color').value, name: '곡선 스티치' }); drawPts = null; updateUI(); } else drawPts.push({x:sw, y:sh}); }
  } else if (state.tool === 'circle') drawStart = { cx: sw, cy: sh, ex: sw, ey: sh };
  else if (state.tool === 'rect') { if (!drawPts) drawPts = [{x:sw, y:sh}]; else { saveUndo(); const p0 = drawPts[0]; const rpts = [{x:p0.x, y:p0.y}, {x:sw, y:p0.y}, {x:sw, y:sh}, {x:p0.x, y:sh}, {x:p0.x, y:p0.y}]; state.objects.push({ id: uid(), type: 'rect', points: rpts, stitch: 'fill', density: 2, angle: 0, scale: 1.0, color: document.getElementById('inp-color').value, name: '사각형 채우기' }); drawPts = null; updateUI(); } }
});

cv.addEventListener('pointermove', e => {
  const mx = e.offsetX, my = e.offsetY, w = s2w(mx, my);
  tempPos = { x: snap(w.x), y: snap(w.y) };
  pos.textContent = `${(w.x / 10).toFixed(1)}, ${(-w.y / 10).toFixed(1)} cm (${w.x.toFixed(0)}, ${-w.y.toFixed(0)} mm)`;
  if (panning) { state.cam.x = panStart.cx - (mx - panStart.mx) / state.cam.z; state.cam.y = panStart.cy - (my - panStart.my) / state.cam.z; render(); return; }
  if (drag) {
    if (drag.t === 'move') {
      const dx = snap(w.x - drag.wx), dy = snap(w.y - drag.wy);
      state.objects[state.selectedIdx].points.forEach((p, i) => { p.x = drag.orig[i].x + dx; p.y = drag.orig[i].y + dy; });
      if (drag.origCtrl) state.objects[state.selectedIdx].controlPoints.forEach((p, i) => { p.x = drag.origCtrl[i].x + dx; p.y = drag.origCtrl[i].y + dy; });
    } else {
      const o = state.objects[state.selectedIdx];
      if (o.controlPoints) { o.controlPoints[drag.nodeIdx].x = tempPos.x; o.controlPoints[drag.nodeIdx].y = tempPos.y; if (o.type === 'arch') o.points = getArch(o.controlPoints[0], o.controlPoints[1], o.controlPoints[2]); }
      else o.points[drag.nodeIdx].x = tempPos.x; o.points[drag.nodeIdx].y = tempPos.y;
    }
    render();
  } else if (drawStart) { drawStart.ex = tempPos.x; drawStart.ey = tempPos.y; render(); }
  else if (drawPts) render();
});

cv.addEventListener('pointerup', () => { panning = false; if (drag) drag = null; if (drawStart) { saveUndo(); const r = Math.hypot(drawStart.ex - drawStart.cx, drawStart.ey - drawStart.cy); if (r > 1) { const pts = []; for (let i = 0; i <= 48; i++) { const t = i/48 * Math.PI*2; pts.push({ x: drawStart.cx + r*Math.cos(t), y: drawStart.cy + r*Math.sin(t) }); } state.objects.push({ id: uid(), type: 'circle', points: pts, stitch: 'satin', density: 2, angle: 0, scale: 1.0, color: document.getElementById('inp-color').value, name: '원형 새틴' }); updateUI(); } drawStart = null; render(); } });
cv.addEventListener('dblclick', () => { if (state.tool === 'curve' && drawPts && drawPts.length > 2) { saveUndo(); state.objects.push({ id: uid(), type: 'curve', points: drawPts, stitch: state.currentStitchTech, density: 2, angle: 0, scale: 1.0, color: document.getElementById('inp-color').value, name: '자유곡선 스티치' }); drawPts = null; render(); updateUI(); } });
cv.addEventListener('wheel', e => { e.preventDefault(); const w = s2w(e.offsetX, e.offsetY); state.cam.z = Math.max(0.15, Math.min(5, state.cam.z * (e.deltaY < 0 ? 1.15 : 0.85))); state.cam.x = w.x - (e.offsetX - cv.width/2)/state.cam.z; state.cam.y = w.y - (e.offsetY - cv.height/2)/state.cam.z; render(); }, { passive: false });

function setTool(t) {
  state.tool = t; drawPts = null; drawStart = null;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  render();
}
document.querySelectorAll('.tool-btn').forEach(b => b.addEventListener('click', () => { if (b.dataset.tool) setTool(b.dataset.tool); }));

document.querySelectorAll('.pattern-btn').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset; saveUndo(); let pts = [];
  if (p === 'floral') pts = PatternPresets.floral();
  else if (p === 'bohemian') pts = PatternPresets.bohemian();
  else if (p === 'geometry') pts = PatternPresets.geometry();
  else if (p === 'sashiko') pts = PatternPresets.sashiko();
  else if (p === 'smocking') pts = PatternPresets.smocking();
  else if (p === 'paisley') pts = PatternPresets.paisley();
  else if (p === 'scroll') pts = PatternPresets.scroll();
  state.objects.push({ id: uid(), type: 'preset', points: PatternPresets.shiftPoints(pts, state.cam.x, state.cam.y), stitch: state.currentStitchTech, density: 2, angle: 0, scale: 1.0, color: document.getElementById('inp-color').value, name: b.textContent });
  render(); updateUI();
}));

document.querySelectorAll('.stitch-tech-btn').forEach(b => b.addEventListener('click', () => {
  state.currentStitchTech = b.dataset.stitch;
  document.querySelectorAll('.stitch-tech-btn').forEach(btn => btn.classList.toggle('active', btn === b));
  if (state.selectedIdx >= 0) { state.objects[state.selectedIdx].stitch = state.currentStitchTech; render(); }
}));

function updateUI() {
  objList.innerHTML = state.objects.length === 0 ? '<div class="empty-state">패턴이 없습니다</div>' : '';
  state.objects.forEach((o, i) => {
    const div = document.createElement('div'); div.className = 'obj-item' + (i === state.selectedIdx ? ' selected' : '');
    div.innerHTML = `<span class="color-dot" style="background:${o.color}"></span><span class="name">${o.name}</span><button class="del-btn">✕</button>`;
    div.addEventListener('click', e => { if (e.target.classList.contains('del-btn')) { saveUndo(); state.objects.splice(i, 1); state.selectedIdx = -1; } else state.selectedIdx = i; render(); updateUI(); });
    objList.appendChild(div);
  });
  const sel = state.objects[state.selectedIdx];
  if (sel) {
    if (!sel.scale) sel.scale = 1.0;
    document.getElementById('sl-scale').value = Math.round(sel.scale * 100);
    document.getElementById('val-scale').textContent = Math.round(sel.scale * 100) + '%';
    document.getElementById('sl-density').value = sel.density; document.getElementById('val-density').textContent = sel.density.toFixed(1);
    document.getElementById('sl-angle').value = sel.angle; document.getElementById('val-angle').textContent = sel.angle + '°';
    document.getElementById('inp-color').value = sel.color; document.getElementById('val-color').textContent = sel.color;
    state.currentStitchTech = sel.stitch;
    document.querySelectorAll('.stitch-tech-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.stitch === sel.stitch));
  }
  const { totalCount } = StitchEngine.objectsToDSTStitches(state.objects, state.maxStitchLen);
  document.getElementById('status-objs').textContent = `오브젝트: ${state.objects.length} | 스티치: ${totalCount.toLocaleString()}`;
}

document.getElementById('sl-scale').addEventListener('input', e => {
  const v = parseInt(e.target.value) / 100;
  document.getElementById('val-scale').textContent = (v * 100).toFixed(0) + '%';
  if (state.selectedIdx >= 0) {
    const obj = state.objects[state.selectedIdx];
    const oldScale = obj.scale || 1.0;
    const ratio = v / oldScale;
    const { x1, y1, x2, y2 } = bbox(obj.points);
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    obj.points.forEach(p => { p.x = cx + (p.x - cx) * ratio; p.y = cy + (p.y - cy) * ratio; });
    if (obj.controlPoints) { obj.controlPoints.forEach(p => { p.x = cx + (p.x - cx) * ratio; p.y = cy + (p.y - cy) * ratio; }); }
    obj.scale = v; render();
  }
});
document.getElementById('sl-density').addEventListener('input', e => { const v = parseFloat(e.target.value); document.getElementById('val-density').textContent = v.toFixed(1); if (state.selectedIdx >= 0) { state.objects[state.selectedIdx].density = v; render(); } });
document.getElementById('sl-angle').addEventListener('input', e => { const v = parseInt(e.target.value); document.getElementById('val-angle').textContent = v + '°'; if (state.selectedIdx >= 0) { state.objects[state.selectedIdx].angle = v; render(); } });
document.getElementById('inp-color').addEventListener('input', e => { document.getElementById('val-color').textContent = e.target.value; if (state.selectedIdx >= 0) { state.objects[state.selectedIdx].color = e.target.value; render(); updateUI(); } });
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo-top').addEventListener('click', redo);
document.getElementById('btn-clear-all').addEventListener('click', () => { if (confirm('전체 삭제하시겠습니까?')) { saveUndo(); state.objects = []; state.selectedIdx = -1; document.getElementById('floating-preview').style.display = 'none'; render(); updateUI(); } });
document.getElementById('btn-export').addEventListener('click', () => { const { stitches } = StitchEngine.objectsToDSTStitches(state.objects, state.maxStitchLen); DSTWriter.download(stitches, 'PATTERN.DST'); });
document.getElementById('btn-help-func').addEventListener('click', () => alert('선스타 패턴 에디터 도움말\n\n- 밀도: 스티치 간격 조절 (값이 작을수록 촘촘함)\n- 각도: 채우기 스티치의 진행 방향 조절\n- 마우스 휠: 확대/축소\n- 우클릭 드래그: 화면 이동\n- 스티치 도구: 직선, 호, 자유곡선 등 선택 가능\n- 라이브러리: 미리 제작된 자수 패턴을 바로 추가 가능'));

function updateTraceFilter() { const wrap = document.getElementById('preview-img-wrap'); if (wrap) wrap.style.filter = `brightness(${state.bgSettings.brightness}%) contrast(${state.bgSettings.contrast}%) opacity(${state.bgSettings.opacity}%)`; }
document.getElementById('trace-brightness').addEventListener('input', e => { state.bgSettings.brightness = e.target.value; updateTraceFilter(); });
document.getElementById('trace-contrast').addEventListener('input', e => { state.bgSettings.contrast = e.target.value; updateTraceFilter(); });
document.getElementById('trace-opacity').addEventListener('input', e => { state.bgSettings.opacity = e.target.value; updateTraceFilter(); });
document.getElementById('btn-clear-preview').addEventListener('click', () => document.getElementById('floating-preview').style.display = 'none');

// ─── RDP & Path Optimization ───
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

const btnCamera = document.getElementById('btn-camera'), cameraModal = document.getElementById('camera-modal'), cameraVideo = document.getElementById('camera-video'), cameraPreview = document.getElementById('camera-preview'), cameraControls = document.getElementById('camera-controls'), cameraPreviewControls = document.getElementById('camera-preview-controls'), btnCapture = document.getElementById('btn-capture'), btnCloseCamera = document.getElementById('btn-close-camera'), btnApplyPattern = document.getElementById('btn-apply-pattern'), btnRecapture = document.getElementById('btn-recapture');
let cameraStream = null;

function stopCamera() { if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; } cameraModal.style.display = 'none'; }
btnCamera.addEventListener('click', async () => { cameraModal.style.display = 'flex'; try { cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } }); cameraVideo.srcObject = cameraStream; } catch (err) { alert('카메라 접근 실패: ' + err.message); cameraModal.style.display = 'none'; } });
btnCloseCamera.addEventListener('click', stopCamera);

document.getElementById('inp-hoop-width').addEventListener('change', e => {
  const newVal = parseFloat(e.target.value) || 100;
  state.hoopWidthMm = newVal;
  showToast(`기준 크기가 ${newVal}mm로 설정되었습니다.`);
});

function processImage(imgSource, isVideo = false) {
  const vW = isVideo ? imgSource.videoWidth : imgSource.videoWidth || imgSource.width;
  const vH = isVideo ? imgSource.videoHeight : imgSource.videoHeight || imgSource.height;
  if (!vW || !vH) return false;
  const roiW = vW * 0.8, roiH = vH * 0.8, roiX = (vW - roiW) / 2, roiY = (vH - roiH) / 2;
  lastRoiW = roiW;
  const maxDim = 600; const scale = Math.min(maxDim / roiW, maxDim / roiH);
  const pw = Math.floor(roiW * scale), ph = Math.floor(roiH * scale);
  const canvas = document.createElement('canvas'); canvas.width = pw; canvas.height = ph;
  const tCtx = canvas.getContext('2d'); tCtx.drawImage(imgSource, roiX, roiY, roiW, roiH, 0, 0, pw, ph);
  cameraPreview.width = roiW; cameraPreview.height = roiH;
  const pCtx = cameraPreview.getContext('2d');
  pCtx.clearRect(0,0,roiW,roiH);
  pCtx.globalAlpha = 0.6; pCtx.drawImage(imgSource, roiX, roiY, roiW, roiH, 0, 0, roiW, roiH); pCtx.globalAlpha = 1.0;
  const imgData = tCtx.getImageData(0, 0, pw, ph), data = imgData.data, gray = new Uint8Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) { gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]; }
  const S = Math.floor(pw / 16), intImg = new Uint32Array(pw * ph);
  for(let y=0; y<ph; y++) { let sumLine = 0; for(let x=0; x<pw; x++) { sumLine += gray[y*pw + x]; intImg[y*pw + x] = (y > 0 ? intImg[(y-1)*pw + x] : 0) + sumLine; } }
  const getSum = (x1, y1, x2, y2) => { x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(pw-1, x2); y2 = Math.min(ph-1, y2); return intImg[y2*pw + x2] - (y1>0 ? intImg[(y1-1)*pw + x2] : 0) - (x1>0 ? intImg[y2*pw + (x1-1)] : 0) + (y1>0 && x1>0 ? intImg[(y1-1)*pw + (x1-1)] : 0); };
  
  const mmPerPx = state.hoopWidthMm / roiW;
  const points = [], T = 0.82;
  for (let y = 2; y < ph - 2; y += 2) { for (let x = 2; x < pw - 2; x += 2) {
    const area = (Math.min(pw-1, x+S) - Math.max(0, x-S) + 1) * (Math.min(ph-1, y+S) - Math.max(0, y-S) + 1);
    if (gray[y*pw + x] < (getSum(x-S, y-S, x+S, y+S) / area) * T) { 
      points.push({ x: ((x / scale) - roiW/2) * mmPerPx, y: ((y / scale) - roiH/2) * mmPerPx, visited: false }); 
    }
  } }
  pendingPatternObjects = [];
  if (points.length > 5) {
    const clusters = []; let remaining = [...points];
    while (remaining.length > 0) {
      let cluster = [remaining.shift()]; let changed = true;
      while (changed) { changed = false; for (let i = 0; i < remaining.length; i++) { const p = remaining[i]; const close = cluster.some(cp => Math.hypot(cp.x - p.x, cp.y - p.y) < 15); if (close) { cluster.push(remaining.splice(i, 1)[0]); i--; changed = true; } } }
      if (cluster.length > 5) clusters.push(cluster);
    }
    clusters.forEach((cluster, idx) => {
      const path = [cluster[0]]; cluster[0].visited = true; let curr = cluster[0];
      for (let i = 1; i < cluster.length; i++) {
        let minDist = Infinity, bestIdx = -1;
        for (let j = 0; j < cluster.length; j++) { if (!cluster[j].visited) { const d = Math.hypot(cluster[j].x - curr.x, cluster[j].y - curr.y); if (d < minDist) { minDist = d; bestIdx = j; } } }
        if (bestIdx !== -1) { cluster[bestIdx].visited = true; curr = cluster[bestIdx]; path.push(curr); }
      }
      const optimized = rdp(path, 4.0);
      if (optimized.length > 2) { pendingPatternObjects.push({ id: uid(), type: 'auto', points: optimized, stitch: state.currentStitchTech, density: 2, angle: 0, scale: 1.0, color: document.getElementById('inp-color').value, name: `추출 패턴 ${idx + 1}` }); }
    });
    pCtx.save(); pCtx.strokeStyle = '#2ecc71'; pCtx.lineWidth = 1; pCtx.lineJoin = 'round'; pCtx.lineCap = 'round';
    pendingPatternObjects.forEach(obj => { pCtx.beginPath(); obj.points.forEach((p, i) => { const sx = p.x + roiW/2, sy = p.y + roiH/2; if(i===0) pCtx.moveTo(sx, sy); else pCtx.lineTo(sx, sy); }); pCtx.stroke(); });
    pCtx.restore();
  }
  return pendingPatternObjects.length > 0;
}

btnCapture.addEventListener('click', () => { if (processImage(cameraVideo, true)) { cameraVideo.style.display = 'none'; cameraPreview.style.display = 'block'; cameraControls.style.display = 'none'; cameraPreviewControls.style.display = 'flex'; } else showToast('인식 실패.', 'error'); });
btnRecapture.addEventListener('click', () => { cameraVideo.style.display = 'block'; cameraPreview.style.display = 'none'; cameraControls.style.display = 'flex'; cameraPreviewControls.style.display = 'none'; });
btnApplyPattern.addEventListener('click', () => {
  if (pendingPatternObjects.length > 0) { saveUndo(); state.objects.push(...pendingPatternObjects.map(o => ({...o, points: o.points.map(p => ({x: p.x + state.cam.x, y: p.y + state.cam.y}))})));
    const dataURL = cameraPreview.toDataURL(); document.getElementById('floating-preview').style.display = 'flex'; document.getElementById('preview-img-wrap').innerHTML = `<img src="${dataURL}" style="width:100%;height:100%;object-fit:cover;">`;
    pendingPatternObjects = []; render(); updateUI(); showToast('패턴이 적용되었습니다.');
  }
  stopCamera();
});

const btnOpenFile = document.getElementById('btn-open-file'), inpFile = document.getElementById('inp-file');
btnOpenFile.addEventListener('click', () => inpFile.click());
inpFile.addEventListener('change', e => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (event) => { const img = new Image(); img.onload = () => { cameraModal.style.display = 'flex'; cameraVideo.style.display = 'none'; cameraPreview.style.display = 'block'; cameraControls.style.display = 'none'; cameraPreviewControls.style.display = 'flex'; processImage(img, false); }; img.src = event.target.result; }; reader.readAsDataURL(file); });

document.getElementById('btn-go-origin').addEventListener('click', () => { state.cam.x = 0; state.cam.y = 0; state.cam.z = 1; render(); updateUI(); showToast('원점으로 이동했습니다.'); });
updateUI(); render();

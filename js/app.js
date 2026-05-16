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
  currentStitchTech: 'running',
  bgSettings: { brightness: 100, contrast: 100, opacity: 50 }
};

let drag = null, drawPts = null, drawStart = null, tempPos = null;
let panning = false, panStart = null;
let pendingPatternObjects = [];

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

// ─── DOM refs ───
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
  state.selectedIdx = -1; render(); updateUI();
}
function redo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(JSON.stringify(state.objects));
  state.objects = JSON.parse(state.redoStack.pop());
  state.selectedIdx = -1; render(); updateUI();
}

// ─── Rendering ───
function drawGrid() {
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const gz = 20 * state.cam.z;
  if (gz < 5) return;
  const ox = W / 2 - state.cam.x * state.cam.z, oy = H / 2 - state.cam.y * state.cam.z;
  ctx.strokeStyle = '#f1f2f6'; ctx.lineWidth = 1;
  let sx = ox % gz; while (sx < 0) sx += gz;
  for (let x = sx; x < W; x += gz) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  let sy = oy % gz; while (sy < 0) sy += gz;
  for (let y = sy; y < H; y += gz) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const o = w2s(0, 0);
  ctx.strokeStyle = 'rgba(239,68,68,.2)'; ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, H); ctx.stroke();
  ctx.strokeStyle = 'rgba(16,185,129,.2)'; ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(W, o.y); ctx.stroke();
}

function drawStitches(pts, color, stitchType = 'running', density = 2, angle = 0, isPreview = false) {
  if (!pts || pts.length < 2) return;
  const tempObj = { points: pts, stitch: stitchType, density, angle };
  const stitches = StitchEngine.objectToStitches(tempObj, state.maxStitchLen);
  
  ctx.save();
  if (!isPreview) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 2 * Math.max(1, state.cam.z);
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }

  ctx.strokeStyle = color; 
  ctx.lineWidth = isPreview ? 1.5 : (1.8 * Math.max(0.5, state.cam.z * 0.8)); 
  ctx.lineJoin = 'round'; 
  ctx.lineCap = 'round';
  
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
  drawStitches(pts, c, o.stitch, o.density, o.angle);
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
    if (state.tool === 'line' || state.tool === 'curve') drawStitches(pts, color, state.currentStitchTech, 2, 0, true);
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

// ─── Interaction ───
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
    else { saveUndo(); state.objects.push({ id: uid(), type: 'line', points: [...drawPts, {x:sw, y:sh}], stitch: state.currentStitchTech, density: parseFloat(document.getElementById('sl-density').value), angle: parseInt(document.getElementById('sl-angle').value), color: document.getElementById('inp-color').value, name: '직선 스티치' }); drawPts = null; updateUI(); }
  } else if (state.tool === 'arch') {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else if (drawPts.length === 1) drawPts.push({x:sw, y:sh});
    else { saveUndo(); state.objects.push({ id: uid(), type: 'arch', points: getArch(drawPts[0], drawPts[1], {x:sw, y:sh}), controlPoints: [drawPts[0], drawPts[1], {x:sw, y:sh}], stitch: state.currentStitchTech, density: parseFloat(document.getElementById('sl-density').value), angle: parseInt(document.getElementById('sl-angle').value), color: document.getElementById('inp-color').value, name: '호 스티치' }); drawPts = null; updateUI(); }
  } else if (state.tool === 'curve') {
    if (!drawPts) drawPts = [{x:sw, y:sh}];
    else { if (Math.hypot(sw - drawPts[0].x, sh - drawPts[0].y) < 15 && drawPts.length > 2) { drawPts.push({...drawPts[0]}); saveUndo(); state.objects.push({ id: uid(), type: 'curve', points: drawPts, stitch: state.currentStitchTech, density: 2, angle: 0, color: document.getElementById('inp-color').value, name: '곡선 스티치' }); drawPts = null; updateUI(); } else drawPts.push({x:sw, y:sh}); }
  } else if (state.tool === 'circle') drawStart = { cx: sw, cy: sh, ex: sw, ey: sh };
  else if (state.tool === 'rect') { if (!drawPts) drawPts = [{x:sw, y:sh}]; else { saveUndo(); const p0 = drawPts[0]; const rpts = [{x:p0.x, y:p0.y}, {x:sw, y:p0.y}, {x:sw, y:sh}, {x:p0.x, y:sh}, {x:p0.x, y:p0.y}]; state.objects.push({ id: uid(), type: 'rect', points: rpts, stitch: 'fill', density: 2, angle: 0, color: document.getElementById('inp-color').value, name: '사각형 채우기' }); drawPts = null; updateUI(); } }
});

cv.addEventListener('pointermove', e => {
  const mx = e.offsetX, my = e.offsetY, w = s2w(mx, my);
  tempPos = { x: snap(w.x), y: snap(w.y) };
  pos.textContent = `${(w.x / 20).toFixed(1)}, ${(-w.y / 20).toFixed(1)} cm`;
  if (panning) { state.cam.x = panStart.cx - (mx - panStart.mx) / state.cam.z; state.cam.y = panStart.cy - (my - panStart.my) / state.cam.z; render(); return; }
  if (drag) {
    if (drag.t === 'move') {
      const dx = snap(w.x - drag.wx), dy = snap(w.y - drag.wy);
      state.objects[state.selectedIdx].points.forEach((p, i) => { p.x = drag.orig[i].x + dx; p.y = drag.orig[i].y + dy; });
      if (drag.origCtrl) state.objects[state.selectedIdx].controlPoints.forEach((p, i) => { p.x = drag.origCtrl[i].x + dx; p.y = drag.origCtrl[i].y + dy; });
    } else {
      const o = state.objects[state.selectedIdx];
      if (o.controlPoints) { 
        o.controlPoints[drag.nodeIdx].x = tempPos.x; o.controlPoints[drag.nodeIdx].y = tempPos.y; 
        if (o.type === 'arch') o.points = getArch(o.controlPoints[0], o.controlPoints[1], o.controlPoints[2]); 
      } else { o.points[drag.nodeIdx].x = tempPos.x; o.points[drag.nodeIdx].y = tempPos.y; }
    }
    render();
  } else if (drawStart) { drawStart.ex = tempPos.x; drawStart.ey = tempPos.y; render(); }
  else if (drawPts) render();
});

cv.addEventListener('pointerup', () => {
  panning = false;
  if (drag) drag = null;
  if (drawStart) {
    saveUndo(); const r = Math.hypot(drawStart.ex - drawStart.cx, drawStart.ey - drawStart.cy);
    if (r > 1) {
      const pts = []; for (let i = 0; i <= 48; i++) { const t = i/48 * Math.PI*2; pts.push({ x: drawStart.cx + r*Math.cos(t), y: drawStart.cy + r*Math.sin(t) }); }
      state.objects.push({ id: uid(), type: 'circle', points: pts, stitch: 'satin', density: 2, angle: 0, color: document.getElementById('inp-color').value, name: '원형 새틴' });
      updateUI();
    }
    drawStart = null; render();
  }
});

cv.addEventListener('dblclick', () => {
  if (state.tool === 'curve' && drawPts && drawPts.length > 2) {
    saveUndo(); state.objects.push({ id: uid(), type: 'curve', points: drawPts, stitch: state.currentStitchTech, density: 2, angle: 0, color: document.getElementById('inp-color').value, name: '자유곡선 스티치' });
    drawPts = null; render(); updateUI();
  }
});

cv.addEventListener('wheel', e => {
  e.preventDefault(); const w = s2w(e.offsetX, e.offsetY);
  state.cam.z = Math.max(0.15, Math.min(5, state.cam.z * (e.deltaY < 0 ? 1.15 : 0.85)));
  state.cam.x = w.x - (e.offsetX - cv.width/2)/state.cam.z; state.cam.y = w.y - (e.offsetY - cv.height/2)/state.cam.z;
  render();
}, { passive: false });

// ─── UI Actions ───
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
  state.objects.push({ id: uid(), type: 'preset', points: PatternPresets.shiftPoints(pts, state.cam.x, state.cam.y), stitch: state.currentStitchTech, density: 2, angle: 0, color: document.getElementById('inp-color').value, name: b.textContent });
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
    document.getElementById('sl-density').value = sel.density; document.getElementById('val-density').textContent = sel.density.toFixed(1);
    document.getElementById('sl-angle').value = sel.angle; document.getElementById('val-angle').textContent = sel.angle + '°';
    document.getElementById('inp-color').value = sel.color; document.getElementById('val-color').textContent = sel.color;
    state.currentStitchTech = sel.stitch;
    document.querySelectorAll('.stitch-tech-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.stitch === sel.stitch));
  }
  const { totalCount } = StitchEngine.objectsToDSTStitches(state.objects, state.maxStitchLen);
  document.getElementById('status-objs').textContent = `오브젝트: ${state.objects.length} | 스티치: ${totalCount.toLocaleString()}`;
}

// ─── Controls ───
document.getElementById('sl-density').addEventListener('input', e => {
  const v = parseFloat(e.target.value); document.getElementById('val-density').textContent = v.toFixed(1);
  if (state.selectedIdx >= 0) { state.objects[state.selectedIdx].density = v; render(); }
});
document.getElementById('sl-angle').addEventListener('input', e => {
  const v = parseInt(e.target.value); document.getElementById('val-angle').textContent = v + '°';
  if (state.selectedIdx >= 0) { state.objects[state.selectedIdx].angle = v; render(); }
});
document.getElementById('inp-color').addEventListener('input', e => {
  document.getElementById('val-color').textContent = e.target.value;
  if (state.selectedIdx >= 0) { state.objects[state.selectedIdx].color = e.target.value; render(); updateUI(); }
});

document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo-top').addEventListener('click', redo);
document.getElementById('btn-clear-all').addEventListener('click', () => { 
  if (confirm('전체 삭제하시겠습니까?')) { 
    saveUndo(); state.objects = []; state.selectedIdx = -1; 
    document.getElementById('floating-preview').style.display = 'none';
    render(); updateUI(); 
  } 
});
document.getElementById('btn-export').addEventListener('click', () => {
  const { stitches } = StitchEngine.objectsToDSTStitches(state.objects, state.maxStitchLen);
  DSTWriter.download(stitches, 'PATTERN.DST');
});
document.getElementById('btn-help-func').addEventListener('click', () => alert('선스타 패턴 에디터 도움말\n\n- 밀도: 스티치 간격 조절 (값이 작을수록 촘촘함)\n- 각도: 채우기 스티치의 진행 방향 조절\n- 마우스 휠: 확대/축소\n- 우클릭 드래그: 화면 이동\n- 스티치 도구: 직선, 호, 자유곡선 등 선택 가능\n- 라이브러리: 미리 제작된 자수 패턴을 바로 추가 가능'));

// ─── Background Settings ───
function updateTraceFilter() {
  const wrap = document.getElementById('preview-img-wrap');
  if (wrap) wrap.style.filter = `brightness(${state.bgSettings.brightness}%) contrast(${state.bgSettings.contrast}%) opacity(${state.bgSettings.opacity}%)`;
}
document.getElementById('trace-brightness').addEventListener('input', e => { state.bgSettings.brightness = e.target.value; updateTraceFilter(); });
document.getElementById('trace-contrast').addEventListener('input', e => { state.bgSettings.contrast = e.target.value; updateTraceFilter(); });
document.getElementById('trace-opacity').addEventListener('input', e => { state.bgSettings.opacity = e.target.value; updateTraceFilter(); });
document.getElementById('btn-clear-preview').addEventListener('click', () => document.getElementById('floating-preview').style.display = 'none');

// ─── Camera Feature ───
const btnCamera = document.getElementById('btn-camera');
const cameraModal = document.getElementById('camera-modal');
const cameraVideo = document.getElementById('camera-video');
const cameraPreview = document.getElementById('camera-preview');
const cameraControls = document.getElementById('camera-controls');
const cameraPreviewControls = document.getElementById('camera-preview-controls');
let cameraStream = null;

btnCamera.addEventListener('click', async () => {
  cameraModal.style.display = 'flex';
  try { cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 1280, height: 720 } }); cameraVideo.srcObject = cameraStream; }
  catch (err) { alert('카메라 접근 실패: ' + err.message); cameraModal.style.display = 'none'; }
});

document.getElementById('btn-close-camera').addEventListener('click', () => {
  cameraModal.style.display = 'none'; if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
});

document.getElementById('btn-capture').addEventListener('click', () => {
  const w = cameraVideo.videoWidth, h = cameraVideo.videoHeight;
  // Guideline area (ROI): center 80%
  const roiW = w * 0.8, roiH = h * 0.8;
  const roiX = (w - roiW) / 2, roiY = (h - roiH) / 2;

  cameraPreview.width = roiW; cameraPreview.height = roiH;
  const pCtx = cameraPreview.getContext('2d');
  
  // Crop to ROI
  pCtx.drawImage(cameraVideo, roiX, roiY, roiW, roiH, 0, 0, roiW, roiH);
  
  // Pattern Detection Mockup within ROI
  pendingPatternObjects = [];
  const cx = roiW/2, cy = roiH/2;
  const pts = []; for(let i=0; i<360; i+=10) { const r = roiW*0.2; pts.push({x: (cx + r*Math.cos(i*Math.PI/180)-roiW/2)/2, y: (cy + r*Math.sin(i*Math.PI/180)-roiH/2)/2}); }
  pendingPatternObjects.push({ id: uid(), type: 'auto', points: pts, stitch: 'running', density: 2, angle: 0, color: '#2ecc71', name: '자동 추출 패턴' });

  // Draw overlap on preview canvas
  pCtx.strokeStyle = '#2ecc71'; pCtx.lineWidth = 4; pCtx.beginPath();
  pts.forEach((p, i) => { const sx = p.x*2 + roiW/2, sy = p.y*2 + roiH/2; if(i===0) pCtx.moveTo(sx, sy); else pCtx.lineTo(sx, sy); });
  pCtx.closePath(); pCtx.stroke();

  cameraVideo.style.display = 'none'; cameraPreview.style.display = 'block';
  cameraControls.style.display = 'none'; cameraPreviewControls.style.display = 'flex';
});

document.getElementById('btn-recapture').addEventListener('click', () => {
  cameraVideo.style.display = 'block'; cameraPreview.style.display = 'none';
  cameraControls.style.display = 'flex'; cameraPreviewControls.style.display = 'none';
});

document.getElementById('btn-apply-pattern').addEventListener('click', () => {
  if (pendingPatternObjects.length > 0) {
    saveUndo();
    // Move to current camera position
    const shifted = pendingPatternObjects.map(o => ({...o, points: o.points.map(p => ({x: p.x + state.cam.x, y: p.y + state.cam.y}))}));
    state.objects.push(...shifted);
    const dataURL = cameraPreview.toDataURL();
    const floatingPreview = document.getElementById('floating-preview');
    const imgWrap = document.getElementById('preview-img-wrap');
    floatingPreview.style.display = 'flex';
    imgWrap.innerHTML = `<img src="${dataURL}" style="width:100%;height:100%;object-fit:cover;">`;
    updateTraceFilter();
    render(); updateUI();
    showToast('패턴이 분석되어 적용되었습니다.');
  }
  document.getElementById('btn-close-camera').click();
});

updateUI(); render();

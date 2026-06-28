// Coach telestration: freeform pen and straight-line annotations drawn over the
// footage. Strokes are stored in normalized [0..1] coordinates (relative to the
// video frame) and with a height-relative line width, so the exact same model
// renders identically on the on-screen overlay canvas and on the higher-res
// canvas the analysis recorder composites for export.

export const PEN_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff'];
export const DEFAULT_WIDTH = 0.006; // fraction of canvas height

// A fresh, empty stroke. `points` are pushed as the pointer moves (pen) or set
// as a two-point pair (line: start + current end).
export function makeStroke(tool, color, width = DEFAULT_WIDTH) {
  return { tool, color, width, points: [] };
}

function drawStroke(ctx, s, { x, y, w, h }) {
  if (!s || !s.points || s.points.length === 0) return;
  const P = (p) => [x + p.x * w, y + p.y * h];
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = Math.max(1.5, (s.width || DEFAULT_WIDTH) * h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s.tool === 'line') {
    // A straight line needs both ends; while only the start exists it draws nothing.
    if (s.points.length < 2) { ctx.restore(); return; }
    const [ax, ay] = P(s.points[0]);
    const [bx, by] = P(s.points[s.points.length - 1]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  } else if (s.points.length === 1) {
    // A single-point pen tap renders as a dot.
    const [px, py] = P(s.points[0]);
    ctx.beginPath();
    ctx.arc(px, py, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const [px, py] = P(p);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  ctx.restore();
}

// Render every committed stroke plus the in-progress one (if any) into `rect`
// {x,y,w,h}. Caller clears the canvas first.
export function drawAnnotations(ctx, strokes, current, rect) {
  for (const s of strokes) drawStroke(ctx, s, rect);
  if (current) drawStroke(ctx, current, rect);
}

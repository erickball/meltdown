/**
 * Front-view drawings of the electrical equipment: switchgear buses,
 * transformers, breakers, diesel generators and batteries.
 *
 * Same conventions as every painter in components.ts: the context is already
 * translated to the component's centre, `view.zoom` is pixels per metre, and
 * the drawing spans the stored width x height about the origin.
 *
 * Live state (energized, breaker position, charge) is read from
 * `elecStatus`, which main.ts resyncs from the simulation every frame; with
 * no running plant it is absent and the lamps are dark.
 */

import type { PlantComponent, ViewState } from '../types';
import { formatVoltage } from '../simulation/electrical-rules';

/** Display-only live state, resynced from the simulation (see main.ts). */
export interface ElecStatus {
  energized: boolean;
  closed?: boolean;
  running?: boolean;
  tripped?: boolean;
  /** battery state of charge, 0-1 */
  soc?: number;
  /** delivered / rating, 0+ (display) */
  loading?: number;
  fault?: string;
}

function statusOf(c: PlantComponent): ElecStatus | undefined {
  return (c as unknown as { elecStatus?: ElecStatus }).elecStatus;
}

/** Status lamp: green live, red dead, amber tripped/faulted, dark with no plant running. */
function lamp(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, st: ElecStatus | undefined): void {
  const color = !st ? '#333'
    : st.tripped || st.fault ? '#ffb020'
    : st.energized ? '#3f3' : '#e33';
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = Math.max(0.5, r * 0.25);
  ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color = '#ddd'): void {
  if (size < 4) return;   // too small to read: leave it out rather than smudge
  ctx.font = `bold ${size}px monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function renderBus(ctx: CanvasRenderingContext2D, c: Record<string, any>, view: ViewState, st?: ElecStatus): void {
  const w = c.width * view.zoom, h = c.height * view.zoom;
  const cubicles = Math.max(2, Math.round(c.width / 0.8));
  const cw = w / cubicles;
  // Cubicles
  for (let i = 0; i < cubicles; i++) {
    const x = -w / 2 + i * cw;
    ctx.fillStyle = c.dc ? '#5a5a70' : '#5c6a62';
    ctx.fillRect(x, -h / 2 + h * 0.12, cw, h * 0.88);
    ctx.strokeStyle = '#2c332f';
    ctx.lineWidth = Math.max(0.5, cw * 0.03);
    ctx.strokeRect(x, -h / 2 + h * 0.12, cw, h * 0.88);
    // Door window and handle
    ctx.fillStyle = '#20282a';
    ctx.fillRect(x + cw * 0.25, -h / 2 + h * 0.25, cw * 0.5, h * 0.14);
    ctx.fillStyle = '#aaa';
    ctx.fillRect(x + cw * 0.78, -h / 2 + h * 0.5, cw * 0.06, h * 0.12);
  }
  // Main bus bar across the top: copper when live
  ctx.fillStyle = st?.energized ? '#d8894a' : '#6a5a4a';
  ctx.fillRect(-w / 2, -h / 2, w, h * 0.12);
  label(ctx, formatVoltage(c.voltage, !!c.dc), 0, -h / 2 + h * 0.06, Math.min(h * 0.09, w / 9), '#111');
  lamp(ctx, w / 2 - cw * 0.3, -h / 2 + h * 0.2, Math.max(1.5, Math.min(cw, h) * 0.07), st);
}

function renderTransformer(ctx: CanvasRenderingContext2D, c: Record<string, any>, view: ViewState, st?: ElecStatus): void {
  const w = c.width * view.zoom, h = c.height * view.zoom;
  const tankW = w * 0.56, tankTop = -h / 2 + h * 0.3;
  // Radiator banks either side
  ctx.strokeStyle = '#566a5e';
  ctx.lineWidth = Math.max(0.6, w * 0.012);
  for (const side of [-1, 1]) {
    const x0 = side * (tankW / 2 + w * 0.02), x1 = side * (w / 2);
    for (let k = 0; k <= 6; k++) {
      const x = x0 + (x1 - x0) * (k / 6);
      ctx.beginPath();
      ctx.moveTo(x, tankTop + h * 0.08);
      ctx.lineTo(x, h / 2 - h * 0.08);
      ctx.stroke();
    }
  }
  // Main tank
  ctx.fillStyle = '#4e5e55';
  ctx.fillRect(-tankW / 2, tankTop, tankW, h / 2 - tankTop);
  ctx.strokeStyle = '#2a332e';
  ctx.lineWidth = Math.max(0.6, w * 0.015);
  ctx.strokeRect(-tankW / 2, tankTop, tankW, h / 2 - tankTop);
  // Three bushings on the lid
  for (let k = -1; k <= 1; k++) {
    const x = k * tankW * 0.3;
    ctx.fillStyle = '#9a5a2a';
    ctx.fillRect(x - w * 0.025, -h / 2 + h * 0.06, w * 0.05, tankTop - (-h / 2 + h * 0.06));
    ctx.fillStyle = '#c87a3a';
    for (let d = 0; d < 3; d++) {
      ctx.fillRect(x - w * 0.045, -h / 2 + h * (0.09 + d * 0.065), w * 0.09, h * 0.025);
    }
    ctx.fillStyle = st?.energized ? '#ffd27a' : '#777';
    ctx.beginPath();
    ctx.arc(x, -h / 2 + h * 0.05, Math.max(1, w * 0.02), 0, Math.PI * 2);
    ctx.fill();
  }
  const fs = Math.min(h * 0.08, tankW / 7);
  label(ctx, `${c.ratingMVA} MVA`, 0, tankTop + h * 0.2, fs);
  label(ctx, `${formatVoltage(c.primaryVoltage, false).replace(' AC', '')} /`, 0, tankTop + h * 0.34, fs * 0.8, '#bbb');
  label(ctx, formatVoltage(c.secondaryVoltage, false).replace(' AC', ''), 0, tankTop + h * 0.45, fs * 0.8, '#bbb');
  lamp(ctx, tankW / 2 - tankW * 0.1, tankTop + h * 0.08, Math.max(1.5, w * 0.03), st);
}

function renderBreaker(ctx: CanvasRenderingContext2D, c: Record<string, any>, view: ViewState, st?: ElecStatus): void {
  const w = c.width * view.zoom, h = c.height * view.zoom;
  ctx.fillStyle = '#56606a';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeStyle = '#2a3036';
  ctx.lineWidth = Math.max(0.5, w * 0.04);
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  // Mimic window: two contacts and the blade between them
  const wy0 = -h / 2 + h * 0.15, wy1 = -h / 2 + h * 0.55;
  ctx.fillStyle = '#1a1e22';
  ctx.fillRect(-w * 0.35, wy0, w * 0.7, wy1 - wy0);
  const closed = st ? !!st.closed : c.closed !== false;
  const top = { x: 0, y: wy0 + (wy1 - wy0) * 0.18 };
  const bot = { x: 0, y: wy1 - (wy1 - wy0) * 0.18 };
  ctx.strokeStyle = closed ? '#4f4' : '#f55';
  ctx.lineWidth = Math.max(1, w * 0.08);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bot.x, bot.y);
  if (closed) ctx.lineTo(top.x, top.y);
  else ctx.lineTo(top.x + (wy1 - wy0) * 0.35, top.y + (wy1 - wy0) * 0.1);
  ctx.stroke();
  ctx.fillStyle = '#ccc';
  for (const p of [top, bot]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1, w * 0.06), 0, Math.PI * 2);
    ctx.fill();
  }
  if (st?.tripped) label(ctx, 'TRIP', 0, -h / 2 + h * 0.66, Math.min(w * 0.3, h * 0.08), '#ffb020');
  lamp(ctx, 0, -h / 2 + h * 0.8, Math.max(1.5, w * 0.1), st);
}

function renderDiesel(ctx: CanvasRenderingContext2D, c: Record<string, any>, view: ViewState, st?: ElecStatus): void {
  const w = c.width * view.zoom, h = c.height * view.zoom;
  const skidH = h * 0.1;
  // Skid
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(-w / 2, h / 2 - skidH, w, skidH);
  // Engine block (left 58%)
  const ex0 = -w / 2 + w * 0.03, ex1 = -w / 2 + w * 0.6;
  const eTop = -h / 2 + h * 0.35;
  ctx.fillStyle = '#6a7470';
  ctx.fillRect(ex0, eTop, ex1 - ex0, h / 2 - skidH - eTop);
  // Cylinder heads along the top
  const heads = 6;
  for (let k = 0; k < heads; k++) {
    const hx = ex0 + (ex1 - ex0) * (k + 0.15) / heads;
    ctx.fillStyle = '#7c8680';
    ctx.fillRect(hx, eTop - h * 0.07, (ex1 - ex0) / heads * 0.7, h * 0.07);
  }
  // Exhaust stack
  const sx = ex0 + (ex1 - ex0) * 0.2;
  ctx.fillStyle = '#444';
  ctx.fillRect(sx, -h / 2, w * 0.05, eTop - h * 0.07 - (-h / 2));
  if (st?.running) {
    ctx.fillStyle = 'rgba(90,90,90,0.45)';
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(sx + w * 0.025 + k * w * 0.03, -h / 2 - k * h * 0.08, w * (0.03 + k * 0.012), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Generator drum (right)
  const gx = -w / 2 + w * 0.8, gr = Math.min(w * 0.18, (h - skidH) * 0.38);
  const gy = h / 2 - skidH - gr - h * 0.03;
  ctx.fillStyle = '#4c5f7a';
  ctx.beginPath();
  ctx.arc(gx, gy, gr, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#2b3646';
  ctx.lineWidth = Math.max(0.6, w * 0.008);
  ctx.stroke();
  // Coupling
  ctx.fillStyle = '#555';
  ctx.fillRect(ex1, gy - gr * 0.25, gx - gr - ex1, gr * 0.5);
  label(ctx, 'EDG', gx, gy - gr * 0.25, gr * 0.5);
  label(ctx, `${c.ratingKW >= 1000 ? `${+(c.ratingKW / 1000).toFixed(1)} MW` : `${c.ratingKW} kW`}`, gx, gy + gr * 0.35, gr * 0.38, '#ccd');
  lamp(ctx, ex1 - w * 0.04, eTop + h * 0.08, Math.max(1.5, h * 0.035), st);
}

function renderBattery(ctx: CanvasRenderingContext2D, c: Record<string, any>, view: ViewState, st?: ElecStatus): void {
  const w = c.width * view.zoom, h = c.height * view.zoom;
  const rackW = w * 0.82;
  // Rack frame
  ctx.strokeStyle = '#777';
  ctx.lineWidth = Math.max(0.6, w * 0.012);
  ctx.strokeRect(-w / 2, -h / 2, rackW, h);
  // Two tiers of cells
  const cols = 6;
  for (let tier = 0; tier < 2; tier++) {
    const y = -h / 2 + h * (0.08 + tier * 0.48);
    for (let k = 0; k < cols; k++) {
      const x = -w / 2 + rackW * (0.04 + k * 0.16);
      ctx.fillStyle = '#2d3f58';
      ctx.fillRect(x, y + h * 0.06, rackW * 0.13, h * 0.34);
      ctx.fillStyle = '#c33';
      ctx.fillRect(x + rackW * 0.02, y + h * 0.02, rackW * 0.03, h * 0.04);
      ctx.fillStyle = '#222';
      ctx.fillRect(x + rackW * 0.08, y + h * 0.02, rackW * 0.03, h * 0.04);
    }
  }
  // Charge gauge at the side
  const gx = -w / 2 + rackW + w * 0.05, gw = w * 0.1;
  ctx.fillStyle = '#111';
  ctx.fillRect(gx, -h / 2, gw, h);
  const soc = st?.soc ?? c.chargeFraction ?? 1;
  ctx.fillStyle = soc > 0.5 ? '#4c4' : soc > 0.2 ? '#cc4' : '#c44';
  ctx.fillRect(gx, h / 2 - h * soc, gw, h * soc);
  ctx.strokeStyle = '#666';
  ctx.strokeRect(gx, -h / 2, gw, h);
  label(ctx, formatVoltage(c.voltage, true), -w / 2 + rackW / 2, -h / 2 + h * 0.5, Math.min(h * 0.1, rackW / 8));
  lamp(ctx, -w / 2 + rackW - rackW * 0.06, -h / 2 + h * 0.04, Math.max(1.5, h * 0.035), st);
}

/** Draw one piece of electrical equipment (context at its centre). */
export function renderElectricalComponent(ctx: CanvasRenderingContext2D, component: PlantComponent, view: ViewState): void {
  const c = component as unknown as Record<string, any>;
  const st = statusOf(component);
  switch (component.type) {
    case 'bus': renderBus(ctx, c, view, st); break;
    case 'transformer': renderTransformer(ctx, c, view, st); break;
    case 'breaker': renderBreaker(ctx, c, view, st); break;
    case 'diesel-generator': renderDiesel(ctx, c, view, st); break;
    case 'battery': renderBattery(ctx, c, view, st); break;
  }
}

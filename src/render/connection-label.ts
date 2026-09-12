/**
 * What a selected flow path is - shared by the grid and 2.5D views, so the
 * two cannot describe the same connection differently.
 *
 * Its two ends (component and port, as built), its bore and length, and
 * while the plant runs: how much is flowing and WHICH WAY (the sign of the
 * solver's mass flow says nothing to someone looking at a picture), and the
 * state of the fluid it is carrying.
 */

import type { PlantState, PlantComponent, Connection, Fluid, Point } from '../types';
import type { SimulationState } from '../simulation';
import { flowConnectionIdForPlantConnection, formatGaugeValue, standInInfo } from './components';

export function connectionLabelLines(
  conn: Connection,
  plantState: PlantState,
  simState: SimulationState | null | undefined,
  fluidFor: (conn: Connection, from: PlantComponent) => Fluid | null | undefined,
  buildMode: boolean
): string[] | null {
  const from = plantState.components.get(conn.fromComponentId);
  const to = plantState.components.get(conn.toComponentId);
  // One end may be the environment, which is not a component
  if (!from && !to) return null;

  const name = (c: PlantComponent | undefined) => c ? (c.label || c.id) : 'Open air';
  const lines: string[] = [`${name(from)} → ${name(to)}`];
  // A break or an open nozzle has no pipe: say what the opening is instead
  const standIn = standInInfo(conn);
  if (standIn?.kind === 'break') {
    const area = conn.flowArea ?? 0;
    const centre = conn.fromElevation ?? 0;
    const tall = conn.fromOpeningHeight ?? 0;
    lines.push(tall > 0
      ? `break: ${formatGaugeValue(area * 1e4)} cm²  ·  ${formatGaugeValue(centre - tall / 2)}-${formatGaugeValue(centre + tall / 2)} m up`
      : `break: ${formatGaugeValue(area * 1e4)} cm²  ·  ${formatGaugeValue(centre)} m up`);
  } else if (standIn?.kind === 'open') {
    lines.push(`open nozzle ${from ? conn.fromPortId : conn.toPortId} - nothing is piped to it`);
  } else {
    lines.push(`ports ${conn.fromPortId} → ${conn.toPortId}`);
  }
  const bore = conn.flowArea && conn.flowArea > 0 ? Math.sqrt(4 * conn.flowArea / Math.PI) : undefined;
  const geometry: string[] = [];
  if (!standIn && bore !== undefined) geometry.push(`⌀ ${formatGaugeValue(bore)} m`);
  if (!standIn && conn.length !== undefined) geometry.push(`L ${formatGaugeValue(conn.length)} m`);
  if (geometry.length > 0) lines.push(geometry.join('  ·  '));

  if (simState) {
    const flowId = flowConnectionIdForPlantConnection(conn, plantState);
    const flow = flowId ? simState.flowConnections.find(fc => fc.id === flowId) : undefined;
    if (flow) {
      const m = flow.massFlowRate;
      const [src, dst] = m >= 0 ? [from, to] : [to, from];
      lines.push(`${formatGaugeValue(Math.abs(m))} kg/s  ${name(src)} → ${name(dst)}`);
      const fluid = fluidFor(conn, (from ?? to)!);
      if (fluid) {
        lines.push(`${fluid.phase}  ·  ${formatGaugeValue(fluid.temperature - 273.15)} °C  ·  ` +
          `${formatGaugeValue(fluid.pressure / 1e5)} bar`);
      }
    }
  }
  if (buildMode && !standIn) lines.push('click again to edit · Delete removes it');
  return lines;
}

/** The label box, beside `anchor` with a leader back to it, kept on screen. */
export function drawConnectionLabel(
  ctx: CanvasRenderingContext2D,
  anchor: Point,
  lines: string[],
  width: number,
  height: number
): void {
  ctx.save();
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const pad = 6;
  const lineH = 15;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2;
  const h = lines.length * lineH + pad * 2 - 3;
  let x = anchor.x + 14;
  let y = anchor.y - h / 2;
  if (x + w > width - 4) x = anchor.x - 14 - w;
  y = Math.max(4, Math.min(height - h - 4, y));
  ctx.fillStyle = 'rgba(20, 24, 30, 0.9)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 120, 0.85)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? '#fff' : '#cfd6e0';
    ctx.font = i === 0 ? 'bold 12px sans-serif' : '12px sans-serif';
    ctx.fillText(l, x + pad, y + pad + i * lineH);
  });
  // Leader from the run to the box
  ctx.strokeStyle = 'rgba(255, 255, 120, 0.85)';
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(x < anchor.x ? x + w : x, anchor.y);
  ctx.stroke();
  ctx.restore();
}

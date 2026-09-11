/**
 * The electrical section of the selected-component panel: what a load is
 * fed from and whether it has power, and for the network's own pieces their
 * state, loading and the operator's buttons (breaker open/close, diesel
 * start/stop, trip reset, the grid at a switchyard).
 *
 * Buttons carry data-elec-cmd; wireElectricalButtons hands their clicks to
 * the app, which applies them to the running plant as a recorded input.
 */

import type { SimulationState, ElecElement, ElecLoad } from './simulation/types';
import type { PlantState } from './types';
import type { ElectricalCommand } from './simulation/electrical';
import { formatVoltage, formatPower } from './simulation/electrical-rules';
import { supplyStatus } from './construction/electrical-wiring';

/** The part of the plant the panel reads. */
type PlantLike = { components: Map<string, unknown>; electrical?: { enabled: boolean } };

function row(label: string, value: string, title = '', color = ''): string {
  return `<div class="detail-row"><span class="detail-label"${title ? ` title="${title}"` : ''}>${label}:</span>` +
    `<span class="detail-value"${color ? ` style="color: ${color};"` : ''}>${value}</span></div>`;
}

function button(cmd: ElectricalCommand, text: string, title: string, bg = '#357'): string {
  return `<button data-elec-cmd="${cmd}" title="${title}" style="background: ${bg}; color: #fff; border: none; ` +
    `padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; margin: 2px 6px 2px 0;">${text}</button>`;
}

function hours(seconds: number): string {
  if (!isFinite(seconds)) return 'indefinitely';
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(0)} min`;
  return `${seconds.toFixed(0)} s`;
}

function faultRow(fault: string | undefined): string {
  return fault
    ? `<div class="detail-row" style="color: #fc8; font-size: 10px;" title="A wiring problem: this piece cannot use the supply it is connected to. Edit it (or its supply) to fix.">&#9888; ${fault}</div>`
    : '';
}

function elementHtml(e: ElecElement, state: SimulationState): string {
  const els = state.electrical!.elements;
  let html = '';
  const status = e.tripped ? 'TRIPPED' : e.energized ? 'ENERGIZED' : 'DEAD';
  const color = e.tripped ? '#fb4' : e.energized ? '#7f7' : '#f77';
  html += row('Status', status, 'Energized: this piece has power to give. Tripped: its overload relay opened it; reset it (or close the breaker) to try again.', color);
  html += faultRow(e.fault);
  if (e.voltage > 0) html += row('Voltage', formatVoltage(e.voltage, e.dc));

  if (e.kind === 'battery') {
    const available = (e.energyJ! > 0 ? e.dischargeW! : 0) + (e.feeds.length > 0 && e.chargeW !== undefined ? e.chargerW! : 0);
    html += row('Load', formatPower(e.demandW), 'DC power delivered to what this battery feeds.');
    html += row('Charge', `${(100 * e.energyJ! / e.capacityJ!).toFixed(1)}%`, 'State of charge of the cells.',
      e.energyJ! / e.capacityJ! > 0.2 ? '' : '#f77');
    if ((e.cellsW ?? 0) > 0) {
      html += row('Discharging', `${formatPower(e.cellsW!)} - empty in ${hours(e.energyJ! / e.cellsW!)}`,
        'The cells are carrying what the charger cannot (or all of it, with the charger dead).', '#fc8');
    } else if ((e.chargeW ?? 0) > 0) {
      html += row('Charging', formatPower(e.chargeW!), 'Spare charger output going into the cells; it tapers off as they fill.');
    }
    html += row('Can deliver', formatPower(available), 'Cells (if charged) plus charger (if its AC supply is live).');
  } else if (isFinite(e.ratingW)) {
    const pct = 100 * e.demandW / e.ratingW;
    html += row('Load', `${formatPower(e.demandW)} of ${formatPower(e.ratingW)} (${pct.toFixed(0)}%)`,
      'Power delivered against the continuous rating.', pct > 100 ? '#f77' : pct > 90 ? '#fc8' : '');
  } else {
    html += row('Load', formatPower(e.demandW), 'Power delivered to everything this bus feeds.');
  }
  if (isFinite(e.ratingW) || e.kind === 'battery') {
    const heat = 100 * e.overload;
    html += row('Relay heat', `${heat.toFixed(0)}%`,
      'Overcurrent relay thermal element. It settles at (load/rating)^2, so a piece run at its rating sits at 100%; it trips when it goes past 100% and cools while unloaded. Reclosing while it is still hot trips again almost at once.',
      heat > 90 ? '#f77' : heat > 60 ? '#fc8' : '');
  }

  // Where it gets its power
  e.feeds.forEach((f, i) => {
    const feed = els[f];
    const name = feed ? feed.label : `${f} (missing)`;
    html += row(i === 0 ? (e.kind === 'battery' ? 'Charger fed from' : e.kind === 'offsite' ? 'Generator' : 'Fed from') : 'Backup',
      `${name}${feed ? (feed.energized ? '' : ' (dead)') : ''}`, '', feed?.energized ? '' : '#f99');
  });

  // Kind-specific state and buttons
  const buttons: string[] = [];
  switch (e.kind) {
    case 'offsite':
      html += row('Grid', e.available ? 'available' : 'LOST', 'Offsite power at this switchyard. With the grid there, the generator\'s output is exported and house loads draw from the grid through the transformers fed from here. With it gone, the generator (if still on line) carries the house loads by itself - if its speed governor can hold it.', e.available ? '#7f7' : '#f77');
      buttons.push(e.available
        ? button('offsite-lost', 'Lose offsite power', 'Disconnect the grid here: a loss of offsite power. Every transformer fed from this switchyard goes dead; emergency diesels set to auto-start will start.', '#744')
        : button('offsite-restored', 'Restore offsite power', 'Reconnect the grid.', '#264'));
      break;
    case 'breaker':
      html += row('Position', e.closed ? 'CLOSED' : 'OPEN', '', e.closed ? '#7f7' : '#f77');
      buttons.push(e.closed
        ? button('open', 'Open', 'Open the breaker: everything fed through it goes dead.', '#744')
        : button('close', 'Close', 'Close the breaker (this also resets an overload trip).', '#264'));
      break;
    case 'diesel': {
      const starting = !!e.running && e.startElapsed! < e.startTime!;
      html += row('Engine', e.running ? (starting ? `STARTING (${e.startElapsed!.toFixed(0)}/${e.startTime} s)` : 'RUNNING') : 'STOPPED',
        'A diesel carries load only once it is up to speed.', e.running ? (starting ? '#fc8' : '#7f7') : '#aaa');
      const burnW = 0.25 * e.ratingW + 0.75 * e.demandW;
      html += row('Fuel', `${(100 * e.fuelJ! / e.fuelCapacityJ!).toFixed(1)}%${e.running ? ` - ${hours(e.fuelJ! / burnW)} at this load` : ''}`,
        'Fuel on hand. Idling burns about a quarter of the full-load rate.', e.fuelJ! / e.fuelCapacityJ! > 0.1 ? '' : '#f77');
      html += row('Auto-start', e.autoStart ? 'on' : 'off', 'Starts by itself when a bus it feeds goes dead.');
      buttons.push(e.running
        ? button('stop', 'Stop', 'Stop the engine.', '#744')
        : button('start', 'Start', 'Start the engine; it carries load after its start time.', '#264'));
      break;
    }
    case 'generator': {
      const mode = e.turbineTripped ? 'TURBINE TRIPPED'
        : !e.online ? 'OFF LINE'
        : e.synchronized ? 'SYNCHRONIZED' : 'ISLANDED';
      html += row('Generator', mode,
        'Synchronized: tied to the grid, which holds its speed. Islanded: carrying the plant\'s own loads with no grid - its speed is whatever the turbine and the load make it. Off line: breaker open.',
        e.turbineTripped ? '#f77' : e.synchronized ? '#7f7' : e.online ? '#fc8' : '#aaa');
      const pct = 100 * e.speed!;
      html += row('Rotor speed', `${pct.toFixed(1)}%`,
        `Fraction of rated (synchronous) speed. The turbine trips above ${(100 * e.overspeedTrip!).toFixed(0)}%; the generator breaker opens below 95%.`,
        pct > 100 * e.overspeedTrip! - 3 || pct < 96 ? '#f77' : Math.abs(pct - 100) > 1 ? '#fc8' : '');
      html += row('Shaft power', formatPower(e.mechW ?? 0), 'Work of the turbine\'s steam expansion.');
      if (e.synchronized) {
        html += row('To grid', formatPower(e.exportW ?? 0), 'Generator output less the house load.', (e.exportW ?? 0) > 0 ? '#7f7' : '#fc8');
      }
      html += row('Speed governor', e.speedGovernor
        ? `control valves ${(100 * e.govValve!).toFixed(0)}% (droop ${(100 * e.droop!).toFixed(1)}%, reset ${(100 * e.govReset!).toFixed(0)}%)`
        : 'none - nothing holds the speed off the grid',
        'The control valves sit at the governor valve setting plus the speed correction: (1 - speed)/droop, plus a reset that winds in to hold an island at rated speed and winds back out at 10%/min once tied to the grid again.');
      buttons.push(e.online
        ? button('open', 'Open generator breaker', 'Take the generator off line: with no load, only the speed governor stands between the turbine and overspeed.', '#744')
        : button('close', 'Close generator breaker', 'Put the generator on line. Onto a live grid the synch check wants speed within 1% of rated; onto dead plant buses it closes at any speed.', '#264'));
      buttons.push(e.turbineTripped
        ? button('turbine-reset', 'Reset turbine trip', 'Open the stop valves again. The speed governor brings the rotor to rated speed; then close the generator breaker.', '#264')
        : button('turbine-trip', 'Trip turbine', 'Shut the stop valves now and open the generator breaker.', '#744'));
      break;
    }
  }
  if (e.tripped && e.kind !== 'breaker') {
    buttons.push(button('reset', 'Reset trip', 'Reset the overload trip. If the load that tripped it is still there, the relay is still hot and it trips again almost at once.', '#665'));
  }
  if (buttons.length > 0) html += `<div class="detail-row" style="flex-wrap: wrap;">${buttons.join('')}</div>`;
  return html;
}

/** What a running load draws, and what losing its power does. (Its supply is in powerSupplyRows.) */
function loadHtml(l: ElecLoad): string {
  let html = '';
  if (l.ratedW > 0 || l.demandW > 0) {
    html += row('Drawing', `${formatPower(l.demandW)}${l.ratedW > 0 ? ` (rated ${formatPower(l.ratedW)})` : ''}`,
      l.kind === 'pump' ? 'Motor input: hydraulic power on the pump curve plus losses, scaled by speed cubed. A running pump against a closed discharge still draws its losses.' : '');
  }
  if (!l.powered) {
    const effect: Record<ElecLoad['kind'], string> = {
      pump: 'The pump coasts down; it restarts by itself when the power returns.',
      mov: 'The valve stays where it is: nothing can stroke it.',
      porv: 'The PORV\'s solenoid has dropped out: it is shut and cannot relieve.',
      controller: 'The cabinet does not scan; its actuator stays where it was.',
      rps: 'The protection system has tripped the reactor (de-energize to trip).',
      heater: 'The heaters heat nothing.',
      'rod-drive': 'The rod drives let go: the rods are in (scram).',
    };
    html += `<div class="detail-row" style="color: #f99; font-size: 10px;">${effect[l.kind]}</div>`;
  }
  return html;
}

/**
 * Operating Status rows for a part that needs power: what it is fed from (and
 * at what voltage), or what it needs when nothing suitable is connected, and
 * - with a running network that matches the wiring on screen - whether it has
 * power right now. '' for a part that takes no supply, or with the model off.
 *
 * The wiring half is read from the plant, not the simulation, so it is right
 * in construction mode too, straight after an edit.
 */
export function powerSupplyRows(componentId: string, plant: PlantLike, state: SimulationState): string {
  if (!plant.electrical?.enabled) return '';
  const c = plant.components.get(componentId) as Record<string, any> | undefined;
  if (!c) return '';
  const st = supplyStatus(plant as unknown as PlantState, c);
  if (!st) return '';
  let html = '';
  html += row('Power supply',
    st.supplyLabel ? `${st.supplyLabel}${st.supplyVoltage ? ` (${st.supplyVoltage})` : ''}` : 'none',
    `What this part is fed from. It needs ${st.needs}. Change it with Edit, or use Auto-wire.`,
    st.problem ? '#f99' : '');
  if (!st.supplyLabel) html += row('Needs', st.needs, 'The kind of supply this part runs from.', '#fc8');
  if (st.problem && st.supplyLabel) {
    html += `<div class="detail-row" style="color: #fc8; font-size: 10px;" title="As wired, power cannot reach this part. Edit it (or its supply) to fix.">&#9888; ${st.problem}</div>`;
  }
  // Live state, only while the running network is wired the way the plant is
  // now (after an unapplied edit, the simulation's answer is about the old wiring)
  const load = state.electrical?.loads[componentId];
  if (load && load.supplyId === c.powerSupplyId) {
    html += row('Power', load.powered ? 'POWERED' : 'NO POWER',
      'Whether the supply is live right now.', load.powered ? '#7f7' : '#f77');
  }
  return html;
}

function section(title: string, body: string): string {
  return `<div class="detail-section"><div class="detail-section-title">${title}</div>${body}</div>`;
}

/**
 * The electrical section for one component, or '' when it has none.
 *
 * A running piece of the network gets its state, loading and buttons. A part
 * that needs power gets an Operating Status section with its supply rows
 * (powerSupplyRows) and what it draws - unless the panel already has an
 * Operating Status section that shows the supply (`supplyShownAbove`, a
 * pump), in which case what is left goes under Electrical.
 */
export function electricalDetailHtml(
  componentId: string, plant: PlantLike, state: SimulationState,
  opts: { supplyShownAbove?: boolean } = {}
): string {
  if (!plant.electrical?.enabled) return '';
  const E = state.electrical;
  const e = E?.elements[componentId];
  if (e) return section('Electrical', elementHtml(e, state));
  const l = E?.loads[componentId];
  const supply = opts.supplyShownAbove ? '' : powerSupplyRows(componentId, plant, state);
  const running = l ? loadHtml(l) : '';
  if (!supply && !running) return '';
  return section(opts.supplyShownAbove ? 'Electrical' : 'Operating Status', supply + running);
}

/** Hand the panel's electrical buttons to the app. */
export function wireElectricalButtons(
  root: HTMLElement, componentId: string, onCommand: (componentId: string, cmd: ElectricalCommand) => void
): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-elec-cmd]').forEach(btn => {
    btn.addEventListener('click', () => onCommand(componentId, btn.dataset.elecCmd as ElectricalCommand));
  });
}

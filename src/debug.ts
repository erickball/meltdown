/**
 * Debug utilities for monitoring simulation state
 */

import {
  SimulationState,
  SolverMetrics,
  calculateWaterState,
  distanceToSaturationLine,
  saturationPressure,
  getWaterPropsProfile,
  resetWaterPropsProfile,
  getFlowOperatorProfile,
  resetFlowOperatorProfile,
  getSolverProfile,
  resetSolverProfile,
  getTurbineCondenserState,
} from './simulation';
import {
  GasComposition,
  totalMoles,
  ALL_GAS_SPECIES,
  GAS_PROPERTIES,
  R_GAS,
  mixtureCv,
} from './simulation/gas-properties';

// Store previous pressures to show transitions
let previousPressures: Map<string, number> = new Map();

/**
 * Format a number with appropriate precision and color coding
 */
function formatValue(value: number, unit: string = '', warnThreshold?: number, dangerThreshold?: number): string {
  let formatted: string;

  if (Math.abs(value) >= 1e6) {
    formatted = (value / 1e6).toFixed(2) + 'M';
  } else if (Math.abs(value) >= 1e3) {
    formatted = (value / 1e3).toFixed(2) + 'k';
  } else if (Math.abs(value) < 0.01 && value !== 0) {
    formatted = value.toExponential(2);
  } else {
    formatted = value.toFixed(2);
  }

  let cssClass = 'debug-value';
  if (dangerThreshold !== undefined && value > dangerThreshold) {
    cssClass = 'debug-danger';
  } else if (warnThreshold !== undefined && value > warnThreshold) {
    cssClass = 'debug-warning';
  }

  return `<span class="${cssClass}">${formatted}${unit}</span>`;
}

/**
 * Smart format for temperature (°C) - more digits for small/cold values
 */
function formatTemp(tempC: number): string {
  if (Math.abs(tempC) < 10) {
    return tempC.toFixed(2);  // e.g., "0.31" or "-5.25"
  } else if (Math.abs(tempC) < 100) {
    return tempC.toFixed(1);  // e.g., "70.5"
  } else {
    return tempC.toFixed(0);  // e.g., "260"
  }
}

/**
 * Smart format for pressure (bar) - more digits for low pressures
 */
function formatPressure(pBar: number): string {
  if (pBar < 0.1) {
    return pBar.toFixed(4);   // e.g., "0.0312"
  } else if (pBar < 1) {
    return pBar.toFixed(3);   // e.g., "0.312"
  } else if (pBar < 10) {
    return pBar.toFixed(2);   // e.g., "5.67"
  } else {
    return pBar.toFixed(1);   // e.g., "155.3"
  }
}

/**
 * Format NCG (Non-Condensible Gas) partial pressures for display.
 * Converts moles to partial pressure using ideal gas law: P = nRT/V
 * Returns HTML string for the NCG section, or empty string if no NCGs present.
 */
function formatNcgPressures(ncg: GasComposition, temperature: number, volume: number): string {
  const total = totalMoles(ncg);
  if (total <= 0) return '';

  let html = '<div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #444;">';
  html += '<div style="color: #aaf; font-size: 10px; margin-bottom: 4px;">NCG Partial Pressures</div>';

  // Calculate total NCG pressure
  const P_total_ncg = (total * R_GAS * temperature) / volume; // Pa
  html += `<div class="detail-row"><span class="detail-label">Total NCG:</span><span class="detail-value" style="color: #faa;">${formatPressure(P_total_ncg / 1e5)} bar</span></div>`;

  // Show individual species
  for (const species of ALL_GAS_SPECIES) {
    const moles = ncg[species];
    if (moles > 0) {
      const P_species = (moles * R_GAS * temperature) / volume; // Pa
      const P_bar = P_species / 1e5;
      const props = GAS_PROPERTIES[species];
      html += `<div class="detail-row"><span class="detail-label">${props.formula}:</span><span class="detail-value">${formatPressure(P_bar)} bar</span></div>`;
    }
  }

  html += '</div>';
  return html;
}

/**
 * Smart format for flow rate (kg/s) - more digits for low flows
 */
function formatFlow(flow: number): string {
  const absFlow = Math.abs(flow);
  if (absFlow < 1) {
    return flow.toFixed(2);   // e.g., "0.25" or "-0.03"
  } else if (absFlow < 10) {
    return flow.toFixed(1);   // e.g., "5.3"
  } else {
    return flow.toFixed(0);   // e.g., "1557"
  }
}

/**
 * Format density with one extra digit (always show .1 precision)
 */
function formatDensity(rho: number): string {
  if (rho < 10) {
    return rho.toFixed(2);    // e.g., "0.35"
  } else if (rho < 100) {
    return rho.toFixed(1);    // e.g., "72.5"
  } else {
    return rho.toFixed(1);    // e.g., "975.3" (extra digit vs previous)
  }
}

/** Pressure solver status for debug panel display */
export interface PressureSolverDebugInfo {
  enabled: boolean;
  status: {
    ran: boolean;
    iterations: number;
    converged: boolean;
    stagnated: boolean;
    maxImbalance: number;
    K_max: number | undefined;
  } | null;
}

/**
 * Update the debug panel with current simulation state
 */
export function updateDebugPanel(
  state: SimulationState,
  metrics: SolverMetrics,
  pressureSolverInfo?: PressureSolverDebugInfo
): void {
  // Solver info
  const solverDiv = document.getElementById('debug-solver');
  if (solverDiv) {
    const rtRatioClass = metrics.realTimeRatio < 0.5 ? 'debug-danger' :
                        metrics.realTimeRatio < 0.95 ? 'debug-warning' : 'debug-value';

    // Format dt limiter - shorten operator names
    let limiterDisplay = metrics.dtLimitedBy;
    if (limiterDisplay === 'config.maxDt') limiterDisplay = 'maxDt';

    // Build error contributors display - always reserve space for 3 lines to prevent layout jumping
    let errorContributorsHtml = '';
    const emptyLine = '<span style="color: #444; font-size: 10px; margin-left: 12px;">•</span>';
    if (metrics.dtLimitedBy === 'RK45-error' && metrics.topErrorContributors && metrics.topErrorContributors.length > 0) {
      const typeLabels: Record<string, string> = {
        'mass': 'mass',
        'energy': 'energy',
        'throughput': 'flow-thru',
        'momentum': 'momentum',
        'temperature': 'temp',
        'power': 'power',
        'precursor': 'precursor'
      };
      // Build lines for each contributor (up to 3)
      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (i < metrics.topErrorContributors.length) {
          const c = metrics.topErrorContributors[i];
          const pct = (c.contribution * 100).toFixed(0);
          const typeLabel = typeLabels[c.type] || c.type;
          lines.push(`<span style="color: #aaa; font-size: 10px; margin-left: 12px;">• ${c.nodeId} <span style="color: #7af;">${typeLabel}</span> (${pct}%): ${c.description}</span>`);
        } else {
          lines.push(emptyLine);
        }
      }
      errorContributorsHtml = `<br><span class="debug-label" style="font-size: 10px;">Error sources:</span><br>${lines.join('<br>')}`;
    } else {
      // Always show the section with placeholder lines to prevent layout jumping
      errorContributorsHtml = `<br><span class="debug-label" style="font-size: 10px; color: #555;">Error sources:</span><br>${emptyLine}<br>${emptyLine}<br>${emptyLine}`;
    }

    // Build pressure solver status display
    let pressureSolverHtml = '';
    if (pressureSolverInfo) {
      if (!pressureSolverInfo.enabled) {
        pressureSolverHtml = `<br><span class="debug-label">Pressure solver:</span> <span style="color: #666;">disabled</span>`;
      } else if (pressureSolverInfo.status) {
        const s = pressureSolverInfo.status;
        // Format K_max
        const kMaxStr = s.K_max !== undefined
          ? `${(s.K_max / 1e6).toFixed(0)} MPa`
          : 'unlimited';
        // Format convergence status
        let statusStr: string;
        let statusClass: string;
        if (s.converged) {
          statusStr = `converged (${s.iterations} iter)`;
          statusClass = 'debug-value';
        } else if (s.stagnated) {
          statusStr = `stagnated (${s.iterations} iter)`;
          statusClass = 'debug-warning';
        } else {
          statusStr = `${s.iterations} iter`;
          statusClass = 'debug-warning';
        }
        pressureSolverHtml = `<br><span class="debug-label">Pressure solver:</span> <span class="${statusClass}">${statusStr}</span>, K<sub>max</sub>=${kMaxStr}`;
      }
    }

    solverDiv.innerHTML = `
      <span class="debug-label">Target dt:</span> ${formatValue(metrics.currentDt * 1000, 'ms')}<br>
      <span class="debug-label">Actual dt:</span> ${formatValue(metrics.actualDt * 1000, 'ms')} <span style="color: #888;">(${limiterDisplay})</span><br>
      <span class="debug-label">Stability limit:</span> ${formatValue(metrics.maxStableDt * 1000, 'ms')} <span style="color: #888;">(${metrics.stabilityLimitedBy}, ×0.8→${formatValue(metrics.maxStableDt * 0.8 * 1000, 'ms')})</span><br>
      <span class="debug-label">Wall time:</span> ${formatValue(metrics.lastStepWallTime, 'ms', 16, 33)}<br>
      <span class="debug-label">RT Ratio:</span> <span class="${rtRatioClass}">${metrics.realTimeRatio.toFixed(3)}x</span>${pressureSolverHtml}${errorContributorsHtml}
    `;
  }

  // Neutronics - only show if a core is linked
  const neutronicsDiv = document.getElementById('debug-neutronics');
  if (neutronicsDiv) {
    const n = state.neutronics;

    // Check if neutronics is active (has a linked core)
    if (!n.coreId) {
      neutronicsDiv.innerHTML = '<span style="color: #666; font-style: italic;">No reactor core in configuration</span>';
    } else {
      const powerPct = (n.power / n.nominalPower) * 100;
      const rhoDisplay = (n.reactivity * 1e5).toFixed(1); // Display in pcm
      const rb = n.reactivityBreakdown;

      // Format reactivity components in pcm
      const rodsPcm = (rb.controlRods * 1e5).toFixed(1);
      const dopplerPcm = (rb.doppler * 1e5).toFixed(1);
      const coolantTempPcm = (rb.coolantTemp * 1e5).toFixed(1);
      const coolantDensityPcm = (rb.coolantDensity * 1e5).toFixed(1);

      // Diagnostic values
      const diag = n.diagnostics;
      const fuelTempC = (diag.fuelTemp - 273).toFixed(0);
      const coolantTempC = (diag.coolantTemp - 273).toFixed(0);
      const coolantRho = diag.coolantDensity.toFixed(1);
      const refCoolantRho = n.refCoolantDensity.toFixed(1);

      neutronicsDiv.innerHTML = `
        <span class="debug-label">Core:</span> <span class="debug-value">${n.coreId}</span><br>
        <span class="debug-label">Power:</span> ${formatValue(powerPct, '%', 100, 120)}<br>
        <span class="debug-label">Reactivity:</span> ${formatValue(parseFloat(rhoDisplay), ' pcm')}<br>
        <span class="debug-label" style="margin-left: 10px; color: #888;">Rods:</span> <span class="debug-value">${rodsPcm} pcm</span><br>
        <span class="debug-label" style="margin-left: 10px; color: #888;">Doppler:</span> <span class="debug-value">${dopplerPcm} pcm</span> (T=${fuelTempC}C)<br>
        <span class="debug-label" style="margin-left: 10px; color: #888;">Coolant T:</span> <span class="debug-value">${coolantTempPcm} pcm</span> (T=${coolantTempC}C)<br>
        <span class="debug-label" style="margin-left: 10px; color: #888;">Coolant ρ:</span> <span class="debug-value">${coolantDensityPcm} pcm</span> (ρ=${coolantRho}, ref=${refCoolantRho})<br>
        <span class="debug-label">Precursors:</span> ${formatValue(n.precursorConcentration, '')}<br>
        <span class="debug-label">Rod insertion:</span> ${formatValue((1 - n.controlRodPosition) * 100, '%')}<br>
        <span class="debug-label">Decay heat:</span> ${formatValue(n.decayHeatFraction * 100, '%')}<br>
        <span class="debug-label">SCRAM:</span> ${n.scrammed ? '<span class="debug-danger">YES</span>' : 'No'}
      `;
    }
  }

  // Thermal nodes
  const thermalDiv = document.getElementById('debug-thermal');
  if (thermalDiv) {
    if (state.thermalNodes.size === 0) {
      thermalDiv.innerHTML = '<span style="color: #666; font-style: italic;">No thermal nodes</span>';
    } else {
      let html = '';
      for (const [id, node] of state.thermalNodes) {
        const tempC = node.temperature - 273;
        const pctOfMax = (node.temperature / node.maxTemperature) * 100;
        const tempClass = pctOfMax > 95 ? 'debug-danger' : pctOfMax > 80 ? 'debug-warning' : 'debug-value';
        html += `<span class="debug-label">${id}:</span> <span class="${tempClass}">${tempC.toFixed(0)}C</span> (${pctOfMax.toFixed(0)}% max)<br>`;
      }
      thermalDiv.innerHTML = html;
    }
  }

  // Flow nodes
  const flowDiv = document.getElementById('debug-flow');
  if (flowDiv) {
    if (state.flowNodes.size === 0) {
      flowDiv.innerHTML = '<span style="color: #666; font-style: italic;">No flow nodes</span>';
    } else {
    let html = '';
    for (const [id, node] of state.flowNodes) {
      const tempC = node.fluid.temperature - 273;
      const pBar = node.fluid.pressure / 1e5;
      const massKg = node.fluid.mass;

      // Check for problematic values
      const tempClass = !isFinite(tempC) || tempC > 1000 ? 'debug-danger' :
                       tempC > 400 ? 'debug-warning' : 'debug-value';
      const massClass = !isFinite(massKg) || massKg < 1 ? 'debug-danger' :
                       massKg < 100 ? 'debug-warning' : 'debug-value';

      // Get previous pressure for this node
      const prevPressure = previousPressures.get(id);
      const showTransition = prevPressure !== undefined && Math.abs(prevPressure - node.fluid.pressure) > 1000; // Show if change > 0.01 bar

      html += `<b>${id}</b>: `;
      html += `<span class="${tempClass}">${formatTemp(tempC)}C</span>, `;

      // Calculate steam pressure if NCG is present
      const ncgMoles = node.fluid.ncg ? totalMoles(node.fluid.ncg) : 0;
      let steamPBar = pBar; // Default to total pressure if no NCG
      if (ncgMoles > 0 && node.volume > 0) {
        const ncgPressure = (ncgMoles * R_GAS * node.fluid.temperature) / node.volume;
        steamPBar = Math.max(0, pBar - ncgPressure / 1e5);
      }

      // Show pressure transition if significant change
      if (showTransition) {
        const prevPBar = prevPressure / 1e5;
        const changeBar = (node.fluid.pressure - prevPressure) / 1e5;
        const changeClass = Math.abs(changeBar) > 5 ? 'debug-danger' :
                           Math.abs(changeBar) > 2 ? 'debug-warning' : 'debug-value';
        html += `${formatPressure(prevPBar)}→<span class="${changeClass}">${formatPressure(pBar)}bar</span>`;
      } else {
        html += `${formatPressure(pBar)}bar`;
      }
      // Show steam partial pressure if NCG is present
      if (ncgMoles > 0) {
        html += ` <span style="color: #8cf;">(P<sub>stm</sub>=${formatPressure(steamPBar)})</span>`;
      }
      html += ', ';

      html += `<span class="${massClass}">${massKg.toFixed(0)}kg</span>, `;
      html += `${node.fluid.phase}`;
      if (node.fluid.phase === 'two-phase') {
        html += ` x=${(node.fluid.quality * 100).toFixed(1)}%`;
      }
      html += '<br>';

      // Second line: density, separation, and phase-specific debug info
      const rho = massKg / node.volume;
      // For water properties, need to subtract NCG energy from total internal energy
      // (reuse ncgMoles from above)
      let steamEnergy = node.fluid.internalEnergy;
      if (ncgMoles > 0) {
        // U_ncg = n * Cv * T (ideal gas)
        // Average Cv for air is ~20.8 J/(mol·K)
        const avgCv = 20.8; // J/(mol·K) - approximate for air-like mixture
        const ncgEnergy = ncgMoles * avgCv * node.fluid.temperature;
        steamEnergy = Math.max(0, node.fluid.internalEnergy - ncgEnergy);
      }
      let rawState;
      let rawP_bar = 0;
      try {
        rawState = calculateWaterState(massKg, steamEnergy, node.volume);
        rawP_bar = rawState.pressure / 1e5;
      } catch {
        // Water properties calculation can fail for extreme states
        rawState = null;
      }
      const u_kJ = steamEnergy / Math.max(1, massKg) / 1000; // specific STEAM energy kJ/kg

      html += `<span style="font-size: 9px; color: #888; margin-left: 10px;">`;
      html += `ρ=${formatDensity(rho)}`;
      html += `, u=${u_kJ.toFixed(0)}kJ/kg`;

      if (node.fluid.phase === 'two-phase') {
        // Two-phase: show P_sat, void fraction, and separation factor
        html += ` (P<sub>sat</sub>=${formatPressure(rawP_bar)}bar)`;

        // Calculate void fraction (volume fraction of vapor) from quality (mass fraction)
        // α = (x / ρ_g) / (x / ρ_g + (1-x) / ρ_f)
        // At low pressure, even tiny quality gives huge void fraction
        const quality = node.fluid.quality ?? 0;
        if (quality > 0 && quality < 1) {
          // Estimate phase densities from temperature (approximate)
          const T_C = node.fluid.temperature - 273.15;
          // Liquid density approximation
          const rho_f = T_C < 100 ? 1000 - 0.08 * T_C :
                       T_C < 300 ? 958 - 1.3 * (T_C - 100) :
                       Math.max(400, 700 - 2.5 * (T_C - 300));
          // Vapor density from ideal gas at saturation pressure
          const P_sat = node.fluid.pressure; // Pa
          const T_K = node.fluid.temperature;
          const R = 8314; // J/(kmol·K)
          const M = 18; // kg/kmol for water
          const rho_g = P_sat * M / (R * T_K);

          const v_vapor = quality / rho_g;
          const v_liquid = (1 - quality) / rho_f;
          const voidFraction = v_vapor / (v_vapor + v_liquid);
          const voidPct = (voidFraction * 100).toFixed(1);
          // Color code: high void = warning (pump performance issue)
          const voidClass = voidFraction > 0.9 ? 'debug-danger' :
                           voidFraction > 0.5 ? 'debug-warning' : 'debug-value';
          html += `, <span class="${voidClass}">α=${voidPct}%</span>`;

          // Calculate liquid level for display
          const liquidMass = node.fluid.mass * (1 - quality);
          const liquidVolume = liquidMass / rho_f;
          const nodeHeight = node.height ?? Math.cbrt(node.volume);
          const baseArea = node.volume / nodeHeight;
          const liquidLevel = liquidVolume / baseArea;
          const levelPct = (liquidLevel / nodeHeight * 100).toFixed(1);
          html += `, lvl=${liquidLevel.toFixed(3)}m (${levelPct}%)`;
        }

        const sep = node.separation;
        if (sep !== undefined && sep !== null) {
          const sepPct = (sep * 100).toFixed(0);
          const sepClass = sep > 0.8 ? 'debug-value' :
                          sep > 0.3 ? 'debug-warning' : 'debug-danger';
          html += `, <span class="${sepClass}">sep=${sepPct}%</span>`;
        } else {
          html += `, sep=?`;
        }
      } else if (node.fluid.phase === 'liquid') {
        // Liquid: just show raw water properties pressure
        html += ` (P<sub>wp</sub>=${formatPressure(rawP_bar)}bar)`;
      } else {
        // Vapor: just show raw water properties pressure
        html += ` (P<sub>wp</sub>=${formatPressure(rawP_bar)}bar)`;
      }

      html += `</span><br>`;

      // Third line: saturation margin info (v, P_sat(T), distance to saturation)
      const v_m3kg = node.volume / massKg;  // specific volume m³/kg
      const u_Jkg = node.fluid.internalEnergy / massKg;  // specific energy J/kg
      const P_sat_T = saturationPressure(node.fluid.temperature);
      const satDist = distanceToSaturationLine(u_Jkg, v_m3kg);

      // Color code based on distance to saturation
      // Positive = compressed (safe), negative = expanded (approaching two-phase)
      // Distance is in scaled units where v is mL/kg and u is kJ/kg (both ~1000-1700)
      const absDistance = Math.abs(satDist.distance);
      const distClass = satDist.distance < 0 ? 'debug-danger' :  // Expanded past v_f - danger!
                       absDistance < 50 ? 'debug-warning' :      // Close to boundary
                       'debug-value';                            // Safe compressed liquid

      html += `<span style="font-size: 9px; color: #888; margin-left: 10px;">`;
      html += `v=${satDist.v_mLkg.toFixed(1)}`;
      html += `, v<sub>f</sub>=${satDist.v_f_closest.toFixed(1)}`;
      html += `, P<sub>sat</sub>(T)=${formatPressure(P_sat_T/1e5)}bar`;
      html += `, <span class="${distClass}">Δsat=${satDist.distance >= 0 ? '+' : ''}${satDist.distance.toFixed(1)}</span>`;
      html += `</span><br>`;
    }



    // Also show flow rates with target flows
    html += '<br><b>Flow connections:</b><br>';
    for (const conn of state.flowConnections) {
      const flowClass = !isFinite(conn.massFlowRate) ? 'debug-danger' :
                       Math.abs(conn.massFlowRate) < 1 ? 'debug-warning' : 'debug-value';

      html += `${conn.fromNodeId} → ${conn.toNodeId}: `;

      // Show actual flow
      html += `<span class="${flowClass}">${formatFlow(conn.massFlowRate)}</span>`;

      // If connection has inertance, show steady-state flow vs actual
      if (conn.inertance && conn.inertance > 0 && conn.steadyStateFlow !== undefined) {
        const steadyClass = Math.abs(conn.steadyStateFlow - conn.massFlowRate) > 100 ? 'debug-warning' : 'debug-value';
        html += ` → <span class="${steadyClass}">${formatFlow(conn.steadyStateFlow)}</span>`;
      }

      html += ` kg/s`;

      // Show pump head if there's a pump providing head on this connection
      // Only pumps with connectedFlowPath === conn.id actually contribute head
      for (const [pumpId, pump] of state.components.pumps) {
        if (pump.connectedFlowPath === conn.id && pump.effectiveSpeed > 0) {
          // Calculate pump head: dP_pump = effectiveSpeed * ratedHead * rho * g
          const flowIsForward = conn.massFlowRate >= 0;
          const upstreamId = flowIsForward ? conn.fromNodeId : conn.toNodeId;
          const upstreamNode = state.flowNodes.get(upstreamId);
          const rho = upstreamNode ? upstreamNode.fluid.mass / upstreamNode.volume : 750; // Default to ~750 kg/m³
          const g = 9.81;
          const dP_pump = pump.effectiveSpeed * pump.ratedHead * rho * g;
          html += ` <span style="color: #8af;">[${pumpId}: +${(dP_pump/1e5).toFixed(1)}bar]</span>`;
        }
      }
      html += '<br>';
    }

    // Show total mass for conservation check (exclude boundary nodes like atmosphere)
    let totalMass = 0;
    let totalEnergy = 0;
    for (const [, node] of state.flowNodes) {
      // Skip boundary nodes (atmosphere, etc.) - they have effectively infinite mass/energy
      if (node.isBoundary) continue;
      totalMass += node.fluid.mass;
      totalEnergy += node.fluid.internalEnergy;
    }
    html += `<br><b>Total mass:</b> <span class="debug-value">${(totalMass / 1000).toFixed(2)} tons</span><br>`;
    html += `<b>Total fluid energy:</b> <span class="debug-value">${(totalEnergy / 1e9).toFixed(2)} GJ</span><br>`;

    // Show energy diagnostics if available
    if (state.energyDiagnostics) {
      const diag = state.energyDiagnostics;
      html += '<br><b>Energy Balance:</b><br>';
      html += `<span class="debug-label">Heat gen:</span> ${formatValue(diag.heatGenerationTotal / 1e6, ' MW')}<br>`;
      html += `<span class="debug-label">Fuel→Core:</span> ${formatValue(diag.fuelToCoreCoolant / 1e6, ' MW')}<br>`;
      html += `<span class="debug-label">Core→SG:</span> ${formatValue(diag.coreCoolantToSG / 1e6, ' MW')}<br>`;

      // Get turbine and condenser state
      const turbineStats = getTurbineCondenserState();
      html += '<br><b>Power Conversion:</b><br>';
      html += `<span class="debug-label">Turbine:</span> ${formatValue(turbineStats.turbinePower / 1e6, ' MW')} (electric)<br>`;
      html += `<span class="debug-label">Condenser:</span> ${formatValue(-turbineStats.condenserHeatRejection / 1e6, ' MW')} (removed)<br>`;
      html += `<span class="debug-label">Pump work:</span> ${formatValue(turbineStats.feedwaterPumpWork / 1e6, ' MW')} (added)<br>`;
      html += `<span class="debug-label">Net power:</span> ${formatValue(turbineStats.netPower / 1e6, ' MW')}<br>`;

      // Energy balance check
      const energyIn = diag.heatGenerationTotal + turbineStats.feedwaterPumpWork;
      const energyOut = turbineStats.turbinePower + turbineStats.condenserHeatRejection;
      const imbalance = energyIn - energyOut;
      const imbalanceClass = Math.abs(imbalance) > 10e6 ? 'debug-danger' :
                            Math.abs(imbalance) > 1e6 ? 'debug-warning' : 'debug-value';
      html += `<span class="debug-label">Imbalance:</span> <span class="${imbalanceClass}">${formatValue(imbalance / 1e6, ' MW')}</span><br>`;

      // Show all heat transfer connections
      html += '<br><b>Heat transfers:</b><br>';
      for (const [connId, rate] of diag.heatTransferRates) {
        const rateClass = Math.abs(rate) > 1e9 ? 'debug-danger' :
          Math.abs(rate) > 1e8 ? 'debug-warning' : 'debug-value';
        html += `<span style="font-size: 10px;">${connId}: <span class="${rateClass}">${(rate / 1e6).toFixed(2)} MW</span></span><br>`;
      }
    }

    flowDiv.innerHTML = html;

    // Store current pressures for next update to show transitions
    previousPressures.clear();
    for (const [id, node] of state.flowNodes) {
      previousPressures.set(id, node.fluid.pressure);
    }
    } // end else (flowNodes.size > 0)
  }

  // Operator timing
  const operatorsDiv = document.getElementById('debug-operators');
  if (operatorsDiv) {
    let html = '';
    let total = 0;
    for (const [name, time] of metrics.operatorTimes) {
      total += time;
      const timeClass = time > 10 ? 'debug-danger' : time > 5 ? 'debug-warning' : 'debug-value';
      html += `<span class="debug-label">${name}:</span> <span class="${timeClass}">${time.toFixed(2)}ms</span><br>`;
    }
    html += `<span class="debug-label">Total:</span> ${formatValue(total, 'ms', 10, 20)}<br>`;

    // Detailed profiling breakdown
    const flowProfile = getFlowOperatorProfile();
    const waterProfile = getWaterPropsProfile();

    if (flowProfile.totalCalls > 0) {
      html += '<br><b>FluidFlow breakdown:</b><br>';
      html += `<span style="font-size: 10px; margin-left: 8px;">flowRates: ${flowProfile.computeFlowRates.toFixed(2)}ms</span><br>`;
      html += `<span style="font-size: 10px; margin-left: 8px;">massTransfer: ${flowProfile.transferMass.toFixed(2)}ms</span><br>`;
    }

    if (waterProfile.calculateStateCalls > 0) {
      html += '<br><b>Water props breakdown:</b><br>';
      const actualComputations = waterProfile.calculateStateCalls - waterProfile.calculateStateCacheHits;
      const hitRate = waterProfile.calculateStateCacheHits / waterProfile.calculateStateCalls * 100;
      const avgStateTime = actualComputations > 0 ? waterProfile.calculateStateTime / actualComputations : 0;
      html += `<span style="font-size: 10px; margin-left: 8px;">calcState: ${waterProfile.calculateStateTime.toFixed(2)}ms (${waterProfile.calculateStateCalls} calls, ${hitRate.toFixed(0)}% cache hit)</span><br>`;
      if (actualComputations > 0) {
        html += `<span style="font-size: 10px; margin-left: 8px;">  computed: ${actualComputations} (${(avgStateTime * 1000).toFixed(1)}µs avg)</span><br>`;
      }
      if (waterProfile.pressureFeedbackCalls > 0) {
        const avgFbTime = waterProfile.pressureFeedbackTime / waterProfile.pressureFeedbackCalls;
        html += `<span style="font-size: 10px; margin-left: 8px;">pressureFb: ${waterProfile.pressureFeedbackTime.toFixed(2)}ms (${waterProfile.pressureFeedbackCalls} calls, ${(avgFbTime * 1000).toFixed(1)}µs avg)</span><br>`;
      }
    }

    // Solver-level profiling (shows where ALL time goes)
    const solverProfile = getSolverProfile();
    if (solverProfile.frameCount > 0) {
      html += '<br><b>Solver breakdown:</b><br>';
      html += `<span style="font-size: 10px; margin-left: 8px;">total: ${solverProfile.totalFrameTime.toFixed(2)}ms</span><br>`;
      html += `<span style="font-size: 10px; margin-left: 8px;">operators: ${solverProfile.operatorApplyTime.toFixed(2)}ms</span><br>`;
      html += `<span style="font-size: 10px; margin-left: 8px;">cloneState: ${solverProfile.cloneStateTime.toFixed(2)}ms</span><br>`;
      html += `<span style="font-size: 10px; margin-left: 8px;">maxStableDt: ${solverProfile.maxStableDtTime.toFixed(2)}ms</span><br>`;
      html += `<span style="font-size: 10px; margin-left: 8px;">capture: ${solverProfile.captureStateTime.toFixed(2)}ms</span><br>`;
      html += `<span style="font-size: 10px; margin-left: 8px;">compare: ${solverProfile.compareStateTime.toFixed(2)}ms</span><br>`;
      html += `<span style="font-size: 10px; margin-left: 8px;">sanitize: ${solverProfile.sanitizeTime.toFixed(2)}ms</span><br>`;
      const otherClass = solverProfile.otherTime > 5 ? 'debug-warning' : 'debug-value';
      html += `<span style="font-size: 10px; margin-left: 8px;">other: <span class="${otherClass}">${solverProfile.otherTime.toFixed(2)}ms</span></span><br>`;
    }

    operatorsDiv.innerHTML = html;

    // Reset profiling accumulators after each display update
    resetFlowOperatorProfile();
    resetWaterPropsProfile();
    resetSolverProfile();
  }

  // Update perf info in status bar
  const perfInfo = document.getElementById('perf-info');
  if (perfInfo) {
    perfInfo.textContent = `dt: ${(metrics.actualDt * 1000).toFixed(2)}ms (${metrics.dtLimitedBy}) | wall: ${metrics.lastStepWallTime.toFixed(1)}ms | RT: ${metrics.realTimeRatio.toFixed(2)}x`;
    perfInfo.style.color = metrics.realTimeRatio < 0.5 ? '#f55' :
                          metrics.realTimeRatio < 0.95 ? '#fa0' : '#aaa';
  }
}

/**
 * Check for NaN/Infinity in simulation state and report issues
 */
export function checkSimulationHealth(state: SimulationState): { healthy: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check thermal nodes
  for (const [id, node] of state.thermalNodes) {
    if (!isFinite(node.temperature)) {
      issues.push(`Thermal node '${id}' has invalid temperature: ${node.temperature}`);
    }
    if (node.temperature < 0) {
      issues.push(`Thermal node '${id}' has negative temperature: ${node.temperature}`);
    }
    if (node.temperature > 10000) {
      issues.push(`Thermal node '${id}' has extreme temperature: ${node.temperature}K`);
    }
  }

  // Check flow nodes
  for (const [id, node] of state.flowNodes) {
    if (!isFinite(node.fluid.temperature)) {
      issues.push(`Flow node '${id}' has invalid temperature: ${node.fluid.temperature}`);
    }
    if (!isFinite(node.fluid.mass)) {
      issues.push(`Flow node '${id}' has invalid mass: ${node.fluid.mass}`);
    }
    if (node.fluid.mass <= 0) {
      issues.push(`Flow node '${id}' has non-positive mass: ${node.fluid.mass}`);
    }
    if (!isFinite(node.fluid.pressure)) {
      issues.push(`Flow node '${id}' has invalid pressure: ${node.fluid.pressure}`);
    }
  }

  // Check flow connections
  for (const conn of state.flowConnections) {
    if (!isFinite(conn.massFlowRate)) {
      issues.push(`Flow connection '${conn.id}' has invalid flow rate: ${conn.massFlowRate}`);
    }
    if (Math.abs(conn.massFlowRate) > 1e6) {
      issues.push(`Flow connection '${conn.id}' has extreme flow rate: ${conn.massFlowRate} kg/s`);
    }
  }

  // Check neutronics
  if (!isFinite(state.neutronics.power)) {
    issues.push(`Neutronics has invalid power: ${state.neutronics.power}`);
  }
  if (state.neutronics.power < 0) {
    issues.push(`Neutronics has negative power: ${state.neutronics.power}`);
  }

  return {
    healthy: issues.length === 0,
    issues,
  };
}

/**
 * Initialize debug panel toggle
 */
export function initDebugPanel(): void {
  const toggleBtn = document.getElementById('toggle-debug');
  const panel = document.getElementById('debug-panel');

  if (toggleBtn && panel) {
    toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      toggleBtn.textContent = panel.classList.contains('collapsed') ? 'Show' : 'Hide';
    });
  }

  // Component detail panel close button
  const closeBtn = document.getElementById('close-detail');
  const detailPanel = document.getElementById('component-detail');

  if (closeBtn && detailPanel) {
    closeBtn.addEventListener('click', () => {
      detailPanel.classList.add('hidden');
    });
  }
}

// Import Connection type for plant connections
import { Connection } from './types';

/**
 * Update the component detail panel with selected component info
 */
export function updateComponentDetail(
  componentId: string | null,
  plantState: { components: Map<string, unknown>; connections: Connection[] },
  simState: SimulationState
): void {
  const panel = document.getElementById('component-detail');
  const content = document.getElementById('component-detail-content');

  if (!panel || !content) return;

  if (!componentId) {
    panel.classList.add('hidden');
    return;
  }

  const component = plantState.components.get(componentId) as Record<string, unknown> | undefined;
  if (!component) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  let html = '';

  // Get simulation linkage from component properties
  const simNodeId = component.simNodeId as string | undefined;
  const simPumpId = component.simPumpId as string | undefined;
  const simValveId = component.simValveId as string | undefined;

  // Get linked flow node if available
  // First check explicit simNodeId, then fall back to looking up by component ID
  // (user-created components use component ID as node ID)
  let flowNode = simNodeId ? simState.flowNodes.get(simNodeId) : undefined;
  if (!flowNode) {
    flowNode = simState.flowNodes.get(componentId);
  }
  // For heat exchangers, check for primary node
  if (!flowNode && component.type === 'heatExchanger') {
    flowNode = simState.flowNodes.get(`${componentId}-primary`);
  }

  // ========== BASIC INFO ==========
  const label = component.label as string | undefined;
  if (label) {
    html += `<div class="detail-row"><span class="detail-label">Name:</span><span class="detail-value" style="color: #7f7; font-weight: bold;">${label}</span></div>`;
  }
  html += `<div class="detail-row"><span class="detail-label">ID:</span><span class="detail-value">${componentId}</span></div>`;
  html += `<div class="detail-row"><span class="detail-label">Type:</span><span class="detail-value">${component.type}</span></div>`;

  // Position and elevation
  const pos = component.position as { x: number; y: number } | undefined;
  if (pos) {
    html += `<div class="detail-row"><span class="detail-label">Position:</span><span class="detail-value">(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) m</span></div>`;
  }
  const elevation = component.elevation as number | undefined;
  html += `<div class="detail-row"><span class="detail-label">Elevation:</span><span class="detail-value">${elevation !== undefined ? elevation.toFixed(1) : '0'} m</span></div>`;

  // Container (what this component is inside)
  const containedBy = component.containedBy as string | undefined;
  if (containedBy) {
    const container = plantState.components.get(containedBy) as Record<string, unknown> | undefined;
    const containerLabel = container?.label as string || containedBy;
    html += `<div class="detail-row"><span class="detail-label">Inside:</span><span class="detail-value" style="color: #aaf;">${containerLabel}</span></div>`;
  } else {
    html += `<div class="detail-row"><span class="detail-label">Inside:</span><span class="detail-value" style="color: #888;">Atmosphere</span></div>`;
  }

  // ========== GEOMETRY ==========
  let volume: number | undefined;
  switch (component.type) {
    case 'vessel': {
      const innerDiam = component.innerDiameter as number;
      const height = component.height as number;
      const pressureRating = component.pressureRating as number | undefined;
      html += `<div class="detail-row"><span class="detail-label">Diameter:</span><span class="detail-value">${innerDiam?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Height:</span><span class="detail-value">${height?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Wall:</span><span class="detail-value">${((component.wallThickness as number) * 1000)?.toFixed(0)} mm</span></div>`;
      if (pressureRating !== undefined) {
        html += `<div class="detail-row"><span class="detail-label">Pressure Rating:</span><span class="detail-value">${pressureRating} bar</span></div>`;
      }
      volume = Math.PI * (innerDiam / 2) ** 2 * height;
      break;
    }
    case 'pipe': {
      const diam = component.diameter as number;
      const length = component.length as number;
      const pressureRating = component.pressureRating as number | undefined;
      html += `<div class="detail-row"><span class="detail-label">Length:</span><span class="detail-value">${length?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Diameter:</span><span class="detail-value">${(diam * 1000)?.toFixed(0)} mm</span></div>`;
      if (pressureRating !== undefined) {
        html += `<div class="detail-row"><span class="detail-label">Pressure Rating:</span><span class="detail-value">${pressureRating} bar</span></div>`;
      }
      volume = Math.PI * (diam / 2) ** 2 * length;
      break;
    }
    case 'tank': {
      const width = component.width as number;
      const height = component.height as number;
      const pressureRating = component.pressureRating as number | undefined;
      html += `<div class="detail-row"><span class="detail-label">Size:</span><span class="detail-value">${width?.toFixed(1)} x ${height?.toFixed(1)} m</span></div>`;
      if (pressureRating !== undefined) {
        html += `<div class="detail-row"><span class="detail-label">Pressure Rating:</span><span class="detail-value">${pressureRating} bar</span></div>`;
      }
      // Assume cylindrical tank
      volume = Math.PI * (width / 2) ** 2 * height;
      break;
    }
    case 'heatExchanger': {
      html += `<div class="detail-row"><span class="detail-label">Size:</span><span class="detail-value">${(component.width as number)?.toFixed(1)} x ${(component.height as number)?.toFixed(1)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Tubes:</span><span class="detail-value">${component.tubeCount as number}</span></div>`;
      break;
    }
    case 'pump': {
      html += `<div class="detail-row"><span class="detail-label">Diameter:</span><span class="detail-value">${((component.diameter as number) * 1000)?.toFixed(0)} mm</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Rated Head:</span><span class="detail-value">${(component.ratedHead as number)?.toFixed(1)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Rated Flow:</span><span class="detail-value">${(component.ratedFlow as number)?.toFixed(0)} kg/s</span></div>`;
      const orientation = (component.orientation as string) || 'left-right';
      html += `<div class="detail-row"><span class="detail-label">Orientation:</span><span class="detail-value">${orientation}</span></div>`;

      // Get pump simulation state
      const pumpState = simState.components.pumps.get(componentId);
      if (pumpState) {
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Operating Status</div>';
        html += `<div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value" style="color: ${pumpState.running ? '#7f7' : '#f77'};">${pumpState.running ? 'RUNNING' : 'STOPPED'}</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Speed:</span><span class="detail-value">${(pumpState.effectiveSpeed * 100).toFixed(1)}%</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Head:</span><span class="detail-value">${(pumpState.ratedHead * pumpState.effectiveSpeed).toFixed(1)} m</span></div>`;

        // Calculate and show pressure rise using actual fluid density
        if (pumpState.connectedFlowPath && pumpState.effectiveSpeed > 0) {
          const conn = simState.flowConnections.find(c => c.id === pumpState.connectedFlowPath);
          if (conn) {
            const flowIsForward = conn.massFlowRate >= 0;
            const upstreamId = flowIsForward ? conn.fromNodeId : conn.toNodeId;
            const upstreamNode = simState.flowNodes.get(upstreamId);
            const rho = upstreamNode ? upstreamNode.fluid.mass / upstreamNode.volume : 750;
            const g = 9.81;
            const dP_pump = pumpState.effectiveSpeed * pumpState.ratedHead * rho * g;
            html += `<div class="detail-row"><span class="detail-label">Pressure Rise:</span><span class="detail-value" style="color: #8af;">+${(dP_pump/1e5).toFixed(2)} bar</span> <span style="color: #888; font-size: 9px;">(ρ=${rho.toFixed(0)} kg/m³)</span></div>`;
          }
        }

        html += `<div class="detail-row"><span class="detail-label">Efficiency:</span><span class="detail-value">${(pumpState.efficiency * 100).toFixed(1)}%</span></div>`;

        // Get current flow and fluid state from connected flow path
        if (pumpState.connectedFlowPath) {
          const conn = simState.flowConnections.find(c => c.id === pumpState.connectedFlowPath);
          if (conn) {
            html += `<div class="detail-row"><span class="detail-label">Current Flow:</span><span class="detail-value">${Math.abs(conn.massFlowRate).toFixed(1)} kg/s</span></div>`;

            // Get fluid state from upstream node (suction side)
            const upstreamNode = simState.flowNodes.get(conn.fromNodeId);
            if (upstreamNode) {
              html += '</div>';
              html += '<div class="detail-section">';
              html += '<div class="detail-section-title">Fluid (Suction)</div>';
              html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(upstreamNode.fluid.temperature - 273).toFixed(0)} C</span></div>`;
              html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(upstreamNode.fluid.pressure / 1e5).toFixed(2)} bar</span></div>`;
              const phaseDisplay = upstreamNode.fluid.phase === 'two-phase'
                ? `two-phase (${(upstreamNode.fluid.quality * 100).toFixed(1)}% quality)`
                : upstreamNode.fluid.phase;
              html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${phaseDisplay}</span></div>`;
            }
          }
        }
        html += '</div>';
      }
      break;
    }
    case 'valve': {
      html += `<div class="detail-row"><span class="detail-label">Diameter:</span><span class="detail-value">${((component.diameter as number) * 1000)?.toFixed(0)} mm</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Type:</span><span class="detail-value">${component.valveType as string}</span></div>`;
      break;
    }
    case 'turbine':
    case 'condenser': {
      html += `<div class="detail-row"><span class="detail-label">Size:</span><span class="detail-value">${(component.width as number)?.toFixed(1)} x ${(component.height as number)?.toFixed(1)} m</span></div>`;
      break;
    }
    case 'reactorVessel': {
      const innerDiam = component.innerDiameter as number;
      const height = component.height as number;
      const wallThickness = component.wallThickness as number;
      const pressureRating = component.pressureRating as number | undefined;
      // barrelDiameter is center-line diameter (to middle of barrel wall)
      const barrelCenterDiam = component.barrelDiameter as number;
      const barrelThickness = component.barrelThickness as number;
      const barrelOuterDiam = barrelCenterDiam + barrelThickness / 2;
      const barrelInnerDiam = barrelCenterDiam - barrelThickness / 2;
      const barrelTopGap = component.barrelTopGap as number;
      const barrelBottomGap = component.barrelBottomGap as number;

      // Get volumes - new architecture uses coreBarrelId, legacy uses insideBarrelId/outsideBarrelId
      const coreBarrelId = component.coreBarrelId as string | undefined;
      const legacyInsideId = component.insideBarrelId as string | undefined;
      const legacyOutsideId = component.outsideBarrelId as string | undefined;

      let coreVolume = 0;
      let downcomerVolume = 0;

      if (coreBarrelId) {
        // New architecture: core barrel is separate component, vessel is downcomer
        // Try simulation nodes first (runtime), fall back to plant component volumes (construction mode)
        const coreBarrelNode = simState?.flowNodes.get(coreBarrelId);
        const vesselNode = simState?.flowNodes.get(componentId);
        if (coreBarrelNode && vesselNode) {
          coreVolume = coreBarrelNode.volume ?? 0;
          downcomerVolume = vesselNode.volume ?? 0;
        } else {
          // Construction mode: read from plant component's stored volumes
          const coreBarrelComp = plantState?.components.get(coreBarrelId) as Record<string, unknown> | undefined;
          coreVolume = (coreBarrelComp?.volume as number) ?? 0;
          downcomerVolume = (component.volume as number) ?? 0;
        }
      } else if (legacyInsideId && legacyOutsideId) {
        // Legacy architecture: insideBarrel is core, outsideBarrel is downcomer
        const insideBarrelComp = plantState.components.get(legacyInsideId) as Record<string, unknown> | undefined;
        const outsideBarrelComp = plantState.components.get(legacyOutsideId) as Record<string, unknown> | undefined;
        coreVolume = (insideBarrelComp?.volume as number) ?? 0;
        downcomerVolume = (outsideBarrelComp?.volume as number) ?? 0;
      }
      const totalVolume = coreVolume + downcomerVolume;

      html += `<div class="detail-row"><span class="detail-label">Vessel Inner Dia:</span><span class="detail-value">${innerDiam?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Vessel Height:</span><span class="detail-value">${height?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Wall Thickness:</span><span class="detail-value">${(wallThickness * 1000)?.toFixed(0)} mm</span></div>`;
      if (pressureRating !== undefined) {
        html += `<div class="detail-row"><span class="detail-label">Pressure Rating:</span><span class="detail-value">${pressureRating} bar</span></div>`;
      }
      html += `<div class="detail-row"><span class="detail-label">Barrel Outer Dia:</span><span class="detail-value">${barrelOuterDiam?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Barrel Inner Dia:</span><span class="detail-value">${barrelInnerDiam?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Barrel Thickness:</span><span class="detail-value">${(barrelThickness * 1000)?.toFixed(0)} mm</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Barrel Gaps:</span><span class="detail-value">top: ${barrelTopGap?.toFixed(2)}m, btm: ${barrelBottomGap?.toFixed(2)}m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Core Volume:</span><span class="detail-value">${coreVolume.toFixed(2)} m³</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Downcomer Volume:</span><span class="detail-value">${downcomerVolume.toFixed(2)} m³</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Total Volume:</span><span class="detail-value">${totalVolume.toFixed(2)} m³</span></div>`;
      break;
    }
    case 'controller': {
      const connectedCoreId = component.connectedCoreId as string | undefined;
      const setpoints = component.setpoints as { highPower: number; lowPower: number; highFuelTemp: number; lowCoolantFlow: number };
      html += `<div class="detail-row"><span class="detail-label">Type:</span><span class="detail-value">SCRAM Controller</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Connected To:</span><span class="detail-value" style="color: ${connectedCoreId ? '#7f7' : '#f77'};">${connectedCoreId || 'None'}</span></div>`;
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Scram Setpoints</div>';
      html += `<div class="detail-row"><span class="detail-label">High Power:</span><span class="detail-value">${setpoints?.highPower ?? 125}%</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Low Power:</span><span class="detail-value">${setpoints?.lowPower ?? 12}%</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">High Fuel Temp:</span><span class="detail-value">${Math.round((setpoints?.highFuelTemp ?? 0.95) * 100)}%</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Low Coolant Flow:</span><span class="detail-value">${setpoints?.lowCoolantFlow ?? 10} kg/s</span></div>`;
      html += '</div>';
      break;
    }
    case 'switchyard': {
      const connectedGenId = component.connectedGeneratorId as string | undefined;
      const transmissionVoltage = component.transmissionVoltage as number;
      const offsiteLines = component.offsiteLines as number;
      const transformerRating = component.transformerRating as number;
      const reliabilityClass = component.reliabilityClass as string;

      html += `<div class="detail-row"><span class="detail-label">Transmission:</span><span class="detail-value">${transmissionVoltage} kV</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Offsite Lines:</span><span class="detail-value">${offsiteLines}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Transformer:</span><span class="detail-value">${transformerRating} MW</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Reliability:</span><span class="detail-value">${reliabilityClass}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Generator:</span><span class="detail-value" style="color: ${connectedGenId ? '#7f7' : '#f77'};">${connectedGenId || 'None'}</span></div>`;

      // Show MW to grid if connected to a generator
      // Note: Currently shows total turbine power, not per-generator
      if (connectedGenId && plantState) {
        const generator = plantState.components.get(connectedGenId) as Record<string, unknown> | undefined;
        if (generator && generator.type === 'turbine-generator') {
          // Get power from turbine-condenser state (simulation calculated value)
          const tcState = getTurbineCondenserState();
          const mwToGrid = tcState.turbinePower / 1e6;
          html += `<div class="detail-row"><span class="detail-label">MW to Grid:</span><span class="detail-value" style="color: ${mwToGrid > 0 ? '#4f4' : '#888'};">${mwToGrid.toFixed(1)} MW</span></div>`;
        }
      }
      break;
    }
  }

  // Volume - prefer simulation node volume, fall back to calculated
  // (Skip for reactor vessels since volumes are shown in geometry section)
  if (component.type !== 'reactorVessel') {
    const nodeVolume = flowNode?.volume;
    const displayVolume = nodeVolume ?? volume;
    if (displayVolume !== undefined) {
      html += `<div class="detail-row"><span class="detail-label">Volume:</span><span class="detail-value">${displayVolume.toFixed(2)} m³</span></div>`;
    }
  }

  // ========== CURRENT FLUID CONDITIONS (from simulation) ==========
  // Helper to determine if a component has distinct liquid/vapor spaces
  const hasSeparatePhases = (type: string): boolean => {
    return type === 'tank' || type === 'vessel' || type === 'heatExchanger';
  };

  // Reactor vessel shows two fluid sections (core region and downcomer)
  if (component.type === 'reactorVessel') {
    // New architecture: coreBarrelId points to core, vessel itself is downcomer
    // Legacy: insideBarrelId is core, outsideBarrelId is downcomer
    const coreBarrelId = component.coreBarrelId as string | undefined;
    const legacyInsideId = component.insideBarrelId as string | undefined;
    const legacyOutsideId = component.outsideBarrelId as string | undefined;

    let coreNode: typeof flowNode | undefined;
    let downcomerNode: typeof flowNode | undefined;

    if (coreBarrelId) {
      // New architecture
      coreNode = simState.flowNodes.get(coreBarrelId);
      downcomerNode = simState.flowNodes.get(componentId);
    } else if (legacyInsideId && legacyOutsideId) {
      // Legacy architecture
      coreNode = simState.flowNodes.get(legacyInsideId);
      downcomerNode = simState.flowNodes.get(legacyOutsideId);
    }

    if (coreNode) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Core Region</div>';
      html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(coreNode.fluid.temperature - 273).toFixed(0)} C</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(coreNode.fluid.pressure / 1e5).toFixed(2)} bar</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${coreNode.fluid.phase}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Mass:</span><span class="detail-value">${coreNode.fluid.mass.toFixed(0)} kg</span></div>`;
      if (coreNode.fluid.phase === 'two-phase') {
        html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">${(coreNode.fluid.quality * 100).toFixed(1)}%</span></div>`;
      }
      html += '</div>';
    }

    if (downcomerNode) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Downcomer</div>';
      html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(downcomerNode.fluid.temperature - 273).toFixed(0)} C</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(downcomerNode.fluid.pressure / 1e5).toFixed(2)} bar</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${downcomerNode.fluid.phase}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Mass:</span><span class="detail-value">${downcomerNode.fluid.mass.toFixed(0)} kg</span></div>`;
      if (downcomerNode.fluid.phase === 'two-phase') {
        html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">${(downcomerNode.fluid.quality * 100).toFixed(1)}%</span></div>`;
      }
      html += '</div>';
    }

    // If no simulation nodes found, show a note
    if (!coreNode && !downcomerNode) {
      html += '<div class="detail-section">';
      html += '<div style="font-size: 10px; color: #888; font-style: italic;">Run simulation to see fluid state</div>';
      html += '</div>';
    }
  } else if (component.type === 'heatExchanger') {
  // Heat exchanger shows two fluid sections (primary & secondary)
    // Find both simulation nodes (tube side and shell side)
    // Convention: simNodeId is tube side (primary), look for shell side
    const tubeNode = flowNode;
    // Find shell side node - it would be named with shell/secondary suffix
    let shellNode: typeof flowNode | undefined;
    for (const [nodeId, node] of simState.flowNodes) {
      if (nodeId.includes(componentId) && nodeId !== simNodeId &&
          (nodeId.includes('shell') || nodeId.includes('secondary'))) {
        shellNode = node;
        break;
      }
    }

    if (tubeNode) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Primary (Tube Side)</div>';
      html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(tubeNode.fluid.temperature - 273).toFixed(0)} C</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(tubeNode.fluid.pressure / 1e5).toFixed(2)} bar</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${tubeNode.fluid.phase}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Mass:</span><span class="detail-value">${tubeNode.fluid.mass.toFixed(0)} kg</span></div>`;
      html += '</div>';
    }

    if (shellNode) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Secondary (Shell Side)</div>';
      html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(shellNode.fluid.temperature - 273).toFixed(0)} C</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(shellNode.fluid.pressure / 1e5).toFixed(2)} bar</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${shellNode.fluid.phase}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Mass:</span><span class="detail-value">${shellNode.fluid.mass.toFixed(0)} kg</span></div>`;
      // Show fill level only for two-phase shell side
      if (shellNode.fluid.phase === 'two-phase') {
        html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">${(shellNode.fluid.quality * 100).toFixed(1)}%</span></div>`;
      }
      html += '</div>';
    }
  } else if (flowNode) {
    // Standard single-fluid component
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Current Fluid State</div>';
    html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(flowNode.fluid.temperature - 273).toFixed(0)} C</span></div>`;

    // Show pressure - if NCGs present, show both steam partial pressure and total pressure
    // NOTE: flowNode.fluid.pressure is TOTAL pressure (steam + NCG) from the constraint operator
    const totalPressure = flowNode.fluid.pressure;
    const ncgMoles = flowNode.fluid.ncg ? totalMoles(flowNode.fluid.ncg) : 0;
    if (ncgMoles > 0) {
      const ncgPressure = (ncgMoles * R_GAS * flowNode.fluid.temperature) / flowNode.volume;
      const steamPressure = Math.max(0, totalPressure - ncgPressure);
      html += `<div class="detail-row"><span class="detail-label">Total Pressure:</span><span class="detail-value" style="color: #ff7;">${formatPressure(totalPressure / 1e5)} bar</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Steam P:</span><span class="detail-value">${formatPressure(steamPressure / 1e5)} bar</span></div>`;
    } else {
      html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${formatPressure(totalPressure / 1e5)} bar</span></div>`;
    }

    html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${flowNode.fluid.phase}</span></div>`;
    html += `<div class="detail-row"><span class="detail-label">Mass:</span><span class="detail-value">${flowNode.fluid.mass.toFixed(0)} kg</span></div>`;

    // Calculate specific energy of steam only (subtract NCG energy contribution)
    let steamEnergy = flowNode.fluid.internalEnergy;
    if (ncgMoles > 0 && flowNode.fluid.ncg) {
      const Cv_ncg = mixtureCv(flowNode.fluid.ncg);
      const ncgEnergy = ncgMoles * Cv_ncg * flowNode.fluid.temperature;
      steamEnergy = Math.max(0, flowNode.fluid.internalEnergy - ncgEnergy);
    }
    const specificEnergy = flowNode.fluid.mass > 0 ? steamEnergy / flowNode.fluid.mass / 1000 : 0;
    html += `<div class="detail-row"><span class="detail-label">Spec. Energy:</span><span class="detail-value">${specificEnergy.toFixed(0)} kJ/kg</span></div>`;

    // Show fill level / quality only for two-phase in containers that can have separate phases
    if (flowNode.fluid.phase === 'two-phase' && hasSeparatePhases(component.type as string)) {
      html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">${(flowNode.fluid.quality * 100).toFixed(1)}%</span></div>`;
    }

    // Show NCG (Non-Condensible Gas) information if present
    if (flowNode.fluid.ncg) {
      const ncgHtml = formatNcgPressures(flowNode.fluid.ncg, flowNode.fluid.temperature, flowNode.volume);
      if (ncgHtml) {
        html += ncgHtml;
      }
    }
    html += '</div>';
  }

  // ========== PUMP STATE ==========
  if (simPumpId) {
    const pump = simState.components.pumps.get(simPumpId);
    if (pump) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Pump Control</div>';
      html += `<div class="detail-row"><span class="detail-label">Running:</span><span class="detail-value" style="color: ${pump.running ? '#7f7' : '#f55'};">${pump.running ? 'Yes' : 'No'}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Speed:</span><span class="detail-value">${(pump.speed * 100).toFixed(0)}%</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Effective:</span><span class="detail-value">${(pump.effectiveSpeed * 100).toFixed(0)}%</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Rated Head:</span><span class="detail-value">${pump.ratedHead} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Rated Flow:</span><span class="detail-value">${pump.ratedFlow} kg/s</span></div>`;

      // Calculate current pump pressure rise
      const flowPath = simState.flowConnections.find(c => c.id === pump.connectedFlowPath);
      if (flowPath && pump.effectiveSpeed > 0) {
        const flowIsForward = flowPath.massFlowRate >= 0;
        const upstreamId = flowIsForward ? flowPath.fromNodeId : flowPath.toNodeId;
        const upstreamNode = simState.flowNodes.get(upstreamId);
        const rho = upstreamNode ? upstreamNode.fluid.mass / upstreamNode.volume : 750;
        const g = 9.81;
        const dP_pump = pump.effectiveSpeed * pump.ratedHead * rho * g;
        const currentHead = pump.effectiveSpeed * pump.ratedHead;
        html += `<div class="detail-row"><span class="detail-label">Current Head:</span><span class="detail-value">${currentHead.toFixed(1)} m</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Pressure Rise:</span><span class="detail-value" style="color: #8af;">+${(dP_pump/1e5).toFixed(2)} bar</span> <span style="color: #888; font-size: 9px;">(ρ=${rho.toFixed(0)} kg/m³)</span></div>`;
      }
      html += '</div>';
    }
  }

  // ========== VALVE STATE ==========
  if (simValveId) {
    const valve = simState.components.valves.get(simValveId);
    if (valve) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Valve Control</div>';
      const posColor = valve.position > 0.9 ? '#7f7' : valve.position < 0.1 ? '#f55' : '#fa0';
      html += `<div class="detail-row"><span class="detail-label">Position:</span><span class="detail-value" style="color: ${posColor};">${(valve.position * 100).toFixed(0)}% open</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Fail Position:</span><span class="detail-value">${(valve.failPosition * 100).toFixed(0)}%</span></div>`;
      html += '</div>';
    }
  }

  // ========== FUEL STATE (for reactor vessels) ==========
  const fuelTemp = component.fuelTemperature as number | undefined;
  if (fuelTemp !== undefined) {
    const fuelMelt = (component.fuelMeltingPoint as number | undefined) ?? 2800;
    const fuelTempC = fuelTemp - 273;
    const fuelRatio = fuelTemp / fuelMelt;
    let fuelColor = '#7f7';  // green
    if (fuelRatio > 0.9) fuelColor = '#f55';  // red
    else if (fuelRatio > 0.7) fuelColor = '#fa0';  // orange
    else if (fuelRatio > 0.5) fuelColor = '#ff0';  // yellow

    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Fuel</div>';
    html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value" style="color: ${fuelColor};">${fuelTempC.toFixed(0)} C</span></div>`;
    html += `<div class="detail-row"><span class="detail-label">Margin:</span><span class="detail-value">${((1 - fuelRatio) * 100).toFixed(0)}% to melt</span></div>`;
    html += '</div>';
  }

  // ========== FLOW CONNECTIONS ==========
  // Find all flow connections involving this component's simulation node(s)
  const nodeIds = new Set<string>();
  if (simNodeId) nodeIds.add(simNodeId);
  // Also add component ID directly (user-created components use this)
  nodeIds.add(componentId);
  // For reactor vessels, include core barrel and vessel (new arch) or inside/outside barrel (legacy)
  if (component.type === 'reactorVessel') {
    const coreBarrelId = component.coreBarrelId as string | undefined;
    const legacyInsideId = component.insideBarrelId as string | undefined;
    const legacyOutsideId = component.outsideBarrelId as string | undefined;
    if (coreBarrelId) nodeIds.add(coreBarrelId);
    if (legacyInsideId) nodeIds.add(legacyInsideId);
    if (legacyOutsideId) nodeIds.add(legacyOutsideId);
  }
  // For HX, also check for primary/secondary/shell side nodes (only if simulation is running)
  if (simState.flowNodes) {
    for (const [nodeId] of simState.flowNodes) {
      if (nodeId.includes(componentId)) {
        nodeIds.add(nodeId);
      }
    }
  }
  // Show simulation connections if running AND they match this component, otherwise show plant connections
  const componentElev = elevation ?? 0;

  // Check if any simulation connections involve this component's nodes
  const matchingSimConnections = simState.flowConnections?.filter(conn =>
    nodeIds.has(conn.fromNodeId) || nodeIds.has(conn.toNodeId)
  ) ?? [];

  const hasMatchingSimConnections = matchingSimConnections.length > 0;

  // Helper to get component label
  const getComponentLabel = (compId: string): string => {
    const comp = plantState.components.get(compId) as Record<string, unknown> | undefined;
    return (comp?.label as string) || compId;
  };

  if (hasMatchingSimConnections) {
    // Collect simulation flow connections, deduplicating internal connections
    const seenConnIds = new Set<string>();
    const flowConnections: Array<{
      conn: typeof simState.flowConnections[0];
      isInternal: boolean;
      isFrom: boolean;
    }> = [];

    for (const conn of matchingSimConnections) {
      const fromInSet = nodeIds.has(conn.fromNodeId);
      const toInSet = nodeIds.has(conn.toNodeId);

      if (fromInSet && toInSet) {
        if (!seenConnIds.has(conn.id)) {
          seenConnIds.add(conn.id);
          flowConnections.push({ conn, isInternal: true, isFrom: true });
        }
      } else if (fromInSet) {
        if (!seenConnIds.has(conn.id)) {
          seenConnIds.add(conn.id);
          flowConnections.push({ conn, isInternal: false, isFrom: true });
        }
      } else if (toInSet) {
        if (!seenConnIds.has(conn.id)) {
          seenConnIds.add(conn.id);
          flowConnections.push({ conn, isInternal: false, isFrom: false });
        }
      }
    }

    if (flowConnections.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Flow Connections</div>';

      for (const { conn, isInternal, isFrom } of flowConnections) {
        const fromNode = simState.flowNodes.get(conn.fromNodeId);
        const toNode = simState.flowNodes.get(conn.toNodeId);
        const fromName = fromNode?.label || conn.fromNodeId;
        const toName = toNode?.label || conn.toNodeId;
        const actualFlow = conn.massFlowRate;

        if (isInternal) {
          const arrowDir = actualFlow >= 0 ? '→' : '←';
          const connElev = conn.fromElevation ?? conn.toElevation;
          let elevStr = '';
          if (connElev !== undefined) {
            elevStr = `@ ${connElev.toFixed(1)}m rel (${(componentElev + connElev).toFixed(1)}m abs)`;
          }
          const upstreamNode = simState.flowNodes.get(actualFlow >= 0 ? conn.fromNodeId : conn.toNodeId);
          const flowPhase = upstreamNode?.fluid.phase || 'unknown';

          html += `<div style="font-size: 10px; margin: 4px 0; padding: 3px; background: rgba(150,150,255,0.1); border-radius: 3px;">`;
          html += `<span style="color: #888;">Internal:</span> <span style="color: #9af;">${fromName} ${arrowDir} ${toName}</span>`;
          html += `<button class="delete-connection-btn" data-from="${conn.fromNodeId}" data-to="${conn.toNodeId}" style="float: right; font-size: 9px; padding: 1px 4px; background: #644; border: none; color: #aaa; cursor: pointer; border-radius: 2px; margin-left: 4px;">Del</button>`;
          html += `<button class="edit-connection-btn" data-conn-id="${conn.id}" style="float: right; font-size: 9px; padding: 1px 4px; background: #456; border: none; color: #aaa; cursor: pointer; border-radius: 2px;">Edit</button><br>`;
          html += `<span style="color: #888; margin-left: 12px;">${Math.abs(actualFlow).toFixed(1)} kg/s ${flowPhase}`;
          if (elevStr) html += `<br><span style="color: #6a8;">${elevStr}</span>`;
          html += `<br>Area: ${(conn.flowArea * 1e4).toFixed(1)} cm²</span></div>`;
        } else {
          const otherName = isFrom ? toName : fromName;
          const flowingOut = (isFrom && actualFlow >= 0) || (!isFrom && actualFlow < 0);
          const arrowDir = flowingOut ? '→' : '←';
          const flowColor = flowingOut ? '#7af' : '#fa7';
          const relElev = isFrom ? conn.fromElevation : conn.toElevation;
          let elevStr = '';
          if (relElev !== undefined) {
            elevStr = `@ ${relElev.toFixed(1)}m rel (${(componentElev + relElev).toFixed(1)}m abs)`;
          }
          const upstreamNode = simState.flowNodes.get(actualFlow >= 0 ? conn.fromNodeId : conn.toNodeId);
          const flowPhase = upstreamNode?.fluid.phase || 'unknown';

          html += `<div style="font-size: 10px; margin: 4px 0; padding: 3px; background: rgba(255,255,255,0.05); border-radius: 3px;">`;
          html += `<span style="color: ${flowColor};">${arrowDir}</span> ${otherName}`;
          html += `<button class="delete-connection-btn" data-from="${conn.fromNodeId}" data-to="${conn.toNodeId}" style="float: right; font-size: 9px; padding: 1px 4px; background: #644; border: none; color: #aaa; cursor: pointer; border-radius: 2px; margin-left: 4px;">Del</button>`;
          html += `<button class="edit-connection-btn" data-conn-id="${conn.id}" style="float: right; font-size: 9px; padding: 1px 4px; background: #456; border: none; color: #aaa; cursor: pointer; border-radius: 2px;">Edit</button><br>`;
          html += `<span style="color: #888; margin-left: 12px;">${Math.abs(actualFlow).toFixed(1)} kg/s ${flowPhase}`;
          if (elevStr) html += `<br><span style="color: #6a8;">${elevStr}</span>`;
          html += `<br>Area: ${(conn.flowArea * 1e4).toFixed(1)} cm²</span></div>`;
        }
      }
      html += '</div>';
    }
  } else {
    // Show plant connections (no matching simulation connections)
    const plantConnections = plantState.connections.filter(pc =>
      pc.fromComponentId === componentId || pc.toComponentId === componentId ||
      nodeIds.has(pc.fromComponentId) || nodeIds.has(pc.toComponentId)
    );

    // Deduplicate connections - use full port IDs to allow multiple connections between same components
    const seenConnections = new Set<string>();
    const uniqueConnections: Array<{ conn: Connection; isInternal: boolean; isFrom: boolean }> = [];

    for (const conn of plantConnections) {
      // Use port IDs (not just component IDs) to uniquely identify each connection
      const connKey = [conn.fromPortId, conn.toPortId].sort().join('|');
      const fromInSet = nodeIds.has(conn.fromComponentId) || conn.fromComponentId === componentId;
      const toInSet = nodeIds.has(conn.toComponentId) || conn.toComponentId === componentId;

      if (fromInSet && toInSet) {
        if (!seenConnections.has(connKey)) {
          seenConnections.add(connKey);
          uniqueConnections.push({ conn, isInternal: true, isFrom: true });
        }
      } else if (fromInSet) {
        if (!seenConnections.has(connKey)) {
          seenConnections.add(connKey);
          uniqueConnections.push({ conn, isInternal: false, isFrom: true });
        }
      } else if (toInSet) {
        if (!seenConnections.has(connKey)) {
          seenConnections.add(connKey);
          uniqueConnections.push({ conn, isInternal: false, isFrom: false });
        }
      }
    }

    if (uniqueConnections.length > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Flow Connections</div>';

      for (const { conn, isInternal, isFrom } of uniqueConnections) {
        const fromName = getComponentLabel(conn.fromComponentId);
        const toName = getComponentLabel(conn.toComponentId);
        const flowArea = conn.flowArea ?? 0.1;

        if (isInternal) {
          const connElev = conn.fromElevation ?? conn.toElevation;
          let elevStr = '';
          if (connElev !== undefined) {
            elevStr = `@ ${connElev.toFixed(1)}m rel (${(componentElev + connElev).toFixed(1)}m abs)`;
          }

          html += `<div style="font-size: 10px; margin: 4px 0; padding: 3px; background: rgba(150,150,255,0.1); border-radius: 3px;">`;
          html += `<span style="color: #888;">Internal:</span> <span style="color: #9af;">${fromName} ↔ ${toName}</span>`;
          html += `<button class="delete-connection-btn" data-from="${conn.fromComponentId}" data-to="${conn.toComponentId}" style="float: right; font-size: 9px; padding: 1px 4px; background: #644; border: none; color: #aaa; cursor: pointer; border-radius: 2px; margin-left: 4px;">Del</button>`;
          html += `<button class="edit-plant-connection-btn" data-from="${conn.fromComponentId}" data-to="${conn.toComponentId}" style="float: right; font-size: 9px; padding: 1px 4px; background: #456; border: none; color: #aaa; cursor: pointer; border-radius: 2px;">Edit</button><br>`;
          html += `<span style="color: #888; margin-left: 12px;"><span style="color: #666; font-style: italic;">(no flow yet)</span>`;
          if (elevStr) html += `<br><span style="color: #6a8;">${elevStr}</span>`;
          html += `<br>Area: ${(flowArea * 1e4).toFixed(1)} cm²</span></div>`;
        } else {
          const otherName = isFrom ? toName : fromName;
          const relElev = isFrom ? conn.fromElevation : conn.toElevation;
          let elevStr = '';
          if (relElev !== undefined) {
            elevStr = `@ ${relElev.toFixed(1)}m rel (${(componentElev + relElev).toFixed(1)}m abs)`;
          }

          html += `<div style="font-size: 10px; margin: 4px 0; padding: 3px; background: rgba(255,255,255,0.05); border-radius: 3px;">`;
          html += `<span style="color: #7af;">↔</span> ${otherName}`;
          html += `<button class="delete-connection-btn" data-from="${conn.fromComponentId}" data-to="${conn.toComponentId}" style="float: right; font-size: 9px; padding: 1px 4px; background: #644; border: none; color: #aaa; cursor: pointer; border-radius: 2px; margin-left: 4px;">Del</button>`;
          html += `<button class="edit-plant-connection-btn" data-from="${conn.fromComponentId}" data-to="${conn.toComponentId}" style="float: right; font-size: 9px; padding: 1px 4px; background: #456; border: none; color: #aaa; cursor: pointer; border-radius: 2px;">Edit</button><br>`;
          html += `<span style="color: #888; margin-left: 12px;"><span style="color: #666; font-style: italic;">(no flow yet)</span>`;
          if (elevStr) html += `<br><span style="color: #6a8;">${elevStr}</span>`;
          html += `<br>Area: ${(flowArea * 1e4).toFixed(1)} cm²</span></div>`;
        }
      }
      html += '</div>';
    }
  }

  // Add click handlers for connection buttons after setting innerHTML
  const setupConnectionButtonHandlers = () => {
    // Edit buttons for simulation connections
    document.querySelectorAll('.edit-connection-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const connId = (btn as HTMLElement).dataset.connId;
        if (connId && connectionEditCallback) {
          connectionEditCallback(connId);
        }
      });
    });

    // Edit buttons for plant connections (before simulation)
    document.querySelectorAll('.edit-plant-connection-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fromId = (btn as HTMLElement).dataset.from;
        const toId = (btn as HTMLElement).dataset.to;
        if (fromId && toId && plantConnectionEditCallback) {
          plantConnectionEditCallback(fromId, toId);
        }
      });
    });

    // Delete buttons
    document.querySelectorAll('.delete-connection-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fromId = (btn as HTMLElement).dataset.from;
        const toId = (btn as HTMLElement).dataset.to;
        if (fromId && toId && connectionDeleteCallback) {
          connectionDeleteCallback(fromId, toId);
        }
      });
    });
  };

  // ========== HEAT TRANSFER CONNECTIONS ==========
  // Find convection connections involving this component's nodes
  const heatConnections: Array<{
    thermalNodeId: string;
    flowNodeId: string;
    heatRate?: number;
  }> = [];

  for (const conv of simState.convectionConnections) {
    if (nodeIds.has(conv.flowNodeId)) {
      const heatRate = simState.energyDiagnostics?.heatTransferRates.get(conv.id);
      heatConnections.push({
        thermalNodeId: conv.thermalNodeId,
        flowNodeId: conv.flowNodeId,
        heatRate
      });
    }
  }

  // Also check if this is a thermal node
  const thermalNode = simState.thermalNodes.get(componentId);
  if (thermalNode) {
    for (const conv of simState.convectionConnections) {
      if (conv.thermalNodeId === componentId) {
        const heatRate = simState.energyDiagnostics?.heatTransferRates.get(conv.id);
        heatConnections.push({
          thermalNodeId: conv.thermalNodeId,
          flowNodeId: conv.flowNodeId,
          heatRate
        });
      }
    }
  }

  if (heatConnections.length > 0) {
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Heat Transfer</div>';

    for (const heat of heatConnections) {
      const thermal = simState.thermalNodes.get(heat.thermalNodeId);
      const flow = simState.flowNodes.get(heat.flowNodeId);
      const thermalName = thermal?.label || heat.thermalNodeId;
      const flowName = flow?.label || heat.flowNodeId;

      // Heat rate and direction
      const rate = heat.heatRate ?? 0;
      const rateStr = Math.abs(rate) >= 1e6
        ? `${(rate / 1e6).toFixed(2)} MW`
        : `${(rate / 1e3).toFixed(1)} kW`;
      const heatDir = rate >= 0 ? '→' : '←';
      const heatColor = rate >= 0 ? '#f80' : '#08f';

      html += `<div style="font-size: 10px; margin: 2px 0;">`;
      html += `<span style="color: ${heatColor};">${thermalName} ${heatDir} ${flowName}</span>: ${rateStr}`;
      html += `</div>`;
    }
    html += '</div>';
  }

  // ========== NO SIMULATION LINKAGE ==========
  if (!simNodeId && !simPumpId && !simValveId && heatConnections.length === 0) {
    html += '<div class="detail-section">';
    html += '<div style="font-size: 10px; color: #888; font-style: italic;">No simulation linkage</div>';
    html += '</div>';
  }

  // ========== EDIT/DELETE BUTTONS ==========
  html += '<div class="detail-section" style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #445;">';
  html += `<button id="edit-component-btn" style="background: #357; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 8px; font-size: 12px;">Edit</button>`;
  html += `<button id="delete-component-btn" style="background: #744; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px;">Delete</button>`;
  html += '</div>';

  content.innerHTML = html;

  // Set up button handlers
  const editBtn = document.getElementById('edit-component-btn');
  const deleteBtn = document.getElementById('delete-component-btn');

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      if (componentEditCallback) {
        componentEditCallback(componentId);
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      if (componentDeleteCallback) {
        componentDeleteCallback(componentId);
      }
    });
  }

  // Set up connection button handlers
  setupConnectionButtonHandlers();
}

// Callbacks for edit/delete actions
let componentEditCallback: ((componentId: string) => void) | null = null;
let componentDeleteCallback: ((componentId: string) => void) | null = null;
let connectionEditCallback: ((connectionId: string) => void) | null = null;
let plantConnectionEditCallback: ((fromId: string, toId: string) => void) | null = null;
let connectionDeleteCallback: ((fromId: string, toId: string) => void) | null = null;

/**
 * Set callback for when the Edit button is clicked
 */
export function setComponentEditCallback(callback: (componentId: string) => void): void {
  componentEditCallback = callback;
}

/**
 * Set callback for when the Delete button is clicked
 */
export function setComponentDeleteCallback(callback: (componentId: string) => void): void {
  componentDeleteCallback = callback;
}

/**
 * Set callback for when a connection Edit button is clicked (simulation running)
 */
export function setConnectionEditCallback(callback: (connectionId: string) => void): void {
  connectionEditCallback = callback;
}

/**
 * Set callback for when a plant connection Edit button is clicked (before simulation)
 */
export function setPlantConnectionEditCallback(callback: (fromId: string, toId: string) => void): void {
  plantConnectionEditCallback = callback;
}

/**
 * Set callback for when a connection Delete button is clicked
 */
export function setConnectionDeleteCallback(callback: (fromId: string, toId: string) => void): void {
  connectionDeleteCallback = callback;
}

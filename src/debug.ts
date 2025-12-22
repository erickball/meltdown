/**
 * Debug utilities for monitoring simulation state
 */

import {
  SimulationState,
  SolverMetrics,
  calculateWaterState,
  lookupCompressedLiquidDensity,
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
 * Update the debug panel with current simulation state
 */
export function updateDebugPanel(state: SimulationState, metrics: SolverMetrics): void {
  // Solver info
  const solverDiv = document.getElementById('debug-solver');
  if (solverDiv) {
    const rtRatioClass = metrics.realTimeRatio < 0.5 ? 'debug-danger' :
                        metrics.realTimeRatio < 0.95 ? 'debug-warning' : 'debug-value';
    solverDiv.innerHTML = `
      <span class="debug-label">Physics dt:</span> ${formatValue(metrics.currentDt * 1000, 'ms')}<br>
      <span class="debug-label">Wall time:</span> ${formatValue(metrics.lastStepWallTime, 'ms', 16, 33)}<br>
      <span class="debug-label">Subcycles:</span> ${formatValue(metrics.subcycleCount, '', 10, 100)}<br>
      <span class="debug-label">RT Ratio:</span> <span class="${rtRatioClass}">${metrics.realTimeRatio.toFixed(3)}</span><br>
      <span class="debug-label">Min dt used:</span> ${formatValue(metrics.minDtUsed * 1000, 'ms')}
    `;
  }

  // Neutronics
  const neutronicsDiv = document.getElementById('debug-neutronics');
  if (neutronicsDiv) {
    const n = state.neutronics;
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

  // Thermal nodes
  const thermalDiv = document.getElementById('debug-thermal');
  if (thermalDiv) {
    let html = '';
    for (const [id, node] of state.thermalNodes) {
      const tempC = node.temperature - 273;
      const pctOfMax = (node.temperature / node.maxTemperature) * 100;
      const tempClass = pctOfMax > 95 ? 'debug-danger' : pctOfMax > 80 ? 'debug-warning' : 'debug-value';
      html += `<span class="debug-label">${id}:</span> <span class="${tempClass}">${tempC.toFixed(0)}C</span> (${pctOfMax.toFixed(0)}% max)<br>`;
    }
    thermalDiv.innerHTML = html;
  }

  // Flow nodes
  const flowDiv = document.getElementById('debug-flow');
  if (flowDiv) {
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

      html += `<b>${id}</b>: `;
      html += `<span class="${tempClass}">${tempC.toFixed(0)}C</span>, `;
      html += `${pBar.toFixed(2)}bar, `;
      html += `<span class="${massClass}">${massKg.toFixed(0)}kg</span>, `;
      html += `${node.fluid.phase}`;
      if (node.fluid.phase === 'two-phase') {
        html += ` x=${(node.fluid.quality * 100).toFixed(1)}%`;
      }
      // Show density for debugging pressure deviation
      const rho = massKg / node.volume;
      html += ` ρ=${rho.toFixed(0)}`;
      html += '<br>';

      // Second line: phase-specific debug info
      const rawState = calculateWaterState(massKg, node.fluid.internalEnergy, node.volume);
      const rawP_bar = rawState.pressure / 1e5;
      const u_kJ = node.fluid.internalEnergy / massKg / 1000; // specific energy kJ/kg

      html += `<span style="font-size: 9px; color: #888; margin-left: 10px;">`;
      html += `u=${u_kJ.toFixed(0)}kJ/kg`;

      if (node.fluid.phase === 'two-phase') {
        // Two-phase: pressure is P_sat, no feedback model applies
        // Just show the raw water properties pressure for comparison
        html += ` (P<sub>sat</sub>=${rawP_bar.toFixed(1)}bar)`;
      } else if (node.fluid.phase === 'liquid') {
        // Liquid nodes: get P_base directly from simulation state (set by FluidStateOperator)
        const u_J = node.fluid.internalEnergy / massKg; // J/kg for lookup
        const P_displayed = node.fluid.pressure;

        // Get P_base from the actual simulation state
        const P_base = state.liquidBasePressures?.get(id);

        let P_base_bar: number;
        let dP_feedback_bar: number;
        let rho_expected = rho; // default if lookup fails

        if (P_base !== undefined) {
          P_base_bar = P_base / 1e5;
          // Look up expected density at this P_base
          const rho_at_Pbase = lookupCompressedLiquidDensity(P_base, u_J);
          if (rho_at_Pbase !== null) {
            rho_expected = rho_at_Pbase;
          }
          dP_feedback_bar = (P_displayed - P_base) / 1e5;
        } else {
          // Fallback: P_base not available (shouldn't happen in normal operation)
          P_base_bar = NaN; // Will display as 'err'
          dP_feedback_bar = NaN;
        }

        const deviationClass = Math.abs(dP_feedback_bar) > 50 ? 'debug-danger' :
                              Math.abs(dP_feedback_bar) > 10 ? 'debug-warning' : 'debug-value';

        html += `, ρ<sub>exp</sub>=${rho_expected.toFixed(0)}`;
        html += `, P<sub>base</sub>=${isNaN(P_base_bar) ? "err" : P_base_bar.toFixed(1) + "bar"}`;
        html += `, <span class="${deviationClass}">ΔP<sub>fb</sub>=${dP_feedback_bar >= 0 ? '+' : ''}${dP_feedback_bar.toFixed(1)}bar</span>`;
        html += ` (P<sub>wp</sub>=${rawP_bar.toFixed(1)}bar)`;
      } else {
        // Vapor: just show raw water properties pressure
        html += ` (P<sub>wp</sub>=${rawP_bar.toFixed(1)}bar)`;
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
      html += `, P<sub>sat</sub>(T)=${(P_sat_T/1e5).toFixed(1)}bar`;
      html += `, <span class="${distClass}">Δsat=${satDist.distance >= 0 ? '+' : ''}${satDist.distance.toFixed(1)}</span>`;
      html += `</span><br>`;
    }



    // Also show flow rates with target flows
    html += '<br><b>Flow connections:</b><br>';
    for (const conn of state.flowConnections) {
      const flowClass = !isFinite(conn.massFlowRate) ? 'debug-danger' :
                       Math.abs(conn.massFlowRate) < 1 ? 'debug-warning' : 'debug-value';
      const targetFlow = conn.targetFlowRate ?? 0;
      const targetClass = !isFinite(targetFlow) ? 'debug-danger' :
                         Math.sign(targetFlow) !== Math.sign(conn.massFlowRate) && Math.abs(conn.massFlowRate) > 100 ? 'debug-warning' : 'debug-value';
      html += `${conn.fromNodeId} -> ${conn.toNodeId}: <span class="${flowClass}">${conn.massFlowRate.toFixed(0)}</span>`;
      html += ` <span style="color: #888;">→</span> <span class="${targetClass}">${targetFlow.toFixed(0)}</span> kg/s`;

      // Show pump head if there's a pump on this connection
      for (const [pumpId, pump] of state.components.pumps) {
        if (pump.connectedFlowPath === conn.id && pump.effectiveSpeed > 0) {
          // Calculate pump head: dP_pump = effectiveSpeed * ratedHead * rho * g
          // effectiveSpeed is maintained by FlowOperator.updatePumpSpeeds()
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

    // Show total mass for conservation check
    let totalMass = 0;
    let totalEnergy = 0;
    for (const [, node] of state.flowNodes) {
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
      html += `<span style="font-size: 10px; margin-left: 8px;">targetFlows: ${flowProfile.computeTargetFlows.toFixed(2)}ms</span><br>`;
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
    perfInfo.textContent = `dt: ${(metrics.currentDt * 1000).toFixed(2)}ms | wall: ${metrics.lastStepWallTime.toFixed(1)}ms | RT: ${metrics.realTimeRatio.toFixed(2)}x`;
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

/**
 * Update the component detail panel with selected component info
 */
export function updateComponentDetail(
  componentId: string | null,
  plantState: { components: Map<string, unknown> },
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

  // Basic info - show label prominently if available
  const label = component.label as string | undefined;
  if (label) {
    html += `<div class="detail-row"><span class="detail-label">Name:</span><span class="detail-value" style="color: #7f7; font-weight: bold;">${label}</span></div>`;
  }
  html += `<div class="detail-row"><span class="detail-label">ID:</span><span class="detail-value">${componentId}</span></div>`;
  html += `<div class="detail-row"><span class="detail-label">Type:</span><span class="detail-value">${component.type}</span></div>`;

  // Position
  const pos = component.position as { x: number; y: number } | undefined;
  if (pos) {
    html += `<div class="detail-row"><span class="detail-label">Position:</span><span class="detail-value">(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) m</span></div>`;
  }

  // Type-specific info
  switch (component.type) {
    case 'vessel': {
      html += `<div class="detail-row"><span class="detail-label">Diameter:</span><span class="detail-value">${(component.innerDiameter as number)?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Height:</span><span class="detail-value">${(component.height as number)?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Wall:</span><span class="detail-value">${((component.wallThickness as number) * 1000)?.toFixed(0)} mm</span></div>`;
      // Fuel info if present
      const fuelTemp = component.fuelTemperature as number | undefined;
      const fuelMelt = component.fuelMeltingPoint as number | undefined ?? 2800;
      if (fuelTemp !== undefined) {
        const fuelTempC = fuelTemp - 273;
        const fuelRatio = fuelTemp / fuelMelt;
        let fuelColor = '#7f7';  // green
        if (fuelRatio > 0.9) fuelColor = '#f55';  // red
        else if (fuelRatio > 0.7) fuelColor = '#fa0';  // orange
        else if (fuelRatio > 0.5) fuelColor = '#ff0';  // yellow
        html += `<div class="detail-row"><span class="detail-label">Fuel Temp:</span><span class="detail-value" style="color: ${fuelColor};">${fuelTempC.toFixed(0)} C</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Fuel Margin:</span><span class="detail-value">${((1 - fuelRatio) * 100).toFixed(0)}% to melt</span></div>`;
      }
      break;
    }
    case 'pipe': {
      html += `<div class="detail-row"><span class="detail-label">Length:</span><span class="detail-value">${(component.length as number)?.toFixed(2)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Diameter:</span><span class="detail-value">${((component.diameter as number) * 1000)?.toFixed(0)} mm</span></div>`;
      break;
    }
    case 'pump': {
      const pumpRunning = component.running as boolean;
      const pumpSpeed = component.speed as number;
      html += `<div class="detail-row"><span class="detail-label">Running:</span><span class="detail-value" style="color: ${pumpRunning ? '#7f7' : '#f55'};">${pumpRunning ? 'Yes' : 'No'}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Speed:</span><span class="detail-value">${(pumpSpeed * 100)?.toFixed(0)}%</span></div>`;
      break;
    }
    case 'valve': {
      const opening = component.opening as number;
      html += `<div class="detail-row"><span class="detail-label">Opening:</span><span class="detail-value">${(opening * 100)?.toFixed(0)}% open</span></div>`;
      break;
    }
    case 'heatExchanger': {
      html += `<div class="detail-row"><span class="detail-label">Size:</span><span class="detail-value">${(component.width as number)?.toFixed(1)} x ${(component.height as number)?.toFixed(1)} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Tubes:</span><span class="detail-value">${component.tubeCount as number}</span></div>`;

      // Primary fluid (tube side)
      const primaryFluid = component.primaryFluid as { temperature: number; pressure: number; phase: string; quality?: number } | undefined;
      if (primaryFluid) {
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Primary (Tube Side)</div>';
        html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(primaryFluid.temperature - 273).toFixed(0)} C</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(primaryFluid.pressure / 1e5).toFixed(1)} bar</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${primaryFluid.phase}</span></div>`;
        // Always show quality line to prevent layout shift
        if (primaryFluid.phase === 'two-phase' && primaryFluid.quality !== undefined) {
          html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">${(primaryFluid.quality * 100).toFixed(0)}%</span></div>`;
        } else {
          html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">-</span></div>`;
        }
        html += '</div>';
      }

      // Secondary fluid (shell side)
      const secondaryFluid = component.secondaryFluid as { temperature: number; pressure: number; phase: string; quality?: number } | undefined;
      if (secondaryFluid) {
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Secondary (Shell Side)</div>';
        html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(secondaryFluid.temperature - 273).toFixed(0)} C</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(secondaryFluid.pressure / 1e5).toFixed(1)} bar</span></div>`;
        html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${secondaryFluid.phase}</span></div>`;
        // Always show quality line to prevent layout shift
        if (secondaryFluid.phase === 'two-phase' && secondaryFluid.quality !== undefined) {
          html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">${(secondaryFluid.quality * 100).toFixed(0)}%</span></div>`;
        } else {
          html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">-</span></div>`;
        }
        html += '</div>';
      }
      break;
    }
    case 'tank': {
      html += `<div class="detail-row"><span class="detail-label">Size:</span><span class="detail-value">${(component.width as number)?.toFixed(1)} x ${(component.height as number)?.toFixed(1)} m</span></div>`;
      const fillLevel = component.fillLevel as number | undefined;
      if (fillLevel !== undefined) {
        html += `<div class="detail-row"><span class="detail-label">Fill Level:</span><span class="detail-value">${(fillLevel * 100).toFixed(0)}%</span></div>`;
      }
      break;
    }
  }

  // Get simulation linkage from component properties
  const simNodeId = component.simNodeId as string | undefined;

  // Fluid info - only show if no simulation linkage (otherwise simulation section shows it)
  const fluid = component.fluid as { temperature: number; pressure: number; phase: string } | undefined;
  if (fluid && !simNodeId && component.type !== 'heatExchanger') {
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Fluid</div>';
    html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(fluid.temperature - 273).toFixed(0)} C</span></div>`;
    html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(fluid.pressure / 1e5).toFixed(1)} bar</span></div>`;
    html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${fluid.phase}</span></div>`;
    html += '</div>';
  }
  const simPumpId = component.simPumpId as string | undefined;
  const simValveId = component.simValveId as string | undefined;

  // Show linked simulation flow node (skip for HX since we show primary/secondary above,
  // and skip for pumps since they show flow path info separately)
  if (simNodeId && component.type !== 'heatExchanger' && !simPumpId) {
    const flowNode = simState.flowNodes.get(simNodeId);
    if (flowNode) {
      html += '<div class="detail-section">';
      html += `<div class="detail-section-title">Simulation: ${flowNode.label || simNodeId}</div>`;
      html += `<div class="detail-row"><span class="detail-label">Temperature:</span><span class="detail-value">${(flowNode.fluid.temperature - 273).toFixed(0)} C</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Pressure:</span><span class="detail-value">${(flowNode.fluid.pressure / 1e5).toFixed(2)} bar</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Mass:</span><span class="detail-value">${flowNode.fluid.mass.toFixed(0)} kg</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Energy:</span><span class="detail-value">${(flowNode.fluid.internalEnergy / 1.0e3 / flowNode.fluid.mass).toFixed(0)
} kJ/kg</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Phase:</span><span class="detail-value">${flowNode.fluid.phase}</span></div>`;
      // Always show quality line to prevent layout shift
      if (flowNode.fluid.phase === 'two-phase') {
        html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">${(flowNode.fluid.quality * 100).toFixed(0)}%</span></div>`;
      } else {
        html += `<div class="detail-row"><span class="detail-label">Quality:</span><span class="detail-value">-</span></div>`;
      }
      html += '</div>';

      // Show flow connections for this node
      const connectedPaths: string[] = [];
      for (const conn of simState.flowConnections) {
        if (conn.fromNodeId === simNodeId || conn.toNodeId === simNodeId) {
          const direction = conn.fromNodeId === simNodeId ? '→' : '←';
          const otherNodeId = conn.fromNodeId === simNodeId ? conn.toNodeId : conn.fromNodeId;
          const otherNode = simState.flowNodes.get(otherNodeId);
          const otherName = otherNode?.label || otherNodeId;
          const flowDir = conn.massFlowRate >= 0 ? '' : ' (reverse)';
          connectedPaths.push(`${direction} ${otherName}: ${Math.abs(conn.massFlowRate).toFixed(1)} kg/s${flowDir}`);
        }
      }

      if (connectedPaths.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Flow Connections</div>';
        for (const path of connectedPaths) {
          html += `<div style="font-size: 10px; color: #aaa;">${path}</div>`;
        }
        html += '</div>';
      }
    }
  }

  // Show linked pump state
  if (simPumpId) {
    const pump = simState.components.pumps.get(simPumpId);
    if (pump) {
      html += '<div class="detail-section">';
      html += `<div class="detail-section-title">Pump: ${simPumpId}</div>`;
      html += `<div class="detail-row"><span class="detail-label">Running:</span><span class="detail-value" style="color: ${pump.running ? '#7f7' : '#f55'};">${pump.running ? 'Yes' : 'No'}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Speed:</span><span class="detail-value">${(pump.speed * 100).toFixed(0)}%</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Rated Head:</span><span class="detail-value">${pump.ratedHead} m</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Rated Flow:</span><span class="detail-value">${pump.ratedFlow} kg/s</span></div>`;
      html += '</div>';

      // Calculate current pump head (using effectiveSpeed from FlowOperator)
      const flowPath = simState.flowConnections.find(c => c.id === pump.connectedFlowPath);
      if (flowPath && pump.effectiveSpeed > 0) {
        // Use density of upstream node based on actual flow direction
        const flowIsForward = flowPath.massFlowRate >= 0;
        const upstreamId = flowIsForward ? flowPath.fromNodeId : flowPath.toNodeId;
        const upstreamNode = simState.flowNodes.get(upstreamId);
        const rho = upstreamNode ? upstreamNode.fluid.mass / upstreamNode.volume : 750;
        const g = 9.81;
        const dP_pump = pump.effectiveSpeed * pump.ratedHead * rho * g;
        html += `<div class="detail-row"><span class="detail-label">Current Head:</span><span class="detail-value" style="color: #8af;">+${(dP_pump/1e5).toFixed(2)} bar</span></div>`;
      }

      // Show the flow path this pump drives
      if (flowPath) {
        const fromNode = simState.flowNodes.get(flowPath.fromNodeId);
        const toNode = simState.flowNodes.get(flowPath.toNodeId);
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Flow Path</div>';
        html += `<div style="font-size: 10px; color: #aaa;">${fromNode?.label || flowPath.fromNodeId} → ${toNode?.label || flowPath.toNodeId}</div>`;
        html += `<div class="detail-row"><span class="detail-label">Flow Rate:</span><span class="detail-value">${flowPath.massFlowRate.toFixed(1)} kg/s</span></div>`;
        html += '</div>';
      }
    }
  }

  // Show linked valve state
  if (simValveId) {
    const valve = simState.components.valves.get(simValveId);
    if (valve) {
      html += '<div class="detail-section">';
      html += `<div class="detail-section-title">Valve: ${simValveId}</div>`;
      const posColor = valve.position > 0.9 ? '#7f7' : valve.position < 0.1 ? '#f55' : '#fa0';
      html += `<div class="detail-row"><span class="detail-label">Position:</span><span class="detail-value" style="color: ${posColor};">${(valve.position * 100).toFixed(0)}% open</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Fail Position:</span><span class="detail-value">${(valve.failPosition * 100).toFixed(0)}%</span></div>`;
      html += '</div>';

      // Show the flow path this valve controls
      const flowPath = simState.flowConnections.find(c => c.id === valve.connectedFlowPath);
      if (flowPath) {
        const fromNode = simState.flowNodes.get(flowPath.fromNodeId);
        const toNode = simState.flowNodes.get(flowPath.toNodeId);
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">Flow Path</div>';
        html += `<div style="font-size: 10px; color: #aaa;">${fromNode?.label || flowPath.fromNodeId} → ${toNode?.label || flowPath.toNodeId}</div>`;
        html += `<div class="detail-row"><span class="detail-label">Flow Rate:</span><span class="detail-value">${flowPath.massFlowRate.toFixed(1)} kg/s</span></div>`;
        html += '</div>';
      }
    }
  }

  // If no simulation linkage, show a note
  if (!simNodeId && !simPumpId && !simValveId) {
    html += '<div class="detail-section">';
    html += '<div style="font-size: 10px; color: #888; font-style: italic;">No simulation linkage</div>';
    html += '</div>';
  }

  content.innerHTML = html;
}

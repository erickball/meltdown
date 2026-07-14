import { PlantCanvas } from './render/canvas';
// Demo plant imports - uncomment createDemoPlant and createDemoReactor to load demo on startup
// import { createDemoPlant } from './plant/factory';
import pwrPresetData from './presets/pwr.json';
import bwrPresetData from './presets/bwr.json';
import htgrPresetData from './presets/htgr.json';
import twoLoopPresetData from './presets/two-loop.json';
import promptCritPresetData from './presets/prompt-crit.json';
import w4loopPresetData from './presets/w4loop.json';
import sboPresetData from './presets/sbo.json';
import meltdownDemoPresetData from './presets/meltdown-demo.json';
import { PlantState, PlantComponent, ReactorVesselComponent, ControllerComponent, PipeComponent } from './types';
import { GameLoop, ScramSetpoints } from './game';
import {
  // createDemoReactor,
  createSimulationFromPlant,
  setSimulationRandomSeed,
  serializeSimulationState,
  deserializeSimulationState,
  SimulationState,
  SolverMetrics,
  setWaterPropsDebug,
  getWaterPropsDebugLog,
  calculateWaterState,
  enableCalculationDebug,
  getCalculationDebugLog,
  preloadWaterProperties,
  setSeparationDebug,
  getTurbineCondenserState,
} from './simulation';
import { updateDebugPanel, initDebugPanel, updateComponentDetail, updateCoreDamageIndicator, setComponentEditCallback, setCoreEditCallback, setComponentMoveCallback, setComponentDeleteCallback, setConnectionEditCallback, setPlantConnectionEditCallback, setConnectionDeleteCallback } from './debug';
import { GameModeManager } from './game-mode';
import { ComponentDialog, ComponentConfig, componentDefinitions } from './construction/component-config';
import { ConstructionManager } from './construction/construction-manager';
import { ConnectionDialog, ConnectionConfig, ConnectionEditResult } from './construction/connection-dialog';
import { estimatePlantComponentCost, formatCost } from './construction/cost-estimation';
import { JackManager } from './jack/jack-manager';

// Throttle debug panel updates to reduce flickering
const DEBUG_UPDATE_INTERVAL_MS = 250; // Update ~4 times per second
let lastDebugUpdate = 0;

// ============================================================================
// Settings Persistence
// ============================================================================
const SETTINGS_KEY = 'meltdown_settings';

interface AppSettings {
  deterministicMode?: boolean;
}

function loadSettings(): AppSettings {
  try {
    const json = localStorage.getItem(SETTINGS_KEY);
    if (json) {
      return JSON.parse(json);
    }
  } catch (e) {
    console.warn('[Settings] Failed to load settings:', e);
  }
  return {};
}

function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('[Settings] Failed to save settings:', e);
  }
}

// Expose debug utilities to browser console
declare global {
  interface Window {
    meltdown: {
      setWaterPropsDebug: typeof setWaterPropsDebug;
      getWaterPropsDebugLog: typeof getWaterPropsDebugLog;
      calculateWaterState: typeof calculateWaterState;
      enableCalculationDebug: typeof enableCalculationDebug;
      getCalculationDebugLog: typeof getCalculationDebugLog;
      setSeparationDebug: typeof setSeparationDebug;
      getState: () => SimulationState | null;
      pause: () => void;
      resume: () => void;
      step: (dt?: number) => void;
      singleStep: () => number;
    };
  }
}

/**
 * Find scram controller in plant state and return its setpoints
 * Returns undefined if no controller is found or controller has no connected core
 */
function getScramSetpointsFromPlant(plantState: PlantState): ScramSetpoints | undefined {
  for (const [, comp] of plantState.components) {
    if (comp.type === 'controller') {
      const controller = comp as ControllerComponent;
      if (controller.controllerType === 'scram' && controller.connectedCoreId) {
        return controller.setpoints;
      }
    }
  }
  return undefined;
}

/**
 * Build the plant-derived choice lists for the PID controller dialog's
 * dynamic dropdowns. IDs must match what the simulation factory will create:
 * flow nodes use the component id (heat exchangers add -tube/-shell),
 * connections are flow-{from}-{to}, valves/pumps/turbines use their ids.
 */
function getPidDynamicChoices(plantState: PlantState): Record<string, Array<{ id: string; label: string }>> {
  const flowNodes: Array<{ id: string; label: string }> = [];
  const valves: Array<{ id: string; label: string }> = [];
  const pumps: Array<{ id: string; label: string }> = [];
  const turbines: Array<{ id: string; label: string }> = [];
  const flowConnections: Array<{ id: string; label: string }> = [];

  for (const [id, comp] of plantState.components) {
    const label = comp.label || id;
    switch (comp.type) {
      case 'tank':
      case 'pipe':
      case 'vessel':
      case 'condenser':
      case 'crossVessel':
      case 'coreBarrel':
        flowNodes.push({ id, label });
        break;
      case 'reactorVessel':
        flowNodes.push({ id, label: `${label} (downcomer)` });
        break;
      case 'heatExchanger':
        flowNodes.push({ id: `${id}-tube`, label: `${label} (tube/primary)` });
        flowNodes.push({ id: `${id}-shell`, label: `${label} (shell/secondary)` });
        break;
      case 'valve':
        valves.push({ id, label });
        break;
      case 'pump':
        pumps.push({ id, label });
        break;
      case 'turbine-generator':
        turbines.push({ id, label });
        break;
    }
  }

  for (const conn of plantState.connections.values()) {
    const fromComp = plantState.components.get(conn.fromComponentId);
    const toComp = plantState.components.get(conn.toComponentId);
    const fromLabel = fromComp?.label || conn.fromComponentId;
    const toLabel = toComp?.label || conn.toComponentId;
    flowConnections.push({
      id: `flow-${conn.fromComponentId}-${conn.toComponentId}`,
      label: `${fromLabel} → ${toLabel}`,
    });
  }

  return { flowNodes, valves, pumps, turbines, flowConnections };
}

/**
 * Extract a human-readable port type from the port ID.
 * Port IDs are like "comp-id-tube-1", "comp-id-shell-2", "comp-id-inlet", etc.
 */
function getPortTypeLabel(portId: string, componentId: string): string {
  // Remove the component ID prefix to get the port suffix
  const suffix = portId.startsWith(componentId + '-')
    ? portId.slice(componentId.length + 1)
    : portId;

  // Map common suffixes to readable labels
  // Only use "Inlet"/"Outlet" for ports that actually have directional function (pumps, turbines, etc.)
  // For passive/bidirectional components, use positional names (Left, Right, 1, 2, etc.)
  const typeMap: Record<string, string> = {
    // Directional ports (pumps, turbines, valves with clear in/out)
    'inlet': 'Inlet',
    'outlet': 'Outlet',
    'steam-inlet': 'Steam Inlet',
    'steam-outlet': 'Steam Outlet',
    'water-inlet': 'Water Inlet',
    'water-outlet': 'Water Outlet',
    // Heat exchanger ports (bidirectional)
    'tube-1': 'Tube 1',
    'tube-2': 'Tube 2',
    'tube-left': 'Tube Left',
    'tube-right': 'Tube Right',
    'tube-top': 'Tube Top',
    'tube-bottom': 'Tube Bottom',
    'shell-1': 'Shell 1',
    'shell-2': 'Shell 2',
    // Cross-vessel ports (bidirectional)
    'inner-in': 'Inner 1',
    'inner-out': 'Inner 2',
    'annulus-1': 'Annulus 1',
    'annulus-2': 'Annulus 2',
    // Positional ports (tanks, vessels, buildings)
    'top': 'Top',
    'bottom': 'Bottom',
    'left': 'Left',
    'right': 'Right',
    'north': 'North',
    'south': 'South',
    'east': 'East',
    'west': 'West',
    // Reactor vessel ports (bidirectional, positional)
    'inlet-left': 'Left',
    'inlet-right': 'Right',
    'outlet-left': 'Left',
    'outlet-right': 'Right',
  };

  return typeMap[suffix] || suffix.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}


// Initialize the application
function init() {
  const canvas = document.getElementById('plant-canvas') as HTMLCanvasElement;
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }

  const portTooltip = document.getElementById('port-tooltip') as HTMLDivElement;

  // Start with empty plant (user can create components)
  // To load the demo plant instead, uncomment the lines below:
  // const plantState: PlantState = createDemoPlant();
  // const simState: SimulationState = createDemoReactor();

  const plantState: PlantState = {
    components: new Map(),
    connections: [],
    simTime: 0,
    simSpeed: 1,
    isPaused: true,
  };

  // Empty simulation state - will be created when user starts simulation
  const simState: SimulationState = {
    time: 0,
    flowNodes: new Map(),
    flowConnections: [],
    thermalNodes: new Map(),
    thermalConnections: [],
    convectionConnections: [],
    neutronics: {
      coreId: null,
      fuelNodeId: null,
      coolantNodeId: null,
      power: 0,
      nominalPower: 0,
      reactivity: 0,
      promptNeutronLifetime: 2e-5,
      delayedNeutronFraction: 0.0065,
      precursorConcentration: 0,
      precursorDecayConstant: 0.08,
      fuelTempCoeff: -2.5e-5,
      coolantTempCoeff: -1e-4,
      coolantDensityCoeff: -2e-4,
      refFuelTemp: 900,
      refCoolantTemp: 580,
      refCoolantDensity: 700,
      controlRodPosition: 1,
      controlRodWorth: 0.08,
      decayHeatFraction: 0,
      decayHeatPools: [0, 0, 0, 0],
      scrammed: false,
      scramTime: 0,
      scramReason: '',
      reactivityBreakdown: { excess: 0, controlRods: 0, doppler: 0, coolantTemp: 0, coolantDensity: 0 },
      diagnostics: { fuelTemp: 0, coolantTemp: 0, coolantDensity: 0 },
    },
    components: {
      pumps: new Map(),
      valves: new Map(),
      checkValves: new Map(),
      controllers: new Map(),
    },
  };

  // Initialize canvas renderer
  const plantCanvas = new PlantCanvas(canvas, plantState);

  // Initialize debug panel
  initDebugPanel();

  // Initialize game loop with simulation
  const gameLoop = new GameLoop(simState, {
    initialSimSpeed: 1.0,
    autoSlowdownEnabled: true,
  });

  // Career mode manager (constructed later, once the plant/save helpers
  // below exist; null until then and forever in pure-sandbox flows)
  let gameMode: GameModeManager | null = null;

  // Bridge simulation state to visual components
  gameLoop.onStateUpdate = (state: SimulationState, metrics: SolverMetrics) => {
    // Career-mode bookkeeping (revenue, objectives, random events)
    gameMode?.onSimUpdate(state);
    // Update time display
    const timeDisplay = document.getElementById('sim-time');
    if (timeDisplay) {
      timeDisplay.textContent = `Time: ${state.time.toFixed(3)}s (${metrics.totalSteps} steps)`;
    }

    // Update speed display
    const speedDisplay = document.getElementById('sim-speed');
    if (speedDisplay) {
      const speed = gameLoop.getSimSpeed();
      const target = gameLoop.getTargetSimSpeed();
      speedDisplay.textContent = 'Speed: ' + speed.toFixed(1) + 'x';
      if (speed < target - 0.001) {
        speedDisplay.textContent += ` (auto-slow from ${target.toFixed(0)}x)`;
      }
      if (metrics.isFallingBehind) {
        speedDisplay.style.color = '#ff4444';
        speedDisplay.textContent += ' [LAGGING]';
      } else {
        speedDisplay.style.color = '#aaa';
      }
    }

    // Keep the toolbar speed readout in sync: auto-slowdown and its silent
    // recovery ramp change the effective speed without any user input
    updateSpeedDisplay();

    // Update MW to grid display from turbine-condenser state
    const mwValueEl = document.getElementById('mw-value');
    if (mwValueEl) {
      const tcState = getTurbineCondenserState();
      const totalMW = tcState.turbinePower / 1e6;
      mwValueEl.textContent = totalMW.toFixed(1) + ' MW';
      // Color based on power level
      if (totalMW <= 0) {
        mwValueEl.style.color = '#888';
      } else if (totalMW < 100) {
        mwValueEl.style.color = '#ff4';
      } else {
        mwValueEl.style.color = '#4f4';
      }
    }

    // Update debug panel and component detail (throttled to reduce flickering)
    const now = performance.now();
    if (now - lastDebugUpdate >= DEBUG_UPDATE_INTERVAL_MS) {
      updateDebugPanel(state, metrics, gameLoop.getPressureSolverStatus());

      // Core damage / radiological release banner
      updateCoreDamageIndicator(state);

      // Update component detail panel if something is selected
      if (selectedComponentId) {
        updateComponentDetail(selectedComponentId, plantState, state);
      }

      // Update history info display
      const historyInfo = gameLoop.getHistoryInfo();
      const historyInfoEl = document.getElementById('history-info');
      if (historyInfoEl) {
        if (historyInfo.count === 0) {
          historyInfoEl.textContent = '';
        } else {
          // Show current position indicator if not at end
          const posStr = historyInfo.currentIndex >= 0
            ? ` [${historyInfo.currentIndex + 1}/${historyInfo.count}]`
            : '';
          historyInfoEl.textContent = `${historyInfo.count} states${posStr}`;
        }
      }

      lastDebugUpdate = now;
    }

    // Sync simulation fluid temperatures to visual components
    syncSimulationToVisuals(state, plantState);

    // Update canvas with simulation state for flow arrows and pressure gauges
    plantCanvas.setSimState(state);
  };

  // Handle game events
  gameLoop.onEvent = (event) => {
    // Career mode reacts to bursts/scrams (repair billing, HUD alarms)
    gameMode?.onGameEvent(event);

    // Could show notifications to user here
    if (event.type === 'scram') {
      showNotification('SCRAM: ' + event.message, 'warning');
    } else if (event.type === 'component-burst') {
      // LOCA - component rupture event: hold the banner 30 s unless dismissed
      showNotification(event.message, 'error', 30000);
    } else if (event.type === 'falling-behind') {
      showNotification('Simulation running slower than real time', 'info');
    } else if (event.type === 'simulation-error') {
      // Show error dialog for simulation errors
      showErrorDialog('Simulation Error', event.message);
      // Update pause button to show paused state
      updatePauseButton();
    }
  };

  /**
   * Show an error dialog to the user
   */
  function showErrorDialog(title: string, message: string): void {
    // Create dialog if it doesn't exist
    let dialog = document.getElementById('error-dialog') as HTMLDivElement;
    if (!dialog) {
      dialog = document.createElement('div');
      dialog.id = 'error-dialog';
      dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(40, 20, 20, 0.98);
        border: 2px solid #a44;
        border-radius: 8px;
        padding: 20px;
        z-index: 10000;
        max-width: 500px;
        font-family: 'Consolas', monospace;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      `;
      document.body.appendChild(dialog);
    }

    dialog.innerHTML = `
      <h3 style="color: #f88; margin: 0 0 10px 0;">${title}</h3>
      <p style="color: #ddd; margin: 0 0 15px 0; font-size: 12px; white-space: pre-wrap; word-break: break-word;">${message}</p>
      <p style="color: #888; margin: 0 0 15px 0; font-size: 11px;">Use the history controls (⏮ ⏭) to go back to a stable state, or reduce simulation speed.</p>
      <button id="error-dialog-close" style="
        background: #644;
        color: #fff;
        border: 1px solid #a66;
        border-radius: 4px;
        padding: 8px 20px;
        cursor: pointer;
        font-family: inherit;
      ">OK</button>
    `;

    dialog.style.display = 'block';

    // Close button handler
    const closeBtn = document.getElementById('error-dialog-close');
    if (closeBtn) {
      closeBtn.onclick = () => {
        dialog.style.display = 'none';
      };
    }
  }

  // Set up UI callbacks
  plantCanvas.onMouseMove = (worldPos) => {
    const posDisplay = document.getElementById('mouse-pos');
    if (posDisplay) {
      posDisplay.textContent = 'X: ' + worldPos.x.toFixed(1) + 'm, Y: ' + worldPos.y.toFixed(1) + 'm';
    }
  };

  // Track selected component for detail panel updates
  let selectedComponentId: string | null = null;

  plantCanvas.onComponentSelect = (componentId) => {
    selectedComponentId = componentId;
    // Update detail panel immediately
    updateComponentDetail(selectedComponentId, plantState, gameLoop.getState());
    // Career mode: offer operator actions on the selected machine
    gameMode?.onComponentSelect(componentId);
  };

  // Toolbar buttons - zoom controls
  document.getElementById('zoom-in')?.addEventListener('click', () => {
    plantCanvas.zoomIn();
  });

  document.getElementById('zoom-out')?.addEventListener('click', () => {
    plantCanvas.zoomOut();
  });

  document.getElementById('reset-view')?.addEventListener('click', () => {
    plantCanvas.resetView();
  });

  const edgePanToggle = document.getElementById('edge-pan-toggle') as HTMLInputElement | null;
  edgePanToggle?.addEventListener('change', () => {
    plantCanvas.setEdgePanEnabled(edgePanToggle.checked);
  });

  // Keep the bottom edge-scroll trigger ABOVE the full-width status bar (in
  // visible canvas) rather than the 1px strip beneath it.
  const statusBarEl = document.getElementById('status-bar');
  const applyEdgePanInsets = () => {
    plantCanvas.setEdgePanInsets({ bottom: statusBarEl?.getBoundingClientRect().height ?? 0 });
  };
  applyEdgePanInsets();
  window.addEventListener('resize', applyEdgePanInsets);

  // Fullscreen toggle. Uses the whole document so all panels stay visible;
  // fullscreen also keeps the cursor from leaving the window while edge-scrolling.
  const fullscreenBtn = document.getElementById('toggle-fullscreen');
  fullscreenBtn?.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.warn('[Fullscreen] exit failed:', err));
    } else {
      document.documentElement.requestFullscreen().catch(err =>
        showNotification(`Fullscreen unavailable: ${err.message}`, 'warning'));
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (fullscreenBtn) {
      fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
    }
  });

  // Component placement buttons (placeholder for now)
  const componentButtons = document.querySelectorAll('#toolbar button[data-component]');
  componentButtons.forEach(button => {
    button.addEventListener('click', () => {
      componentButtons.forEach(b => b.classList.remove('selected'));
      button.classList.add('selected');
      // Store selected component type for placement
      button.getAttribute('data-component');
    });
  });


  // Close detail panel button - clear selection so it doesn't reopen
  const closeDetailBtn = document.getElementById('close-detail');
  if (closeDetailBtn) {
    closeDetailBtn.addEventListener('click', () => {
      selectedComponentId = null;
      plantCanvas.clearSelection();
    });
  }

  // Control rod position slider
  // Slider shows insertion % (0% = withdrawn, 100% = fully inserted)
  // Simulation uses withdrawal position (0 = inserted, 1 = withdrawn)
  const rodSlider = document.getElementById('rod-position') as HTMLInputElement;
  const rodValueDisplay = document.getElementById('rod-position-value');
  if (rodSlider) {
    rodSlider.addEventListener('input', () => {
      const insertionPercent = parseInt(rodSlider.value);
      const withdrawalPosition = 1 - insertionPercent / 100; // Convert to simulation scale
      // Update display
      if (rodValueDisplay) {
        rodValueDisplay.textContent = insertionPercent + '%';
      }
      // Update simulation state
      gameLoop.updateState((state) => {
        state.neutronics.controlRodPosition = withdrawalPosition;
        return state;
      });
      // Update visual components with control rods (visual also uses withdrawal position internally)
      for (const [, comp] of plantState.components) {
        // Vessels have controlRodCount directly
        if (comp.type === 'vessel' && (comp as any).controlRodCount) {
          (comp as any).controlRodPosition = withdrawalPosition;
        }
        // Core barrels have control rod properties
        if (comp.type === 'coreBarrel' && (comp as any).controlRodCount) {
          (comp as any).controlRodPosition = withdrawalPosition;
        }
      }
    });
  }

  // Soluble boron target (CVCS boration/dilution)
  const boronSlider = document.getElementById('boron-target') as HTMLInputElement;
  if (boronSlider) {
    boronSlider.addEventListener('input', () => {
      const targetPpm = parseInt(boronSlider.value);
      gameLoop.updateState((state) => {
        state.neutronics.boronTargetPpm = targetPpm;
        return state;
      });
    });
  }

  // Rod controller manual/auto toggle: flips every control-rods PID
  // controller between auto and manual. Bumpless in both directions (the
  // velocity-form controller has no integrator state to wind up).
  const rodModeBtn = document.getElementById('rod-mode-btn') as HTMLButtonElement;
  if (rodModeBtn) {
    rodModeBtn.addEventListener('click', () => {
      gameLoop.updateState((state) => {
        const controllers = state.components.controllers;
        if (controllers) {
          for (const [, ctl] of controllers) {
            if (ctl.actuator.kind === 'control-rods') {
              ctl.mode = ctl.mode === 'manual' ? 'auto' : 'manual';
              // Manual mode holds position until the slider commands otherwise
              ctl.manualOutput = undefined;
            }
          }
        }
        return state;
      });
    });
  }

  // Simulation speed controls
  const pauseBtn = document.getElementById('pause-btn');
  const speedDisplay = document.getElementById('speed-display');
  const speedUpBtn = document.getElementById('speed-up');
  const speedDownBtn = document.getElementById('speed-down');
  const speedPresets = document.querySelectorAll('.speed-preset');

  function updateSpeedDisplay() {
    const speed = gameLoop.getSimSpeed();
    const target = gameLoop.getTargetSimSpeed();
    const autoSlowed = speed < target - 0.001;
    if (speedDisplay) {
      // Recovery from auto-slow passes through fractional speeds (1.5x, ...)
      const label = Number.isInteger(speed) ? `${speed}` : speed < 1 ? `${speed}` : speed.toFixed(1);
      speedDisplay.textContent = autoSlowed ? `${label}x*` : `${label}x`;
      speedDisplay.title = autoSlowed
        ? `Auto-slowdown active: running at ${label}x, returning to ${target}x once the transient settles`
        : 'Simulation speed';
    }
    // Highlight the preset the user asked for (the target), not the
    // momentary auto-slowed speed
    speedPresets.forEach(btn => {
      const presetSpeed = parseFloat(btn.getAttribute('data-speed') || '1');
      btn.classList.toggle('active', Math.abs(target - presetSpeed) < 0.001);
    });
  }

  function updatePauseButton() {
    if (pauseBtn) {
      const isPaused = gameLoop.getIsPaused();
      pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
      pauseBtn.classList.toggle('paused', isPaused);
    }
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      gameLoop.togglePause();
      updatePauseButton();
    });
  }

  // History controls (back/forward buttons and Go To dialog)
  const backStepBtn = document.getElementById('back-step-btn');
  const forwardStepBtn = document.getElementById('forward-step-btn');
  const runOneStepBtn = document.getElementById('run-one-step-btn');
  const gotoTimeBtn = document.getElementById('goto-time-btn');
  const resetSimBtn = document.getElementById('reset-sim-btn');
  const historyInfoSpan = document.getElementById('history-info');
  const historyDialog = document.getElementById('history-dialog');
  const historyDialogBody = document.getElementById('history-dialog-body');
  const historyTimeInput = document.getElementById('history-time-input') as HTMLInputElement | null;
  const historyGotoTimeBtn = document.getElementById('history-goto-time-btn');
  const historyDialogCancel = document.getElementById('history-dialog-cancel');
  const historyDialogClose = document.querySelector('.history-dialog-close');

  // Refresh all displays after restoring a state from history
  function refreshDisplayAfterRestore(): void {
    const state = gameLoop.getState();
    const historyInfo = gameLoop.getHistoryInfo();

    // Sync simulation to visual components
    syncSimulationToVisuals(state, plantState);

    // Update canvas
    plantCanvas.setSimState(state);

    // Update time display - use step number from history, not solver
    const timeDisplay = document.getElementById('sim-time');
    if (timeDisplay) {
      timeDisplay.textContent = `Time: ${state.time.toFixed(3)}s (${historyInfo.currentStepNumber} steps)`;
    }

    // Update debug panel
    updateDebugPanel(state, gameLoop.getSolverMetrics(), gameLoop.getPressureSolverStatus());

    // Update component detail panel if something is selected
    if (selectedComponentId) {
      updateComponentDetail(selectedComponentId, plantState, state);
    }

    // Update history info
    updateHistoryInfo();
  }

  if (backStepBtn) {
    backStepBtn.addEventListener('click', () => {
      const success = gameLoop.stepBack();
      if (success) {
        refreshDisplayAfterRestore();
      } else {
        showNotification('Already at beginning of history', 'warning');
      }
    });
  }

  if (forwardStepBtn) {
    forwardStepBtn.addEventListener('click', () => {
      const success = gameLoop.stepForward();
      if (success) {
        refreshDisplayAfterRestore();
      } else {
        showNotification('Already at end of history', 'warning');
      }
    });
  }

  // Run 1 Step button - advance simulation by one solver step
  if (runOneStepBtn) {
    runOneStepBtn.addEventListener('click', () => {
      try {
        gameLoop.singleStep();
        refreshDisplayAfterRestore();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        showNotification('Simulation error: ' + errorMessage.substring(0, 50), 'warning');
      }
    });
  }

  // Reset button - jump to t=0
  if (resetSimBtn) {
    resetSimBtn.addEventListener('click', () => {
      const restoredTime = gameLoop.restoreToTime(0);
      if (restoredTime !== null) {
        refreshDisplayAfterRestore();
      } else {
        showNotification('No history available', 'warning');
      }
    });
  }

  // Open history dialog
  function openHistoryDialog(): void {
    if (!historyDialog || !historyDialogBody) return;

    const snapshots = gameLoop.getSnapshotList();
    const historyInfo = gameLoop.getHistoryInfo();

    if (snapshots.length === 0) {
      showNotification('No history available', 'warning');
      return;
    }

    // Build snapshot list HTML
    // Show most recent first, highlight current position
    const currentIdx = historyInfo.currentIndex >= 0 ? historyInfo.currentIndex : snapshots.length - 1;

    let html = '<div style="font-size: 11px;">';
    // Show in reverse order (newest first)
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const s = snapshots[i];
      const isCurrent = i === currentIdx;
      const isMarker = s.isSecondMarker;
      const bgColor = isCurrent ? 'rgba(100, 150, 255, 0.3)' : (isMarker ? 'rgba(255, 255, 255, 0.05)' : 'transparent');
      const border = isCurrent ? '1px solid #7af' : 'none';
      const markerIcon = isMarker ? '⏱' : '';

      html += `<div class="history-item" data-index="${i}" style="
        padding: 4px 8px;
        margin: 2px 0;
        cursor: pointer;
        background: ${bgColor};
        border: ${border};
        border-radius: 3px;
        display: flex;
        justify-content: space-between;
      " onmouseover="this.style.background='rgba(100,150,255,0.2)'" onmouseout="this.style.background='${bgColor}'">
        <span>${markerIcon} t = ${s.simTime.toFixed(3)}s</span>
        <span style="color: #888;">step ${s.stepNumber}</span>
      </div>`;
    }
    html += '</div>';

    historyDialogBody.innerHTML = html;

    // Add click handlers to items
    const items = historyDialogBody.querySelectorAll('.history-item');
    items.forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.getAttribute('data-index') || '0', 10);
        const time = gameLoop.navigateToHistoryIndex(index);
        if (time !== null) {
          refreshDisplayAfterRestore();
          closeHistoryDialog();
        }
      });
    });

    // Set input to current time
    if (historyTimeInput) {
      historyTimeInput.value = historyInfo.currentTime.toFixed(1);
    }

    historyDialog.style.display = 'flex';
  }

  function closeHistoryDialog(): void {
    if (historyDialog) {
      historyDialog.style.display = 'none';
    }
  }

  if (gotoTimeBtn) {
    gotoTimeBtn.addEventListener('click', openHistoryDialog);
  }

  if (historyDialogClose) {
    historyDialogClose.addEventListener('click', closeHistoryDialog);
  }

  if (historyDialogCancel) {
    historyDialogCancel.addEventListener('click', closeHistoryDialog);
  }

  if (historyGotoTimeBtn && historyTimeInput) {
    historyGotoTimeBtn.addEventListener('click', () => {
      const targetTime = parseFloat(historyTimeInput.value);
      if (isNaN(targetTime)) {
        showNotification('Invalid time value', 'warning');
        return;
      }

      const restoredTime = gameLoop.restoreToTime(targetTime);
      if (restoredTime !== null) {
        refreshDisplayAfterRestore();
        closeHistoryDialog();
      } else {
        showNotification('No snapshot found near that time', 'warning');
      }
    });
  }

  // Close dialog on background click
  if (historyDialog) {
    historyDialog.addEventListener('click', (e) => {
      if (e.target === historyDialog) {
        closeHistoryDialog();
      }
    });
  }

  // Update history info display and forward button state
  function updateHistoryInfo(): void {
    const info = gameLoop.getHistoryInfo();

    // Update the history info text
    if (historyInfoSpan) {
      if (info.count === 0) {
        historyInfoSpan.textContent = '';
      } else {
        // Show current position indicator if not at end
        const posStr = info.currentIndex >= 0
          ? ` [${info.currentIndex + 1}/${info.count}]`
          : '';
        historyInfoSpan.textContent = `${info.count} states${posStr}`;
      }
    }

    // Update forward button disabled state
    // Disable when at end of history (currentIndex === -1 means at end)
    if (forwardStepBtn) {
      const atEnd = info.currentIndex < 0;
      (forwardStepBtn as HTMLButtonElement).disabled = atEnd;
      forwardStepBtn.title = atEnd
        ? 'Already at end of history - use "Run 1 Step" to advance simulation'
        : 'Forward one step in history';
      forwardStepBtn.style.opacity = atEnd ? '0.5' : '1';
    }
  }

  if (speedUpBtn) {
    speedUpBtn.addEventListener('click', () => {
      gameLoop.setSimSpeed(gameLoop.getSimSpeed() * 2);
      updateSpeedDisplay();
    });
  }

  if (speedDownBtn) {
    speedDownBtn.addEventListener('click', () => {
      gameLoop.setSimSpeed(gameLoop.getSimSpeed() / 2);
      updateSpeedDisplay();
    });
  }

  speedPresets.forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.getAttribute('data-speed') || '1');
      gameLoop.setSimSpeed(speed);
      updateSpeedDisplay();
    });
  });

  // Auto-slowdown controls
  const slowdownThreshold = document.getElementById('slowdown-threshold') as HTMLInputElement;
  const slowdownThresholdValue = document.getElementById('slowdown-threshold-value');
  const autoSlowdownEnabled = document.getElementById('auto-slowdown-enabled') as HTMLInputElement;

  if (slowdownThreshold) {
    slowdownThreshold.addEventListener('input', () => {
      const percent = parseInt(slowdownThreshold.value, 10);
      if (slowdownThresholdValue) {
        slowdownThresholdValue.textContent = percent.toString();
      }
      gameLoop.setAutoSlowdownThreshold(percent / 100);
    });
  }

  if (autoSlowdownEnabled) {
    autoSlowdownEnabled.addEventListener('change', () => {
      gameLoop.setAutoSlowdownEnabled(autoSlowdownEnabled.checked);
    });
  }

  // Max timestep control
  const maxTimestepSlider = document.getElementById('max-timestep') as HTMLInputElement;
  const maxTimestepValue = document.getElementById('max-timestep-value');

  if (maxTimestepSlider) {
    maxTimestepSlider.addEventListener('input', () => {
      const ms = parseInt(maxTimestepSlider.value, 10);
      if (maxTimestepValue) {
        maxTimestepValue.textContent = ms.toString();
      }
      gameLoop.setMaxTimestep(ms / 1000); // Convert ms to seconds
    });

    // Initialize slider position and apply initial value
    const initialMs = parseInt(maxTimestepSlider.value, 10);
    if (maxTimestepValue) {
      maxTimestepValue.textContent = initialMs.toString();
    }
    gameLoop.setMaxTimestep(initialMs / 1000);
  }

  // Pressure model dropdown removed: the old 'hybrid' bulk-modulus model is
  // obsolete (a no-op that silently disabled triangulation pressure
  // feedback), so the config stays at its 'pure-triangulation' default.

  // Advanced solver settings: Min timestep control (logarithmic scale)
  // Slider value 0-5 maps to 1µs (1e-6) to 100ms (0.1) via exponential: 10^(sliderValue - 6)
  const minTimestepSlider = document.getElementById('min-timestep') as HTMLInputElement;
  const minTimestepValue = document.getElementById('min-timestep-value');

  function formatMinTimestep(seconds: number): string {
    if (seconds < 1e-3) {
      return `${(seconds * 1e6).toFixed(0)}µs`;
    } else {
      return `${(seconds * 1e3).toFixed(1)}ms`;
    }
  }

  if (minTimestepSlider) {
    minTimestepSlider.addEventListener('input', () => {
      // Slider value 0-5 maps logarithmically: 0=1µs, 5=100ms
      const sliderVal = parseFloat(minTimestepSlider.value);
      const minDt = Math.pow(10, sliderVal - 6); // 0 -> 1e-6, 5 -> 1e-1
      if (minTimestepValue) {
        minTimestepValue.textContent = formatMinTimestep(minDt);
      }
      gameLoop.setMinTimestep(minDt);
    });

    // Initialize display AND apply initial value
    const initialSliderVal = parseFloat(minTimestepSlider.value);
    const initialMinDt = Math.pow(10, initialSliderVal - 6);
    if (minTimestepValue) {
      minTimestepValue.textContent = formatMinTimestep(initialMinDt);
    }
    gameLoop.setMinTimestep(initialMinDt);
  }

  // Advanced solver settings: K_max control (numerical bulk modulus cap)
  const kMaxSlider = document.getElementById('k-max') as HTMLInputElement;
  const kMaxValue = document.getElementById('k-max-value');

  if (kMaxSlider) {
    kMaxSlider.addEventListener('input', () => {
      const kMaxMPa = parseInt(kMaxSlider.value, 10);
      if (kMaxValue) {
        kMaxValue.textContent = kMaxMPa.toString();
      }
      // Convert MPa to Pa and set (undefined at max means no cap)
      const kMaxPa = kMaxMPa >= 2200 ? undefined : kMaxMPa * 1e6;
      gameLoop.setKMax(kMaxPa);
    });

    // Initialize display and apply the initial value (2200 = no cap)
    const initialKMax = parseInt(kMaxSlider.value, 10);
    if (kMaxValue) {
      kMaxValue.textContent = initialKMax.toString();
    }
    gameLoop.setKMax(initialKMax >= 2200 ? undefined : initialKMax * 1e6);
  }

  // Advanced solver settings: Pressure solver enable/disable
  const pressureSolverCheckbox = document.getElementById('pressure-solver-enabled') as HTMLInputElement;
  if (pressureSolverCheckbox) {
    // Reflect the solver's actual default (enabled)
    pressureSolverCheckbox.checked = gameLoop.getPressureSolverEnabled();

    pressureSolverCheckbox.addEventListener('change', () => {
      gameLoop.setPressureSolverEnabled(pressureSolverCheckbox.checked);
    });
  }

  // Advanced solver settings: Implicit flow momentum (backward-Euler
  // pressure-flow solve) enable/disable
  const implicitMomentumCheckbox = document.getElementById('implicit-momentum-enabled') as HTMLInputElement;
  if (implicitMomentumCheckbox) {
    // Reflect the solver's actual default (enabled)
    implicitMomentumCheckbox.checked = gameLoop.getImplicitMomentumEnabled();

    implicitMomentumCheckbox.addEventListener('change', () => {
      gameLoop.setImplicitMomentumEnabled(implicitMomentumCheckbox.checked);
    });
  }

  // Advanced solver settings: Deterministic mode enable/disable
  const deterministicModeCheckbox = document.getElementById('deterministic-mode') as HTMLInputElement;
  if (deterministicModeCheckbox) {
    // Load saved setting, default to false for UI responsiveness
    const savedSettings = loadSettings();
    const initialDeterministic = savedSettings.deterministicMode ?? false;
    deterministicModeCheckbox.checked = initialDeterministic;
    gameLoop.setDeterministicMode(initialDeterministic);

    deterministicModeCheckbox.addEventListener('change', () => {
      gameLoop.setDeterministicMode(deterministicModeCheckbox.checked);
      // Persist the setting
      const settings = loadSettings();
      settings.deterministicMode = deterministicModeCheckbox.checked;
      saveSettings(settings);
    });
  }

  // Listen for auto-slowdown events: update the speed display and tell the
  // user what tripped the slowdown (the event message names the quantity
  // and how fast it was moving)
  gameLoop.addEventListener('auto-slowdown', (event) => {
    updateSpeedDisplay();
    showNotification(`⏱ ${event.message}`, 'warning');
  });

  // Initial display update
  updateSpeedDisplay();
  updatePauseButton();

  // Keyboard controls are set up later, after currentMode is defined

  // SCRAM button controls
  const scramBtn = document.getElementById('scram-btn') as HTMLButtonElement;
  const resetScramBtn = document.getElementById('reset-scram-btn') as HTMLButtonElement;
  const scramIndicator = document.getElementById('scram-indicator') as HTMLDivElement;

  function updateScramDisplay(): void {
    const isScramActive = gameLoop.isScramActive();
    if (scramBtn) scramBtn.style.display = isScramActive ? 'none' : 'block';
    if (resetScramBtn) resetScramBtn.style.display = isScramActive ? 'block' : 'none';
    if (scramIndicator) {
      scramIndicator.style.display = isScramActive ? 'block' : 'none';
      // Update indicator with time and reason
      if (isScramActive) {
        const simState = gameLoop.getState();
        const scramTime = simState.neutronics.scramTime;
        const scramReason = simState.neutronics.scramReason || 'Unknown';
        scramIndicator.innerHTML = `<strong>SCRAM ACTIVE</strong><br>Time: ${scramTime.toFixed(1)}s<br>Reason: ${scramReason}`;
      }
    }

    // Also disable rod control when scrammed
    const rodSlider = document.getElementById('rod-position') as HTMLInputElement;
    if (rodSlider) {
      rodSlider.disabled = isScramActive;
    }
  }

  if (scramBtn) {
    scramBtn.addEventListener('click', () => {
      gameLoop.triggerScram('Manual operator action');
      updateScramDisplay();
    });
  }

  if (resetScramBtn) {
    resetScramBtn.addEventListener('click', () => {
      // Reset T&H conditions to initial state (recreate simulation)
      // Set random seed for deterministic mode
      const deterministicCheckbox = document.getElementById('deterministic-mode') as HTMLInputElement;
      setSimulationRandomSeed(deterministicCheckbox?.checked ? 0 : undefined);
      const newSimState = createSimulationFromPlant(plantState);
      gameLoop.resetState(newSimState);
      // SCRAM is automatically cleared since we have a fresh simulation state
      gameMode?.onSimReset();
      updateScramDisplay();
    });
  }

  // Listen for scram events
  gameLoop.addEventListener('scram', () => {
    updateScramDisplay();
  });

  gameLoop.addEventListener('scram-reset', () => {
    updateScramDisplay();
  });

  // Initial scram display update
  updateScramDisplay();

  // Construction/Simulation mode controls
  const modeConstructionBtn = document.getElementById('mode-construction') as HTMLButtonElement;
  const modeSimulationBtn = document.getElementById('mode-simulation') as HTMLButtonElement;
  const simControls = document.getElementById('sim-controls') as HTMLDivElement;
  const constructionControls = document.getElementById('construction-controls') as HTMLDivElement;
  const constructionButtons = document.querySelectorAll('.component-btn');
  const selectedComponentDiv = document.getElementById('selected-component') as HTMLDivElement;
  const placementHintDiv = document.getElementById('placement-hint') as HTMLDivElement;

  let currentMode: 'construction' | 'simulation' = 'construction';
  let constructionSubMode: 'place' | 'connect' | 'move' = 'place';
  let selectedComponentType: string | null = null;
  const componentDialog = new ComponentDialog();
  const connectionDialog = new ConnectionDialog();
  const constructionManager = new ConstructionManager(plantState);

  // Construction cost panel elements
  const constructionCostPanel = document.getElementById('construction-cost-panel') as HTMLDivElement;
  const totalCostDisplay = document.getElementById('total-cost') as HTMLDivElement;
  const costBreakdownDisplay = document.getElementById('cost-breakdown') as HTMLDivElement;
  const costHeader = document.getElementById('cost-header') as HTMLDivElement;

  // Toggle cost breakdown visibility on header click
  if (costHeader && costBreakdownDisplay && constructionCostPanel) {
    costHeader.addEventListener('click', () => {
      const isExpanded = constructionCostPanel.classList.toggle('expanded');
      costBreakdownDisplay.style.display = isExpanded ? 'block' : 'none';
    });
  }

  /**
   * Update the construction cost panel with current plant costs
   */
  function updateConstructionCostPanel(): void {
    if (!constructionCostPanel) return;

    let totalCost = 0;
    const componentCosts: Array<{ label: string; cost: number }> = [];

    // Calculate cost for each component (shared pricing entry point)
    for (const [id, component] of plantState.components) {
      const estimate = estimatePlantComponentCost(component as any);
      if (!estimate) continue; // priced as part of parent (core barrel)
      totalCost += estimate.total;
      componentCosts.push({
        label: component.label || id,
        cost: estimate.total,
      });
    }

    // Update total display
    if (totalCostDisplay) {
      totalCostDisplay.textContent = formatCost(totalCost);
    }

    // Update breakdown
    if (costBreakdownDisplay) {
      // Sort by cost descending
      componentCosts.sort((a, b) => b.cost - a.cost);

      // Build breakdown HTML
      let html = '';
      for (const item of componentCosts) {
        html += `<div class="cost-item">
          <span class="cost-label" title="${item.label}">${item.label}</span>
          <span class="cost-value">${formatCost(item.cost)}</span>
        </div>`;
      }

      if (componentCosts.length === 0) {
        html = '<div style="color: #666; font-style: italic;">No components placed</div>';
      }

      costBreakdownDisplay.innerHTML = html;
    }

    // Keep the career HUD's budget readout in sync with the design
    gameMode?.refreshConstructionHud();
  }

  // Keyboard controls
  document.addEventListener('keydown', (e) => {
    // Don't steal keystrokes from text fields (e.g. Jack's chat box):
    // space/Delete/+/- are shortcuts only when not typing.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    // Don't handle keyboard shortcuts if a dialog is open
    const componentDialogEl = document.getElementById('component-dialog');
    const connectionDialogEl = document.getElementById('connection-dialog');
    if ((componentDialogEl && componentDialogEl.style.display !== 'none') ||
        (connectionDialogEl && connectionDialogEl.style.display !== 'none')) {
      return;
    }

    // Construction mode keyboard shortcuts
    if (currentMode === 'construction') {
      // Delete key deletes the selected component (but not Backspace - that's for text editing)
      if (e.key === 'Delete' && selectedComponentId) {
        e.preventDefault();
        const component = constructionManager.getComponent(selectedComponentId);
        const label = component?.label || selectedComponentId;
        if (confirm(`Delete component "${label}"? This will also remove all its connections.`)) {
          const wasController = component?.type === 'controller';
          constructionManager.deleteComponent(selectedComponentId);
          if (wasController) {
            gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
          }
          plantCanvas.clearSelection();
          selectedComponentId = null;
          updateComponentDetail(null, plantState, gameLoop?.getState() || {} as SimulationState);
          updateConstructionCostPanel();
        }
      }
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        gameLoop.togglePause();
        updatePauseButton();
        break;
      case '+':
      case '=':
        gameLoop.setSimSpeed(gameLoop.getSimSpeed() * 2);
        updateSpeedDisplay();
        break;
      case '-':
        gameLoop.setSimSpeed(gameLoop.getSimSpeed() / 2);
        updateSpeedDisplay();
        break;
      case 's':
        if (e.ctrlKey) {
          e.preventDefault();
        } else {
          gameLoop.triggerScram('Manual operator action');
        }
        break;
    }
  });

  // Set up edit/delete callbacks for component detail panel
  setComponentEditCallback((componentId: string) => {
    const component = constructionManager.getComponent(componentId);
    if (!component) {
      console.error(`[Edit] Component ${componentId} not found`);
      return;
    }

    // Get available cores for controller dropdowns
    const availableCores: Array<{ id: string; label: string }> = [];
    if (component.type === 'controller') {
      for (const [id, comp] of plantState.components) {
        if (comp.type === 'reactorVessel' || (comp.type === 'vessel' && (comp as any).fuelRodCount)) {
          availableCores.push({ id, label: comp.label || id });
        }
      }
    }

    // PID controllers need plant-derived target lists for their dropdowns
    if (component.type === 'controller' && (component as any).controllerType === 'pid') {
      componentDialog.setDynamicChoices(getPidDynamicChoices(plantState));
    }

    // Get available generators for switchyard dropdowns
    const availableGenerators: Array<{ id: string; label: string }> = [];
    if (component.type === 'switchyard') {
      for (const [id, comp] of plantState.components) {
        if (comp.type === 'turbine-generator') {
          availableGenerators.push({ id, label: comp.label || id });
        }
      }
    }

    componentDialog.showEdit(component as Record<string, any>, (properties) => {
      if (properties) {
        constructionManager.updateComponent(componentId, properties);
        // If editing a controller, update the game loop scram setpoints
        if (component.type === 'controller') {
          gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
        }
        // Refresh the component detail panel
        if (gameLoop) {
          updateComponentDetail(componentId, plantState, gameLoop.getState());
        }
      }
    }, availableCores, availableGenerators);
  });

  // Edit the core installed in a reactor vessel. The vessel's own Edit button
  // reaches only the vessel geometry; the fuel/enrichment/power/rods live on
  // the core barrel. Reverse the addCoreToContainer transforms to pre-fill the
  // core dialog, then re-apply the edited values to the barrel.
  setCoreEditCallback((reactorVesselId: string) => {
    const rv = constructionManager.getComponent(reactorVesselId) as any;
    if (!rv || !rv.coreBarrelId) return;
    const barrel = constructionManager.getComponent(rv.coreBarrelId) as any;
    if (!barrel) return;

    const coreRecord: Record<string, any> = {
      // type 'vessel' + fuelRodCount marker maps to the 'core' dialog definition
      type: 'vessel', fuelRodCount: 1,
      label: `${rv.label || 'Reactor'} Core`,
      position: rv.position,
      name: `${rv.label || 'Reactor'} Core`,
      nqa1: barrel.nqa1 ?? true,
      height: barrel.activeFuelHeight ?? barrel.coreHeight ?? 3.66,
      coreBottomElevation: barrel.coreBottomElevation ?? 0.5,
      diameter: barrel.coreDiameter ?? barrel.innerDiameter ?? 3.2,
      fuelForm: barrel.fuelForm ?? 'rods',
      rodDiameter: barrel.rodDiameter ?? 9.5,
      rodPitch: barrel.rodPitch ?? 12.6,
      cladThickness: barrel.cladThickness ?? 0.6,
      pebbleDiameter: barrel.pebbleDiameter ?? 60,
      pebbleCount: barrel.pebbleCount ?? 400000,
      heavyMetalPerPebble: barrel.heavyMetalPerPebble ?? 7,
      reflectorThickness: barrel.reflectorThickness ?? 0.8,
      enrichmentPct: (barrel.enrichment ?? 0.05) * 100,
      fuelMaterial: barrel.fuelMaterial ?? 'UO2',
      controlRodBanks: barrel.controlRodCount ?? 4,
      // Keep W here: the dialog's getExistingValue converts thermalPower W->MW
      // for display (pre-dividing made a 3000 MWt core show as 0.003 MWt)
      thermalPower: barrel.thermalPower ?? 3000e6,
      // 0 = fully inserted, 1 = fully withdrawn (same convention everywhere)
      initialRodPosition: Math.round((barrel.controlRodPosition ?? 0.5) * 100),
      startCritical: barrel.startCritical !== false,
      autoPoison: barrel.autoPoison !== false,
      ...(barrel.burnablePoisonPcm !== undefined ? { burnablePoisonPcm: barrel.burnablePoisonPcm } : {}),
    };
    console.log(`[EditCore] open for ${reactorVesselId}: barrel ${rv.coreBarrelId} thermalPower=${((barrel.thermalPower ?? 3000e6) / 1e6).toFixed(0)} MWt`);

    componentDialog.showEdit(coreRecord, (properties) => {
      if (!properties) return;
      console.log(`[EditCore] apply to ${reactorVesselId}: thermalPower=${properties.thermalPower} MWt, diameter=${properties.diameter} m, enrichment=${properties.enrichmentPct}%`);
      const result = constructionManager.addCoreToContainer(reactorVesselId, properties);
      if (result.success) {
        updateConstructionCostPanel();
        if (gameLoop) updateComponentDetail(reactorVesselId, plantState, gameLoop.getState());
        showNotification('Core updated', 'info');
      } else {
        showNotification(result.error || 'Failed to update core', 'error');
      }
    });
  });

  // "Move"/"Move Building": arm this component and switch to move mode so the
  // next click-drag repositions it (the only way to move a building).
  setComponentMoveCallback((componentId: string) => {
    if (currentMode !== 'construction') {
      showNotification('Switch to construction mode to move components.', 'warning');
      return;
    }
    setConstructionSubMode('move');
    armedMoveId = componentId;
    const c = plantState.components.get(componentId);
    showNotification(`Click and drag anywhere to move "${c?.label || componentId}".`, 'info');
  });

  setComponentDeleteCallback((componentId: string) => {
    if (confirm(`Delete component "${componentId}"? This will also remove all its connections.`)) {
      // Check if this is a controller before deleting
      const wasController = plantState.components.get(componentId)?.type === 'controller';

      constructionManager.deleteComponent(componentId);

      // If we deleted a controller, update the scram setpoints
      if (wasController) {
        gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
      }

      // Clear selection
      plantCanvas.clearSelection();
      // Hide component detail panel
      updateComponentDetail(null, plantState, gameLoop?.getState() || {} as SimulationState);
      // Update construction cost
      updateConstructionCostPanel();
    }
  });

  // Connection edit callback - find plant connection from simulation connection ID
  setConnectionEditCallback((simConnId: string) => {
    // Simulation connection IDs are typically formatted as "fromNodeId->toNodeId"
    // We need to find the matching plant connection
    const simState = gameLoop?.getState();
    if (!simState) return;

    // Find the simulation connection to get the node IDs
    const simConn = simState.flowConnections.find(c => c.id === simConnId);
    if (!simConn) {
      console.error(`[Edit] Simulation connection ${simConnId} not found`);
      return;
    }

    // Find the plant connection that matches these nodes
    // Node IDs might be component IDs or internal region IDs. Sub-node ids are
    // formed as "<componentId>-<suffix>", so match on exact id or that prefix
    // pattern - a bare substring test would cross-wire id families like
    // "pump-1" / "fw-pump-1" / "cond-pump-1".
    const idsMatch = (componentId: string, nodeId: string) =>
      componentId === nodeId ||
      nodeId.startsWith(componentId + '-') ||
      componentId.startsWith(nodeId + '-');
    const plantConn = plantState.connections.find(pc =>
      idsMatch(pc.fromComponentId, simConn.fromNodeId) &&
      idsMatch(pc.toComponentId, simConn.toNodeId)
    );

    if (!plantConn) {
      console.error(`[Edit] No plant connection found for sim connection ${simConnId}`);
      alert('Cannot edit this connection - it may be an automatically generated internal connection.');
      return;
    }

    // Get the components
    const fromComponent = plantState.components.get(plantConn.fromComponentId);
    const toComponent = plantState.components.get(plantConn.toComponentId);

    if (!fromComponent || !toComponent) {
      console.error(`[Edit] Components not found for connection`);
      return;
    }

    // Show the edit dialog
    connectionDialog.edit(plantConn, fromComponent, toComponent, (result: ConnectionEditResult | null) => {
      if (result) {
        // Update the plant connection
        plantConn.fromElevation = result.fromElevation;
        plantConn.toElevation = result.toElevation;
        plantConn.flowArea = result.flowArea;
        plantConn.length = result.length;

        // Also update the simulation connection directly for immediate effect
        simConn.flowArea = result.flowArea;
        simConn.fromElevation = result.fromElevation;
        simConn.toElevation = result.toElevation;
        // Note: length affects inertance which is calculated at simulation start,
        // so changing it during simulation won't have full effect until restart


        // Refresh the component detail panel
        const selectedId = plantCanvas.getSelectedComponentId?.();
        if (selectedId) {
          updateComponentDetail(selectedId, plantState, simState);
        }
      }
    });
  });

  // Plant connection edit callback (before simulation starts)
  setPlantConnectionEditCallback((fromId: string, toId: string) => {
    // Find the plant connection
    const plantConn = plantState.connections.find(pc =>
      (pc.fromComponentId === fromId && pc.toComponentId === toId) ||
      (pc.fromComponentId === toId && pc.toComponentId === fromId)
    );

    if (!plantConn) {
      console.error(`[Edit] Plant connection ${fromId} → ${toId} not found`);
      return;
    }

    // Get the components
    const fromComponent = plantState.components.get(plantConn.fromComponentId);
    const toComponent = plantState.components.get(plantConn.toComponentId);

    if (!fromComponent || !toComponent) {
      console.error(`[Edit] Components not found for connection`);
      return;
    }

    // Show the edit dialog
    connectionDialog.edit(plantConn, fromComponent, toComponent, (result: ConnectionEditResult | null) => {
      if (result) {
        // Update the connection with new values
        plantConn.fromElevation = result.fromElevation;
        plantConn.toElevation = result.toElevation;
        plantConn.flowArea = result.flowArea;
        plantConn.length = result.length;


        // Refresh the component detail panel
        const selectedId = plantCanvas.getSelectedComponentId?.();
        if (selectedId) {
          updateComponentDetail(selectedId, plantState, gameLoop?.getState() || {} as SimulationState);
        }
      }
    });
  });

  // Connection delete callback
  setConnectionDeleteCallback((fromId: string, toId: string) => {
    if (confirm(`Delete connection between ${fromId} and ${toId}?`)) {
      const deleted = constructionManager.deleteConnection(fromId, toId);
      if (deleted) {
        // Refresh the component detail panel
        const selectedId = plantCanvas.getSelectedComponentId?.();
        if (selectedId) {
          updateComponentDetail(selectedId, plantState, gameLoop?.getState() || {} as SimulationState);
        }
      }
    }
  });

  // Connection mode state
  let connectingFrom: { component: any, port: any } | null = null;
  const connectModeBtn = document.getElementById('connect-mode-btn') as HTMLButtonElement;
  const connectionInfo = document.getElementById('connection-info') as HTMLDivElement;
  const connectionStatus = document.getElementById('connection-status') as HTMLDivElement;

  // Move mode button
  const moveModeBtn = document.getElementById('move-mode') as HTMLButtonElement;

  // Isometric view toggle
  const isometricBtn = document.getElementById('toggle-isometric') as HTMLButtonElement;
  if (isometricBtn) {
    isometricBtn.addEventListener('click', () => {
      plantCanvas.toggleIsometric();
      isometricBtn.classList.toggle('active', plantCanvas.getIsometric());
    });
  }

  // View elevation slider (controls both camera height and view angle)
  const viewElevationSlider = document.getElementById('view-elevation') as HTMLInputElement;
  const viewElevationValue = document.getElementById('view-elevation-value');
  if (viewElevationSlider) {
    viewElevationSlider.addEventListener('input', () => {
      const value = parseInt(viewElevationSlider.value, 10);
      plantCanvas.setViewElevation(value);
      if (viewElevationValue) {
        viewElevationValue.textContent = String(value);
      }
    });

    // Initialize slider position and apply initial value
    const initialValue = parseInt(viewElevationSlider.value, 10);
    plantCanvas.setViewElevation(initialValue);
    if (viewElevationValue) {
      viewElevationValue.textContent = String(initialValue);
    }
  }

  // ============================================================================
  // Save/Load Configuration
  // ============================================================================
  const STORAGE_PREFIX = 'meltdown_config_';
  const openSaveLoadBtn = document.getElementById('open-save-load-btn') as HTMLButtonElement;

  // Serialize PlantState to JSON-compatible object
  function serializePlantState(state: PlantState): object {
    return {
      components: Array.from(state.components.entries()),
      connections: state.connections,
    };
  }

  // Deserialize JSON object back to PlantState
  function deserializePlantState(data: any): void {
    plantState.components.clear();
    plantState.connections = [];

    if (data.components) {
      for (const [id, component] of data.components) {
        plantState.components.set(id, component);
      }
    }

    if (data.connections) {
      plantState.connections = data.connections;
    }

    // Migration: convert legacy reactor vessels (sibling architecture) to new architecture (parent-child)
    migrateReactorVessels(plantState);

    // Migration: ensure pipes have endPosition for proper 3D rendering
    migratePipeEndpoints(plantState);

    // Restore construction-path invariants (port.connectedTo flags, canonical
    // pump port geometry/orientation) that raw JSON doesn't carry
    constructionManager.normalizeLoadedPlant();
  }

  // Migrate pipes to have endPosition and endElevation for 3D rendering
  function migratePipeEndpoints(state: PlantState): void {
    for (const [_id, component] of state.components) {
      if (component.type !== 'pipe') continue;
      const pipe = component as PipeComponent;

      // Skip if already has endPosition
      if (pipe.endPosition) continue;

      // Calculate endPosition from start position and length
      // Pipe extends in +X direction in local coordinates
      // Apply rotation to get world coordinates
      const cos = Math.cos(pipe.rotation);
      const sin = Math.sin(pipe.rotation);
      const localEndX = pipe.length;
      const localEndY = 0;

      pipe.endPosition = {
        x: pipe.position.x + localEndX * cos - localEndY * sin,
        y: pipe.position.y + localEndX * sin + localEndY * cos
      };

      // endElevation: use elevation if set, otherwise default to 0
      // For legacy pipes without elevation, assume horizontal
      pipe.endElevation = pipe.elevation ?? 0;

    }
  }

  // Migrate reactor vessels from old architecture (insideBarrelId, outsideBarrelId)
  // to new architecture (coreBarrelId, vessel IS downcomer)
  function migrateReactorVessels(state: PlantState): void {
    for (const [id, component] of state.components) {
      if (component.type !== 'reactorVessel') continue;
      const rv = component as any;

      // Skip if already migrated or new architecture
      if (rv.coreBarrelId) continue;
      if (!rv.insideBarrelId || !rv.outsideBarrelId) continue;


      const insideBarrel = state.components.get(rv.insideBarrelId) as any;
      const outsideBarrel = state.components.get(rv.outsideBarrelId) as any;

      if (!insideBarrel || !outsideBarrel) {
        console.warn(`[Migration] Could not find sub-components for reactor vessel ${id}`);
        continue;
      }

      // Create new CoreBarrel component from inside barrel
      const coreBarrelId = `${id}-core`;
      const coreBarrel: any = {
        id: coreBarrelId,
        type: 'coreBarrel',
        label: `${rv.label || 'Reactor'} Core`,
        position: rv.position,
        rotation: rv.rotation,
        elevation: rv.elevation,
        ports: [],
        fluid: insideBarrel.fluid,
        containedBy: id,
        innerDiameter: rv.barrelDiameter - rv.barrelThickness,
        thickness: rv.barrelThickness,
        height: rv.height - rv.barrelBottomGap - rv.barrelTopGap,
        bottomGap: rv.barrelBottomGap,
        topGap: rv.barrelTopGap,
        // Transfer fuel properties from vessel
        fuelRodCount: rv.fuelRodCount,
        actualFuelRodCount: rv.actualFuelRodCount,
        fuelTemperature: rv.fuelTemperature,
        fuelMeltingPoint: rv.fuelMeltingPoint,
        controlRodCount: rv.controlRodCount,
        controlRodPosition: rv.controlRodPosition,
      };

      // Create ports for core barrel
      coreBarrel.ports = [
        { id: `${coreBarrelId}-bottom`, position: { x: 0, y: coreBarrel.height / 2 }, direction: 'both' as const },
        { id: `${coreBarrelId}-top`, position: { x: 0, y: -coreBarrel.height / 2 }, direction: 'both' as const },
      ];

      // Transfer ports from outside barrel to vessel (for external connections)
      // Copy ports that aren't internal connections
      rv.ports = [];
      for (const port of outsideBarrel.ports || []) {
        if (!port.id.includes('internal')) {
          rv.ports.push({
            ...port,
            id: port.id.replace(rv.outsideBarrelId, id),
          });
        }
      }

      // Transfer fluid from outside barrel to vessel (vessel is now the downcomer)
      rv.fluid = outsideBarrel.fluid || rv.outsideBarrelFluid;

      // Set new reference
      rv.coreBarrelId = coreBarrelId;

      // Clear fuel properties from vessel (they're on core barrel now)
      delete rv.fuelRodCount;
      delete rv.actualFuelRodCount;
      delete rv.fuelTemperature;
      delete rv.fuelMeltingPoint;
      delete rv.controlRodCount;
      delete rv.controlRodPosition;

      // Add the new core barrel
      state.components.set(coreBarrelId, coreBarrel);

      // Update connections to point to new component IDs
      for (const conn of state.connections) {
        // Connections to inside barrel now go to core barrel
        if (conn.fromComponentId === rv.insideBarrelId) {
          conn.fromComponentId = coreBarrelId;
          conn.fromPortId = conn.fromPortId.replace(rv.insideBarrelId, coreBarrelId);
        }
        if (conn.toComponentId === rv.insideBarrelId) {
          conn.toComponentId = coreBarrelId;
          conn.toPortId = conn.toPortId.replace(rv.insideBarrelId, coreBarrelId);
        }
        // Connections to outside barrel now go to vessel
        if (conn.fromComponentId === rv.outsideBarrelId) {
          conn.fromComponentId = id;
          conn.fromPortId = conn.fromPortId.replace(rv.outsideBarrelId, id);
        }
        if (conn.toComponentId === rv.outsideBarrelId) {
          conn.toComponentId = id;
          conn.toPortId = conn.toPortId.replace(rv.outsideBarrelId, id);
        }
      }

      // Remove old sub-components
      state.components.delete(rv.insideBarrelId);
      state.components.delete(rv.outsideBarrelId);

      // Keep legacy fields for reference (they're marked as deprecated in types)
      // Don't delete them so we can track what was migrated

    }
  }

  // Get list of saved configuration names
  function getSavedConfigNames(): string[] {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        names.push(key.substring(STORAGE_PREFIX.length));
      }
    }
    return names.sort();
  }

  // Save current configuration. In simulation mode the running simulation
  // state rides along with the design, so loading resumes mid-run.
  function saveConfiguration(name: string): boolean {
    try {
      const data = serializePlantState(plantState) as Record<string, unknown>;
      if (currentMode === 'simulation') {
        const sim = gameLoop.getState();
        if (sim && sim.flowNodes.size > 0) {
          data.simState = serializeSimulationState(sim);
        }
      }
      const json = JSON.stringify(data);
      localStorage.setItem(STORAGE_PREFIX + name, json);
      return true;
    } catch (e) {
      console.error('[Save] Failed to save configuration:', e);
      return false;
    }
  }

  /**
   * A loaded config carried a running-simulation snapshot: rebuild the sim
   * from the design (operators, geometry), then swap the saved state in and
   * leave it paused at the saved time.
   */
  function restoreSimStateIfPresent(data: Record<string, unknown>): void {
    if (!data.simState) return;
    try {
      const restored = deserializeSimulationState(data.simState as Record<string, unknown>);
      setMode('simulation');
      if (currentMode !== 'simulation') {
        // career mode vetoed the switch (e.g. not built yet)
        showNotification('Design loaded; the saved simulation state was skipped (simulation mode unavailable right now).', 'warning');
        return;
      }
      gameLoop.setSimulationState(restored);
      plantCanvas.setSimState(restored);
      syncSimulationToVisuals(restored, plantState);
      updatePauseButton();
      showNotification(`Simulation restored at t=${restored.time.toFixed(0)} s (paused)`, 'info');
    } catch (e) {
      console.error('[Load] Failed to restore simulation state:', e);
      showNotification(`Design loaded, but restoring the running simulation failed: ${String(e)}`, 'error');
    }
  }

  // Load configuration by name
  function loadConfiguration(name: string): boolean {
    try {
      const json = localStorage.getItem(STORAGE_PREFIX + name);
      if (!json) {
        console.error(`[Load] Configuration '${name}' not found`);
        return false;
      }

      const data = JSON.parse(json);
      deserializePlantState(data);
      restoreSimStateIfPresent(data);
      return true;
    } catch (e) {
      console.error('[Load] Failed to load configuration:', e);
      return false;
    }
  }

  // Delete configuration by name
  function deleteConfiguration(name: string): boolean {
    try {
      localStorage.removeItem(STORAGE_PREFIX + name);
      return true;
    } catch (e) {
      console.error('[Delete] Failed to delete configuration:', e);
      return false;
    }
  }

  // Show Save/Load dialog
  function showSaveLoadDialog(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #1a1e24; border: 1px solid #445566; border-radius: 8px;
      padding: 20px; min-width: 320px; max-width: 400px; color: #d0d8e0;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;

    const configs = getSavedConfigNames();
    const configOptions = configs.length > 0
      ? configs.map(name => `<option value="${name}">${name}</option>`).join('')
      : '';

    dialog.innerHTML = `
      <h3 style="margin: 0 0 15px 0; color: #7af;">Save / Load Configuration</h3>

      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; color: #99aacc; font-size: 12px;"
          title="In simulation mode the running simulation state is saved with the design - loading it resumes at the same moment, paused.">
          Save Current Design${currentMode === 'simulation' ? ' + Running Simulation' : ''}</label>
        <div style="display: flex; gap: 5px;">
          <input type="text" id="save-name-input" placeholder="Enter name..."
            style="flex: 1; padding: 8px; background: #2a2e38; border: 1px solid #445566;
            border-radius: 4px; color: #d0d8e0;" />
          <button id="dialog-save-btn" style="padding: 8px 16px; background: #2a5a8a;
            border: 1px solid #4a8aba; border-radius: 4px; color: #fff; cursor: pointer;">
            Save
          </button>
        </div>
      </div>

      <hr style="border: none; border-top: 1px solid #445566; margin: 15px 0;" />

      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; color: #99aacc; font-size: 12px;">Load Preset Plant</label>
        <div id="dialog-preset-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
        </div>
      </div>

      <hr style="border: none; border-top: 1px solid #445566; margin: 15px 0;" />

      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; color: #99aacc; font-size: 12px;">Load Saved Design</label>
        <select id="dialog-config-select" style="width: 100%; padding: 8px; margin-bottom: 8px;
          background: #2a2e38; color: #d0d8e0; border: 1px solid #445566; border-radius: 4px;">
          <option value="">-- Select Configuration --</option>
          ${configOptions}
        </select>
        <div style="display: flex; gap: 5px;">
          <button id="dialog-load-btn" style="flex: 1; padding: 8px; background: #334455;
            border: 1px solid #556677; border-radius: 4px; color: #d0d8e0; cursor: pointer;">
            Load
          </button>
          <button id="dialog-delete-btn" style="padding: 8px 12px; background: #433;
            border: 1px solid #644; border-radius: 4px; color: #d0d8e0; cursor: pointer;">
            Delete
          </button>
          <button id="dialog-export-btn" style="padding: 8px 12px; background: #353;
            border: 1px solid #464; border-radius: 4px; color: #d0d8e0; cursor: pointer;">
            Export
          </button>
          <button id="dialog-import-btn" style="padding: 8px 12px; background: #335;
            border: 1px solid #446; border-radius: 4px; color: #d0d8e0; cursor: pointer;">
            Import
          </button>
          <input type="file" id="dialog-import-file" accept=".json" style="display: none;">
        </div>
      </div>

      <div style="text-align: right; margin-top: 15px;">
        <button id="dialog-close-btn" style="padding: 8px 20px; background: #334455;
          border: 1px solid #556677; border-radius: 4px; color: #d0d8e0; cursor: pointer;">
          Close
        </button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const saveNameInput = dialog.querySelector('#save-name-input') as HTMLInputElement;
    const configSelect = dialog.querySelector('#dialog-config-select') as HTMLSelectElement;
    const presetGrid = dialog.querySelector('#dialog-preset-grid') as HTMLDivElement;
    const saveBtn = dialog.querySelector('#dialog-save-btn') as HTMLButtonElement;
    const loadBtn = dialog.querySelector('#dialog-load-btn') as HTMLButtonElement;
    const deleteBtn = dialog.querySelector('#dialog-delete-btn') as HTMLButtonElement;
    const exportBtn = dialog.querySelector('#dialog-export-btn') as HTMLButtonElement;
    const importBtn = dialog.querySelector('#dialog-import-btn') as HTMLButtonElement;
    const importFileInput = dialog.querySelector('#dialog-import-file') as HTMLInputElement;
    const closeBtn = dialog.querySelector('#dialog-close-btn') as HTMLButtonElement;

    const cleanup = () => document.body.removeChild(overlay);

    const refreshConfigs = () => {
      const names = getSavedConfigNames();
      configSelect.innerHTML = '<option value="">-- Select Configuration --</option>' +
        names.map(name => `<option value="${name}">${name}</option>`).join('');
    };

    const loadPreset = (presetData: unknown, label: string) => {
      // Presets are shared, cached JSON module objects - deserializePlantState (and its
      // migration passes) mutate component objects in place, so clone before loading
      // to avoid corrupting the preset for future loads in this session.
      const data = JSON.parse(JSON.stringify(presetData));
      deserializePlantState(data);
      updateConstructionCostPanel();
      showNotification(`Loaded '${label}' preset`, 'info');
      cleanup();
    };

    // Preset catalog: working plants first, then accident scenarios.
    // Tooltips explain what each one is and what to expect.
    const PRESETS: Array<{ label: string; data: unknown; tooltip: string }> = [
      {
        label: 'PWR', data: pwrPresetData,
        tooltip: 'Pressurized water reactor with a full automatic control suite ' +
          '(rods, turbine governor, feedwater, pressurizer). Converges to 100% power on its own.',
      },
      {
        label: 'BWR', data: bwrPresetData,
        tooltip: 'Boiling water reactor. Manually operated - you drive the rods, ' +
          'recirculation, and feedwater yourself.',
      },
      {
        label: 'HTGR (Pebble Bed)', data: htgrPresetData,
        tooltip: 'Helium-cooled, graphite-moderated pebble-bed reactor (250 MWt) with a ' +
          'helical steam generator. Losing the helium barely changes reactivity, and the ' +
          'graphite pebbles are a huge passive heat sink.',
      },
      {
        label: 'Two-Loop PWR', data: twoLoopPresetData,
        tooltip: 'PWR with two parallel coolant loops sharing one core - watch the loops ' +
          'share load, or idle one and see the asymmetry.',
      },
      {
        label: '4-Loop PWR (W)', data: w4loopPresetData,
        tooltip: 'Westinghouse-style 4-loop PWR (~3400 MWt / ~1150 MWe) with the full safety ' +
          'lineup: pressurizer PORV + safety to a relief tank, per-SG feed trains and MSSVs, ' +
          'turbine-driven aux feedwater, N2 accumulators, and HPI/LPI from the RWST.',
      },
      {
        label: 'Prompt Criticality', data: promptCritPresetData,
        tooltip: 'Reactivity accident demo: a reactor set up to go prompt-critical. ' +
          'Doppler feedback quenches the excursion, but not before the fuel takes a beating.',
      },
      {
        label: 'Station Blackout', data: sboPresetData,
        tooltip: 'Full-power PWR with every pump dead and no automatic controls. ' +
          'Surprisingly stable at first: feedback throttles the reactor and natural ' +
          'circulation carries decay heat to the steam generators - until inventories run out.',
      },
      {
        label: 'Meltdown Demo', data: meltdownDemoPresetData,
        tooltip: 'Severe-accident showcase: a freshly scrammed core with full decay heat, ' +
          'almost no water, and a flimsy containment. Dryout, cladding oxidation (hydrogen!), ' +
          'fuel melt, and fission-product release to the environment - in about 10 minutes.',
      },
    ];
    for (const preset of PRESETS) {
      const btn = document.createElement('button');
      btn.textContent = preset.label;
      btn.title = preset.tooltip;
      btn.style.cssText = 'padding: 8px; background: #334455; border: 1px solid #556677; ' +
        'border-radius: 4px; color: #d0d8e0; cursor: pointer;';
      btn.addEventListener('click', () => loadPreset(preset.data, preset.label));
      presetGrid.appendChild(btn);
    }

    saveBtn.addEventListener('click', () => {
      const name = saveNameInput.value.trim();
      if (!name) {
        showNotification('Enter a name for the configuration', 'warning');
        return;
      }
      // Check if configuration already exists
      const existingConfigs = getSavedConfigNames();
      if (existingConfigs.includes(name)) {
        if (!confirm(`Configuration '${name}' already exists. Overwrite?`)) {
          return;
        }
      }
      if (saveConfiguration(name)) {
        showNotification(`Saved '${name}'`, 'info');
        cleanup();
      }
    });

    loadBtn.addEventListener('click', () => {
      const name = configSelect.value;
      if (!name) {
        showNotification('Select a configuration to load', 'warning');
        return;
      }
      if (loadConfiguration(name)) {
        showNotification(`Loaded '${name}'`, 'info');
        updateConstructionCostPanel();
        cleanup();
      }
    });

    deleteBtn.addEventListener('click', () => {
      const name = configSelect.value;
      if (!name) {
        showNotification('Select a configuration to delete', 'warning');
        return;
      }
      if (confirm(`Delete '${name}'?`)) {
        if (deleteConfiguration(name)) {
          showNotification(`Deleted '${name}'`, 'info');
          refreshConfigs();
        }
      }
    });

    exportBtn.addEventListener('click', () => {
      const name = configSelect.value;
      if (!name) {
        showNotification('Select a configuration to export', 'warning');
        return;
      }
      const json = localStorage.getItem(STORAGE_PREFIX + name);
      if (!json) {
        showNotification('Configuration not found', 'error');
        return;
      }
      // Create downloadable file
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showNotification(`Exported '${name}.json'`, 'info');
    });

    importBtn.addEventListener('click', () => {
      importFileInput.click();
    });

    importFileInput.addEventListener('change', () => {
      const file = importFileInput.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const json = e.target?.result as string;
          const data = JSON.parse(json);

          // Validate the data has the expected structure
          if (!data.components || !Array.isArray(data.components)) {
            showNotification('Invalid configuration file: missing components', 'error');
            return;
          }

          // Load directly into plant state
          deserializePlantState(data);
          updateConstructionCostPanel();
          showNotification(`Imported '${file.name}'`, 'info');
          restoreSimStateIfPresent(data);
          cleanup();
        } catch (err) {
          console.error('[Import] Failed to parse JSON:', err);
          showNotification('Failed to import: invalid JSON file', 'error');
        }
      };
      reader.onerror = () => {
        showNotification('Failed to read file', 'error');
      };
      reader.readAsText(file);

      // Reset the input so the same file can be selected again
      importFileInput.value = '';
    });

    closeBtn.addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', escHandler); }
    });

    saveNameInput.focus();
  }

  // Open Save/Load dialog button
  if (openSaveLoadBtn) {
    openSaveLoadBtn.addEventListener('click', showSaveLoadDialog);
  }

  function setMode(mode: 'construction' | 'simulation'): void {
    // Career mode gates mode switches (BUILD required before operating;
    // returning to construction mid-run is an outage with repair billing)
    if (gameMode && !gameMode.beforeModeSwitch(mode)) {
      return;
    }
    currentMode = mode;

    if (mode === 'construction') {
      // Construction mode
      modeConstructionBtn?.classList.add('active');
      modeSimulationBtn?.classList.remove('active');

      // Hide simulation controls, show construction controls
      if (simControls) simControls.style.display = 'none';
      if (constructionControls) constructionControls.style.display = 'block';
      if (constructionCostPanel) {
        constructionCostPanel.style.display = 'block';
        updateConstructionCostPanel();
      }

      // Hide MW to grid panel in construction mode
      const mwPanel = document.getElementById('mw-to-grid-panel');
      if (mwPanel) mwPanel.style.display = 'none';

      // Enable construction mode visuals (grid, outlines)
      plantCanvas.setConstructionMode(true);
      plantCanvas.setMoveMode(constructionSubMode === 'move');

      // Pause simulation
      gameLoop.pause();

    } else {
      // Simulation mode
      modeConstructionBtn?.classList.remove('active');
      modeSimulationBtn?.classList.add('active');

      // Show simulation controls, hide construction controls
      if (simControls) simControls.style.display = 'block';
      if (constructionControls) constructionControls.style.display = 'none';
      if (constructionCostPanel) constructionCostPanel.style.display = 'none';

      // Show MW to grid panel in simulation mode
      const mwPanel = document.getElementById('mw-to-grid-panel');
      if (mwPanel) mwPanel.style.display = 'block';

      // Disable construction mode visuals
      plantCanvas.setConstructionMode(false);
      plantCanvas.setMoveMode(false);

      // Clear component selection
      selectedComponentType = null;
      constructionButtons.forEach(btn => btn.classList.remove('selected'));
      if (selectedComponentDiv) selectedComponentDiv.textContent = 'No component selected';
      if (placementHintDiv) placementHintDiv.style.display = 'none';

      // Always create simulation state from current plant configuration
      // (even if empty - this replaces the demo plant with an empty simulation)
      // Set random seed for deterministic mode
      const deterministicCheckbox = document.getElementById('deterministic-mode') as HTMLInputElement;
      setSimulationRandomSeed(deterministicCheckbox?.checked ? 0 : undefined);
      const newSimState = createSimulationFromPlant(plantState);
      gameLoop.setSimulationState(newSimState);
      plantCanvas.setSimState(newSimState);

      // Sync simulation state back to plant components for correct rendering
      // This is needed before simulation starts so components display correctly
      syncSimulationToVisuals(newSimState, plantState);

      // Immediately update debug panel to show new configuration
      const currentState = gameLoop.getState();
      const emptyMetrics: SolverMetrics = {
        currentDt: 0,
        actualDt: 0,
        maxStableDt: Infinity,
        dtLimitedBy: 'none',
        stabilityLimitedBy: 'none',
        minDtUsed: 0,
        subcycleCount: 0,
        totalSteps: 0,
        lastStepWallTime: 0,
        avgStepWallTime: 0,
        retriesThisFrame: 0,
        maxPressureChange: 0,
        maxFlowChange: 0,
        maxMassChange: 0,
        consecutiveSuccesses: 0,
        topErrorContributors: [],
        realTimeRatio: 0,
        isFallingBehind: false,
        fallingBehindSince: 0,
        operatorTimes: new Map(),
        lastSimTime: 0,
      };
      updateDebugPanel(currentState, emptyMetrics, gameLoop.getPressureSolverStatus());

      if (plantState.components.size > 0) {
      } else {
      }

      // Start paused so the user can look the plant over (and step through)
      // before time starts moving; career mode resumes explicitly when the
      // plant goes online
      gameLoop.pause();

      // Update pause button to reflect actual paused state
      updatePauseButton();

    }
  }

  if (modeConstructionBtn) {
    modeConstructionBtn.addEventListener('click', () => setMode('construction'));
  }

  if (modeSimulationBtn) {
    modeSimulationBtn.addEventListener('click', () => setMode('simulation'));
  }

  // Component selection handlers
  constructionButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const button = e.target as HTMLButtonElement;
      const componentType = button.dataset.component;

      if (!componentType) return;

      // If clicking the same component again, deselect it
      if (selectedComponentType === componentType) {
        constructionButtons.forEach(b => b.classList.remove('selected'));
        selectedComponentType = null;
        if (selectedComponentDiv) {
          selectedComponentDiv.textContent = 'Select a component to place';
        }
        if (placementHintDiv) {
          placementHintDiv.style.display = 'none';
        }
        return;
      }

      // If in connect or move mode, switch to place mode
      if (constructionSubMode !== 'place') {
        setConstructionSubMode('place');
      }

      // Clear previous selection
      constructionButtons.forEach(b => b.classList.remove('selected'));

      // Select this component
      button.classList.add('selected');
      selectedComponentType = componentType;

      // Update UI
      if (selectedComponentDiv) {
        selectedComponentDiv.textContent = `Selected: ${button.textContent}`;
      }
      if (placementHintDiv) {
        placementHintDiv.style.display = 'block';
      }

    });
  });

  // Move mode state
  let movingComponent: PlantComponent | null = null;
  let moveStartOffset = { x: 0, y: 0 };
  let isDraggingComponent = false;
  let moveMouseDownPos = { x: 0, y: 0 }; // to distinguish a click from a drag
  // For pipes: which end is being dragged ('start', 'end', or 'both')
  let pipeDragMode: 'start' | 'end' | 'both' = 'both';
  // For pipes: offset from end position when dragging 'end'
  let moveEndOffset = { x: 0, y: 0 };
  // Buildings only move via the "Move Building" button (too easy to grab by
  // accident otherwise). moveLocked = grabbed a building without arming it, so
  // the drag is a no-op. armedMoveId = a component armed for a deliberate move.
  let moveLocked = false;
  let armedMoveId: string | null = null;
  // Pre-drag snapshot so a cancelled containment change can be reverted
  let movePreDrag: { x: number; y: number; endX?: number; endY?: number; containedBy?: string } | null = null;

  // Find the building whose footprint contains a world position (or null).
  function findContainingBuilding(worldPos: { x: number; y: number }): PlantComponent | null {
    for (const [, comp] of plantState.components) {
      if (comp.type !== 'building') continue;
      const b = comp as any;
      const halfW = b.shape === 'cylinder' ? (b.diameter || 40) / 2 : (b.width || 40) / 2;
      const halfD = b.shape === 'cylinder' ? (b.diameter || 40) / 2 : (b.length || 40) / 2;
      const dx = worldPos.x - comp.position.x;
      const dy = worldPos.y - comp.position.y;
      const inside = b.shape === 'cylinder'
        ? (dx * dx) / (halfW * halfW) + (dy * dy) / (halfD * halfD) <= 1
        : Math.abs(dx) <= halfW && Math.abs(dy) <= halfD;
      if (inside) return comp;
    }
    return null;
  }

  // Canvas mouse move handler for visual feedback and dragging
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // DEBUG: Track cursor position for gauge debug logging
    (window as any).__debugCursor = { x: Math.round(x), y: Math.round(y) };

    // Port tooltip - show on hover in any mode
    const hoveredPortInfo = plantCanvas.getPortAtScreen({ x, y });
    if (hoveredPortInfo && portTooltip) {
      const { component, port, worldPos } = hoveredPortInfo;
      const portType = getPortTypeLabel(port.id, component.id);
      const elevation = component.elevation ?? 0;

      // Calculate port elevation offset (some ports are above/below component center)
      // For most components, port.position.y affects elevation
      let portElevation = elevation;
      if (component.type === 'tank' || component.type === 'vessel' || component.type === 'reactorVessel' || component.type === 'heatExchanger') {
        // Vertical components: port Y offset is vertical
        // For HX, the component.elevation is the shell bottom, and port positions already include plenum offset
        portElevation = elevation - port.position.y;
      }

      portTooltip.innerHTML = `
        <div class="port-component">${component.label || component.id}</div>
        <div class="port-type">${portType}</div>
        <div class="port-coords">Position: (${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}) m</div>
        <div class="port-coords">Elevation: ${portElevation.toFixed(1)} m</div>
      `;

      // Position tooltip near cursor
      portTooltip.style.left = `${e.clientX + 15}px`;
      portTooltip.style.top = `${e.clientY + 10}px`;
      portTooltip.classList.add('visible');
    } else if (portTooltip) {
      portTooltip.classList.remove('visible');
    }

    if (currentMode !== 'construction') {
      // Clear placement preview when not in construction mode
      plantCanvas.setPlacementPreview(null, null);
      return;
    }

    if (constructionSubMode === 'connect') {
      const hoveredPort = plantCanvas.getPortAtScreen({ x, y });
      if (hoveredPort) {
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'default';
      }
      // Clear placement preview in connect mode
      plantCanvas.setPlacementPreview(null, null);
    } else if (constructionSubMode === 'move') {
      if (isDraggingComponent && movingComponent && !moveLocked) {
        // Dragging - move the component
        const worldClick = plantCanvas.getWorldPositionFromScreen({ x, y });

        // Handle pipes with endpoint data specially
        if (movingComponent.type === 'pipe') {
          const pipe = movingComponent as PipeComponent;
          if (pipe.endPosition) {
            if (pipeDragMode === 'start') {
              // Move only start position
              pipe.position.x = worldClick.x - moveStartOffset.x;
              pipe.position.y = worldClick.y - moveStartOffset.y;
              // Recalculate length
              const dx = pipe.endPosition.x - pipe.position.x;
              const dy = pipe.endPosition.y - pipe.position.y;
              const dz = (pipe.endElevation ?? 0) - (pipe.elevation ?? 0);
              pipe.length = Math.sqrt(dx*dx + dy*dy + dz*dz);
            } else if (pipeDragMode === 'end') {
              // Move only end position
              pipe.endPosition.x = worldClick.x - moveEndOffset.x;
              pipe.endPosition.y = worldClick.y - moveEndOffset.y;
              // Recalculate length
              const dx = pipe.endPosition.x - pipe.position.x;
              const dy = pipe.endPosition.y - pipe.position.y;
              const dz = (pipe.endElevation ?? 0) - (pipe.elevation ?? 0);
              pipe.length = Math.sqrt(dx*dx + dy*dy + dz*dz);
            } else {
              // Move both ends together (translate the whole pipe)
              const dx = worldClick.x - moveStartOffset.x - pipe.position.x;
              const dy = worldClick.y - moveStartOffset.y - pipe.position.y;
              pipe.position.x += dx;
              pipe.position.y += dy;
              pipe.endPosition.x += dx;
              pipe.endPosition.y += dy;
            }
            // Update port position
            const rightPort = pipe.ports.find(p => p.id.endsWith('-right'));
            if (rightPort) {
              rightPort.position.x = pipe.length;
            }
          } else {
            // No endpoint data, move position only
            movingComponent.position.x = worldClick.x - moveStartOffset.x;
            movingComponent.position.y = worldClick.y - moveStartOffset.y;
          }
        } else {
          // Non-pipe components: move normally
          movingComponent.position.x = worldClick.x - moveStartOffset.x;
          movingComponent.position.y = worldClick.y - moveStartOffset.y;
        }
        // Update component detail panel to show new position immediately
        if (selectedComponentId) {
          updateComponentDetail(selectedComponentId, plantState, gameLoop.getState());
        }
        canvas.style.cursor = 'grabbing';
      } else {
        // Not dragging - show move cursor on hover
        const hoveredComponent = plantCanvas.getComponentAtScreen({ x, y });
        if (hoveredComponent) {
          canvas.style.cursor = 'grab';
        } else {
          canvas.style.cursor = 'default';
        }
      }
      // Clear placement preview in move mode
      plantCanvas.setPlacementPreview(null, null);
    } else if (constructionSubMode === 'place' && selectedComponentType) {
      // Show placement preview footprint following cursor
      const worldPos = plantCanvas.getWorldPositionFromScreen({ x, y });
      plantCanvas.setPlacementPreview(selectedComponentType, worldPos);
      canvas.style.cursor = 'crosshair';
    } else {
      // Clear placement preview when not in place mode
      plantCanvas.setPlacementPreview(null, null);
    }
  });

  // Mouse down handler for starting drag in move mode
  canvas.addEventListener('mousedown', (e) => {
    if (currentMode !== 'construction') return;
    if (constructionSubMode !== 'move') return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // If a component was armed via its "Move" button, that specific component
    // is grabbed wherever the user clicks (this is how buildings move).
    let component = armedMoveId ? plantState.components.get(armedMoveId) ?? null : null;
    const armedThisPress = component !== null;
    if (!component) {
      component = plantCanvas.getComponentAtScreen({ x, y });
    }
    if (component) {
      // Buildings are only movable when deliberately armed - otherwise a drag
      // that grabbed a building is locked (a click still selects it on mouseup).
      moveLocked = component.type === 'building' && !armedThisPress;

      // Start dragging this component
      movingComponent = component;
      isDraggingComponent = true;
      moveMouseDownPos = { x, y };
      movePreDrag = {
        x: component.position.x,
        y: component.position.y,
        endX: (component as PipeComponent).endPosition?.x,
        endY: (component as PipeComponent).endPosition?.y,
        containedBy: (component as any).containedBy,
      };

      // Calculate offset from component position to click point
      const worldClick = plantCanvas.getWorldPositionFromScreen({ x, y });

      // For pipes with endpoint data, determine which end is nearest using screen-space distance
      if (component.type === 'pipe') {
        const pipe = component as PipeComponent;
        if (pipe.endPosition) {
          // Get screen positions of pipe endpoints
          const startScreen = plantCanvas.getScreenPositionFromWorld(pipe.position, pipe.elevation ?? 0);
          const endScreen = plantCanvas.getScreenPositionFromWorld(pipe.endPosition, pipe.endElevation ?? 0);

          // Calculate screen-space distances
          const distToStart = Math.hypot(x - startScreen.x, y - startScreen.y);
          const distToEnd = Math.hypot(x - endScreen.x, y - endScreen.y);
          const pipeScreenLength = Math.hypot(endScreen.x - startScreen.x, endScreen.y - startScreen.y);

          // Threshold: within 30% of pipe length from either end = move that end
          const endThreshold = pipeScreenLength * 0.3;

          if (distToStart < endThreshold && distToStart < distToEnd) {
            pipeDragMode = 'start';
          } else if (distToEnd < endThreshold && distToEnd < distToStart) {
            pipeDragMode = 'end';
            moveEndOffset.x = worldClick.x - pipe.endPosition.x;
            moveEndOffset.y = worldClick.y - pipe.endPosition.y;
          } else {
            pipeDragMode = 'both';
          }
        } else {
          pipeDragMode = 'both';
        }
      }

      moveStartOffset.x = worldClick.x - component.position.x;
      moveStartOffset.y = worldClick.y - component.position.y;

      canvas.style.cursor = 'grabbing';
      e.preventDefault(); // Prevent text selection while dragging
    }
  });

  // Hide port tooltip when mouse leaves canvas
  canvas.addEventListener('mouseleave', () => {
    if (portTooltip) {
      portTooltip.classList.remove('visible');
    }
  });

  // Mouse up handler for ending drag in move mode
  canvas.addEventListener('mouseup', (e) => {
    if (isDraggingComponent && movingComponent) {
      // A press-and-release without movement is a click: select instead of move
      const upRect = canvas.getBoundingClientRect();
      const dragDist = Math.hypot(
        e.clientX - upRect.left - moveMouseDownPos.x,
        e.clientY - upRect.top - moveMouseDownPos.y
      );

      const moved = movingComponent;
      const wasLocked = moveLocked;
      const preDrag = movePreDrag;

      // Reset drag state before any (blocking) confirmation dialog
      movingComponent = null;
      isDraggingComponent = false;
      moveStartOffset = { x: 0, y: 0 };
      moveEndOffset = { x: 0, y: 0 };
      pipeDragMode = 'both';
      moveLocked = false;
      armedMoveId = null;
      movePreDrag = null;

      if (dragDist < 4) {
        // A click selects (works for buildings, whose drag is otherwise locked)
        plantCanvas.selectComponent(moved.id);
      } else if (wasLocked) {
        showNotification('To move a building, select it and click "Move Building".', 'info');
      } else {
        // A real move: if it crossed a building boundary, confirm the
        // containment change (and revert the move if the player cancels).
        maybeConfirmContainmentChange(moved, preDrag);
        showNotification(`Moved ${moved.label || moved.id}`, 'info');
      }

      // Check what's under cursor now
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hoveredComponent = plantCanvas.getComponentAtScreen({ x, y });
      canvas.style.cursor = hoveredComponent ? 'grab' : 'default';
    }
  });

  // If a move put a component into or out of a building, ask before changing
  // its containment; on cancel, snap it back to where the drag started.
  function maybeConfirmContainmentChange(
    moved: PlantComponent,
    preDrag: { x: number; y: number; endX?: number; endY?: number; containedBy?: string } | null
  ): void {
    if (!preDrag) return;
    // Buildings and cores are structural containers, not contained items here
    if (moved.type === 'building') return;

    const newBuilding = findContainingBuilding(moved.position);
    const newBuildingId = newBuilding?.id ?? null;
    const prevContainedBy = preDrag.containedBy;
    const prevBuilding = (prevContainedBy &&
      plantState.components.get(prevContainedBy)?.type === 'building') ? prevContainedBy : null;

    if (newBuildingId === prevBuilding) return; // no building-containment change

    const nameOf = (id: string | null) => id ? (plantState.components.get(id)?.label || id) : '';
    let msg: string;
    if (newBuildingId && !prevBuilding) {
      msg = `Move "${moved.label || moved.id}" INTO "${nameOf(newBuildingId)}"?`;
    } else if (!newBuildingId && prevBuilding) {
      msg = `Move "${moved.label || moved.id}" OUT of "${nameOf(prevBuilding)}"?`;
    } else {
      msg = `Move "${moved.label || moved.id}" from "${nameOf(prevBuilding)}" into "${nameOf(newBuildingId)}"?`;
    }

    if (confirm(msg)) {
      if (newBuildingId) (moved as any).containedBy = newBuildingId;
      else delete (moved as any).containedBy;
      updateConstructionCostPanel();
    } else {
      // Revert the move entirely
      moved.position.x = preDrag.x;
      moved.position.y = preDrag.y;
      const pipe = moved as PipeComponent;
      if (pipe.endPosition && preDrag.endX !== undefined && preDrag.endY !== undefined) {
        pipe.endPosition.x = preDrag.endX;
        pipe.endPosition.y = preDrag.endY;
      }
    }
    if (selectedComponentId) {
      updateComponentDetail(selectedComponentId, plantState, gameLoop.getState());
    }
  }

  // Canvas click handler for placing components or making connections
  canvas.addEventListener('click', (e) => {
    if (currentMode !== 'construction') return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Move mode is handled by mousedown/mousemove/mouseup for drag behavior
    if (constructionSubMode === 'move') {
      return; // Don't process clicks in move mode
    }

    if (constructionSubMode === 'place' && selectedComponentType) {
      // Component placement mode - convert screen to world coordinates
      // Uses perspective projection when in isometric mode
      const worldPos = plantCanvas.getWorldPositionFromScreen({ x, y });

      // Check if clicking on an existing container component (tank, vessel, reactor vessel)
      const clickedComponent = plantCanvas.getComponentAtScreen({ x, y });
      const isContainer = clickedComponent && (clickedComponent.type === 'tank' || clickedComponent.type === 'vessel' || clickedComponent.type === 'reactorVessel');

      // Check if click position is inside any building's footprint
      // Buildings auto-contain components without asking
      let containingBuilding: PlantComponent | null = null;
      for (const [, comp] of plantState.components) {
        if (comp.type === 'building') {
          const bldg = comp as any;
          const halfW = bldg.shape === 'cylinder' ? (bldg.diameter || 40) / 2 : (bldg.width || 40) / 2;
          const halfD = bldg.shape === 'cylinder' ? (bldg.diameter || 40) / 2 : (bldg.length || 40) / 2;
          const dx = worldPos.x - comp.position.x;
          const dy = worldPos.y - comp.position.y;

          let isInside = false;
          if (bldg.shape === 'cylinder') {
            // Elliptical footprint check
            isInside = (dx * dx) / (halfW * halfW) + (dy * dy) / (halfD * halfD) <= 1;
          } else {
            // Rectangular footprint check
            isInside = Math.abs(dx) <= halfW && Math.abs(dy) <= halfD;
          }

          if (isInside) {
            containingBuilding = comp;
            break;
          }
        }
      }

      // Function to proceed with component placement
      const proceedWithPlacement = (containedBy?: string) => {
        // If placing inside a container, use the container's position
        let placementPos = worldPos;
        if (containedBy && clickedComponent) {
          placementPos = { ...clickedComponent.position };
        }

        // Get available cores for controller dropdowns
        const availableCores: Array<{ id: string; label: string }> = [];
        if (selectedComponentType === 'scram-controller') {
          for (const [id, comp] of plantState.components) {
            // Include reactor vessels with cores (fuelRodCount defined) and standalone cores
            if (comp.type === 'reactorVessel' || (comp.type === 'vessel' && (comp as any).fuelRodCount)) {
              availableCores.push({ id, label: comp.label || id });
            }
          }
        }

        // Get available generators for switchyard dropdowns
        const availableGenerators: Array<{ id: string; label: string }> = [];
        if (selectedComponentType === 'switchyard') {
          for (const [id, comp] of plantState.components) {
            if (comp.type === 'turbine-generator') {
              availableGenerators.push({ id, label: comp.label || id });
            }
          }
        }

        // PID controllers need plant-derived target lists for their dropdowns
        if (selectedComponentType === 'pid-controller') {
          componentDialog.setDynamicChoices(getPidDynamicChoices(plantState));
        }

        // Generate default name with number matching the ID that will be assigned
        const definition = componentDefinitions[selectedComponentType!];
        let defaultName: string | undefined;
        if (definition) {
          const nextIdNum = constructionManager.getNextIdNumber();
          defaultName = `${definition.displayName} ${nextIdNum}`;
        }

        componentDialog.show(
          selectedComponentType!,
          placementPos,
          (config: ComponentConfig | null) => {
            if (config) {

              // Special case: placing a core inside a container
              if (config.type === 'core' && containedBy && clickedComponent) {
              // Add fuel rod properties to the container (reactor vessel or tank)
              // The container handles rendering the fuel rods at the correct position
              const coreTarget = plantState.components.get(containedBy);
              console.log(`[Placement] core -> addCoreToContainer('${containedBy}' [${coreTarget?.type}]), thermalPower=${config.properties.thermalPower} MWt`);
              const result = constructionManager.addCoreToContainer(containedBy, config.properties);
              if (result.success) {
                // Name the ACTUAL container - it is not always the clicked component
                showNotification(`Added reactor core to ${coreTarget?.label || containedBy}`, 'info');
              } else {
                console.error(`[Construction] Failed to add core to container: ${result.error}`);
                showNotification(result.error || 'Failed to add core to container', 'error');
              }
            } else {
              // Normal component creation
              // Set containment if specified
              if (containedBy) {
                config.containedBy = containedBy;
                // Ensure position and elevation match container
                if (clickedComponent) {
                  config.position = { ...clickedComponent.position };
                  if (clickedComponent.elevation !== undefined) {
                    config.properties = config.properties || {};
                    config.properties.elevation = clickedComponent.elevation;
                  }
                }
              }

              // Actually create and place the component in the plant state
              const componentId = constructionManager.createComponent(config);

              if (componentId) {

                // If a scram controller was placed, update the game loop setpoints
                if (config.type === 'scram-controller') {
                  gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
                }

                // Update construction cost panel
                updateConstructionCostPanel();

                // The canvas will automatically re-render in its render loop
                // Just show success notification. Name the actual container -
                // with building auto-contain there is no clicked component
                // (this used to print "inside undefined").
                const containerComp = containedBy ? plantState.components.get(containedBy) : undefined;
                const containerNote = containedBy ? ` inside ${containerComp?.label || containedBy}` : '';
                showNotification(`Created ${config.name} (${config.type})${containerNote}`, 'info');
              } else {
                console.error(`[Construction] Failed to create component`);
                showNotification(`Failed to create ${config.type}`, 'error');
              }
            }

            // Clear component selection after placing
            selectedComponentType = null;
            constructionButtons.forEach(b => b.classList.remove('selected'));
            if (selectedComponentDiv) {
              selectedComponentDiv.textContent = 'Select a component to place';
            }
            if (placementHintDiv) {
              placementHintDiv.style.display = 'none';
            }
          } else {
          }
        }, availableCores, availableGenerators, defaultName);
      };

      console.log(`[Placement] ${selectedComponentType} click at world (${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}): ` +
        `hit=${clickedComponent ? `${clickedComponent.id} (${clickedComponent.type})` : 'nothing'}, ` +
        `building=${containingBuilding ? containingBuilding.id : 'none'} -> ` +
        `${isContainer && clickedComponent ? 'container prompt' : containingBuilding ? 'auto-contain in building' : 'open ground'}`);

      // Clicking a container component (tank/vessel/reactor vessel) takes
      // priority over the building footprint: ask about the clicked container.
      // (Building-first silently dropped a core "placed in the vessel" into the
      // containment building whenever the click's ground point fell inside the
      // building footprint.)
      if (isContainer && clickedComponent) {
        const containerName = clickedComponent.label || clickedComponent.id;
        showContainmentDialog(containerName, selectedComponentType, (placeInside: boolean | null) => {
          if (placeInside === true) {
            proceedWithPlacement(clickedComponent.id);
          }
          // If placeInside is false/null, user cancelled - do nothing
        });
      } else if (containingBuilding) {
        // Position is inside a building's footprint: auto-contain without dialog
        proceedWithPlacement(containingBuilding.id);
      } else {
        proceedWithPlacement();
      }
    } else if (constructionSubMode === 'connect') {
      // Connection mode - detect clicked port
      const portInfo = plantCanvas.getPortAtScreen({ x, y });

      if (portInfo) {
        if (!connectingFrom) {
          // First click - select source port
          connectingFrom = {
            component: portInfo.component,
            port: portInfo.port
          };
          // Highlight the selected port
          plantCanvas.setHighlightedPort(portInfo.component.id, portInfo.port.id);
          if (connectionStatus) {
            const componentName = portInfo.component.label || portInfo.component.id;
            const portName = portInfo.port.id.split('-').pop(); // Get last part of port ID
            connectionStatus.textContent = `Connecting from ${componentName} (${portName}). Select target port...`;
          }
        } else {
          // Second click - select target port and create connection
          if (portInfo.component.id === connectingFrom.component.id) {
            // Can't connect to self
            showNotification('Cannot connect component to itself', 'warning');
            return;
          }

          // Show connection configuration dialog with port-specific elevations
          connectionDialog.show(
            connectingFrom.component,
            portInfo.component,
            connectingFrom.port,
            portInfo.port,
            (config: ConnectionConfig | null) => {
              if (config) {
                // Create the connection
                let success: boolean;
                if (config.createPipe) {
                  success = constructionManager.createConnectionWithPipe(
                    config.fromPort.id,
                    config.toPort.id,
                    config.flowArea,
                    config.length,
                    config.fromElevation,
                    config.toElevation
                  );
                } else {
                  success = constructionManager.createConnection(
                    config.fromPort.id,
                    config.toPort.id,
                    config.fromElevation,
                    config.toElevation,
                    config.flowArea,
                    config.length
                  );
                }

                if (success) {
                  showNotification(`Connected ${config.fromComponent.label} to ${config.toComponent.label}`, 'info');
                } else {
                  showNotification('Failed to create connection', 'error');
                }
              }

              // Reset connection state
              connectingFrom = null;
              plantCanvas.setHighlightedPort(null, null); // Clear highlight
              if (connectionStatus) {
                connectionStatus.textContent = 'Select first component...';
              }
            }
          );
        }
      }
    }
  });


  // Helper to set construction sub-mode
  function setConstructionSubMode(mode: 'place' | 'connect' | 'move') {
    constructionSubMode = mode;

    // Update button states
    connectModeBtn?.classList.toggle('active', mode === 'connect');
    moveModeBtn?.classList.toggle('active', mode === 'move');

    // Show ports when in connect mode
    plantCanvas.setShowPorts(mode === 'connect');

    // In move mode the canvas must not select on mousedown (it's the start
    // of a click-and-drag; selection happens on mouseup without movement)
    plantCanvas.setMoveMode(mode === 'move');

    // Update UI visibility
    if (connectionInfo) {
      connectionInfo.style.display = mode === 'connect' ? 'block' : 'none';
    }

    // Reset states when switching modes
    if (mode !== 'connect') {
      connectingFrom = null;
      plantCanvas.setHighlightedPort(null, null); // Clear highlight when leaving connect mode
      if (connectionStatus) {
        connectionStatus.textContent = 'Select first component...';
      }
    }

    if (mode !== 'move') {
      movingComponent = null;
      moveStartOffset = { x: 0, y: 0 };
      isDraggingComponent = false;
      canvas.style.cursor = 'default';
    }

    if (mode !== 'place') {
      // Clear component selection when not in place mode
      selectedComponentType = null;
      constructionButtons.forEach(b => b.classList.remove('selected'));
      if (selectedComponentDiv) {
        selectedComponentDiv.textContent = 'No component selected';
      }
      if (placementHintDiv) {
        placementHintDiv.style.display = 'none';
      }
    }

  }

  // Connect mode button handler
  if (connectModeBtn) {
    connectModeBtn.addEventListener('click', () => {
      if (constructionSubMode === 'connect') {
        // Exit connect mode, return to place mode
        setConstructionSubMode('place');
      } else {
        // Enter connect mode
        setConstructionSubMode('connect');
        if (connectionStatus) {
          connectionStatus.textContent = 'Select first component...';
        }
      }
    });
  }

  // Move mode button handler
  if (moveModeBtn) {
    moveModeBtn.addEventListener('click', () => {
      if (constructionSubMode === 'move') {
        // Exit move mode, return to place mode
        setConstructionSubMode('place');
      } else {
        // Enter move mode
        setConstructionSubMode('move');
      }
    });
  }

  // Construction-palette focus for early career levels: show only the
  // component types the level expects (plus a SHOW ALL toggle so nobody is
  // ever actually locked out of the catalog).
  let paletteFilterTypes: string[] | null = null;
  let paletteShowAll = false;
  function applyPaletteFilter(): void {
    const container = document.querySelector('.component-categories') as HTMLElement | null;
    if (!container) return;
    const filtering = paletteFilterTypes !== null && !paletteShowAll;
    container.querySelectorAll<HTMLButtonElement>('.component-btn').forEach(btn => {
      const t = btn.dataset.component ?? '';
      // class, not inline style: .component-btn carries display:block !important
      btn.classList.toggle('palette-hidden', filtering && !paletteFilterTypes!.includes(t));
    });
    container.querySelectorAll('details').forEach(d => {
      const anyVisible = Array.from(d.querySelectorAll<HTMLButtonElement>('.component-btn'))
        .some(b => !b.classList.contains('palette-hidden'));
      (d as HTMLElement).style.display = anyVisible ? '' : 'none';
    });
    let toggle = document.getElementById('palette-filter-toggle') as HTMLButtonElement | null;
    if (paletteFilterTypes !== null) {
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.id = 'palette-filter-toggle';
        toggle.style.cssText = 'width: 100%; margin-bottom: 6px; font-size: 11px; padding: 3px; background: #223a52; color: #9cf; border: 1px solid #456; cursor: pointer;';
        toggle.addEventListener('click', () => {
          paletteShowAll = !paletteShowAll;
          applyPaletteFilter();
        });
        container.prepend(toggle);
      }
      toggle.style.display = '';
      toggle.textContent = paletteShowAll ? 'SHOW SUGGESTED PARTS ONLY' : 'SHOW ALL PARTS';
      toggle.title = paletteShowAll
        ? 'Back to just the components this job calls for'
        : 'This level suggests a short parts list; click to browse the full catalog';
    } else if (toggle) {
      toggle.style.display = 'none';
    }
  }

  // Career mode: constructed here so it can close over the plant/save
  // helpers; the title screen below offers CAREER or SANDBOX.
  gameMode = new GameModeManager({
    plantState,
    gameLoop,
    setMode,
    loadPlantData: (data: unknown) => {
      deserializePlantState(data);
      updateConstructionCostPanel();
    },
    clearPlant: () => {
      deserializePlantState({ components: [], connections: [] });
      updateConstructionCostPanel();
    },
    showNotification,
    refreshSimControls: () => updatePauseButton(),
    setPaletteFilter: (types: string[] | null) => {
      paletteFilterTypes = types;
      paletteShowAll = false;
      applyPaletteFilter();
    },
  });

  // "Atom" Jack: AI contractor chat in the bottom-right corner. Constructed
  // here (like career mode) so its host closures can reach init()'s state.
  new JackManager({
    plantState,
    constructionManager,
    getSimState: () => gameLoop.getState(),
    getMode: () => currentMode,
    getSelectedComponentId: () => selectedComponentId,
    refreshCostPanel: () => updateConstructionCostPanel(),
  });

  // Start in construction mode
  setMode('construction');

  // Title screen: pick CAREER (a level) or SANDBOX (everything as before)
  gameMode.showTitle();

  // Start the game loop (paused for debugging)
  gameLoop.start();
  gameLoop.pause(); // Start paused so user can step through

  // Initialize simulation state in canvas immediately so arrows/gauges show
  plantCanvas.setSimState(simState);

  // Trigger initial debug panel update so we can see the starting state
  // before any physics runs. Use empty metrics since we haven't stepped yet.
  const initialMetrics: SolverMetrics = {
    lastStepWallTime: 0,
    avgStepWallTime: 0,
    currentDt: 0,
    actualDt: 0,
    dtLimitedBy: 'none',
    maxStableDt: 0,
    stabilityLimitedBy: 'none',
    minDtUsed: 0,
    subcycleCount: 0,
    totalSteps: 0,
    retriesThisFrame: 0,
    maxPressureChange: 0,
    maxFlowChange: 0,
    maxMassChange: 0,
    consecutiveSuccesses: 0,
    topErrorContributors: [],
    realTimeRatio: 0,
    isFallingBehind: false,
    fallingBehindSince: 0,
    operatorTimes: new Map(),
    lastSimTime: 0,
  };
  updateDebugPanel(simState, initialMetrics, gameLoop.getPressureSolverStatus());

  // Expose debug utilities to browser console
  window.meltdown = {
    setWaterPropsDebug,
    getWaterPropsDebugLog,
    calculateWaterState,
    enableCalculationDebug,
    getCalculationDebugLog,
    setSeparationDebug,
    getState: () => gameLoop.getState(),
    pause: () => gameLoop.pause(),
    resume: () => gameLoop.resume(),
    step: (dt?: number) => gameLoop.step(dt),
    singleStep: () => gameLoop.singleStep(),
  };

  console.log('  S: Manual SCRAM');
  console.log('  Mouse drag: Pan view');
  console.log('  Mouse wheel: Zoom');

  // Preload water properties in the background after UI is ready
  // This prevents blocking the main thread when switching to simulation mode
  setTimeout(() => {
    preloadWaterProperties().catch(err => {
      console.warn('[Main] Water properties preload failed:', err);
    });
  }, 100);
}

// Components already warned about missing sim nodes (warn once, not per frame)
const warnedMissingSimNodes = new Set<string>();

function syncSimulationToVisuals(simState: SimulationState, plantState: PlantState): void {
  // Sync all components to their simulation nodes
  // Uses simNodeId if set, otherwise falls back to component.id
  for (const [, component] of plantState.components) {
    const simNodeId = (component as { simNodeId?: string }).simNodeId || component.id;

    // Handle heat exchangers specially - they have primary and secondary sides
    if (component.type === 'heatExchanger') {
      // Primary side: try simNodeId, then {id}-primary
      const primaryNodeId = (component as { simNodeId?: string }).simNodeId || `${component.id}-primary`;
      const primaryNode = simState.flowNodes.get(primaryNodeId);
      if (primaryNode && component.primaryFluid) {
        component.primaryFluid.temperature = primaryNode.fluid.temperature;
        component.primaryFluid.pressure = primaryNode.fluid.pressure;
        component.primaryFluid.phase = primaryNode.fluid.phase;
        component.primaryFluid.quality = primaryNode.fluid.quality;
        component.primaryFluid.separation = primaryNode.separation;
      }

      // Secondary side: try {id}-secondary
      const secondaryNode = simState.flowNodes.get(`${component.id}-secondary`);
      if (secondaryNode && component.secondaryFluid) {
        component.secondaryFluid.temperature = secondaryNode.fluid.temperature;
        component.secondaryFluid.pressure = secondaryNode.fluid.pressure;
        component.secondaryFluid.phase = secondaryNode.fluid.phase;
        component.secondaryFluid.quality = secondaryNode.fluid.quality;
        component.secondaryFluid.separation = secondaryNode.separation;
      }
      continue;
    }

    // For vessels with fuel, sync fuel temperature
    if (component.type === 'vessel' && component.fuelRodCount) {
      const fuelNodeId = `${component.id}-fuel`;
      const fuelNode = simState.thermalNodes.get(fuelNodeId);
      if (fuelNode) {
        component.fuelTemperature = fuelNode.temperature;
      }
    }

    // Handle reactor vessels specially - sync both core and downcomer regions
    if (component.type === 'reactorVessel') {
      const rv = component as ReactorVesselComponent;

      // New architecture: vessel IS the downcomer, coreBarrel is separate
      if (rv.coreBarrelId) {
        // Sync vessel.fluid from the vessel's own flow node (downcomer)
        const vesselNode = simState.flowNodes.get(component.id);
        if (vesselNode && component.fluid) {
          component.fluid.temperature = vesselNode.fluid.temperature;
          component.fluid.pressure = vesselNode.fluid.pressure;
          component.fluid.phase = vesselNode.fluid.phase;
          component.fluid.quality = vesselNode.fluid.quality;
          component.fluid.separation = vesselNode.separation;
          component.fluid.ncg = vesselNode.fluid.ncg;
          component.fluid.volume = vesselNode.volume;
        }
        // Core barrel syncs automatically via normal component loop (it has its own fluid)
        // Sync fuel temperature from core barrel's thermal node
        const fuelNodeId = `${component.id}-fuel`;
        const fuelNode = simState.thermalNodes.get(fuelNodeId);
        if (fuelNode) {
          // Update fuel temp on the core barrel
          const coreBarrel = plantState.components.get(rv.coreBarrelId);
          if (coreBarrel) {
            (coreBarrel as any).fuelTemperature = fuelNode.temperature;
          }
        }
        continue;
      }

      // Legacy architecture: insideBarrelId/outsideBarrelId
      // Sync fluid from inside barrel region (core region) to component.fluid
      if (rv.insideBarrelId) {
        const insideNode = simState.flowNodes.get(rv.insideBarrelId);
        if (insideNode && component.fluid) {
          component.fluid.temperature = insideNode.fluid.temperature;
          component.fluid.pressure = insideNode.fluid.pressure;
          component.fluid.phase = insideNode.fluid.phase;
          component.fluid.quality = insideNode.fluid.quality;
          component.fluid.separation = insideNode.separation;
          component.fluid.ncg = insideNode.fluid.ncg;
          component.fluid.volume = insideNode.volume;
        }
      }
      // Sync fluid from outside barrel region (downcomer) to outsideBarrelFluid
      if (rv.outsideBarrelId) {
        const outsideNode = simState.flowNodes.get(rv.outsideBarrelId);
        if (outsideNode) {
          // Initialize outsideBarrelFluid if it doesn't exist
          if (!rv.outsideBarrelFluid) {
            rv.outsideBarrelFluid = {
              temperature: outsideNode.fluid.temperature,
              pressure: outsideNode.fluid.pressure,
              phase: outsideNode.fluid.phase,
              flowRate: 0,
            };
          }
          rv.outsideBarrelFluid.temperature = outsideNode.fluid.temperature;
          rv.outsideBarrelFluid.pressure = outsideNode.fluid.pressure;
          rv.outsideBarrelFluid.phase = outsideNode.fluid.phase;
          rv.outsideBarrelFluid.quality = outsideNode.fluid.quality;
          rv.outsideBarrelFluid.separation = outsideNode.separation;
          rv.outsideBarrelFluid.ncg = outsideNode.fluid.ncg;
          rv.outsideBarrelFluid.volume = outsideNode.volume;
        }
      }
      // Sync fuel temperature if present
      const fuelNodeId = `${component.id}-fuel`;
      const fuelNode = simState.thermalNodes.get(fuelNodeId);
      if (fuelNode) {
        (component as any).fuelTemperature = fuelNode.temperature;
      }
      continue;
    }

    // Sync fluid state for components with fluid
    if (component.fluid) {
      const simNode = simState.flowNodes.get(simNodeId);
      if (simNode) {
        component.fluid.temperature = simNode.fluid.temperature;
        component.fluid.pressure = simNode.fluid.pressure;
        component.fluid.phase = simNode.fluid.phase;
        component.fluid.quality = simNode.fluid.quality;
        component.fluid.separation = simNode.separation;
        // Sync NCG and volume for proper visualization
        component.fluid.ncg = simNode.fluid.ncg;
        component.fluid.volume = simNode.volume;
      } else if (!warnedMissingSimNodes.has(component.id)) {
        // Warn once per component, not every frame
        console.warn(`[Sync] ${component.id}: no simNode found for '${simNodeId}'`);
        warnedMissingSimNodes.add(component.id);
      }
    }

    // Sync pump state
    if (component.type === 'pump') {
      const pumpId = (component as { simPumpId?: string }).simPumpId || component.id;
      const pumpState = simState.components.pumps.get(pumpId);
      if (pumpState) {
        component.running = pumpState.running;
        component.speed = pumpState.speed;
        // Operating point on the pump curve for the sprite's color cue:
        // flow / rated flow, normalized by speed (affinity laws), so
        // 0 = deadhead, 1 = rated point, ~2.24 = runout.
        let opFlow: number | undefined;
        if (pumpState.running && pumpState.effectiveSpeed > 0.01 &&
            pumpState.connectedFlowPath && pumpState.ratedFlow > 0) {
          const conn = simState.flowConnections.find(c => c.id === pumpState.connectedFlowPath);
          if (conn) {
            opFlow = Math.abs(conn.massFlowRate) / (pumpState.ratedFlow * pumpState.effectiveSpeed);
          }
        }
        (component as unknown as { opFlowFraction?: number }).opFlowFraction = opFlow;
      }
    }

    // Sync valve state
    if (component.type === 'valve') {
      const valveId = (component as { simValveId?: string }).simValveId || component.id;
      const valveState = simState.components.valves.get(valveId);
      if (valveState) {
        component.opening = valveState.position;
      }
    }
  }

  // Sync control rod position to vessel/coreBarrel visual
  const rodPosition = simState.neutronics.controlRodPosition;
  for (const [, comp] of plantState.components) {
    // Vessels have controlRodCount directly
    if (comp.type === 'vessel' && (comp as any).controlRodCount) {
      (comp as any).controlRodPosition = rodPosition;
    }
    // Core barrels have control rod properties
    if (comp.type === 'coreBarrel' && (comp as any).controlRodCount) {
      (comp as any).controlRodPosition = rodPosition;
    }
  }

  // Update slider if simulation changed rod position (e.g., SCRAM)
  // Slider shows insertion % (100 - withdrawal position * 100)
  const rodSlider = document.getElementById('rod-position') as HTMLInputElement;
  const rodValueDisplay = document.getElementById('rod-position-value');
  if (rodSlider) {
    // If an auto rod controller owns the rods, the slider is an indicator
    // only: manual writes would be overwritten on the next solver step.
    let rodControllerId: string | null = null;
    let anyRodController = false;
    const controllers = simState.components.controllers;
    if (controllers) {
      for (const [, ctl] of controllers) {
        if (ctl.actuator.kind !== 'control-rods') continue;
        anyRodController = true;
        if (ctl.mode !== 'manual') {
          rodControllerId = ctl.id;
          break;
        }
      }
    }
    const scrammed = simState.neutronics.scrammed;

    // Manual/auto toggle is only offered when a rod controller exists
    const rodModeBtn = document.getElementById('rod-mode-btn') as HTMLButtonElement | null;
    if (rodModeBtn) {
      // .sim-btn carries `display: inline-flex !important`, so a plain
      // style.display write is ignored - the toggle needs !important too
      rodModeBtn.style.setProperty('display', anyRodController ? 'inline-flex' : 'none', 'important');
      if (anyRodController) {
        const isAuto = rodControllerId !== null;
        rodModeBtn.textContent = isAuto ? 'Rods: AUTO' : 'Rods: MANUAL';
        rodModeBtn.title = isAuto
          ? 'Rod controller is in automatic mode. Click to take manual control with the slider.'
          : 'Rod controller is in manual mode (slider drives the rods). Click to return to automatic control.';
      }
    }
    rodSlider.disabled = scrammed || rodControllerId !== null;
    if (scrammed) {
      rodSlider.title = 'SCRAM active: rods are fully inserted';
    } else if (rodControllerId) {
      const ctlComponent = plantState.components.get(rodControllerId);
      const ctlName = (ctlComponent?.label as string | undefined) ?? rodControllerId;
      rodSlider.title = `Rod position is driven by "${ctlName}" (auto mode); the slider shows the actual position`;
    } else {
      rodSlider.title = 'Manual control rod insertion (0% = withdrawn, 100% = inserted)';
    }

    const insertionPercent = Math.round((1 - rodPosition) * 100);
    const currentSliderValue = parseInt(rodSlider.value);
    // When the slider is a passive indicator, track the sim exactly; the
    // 1% deadband only exists to avoid fighting active user input
    const deadband = rodSlider.disabled ? 0 : 1;
    if (Math.abs(currentSliderValue - insertionPercent) > deadband) {
      rodSlider.value = String(insertionPercent);
      if (rodValueDisplay) {
        rodValueDisplay.textContent = insertionPercent + '%';
      }
    }
  }

  // Boron display: show current concentration, and the target while slewing
  const boronValueEl = document.getElementById('boron-value');
  if (boronValueEl) {
    const current = simState.neutronics.boronPpm ?? 0;
    const target = simState.neutronics.boronTargetPpm ?? current;
    boronValueEl.textContent = Math.abs(target - current) > 0.5
      ? `${current.toFixed(0)} → ${target.toFixed(0)} ppm`
      : `${current.toFixed(0)} ppm`;
  }

  // Sync turbine-generator state using component's simNodeId
  for (const [, comp] of plantState.components) {
    if (comp.type === 'turbine-generator') {
      // Get the turbine's simulation node using its simNodeId
      const turbineNodeId = (comp as { simNodeId?: string }).simNodeId;
      const turbineNode = turbineNodeId ? simState.flowNodes.get(turbineNodeId) : undefined;

      // Update inlet/outlet fluids from simulation
      if (turbineNode && comp.inletFluid) {
        comp.inletFluid.temperature = turbineNode.fluid.temperature;
        comp.inletFluid.pressure = turbineNode.fluid.pressure;
        comp.inletFluid.phase = turbineNode.fluid.phase;
        comp.inletFluid.quality = turbineNode.fluid.quality;
      }
      // Turbine is running if there's flow through it
      comp.running = true; // For now, always running
      // Power would come from TurbineCondenserOperator - TODO: sync this
    }
  }
}

function showNotification(message: string, type: 'info' | 'warning' | 'error' = 'info', durationMs?: number): void {
  const prefix = type === 'warning' ? '!' : type === 'error' ? 'X' : 'i';
  console.log('[' + prefix + '] ' + message);

  // Stack below any notifications already showing instead of covering them
  const existing = document.querySelectorAll('.sim-notification').length;

  // Create visible notification element
  const notification = document.createElement('div');
  notification.className = 'sim-notification';
  notification.style.cssText = `
    position: fixed;
    top: ${20 + existing * 52}px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    border-radius: 6px;
    font-family: monospace;
    font-size: 14px;
    z-index: 2000;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    animation: slideDown 0.3s ease-out;
    max-width: 80%;
    text-align: center;
    display: flex;
    align-items: center;
    gap: 12px;
  `;

  // Color based on type
  switch (type) {
    case 'error':
      notification.style.background = '#8b2020';
      notification.style.border = '1px solid #cc4444';
      notification.style.color = '#ffcccc';
      break;
    case 'warning':
      notification.style.background = '#8b6b20';
      notification.style.border = '1px solid #ccaa44';
      notification.style.color = '#ffeebb';
      break;
    default:
      notification.style.background = '#1a3a5a';
      notification.style.border = '1px solid #4488aa';
      notification.style.color = '#d0e8ff';
  }

  const text = document.createElement('span');
  text.textContent = message;
  text.style.flex = '1';
  notification.appendChild(text);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s ease-out';
    setTimeout(() => {
      if (notification.parentNode) document.body.removeChild(notification);
    }, 300);
  };

  // Manual close button (X) - dismiss immediately without waiting for the timer
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.title = 'Dismiss';
  closeBtn.style.cssText = `
    background: transparent;
    border: none;
    color: inherit;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
    opacity: 0.7;
  `;
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.7'; });
  closeBtn.addEventListener('click', remove);
  notification.appendChild(closeBtn);

  document.body.appendChild(notification);

  // Auto-remove after delay (longer for errors); callers can override for
  // events the player must not miss (bursts hold for 30 s unless dismissed)
  const duration = durationMs ?? (type === 'error' ? 5000 : type === 'warning' ? 4000 : 3000);
  setTimeout(remove, duration);
}

// Show a dialog asking if user wants to place component inside a container
function showContainmentDialog(
  containerName: string,
  componentType: string,
  callback: (placeInside: boolean | null) => void
): void {
  // Create modal overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  // Create dialog box
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #1a1e24;
    border: 1px solid #445566;
    border-radius: 8px;
    padding: 20px;
    max-width: 400px;
    color: #d0d8e0;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  `;

  // Dialog content
  dialog.innerHTML = `
    <h3 style="margin: 0 0 15px 0; color: #7af;">Place Inside Container?</h3>
    <p style="margin: 0 0 20px 0; line-height: 1.5;">
      You clicked on <strong>${containerName}</strong>. Would you like to place the
      <strong>${componentType}</strong> inside this container?
    </p>
    <p style="margin: 0 0 20px 0; font-size: 12px; color: #889;">
      Placing inside will:
      <br>• Reduce the container's free volume
      <br>• Connect heat transfer to the container's fluid
      <br>• Direct any ruptures into the container
    </p>
    <div style="display: flex; gap: 10px; justify-content: flex-end;">
      <button id="containment-no" style="
        padding: 8px 16px;
        background: #334455;
        border: 1px solid #556677;
        border-radius: 4px;
        color: #d0d8e0;
        cursor: pointer;
      ">Cancel</button>
      <button id="containment-yes" style="
        padding: 8px 16px;
        background: #2a5a8a;
        border: 1px solid #4a8aba;
        border-radius: 4px;
        color: #fff;
        cursor: pointer;
      ">Place Inside</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Handle button clicks
  const yesBtn = dialog.querySelector('#containment-yes') as HTMLButtonElement;
  const noBtn = dialog.querySelector('#containment-no') as HTMLButtonElement;

  const cleanup = () => {
    document.body.removeChild(overlay);
  };

  yesBtn.addEventListener('click', () => {
    cleanup();
    callback(true);
  });

  noBtn.addEventListener('click', () => {
    cleanup();
    callback(null);
  });

  // Close on escape key
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cleanup();
      callback(null);
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      cleanup();
      callback(null);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

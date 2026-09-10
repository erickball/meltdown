import { deserializePlantDesign } from './simulation/serialization';
import type { HistoryEpoch } from './game/state-history';
import { buildTimeline, formatBandTime, eventIcon } from './game/history-timeline';
import { PlantCanvas, ViewMode } from './render/canvas';
import { PipeOrientation } from './render/grid-geometry';
import { installPageZoomReset } from './page-zoom';
import { getComponentVisualHeight, formatGaugeValue } from './render/components';
// Demo plant imports - uncomment createDemoPlant and createDemoReactor to load demo on startup
// import { createDemoPlant } from './plant/factory';
import pwrPresetData from './presets/pwr.json';
import bwrPresetData from './presets/bwr.json';
import htgrPresetData from './presets/htgr.json';
import xe100PresetData from './presets/xe100.json';
import xe100SboPresetData from './presets/xe100-sbo.json';
import xe100SgtrPresetData from './presets/xe100-sgtr.json';
import twoLoopPresetData from './presets/two-loop.json';
import promptCritPresetData from './presets/prompt-crit.json';
import w4loopPresetData from './presets/w4loop.json';
import sboPresetData from './presets/sbo.json';
import meltdownDemoPresetData from './presets/meltdown-demo.json';
import { PlantState, PlantComponent, ReactorVesselComponent, ControllerComponent, PipeComponent, HeatExchangerComponent, Fluid, Port, Point, Connection, PlantStock } from './types';
import { GameLoop, ScramSetpoints } from './game';
import {
  // createDemoReactor,
  createSimulationFromPlant,
  setSimulationRandomSeed,
  serializeSimulationState,
  deserializeSimulationState,
  serializePlantDesign,
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
  hxBundleCount,
  hxTubeNodeIds,
  assignFlowConnectionIds,
  evaluateOtsgSections,
  writeSimulationStateToPlant,
  captureResumeSnapshot,
  transplantSimulationState,
  ResumeSnapshot,
  beginLivePlantEdit,
  commitLivePlantEdit,
  revertLivePlantEdit,
  LiveEditSnapshot,
  nodeLiquidLevelFraction,
  steamPartialPressurePa,
  terrainHeightAt,
} from './simulation';
import {
  getStock, componentsRemaining, pipeMetersRemaining, storedTypeForPaletteKey,
  formatMetres, applyConnectionLengthEdit,
  stockedPipeSpecId, stockLineDisplayName, pipeSpecDisplayName,
  paletteKeyForStockLine,
} from './game/stock';
import {
  BuildQueue, Buildable, componentBuildMassKg, connectionBuildMassKg,
} from './game/build-queue';
import { getPipeSpecById } from './construction/component-presets';
import { updateDebugPanel, initDebugPanel, updateComponentDetail, updateCoreDamageIndicator, setComponentEditCallback, setCoreEditCallback, setComponentMoveCallback, setComponentDeleteCallback, setConnectionEditCallback, setPlantConnectionEditCallback, setConnectionDeleteCallback, setPumpControlCallback } from './debug';
import { waveCasualties, WaveCasualty } from './simulation/wave-casualties';
import { nodeGasVolume } from './simulation/mixture-properties';
import { addWreck } from './render/debris-fx';
import { GameModeManager } from './game-mode';
import { ComponentDialog, ComponentConfig, componentDefinitions, auditComponentEditSync } from './construction/component-config';
import { ConstructionManager } from './construction/construction-manager';
import { ConnectionDialog, ConnectionConfig, ConnectionEditResult } from './construction/connection-dialog';
import { estimatePlantComponentCost, formatCost } from './construction/cost-estimation';
import { JackManager } from './jack/jack-manager';
import { executeJackTool, fileCarReport } from './jack/jack-tools-exec';
import { refreshLivePlots, getOpenPlotInputs, restorePlots } from './jack/jack-history';
import { closeAllPlots, getPlotDrawnWindow } from './jack/jack-plot';
import { saveHistoryRecord, loadHistoryRecord, deleteHistoryRecord } from './game/history-store';

// Throttle debug panel updates to reduce flickering
const DEBUG_UPDATE_INTERVAL_MS = 250; // Update ~4 times per second
let lastDebugUpdate = 0;

// ============================================================================
// Settings Persistence
// ============================================================================
const SETTINGS_KEY = 'meltdown_settings';

interface AppSettings {
  deterministicMode?: boolean;
  viewMode?: ViewMode;
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
      case 'pool':
      case 'coreBarrel':
        flowNodes.push({ id, label });
        break;
      case 'reactorVessel':
        flowNodes.push({ id, label: `${label} (downcomer)` });
        break;
      case 'heatExchanger': {
        const nBundles = hxBundleCount(comp as any);
        hxTubeNodeIds(id, nBundles).forEach((nodeId, b) => {
          flowNodes.push({
            id: nodeId,
            label: nBundles > 1 ? `${label} (tube bundle ${b + 1})` : `${label} (tube/primary)`,
          });
        });
        flowNodes.push({ id: `${id}-shell`, label: `${label} (shell/secondary)` });
        break;
      }
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

  // Ids from the factory's own naming rule, so a second connection between
  // the same pair of components (two bundles of one heat exchanger fed from
  // one header) is offered under the id it will actually have.
  const connectionIds = assignFlowConnectionIds(plantState.connections);
  plantState.connections.forEach((conn, i) => {
    const fromComp = plantState.components.get(conn.fromComponentId);
    const toComp = plantState.components.get(conn.toComponentId);
    const fromLabel = fromComp?.label || conn.fromComponentId;
    const toLabel = toComp?.label || conn.toComponentId;
    flowConnections.push({
      id: connectionIds[i],
      label: `${fromLabel} → ${toLabel}` +
        (connectionIds[i] === `flow-${conn.fromComponentId}-${conn.toComponentId}`
          ? '' : ` (${getPortTypeLabel(conn.fromPortId, conn.fromComponentId)})`),
    });
  });

  return { flowNodes, valves, pumps, turbines, flowConnections };
}

/**
 * Extract a human-readable port type from the port ID.
 * Port IDs are like "comp-id-tube-1", "comp-id-shell-2", "comp-id-inlet", etc.
 */
function getPortTypeLabel(portId: string, componentId: string): string {
  // Remove the component ID prefix to get the port suffix
  let suffix = portId.startsWith(componentId + '-')
    ? portId.slice(componentId.length + 1)
    : portId;

  // Multi-bundle heat exchangers suffix their tube ports with the bundle they
  // open into ("tube-top-b2"); name the bundle rather than leaving "B2" on
  // the end of the label.
  let bundleNote = '';
  const bundleMatch = /^(.*)-b(\d+)$/.exec(suffix);
  if (bundleMatch) {
    suffix = bundleMatch[1];
    bundleNote = ` (Bundle ${bundleMatch[2]})`;
  }

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
    // Spent-fuel pool
    'vent': 'Vent (rim, open to the sky)',
    'drain': 'Drain (floor)',
    'makeup-w': 'Make-up West',
    'makeup-e': 'Make-up East',
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

  return (typeMap[suffix] || suffix.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())) + bundleNote;
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

  // Debug handle for headless test scripts (see also __debugCursor)
  (window as any).__meltdownDebug = { plantCanvas, plantState };
  installPageZoomReset();

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
  // Parts being installed run on the PLANT's clock: a pump takes the same
  // amount of the accident however fast the player has the clock turned up,
  // installing stops when the simulation stops, and rewinding the run rewinds
  // the builders with it (see src/game/build-queue.ts). onSimAdvance fires
  // wherever simulated time moves - a frame, a manual step, or a seek.
  gameLoop.onSimAdvance = (simTime: number) => buildQueue.tick(simTime);

  gameLoop.onStateUpdate = (state: SimulationState, metrics: SolverMetrics) => {
    // Career-mode bookkeeping (revenue, objectives, random events)
    gameMode?.onSimUpdate(state);
    // A wave that has closed over something the player built takes it
    checkWaveCasualties(state);
    // Update time display
    const timeDisplay = document.getElementById('sim-time');
    if (timeDisplay) {
      timeDisplay.textContent = `Time: ${formatClock(state.time)}, ${metrics.totalSteps} steps`;
    }

    // Wall clock and achieved speed
    updateWallTimeDisplay();
    updateAchievedSpeedDisplay();

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

      // Persistent performance bubble: solver slower than the requested speed
      updateSlowSimBubble(metrics, gameLoop.getTargetSimSpeed());

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

      // Redraw Jack's open-ended plot panels against the latest history
      refreshLivePlots((a, b) => gameLoop.getHistoryStates(a, b), state.time);

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
    } else if (event.type === 'scenario') {
      // A preset's scripted accident sequence just acted on the plant
      showNotification('Scenario: ' + event.message, 'warning', 15000);
    } else if (event.type === 'washed-away') {
      showNotification(event.message, 'error', 15000);
    } else if (event.type === 'shake') {
      // Ground motion: the view jolts, the plant does not. No banner - the
      // scenario event that ordered it carries the words.
      const d = event.data as { seconds?: number; amplitude?: number } | undefined;
      plantCanvas.startShake(d?.seconds ?? 2, d?.amplitude);
    } else if (event.type === 'simulation-error') {
      // Show error dialog for simulation errors. The loop hands the thrown
      // error along with the message, so a bug report filed from the dialog
      // carries its stack trace.
      showErrorDialog('Simulation Error', event.message, {
        error: (event.data as { error?: unknown } | undefined)?.error,
      });
      // Update pause button to show paused state
      updatePauseButton();
    }
  };

  /**
   * What the error dialog's "File bug report" button needs to turn a failure
   * into a Corrective Action Report. Everything is optional: the message
   * alone is worth reporting, an `error` just lets the report carry a stack.
   */
  interface ErrorReportInfo {
    /** CAR severity. Defaults to 'high' - this dialog only opens on a failure. */
    severity?: 'low' | 'medium' | 'high';
    /** The thrown error, so the report can carry its stack trace. */
    error?: unknown;
  }

  /** The dialog builds its panes with innerHTML, and error text contains '<'. */
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /**
   * Show an error dialog to the user.
   *
   * Everything that opens this dialog is something no user asked for, so the
   * dialog offers to file it: the button leads to the same Corrective Action
   * Report path Jack uses (consent dialog, reproduction bundle and all),
   * reached without having to describe the crash to him first.
   */
  function showErrorDialog(title: string, message: string, report: ErrorReportInfo = {}): void {
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

    const buttonStyle =
      'background: #644; color: #fff; border: 1px solid #a66; border-radius: 4px; ' +
      'padding: 8px 20px; cursor: pointer; font-family: inherit;';
    const btn = (id: string, label: string, tip: string) =>
      `<button id="${id}" style="${buttonStyle}" title="${tip}">${label}</button>`;

    // --- Pane 1: the error, with the offer to report it ---------------------
    const showError = () => {
      dialog.innerHTML = `
        <h3 style="color: #f88; margin: 0 0 10px 0;">${escapeHtml(title)}</h3>
        <p style="color: #ddd; margin: 0 0 15px 0; font-size: 12px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(message)}</p>
        <p style="color: #888; margin: 0 0 15px 0; font-size: 11px;">Use the history controls (⏮ ⏭) to go back to a stable state, or reduce simulation speed.</p>
        <div style="display: flex; gap: 10px;">
          ${btn('error-dialog-close', 'OK', 'Dismiss this message')}
          ${btn('error-dialog-report', 'File bug report',
                'Send this error to the developers, together with your plant and the ' +
                'simulation history, so they can reproduce it. You see the whole report ' +
                'and approve it before anything leaves your machine.')}
        </div>
      `;
      const closeBtn = dialog.querySelector<HTMLButtonElement>('#error-dialog-close');
      if (closeBtn) closeBtn.onclick = () => { dialog.style.display = 'none'; };
      const reportBtn = dialog.querySelector<HTMLButtonElement>('#error-dialog-report');
      if (reportBtn) reportBtn.onclick = showCompose;
    };

    // --- Pane 2: the one thing the report cannot collect by itself ----------
    // What the user was doing. Optional: a report with no note still carries
    // the error, the plant and the history, which is most of the value.
    const showCompose = () => {
      dialog.innerHTML = `
        <h3 style="color: #f88; margin: 0 0 10px 0;">File a bug report</h3>
        <p style="color: #ddd; margin: 0 0 12px 0; font-size: 12px;">
          The error text, your plant design and the simulation history travel with this report.
          The next screen shows you everything that would be sent, and nothing goes out until
          you approve it there.
        </p>
        <label for="error-dialog-note" style="color: #bbb; display: block; font-size: 11px; margin: 0 0 4px 0;">
          What were you doing when this happened? (optional)
        </label>
        <textarea id="error-dialog-note" rows="4"
          placeholder="e.g. opened the main steam isolation valve at full power"
          style="width: 100%; box-sizing: border-box; background: #221a1a; color: #eee;
                 border: 1px solid #a66; border-radius: 4px; padding: 6px;
                 font-family: inherit; font-size: 12px; resize: vertical;"></textarea>
        <div style="display: flex; gap: 10px; margin-top: 12px;">
          ${btn('error-dialog-send', 'Send report', 'Build the report and show it to you for approval')}
          ${btn('error-dialog-back', 'Cancel', 'Go back without reporting anything')}
        </div>
        <p id="error-dialog-status" style="color: #888; font-size: 11px; margin: 10px 0 0 0;"></p>
      `;
      const note = dialog.querySelector<HTMLTextAreaElement>('#error-dialog-note');
      const sendBtn = dialog.querySelector<HTMLButtonElement>('#error-dialog-send');
      const backBtn = dialog.querySelector<HTMLButtonElement>('#error-dialog-back');
      const status = dialog.querySelector<HTMLParagraphElement>('#error-dialog-status');
      note?.focus();
      if (backBtn) backBtn.onclick = showError;
      if (sendBtn) sendBtn.onclick = async () => {
        sendBtn.disabled = true;
        if (backBtn) backBtn.disabled = true;
        if (status) status.textContent = 'Packing up the plant and the simulation history...';
        try {
          const result = await fileErrorReport(title, message, note?.value.trim() ?? '', report);
          dialog.style.display = 'none';
          if (!result.ok) {
            showNotification(`Bug report not sent: ${result.error}`, 'error', 15000);
          } else if (result.status === 'filed') {
            showNotification(
              `Bug report filed${result.carId ? ` (${result.carId})` : ''} - thank you.`, 'info', 10000);
          } else if (result.status === 'parked') {
            showNotification(result.note, 'warning', 20000);
          }
          // 'declined' means the user said no on the consent screen; they know.
        } catch (e) {
          // The report failed, but the error it was about is still behind this
          // pane - keep the dialog up so they can read it or try again.
          console.error('[CAR] Filing the bug report failed:', e);
          if (status) {
            status.textContent =
              `Could not file the report: ${e instanceof Error ? e.message : String(e)}`;
          }
          sendBtn.disabled = false;
          if (backBtn) backBtn.disabled = false;
        }
      };
    };

    showError();
    dialog.style.display = 'block';
  }

  /**
   * Turn one error dialog into a Corrective Action Report: the same call
   * Jack's file_car tool makes, so the user gets the same consent dialog and
   * the report carries the same reproduction bundle.
   */
  function fileErrorReport(
    title: string,
    message: string,
    note: string,
    report: ErrorReportInfo
  ): ReturnType<typeof fileCarReport> {
    const thrown = report.error;
    const stack = thrown instanceof Error && thrown.stack ? thrown.stack : null;
    const firstLine = message.split('\n')[0].trim();
    const description =
      `${title}. Reported by the user from the error dialog.\n\n${message}\n\n` +
      (note
        ? `What the user was doing: ${note}\n`
        : 'The user did not add a description of what they were doing.\n') +
      (stack ? `\nStack trace:\n${stack}\n` : '');
    return fileCarReport(
      {
        title: `${title}: ${firstLine}`.slice(0, 300),
        description,
        severity: report.severity ?? 'high',
      },
      jackHost,
      () => {},
      { source: 'user', extraContext: { reportedFrom: 'error dialog' } }
    );
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
    // Flag an in-progress drag so the per-frame sim writeback (which snaps
    // the thumb to the commanded position) leaves the thumb alone while the
    // user holds it. On long frames the sim moves several percent between
    // syncs, and without this the writeback yanks the slider mid-drag.
    rodSlider.addEventListener('pointerdown', () => { rodSlider.dataset.dragging = '1'; });
    const endRodDrag = () => { delete rodSlider.dataset.dragging; };
    window.addEventListener('pointerup', endRodDrag);
    window.addEventListener('pointercancel', endRodDrag);
    rodSlider.addEventListener('input', () => {
      const insertionPercent = parseInt(rodSlider.value);
      const withdrawalPosition = 1 - insertionPercent / 100; // Convert to simulation scale
      // Update display
      if (rodValueDisplay) {
        rodValueDisplay.textContent = insertionPercent + '%';
      }
      // If the plant has a rod controller (rod drive), the slider commands
      // its manual SETPOINT and the rods travel there at the drive's rate
      // limit. Writing the position directly would fight the drive: it
      // steps the rods back toward its own manualOutput every solver step,
      // and the per-frame slider sync then snaps the slider back - fastest
      // at high sim speeds. Only a plant with no rod drive at all gets the
      // instantaneous position write.
      let hasRodController = false;
      gameLoop.updateState((state) => {
        const controllers = state.components.controllers;
        if (controllers) {
          for (const [, ctl] of controllers) {
            if (ctl.actuator.kind !== 'control-rods') continue;
            hasRodController = true;
            if (ctl.mode === 'manual') {
              ctl.manualOutput = withdrawalPosition;
            }
          }
        }
        if (!hasRodController) {
          state.neutronics.controlRodPosition = withdrawalPosition;
        }
        return state;
      });
      // Update visual components with control rods (visual also uses
      // withdrawal position internally). With a rod drive the rods have not
      // moved yet - the per-frame sync tracks them as they travel.
      if (!hasRodController) {
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

  /**
   * A requested speed, the way the user set it: 1x, 10x, 0.01x - no trailing
   * zeros on a number they typed in themselves.
   */
  function formatRequestedSpeed(speed: number): string {
    return Number.isInteger(speed) ? `${speed}` : speed < 1 ? `${speed}` : speed.toFixed(1);
  }

  /**
   * A measured speed, which needs enough digits to be worth reading at any
   * scale: 0.43x and 0.010x are both meaningful, and both would round to
   * nothing at one decimal place.
   */
  function formatAchievedSpeed(speed: number): string {
    if (speed >= 10) return speed.toFixed(0);
    if (speed >= 1) return speed.toFixed(1);
    if (speed >= 0.1) return speed.toFixed(2);
    return speed.toFixed(3);
  }

  /**
   * A clock reading for the status bar: seconds at about three figures of
   * resolution, then the same time in decimal hours, which is the unit the
   * levels, the scenarios and the decay-heat curves are all written in.
   * `formatGaugeValue` does the hours (three significant figures, trailing
   * zeros dropped); the seconds cannot go through it, because its
   * toPrecision(3) would round 1234 s to 1230 s.
   */
  function formatClock(seconds: number): string {
    const abs = Math.abs(seconds);
    const decimals = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
    return `${seconds.toFixed(decimals)} s (${formatGaugeValue(seconds / 3600)} h)`;
  }

  /** Wall clock, compact: 12.3 s below a minute, then 3:05, then 1:02:33. */
  function formatWallTime(seconds: number): string {
    if (seconds < 60) return `${seconds.toFixed(1)} s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function updateWallTimeDisplay(): void {
    const el = document.getElementById('wall-time');
    if (!el) return;
    const wall = gameLoop.getRunningWallTime();
    el.textContent = `Wall: ${formatWallTime(wall)} (${formatGaugeValue(wall / 3600)} h)`;
  }

  /**
   * Status-bar speed: what the simulation is ACHIEVING, with the speed it is
   * trying to reach in brackets whenever it cannot keep up. The achieved
   * figure is averaged over a couple of seconds of wall time by the game loop
   * - a single frame's ratio swings too wildly to read.
   */
  function updateAchievedSpeedDisplay(): void {
    const el = document.getElementById('sim-speed');
    if (!el) return;
    const commanded = gameLoop.getSimSpeed();
    const target = gameLoop.getTargetSimSpeed();
    const achieved = gameLoop.getAchievedSpeed();

    if (achieved === null) {
      // Nothing has run yet, so there is no achieved speed to report. Show the
      // request rather than inventing a measurement.
      el.textContent = `Speed: ${formatRequestedSpeed(commanded)}x`;
      el.style.color = '#aaa';
      return;
    }

    // 10% slack, the same the loop's own falling-behind test uses, so ordinary
    // frame jitter on a plant that IS keeping up does not flicker the readout.
    const lagging = achieved < commanded * 0.9;
    let text = `Speed: ${formatAchievedSpeed(achieved)}x`;
    if (lagging) text += ` [${formatRequestedSpeed(commanded)}x]`;
    // Auto-slowdown holding the speed below what the user asked for is a
    // deliberate choice, not lag, so it gets its own words.
    if (commanded < target - 0.001) {
      text += ` (auto-slow from ${formatRequestedSpeed(target)}x)`;
    }
    el.textContent = text;
    el.style.color = lagging ? '#ff4444' : '#aaa';
  }

  function updateSpeedDisplay() {
    const speed = gameLoop.getSimSpeed();
    const target = gameLoop.getTargetSimSpeed();
    const autoSlowed = speed < target - 0.001;
    if (speedDisplay) {
      // Recovery from auto-slow passes through fractional speeds (1.5x, ...)
      const label = formatRequestedSpeed(speed);
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

  // Refresh all displays after restoring/replaying a state from history -
  // everything the per-frame update path touches that derives from state:
  // visuals (incl. burst overlays via setSimState), debug pane, detail
  // panel, MW readout, core-damage banner, time display
  function refreshDisplayAfterRestore(): void {
    const state = gameLoop.getState();
    const historyInfo = gameLoop.getHistoryInfo();

    // Sync simulation to visual components (valve/pump/rod positions, fluid)
    syncSimulationToVisuals(state, plantState);

    // Update canvas - burst overlays and gauges read state.burstStates etc.
    plantCanvas.setSimState(state);

    // Update time display - use step number from history, not solver
    const timeDisplay = document.getElementById('sim-time');
    if (timeDisplay) {
      timeDisplay.textContent = `Time: ${formatClock(state.time)}, ${historyInfo.currentStepNumber} steps`;
    }
    updateWallTimeDisplay();
    updateAchievedSpeedDisplay();

    // Update debug panel
    updateDebugPanel(state, gameLoop.getSolverMetrics(), gameLoop.getPressureSolverStatus());

    // Core damage / radiological release banner tracks the restored state
    updateCoreDamageIndicator(state);

    // MW readout: a replay re-runs the turbine operator, so its live report
    // matches the replayed state; a pure snapshot restore leaves the last
    // computed value, which the next step corrects
    const mwValueEl = document.getElementById('mw-value');
    if (mwValueEl) {
      const tcState = getTurbineCondenserState();
      const totalMW = tcState.turbinePower / 1e6;
      mwValueEl.textContent = totalMW.toFixed(1) + ' MW';
      mwValueEl.style.color = totalMW <= 0 ? '#888' : totalMW < 100 ? '#ff4' : '#4f4';
    }

    // Update component detail panel if something is selected
    if (selectedComponentId) {
      updateComponentDetail(selectedComponentId, plantState, state);
    }

    // Live plot panels track the seek position too (they redraw whenever
    // the current time moved backwards or gained more than 0.1 s)
    refreshLivePlots((a, b) => gameLoop.getHistoryStates(a, b), state.time);

    // Update history info
    updateHistoryInfo();
  }

  // Seek and report; surfaces replay determinism errors instead of dying
  function seekAndRefresh(run: () => number | null, atLimitMsg: string): void {
    try {
      const time = run();
      if (time !== null) {
        refreshDisplayAfterRestore();
      } else {
        showNotification(atLimitMsg, 'warning');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      showNotification('Replay error: ' + msg.substring(0, 120), 'error', 15000);
      console.error(error);
    }
  }

  // << / >>: back/forward one second, landing on round-number seconds
  // (the state at the step that first crossed the integer-second boundary)
  if (backStepBtn) {
    backStepBtn.addEventListener('click', () => {
      const t = gameLoop.getState().time;
      if (t <= 1e-6) {
        showNotification('Already at beginning of history', 'warning');
        return;
      }
      const target = Math.max(0, Math.ceil(t - 1e-6) - 1);
      seekAndRefresh(() => {
        let landed = gameLoop.seekToTime(target);
        // Seeks land on the step just PAST the round second, so sitting at
        // e.g. 5.003s makes "back to 5" a no-op - go one more second back
        if (landed !== null && landed >= t - 1e-9 && target > 0) {
          landed = gameLoop.seekToTime(target - 1);
        }
        return landed;
      }, 'Already at beginning of history');
    });
  }

  if (forwardStepBtn) {
    forwardStepBtn.addEventListener('click', () => {
      const t = gameLoop.getState().time;
      const target = Math.floor(t + 1e-6) + 1;
      seekAndRefresh(() => {
        const landed = gameLoop.seekToTime(target);
        // seekToTime clamps to the newest recorded state; landing where we
        // already are means there is no future to seek into
        return landed !== null && landed > t + 1e-9 ? landed : null;
      }, 'Already at end of history');
    });
  }

  // ‹ / ›: exactly one solver step back/forward, replayed from history
  const replayBackBtn = document.getElementById('replay-back-btn');
  const replayForwardBtn = document.getElementById('replay-forward-btn');
  if (replayBackBtn) {
    replayBackBtn.addEventListener('click', () => {
      const prev = gameLoop.adjacentStep(gameLoop.getPositionStep(), -1);
      if (prev === null) {
        showNotification('Already at beginning of history', 'warning');
        return;
      }
      seekAndRefresh(() => gameLoop.seekToStep(prev), 'Already at beginning of history');
    });
  }
  if (replayForwardBtn) {
    replayForwardBtn.addEventListener('click', () => {
      const next = gameLoop.adjacentStep(gameLoop.getPositionStep(), 1);
      if (next === null) {
        showNotification('Already at end of history - use Run 1 Step to advance', 'warning');
        return;
      }
      seekAndRefresh(() => gameLoop.seekToStep(next), 'Already at end of history');
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

  // Reset button - back to the very beginning of the run: the simulation as
  // it was first built, with the plant design of that time put back if the
  // plant has been edited since (an epoch change, see restoreDesignFromHistory)
  if (resetSimBtn) {
    resetSimBtn.addEventListener('click', () => {
      try {
        const landed = gameLoop.seekToStart();
        if (landed === null) {
          showNotification('No history available', 'warning');
          return;
        }
        refreshDisplayAfterRestore();
        if (!landed.exact) {
          showNotification(
            `The run's initial state is no longer in the history - landed on the oldest ` +
            `recorded state instead (t = ${formatClock(landed.time)})`, 'warning', 8000);
        } else {
          showNotification('Back at the start of the run. Resuming from here discards the recorded history after it.', 'info', 6000);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        showNotification('Could not return to the start: ' + msg.substring(0, 160), 'error', 15000);
        console.error(error);
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

    // The recorded range as at most ten expandable time bands, each cut
    // again when opened, down to the snapshots themselves; events
    // (ruptures, scrams, scenario steps, plant rebuilds) sit between the
    // snapshots they fall between. Newest first at every level. The path
    // to the current position starts expanded.
    const currentIdx = historyInfo.currentIndex >= 0 ? historyInfo.currentIndex : snapshots.length - 1;
    const positionOnSnapshot = snapshots[currentIdx] &&
      Math.abs(snapshots[currentIdx].simTime - historyInfo.currentTime) < 1e-9;
    const root = buildTimeline(snapshots, gameLoop.getHistoryEvents(), {
      maxGroups: 10,
      leafMax: 12,
      currentIndex: positionOnSnapshot ? currentIdx : undefined,
      currentTime: historyInfo.currentTime,
    });
    if (!root) {
      showNotification('No history available', 'warning');
      return;
    }
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const eventSummary = (events: typeof root.events): string => {
      if (events.length === 0) return '';
      const shown = events.slice(0, 3).map(e => `<span title="${esc(e.message)}">${eventIcon(e.type)}</span>`).join('');
      const more = events.length > 3 ? `<span class="history-more">+${events.length - 3}</span>` : '';
      return `<span class="history-events">${shown}${more}</span>`;
    };
    const renderRows = (items: NonNullable<typeof root.items>): string => {
      let out = '';
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === 'snapshot') {
          const s = it.snapshot;
          const isCurrent = positionOnSnapshot && s.index === currentIdx;
          const tag = s.kind === 'initial' ? '<span class="history-tag">start</span>'
            : s.kind === 'rebuild' ? '<span class="history-tag">rebuilt</span>'
            : s.kind === 'input' ? '<span class="history-tag">input</span>' : '';
          out += `<div class="history-item${isCurrent ? ' history-current' : ''}" data-index="${s.index}" ` +
            `title="Restore this state${s.kind === 'input' ? ' (recorded right after a control input)' : ''}">` +
            `<span>${s.isSecondMarker ? '⏱ ' : ''}t = ${s.simTime.toFixed(3)} s${tag}</span>` +
            `<span class="history-step">step ${s.stepNumber}</span></div>`;
        } else {
          const e = it.event;
          out += `<div class="history-event" data-step="${e.step}" ` +
            `title="Happened between the state below and the state above. Click to go to the first state that has it.">` +
            `<span class="history-event-icon">${eventIcon(e.type)}</span>` +
            `<span class="history-event-text">${esc(e.message)}</span>` +
            `<span class="history-step">t = ${e.simTime.toFixed(2)} s</span></div>`;
        }
      }
      return out;
    };
    const renderGroup = (g: typeof root, depth: number): string => {
      const label = g.tEnd === Infinity
        ? `from ${formatBandTime(g.tStart, g.span)}`
        : `${formatBandTime(g.tStart, g.span)} – ${formatBandTime(g.tEnd, g.span)}`;
      const open = g.containsCurrent;
      const body = g.children
        ? [...g.children].reverse().map(c => renderGroup(c, depth + 1)).join('')
        : renderRows(g.items!);
      return `<details class="history-group${g.containsCurrent ? ' history-group-current' : ''}"${open ? ' open' : ''}>` +
        `<summary title="${g.snapshotCount} recorded state${g.snapshotCount === 1 ? '' : 's'} in this span - click to expand">` +
        `<span class="history-range">${label}</span>` +
        `<span class="history-count">${g.snapshotCount}</span>${eventSummary(g.events)}</summary>` +
        `<div class="history-group-body">${body}</div></details>`;
    };
    const epochs = gameLoop.getHistoryEpochs();
    let html = '<div class="history-list">';
    if (epochs.length > 1) {
      html += `<div class="history-note" title="The plant was edited while this history was recorded. Rewinding past an edit puts the earlier design back on screen; resuming from there discards the edit.">` +
        `🔧 ${epochs.length - 1} plant edit${epochs.length > 2 ? 's' : ''} in this history</div>`;
    }
    html += root.children ? [...root.children].reverse().map(c => renderGroup(c, 0)).join('') : renderRows(root.items!);
    html += '</div>';

    historyDialogBody.innerHTML = html;

    // Clicks: a snapshot row restores it; an event row seeks to the first
    // state that contains it
    historyDialogBody.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.getAttribute('data-index') || '0', 10);
        seekAndRefresh(() => gameLoop.navigateToHistoryIndex(index), 'That state is no longer available');
        closeHistoryDialog();
      });
    });
    historyDialogBody.querySelectorAll('.history-event').forEach(item => {
      item.addEventListener('click', () => {
        const step = parseInt(item.getAttribute('data-step') || '0', 10);
        seekAndRefresh(() => gameLoop.seekToStep(step), 'That moment is no longer in the history');
        closeHistoryDialog();
      });
    });
    // Scroll the current state into view
    const current = historyDialogBody.querySelector('.history-current') as HTMLElement | null;
    if (current) current.scrollIntoView({ block: 'center' });

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

      // Step-exact: restores the nearest snapshot and replays logged dts
      seekAndRefresh(() => gameLoop.seekToTime(targetTime), 'No history found near that time');
      closeHistoryDialog();
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
      gameLoop.resetState(newSimState, serializePlantState(plantState));
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
  // Advanced solver settings sit at the bottom of the toolbar but belong to
  // the simulation controls, so they come and go with them.
  const advancedSolverSection = document.getElementById('advanced-solver-section') as HTMLDetailsElement | null;
  const constructionControls = document.getElementById('construction-controls') as HTMLDivElement;
  const constructionButtons = document.querySelectorAll('.component-btn');
  const selectedComponentDiv = document.getElementById('selected-component') as HTMLDivElement;
  const placementHintDiv = document.getElementById('placement-hint') as HTMLDivElement;

  let currentMode: 'construction' | 'simulation' = 'construction';
  let constructionSubMode: 'place' | 'connect' | 'move' = 'place';
  // Live sim state saved on entering construction mode, so returning to
  // simulation mode resumes it (edited components re-initialize instead).
  // Cleared whenever a different plant is loaded.
  let resumeSnapshot: ResumeSnapshot | null = null;
  // A live plant edit in flight (see beginLiveEdit, further down). Declared
  // here so deserializePlantState - which is defined above that block - can
  // drop it when a different plant is loaded.
  let pendingLiveEdit: PendingLiveEdit | null = null;
  let selectedComponentType: string | null = null;
  /**
   * Which way the pipe tool is holding a single ground pipe section: east-west
   * or north-south. R and the on-screen Rotate button turn it, and the
   * placement preview draws exactly the piece that will be built.
   */
  let pipeOrientation: PipeOrientation = 'EW';
  /**
   * The equipment design the selected palette button hands out, when it is a
   * supply-yard line. Null for an ordinary palette button, where the player
   * still picks a design in the placement dialog.
   */
  let selectedComponentDesign: string | null = null;
  const componentDialog = new ComponentDialog();
  const connectionDialog = new ConnectionDialog();
  // The dialog reads the racks through this rather than the plant, so it has
  // no idea a warehouse exists - it just shows a number when there is one.
  connectionDialog.setPipeStockProvider(() => pipeMetersRemaining(plantState));
  connectionDialog.setYardPipeSpecProvider(() => stockedPipeSpecId(plantState));
  // Absolute elevations in the dialog are ground + elevation + port, so it
  // needs the ground
  connectionDialog.setTerrainProvider(() => plantState.terrain);
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
   * Show what the warehouse has left on the build buttons.
   *
   * A plant with no warehouse builds from an unlimited store, so the badges
   * disappear entirely and the palette is exactly what it has always been.
   * With one, every button carries its remaining count (metres, for the two
   * pipe-laying controls) and an empty pile greys the button out with
   * `.tool-unavailable` - deliberately not the `disabled` attribute, which
   * eats the tooltip that explains why (same reasoning as the Move tool).
   *
   * Cheap enough to call on every construction change: it is ~20 buttons and
   * it skips the DOM writes when nothing about the stock has changed.
   */
  let lastStockSignature: string | null = null;
  function refreshStockBadges(): void {
    const stock = getStock(plantState);
    const signature = stock ? JSON.stringify(stock) : 'unlimited';
    if (signature === lastStockSignature) return;
    lastStockSignature = signature;

    // The yard IS the palette when there is one: rebuild its buttons first,
    // then badge everything (theirs included) in one pass.
    rebuildYardPalette(stock);

    const badge = (btn: HTMLElement, text: string | null): void => {
      const base = btn.dataset.baseLabel ?? (btn.dataset.baseLabel = btn.textContent ?? '');
      btn.textContent = base;
      if (text === null) return;
      const span = document.createElement('span');
      span.className = 'stock-badge';
      span.textContent = text;
      btn.appendChild(span);
    };

    document.querySelectorAll<HTMLButtonElement>('.component-btn').forEach(btn => {
      const paletteKey = btn.dataset.component;
      if (!paletteKey) return;
      if (btn.dataset.baseTitle === undefined) btn.dataset.baseTitle = btn.title;
      const baseTitle = btn.dataset.baseTitle || '';

      if (!stock) {
        badge(btn, null);
        btn.classList.remove('tool-unavailable');
        btn.title = baseTitle;
        return;
      }

      const storedType = storedTypeForPaletteKey(paletteKey);
      if (storedType === 'warehouse') {
        // Putting up another yard costs nothing out of this one
        badge(btn, null);
        btn.classList.remove('tool-unavailable');
        btn.title = baseTitle;
        return;
      }
      if (storedType === 'pipe') {
        const metres = pipeMetersRemaining(plantState) ?? 0;
        const specId = stockedPipeSpecId(plantState);
        const specNote = specId ? ` It is ${pipeSpecDisplayName(specId)}, and that size is fixed.` : '';
        badge(btn, `${formatMetres(metres)} m`);
        btn.classList.toggle('tool-unavailable', metres <= 0);
        btn.title = metres > 0
          ? `${formatMetres(metres)} m of pipe left in the warehouse. A run costs its own length.${specNote}`
          : 'The warehouse is out of pipe. Delete a run somewhere else to get the metres back.';
        return;
      }
      // A yard button is one stock LINE; a plain palette button is the
      // generic pile for its type.
      const design = btn.dataset.design || undefined;
      const left = componentsRemaining(plantState, storedType, design) ?? 0;
      badge(btn, `\u00d7${left}`);
      btn.classList.toggle('tool-unavailable', left <= 0);
      const name = stockLineDisplayName(storedType, design, left !== 1);
      btn.title = left > 0
        ? `${left} ${name} left in the warehouse.` + (baseTitle ? ` ${baseTitle}` : '')
        : `The warehouse has no more ${stockLineDisplayName(storedType, design, true)}. ` +
          `Deleting one that is already built puts it back on the shelf.`;
    });

    // Laying pipe on the grid spends the same metres
    const connectBtn = document.getElementById('connect-mode-btn');
    if (connectBtn) {
      if (connectBtn.dataset.baseTitle === undefined) connectBtn.dataset.baseTitle = connectBtn.title;
      const baseTitle = connectBtn.dataset.baseTitle || '';
      if (!stock) {
        badge(connectBtn, null);
        connectBtn.title = baseTitle;
      } else {
        const metres = pipeMetersRemaining(plantState) ?? 0;
        badge(connectBtn, `${formatMetres(metres)} m`);
        connectBtn.title = `${formatMetres(metres)} m of pipe left in the warehouse; ` +
          `a run costs its own length.` + (baseTitle ? ` ${baseTitle}` : '');
      }
    }

    // New buttons (or none) - re-decide what the palette shows
    applyPaletteFilter();
  }

  /**
   * The palette a supply yard hands the player: one button per STOCK LINE,
   * not one per component type. A line that names an equipment design says so
   * on its face ("Low-Pressure Service Water Pump x2") and placing from it
   * builds exactly that design with no design choice - the part is already
   * built and standing in the yard. A generic line (no design) behaves
   * exactly as the old type buttons did.
   *
   * With no warehouse the section is empty and hidden, and the palette is
   * exactly what it has always been.
   */
  function rebuildYardPalette(stock: PlantStock | null): void {
    const group = document.getElementById('yard-palette-group');
    const host = document.getElementById('yard-palette-buttons');
    if (!group || !host) return;
    host.innerHTML = '';
    if (!stock) {
      group.style.display = 'none';
      return;
    }
    group.style.display = '';

    const makeButton = (paletteKey: string, design: string | undefined,
                        label: string, title: string): void => {
      const btn = document.createElement('button');
      btn.className = 'component-btn yard-btn';
      btn.dataset.component = paletteKey;
      if (design) btn.dataset.design = design;
      btn.textContent = label;
      btn.dataset.baseLabel = label;
      btn.dataset.baseTitle = title;
      btn.title = title;
      btn.addEventListener('click', () => selectPaletteButton(btn));
      host.appendChild(btn);
    };

    // Pipe first: it is measured in metres rather than counted, and almost
    // every line the player builds needs some.
    const specId = stock.pipeSpec ?? null;
    makeButton('pipe', undefined,
      specId ? pipeSpecDisplayName(specId) : 'Pipe',
      specId
        ? `The yard's pipe: ${pipeSpecDisplayName(specId)}. Every run costs its own ` +
          `length, and the size and rating are fixed - only the route and the length are yours.`
        : 'Bulk pipe from the yard. Every run costs its own length.');

    for (const line of stock.components) {
      let paletteKey: string;
      try {
        paletteKey = paletteKeyForStockLine(line);
      } catch (e) {
        // A line naming a design nothing knows: say so on the palette rather
        // than quietly dropping the part the level meant to hand over.
        console.error(e);
        showNotification(String((e as Error).message ?? e), 'error');
        continue;
      }
      const name = stockLineDisplayName(line.type, line.design);
      makeButton(paletteKey, line.design, name,
        line.design
          ? `${name}, from the supply yard. It is already built to this design, ` +
            `so placing one asks you only where it goes and what to call it.`
          : `${name} - the yard stocks these without a specified design, so you ` +
            `choose one when you place it.`);
    }
  }

  /**
   * Update the construction cost panel with current plant costs
   */
  function updateConstructionCostPanel(): void {
    refreshStockBadges();
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

    // R turns the ground pipe section the pipe tool is holding
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && plantCanvas.isPipeTool()) {
      e.preventDefault();
      pipeOrientation = plantCanvas.rotatePipeOrientation();
      refreshPipeTool();
      return;
    }

    // Delete key removes what is selected (but not Backspace - that's for
    // text editing). Works in both modes: while the plant is running the
    // simulation is rebuilt around the removal. A selected pipe RUN goes
    // first: it is the thing the click most recently picked out.
    if (e.key === 'Delete' && (currentMode === 'construction' || liveBuildAllowed())) {
      const selectedRun = plantCanvas.getSelectedConnection();
      if (selectedRun) {
        e.preventDefault();
        deletePlantConnection(selectedRun);
        return;
      }
    }
    if (e.key === 'Delete' && selectedComponentId &&
        (currentMode === 'construction' || liveBuildAllowed())) {
      e.preventDefault();
      requestComponentDelete(selectedComponentId);
      return;
    }

    // The remaining shortcuts drive the simulation
    if (currentMode === 'construction') return;

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

    // Snapshot BEFORE the dialog is populated. The write-back inside
    // beginLiveEdit is what puts the CURRENT conditions into the IC fields
    // the dialog reads, and the snapshot has to be taken after it or every
    // component would come back looking edited.
    const liveSnap = beginLiveEdit();

    componentDialog.showEdit(component as Record<string, any>, (properties) => {
      if (properties) {
        constructionManager.updateComponent(componentId, properties);

        // Round-trip audit: re-read every dialog field from the updated model
        // and fail LOUDLY if anything the user submitted didn't stick. Every
        // hit here is a write-path/read-path disagreement (a bug), or a
        // model-side adjustment the user must know about.
        const mismatches = auditComponentEditSync(component as Record<string, any>, properties);
        if (mismatches.length > 0) {
          console.error(`[EditSync] Dialog edit of ${componentId} did not round-trip - ` +
            `these fields differ between what was submitted and what the model now holds:`, mismatches);
          const detail = mismatches
            .map(m => `${m.label}: entered ${JSON.stringify(m.submitted)}, model has ${JSON.stringify(m.actual)}`)
            .join('; ');
          showNotification(
            `⚠ Edit of "${component.label || componentId}" did not fully apply - ${detail}. ` +
            `This is a dialog/model sync bug - please report it.`,
            'error', 15000);
        }

        // If editing a controller, update the game loop scram setpoints
        if (component.type === 'controller') {
          gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
        }
        // Rebuild the running simulation around the edit: the edited
        // component re-initializes from the values the dialog just showed
        // (which are its live conditions), everything else carries on
        commitLiveEdit(liveSnap, `Editing ${component.label || componentId}`);
        // Refresh the component detail panel
        if (gameLoop) {
          updateComponentDetail(componentId, plantState, gameLoop.getState());
        }
      } else {
        // Cancelled: nothing changed, let the clock go again
        abandonLiveEdit(liveSnap);
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
      startupSourceNps: (barrel as any).startupSourceNps ?? 1e9,
      autoPoison: barrel.autoPoison !== false,
      ...(barrel.burnablePoisonPcm !== undefined ? { burnablePoisonPcm: barrel.burnablePoisonPcm } : {}),
    };
    console.log(`[EditCore] open for ${reactorVesselId}: barrel ${rv.coreBarrelId} thermalPower=${((barrel.thermalPower ?? 3000e6) / 1e6).toFixed(0)} MWt`);

    const liveSnap = beginLiveEdit();

    componentDialog.showEdit(coreRecord, (properties) => {
      if (!properties) { abandonLiveEdit(liveSnap); return; }
      console.log(`[EditCore] apply to ${reactorVesselId}: thermalPower=${properties.thermalPower} MWt, diameter=${properties.diameter} m, enrichment=${properties.enrichmentPct}%`);
      const result = constructionManager.addCoreToContainer(reactorVesselId, properties);
      if (result.success) {
        commitLiveEdit(liveSnap, `Editing the core in ${rv.label || reactorVesselId}`);
        updateConstructionCostPanel();
        if (gameLoop) updateComponentDetail(reactorVesselId, plantState, gameLoop.getState());
        showNotification('Core updated', 'info');
      } else {
        abandonLiveEdit(liveSnap);
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
    requestComponentDelete(componentId);
  });

  // START/STOP and the speed slider on a pump's panel. In a career level the
  // order goes to the operator panel's field crew (a walk of some seconds);
  // in the sandbox it lands at once, as an input the history records.
  setPumpControlCallback((componentId: string, order: { running?: boolean; speed?: number }) => {
    if (gameMode?.orderPump(componentId, order)) return;
    const pump = gameLoop.getState()?.components.pumps.get(componentId);
    if (!pump) {
      showNotification(`${componentId} has no pump in the running simulation`, 'warning');
      return;
    }
    gameLoop.updateState(state => {
      const p = state.components.pumps.get(componentId);
      if (!p) return state;
      if (order.speed !== undefined) {
        p.speed = order.speed;
        if (order.speed > 0 && order.running === undefined) p.running = true;
      }
      if (order.running !== undefined) {
        p.running = order.running;
        if (order.running && p.speed <= 0) p.speed = 1.0;
      }
      return state;
    });
    const p = gameLoop.getState().components.pumps.get(componentId)!;
    showNotification(`${componentId}: ${p.running ? `running, setpoint ${(p.speed * 100).toFixed(0)}%` : 'stopped'}`, 'info', 3000);
    updateComponentDetail(componentId, plantState, gameLoop.getState());
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

    // One dialog, one apply path: editPlantConnection edits the PLANT
    // connection and rebuilds the running simulation around it. (This used
    // to poke the simulation connection's geometry directly and leave its
    // inertance stale until the next restart.)
    editPlantConnection(plantConn);
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
    editPlantConnection(plantConn);
  });

  // Grid view: clicking a pipe run selects it; clicking the selected run
  // again while building opens its edit dialog (same one as the detail
  // panel's Edit button)
  plantCanvas.onConnectionSelect = (conn, again) => {
    if (conn && again && (currentMode === 'construction' || liveBuildAllowed())) {
      editPlantConnection(conn);
    }
  };

  function editPlantConnection(plantConn: Connection): void {
    // Get the components
    const fromComponent = plantState.components.get(plantConn.fromComponentId);
    const toComponent = plantState.components.get(plantConn.toComponentId);

    if (!fromComponent || !toComponent) {
      console.error(`[Edit] Components not found for connection`);
      return;
    }

    const liveSnap = beginLiveEdit();

    // Show the edit dialog
    connectionDialog.edit(plantConn, fromComponent, toComponent, (result: ConnectionEditResult | null) => {
      if (result) {
        // Lengthening a run costs the extra metres; shortening it hands them
        // back. Refused, the edit does not happen at all - so the connection
        // must be left exactly as it was, including the fields above.
        const lengthEdit = applyConnectionLengthEdit(plantState, plantConn, result.length);
        if (!lengthEdit.ok) {
          abandonLiveEdit(liveSnap);
          showNotification(lengthEdit.reason, 'warning');
          return;
        }

        // Update the connection with new values
        plantConn.fromElevation = result.fromElevation;
        plantConn.toElevation = result.toElevation;
        plantConn.flowArea = result.flowArea;
        plantConn.fromOpeningHeight = result.fromOpeningHeight;
        plantConn.toOpeningHeight = result.toOpeningHeight;
        updateConstructionCostPanel();

        // Rebuild: bore and length set the flow area and the inertance, which
        // are baked into the simulation connection at build time. An edited
        // run restarts at zero flow (resume.ts only carries momentum across
        // connections that did not change).
        commitLiveEdit(liveSnap,
          `Editing the pipe ${fromComponent.label || plantConn.fromComponentId} \u2192 ${toComponent.label || plantConn.toComponentId}`);

        // Refresh the component detail panel
        const selectedId = plantCanvas.getSelectedComponentId?.();
        if (selectedId) {
          updateComponentDetail(selectedId, plantState, gameLoop?.getState() || {} as SimulationState);
        }
      } else {
        abandonLiveEdit(liveSnap);
      }
    },
    // Delete: the dialog closes and releases its own snapshot first, then
    // this runs as an edit of its own (see ConnectionDialog.handleDelete).
    () => deletePlantConnection(plantConn));
  }

  // Connection delete callback
  setConnectionDeleteCallback((fromId: string, toId: string) => {
    if (confirm(`Delete connection between ${fromId} and ${toId}?`)) {
      const label = `the pipe ${fromId} \u2192 ${toId}`;
      const deleted = removeConnectionRun(
        plantState.connections.find(
          c => c.fromComponentId === fromId && c.toComponentId === toId),
        label, () => constructionManager.deleteConnection(fromId, toId));
      if (deleted) {
        updateConstructionCostPanel();
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

  // View mode selector: the tile grid (shown as "2D") or the 2.5D
  // perspective. The choice is remembered across sessions; a setting saved
  // by the retired flat plan view lands on the grid.
  const viewModeButtons: Array<[ViewMode, string]> = [
    ['grid', 'view-mode-grid'],
    ['perspective', 'view-mode-perspective'],
  ];
  const viewAngleControl = document.getElementById('view-angle-control');
  const gridViewHint = document.getElementById('grid-view-hint');
  function applyViewMode(mode: ViewMode, persist: boolean): void {
    plantCanvas.setViewMode(mode);
    for (const [m, id] of viewModeButtons) {
      document.getElementById(id)?.classList.toggle('active', m === mode);
    }
    if (viewAngleControl) viewAngleControl.style.display = mode === 'perspective' ? '' : 'none';
    if (gridViewHint) gridViewHint.style.display = mode === 'grid' ? '' : 'none';
    // Ground pipe is a grid affordance; leaving the grid disarms the tool
    refreshPipeTool();
    if (persist) saveSettings({ ...loadSettings(), viewMode: mode });
  }
  for (const [m, id] of viewModeButtons) {
    document.getElementById(id)?.addEventListener('click', () => applyViewMode(m, true));
  }
  /**
   * Measure the floating panels that cover the canvas (the toolbar down the
   * left, the career HUD across the top) and hand the rectangle they leave to
   * the canvas, so fit-to-plant does not put half the plant behind the
   * toolbar. Measured rather than hard-coded: the toolbar's width follows its
   * content and the HUD is not always there.
   */
  function refreshViewportInsets(): void {
    const rectOf = (id: string) => {
      const el = document.getElementById(id);
      if (!el || el.offsetParent === null) return null;
      return el.getBoundingClientRect();
    };
    const toolbar = rectOf('toolbar');
    const hud = document.querySelector('.gm-hud') as HTMLElement | null;
    plantCanvas.setViewportInsets({
      left: toolbar ? toolbar.right + 8 : 0,
      top: hud ? hud.getBoundingClientRect().height + 8 : 0,
      // The gas legend and the status bar are drawn ON the canvas, so there
      // is no element to measure - this is their combined height.
      bottom: 60,
    });
  }

  const savedViewMode = loadSettings().viewMode as string | undefined;
  applyViewMode(savedViewMode === 'grid' || savedViewMode === '2d' ? 'grid' : 'perspective', false);

  // Grid view: the canvas lays pipe along the tiles itself and hands the
  // finished route here. The dialog's length field is seeded with the drawn
  // plan length plus the climb between the two ports; the route is kept
  // with the connection (or the pipe it creates) for drawing.
  // Grid view: a press on open ground with the pipe tool armed lays pipe
  // there - a bare click drops one section, a sweep lays the whole run.
  plantCanvas.onGroundPipe = (route) => layGroundPipeRun(route);

  plantCanvas.onRouteComplete = (from, to, route, planLength) => {
    if (from.component.id === to.component.id) {
      showNotification('Cannot connect component to itself', 'warning');
      return;
    }
    const portAbsElevation = (c: PlantComponent, port: Port) =>
      terrainHeightAt(plantState.terrain, c.position) + (c.elevation ?? 0) +
      getComponentVisualHeight(c) / 2 - port.position.y;
    const rise = Math.abs(portAbsElevation(from.component, from.port) - portAbsElevation(to.component, to.port));
    if (connectionStatus) {
      connectionStatus.textContent = `Pipe laid: ${planLength.toFixed(1)} m along the grid`;
    }
    openConnectionDialog(from, to, route, planLength + rise);
  };

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

  // View zoom slider (magnifies the 2.5D view independently of view angle).
  // The slider is logarithmic (value = 100*log10(zoom)) so equal drags feel
  // like equal zoom ratios; the canvas keeps the readout in sync itself.
  const viewZoomSlider = document.getElementById('view-zoom') as HTMLInputElement;
  if (viewZoomSlider) {
    viewZoomSlider.addEventListener('input', () => {
      const value = parseInt(viewZoomSlider.value, 10);
      plantCanvas.setIsoZoom(Math.pow(10, value / 100));
    });
  }

  // ============================================================================
  // Save/Load Configuration
  // ============================================================================
  const STORAGE_PREFIX = 'meltdown_config_';
  const openSaveLoadBtn = document.getElementById('open-save-load-btn') as HTMLButtonElement;

  // Serialize PlantState to JSON-compatible object (shared with Jack's
  // bug-report bundle, so a report carries exactly what a save file does)
  function serializePlantState(state: PlantState): object {
    return serializePlantDesign(state);
  }

  // Deserialize JSON object back to PlantState
  function deserializePlantState(data: any): void {
    // A different plant invalidates any saved mode-switch resume state, and
    // any live edit still waiting on an open dialog (commitLiveEdit refuses
    // a superseded snapshot rather than resuming the old plant onto this one)
    resumeSnapshot = null;
    pendingLiveEdit = null;
    // Jobs describe parts of a plant that is about to stop existing
    buildQueue.clear();
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

    // Timed accident sequence, if the preset ships one (a plant without one
    // must not inherit the previous preset's)
    plantState.scenario = data.scenario ?? undefined;
    // Ground, likewise: a flat plant must not keep the previous one's hills
    plantState.terrain = data.terrain ?? undefined;

    // Migration: convert legacy reactor vessels (sibling architecture) to new architecture (parent-child)
    migrateReactorVessels(plantState);

    // Migration: ensure pipes have endPosition for proper 3D rendering
    migratePipeEndpoints(plantState);

    // Restore construction-path invariants (port.connectedTo flags, canonical
    // pump port geometry/orientation) that raw JSON doesn't carry
    constructionManager.normalizeLoadedPlant();

    // Plants are laid out for the 2.5D camera; the grid camera goes to them,
    // aiming at the part of the canvas the floating panels leave visible.
    refreshViewportInsets();
    plantCanvas.centerOnPlant();
  }

  /**
   * A seek landed in a different epoch of the rewind history: the restored
   * state describes the plant as it was designed THEN (before or after an
   * edit), so the design on screen must follow. Swaps the plant's contents
   * in place - the PlantState object itself is shared by every panel and
   * closure - without touching the history, the resume snapshot or the
   * camera, then re-derives everything main.ts keeps from the plant
   * (scram setpoints, panels, selection).
   */
  function restoreDesignFromHistory(epoch: HistoryEpoch, previousEpochId: number): void {
    if (epoch.design == null) {
      // The history cannot say what this epoch's plant looked like (a history
      // saved before designs were recorded). The state is restored; the
      // plant on screen is not - say so loudly rather than pretend.
      const msg =
        `Rewound into a stretch of the history (epoch ${epoch.id}: ${epoch.label}) whose plant design ` +
        `was not recorded. The simulation state is restored, but the plant on screen is still the ` +
        `epoch-${previousEpochId} design and may not match it.`;
      console.error('[History] ' + msg);
      showNotification(msg, 'error', 15000);
      return;
    }
    if (pendingLiveEdit) {
      // A live-edit gesture was open against the plant we are about to
      // replace; it cannot be committed onto another design
      console.warn('[History] Dropping an open live-edit gesture: the plant design changed under it.');
      abandonLiveEdit(pendingLiveEdit);
    }
    const design = deserializePlantDesign(epoch.design as Record<string, unknown>);
    plantState.components.clear();
    for (const [id, component] of design.components) plantState.components.set(id, component);
    plantState.connections = design.connections;
    plantState.scenario = design.scenario;
    plantState.terrain = design.terrain;
    migrateReactorVessels(plantState);
    migratePipeEndpoints(plantState);
    constructionManager.normalizeLoadedPlant();

    gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
    if (selectedComponentId && !plantState.components.has(selectedComponentId)) {
      selectedComponentId = null;
      if (selectedComponentDiv) selectedComponentDiv.textContent = 'No component selected';
    }
    // The renderer keys its per-connection cache on the connections array,
    // which was just replaced - the next frame rebuilds it. Repaint the
    // plant-derived panels now; refreshDisplayAfterRestore (run by every
    // seek path after this) does the state-derived ones.
    updateReactorControlsVisibility();
    updateConstructionCostPanel();
    console.log(
      `[History] Plant design restored from epoch ${epoch.id} (${epoch.label}) - ` +
      `${plantState.components.size} components, ${plantState.connections.length} connections ` +
      `(was epoch ${previousEpochId})`);
    showNotification(
      `Rewound past an edit: the plant is back to its design ${epoch.id === 0 ? 'at the start of the run' : `after "${epoch.label}"`}`,
      'info', 6000);
  }
  gameLoop.onEpochChange = restoreDesignFromHistory;

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
  // state rides along with the design (localStorage), Jack's open plot
  // panels ride as their small request specs, and the rewind history goes
  // to IndexedDB - it runs to tens of MB, far past the localStorage quota.
  function saveConfiguration(name: string): boolean {
    try {
      const data = serializePlantState(plantState) as Record<string, unknown>;
      let saveHistory = false;
      if (currentMode === 'simulation') {
        const sim = gameLoop.getState();
        if (sim && sim.flowNodes.size > 0) {
          data.simState = serializeSimulationState(sim);
          saveHistory = true;
        }
      }
      const plots = getOpenPlotInputs();
      if (plots.length > 0) data.jackPlots = plots;
      const json = JSON.stringify(data);
      localStorage.setItem(STORAGE_PREFIX + name, json);

      if (saveHistory) {
        const record = {
          version: 1 as const,
          savedAt: new Date().toISOString(),
          simTime: gameLoop.getState().time,
          history: gameLoop.exportHistory(),
        };
        saveHistoryRecord(name, record)
          .then(() => console.log(`[Save] Rewind history for '${name}' stored in IndexedDB`))
          .catch((e) => {
            console.error('[Save] Failed to store rewind history:', e);
            showNotification(
              `Saved '${name}', but storing the rewind history failed (${String(e)}). ` +
              `Loading this save will resume without step-back history.`,
              'warning', 10000);
          });
      }
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
      gameLoop.setSimulationState(restored, serializePlantState(plantState));
      plantCanvas.setSimState(restored);
      syncSimulationToVisuals(restored, plantState);
      updatePauseButton();
      // The per-frame update path is idle while paused - refresh the time
      // display, debug pane, etc. against the restored state explicitly
      refreshDisplayAfterRestore();
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
      closeAllPlots(); // old panels reference the previous plant's history
      deserializePlantState(data);
      restoreSimStateIfPresent(data);

      // Rewind history + Jack's plot panels come back asynchronously
      // (IndexedDB); plots wait for the history so they draw the full past
      if (data.simState) {
        loadHistoryRecord(name)
          .then((record) => {
            if (record && record.version === 1) {
              gameLoop.importHistory(record.history as ReturnType<typeof gameLoop.exportHistory>);
              updateHistoryInfo();
              console.log(`[Load] Rewind history restored (${gameLoop.getHistoryInfo().count} snapshots)`);
            } else if (record) {
              console.warn(`[Load] Saved history for '${name}' has unknown version - skipped`);
            }
          })
          .catch((e) => {
            console.error('[Load] Failed to restore rewind history:', e);
            showNotification(
              `Loaded '${name}', but restoring the rewind history failed (${String(e)}).`,
              'warning', 10000);
          })
          .finally(() => {
            if (data.jackPlots) {
              const n = restorePlots(
                data.jackPlots,
                (a, b) => gameLoop.getHistoryStates(a, b),
                gameLoop.getState().time
              );
              if (n > 0) console.log(`[Load] Restored ${n} plot panel(s)`);
            }
          });
      }
      return true;
    } catch (e) {
      console.error('[Load] Failed to load configuration:', e);
      return false;
    }
  }

  // Delete configuration by name (and its IndexedDB history record)
  function deleteConfiguration(name: string): boolean {
    try {
      localStorage.removeItem(STORAGE_PREFIX + name);
      deleteHistoryRecord(name).catch((e) =>
        console.warn('[Delete] Failed to delete stored history:', e));
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

    // Every way out of the dialog (close, backdrop, Escape, loading a preset)
    // goes through here, so the Escape listener must come off with the
    // overlay - a leftover one would try to remove it again on the next
    // Escape pressed anywhere (e.g. abandoning a pipe in grid view)
    const cleanup = () => {
      document.removeEventListener('keydown', escHandler);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    function escHandler(e: KeyboardEvent) {
      if (e.key === 'Escape') cleanup();
    }

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
        label: 'Xe-100 (HTGR)', data: xe100PresetData,
        tooltip: 'X-energy Xe-100: 200 MWt helium pebble-bed at 60 bar, 750°C core outlet, ' +
          'with a coaxial hot gas duct and a helical once-through steam generator modeled with ' +
          'moving phase boundaries (water in the tubes - an SG tube leak pushes steam INTO the ' +
          'primary, where hot graphite gasifies it to H₂ and CO). Walk-away safe: trip the ' +
          'circulator and watch decay heat leave through the reflector.',
      },
      {
        label: 'Xe-100 Station Blackout', data: xe100SboPresetData,
        tooltip: 'The Xe-100 with a scripted station blackout at t = 400 s: circulator, feed and ' +
          'condensate pumps trip, turbine shut, no scram. Nothing is left but temperature ' +
          'feedback and the reflector-to-cavity heat path - watch fission power die on its own ' +
          'and decay heat soak into the graphite. The event fires automatically; a notification ' +
          'marks it.',
      },
      {
        label: 'Xe-100 SG Tube Rupture', data: xe100SgtrPresetData,
        tooltip: 'The Xe-100 with a scripted turbine trip at t = 400 s (the boiler bottles up ' +
          'toward the dump setpoint) followed by an SG tube rupture at t = 550 s: 165-bar steam ' +
          'into 60-bar helium, carried to the hot graphite where it gasifies to H₂ and CO. ' +
          'Both events fire automatically; notifications mark them.',
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
    document.addEventListener('keydown', escHandler);

    saveNameInput.focus();
  }

  // Open Save/Load dialog button
  if (openSaveLoadBtn) {
    openSaveLoadBtn.addEventListener('click', showSaveLoadDialog);
  }

  // ==========================================================================
  // Live plant edits: build while the simulation runs
  // ==========================================================================
  //
  // Every plant change made in simulation mode goes through this pair, so the
  // pause/rebuild/resume sequence exists exactly once. beginLiveEdit() writes
  // the live state back into the components' initial-condition fields (which
  // is what makes an edit dialog opened next show CURRENT conditions) and
  // snapshots the plant; commitLiveEdit() rebuilds from the edited plant and
  // transplants the live state of everything that did not change.
  //
  // Where live editing does not apply (construction mode, career mode)
  // beginLiveEdit() returns null and commitLiveEdit() does nothing, so the
  // edit sites below behave exactly as they did before.

  /** Told the user once that a live edit clears the rewind history. */

  /**
   * Whether the plant may be built while it runs. Sandbox: yes. Career mode:
   * normally no - construction there is an OUTAGE, and GameModeManager bills
   * repairs and lost generation when you leave simulation mode
   * (beforeModeSwitch). Building mid-run would walk straight past that, so
   * career keeps the stop-the-plant-to-build rule and the palette stays
   * hidden while running.
   *
   * The exception is a level flagged `liveBuild` (LevelDef): an emergency the
   * player builds their way out of with the plant live. Such a level has no
   * outage to bill - the manager refuses the switch back to construction
   * mode altogether - so there is nothing to walk past.
   */
  function liveBuildAllowed(): boolean {
    return !gameMode?.active || gameMode.liveBuild;
  }

  interface PendingLiveEdit {
    snapshot: LiveEditSnapshot;
    /** The clock was running when the edit started, so put it back running. */
    wasRunning: boolean;
  }

  // At most one edit gesture is in flight (dialogs are modal); the variable
  // itself is declared at the top of init() - see the note there.

  /**
   * Start an edit gesture: hold the clock, write the live state into the
   * components' IC fields, and snapshot the plant.
   *
   * THE CLOCK HAS TO STOP FOR THE WHOLE GESTURE, not just the rebuild. The
   * per-frame syncSimulationToVisuals writes display values into the very
   * component fields the snapshot compares to tell an edited component from
   * an untouched one, so a single frame between the snapshot and the rebuild
   * makes EVERY component look edited and re-initializes the whole plant.
   * Holding it also means the dialog shows exactly the conditions the resumed
   * simulation will carry.
   *
   * Returns null wherever live editing does not apply (construction mode,
   * career mode, an empty simulation) - the caller then behaves as before.
   */
  function beginLiveEdit(): PendingLiveEdit | null {
    // A dialog abandoned by opening another one would otherwise leave the
    // clock stopped on a snapshot nobody is going to commit
    if (pendingLiveEdit) abandonLiveEdit(pendingLiveEdit);
    // Construction mode (the mode switch resumes instead) and career mode
    // (construction is an outage there) both fall through: the plant edit
    // still happens, it just does not rebuild the running simulation.
    if (currentMode !== 'simulation' || !liveBuildAllowed()) return null;
    const liveState = gameLoop.getState();
    if (!liveState || liveState.flowNodes.size === 0) return null;
    const wasRunning = !gameLoop.getIsPaused();
    gameLoop.pause();
    updatePauseButton();
    pendingLiveEdit = { snapshot: beginLivePlantEdit(liveState, plantState), wasRunning };
    return pendingLiveEdit;
  }

  /** The gesture ended without a plant change (cancelled dialog, failed
   *  creation): let the clock go again. */
  function abandonLiveEdit(pending: PendingLiveEdit | null): void {
    if (!pending || pendingLiveEdit !== pending) return; // already superseded
    pendingLiveEdit = null;
    if (pending.wasRunning) gameLoop.resume();
    updatePauseButton();
  }

  /**
   * Rebuild the running simulation around an edit that has already been made
   * to the plant. Returns true when the simulation was rebuilt.
   *
   * The rebuild is synchronous and can take tens of milliseconds on a big
   * plant; the clock has been stopped since beginLiveEdit and is put back the
   * way it was afterwards, so no frame ever steps a half-built state. If the
   * factory refuses the edited design, the plant is put back exactly as it
   * was and the simulation keeps running the state it already had - a running
   * simulation that no longer describes the plant on screen would be far
   * worse than a rejected edit.
   */
  function commitLiveEdit(pending: PendingLiveEdit | null, what: string): boolean {
    if (!pending) return false;
    if (pendingLiveEdit !== pending) {
      // Superseded: another edit gesture started, or a different plant was
      // loaded, while this dialog was open. The snapshot describes a plant
      // that no longer exists, so it cannot be resumed onto this one.
      console.warn(`[LiveEdit] ${what}: dropped - the plant changed while the dialog was open.`);
      return false;
    }
    pendingLiveEdit = null;
    const { snapshot, wasRunning } = pending;

    let result;
    try {
      const deterministicCheckbox = document.getElementById('deterministic-mode') as HTMLInputElement;
      setSimulationRandomSeed(deterministicCheckbox?.checked ? 0 : undefined);
      result = commitLivePlantEdit(plantState, snapshot);
    } catch (error) {
      revertLivePlantEdit(plantState, snapshot);
      if (wasRunning) gameLoop.resume();
      updatePauseButton();
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[LiveEdit] ${what}: the edited plant could not be built - reverted.`, error);
      showErrorDialog(
        'Cannot apply that change to the running plant',
        `${what} could not be turned into a simulation, so the change was undone and ` +
        `the plant is still running as it was.\n\n${message}`,
        // The plant survived the failed edit, so this is wrong behavior with a
        // workaround (build the same thing in construction mode), not a stopper.
        { severity: 'medium', error });
      return false;
    }

    // The rewind history keeps the pre-edit plant as an earlier epoch: the
    // rebuilt state opens a new one at the current position (its snapshots
    // carry a different node set, so no replay ever crosses the edit), and
    // seeking back past the edit puts the old design back on screen
    // (restoreDesignFromHistory). Step numbering continues.
    //
    // The clock is stopped from here until the finally below. Anything that
    // throws while repainting the panels must NOT leave it stopped - a plant
    // frozen by a display bug is the worst possible failure of a live edit.
    try {
      gameLoop.rebuildSimulationState(result.state, serializePlantState(plantState), what);
      gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
      plantCanvas.setSimState(result.state);
      refreshDisplayAfterRestore();
      updateConstructionCostPanel();
      // A reactor (or a turbine) can be built while the plant runs
      updateReactorControlsVisibility();
    } finally {
      if (wasRunning) gameLoop.resume();
      updatePauseButton();
    }

    console.log(`[LiveEdit] ${what}: ${result.notes.join('; ')}`);
    showNotification(
      `${what} applied to the running plant - ${result.notes[0]}`,
      'info', 6000);
    return true;
  }


  // ==========================================================================
  // Building takes time
  // ==========================================================================
  //
  // A part placed while the plant runs is NOT dropped into the simulation the
  // moment its dialog is confirmed. It goes into `buildQueue` as a ghost -
  // present in the plant so it can be seen, selected and cancelled, excluded
  // from the simulation by the factory - and the live edit that actually puts
  // it in the plant runs once, when its timer fires. Taking a part back to
  // the yard is the same job in reverse. See src/game/build-queue.ts for the
  // rate and where it comes from.

  const buildQueue = new BuildQueue();

  /**
   * Whether a build should be timed. Only while the plant is running: in
   * construction mode the plant is stopped and there is nothing to be late
   * for, so a build there lands immediately as it always has.
   */
  function buildsAreTimed(): boolean {
    return currentMode === 'simulation' && liveBuildAllowed() &&
      (gameLoop.getState()?.flowNodes.size ?? 0) > 0;
  }

  /** Everything in the plant right now, to diff a construction call against. */
  function capturePlantParts(): { components: Set<string>; connections: Set<Connection> } {
    return {
      components: new Set(plantState.components.keys()),
      connections: new Set(plantState.connections),
    };
  }

  function newPartsSince(before: { components: Set<string>; connections: Set<Connection> }) {
    const components: PlantComponent[] = [];
    for (const [id, c] of plantState.components) {
      if (!before.components.has(id)) components.push(c);
    }
    const connections = plantState.connections.filter(c => !before.connections.has(c));
    return { components, connections };
  }

  /**
   * Hold a freshly created part as a ghost until it is built.
   *
   * The construction manager has already made the plant change and charged
   * the yard for it, and the caller is holding an open live-edit snapshot.
   * Returns true when the queue took the job, in which case the caller must
   * NOT commit that snapshot - the part is not in the simulation yet.
   */
  function queueNewParts(
    label: string,
    parts: { components: PlantComponent[]; connections: Connection[] },
    liveSnap: PendingLiveEdit | null
  ): boolean {
    if (!buildsAreTimed()) return false;
    if (parts.components.length === 0 && parts.connections.length === 0) return false;
    abandonLiveEdit(liveSnap);
    const massKg = parts.components.reduce((s, c) => s + componentBuildMassKg(c), 0)
      + parts.connections.reduce((s, c) => s + connectionBuildMassKg(c), 0);
    const job = buildQueue.enqueue({
      kind: 'build',
      label,
      massKg,
      targets: [...parts.components, ...parts.connections] as Buildable[],
      finish: (apply) => {
        liveEdit(`Building ${label}`, apply);
        showNotification(`${label} is built and in service.`, 'info', 4000);
      },
      abandon: (apply) => {
        apply();
        for (const conn of parts.connections) {
          constructionManager.deleteConnection(conn.fromComponentId, conn.toComponentId);
        }
        for (const c of parts.components) constructionManager.deleteComponent(c.id);
        showNotification(`${label} cancelled - the parts are back in the yard.`, 'info', 4000);
        updateConstructionCostPanel();
      },
    });
    showNotification(
      `Building ${label}: ${formatClock(job.simSeconds)} of plant time ` +
      `(${Math.round(job.massKg)} kg to install). It joins the plant when it is finished.`,
      'info', 5000);
    updateConstructionCostPanel();
    return true;
  }

  /**
   * The wave takes what it closes over (src/simulation/wave-casualties.ts
   * decides what; this carries it out). Checked on every state update, and
   * acted on OUTSIDE the loop's own update because removing a component is
   * a live edit - a rebuild of the simulation - which cannot happen in the
   * middle of the step that noticed it. Nothing is refunded: a part at the
   * bottom of the sea is not back on the shelf, and a part still being
   * built there is lost with it. Rewinding past the wave brings them back,
   * since the removal is an ordinary plant edit in the history.
   */
  let waveCasualtiesQueued = false;
  function checkWaveCasualties(state: SimulationState): void {
    if (waveCasualtiesQueued || currentMode !== 'simulation') return;
    const lost = waveCasualties(plantState, state);
    if (lost.length === 0) return;
    waveCasualtiesQueued = true;
    window.setTimeout(() => {
      waveCasualtiesQueued = false;
      try {
        washAway(lost, state.time);
      } catch (error) {
        console.error('[Wave] Could not remove the components the wave took:', error);
        showNotification('The wave reached the plant, and removing what it took failed: ' +
          (error instanceof Error ? error.message : String(error)).substring(0, 160), 'error', 15000);
      }
    }, 0);
  }

  function washAway(lost: WaveCasualty[], simTime: number): void {
    // Still there? (the player may have rewound, or deleted it, meanwhile)
    const taken = lost.filter(c => plantState.components.has(c.id));
    if (taken.length === 0) return;
    for (const c of taken) {
      const component = plantState.components.get(c.id);
      const job = component ? buildQueue.jobFor(component as Buildable) : null;
      if (job) buildQueue.discard(job.id);
    }
    liveEdit(`The wave took ${taken.map(c => c.label).join(', ')}`, () => {
      for (const c of taken) {
        if (plantState.components.has(c.id)) constructionManager.destroyComponent(c.id);
      }
    });
    for (const c of taken) {
      addWreck(c.bodyId, c.position, simTime);
      gameLoop.reportEvent('washed-away',
        `THE WAVE TOOK ${c.label.toUpperCase()}: the sea stood ${(c.surface - c.washAwayElevation).toFixed(1)} m over it. ` +
        `It is gone - nothing of it goes back to the yard.`,
        { componentId: c.id, bodyId: c.bodyId });
    }
    if (selectedComponentId && !plantState.components.has(selectedComponentId)) {
      plantCanvas.clearSelection();
      selectedComponentId = null;
      updateComponentDetail(null, plantState, gameLoop.getState());
    }
    updateConstructionCostPanel();
  }

  /**
   * Remove a component: instantly with the plant stopped, otherwise as a
   * timed return to the yard. A part still under construction is CANCELLED
   * instead, which refunds it at once - nothing has been installed to undo.
   */
  function removeComponentPart(
    componentId: string, label: string, before?: () => void
  ): void {
    const component = plantState.components.get(componentId);
    const pending = component ? buildQueue.jobFor(component as Buildable) : null;
    if (pending) {
      buildQueue.cancel(pending.id);
      updateConstructionCostPanel();
      return;
    }
    if (!component || !buildsAreTimed()) {
      liveEdit(`Removing ${label}`, () => {
        before?.();
        constructionManager.deleteComponent(componentId);
      });
      return;
    }
    const job = buildQueue.enqueue({
      kind: 'return',
      label,
      massKg: componentBuildMassKg(component),
      targets: [component as Buildable],
      finish: (apply) => {
        liveEdit(`Returning ${label}`, () => {
          apply();
          before?.();
          constructionManager.deleteComponent(componentId);
        });
        showNotification(`${label} is back in the yard.`, 'info', 4000);
        updateConstructionCostPanel();
      },
      abandon: (apply) => apply(),
    });
    showNotification(
      `Returning ${label}: ${formatClock(job.simSeconds)} of plant time. ` +
      `It keeps running until it is out.`, 'info', 5000);
  }

  /** The same, for a run of pipe. */
  function removeConnectionRun(
    conn: Connection | undefined, label: string, del: () => boolean
  ): boolean {
    const pending = conn ? buildQueue.jobFor(conn as unknown as Buildable) : null;
    if (pending) {
      buildQueue.cancel(pending.id);
      updateConstructionCostPanel();
      return true;
    }
    if (!conn || !buildsAreTimed()) {
      let deleted = false;
      liveEdit(`Removing ${label}`, () => { deleted = del(); });
      return deleted;
    }
    buildQueue.enqueue({
      kind: 'return',
      label,
      massKg: connectionBuildMassKg(conn),
      targets: [conn as unknown as Buildable],
      finish: (apply) => {
        liveEdit(`Returning ${label}`, () => {
          apply();
          del();
        });
        updateConstructionCostPanel();
      },
      abandon: (apply) => apply(),
    });
    return true;
  }

  /** A live edit with no dialog in the middle: snapshot, mutate, rebuild. */
  function liveEdit(what: string, mutate: () => void): void {
    const pending = beginLiveEdit();
    try {
      mutate();
    } catch (error) {
      if (pending) {
        revertLivePlantEdit(plantState, pending.snapshot);
        abandonLiveEdit(pending);
      }
      throw error;
    }
    commitLiveEdit(pending, what);
  }

  /**
   * Does this plant have anything a reactor operator would operate? A reactor
   * vessel, a core barrel or a fuel assembly - or a turbine, which is what
   * puts megawatts on the grid.
   *
   * Read off the PLANT, not off the mode and not off a career-level flag: a
   * spent fuel pool, a test loop or a boiler house has no rods to pull, no
   * boron to add, nothing to scram and nothing to sell, and a panel full of
   * controls that do nothing is worse than no panel. Build a reactor while it
   * runs and the panel comes straight back (every live edit refreshes this).
   *
   * A spent fuel pool holds fuel and is deliberately NOT a reactor: it has no
   * control rods, and its `pool` type is not in the list.
   */
  function plantHasReactorControls(): boolean {
    // Compared as strings: 'fuelAssembly' and 'turbine' are ComponentTypes
    // that no current PlantComponent interface claims, and a plant loaded
    // from JSON may still carry them.
    const OPERATED = new Set(['reactorVessel', 'coreBarrel', 'fuelAssembly', 'turbine', 'turbine-generator']);
    for (const component of plantState.components.values()) {
      if (OPERATED.has(component.type as string)) return true;
      // A standalone core is stored as a fuelled vessel (see stock.ts)
      const fuelled = component as { fuelRodCount?: number; thermalPower?: number };
      if ((component.type === 'vessel' || component.type === 'tank') &&
          ((fuelled.fuelRodCount ?? 0) > 0 || (fuelled.thermalPower ?? 0) > 0)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Show or hide the reactor operator's controls (rods, boron, SCRAM) and the
   * MW-to-grid readout to match the plant. The MW panel is a simulation-mode
   * readout, so it stays down in construction mode whatever the plant is.
   */
  function updateReactorControlsVisibility(): void {
    const show = plantHasReactorControls();
    const panel = document.getElementById('reactor-controls');
    if (panel) panel.style.display = show ? 'block' : 'none';
    const mwPanel = document.getElementById('mw-to-grid-panel');
    if (mwPanel) mwPanel.style.display = show && currentMode === 'simulation' ? 'block' : 'none';
  }

  function setMode(mode: 'construction' | 'simulation'): void {
    // Career mode gates mode switches (BUILD required before operating;
    // returning to construction mid-run is an outage with repair billing)
    if (gameMode && !gameMode.beforeModeSwitch(mode)) {
      return;
    }
    // Stopping the plant is when the outstanding work gets done: nothing is
    // left half-installed on a map the player is about to rebuild, and the
    // clock that was paying for it has stopped.
    if (mode === 'construction') buildQueue.finishAll();
    const previousMode = currentMode;
    currentMode = mode;

    const editSection = document.getElementById('edit-section');

    if (mode === 'construction') {
      // Leaving simulation mode: write the live state back into the
      // components' initial conditions (so edit dialogs show current
      // conditions) and save the state so re-entering simulation mode
      // resumes it - except for components the user edits meanwhile
      if (previousMode === 'simulation') {
        const liveState = gameLoop.getState();
        if (liveState && liveState.flowNodes.size > 0) {
          writeSimulationStateToPlant(liveState, plantState);
          resumeSnapshot = captureResumeSnapshot(liveState, plantState);
        }
      }

      // Construction mode
      modeConstructionBtn?.classList.add('active');
      modeSimulationBtn?.classList.remove('active');

      // Hide simulation controls, show construction controls
      if (simControls) simControls.style.display = 'none';
      if (advancedSolverSection) advancedSolverSection.style.display = 'none';
      if (constructionControls) constructionControls.style.display = 'block';
      if (editSection) editSection.style.display = 'block';
      // The overnight-cost readout is a money panel: a level with no economy
      // (nothing is bought, the warehouse is the limit) leaves it down.
      if (constructionCostPanel) {
        constructionCostPanel.style.display = gameMode?.moneyHidden ? 'none' : 'block';
        updateConstructionCostPanel();
      }

      // MW to grid is a simulation-mode readout (and only for a plant that
      // has a turbine at all)
      updateReactorControlsVisibility();

      // Enable construction mode visuals (grid, outlines)
      plantCanvas.setConstructionMode(true);
      plantCanvas.setBuildMode(true);
      plantCanvas.setMoveMode(constructionSubMode === 'move');
      setBuildToolsAvailable(true);

      // Pause simulation. Refresh the button even though it is hidden here:
      // it is the label the user meets on the way back into simulation mode,
      // and init() paints it before the first pause() ever runs.
      gameLoop.pause();
      updatePauseButton();

    } else {
      // Simulation mode.
      //
      // Build the simulation BEFORE touching any UI. The factory throws on a
      // design it cannot wire (an unmappable port, a leak path that names no
      // flow node), and a throw part-way through the switch used to leave the
      // worst possible state: simulation controls on screen, the pause button
      // still showing whatever it last said, and the game loop quietly running
      // the PREVIOUS state - so the clock advanced while the plant on screen
      // never moved. Nothing below commits until the state exists.
      let newSimState: SimulationState;
      let resumed = false;
      try {
        // Set random seed for deterministic mode
        const deterministicCheckbox = document.getElementById('deterministic-mode') as HTMLInputElement;
        setSimulationRandomSeed(deterministicCheckbox?.checked ? 0 : undefined);
        // Always create simulation state from current plant configuration
        // (even if empty - this replaces the demo plant with an empty simulation)
        newSimState = createSimulationFromPlant(plantState);

        // Returning from a construction visit: resume the saved live state for
        // everything the user did not edit (edited/added components keep their
        // fresh factory initialization from the edited ICs)
        resumed = resumeSnapshot !== null;
        if (resumeSnapshot) {
          const notes = transplantSimulationState(newSimState, resumeSnapshot, plantState);
          console.log(`[Resume] ${notes.join('; ')}`);
          showNotification(`Simulation ${notes[0]}${notes.length > 1 ? ` (${notes.slice(1).join('; ')})` : ''}`, 'info', 8000);
          resumeSnapshot = null;
        }
      } catch (error) {
        // Stay in construction mode - the design is not simulatable yet, and
        // half a mode switch is worse than none.
        currentMode = previousMode;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Simulation] Failed to build the simulation from this plant:', error);
        showErrorDialog(
          'Cannot start the simulation',
          `The plant could not be turned into a simulation, so we are staying in construction mode.\n\n${message}`,
          { error });
        return;
      }

      modeConstructionBtn?.classList.remove('active');
      modeSimulationBtn?.classList.add('active');

      // Show simulation controls. The component palette and the connect tool
      // stay up: the plant can be built while it runs (every such edit goes
      // through commitLiveEdit). Only the cost panel folds away - it is a
      // design-stage readout, and career mode bills construction separately.
      const canBuildLive = liveBuildAllowed();
      if (simControls) simControls.style.display = 'block';
      if (advancedSolverSection) advancedSolverSection.style.display = 'block';
      if (constructionControls) constructionControls.style.display = canBuildLive ? 'block' : 'none';
      if (constructionCostPanel) constructionCostPanel.style.display = 'none';
      if (editSection) editSection.style.display = canBuildLive ? 'block' : 'none';
      // Start from the placement tool: move mode is construction-only (see
      // setBuildToolsAvailable), so leaving the canvas in it would strand it
      // in a sub-mode with no way out.
      setConstructionSubMode('place');
      setBuildToolsAvailable(false);

      // MW to grid and the rod/boron/SCRAM panel, for a plant that has a
      // reactor or a turbine to operate
      updateReactorControlsVisibility();

      // Draw the plant as a running plant (gauges, fluid levels), but keep
      // the placement/routing affordances live
      plantCanvas.setConstructionMode(false);
      plantCanvas.setBuildMode(canBuildLive);
      plantCanvas.setMoveMode(false);

      // Clear component selection
      clearPaletteSelection();
      if (selectedComponentDiv) selectedComponentDiv.textContent = 'No component selected';
      if (placementHintDiv) placementHintDiv.style.display = 'none';

      // A resumed simulation continues the rewind history as a new epoch
      // (the pre-visit plant stays seekable); a fresh build starts one
      if (resumed) {
        gameLoop.rebuildSimulationState(newSimState, serializePlantState(plantState), 'Returned from construction mode');
      } else {
        gameLoop.setSimulationState(newSimState, serializePlantState(plantState));
      }

      // Start paused so the user can look the plant over (and step through)
      // before time starts moving; career mode resumes explicitly when the
      // plant goes online. Settle the run state and its button BEFORE the
      // display work below, so that if any of it throws the loop is at least
      // stopped and the button is not inviting a click that says "pause" and
      // does the opposite.
      gameLoop.pause();
      updatePauseButton();

      plantCanvas.setSimState(newSimState);

      // Sync simulation state back to plant components for correct rendering
      // This is needed before simulation starts so components display correctly
      syncSimulationToVisuals(newSimState, plantState);

      // Boron is a no-op without water to carry it: collapse the slider when
      // the core starts dry (gas-cooled or voided). Purely a UI default - the
      // user can expand it, and the physics works either way.
      const boronDetails = document.getElementById('boron-details') as HTMLDetailsElement | null;
      if (boronDetails) {
        const coolantNode = newSimState.neutronics.coolantNodeId
          ? newSimState.flowNodes.get(newSimState.neutronics.coolantNodeId)
          : undefined;
        const waterDensity = coolantNode && coolantNode.volume > 0
          ? coolantNode.fluid.mass / coolantNode.volume
          : 0;
        boronDetails.open = waterDensity >= 10; // kg/m³ - trace steam is ~0.01-1
      }

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

      // The new state came with a fresh wall clock and no speed history; say
      // so now rather than leaving the previous plant's numbers on screen
      // until the first frame runs.
      updateWallTimeDisplay();
      updateAchievedSpeedDisplay();

      if (plantState.components.size > 0) {
      } else {
      }

      // A resumed sim starts at the saved time, not t=0 - refresh the time
      // display and everything else the paused per-frame path won't touch
      if (resumed) refreshDisplayAfterRestore();

    }
  }

  if (modeConstructionBtn) {
    modeConstructionBtn.addEventListener('click', () => setMode('construction'));
  }

  if (modeSimulationBtn) {
    modeSimulationBtn.addEventListener('click', () => setMode('simulation'));
  }

  // Component selection handlers
  /**
   * Picking a part off the palette. Shared by the static type buttons and by
   * the supply-yard buttons, which are rebuilt whenever the stock changes and
   * so cannot live in the NodeList captured at load.
   *
   * A yard button carries `data-design`: the equipment design that button
   * hands out, which the placement dialog then shows fixed.
   */
  function selectPaletteButton(button: HTMLButtonElement): void {
    const componentType = button.dataset.component;
    const design = button.dataset.design || null;
    if (!componentType) return;

    // Out of stock: say so rather than opening a dialog that cannot be
    // confirmed. (The button is greyed with a class, not `disabled`, so the
    // click still arrives here and the tooltip still works.)
    if (button.classList.contains('tool-unavailable')) {
      showNotification(button.title, 'warning');
      return;
    }

    // If clicking the same part again, deselect it
    if (selectedComponentType === componentType && selectedComponentDesign === design) {
      clearPaletteSelection();
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

    clearPaletteSelection();

    // Select this component
    button.classList.add('selected');
    selectedComponentType = componentType;
    selectedComponentDesign = design;

    // Update UI
    if (selectedComponentDiv) {
      // baseLabel is the button text without its stock badge
      selectedComponentDiv.textContent =
        `Selected: ${button.dataset.baseLabel ?? button.textContent}`;
    }
    if (placementHintDiv) {
      placementHintDiv.style.display = 'block';
    }
    refreshPipeTool();
  }

  /**
   * Drop the current palette selection. Queries the document rather than the
   * NodeList captured at load, because the supply-yard buttons are created
   * (and replaced) as the stock changes.
   */
  function clearPaletteSelection(): void {
    document.querySelectorAll('.component-btn').forEach(b => b.classList.remove('selected'));
    selectedComponentType = null;
    selectedComponentDesign = null;
    refreshPipeTool();
  }

  /**
   * The pipe tool. Selecting pipe from the palette (or from the supply yard)
   * on the grid does two things at once, because on the grid they are one
   * job: connection points become visible and clickable, so a press on one
   * starts a run to another port exactly as the Connect tool does, AND a
   * press anywhere else lays pipe on the ground there.
   *
   * Only on the grid: ground pipe is laid tile by tile, and the perspective
   * view has no tile lattice to lay it on. There the Pipe button keeps its
   * old behaviour (the placement dialog).
   */
  function refreshPipeTool(): void {
    const armed = selectedComponentType === 'pipe' &&
      constructionSubMode === 'place' &&
      plantCanvas.getViewMode() === 'grid' &&
      (currentMode === 'construction' || liveBuildAllowed());
    plantCanvas.setPipeTool(armed, pipeOrientation);
    // The pipe tool IS connection mode while it is armed. Leaving connect
    // mode's own state alone: this only turns the port markers on.
    plantCanvas.setShowPorts(armed || constructionSubMode === 'connect');

    const rotateBtn = document.getElementById('pipe-rotate-btn') as HTMLButtonElement | null;
    if (rotateBtn) {
      rotateBtn.style.display = armed ? '' : 'none';
      rotateBtn.textContent = pipeOrientation === 'EW'
        ? 'Rotate section (R): east-west'
        : 'Rotate section (R): north-south';
    }
    if (placementHintDiv) {
      placementHintDiv.textContent = armed
        ? 'Click a connection point to run pipe to another one. Click open ground to drop a section, or drag to lay a run - ends that meet connect themselves. R turns the section.'
        : 'Click to place';
    }
  }

  /**
   * A run laid on open ground with the pipe tool: it becomes a standalone
   * pipe COMPONENT along the route drawn, and any loose end that lands on
   * another loose end (or on a nozzle facing it) is connected on contact.
   *
   * The stock rule, in one place: ground pipe costs its own route length off
   * the racks, once, and the joins it makes are zero-length connections that
   * cost nothing - the ends are touching, there is no pipe between them. A
   * run drawn port to port is unchanged: it costs the length the connection
   * dialog confirms. Nothing is charged twice.
   */
  function layGroundPipeRun(route: Point[]): void {
    if (currentMode !== 'construction' && !liveBuildAllowed()) return;
    // The yard hands out one line size when it names one; without a yard the
    // pipe is the palette's own default service line.
    const specId = stockedPipeSpecId(plantState);
    const spec = specId ? getPipeSpecById(specId) : null;
    if (specId && !spec) {
      showNotification(`The warehouse names a pipe specification '${specId}' that does not exist.`, 'error');
      return;
    }
    const name = `Pipe ${constructionManager.getNextIdNumber()}`;
    // The same shape as a placement: snapshot, lay it, then either hand it
    // to the build queue as a ghost or commit it straight away.
    const liveSnap = beginLiveEdit();
    const partsBefore = capturePlantParts();
    let laid: { id: string; joined: number } | null = null;
    try {
      laid = constructionManager.layGroundPipe({
        name,
        diameter: spec?.diameter ?? 0.3,
        pressureRating: spec?.pressureRating ?? 155,
        elevation: 0,
        initialPhase: 'liquid',
        initialPressure: 1,
        initialTemperature: 25,
      }, route);
    } catch (error) {
      if (liveSnap) {
        revertLivePlantEdit(plantState, liveSnap.snapshot);
        abandonLiveEdit(liveSnap);
      }
      throw error;
    }
    const result = laid as { id: string; joined: number } | null;
    if (!result) {
      abandonLiveEdit(liveSnap);
      updateConstructionCostPanel();
      const refused = constructionManager.takeStockRefusal();
      showNotification(refused ?? 'Could not lay that pipe', refused ? 'warning' : 'error');
      return;
    }
    const metres = formatMetres(routePlanLength(route));
    if (queueNewParts(`${metres} m of pipe`, newPartsSince(partsBefore), liveSnap)) {
      updateConstructionCostPanel();
      return;
    }
    commitLiveEdit(liveSnap, `Laying ${name}`);
    updateConstructionCostPanel();
    showNotification(result.joined > 0
      ? `Laid ${metres} m of pipe; ${result.joined} end${result.joined === 1 ? '' : 's'} connected on contact.`
      : `Laid ${metres} m of pipe. Its ends are free - run it up to a nozzle or another pipe end to connect it.`,
      'info');
  }

  /** Plan length of a drawn route (metres). */
  function routePlanLength(route: Point[]): number {
    let total = 0;
    for (let i = 1; i < route.length; i++) {
      total += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
    }
    return total;
  }

  /**
   * Remove one pipe run and put its metres back on the racks. Used by the
   * Delete key on a selected run and by the connection dialog's Delete
   * button, so both answer to the same rule.
   */
  function deletePlantConnection(plantConn: Connection): void {
    const from = plantState.components.get(plantConn.fromComponentId);
    const to = plantState.components.get(plantConn.toComponentId);
    const label = `${from?.label || plantConn.fromComponentId} \u2192 ${to?.label || plantConn.toComponentId}`;
    const metres = plantConn.length ?? 0;
    // Through the build queue, like every other removal: instant with the
    // plant stopped, a timed return while it runs.
    const deleted = removeConnectionRun(plantConn, `the pipe ${label}`,
      () => constructionManager.deleteConnectionObject(plantConn));
    if (!deleted) {
      showNotification(`Could not remove the pipe ${label}`, 'error');
      return;
    }
    plantCanvas.clearSelection();
    updateConstructionCostPanel();
    updateComponentDetail(null, plantState, gameLoop?.getState() || {} as SimulationState);
    showNotification(getStock(plantState)
      ? `Removed the pipe ${label}; ${formatMetres(metres)} m back in the warehouse.`
      : `Removed the pipe ${label}.`, 'info');
  }

  /**
   * Delete a component, asking first what should happen to the pipe runs
   * attached to it.
   */
  function requestComponentDelete(componentId: string): void {
    const component = constructionManager.getComponent(componentId);
    if (!component) return;
    const label = component.label || componentId;
    const { keepable, doomed, joints } = constructionManager.attachedPipeRuns(componentId);
    showComponentDeleteDialog(label, keepable.length, doomed.length, joints.length, (choice) => {
      if (!choice) return;
      const wasController = component.type === 'controller';
      // Taking a part out takes as long as putting it in, so this goes
      // through the build queue: instant with the plant stopped, a timed
      // return while it runs. Leaving the runs standing happens FIRST -
      // once the component is gone there is no route left to leave them
      // along - so it rides inside the same transaction.
      removeComponentPart(componentId, label, choice === 'keep'
        ? () => constructionManager.detachConnectionsAsPipes(componentId)
        : undefined);
      if (wasController) {
        gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
      }
      plantCanvas.clearSelection();
      selectedComponentId = null;
      updateComponentDetail(null, plantState, gameLoop?.getState() || {} as SimulationState);
      updateConstructionCostPanel();
      // Say what went back on the racks - for a pipe that IS the point of
      // deleting it, and a yard that is not counting says nothing.
      const returned = getStock(plantState) === null ? '' :
        component.type === 'pipe'
          ? ` ${formatMetres((component as PipeComponent).length ?? 0)} m of pipe back in the warehouse.`
          : ' Back on the warehouse shelf.';
      showNotification(choice === 'keep' && keepable.length > 0
        ? `Removed ${label}; ${keepable.length} pipe run${keepable.length === 1 ? '' : 's'} left standing with a free end.`
        : `Removed ${label}.${returned}`, 'info');
    });
  }


  constructionButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      selectPaletteButton(e.currentTarget as HTMLButtonElement);
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

  /**
   * The components riding along with the one being dragged: everything
   * transitively inside it. Each keeps the offset it had from the dragged
   * component when the drag began, so the whole assembly translates rigidly
   * and the offsets cannot accumulate drift over a long drag; the pre-drag
   * absolute positions are kept alongside for the revert paths.
   */
  interface MoveFollower {
    comp: PlantComponent;
    dx: number; dy: number;
    endDx?: number; endDy?: number;
    preX: number; preY: number;
    preEndX?: number; preEndY?: number;
  }
  let moveFollowers: MoveFollower[] = [];

  /**
   * Everything transitively contained by `id`. Containment nests - a core
   * barrel inside a reactor vessel inside a building - so this walks the
   * whole tree rather than one level, and guards against a cycle in saved
   * data rather than hanging on it.
   */
  function containedDescendants(id: string): PlantComponent[] {
    const out: PlantComponent[] = [];
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const [childId, child] of plantState.components) {
        if ((child as any).containedBy !== parent || seen.has(childId)) continue;
        seen.add(childId);
        out.push(child);
        queue.push(childId);
      }
    }
    return out;
  }

  /** Snapshot the passengers of a drag about to start. */
  function collectMoveFollowers(container: PlantComponent): MoveFollower[] {
    return containedDescendants(container.id).map(comp => {
      const end = (comp as PipeComponent).endPosition;
      return {
        comp,
        dx: comp.position.x - container.position.x,
        dy: comp.position.y - container.position.y,
        endDx: end ? end.x - container.position.x : undefined,
        endDy: end ? end.y - container.position.y : undefined,
        preX: comp.position.x,
        preY: comp.position.y,
        preEndX: end?.x,
        preEndY: end?.y,
      };
    });
  }

  /** Put every passenger back at its stored offset from the container. */
  function applyMoveFollowers(container: PlantComponent): void {
    for (const f of moveFollowers) {
      f.comp.position.x = container.position.x + f.dx;
      f.comp.position.y = container.position.y + f.dy;
      const end = (f.comp as PipeComponent).endPosition;
      if (end && f.endDx !== undefined && f.endDy !== undefined) {
        end.x = container.position.x + f.endDx;
        end.y = container.position.y + f.endDy;
      }
    }
  }

  /**
   * Nudge a component's elevation by one arrow click, carrying everything
   * inside it so an assembly keeps its internal geometry - raising a vessel
   * must not leave its core barrel behind at the old height.
   *
   * Rounded to the millimetre only to keep repeated 0.5 m steps from
   * accumulating float dust in the readout; the value is not snapped to a
   * grid, so a component that started at 6.3 m steps to 6.8, not 6.5.
   */
  function nudgeElevation(componentId: string, delta: number): void {
    const target = plantState.components.get(componentId);
    if (!target) return;
    const tidy = (v: number) => Math.round(v * 1000) / 1000;

    for (const comp of [target, ...containedDescendants(componentId)]) {
      const c = comp as any;
      c.elevation = tidy((c.elevation ?? 0) + delta);
      const pipe = comp as PipeComponent;
      if (pipe.type === 'pipe' && pipe.endElevation !== undefined) {
        // Translate the pipe, do not tilt it
        pipe.endElevation = tidy(pipe.endElevation + delta);
      }
    }

    if (selectedComponentId) {
      updateComponentDetail(selectedComponentId, plantState, gameLoop.getState());
    }
    updateConstructionCostPanel();
  }

  /** Undo a drag: the component itself and everything that rode with it. */
  function revertMove(moved: PlantComponent, preDrag: { x: number; y: number; endX?: number; endY?: number }): void {
    moved.position.x = preDrag.x;
    moved.position.y = preDrag.y;
    const pipe = moved as PipeComponent;
    if (pipe.endPosition && preDrag.endX !== undefined && preDrag.endY !== undefined) {
      pipe.endPosition.x = preDrag.endX;
      pipe.endPosition.y = preDrag.endY;
    }
    for (const f of moveFollowers) {
      f.comp.position.x = f.preX;
      f.comp.position.y = f.preY;
      const end = (f.comp as PipeComponent).endPosition;
      if (end && f.preEndX !== undefined && f.preEndY !== undefined) {
        end.x = f.preEndX;
        end.y = f.preEndY;
      }
    }
  }

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

  // Canvas pointer move handler for visual feedback and dragging
  // (pointer events cover mouse and touch; see PlantCanvas.setupEventListeners)
  canvas.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return; // second finger of a pinch
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

    if (currentMode !== 'construction' && !liveBuildAllowed()) {
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
              // Move both ends together (translate the whole pipe, and the
              // grid route drawn for it)
              const target = plantCanvas.snapComponentPosition(pipe, {
                x: worldClick.x - moveStartOffset.x,
                y: worldClick.y - moveStartOffset.y,
              });
              const dx = target.x - pipe.position.x;
              const dy = target.y - pipe.position.y;
              pipe.position.x += dx;
              pipe.position.y += dy;
              pipe.endPosition.x += dx;
              pipe.endPosition.y += dy;
              if (pipe.route) {
                pipe.route = pipe.route.map(p => ({ x: p.x + dx, y: p.y + dy }));
              }
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
          // Non-pipe components: move normally (snapped to the tile lattice in grid view)
          const target = plantCanvas.snapComponentPosition(movingComponent, {
            x: worldClick.x - moveStartOffset.x,
            y: worldClick.y - moveStartOffset.y,
          });
          movingComponent.position.x = target.x;
          movingComponent.position.y = target.y;
        }
        // Anything inside the component rides along. Dragging one END of a
        // pipe reshapes it rather than translating it, so passengers stay put
        // in that case (a pipe contains nothing anyway).
        if (movingComponent.type !== 'pipe' || pipeDragMode === 'both') {
          applyMoveFollowers(movingComponent);
        }
        // Update component detail panel to show new position immediately
        if (selectedComponentId) {
          updateComponentDetail(selectedComponentId, plantState, gameLoop.getState());
        }
        canvas.style.cursor = 'grabbing';
      } else if (plantCanvas.getElevationArrowAtScreen({ x, y })) {
        canvas.style.cursor = 'pointer';
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

  // Pointer down handler for starting drag in move mode
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) {
      // Second finger down = pinch gesture: abandon any in-progress component
      // drag and put the component back where it started.
      if (isDraggingComponent && movingComponent && movePreDrag) {
        revertMove(movingComponent, movePreDrag);
      }
      movingComponent = null;
      isDraggingComponent = false;
      moveLocked = false;
      movePreDrag = null;
      moveFollowers = [];
      return;
    }
    if (currentMode !== 'construction') return;
    if (constructionSubMode !== 'move') return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Elevation arrows sit on top of everything and are checked first, so a
    // click on one nudges height instead of starting a plan-position drag
    const arrow = plantCanvas.getElevationArrowAtScreen({ x, y });
    if (arrow) {
      nudgeElevation(arrow.componentId, arrow.delta);
      e.preventDefault();
      return;
    }

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
      moveFollowers = collectMoveFollowers(component);

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

          if (plantCanvas.getViewMode() === 'grid' && pipe.route) {
            // A pipe drawn along the grid moves as one piece
            pipeDragMode = 'both';
          } else if (distToStart < endThreshold && distToStart < distToEnd) {
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

  // Hide port tooltip when the pointer leaves the canvas
  canvas.addEventListener('pointerleave', () => {
    if (portTooltip) {
      portTooltip.classList.remove('visible');
    }
  });

  // Pointer up handler for ending drag in move mode
  canvas.addEventListener('pointerup', (e) => {
    if (!e.isPrimary) return;
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
        // Pipes drawn to the old position no longer fit; the grid view
        // routes them afresh
        if (plantCanvas.getViewMode() === 'grid') plantCanvas.rerouteConnectionsOf(moved.id);
        const carried = moveFollowers.length;
        showNotification(
          `Moved ${moved.label || moved.id}` +
          (carried > 0 ? ` and ${carried} component${carried === 1 ? '' : 's'} inside it` : ''),
          'info'
        );
      }
      moveFollowers = [];

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
      // Revert the move entirely - the component and its passengers
      revertMove(moved, preDrag);
    }
    if (selectedComponentId) {
      updateComponentDetail(selectedComponentId, plantState, gameLoop.getState());
    }
  }

  // Canvas click handler for placing components or making connections.
  // Runs in both modes - a plant can be built while it is running (each
  // change is absorbed by commitLiveEdit). In simulation mode the sub-mode
  // is 'place' with nothing selected until the player picks a component, so
  // ordinary clicks fall through to selection as before.
  canvas.addEventListener('click', (e) => {
    if (currentMode !== 'construction' && !liveBuildAllowed()) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Move mode is handled by mousedown/mousemove/mouseup for drag behavior
    if (constructionSubMode === 'move') {
      return; // Don't process clicks in move mode
    }

    if (constructionSubMode === 'place' && selectedComponentType) {
      // The pipe tool already handled this press on the canvas itself: it
      // either started a port-to-port run or laid ground pipe (onGroundPipe).
      // Falling through here would open the pipe dialog on top of it.
      if (plantCanvas.isPipeTool()) return;

      // Component placement mode - convert screen to world coordinates
      // (perspective projection in 2.5D, snapped to whole tiles on the grid)
      const worldPos = plantCanvas.snapPlacementPosition(
        selectedComponentType, plantCanvas.getWorldPositionFromScreen({ x, y }));

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
        // Snapshot before the dialog opens (see beginLiveEdit): in simulation
        // mode this is what lets the new component drop into a plant that is
        // already running. A new component always starts from its factory
        // initial conditions; every other component carries on untouched.
        const liveSnap = beginLiveEdit();
        const partsBefore = capturePlantParts();
        let placed = false;

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

        // A yard part is placed to the design the yard stocks: the dialog
        // shows it, locks every field but the name, and stamps it on the
        // component so the refund goes back to the line it came from.
        // ...and if it is a yard part, there is nothing left to ask: it is
        // placed on the click, named and standing on the ground. The dialog
        // stays for generic parts, where the design is still the player's.
        const yardDesign = selectedComponentDesign ?? undefined;
        const openPlacementForm = yardDesign
          ? (type: string, pos: { x: number; y: number },
             cb: (config: ComponentConfig | null) => void,
             cores?: Array<{ id: string; label: string }>,
             gens?: Array<{ id: string; label: string }>,
             name?: string) =>
              componentDialog.showYardPlacement(type, pos, cb, cores, gens, name, yardDesign)
          : (type: string, pos: { x: number; y: number },
             cb: (config: ComponentConfig | null) => void,
             cores?: Array<{ id: string; label: string }>,
             gens?: Array<{ id: string; label: string }>,
             name?: string) =>
              componentDialog.show(type, pos, cb, cores, gens, name, undefined);
        openPlacementForm(
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
                placed = true;
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
                placed = true;

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
                const refused = constructionManager.takeStockRefusal();
                showNotification(refused ?? `Failed to create ${config.type}`,
                  refused ? 'warning' : 'error');
              }
            }

            // Absorb the new component into the running simulation (a no-op
            // in construction mode, where the mode switch does it instead) -
            // unless the plant is running, in which case the part goes into
            // the build queue as a ghost and joins the simulation when its
            // timer runs out.
            const label = config.name || config.type;
            if (placed && queueNewParts(label, newPartsSince(partsBefore), liveSnap)) {
              // held by the queue; the plant already has the ghost
            } else if (placed) commitLiveEdit(liveSnap, `Placing ${label}`);
            else abandonLiveEdit(liveSnap);

            // Clear component selection after placing
            clearPaletteSelection();
            if (selectedComponentDiv) {
              selectedComponentDiv.textContent = 'Select a component to place';
            }
            if (placementHintDiv) {
              placementHintDiv.style.display = 'none';
            }
          } else {
            // Placement cancelled
            abandonLiveEdit(liveSnap);
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
      // Grid view lays pipe from port to port itself (see onRouteComplete)
      if (plantCanvas.getViewMode() === 'grid') return;

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
          openConnectionDialog(connectingFrom, { component: portInfo.component, port: portInfo.port });
        }
      }
    }
  });


  // Connection dialog for a chosen pair of ports, then the connection itself.
  // `route`/`suggestedLength` come from a pipe drawn in grid view.
  function openConnectionDialog(
    from: { component: PlantComponent; port: Port },
    to: { component: PlantComponent; port: Port },
    route?: Point[],
    suggestedLength?: number
  ): void {
    // Snapshot before the dialog opens (see beginLiveEdit); the new run is
    // built at zero flow and every other component keeps its live state.
    const liveSnap = beginLiveEdit();
    const partsBefore = capturePlantParts();

    connectionDialog.show(
      from.component,
      to.component,
      from.port,
      to.port,
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
              config.toElevation,
              config.pressureRating,
              route
            );
          } else {
            success = constructionManager.createConnection(
              config.fromPort.id,
              config.toPort.id,
              config.fromElevation,
              config.toElevation,
              config.flowArea,
              config.length,
              undefined,
              undefined,
              route
            );
          }

          const runLabel =
            `the run ${config.fromComponent.label} \u2192 ${config.toComponent.label}`;
          if (success && queueNewParts(runLabel, newPartsSince(partsBefore), liveSnap)) {
            // Laid as a ghost; it carries nothing until the pipefitters finish
          } else if (success) {
            commitLiveEdit(liveSnap,
              `Connecting ${config.fromComponent.label} to ${config.toComponent.label}`);
            showNotification(`Connected ${config.fromComponent.label} to ${config.toComponent.label}`, 'info');
          } else {
            abandonLiveEdit(liveSnap);
            const refused = constructionManager.takeStockRefusal();
            showNotification(refused ?? 'Failed to create connection',
              refused ? 'warning' : 'error');
          }
          updateConstructionCostPanel();
        } else {
          // Connection cancelled
          abandonLiveEdit(liveSnap);
        }

        // Reset connection state
        connectingFrom = null;
        plantCanvas.setHighlightedPort(null, null); // Clear highlight
        if (connectionStatus) {
          connectionStatus.textContent = 'Select first component...';
        }
      },
      suggestedLength !== undefined ? { suggestedLength } : undefined
    );
  }

  /**
   * Enable/disable the build tools that only work with the plant stopped.
   *
   * Placing, deleting, connecting and editing all work live (the simulation
   * is rebuilt around the change). Moving does not: a drag repositions a
   * component continuously, and every intermediate position would need its
   * own rebuild - and the relocated component would re-initialize from its
   * current conditions while its pipes re-route underneath it. That is an
   * outage job, so the button says so instead of pretending.
   */
  let moveToolAvailable = true;
  function setBuildToolsAvailable(constructionMode: boolean): void {
    moveToolAvailable = constructionMode;
    if (!moveModeBtn) return;
    moveModeBtn.classList.toggle('tool-unavailable', !constructionMode);
    moveModeBtn.title = constructionMode
      ? 'Drag a component to move it in plan; use the \u25b2\u25bc buttons beside it to raise or lower it 0.5 m at a time. Anything inside a component (a core barrel in a vessel, equipment in a building) moves with it. Buildings only move once armed with their own \'Move Building\' button.'
      : 'Not available while the plant is running: relocating a component would re-initialize it from its current conditions and re-route its pipes under it, once per step of the drag. Switch to Construction mode to move things.';
  }

  // Helper to set construction sub-mode
  function setConstructionSubMode(mode: 'place' | 'connect' | 'move') {
    constructionSubMode = mode;

    // Update button states
    connectModeBtn?.classList.toggle('active', mode === 'connect');
    moveModeBtn?.classList.toggle('active', mode === 'move');

    // Show ports when in connect mode (the pipe tool shows them too - see
    // refreshPipeTool, called at the end of this function)
    plantCanvas.setShowPorts(mode === 'connect');

    // In move mode the canvas must not select on mousedown (it's the start
    // of a click-and-drag; selection happens on mouseup without movement)
    plantCanvas.setMoveMode(mode === 'move');

    // Move mode also offers elevation: drag for plan position, arrows for height
    plantCanvas.setElevationArrowsVisible(mode === 'move');

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
      moveFollowers = [];
      canvas.style.cursor = 'default';
    }

    if (mode !== 'place') {
      // Clear component selection when not in place mode
      clearPaletteSelection();
      if (selectedComponentDiv) {
        selectedComponentDiv.textContent = 'No component selected';
      }
      if (placementHintDiv) {
        placementHintDiv.style.display = 'none';
      }
    }

    refreshPipeTool();
  }

  // Rotate the ground pipe section being placed (same as the R key)
  document.getElementById('pipe-rotate-btn')?.addEventListener('click', () => {
    pipeOrientation = plantCanvas.rotatePipeOrientation();
    refreshPipeTool();
  });

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
      if (!moveToolAvailable) {
        showNotification(
          'Moving components is a construction-mode job: relocating a running component ' +
          'would re-initialize it from its current conditions and re-route its pipes under ' +
          'it. Switch to Construction mode to move things.', 'warning', 7000);
        return;
      }
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
    // With a supply yard on the map the palette IS the yard: one button per
    // stock LINE. The generic type buttons would offer parts the yard does not
    // have and a design choice the yard has already made, so they stand down -
    // all but Warehouse, which costs nothing out of the yard it edits.
    const yardActive = getStock(plantState) !== null;
    container.querySelectorAll<HTMLButtonElement>('.component-btn').forEach(btn => {
      const t = btn.dataset.component ?? '';
      const hiddenByLevel = filtering && !paletteFilterTypes!.includes(t);
      const hiddenByYard = yardActive && !btn.classList.contains('yard-btn') && t !== 'warehouse';
      // class, not inline style: .component-btn carries display:block !important
      btn.classList.toggle('palette-hidden', hiddenByLevel || hiddenByYard);
    });
    container.querySelectorAll('details').forEach(d => {
      const anyVisible = Array.from(d.querySelectorAll<HTMLButtonElement>('.component-btn'))
        .some(b => !b.classList.contains('palette-hidden'));
      (d as HTMLElement).style.display = anyVisible ? '' : 'none';
    });
    let toggle = document.getElementById('palette-filter-toggle') as HTMLButtonElement | null;
    // With a yard on the map there is no wider catalog to show: the palette is
    // the yard's own stock, and the toggle would promise parts that are not there.
    if (paletteFilterTypes !== null && !yardActive) {
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
    setSimSpeed: (speed: number) => {
      gameLoop.setSimSpeed(speed);
      updateSpeedDisplay();
    },
    setViewMode: (mode: 'grid' | 'perspective') => applyViewMode(mode, false),
    setConstructionAvailable: (available: boolean, reason: string) => {
      // The button stays clickable (setMode's career guard repeats the
      // reason as a notification); what changes is that it looks unavailable
      // and says why on hover. A disabled button would swallow the click and
      // with it the explanation.
      if (!modeConstructionBtn) return;
      if (modeConstructionBtn.dataset.baseTitle === undefined) {
        modeConstructionBtn.dataset.baseTitle = modeConstructionBtn.title;
      }
      modeConstructionBtn.classList.toggle('tool-unavailable', !available);
      modeConstructionBtn.title = available
        ? (modeConstructionBtn.dataset.baseTitle ?? '')
        : reason;
    },
  });

  // "Atom" Jack: AI contractor chat in the bottom-right corner. Constructed
  // here (like career mode) so its host closures can reach init()'s state.
  const jackHost = {
    plantState,
    constructionManager,
    getSimState: () => gameLoop.getState(),
    getHistoryStates: (tMin: number, tMax: number) => gameLoop.getHistoryStates(tMin, tMax),
    getMode: () => currentMode,
    getSelectedComponentId: () => selectedComponentId,
    refreshCostPanel: () => updateConstructionCostPanel(),
    // Bug-report reproduction bundle: the same design + state a save file
    // carries, plus the rewind history. Nothing to attach before the sim
    // has been built at least once.
    captureReproSource: () => {
      const sim = gameLoop.getState();
      if (!sim || sim.flowNodes.size === 0) return null;
      return {
        build: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
        mode: currentMode,
        plant: plantState,
        simState: sim,
        history: gameLoop.exportHistory(),
      };
    },
  };
  new JackManager(jackHost);
  // Headless-test hook: run one of Jack's tools directly (no LLM round trip)
  (window as any).__meltdownDebug.jackTool = (name: string, input: Record<string, unknown>) =>
    executeJackTool(name, input, jackHost, () => {});
  (window as any).__meltdownDebug.getPlotDrawnWindow = getPlotDrawnWindow;
  // Headless-test hook: the running clock, so a test can wind a level forward
  // to the minute it wants to look at instead of waiting for it in real time.
  (window as any).__meltdownDebug.gameLoop = gameLoop;
  (window as any).__meltdownDebug.buildQueue = buildQueue;
  // Headless-test hook: load a plant JSON (the same shape save/load and the
  // scripts/test-plants fixtures use) without going through the save slots
  (window as any).__meltdownDebug.loadPlantData = (data: unknown) => {
    deserializePlantState(data);
    updateConstructionCostPanel();
  };

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

/**
 * Give a moving-boundary exchanger's bundles their subcooled / boiling /
 * superheated split, so the renderer can paint each tube run in bands rather
 * than one averaged colour that shows a boiling tube as tepid water.
 *
 * The partition is RE-EVALUATED here rather than read from otsg.lastEval:
 * that cache is written by the rate operator onto the solver's per-stage
 * clones and never reaches the accepted state this sync sees, which is the
 * same trap the superheat-fraction sensor fell into. The partition is solved
 * from the node's own totals, so rerunning the shared evaluation on the
 * accepted state is exact, not an approximation.
 */
function syncOtsgTubeSections(simState: SimulationState, hx: HeatExchangerComponent): void {
  const bundleCount = hxBundleCount(hx as any);
  const nodeIds = hxTubeNodeIds(hx.id, bundleCount);
  const sections: NonNullable<HeatExchangerComponent['tubeSections']> = [];

  for (const nodeId of nodeIds) {
    const node = simState.flowNodes.get(nodeId);
    if (!node?.otsg) continue;
    const { ev } = evaluateOtsgSections(simState, nodeId, node);
    const P = ev.P;
    // Mean quality of the boiling band, from its own mean enthalpy - what
    // sets the liquid/vapor speckle density the pattern renderer draws
    const span = ev.sat.h_g - ev.sat.h_f;
    const xBar = span > 0
      ? Math.max(0, Math.min(1, (ev.sections[1].hBar - ev.sat.h_f) / span))
      : 0.5;
    sections.push({
      lengthFracs: [
        ev.sections[0].lengthFrac, ev.sections[1].lengthFrac, ev.sections[2].lengthFrac,
      ],
      fluids: [
        { temperature: ev.sections[0].T, pressure: P, phase: 'liquid', quality: 0, flowRate: 0 },
        { temperature: ev.sat.T, pressure: P, phase: 'two-phase', quality: xBar, flowRate: 0 },
        { temperature: ev.sections[2].T, pressure: P, phase: 'vapor', quality: 1, flowRate: 0 },
      ],
    });
  }

  if (sections.length > 0) hx.tubeSections = sections;
  else delete hx.tubeSections;
}

function syncSimulationToVisuals(simState: SimulationState, plantState: PlantState): void {
  // Sync all components to their simulation nodes
  // Uses simNodeId if set, otherwise falls back to component.id
  for (const [, component] of plantState.components) {
    const simNodeId = (component as { simNodeId?: string }).simNodeId || component.id;

    // Handle heat exchangers specially - they have primary and secondary sides
    if (component.type === 'heatExchanger') {
      // Primary side (tube bundle): try simNodeId, then {id}-primary, then {id}-tube
      const primaryNodeId = (component as { simNodeId?: string }).simNodeId || `${component.id}-primary`;
      const primaryNode = simState.flowNodes.get(primaryNodeId)
        ?? simState.flowNodes.get(`${component.id}-tube`);
      if (primaryNode && component.primaryFluid) {
        component.primaryFluid.temperature = primaryNode.fluid.temperature;
        component.primaryFluid.pressure = primaryNode.fluid.pressure;
        component.primaryFluid.phase = primaryNode.fluid.phase;
        component.primaryFluid.quality = primaryNode.fluid.quality;
        component.primaryFluid.separation = primaryNode.separation;
        // NCG and volume are what let the renderer show a gas fill (e.g. helium)
        // instead of defaulting to steam-white
        component.primaryFluid.ncg = primaryNode.fluid.ncg;
        component.primaryFluid.volume = primaryNode.volume;
        component.primaryFluid.gasVolume = nodeGasVolume(primaryNode);
        component.primaryFluid.steamPressure = steamPartialPressurePa(primaryNode);
        component.primaryFluid.liquidLevelFraction = nodeLiquidLevelFraction(primaryNode);
      }

      // Extra tube bundles: each is its own flow path and can be in a
      // completely different state from the first (one boiling, one drained),
      // so the renderer gets each bundle's own fluid rather than painting the
      // whole shell with bundle 1's.
      const bundleCount = hxBundleCount(component as any);
      if (bundleCount > 1) {
        const fluids = component.bundleFluids && component.bundleFluids.length === bundleCount
          ? component.bundleFluids
          : (component.bundleFluids = hxTubeNodeIds(component.id, bundleCount).map(
              () => ({ ...(component.primaryFluid ?? { temperature: 300, pressure: 1e5, phase: 'liquid' as const, quality: 0, flowRate: 0 }) })));
        hxTubeNodeIds(component.id, bundleCount).forEach((nodeId, b) => {
          const bundleNode = simState.flowNodes.get(nodeId);
          if (!bundleNode) return;
          fluids[b].temperature = bundleNode.fluid.temperature;
          fluids[b].pressure = bundleNode.fluid.pressure;
          fluids[b].phase = bundleNode.fluid.phase;
          fluids[b].quality = bundleNode.fluid.quality;
          fluids[b].separation = bundleNode.separation;
          fluids[b].ncg = bundleNode.fluid.ncg;
          fluids[b].volume = bundleNode.volume;
          fluids[b].gasVolume = nodeGasVolume(bundleNode);
          fluids[b].steamPressure = steamPartialPressurePa(bundleNode);
          fluids[b].liquidLevelFraction = nodeLiquidLevelFraction(bundleNode);
        });
      }

      syncOtsgTubeSections(simState, component);

      // Secondary side (shell): try {id}-secondary, then {id}-shell
      const secondaryNode = simState.flowNodes.get(`${component.id}-secondary`)
        ?? simState.flowNodes.get(`${component.id}-shell`);
      if (secondaryNode && component.secondaryFluid) {
        component.secondaryFluid.temperature = secondaryNode.fluid.temperature;
        component.secondaryFluid.pressure = secondaryNode.fluid.pressure;
        component.secondaryFluid.phase = secondaryNode.fluid.phase;
        component.secondaryFluid.quality = secondaryNode.fluid.quality;
        component.secondaryFluid.separation = secondaryNode.separation;
        component.secondaryFluid.ncg = secondaryNode.fluid.ncg;
        component.secondaryFluid.volume = secondaryNode.volume;
        component.secondaryFluid.gasVolume = nodeGasVolume(secondaryNode);
        component.secondaryFluid.steamPressure = steamPartialPressurePa(secondaryNode);
        component.secondaryFluid.liquidLevelFraction = nodeLiquidLevelFraction(secondaryNode);
      }
      continue;
    }

    // Cross-vessels carry a second display fluid for the annulus, backed by
    // its own flow node ({id}-annulus); the inner pipe (component.fluid)
    // syncs through the generic path below via simNodeId
    if (component.type === 'crossVessel') {
      const annulusNode = simState.flowNodes.get(`${component.id}-annulus`);
      const cv = component as unknown as { annulusFluid?: Fluid };
      if (annulusNode) {
        if (!cv.annulusFluid) {
          cv.annulusFluid = {
            temperature: annulusNode.fluid.temperature,
            pressure: annulusNode.fluid.pressure,
            phase: annulusNode.fluid.phase,
            flowRate: 0,
          };
        }
        cv.annulusFluid.temperature = annulusNode.fluid.temperature;
        cv.annulusFluid.pressure = annulusNode.fluid.pressure;
        cv.annulusFluid.phase = annulusNode.fluid.phase;
        cv.annulusFluid.quality = annulusNode.fluid.quality;
        cv.annulusFluid.separation = annulusNode.separation;
        cv.annulusFluid.ncg = annulusNode.fluid.ncg;
        cv.annulusFluid.volume = annulusNode.volume;
        cv.annulusFluid.gasVolume = nodeGasVolume(annulusNode);
        cv.annulusFluid.steamPressure = steamPartialPressurePa(annulusNode);
        cv.annulusFluid.liquidLevelFraction = nodeLiquidLevelFraction(annulusNode);
      }
    }

    // Spent-fuel racks: the drawings redden with the cladding temperature,
    // so it has to reach the plant component the same way fuel temperature does
    if (component.type === 'pool') {
      const rackNode = simState.thermalNodes.get(`${component.id}-clad`);
      if (rackNode) (component as { rackTemperature?: number }).rackTemperature = rackNode.temperature;
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
          component.fluid.gasVolume = nodeGasVolume(vesselNode);
        component.fluid.steamPressure = steamPartialPressurePa(vesselNode);
          component.fluid.liquidLevelFraction = nodeLiquidLevelFraction(vesselNode);
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
          component.fluid.gasVolume = nodeGasVolume(insideNode);
        component.fluid.steamPressure = steamPartialPressurePa(insideNode);
          component.fluid.liquidLevelFraction = nodeLiquidLevelFraction(insideNode);
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
          rv.outsideBarrelFluid.gasVolume = nodeGasVolume(outsideNode);
        rv.outsideBarrelFluid.steamPressure = steamPartialPressurePa(outsideNode);
          rv.outsideBarrelFluid.liquidLevelFraction = nodeLiquidLevelFraction(outsideNode);
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
        component.fluid.gasVolume = nodeGasVolume(simNode);
        component.fluid.steamPressure = steamPartialPressurePa(simNode);
        component.fluid.liquidLevelFraction = nodeLiquidLevelFraction(simNode);
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
    // Commanded setpoint of a manual-mode rod drive (rods may still be
    // traveling toward it at the drive rate limit)
    let manualRodCommand: number | undefined;
    const controllers = simState.components.controllers;
    if (controllers) {
      for (const [, ctl] of controllers) {
        if (ctl.actuator.kind !== 'control-rods') continue;
        anyRodController = true;
        if (ctl.mode !== 'manual') {
          rodControllerId = ctl.id;
          break;
        }
        manualRodCommand ??= ctl.manualOutput;
      }
    }
    const hasManualRodCtl = anyRodController && rodControllerId === null;
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
    } else if (hasManualRodCtl) {
      rodSlider.title = 'Commands the rod drive setpoint (0% = withdrawn, 100% = inserted); '
        + 'the rods travel there at the drive rate limit';
    } else {
      rodSlider.title = 'Manual control rod insertion (0% = withdrawn, 100% = inserted)';
    }

    // With a manual rod drive the slider represents the COMMANDED setpoint;
    // tracking the traveling actual position would yank the command out of
    // the user's hands (worst at high sim speed, where the rods move many
    // sim-seconds per rendered frame). Everywhere else it shows the actual.
    const commanded = !scrammed && hasManualRodCtl ? (manualRodCommand ?? rodPosition) : rodPosition;
    const commandedPercent = Math.round((1 - commanded) * 100);
    const actualPercent = Math.round((1 - rodPosition) * 100);
    const currentSliderValue = parseInt(rodSlider.value);
    // When the slider is a passive indicator, track the sim exactly; the
    // 1% deadband only exists to avoid fighting active user input, and a
    // drag in progress (pointer held on the thumb) suppresses the writeback
    // entirely - see the pointerdown/pointerup handlers where the slider is
    // wired up.
    const deadband = rodSlider.disabled ? 0 : 1;
    if (rodSlider.dataset.dragging !== '1' && Math.abs(currentSliderValue - commandedPercent) > deadband) {
      rodSlider.value = String(commandedPercent);
    }
    if (rodValueDisplay) {
      // Show the traveling actual position next to the command until they meet
      const text = actualPercent !== commandedPercent
        ? `${commandedPercent}% (rods at ${actualPercent}%)`
        : `${commandedPercent}%`;
      if (rodValueDisplay.textContent !== text) rodValueDisplay.textContent = text;
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

// ============================================================================
// Persistent "running slower than requested" bubble
// ============================================================================
// One bubble that appears while the solver can't keep up with the REQUESTED
// sim speed (which may still be faster than real time - e.g. 1.6x when the
// player asked for 2x), updates its readout in place, and disappears on
// recovery. Unlike showNotification pop-ups it never stacks or re-fires.
// Dismissing it hides it until the next distinct slowdown episode.
let slowSimBubble: HTMLDivElement | null = null;
let slowSimBubbleText: HTMLSpanElement | null = null;
let slowSimBubbleDismissed = false;
let slowSimLastBehindMs = -Infinity;

function updateSlowSimBubble(metrics: SolverMetrics, targetSpeed: number): void {
  // isFallingBehind is a per-frame verdict that can flicker under marginal
  // load; hold the bubble for 2 s past the last "behind" frame so it doesn't
  // blink (UI smoothing only - the metric itself is untouched).
  const nowMs = performance.now();
  if (metrics.isFallingBehind) slowSimLastBehindMs = nowMs;
  if (nowMs - slowSimLastBehindMs > 2000) {
    slowSimBubbleDismissed = false;
    if (slowSimBubble) {
      slowSimBubble.remove();
      slowSimBubble = null;
      slowSimBubbleText = null;
    }
    return;
  }
  if (slowSimBubbleDismissed) return;

  if (!slowSimBubble) {
    slowSimBubble = document.createElement('div');
    slowSimBubble.className = 'sim-notification';
    slowSimBubble.title = 'The physics solver cannot keep up with the requested '
      + 'simulation speed on this machine. Nothing is wrong with the simulation - '
      + 'sim time just advances more slowly than the speed setting asks for. '
      + 'Lower the sim speed setting to make the readout honest, or ignore this.';
    slowSimBubble.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 18px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 13px;
      z-index: 1999;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      max-width: 80%;
      text-align: center;
      display: flex;
      align-items: center;
      gap: 12px;
      background: #1a3a5a;
      border: 1px solid #4488aa;
      color: #d0e8ff;
      opacity: 0.9;
    `;

    slowSimBubbleText = document.createElement('span');
    slowSimBubbleText.style.flex = '1';
    slowSimBubble.appendChild(slowSimBubbleText);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Dismiss until the next slowdown';
    closeBtn.style.cssText = `
      background: transparent;
      border: none;
      color: inherit;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 0 2px;
      opacity: 0.7;
    `;
    closeBtn.addEventListener('click', () => {
      slowSimBubbleDismissed = true;
      slowSimBubble?.remove();
      slowSimBubble = null;
      slowSimBubbleText = null;
    });
    slowSimBubble.appendChild(closeBtn);
    document.body.appendChild(slowSimBubble);
  }

  const fmt = (x: number) => x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2);
  if (slowSimBubbleText && metrics.isFallingBehind) {
    slowSimBubbleText.textContent =
      `Simulation running at ${fmt(metrics.realTimeRatio)}x (requested ${fmt(targetSpeed)}x)`;
  }
}

// Show a dialog asking if user wants to place component inside a container
/**
 * Ask what should happen to the pipe runs attached to a component that is
 * about to be deleted. A question, not a warning: both answers are
 * reasonable, and which one is right depends on what the player is doing.
 *
 *  - "Delete all"  takes the runs with the component. Their metres, and the
 *                  component, go back on the warehouse shelves.
 *  - "Keep pipes"  leaves each run standing as GROUND PIPE along the very
 *                  route it was drawn along - still attached at its far end,
 *                  with a free end where the component used to be, ready for
 *                  the replacement to be plumbed straight back in. The stock
 *                  ledger nets to zero: the run's metres come back and the
 *                  pipe that replaces it costs exactly the same.
 *
 * A run can only be left standing when there is something at its other end
 * to stay attached to. One whose far end goes with the same deletion, one to
 * open air, and an opening into the vessel the component sits inside all
 * have nothing to hold them up; the dialog counts those separately and says
 * so rather than silently doing less than it offered.
 *
 * Keyboard: D deletes everything, K keeps the pipes, Escape or C cancels;
 * the focused button also answers to Enter.
 */
function showComponentDeleteDialog(
  label: string,
  keepable: number,
  doomed: number,
  joints: number,
  callback: (choice: 'all' | 'keep' | null) => void
): void {
  const total = keepable + doomed;
  // A joint carries no pipe: whatever is butted onto the component keeps
  // standing where it is, whichever answer is given.
  const jointNote = joints > 0
    ? `<p style="margin: 0 0 16px 0; font-size: 12px; color: #889;">` +
      `${joints} section${joints === 1 ? '' : 's'} of pipe ${joints === 1 ? 'is' : 'are'} ` +
      `butted straight onto it. ${joints === 1 ? 'That section stays' : 'Those stay'} exactly ` +
      `where ${joints === 1 ? 'it is' : 'they are'} - only the joint goes.</p>`
    : '';

  const overlay = document.createElement('div');
  overlay.id = 'component-delete-dialog';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
  `;

  const dialog = document.createElement('div');
  dialog.style.cssText = `
    background: #1a1e24; border: 1px solid #445566; border-radius: 8px;
    padding: 20px; max-width: 460px; color: #d0d8e0;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  `;

  const runs = (n: number) => `${n} pipe run${n === 1 ? '' : 's'}`;
  const btn = (id: string, text: string, primary: boolean, title: string, disabled = false) => `
    <button id="${id}" ${disabled ? 'data-disabled="1"' : ''} title="${title}" style="
      padding: 8px 16px;
      background: ${disabled ? '#2a2f36' : primary ? '#8a3a3a' : '#334455'};
      border: 1px solid ${disabled ? '#3a4048' : primary ? '#b05555' : '#556677'};
      border-radius: 4px;
      color: ${disabled ? '#66707a' : primary ? '#ffe8e8' : '#d0d8e0'};
      cursor: ${disabled ? 'not-allowed' : 'pointer'};
    ">${text}</button>`;

  const keepTitle = keepable > 0
    ? `Leave ${runs(keepable)} standing on the ground, still attached at the far end, ` +
      `with a free end where ${label} was. The metres stay spent; nothing extra is charged.`
    : `Nothing here can be left standing: ${total === 0 ? 'no pipe is attached' :
        'every attached run has nothing at its other end to hold it up - its far end goes ' +
        'with this deletion, it runs to open air, or it is an opening into the vessel this ' +
        'component sits inside'}.`;

  const body = total === 0
    ? (joints > 0 ? '' :
        `<p style="margin: 0 0 20px 0; line-height: 1.5;">Nothing is piped to it.</p>`) + jointNote
    : `<p style="margin: 0 0 12px 0; line-height: 1.5;">` +
      `<strong>${label}</strong> has ${runs(total)} attached. Delete ${total === 1 ? 'it' : 'them'} too?</p>` +
      (doomed > 0 && keepable > 0
        ? `<p style="margin: 0 0 16px 0; font-size: 12px; color: #c99;">` +
          `${runs(keepable)} can be left standing as loose pipe. The other ` +
          `${doomed} cannot - ${doomed === 1 ? 'it has' : 'they have'} nothing at the far ` +
          `end to stay attached to - and will be removed either way.</p>`
        : doomed > 0
          ? `<p style="margin: 0 0 16px 0; font-size: 12px; color: #c99;">` +
            `None of them can be left standing: ${doomed === 1 ? 'it has' : 'they have'} ` +
            `nothing at the far end to stay attached to (the far end goes with this ` +
            `deletion, the line runs to open air, or it is an opening into the vessel ` +
            `this component sits inside).</p>`
          : `<p style="margin: 0 0 16px 0; font-size: 12px; color: #889;">` +
            `Kept pipes stay exactly where they are drawn, attached at the far end, with a ` +
            `free end here. Deleted pipe goes back on the warehouse racks.</p>`) + jointNote;

  dialog.innerHTML = `
    <h3 style="margin: 0 0 15px 0; color: #7af;">Delete ${label}?</h3>
    ${body}
    <div style="display: flex; gap: 10px; justify-content: flex-end;">
      ${btn('cdel-cancel', 'Cancel <u>(C)</u>', false, 'Leave everything as it is. Escape does the same.')}
      ${total > 0 ? btn('cdel-keep', '<u>K</u>eep pipes', false, keepTitle, keepable === 0) : ''}
      ${btn('cdel-all', total > 0 ? '<u>D</u>elete all' : '<u>D</u>elete', true,
        `Remove ${label}${total > 0 ? ` and ${runs(total)}` : ''}. Everything goes back on the warehouse shelves.`)}
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let answered = false;
  const finish = (choice: 'all' | 'keep' | null) => {
    if (answered) return;
    answered = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    callback(choice);
  };

  const keepBtn = dialog.querySelector('#cdel-keep') as HTMLButtonElement | null;
  const keepEnabled = !!keepBtn && keepBtn.dataset.disabled !== '1';
  (dialog.querySelector('#cdel-cancel') as HTMLButtonElement).addEventListener('click', () => finish(null));
  (dialog.querySelector('#cdel-all') as HTMLButtonElement).addEventListener('click', () => finish('all'));
  keepBtn?.addEventListener('click', () => { if (keepEnabled) finish('keep'); });

  const onKey = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (e.key === 'Escape' || key === 'c') { e.preventDefault(); e.stopPropagation(); finish(null); }
    else if (key === 'd') { e.preventDefault(); e.stopPropagation(); finish('all'); }
    else if (key === 'k' && keepEnabled) { e.preventDefault(); e.stopPropagation(); finish('keep'); }
  };
  // Capture, so the canvas shortcuts underneath never see these keys
  document.addEventListener('keydown', onKey, true);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
  (dialog.querySelector('#cdel-all') as HTMLButtonElement).focus();
}

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

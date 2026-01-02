import { PlantCanvas } from './render/canvas';
// Demo plant imports - uncomment createDemoPlant and createDemoReactor to load demo on startup
// import { createDemoPlant } from './plant/factory';
import { PlantState, PlantComponent, ReactorVesselComponent, ControllerComponent } from './types';
import { GameLoop, ScramSetpoints } from './game';
import {
  // createDemoReactor,
  createSimulationFromPlant,
  SimulationState,
  SolverMetrics,
  setWaterPropsDebug,
  getWaterPropsDebugLog,
  calculateWaterState,
  enableCalculationDebug,
  getCalculationDebugLog,
  simulationConfig,
  preloadWaterProperties,
  setSeparationDebug,
} from './simulation';
import { updateDebugPanel, initDebugPanel, updateComponentDetail, setComponentEditCallback, setComponentDeleteCallback, setConnectionEditCallback, setPlantConnectionEditCallback, setConnectionDeleteCallback } from './debug';
import { ComponentDialog, ComponentConfig } from './construction/component-config';
import { ConstructionManager } from './construction/construction-manager';
import { ConnectionDialog, ConnectionConfig } from './construction/connection-dialog';

// Throttle debug panel updates to reduce flickering
const DEBUG_UPDATE_INTERVAL_MS = 250; // Update ~4 times per second
let lastDebugUpdate = 0;

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

// Initialize the application
function init() {
  const canvas = document.getElementById('plant-canvas') as HTMLCanvasElement;
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }

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
      scrammed: false,
      scramTime: 0,
      scramReason: '',
      reactivityBreakdown: { controlRods: 0, doppler: 0, coolantTemp: 0, coolantDensity: 0 },
      diagnostics: { fuelTemp: 0, coolantTemp: 0, coolantDensity: 0 },
    },
    components: {
      pumps: new Map(),
      valves: new Map(),
      checkValves: new Map(),
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

  // Bridge simulation state to visual components
  gameLoop.onStateUpdate = (state: SimulationState, metrics: SolverMetrics) => {
    // Update time display
    const timeDisplay = document.getElementById('sim-time');
    if (timeDisplay) {
      timeDisplay.textContent = `Time: ${state.time.toFixed(3)}s (${metrics.totalSteps} steps)`;
    }

    // Update speed display
    const speedDisplay = document.getElementById('sim-speed');
    if (speedDisplay) {
      const speed = gameLoop.getSimSpeed();
      speedDisplay.textContent = 'Speed: ' + speed.toFixed(1) + 'x';
      if (metrics.isFallingBehind) {
        speedDisplay.style.color = '#ff4444';
        speedDisplay.textContent += ' [LAGGING]';
      } else {
        speedDisplay.style.color = '#aaa';
      }
    }

    // Update debug panel and component detail (throttled to reduce flickering)
    const now = performance.now();
    if (now - lastDebugUpdate >= DEBUG_UPDATE_INTERVAL_MS) {
      updateDebugPanel(state, metrics);

      // Update component detail panel if something is selected
      if (selectedComponentId) {
        updateComponentDetail(selectedComponentId, plantState, state);
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
    console.log('[Event] ' + event.type + ': ' + event.message);

    // Could show notifications to user here
    if (event.type === 'scram') {
      showNotification('SCRAM: ' + event.message, 'warning');
    } else if (event.type === 'falling-behind') {
      showNotification('Simulation running slower than real time', 'info');
    }
  };

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
    if (componentId) {
      const component = plantState.components.get(componentId);
      console.log('Selected component:', component);
    }
    // Update detail panel immediately
    updateComponentDetail(selectedComponentId, plantState, gameLoop.getState());
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

  // Component placement buttons (placeholder for now)
  const componentButtons = document.querySelectorAll('#toolbar button[data-component]');
  componentButtons.forEach(button => {
    button.addEventListener('click', () => {
      componentButtons.forEach(b => b.classList.remove('selected'));
      button.classList.add('selected');
      const componentType = button.getAttribute('data-component');
      console.log('Selected component type for placement:', componentType);
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
      // Update visual vessel (visual also uses withdrawal position internally)
      for (const [, comp] of plantState.components) {
        if ((comp.type === 'vessel' || comp.type === 'reactorVessel') && comp.controlRodCount) {
          comp.controlRodPosition = withdrawalPosition;
        }
      }
    });
  }

  // Simulation speed controls
  const pauseBtn = document.getElementById('pause-btn');
  const stepBtn = document.getElementById('step-btn');
  const speedDisplay = document.getElementById('speed-display');
  const speedUpBtn = document.getElementById('speed-up');
  const speedDownBtn = document.getElementById('speed-down');
  const speedPresets = document.querySelectorAll('.speed-preset');

  function updateSpeedDisplay() {
    const speed = gameLoop.getSimSpeed();
    if (speedDisplay) {
      speedDisplay.textContent = speed >= 1 ? `${speed.toFixed(0)}x` : `${speed}x`;
    }
    // Update preset button highlighting
    speedPresets.forEach(btn => {
      const presetSpeed = parseFloat(btn.getAttribute('data-speed') || '1');
      btn.classList.toggle('active', Math.abs(speed - presetSpeed) < 0.001);
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

  if (stepBtn) {
    stepBtn.addEventListener('click', () => {
      // Execute a single timestep (1ms of simulation time - may be multiple internal steps)
      gameLoop.step(0.001);
    });
  }

  const singleStepBtn = document.getElementById('single-step-btn');
  if (singleStepBtn) {
    singleStepBtn.addEventListener('click', () => {
      // Execute exactly one internal physics step
      const dt = gameLoop.singleStep();
      console.log(`[Single Step] Advanced by ${(dt * 1e6).toFixed(3)} microseconds`);
    });
  }

  // Reset simulation button
  const resetSimBtn = document.getElementById('reset-sim-btn');
  if (resetSimBtn) {
    resetSimBtn.addEventListener('click', () => {
      // Recreate simulation from current plant state
      const newSimState = createSimulationFromPlant(plantState);
      gameLoop.resetState(newSimState);
      // Update scram setpoints from any scram controller in the plant
      gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
      console.log('[Main] Simulation reset to initial conditions');
    });
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

  // Pressure model control
  const pressureModelSelect = document.getElementById('pressure-model') as HTMLSelectElement;
  if (pressureModelSelect) {
    // Set initial value to match configuration
    pressureModelSelect.value = simulationConfig.pressureModel;

    // Handle changes
    pressureModelSelect.addEventListener('change', () => {
      simulationConfig.pressureModel = pressureModelSelect.value as 'hybrid' | 'pure-triangulation';
      console.log(`Pressure model changed to: ${simulationConfig.pressureModel}`);
    });
  }

  // Listen for auto-slowdown events to update speed display
  gameLoop.addEventListener('auto-slowdown', () => {
    updateSpeedDisplay();
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
      const newSimState = createSimulationFromPlant(plantState);
      gameLoop.resetState(newSimState);
      // SCRAM is automatically cleared since we have a fresh simulation state
      updateScramDisplay();
      console.log('[Main] SCRAM reset with initial T&H conditions');
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

  // Keyboard controls
  document.addEventListener('keydown', (e) => {
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
        }
      }
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        gameLoop.togglePause();
        updatePauseButton();
        console.log(gameLoop.getIsPaused() ? 'Paused' : 'Resumed');
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

    componentDialog.showEdit(component as Record<string, any>, (properties) => {
      if (properties) {
        constructionManager.updateComponent(componentId, properties);
        // If editing a controller, update the game loop scram setpoints
        if (component.type === 'controller') {
          gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
          console.log('[Main] Controller edited, scram setpoints updated');
        }
        // Refresh the component detail panel
        if (gameLoop) {
          updateComponentDetail(componentId, plantState, gameLoop.getState());
        }
      }
    }, availableCores);
  });

  setComponentDeleteCallback((componentId: string) => {
    if (confirm(`Delete component "${componentId}"? This will also remove all its connections.`)) {
      // Check if this is a controller before deleting
      const wasController = plantState.components.get(componentId)?.type === 'controller';

      constructionManager.deleteComponent(componentId);

      // If we deleted a controller, update the scram setpoints
      if (wasController) {
        gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
        console.log('[Main] Scram controller deleted, checking for remaining controllers');
      }

      // Clear selection
      plantCanvas.clearSelection();
      // Hide component detail panel
      updateComponentDetail(null, plantState, gameLoop?.getState() || {} as SimulationState);
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
    // Node IDs might be component IDs or internal region IDs
    const plantConn = plantState.connections.find(pc => {
      // Check if the plant connection matches (in either direction)
      const fromMatches = pc.fromComponentId === simConn.fromNodeId ||
        pc.fromComponentId.includes(simConn.fromNodeId) ||
        simConn.fromNodeId.includes(pc.fromComponentId);
      const toMatches = pc.toComponentId === simConn.toNodeId ||
        pc.toComponentId.includes(simConn.toNodeId) ||
        simConn.toNodeId.includes(pc.toComponentId);
      return fromMatches && toMatches;
    });

    if (!plantConn) {
      console.error(`[Edit] No plant connection found for sim connection ${simConnId}`);
      alert('Cannot edit this connection - it may be an automatically generated internal connection.');
      return;
    }

    // Show edit dialog
    const currentArea = plantConn.flowArea ?? 0.1;
    const currentLength = plantConn.length ?? 1;
    const currentFromElev = plantConn.fromElevation ?? 0;
    const currentToElev = plantConn.toElevation ?? 0;

    const newAreaStr = prompt(
      `Edit Connection: ${plantConn.fromComponentId} → ${plantConn.toComponentId}\n\n` +
      `Current flow area: ${(currentArea * 1e4).toFixed(1)} cm²\n` +
      `Current length: ${currentLength.toFixed(2)} m\n` +
      `From elevation: ${currentFromElev.toFixed(2)} m\n` +
      `To elevation: ${currentToElev.toFixed(2)} m\n\n` +
      `Enter new flow area in cm² (or cancel to keep current):`,
      (currentArea * 1e4).toFixed(1)
    );

    if (newAreaStr !== null) {
      const newAreaCm2 = parseFloat(newAreaStr);
      if (!isNaN(newAreaCm2) && newAreaCm2 > 0) {
        plantConn.flowArea = newAreaCm2 / 1e4; // Convert cm² to m²
        console.log(`[Edit] Updated connection flow area to ${plantConn.flowArea.toFixed(4)} m²`);

        // Also update the simulation connection directly for immediate effect
        simConn.flowArea = plantConn.flowArea;

        // Refresh the component detail panel
        const selectedId = plantCanvas.getSelectedComponentId?.();
        if (selectedId) {
          updateComponentDetail(selectedId, plantState, simState);
        }
      }
    }
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

    const currentArea = plantConn.flowArea ?? 0.1;
    const newAreaStr = prompt(
      `Edit Connection: ${plantConn.fromComponentId} → ${plantConn.toComponentId}\n\n` +
      `Current flow area: ${(currentArea * 1e4).toFixed(1)} cm²\n\n` +
      `Enter new flow area in cm²:`,
      (currentArea * 1e4).toFixed(1)
    );

    if (newAreaStr !== null) {
      const newAreaCm2 = parseFloat(newAreaStr);
      if (!isNaN(newAreaCm2) && newAreaCm2 > 0) {
        plantConn.flowArea = newAreaCm2 / 1e4;
        console.log(`[Edit] Updated plant connection flow area to ${plantConn.flowArea.toFixed(4)} m²`);

        // Refresh the component detail panel
        const selectedId = plantCanvas.getSelectedComponentId?.();
        if (selectedId) {
          updateComponentDetail(selectedId, plantState, gameLoop?.getState() || {} as SimulationState);
        }
      }
    }
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
      console.log(`[View] Isometric mode: ${plantCanvas.getIsometric() ? 'enabled' : 'disabled'}`);
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

  // Save current configuration
  function saveConfiguration(name: string): boolean {
    try {
      const data = serializePlantState(plantState);
      const json = JSON.stringify(data);
      localStorage.setItem(STORAGE_PREFIX + name, json);
      console.log(`[Save] Configuration '${name}' saved (${json.length} bytes)`);
      return true;
    } catch (e) {
      console.error('[Save] Failed to save configuration:', e);
      return false;
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
      console.log(`[Load] Configuration '${name}' loaded (${plantState.components.size} components)`);
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
      console.log(`[Delete] Configuration '${name}' deleted`);
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
        <label style="display: block; margin-bottom: 5px; color: #99aacc; font-size: 12px;">Save Current Design</label>
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
    const saveBtn = dialog.querySelector('#dialog-save-btn') as HTMLButtonElement;
    const loadBtn = dialog.querySelector('#dialog-load-btn') as HTMLButtonElement;
    const deleteBtn = dialog.querySelector('#dialog-delete-btn') as HTMLButtonElement;
    const closeBtn = dialog.querySelector('#dialog-close-btn') as HTMLButtonElement;

    const cleanup = () => document.body.removeChild(overlay);

    const refreshConfigs = () => {
      const names = getSavedConfigNames();
      configSelect.innerHTML = '<option value="">-- Select Configuration --</option>' +
        names.map(name => `<option value="${name}">${name}</option>`).join('');
    };

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
    currentMode = mode;

    if (mode === 'construction') {
      // Construction mode
      modeConstructionBtn?.classList.add('active');
      modeSimulationBtn?.classList.remove('active');

      // Hide simulation controls, show construction controls
      if (simControls) simControls.style.display = 'none';
      if (constructionControls) constructionControls.style.display = 'block';

      // Enable construction mode visuals (grid, outlines)
      plantCanvas.setConstructionMode(true);

      // Pause simulation
      gameLoop.pause();

      console.log('[Mode] Switched to Construction mode');
    } else {
      // Simulation mode
      modeConstructionBtn?.classList.remove('active');
      modeSimulationBtn?.classList.add('active');

      // Show simulation controls, hide construction controls
      if (simControls) simControls.style.display = 'block';
      if (constructionControls) constructionControls.style.display = 'none';

      // Disable construction mode visuals
      plantCanvas.setConstructionMode(false);

      // Clear component selection
      selectedComponentType = null;
      constructionButtons.forEach(btn => btn.classList.remove('selected'));
      if (selectedComponentDiv) selectedComponentDiv.textContent = 'No component selected';
      if (placementHintDiv) placementHintDiv.style.display = 'none';

      // Always create simulation state from current plant configuration
      // (even if empty - this replaces the demo plant with an empty simulation)
      const newSimState = createSimulationFromPlant(plantState);
      gameLoop.setSimulationState(newSimState);
      plantCanvas.setSimState(newSimState);

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
        realTimeRatio: 0,
        isFallingBehind: false,
        fallingBehindSince: 0,
        operatorTimes: new Map(),
      };
      updateDebugPanel(currentState, emptyMetrics);

      if (plantState.components.size > 0) {
        console.log(`[Mode] Created simulation from user plant (${plantState.components.size} components)`);
      } else {
        console.log('[Mode] Created empty simulation (no components in plant)');
      }

      console.log('[Mode] Switched to Simulation mode');
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
        console.log(`[Construction] Deselected component: ${componentType}`);
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

      console.log(`[Construction] Selected component: ${componentType}`);
    });
  });

  // Move mode state
  let movingComponent: PlantComponent | null = null;
  let moveStartOffset = { x: 0, y: 0 };
  let isDraggingComponent = false;

  // Canvas mouse move handler for visual feedback and dragging
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // DEBUG: Track cursor position for gauge debug logging
    (window as any).__debugCursor = { x: Math.round(x), y: Math.round(y) };

    if (currentMode !== 'construction') return;

    if (constructionSubMode === 'connect') {
      const hoveredPort = plantCanvas.getPortAtScreen({ x, y });
      if (hoveredPort) {
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'default';
      }
    } else if (constructionSubMode === 'move') {
      if (isDraggingComponent && movingComponent) {
        // Dragging - move the component
        const worldClick = plantCanvas.getWorldPositionFromScreen({ x, y });
        movingComponent.position.x = worldClick.x - moveStartOffset.x;
        movingComponent.position.y = worldClick.y - moveStartOffset.y;
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
    }
  });

  // Mouse down handler for starting drag in move mode
  canvas.addEventListener('mousedown', (e) => {
    if (currentMode !== 'construction') return;
    if (constructionSubMode !== 'move') return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const component = plantCanvas.getComponentAtScreen({ x, y });
    if (component) {
      // Start dragging this component
      movingComponent = component;
      isDraggingComponent = true;

      // Calculate offset from component position to click point
      const worldClick = plantCanvas.getWorldPositionFromScreen({ x, y });
      moveStartOffset.x = worldClick.x - component.position.x;
      moveStartOffset.y = worldClick.y - component.position.y;

      canvas.style.cursor = 'grabbing';
      e.preventDefault(); // Prevent text selection while dragging
    }
  });

  // Mouse up handler for ending drag in move mode
  canvas.addEventListener('mouseup', (e) => {
    if (isDraggingComponent && movingComponent) {
      showNotification(`Moved ${movingComponent.label || movingComponent.id}`, 'info');
      movingComponent = null;
      isDraggingComponent = false;
      moveStartOffset = { x: 0, y: 0 };

      // Check what's under cursor now
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hoveredComponent = plantCanvas.getComponentAtScreen({ x, y });
      canvas.style.cursor = hoveredComponent ? 'grab' : 'default';
    }
  });

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
      console.log(`[Construction] Opening config dialog for ${selectedComponentType} at world (${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)})`);

      // Check if clicking on an existing container component (tank, vessel, reactor vessel)
      const clickedComponent = plantCanvas.getComponentAtScreen({ x, y });
      const isContainer = clickedComponent && (clickedComponent.type === 'tank' || clickedComponent.type === 'vessel' || clickedComponent.type === 'reactorVessel');

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

        componentDialog.show(selectedComponentType!, placementPos, (config: ComponentConfig | null) => {
          if (config) {
            console.log(`[Construction] Component configured:`, config);

            // Special case: placing a core inside a container
            if (config.type === 'core' && containedBy && clickedComponent) {
              // Add fuel rod properties to the container (reactor vessel or tank)
              // The container handles rendering the fuel rods at the correct position
              const result = constructionManager.addCoreToContainer(containedBy, config.properties);
              if (result.success) {
                console.log(`[Construction] Added core to ${clickedComponent.label || containedBy}`);
                showNotification(`Added reactor core to ${clickedComponent.label || containedBy}`, 'info');
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
                console.log(`[Construction] Successfully created component '${componentId}'`);

                // If a scram controller was placed, update the game loop setpoints
                if (config.type === 'scram-controller') {
                  gameLoop.setScramSetpoints(getScramSetpointsFromPlant(plantState));
                  console.log('[Main] Scram controller placed, automatic scram enabled');
                }

                // The canvas will automatically re-render in its render loop
                // Just show success notification
                const containerNote = containedBy ? ` inside ${clickedComponent?.label || clickedComponent?.id}` : '';
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
            console.log(`[Construction] Component placement cancelled`);
          }
        }, availableCores);
      };

      // If clicking on a container, ask if user wants to place inside
      if (isContainer && clickedComponent) {
        const containerName = clickedComponent.label || clickedComponent.id;
        showContainmentDialog(containerName, selectedComponentType, (placeInside: boolean | null) => {
          if (placeInside === true) {
            proceedWithPlacement(clickedComponent.id);
          }
          // If placeInside is false/null, user cancelled - do nothing
        });
      } else {
        proceedWithPlacement();
      }
    } else if (constructionSubMode === 'connect') {
      // Connection mode - detect clicked port
      console.log(`[Connection] Click at (${x}, ${y})`);
      const portInfo = plantCanvas.getPortAtScreen({ x, y });
      console.log(`[Connection] Found port:`, portInfo);

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
                console.log(`[Connection Config] createPipe: ${config.createPipe}, flowArea: ${config.flowArea}, length: ${config.length}`);
                let success: boolean;
                if (config.createPipe) {
                  console.log(`[Main] Calling createConnectionWithPipe`);
                  success = constructionManager.createConnectionWithPipe(
                    config.fromPort.id,
                    config.toPort.id,
                    config.flowArea,
                    config.length,
                    config.fromElevation,
                    config.toElevation
                  );
                } else {
                  console.log(`[Main] Calling createConnection (direct)`);
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

    console.log(`[Construction] Switched to ${mode} mode`);
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

  // Start in construction mode
  setMode('construction');

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
    realTimeRatio: 0,
    isFallingBehind: false,
    fallingBehindSince: 0,
    operatorTimes: new Map(),
  };
  updateDebugPanel(simState, initialMetrics);

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

  console.log('Meltdown initialized!');
  console.log('Debug utilities available via window.meltdown:');
  console.log('  meltdown.setWaterPropsDebug(true) - Enable water property logging');
  console.log('  meltdown.setSeparationDebug(true) - Enable phase separation logging');
  console.log('  meltdown.getWaterPropsDebugLog() - Get recent log entries');
  console.log('  meltdown.getState() - Get current simulation state');
  console.log('  meltdown.pause() / meltdown.resume() - Control simulation');
  console.log('Controls:');
  console.log('  Space: Pause/Resume');
  console.log('  +/-: Speed up/slow down');
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

    // Handle reactor vessels specially - sync both inside and outside barrel regions
    if (component.type === 'reactorVessel') {
      const rv = component as ReactorVesselComponent;
      // Sync fluid from inside barrel region (core region) to component.fluid
      if (rv.insideBarrelId) {
        const insideNode = simState.flowNodes.get(rv.insideBarrelId);
        if (insideNode && component.fluid) {
          component.fluid.temperature = insideNode.fluid.temperature;
          component.fluid.pressure = insideNode.fluid.pressure;
          component.fluid.phase = insideNode.fluid.phase;
          component.fluid.quality = insideNode.fluid.quality;
          component.fluid.separation = insideNode.separation;
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
      }
    }

    // Sync pump state
    if (component.type === 'pump') {
      const pumpId = (component as { simPumpId?: string }).simPumpId || component.id;
      const pumpState = simState.components.pumps.get(pumpId);
      if (pumpState) {
        component.running = pumpState.running;
        component.speed = pumpState.speed;
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

  // Sync control rod position to vessel visual
  const rodPosition = simState.neutronics.controlRodPosition;
  for (const [, comp] of plantState.components) {
    if ((comp.type === 'vessel' || comp.type === 'reactorVessel') && comp.controlRodCount) {
      comp.controlRodPosition = rodPosition;
    }
  }

  // Update slider if simulation changed rod position (e.g., SCRAM)
  // Slider shows insertion % (100 - withdrawal position * 100)
  const rodSlider = document.getElementById('rod-position') as HTMLInputElement;
  const rodValueDisplay = document.getElementById('rod-position-value');
  if (rodSlider) {
    const insertionPercent = Math.round((1 - rodPosition) * 100);
    const currentSliderValue = parseInt(rodSlider.value);
    if (Math.abs(currentSliderValue - insertionPercent) > 1) {
      rodSlider.value = String(insertionPercent);
      if (rodValueDisplay) {
        rodValueDisplay.textContent = insertionPercent + '%';
      }
    }
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

function showNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
  const prefix = type === 'warning' ? '!' : type === 'error' ? 'X' : 'i';
  console.log('[' + prefix + '] ' + message);

  // Create visible notification element
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
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

  notification.textContent = message;
  document.body.appendChild(notification);

  // Auto-remove after delay (longer for errors)
  const duration = type === 'error' ? 5000 : type === 'warning' ? 4000 : 3000;
  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s ease-out';
    setTimeout(() => {
      if (notification.parentNode) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, duration);
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

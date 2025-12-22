import { PlantCanvas } from './render/canvas';
import { createDemoPlant } from './plant/factory';
import { PlantState } from './types';
import { GameLoop } from './game';
import {
  createDemoReactor,
  SimulationState,
  SolverMetrics,
  setWaterPropsDebug,
  getWaterPropsDebugLog,
  calculateWaterState,
  enableCalculationDebug,
  getCalculationDebugLog,
} from './simulation';
import { updateDebugPanel, initDebugPanel, updateComponentDetail } from './debug';

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
      getState: () => SimulationState | null;
      pause: () => void;
      resume: () => void;
      step: (dt?: number) => void;
      singleStep: () => number;
    };
  }
}

// Initialize the application
function init() {
  const canvas = document.getElementById('plant-canvas') as HTMLCanvasElement;
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }

  // Create demo plant (visual representation)
  const plantState: PlantState = createDemoPlant();

  // Create demo reactor (physics simulation)
  const simState: SimulationState = createDemoReactor();

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

  // Move mode toggle
  const moveModeBtn = document.getElementById('move-mode');
  if (moveModeBtn) {
    moveModeBtn.addEventListener('click', () => {
      const isActive = plantCanvas.isMoveMode();
      plantCanvas.setMoveMode(!isActive);
      moveModeBtn.classList.toggle('selected', !isActive);
      moveModeBtn.textContent = !isActive ? 'Move (ON)' : 'Move';
    });
  }

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
        if (comp.type === 'vessel' && comp.controlRodCount) {
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

  // Listen for auto-slowdown events to update speed display
  gameLoop.addEventListener('auto-slowdown', () => {
    updateSpeedDisplay();
  });

  // Initial display update
  updateSpeedDisplay();
  updatePauseButton();

  // Keyboard controls
  document.addEventListener('keydown', (e) => {
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
    getState: () => gameLoop.getState(),
    pause: () => gameLoop.pause(),
    resume: () => gameLoop.resume(),
    step: (dt?: number) => gameLoop.step(dt),
    singleStep: () => gameLoop.singleStep(),
  };

  console.log('Meltdown initialized!');
  console.log('Debug utilities available via window.meltdown:');
  console.log('  meltdown.setWaterPropsDebug(true) - Enable water property logging');
  console.log('  meltdown.getWaterPropsDebugLog() - Get recent log entries');
  console.log('  meltdown.getState() - Get current simulation state');
  console.log('  meltdown.pause() / meltdown.resume() - Control simulation');
  console.log('Controls:');
  console.log('  Space: Pause/Resume');
  console.log('  +/-: Speed up/slow down');
  console.log('  S: Manual SCRAM');
  console.log('  Mouse drag: Pan view');
  console.log('  Mouse wheel: Zoom');
}

function syncSimulationToVisuals(simState: SimulationState, plantState: PlantState): void {
  // Sync all components that have a simNodeId to their simulation node
  for (const [, component] of plantState.components) {
    const simNodeId = (component as { simNodeId?: string }).simNodeId;
    if (simNodeId && component.fluid) {
      const simNode = simState.flowNodes.get(simNodeId);
      if (simNode) {
        component.fluid.temperature = simNode.fluid.temperature;
        component.fluid.pressure = simNode.fluid.pressure;
        component.fluid.phase = simNode.fluid.phase;
        component.fluid.quality = simNode.fluid.quality;
        // Note: flowRate comes from FlowConnections, not FluidState
      }
    }
  }

  // Sync heat exchanger primary/secondary fluids
  // Find heat exchangers by type since IDs are auto-generated
  const sgPrimary = simState.flowNodes.get('sg-primary');
  const sgSecondary = simState.flowNodes.get('sg-secondary');
  for (const [, comp] of plantState.components) {
    if (comp.type === 'heatExchanger') {
      const sgComponent = comp;
      if (sgPrimary && sgComponent.primaryFluid) {
        sgComponent.primaryFluid.temperature = sgPrimary.fluid.temperature;
        sgComponent.primaryFluid.pressure = sgPrimary.fluid.pressure;
        sgComponent.primaryFluid.phase = sgPrimary.fluid.phase;
        sgComponent.primaryFluid.quality = sgPrimary.fluid.quality;
      }
      if (sgSecondary && sgComponent.secondaryFluid) {
        sgComponent.secondaryFluid.temperature = sgSecondary.fluid.temperature;
        sgComponent.secondaryFluid.pressure = sgSecondary.fluid.pressure;
        sgComponent.secondaryFluid.phase = sgSecondary.fluid.phase;
        sgComponent.secondaryFluid.quality = sgSecondary.fluid.quality;
      }
    }
  }

  // Sync fuel temperature to reactor vessel
  const fuelNode = simState.thermalNodes.get('fuel');
  if (fuelNode) {
    for (const [, comp] of plantState.components) {
      if (comp.type === 'vessel' && comp.fuelRodCount) {
        comp.fuelTemperature = fuelNode.temperature;
      }
    }
  }

  // Sync pump state
  const pump = plantState.components.get('pump-1');
  const pumpState = simState.components.pumps.get('rcp-1');
  if (pump && pump.type === 'pump' && pumpState) {
    pump.running = pumpState.running;
    pump.speed = pumpState.speed;
  }

  // Sync control rod position to vessel visual
  const rodPosition = simState.neutronics.controlRodPosition;
  for (const [, comp] of plantState.components) {
    if (comp.type === 'vessel' && comp.controlRodCount) {
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

  // Sync turbine state
  const turbineInlet = simState.flowNodes.get('turbine-inlet');
  const turbineOutlet = simState.flowNodes.get('turbine-outlet');
  for (const [, comp] of plantState.components) {
    if (comp.type === 'turbine') {
      // Update inlet/outlet fluids from simulation
      if (turbineInlet && comp.inletFluid) {
        comp.inletFluid.temperature = turbineInlet.fluid.temperature;
        comp.inletFluid.pressure = turbineInlet.fluid.pressure;
        comp.inletFluid.phase = turbineInlet.fluid.phase;
        comp.inletFluid.quality = turbineInlet.fluid.quality;
      }
      if (turbineOutlet && comp.outletFluid) {
        comp.outletFluid.temperature = turbineOutlet.fluid.temperature;
        comp.outletFluid.pressure = turbineOutlet.fluid.pressure;
        comp.outletFluid.phase = turbineOutlet.fluid.phase;
        comp.outletFluid.quality = turbineOutlet.fluid.quality;
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

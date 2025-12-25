import { PlantCanvas } from './render/canvas';
import { createDemoPlant } from './plant/factory';
import { PlantState, PlantComponent } from './types';
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
  simulationConfig,
} from './simulation';
import { updateDebugPanel, initDebugPanel, updateComponentDetail } from './debug';
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

  // SCRAM button controls
  const scramBtn = document.getElementById('scram-btn') as HTMLButtonElement;
  const resetScramBtn = document.getElementById('reset-scram-btn') as HTMLButtonElement;
  const scramIndicator = document.getElementById('scram-indicator') as HTMLDivElement;

  function updateScramDisplay(): void {
    const isScramActive = gameLoop.isScramActive();
    if (scramBtn) scramBtn.style.display = isScramActive ? 'none' : 'block';
    if (resetScramBtn) resetScramBtn.style.display = isScramActive ? 'block' : 'none';
    if (scramIndicator) scramIndicator.style.display = isScramActive ? 'block' : 'none';

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
      gameLoop.resetScram();
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

  function setMode(mode: 'construction' | 'simulation'): void {
    currentMode = mode;

    if (mode === 'construction') {
      // Construction mode
      modeConstructionBtn?.classList.add('active');
      modeSimulationBtn?.classList.remove('active');

      // Hide simulation controls, show construction controls
      if (simControls) simControls.style.display = 'none';
      if (constructionControls) constructionControls.style.display = 'block';

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

      // Clear component selection
      selectedComponentType = null;
      constructionButtons.forEach(btn => btn.classList.remove('selected'));
      if (selectedComponentDiv) selectedComponentDiv.textContent = 'No component selected';
      if (placementHintDiv) placementHintDiv.style.display = 'none';

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

  // Canvas mouse move handler for visual feedback
  canvas.addEventListener('mousemove', (e) => {
    if (currentMode !== 'construction') return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (constructionSubMode === 'connect') {
      const hoveredPort = plantCanvas.getPortAtScreen({ x, y });
      if (hoveredPort) {
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'default';
      }
    } else if (constructionSubMode === 'move') {
      const hoveredComponent = plantCanvas.getComponentAtScreen({ x, y });
      if (!movingComponent && hoveredComponent) {
        canvas.style.cursor = 'pointer';
      } else if (movingComponent) {
        canvas.style.cursor = 'move';
      } else {
        canvas.style.cursor = 'default';
      }
    }
  });

  // Move mode state
  let movingComponent: PlantComponent | null = null;
  let moveStartOffset = { x: 0, y: 0 };

  // Canvas click handler for placing components or making connections
  canvas.addEventListener('click', (e) => {
    if (currentMode !== 'construction') return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (constructionSubMode === 'move') {
      // Move mode - select or place component
      const component = plantCanvas.getComponentAtScreen({ x, y });

      if (!movingComponent) {
        // First click - select component to move
        if (component) {
          movingComponent = component;
          // Calculate offset from component position to click point
          const view = plantCanvas.getView();
          const worldClickX = (x - view.offsetX) / view.zoom;
          const worldClickY = (y - view.offsetY) / view.zoom;
          moveStartOffset.x = worldClickX - component.position.x;
          moveStartOffset.y = worldClickY - component.position.y;

          showNotification(`Selected ${component.label || component.id} to move`, 'info');
          canvas.style.cursor = 'move';
        }
      } else {
        // Second click - place component at new location
        const view = plantCanvas.getView();
        const newX = (x - view.offsetX) / view.zoom - moveStartOffset.x;
        const newY = (y - view.offsetY) / view.zoom - moveStartOffset.y;

        movingComponent.position.x = newX;
        movingComponent.position.y = newY;

        showNotification(`Moved ${movingComponent.label || movingComponent.id}`, 'info');

        // Reset move state
        movingComponent = null;
        moveStartOffset = { x: 0, y: 0 };
        canvas.style.cursor = 'default';
      }
    } else if (constructionSubMode === 'place' && selectedComponentType) {
      // Component placement mode - convert screen to world coordinates
      const view = plantCanvas.getView();
      const worldPos = {
        x: (x - view.offsetX) / view.zoom,
        y: (y - view.offsetY) / view.zoom
      };
      console.log(`[Construction] Opening config dialog for ${selectedComponentType} at world (${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)})`);

      // Show configuration dialog with world coordinates
      componentDialog.show(selectedComponentType, worldPos, (config: ComponentConfig | null) => {
        if (config) {
          console.log(`[Construction] Component configured:`, config);

          // Actually create and place the component in the plant state
          const componentId = constructionManager.createComponent(config);

          if (componentId) {
            console.log(`[Construction] Successfully created component '${componentId}'`);

            // The canvas will automatically re-render in its render loop
            // Just show success notification
            showNotification(`Created ${config.name} (${config.type})`, 'info');
          } else {
            console.error(`[Construction] Failed to create component`);
            showNotification(`Failed to create ${config.type}`, 'error');
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
      });
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
                    config.toPort.id
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

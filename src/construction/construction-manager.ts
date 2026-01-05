// Construction manager for creating and managing components in construction mode

import {
  PlantState,
  PlantComponent,
  TankComponent,
  PipeComponent,
  PumpComponent,
  VesselComponent,
  ReactorVesselComponent,
  CoreBarrelComponent,
  ValveComponent,
  HeatExchangerComponent,
  TurbineGeneratorComponent,
  TurbineDrivenPumpComponent,
  CondenserComponent,
  ControllerComponent,
  SwitchyardComponent,
  Connection,
  Port,
  Fluid
} from '../types';
import { ComponentConfig } from './component-config';
import { saturationTemperature } from '../simulation/water-properties';
import {
  calculateState,
  saturatedLiquidDensity,
  saturatedVaporDensity,
  saturatedLiquidEnergy,
  saturatedVaporEnergy
} from '../simulation/water-properties-v3';

export class ConstructionManager {
  private plantState: PlantState;
  private nextComponentId: number = 1;

  constructor(plantState: PlantState) {
    this.plantState = plantState;

    // Clear existing components to start fresh
    this.clearAll();
  }

  clearAll(): void {
    this.plantState.components.clear();
    this.plantState.connections = [];
    this.nextComponentId = 1;
  }

  createComponent(config: ComponentConfig): string | null {
    const id = this.generateComponentId(config.type);
    const { x, y } = config.position;  // These are already world coordinates
    const props = config.properties;

    // Position is already in world coordinates from the canvas
    const worldX = x;
    const worldY = y;

    // Create default fluid state
    // If initial level < 100%, the component is two-phase (liquid + vapor space)
    const fillLevel = props.initialLevel !== undefined ? props.initialLevel / 100 : 1;
    const isTwoPhase = fillLevel > 0 && fillLevel < 1;
    // For two-phase, quality represents fraction of vapor by mass
    // Low fill level with small vapor space = low quality (mostly liquid by mass)
    const defaultQuality = isTwoPhase ? Math.max(0.01, (1 - fillLevel) * 0.1) : 0;
    const defaultFluid: Fluid = {
      temperature: props.initialTemperature ? props.initialTemperature + 273.15 : 300,
      pressure: props.initialPressure ? props.initialPressure * 100000 : 15000000, // Convert bar to Pa
      phase: isTwoPhase ? 'two-phase' : 'liquid',
      quality: defaultQuality,
      flowRate: 0
    };

    // Create standard bidirectional ports for passive components (pipes, condensers)
    // Flow direction is determined by physics, not by the component
    const bidirectionalPorts: Port[] = [
      {
        id: `${id}-left`,
        position: { x: -0.5, y: 0 },
        direction: 'both'
      },
      {
        id: `${id}-right`,
        position: { x: 0.5, y: 0 },
        direction: 'both'
      }
    ];

    // Directional ports for active components (pumps, turbines) where flow has a defined direction
    const directionalPorts: Port[] = [
      {
        id: `${id}-inlet`,
        position: { x: -0.5, y: 0 },
        direction: 'in'
      },
      {
        id: `${id}-outlet`,
        position: { x: 0.5, y: 0 },
        direction: 'out'
      }
    ];

    switch (config.type) {
      case 'tank': {
        // Calculate diameter from cylindrical volume: V = π * r² * h
        // r = sqrt(V / (π * h)), diameter = 2 * r
        const width = 2 * Math.sqrt(props.volume / (Math.PI * props.height));
        const halfWidth = width / 2;
        const halfHeight = props.height / 2;

        // Create 4 ports at center of each side
        const tankPorts: Port[] = [
          {
            id: `${id}-top`,
            position: { x: 0, y: -halfHeight },  // Top center
            direction: 'both'
          },
          {
            id: `${id}-bottom`,
            position: { x: 0, y: halfHeight },   // Bottom center
            direction: 'both'
          },
          {
            id: `${id}-left`,
            position: { x: -halfWidth, y: 0 },   // Left center
            direction: 'both'
          },
          {
            id: `${id}-right`,
            position: { x: halfWidth, y: 0 },    // Right center
            direction: 'both'
          }
        ];

        const tank: TankComponent = {
          id,
          type: 'tank',
          label: props.name || 'Tank',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: props.elevation || 0,
          width,
          height: props.height,
          wallThickness: 0.05,  // 5cm default (overridden by rendering if pressureRating is set)
          fillLevel: props.initialLevel / 100,
          pressureRating: props.pressureRating,
          ports: tankPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, tank);
        (tank as any).nqa1 = props.nqa1 ?? false;
        break;
      }

      case 'pressurizer': {
        // Calculate diameter from cylindrical volume: V = π * r² * h
        const width = 2 * Math.sqrt(props.volume / (Math.PI * props.height));
        const halfWidth = width / 2;
        const halfHeight = props.height / 2;

        // Pressurizer typically has fewer connections
        const pressurizerPorts: Port[] = [
          {
            id: `${id}-surge`,
            position: { x: 0, y: halfHeight },   // Bottom center (surge line)
            direction: 'both'
          },
          {
            id: `${id}-spray`,
            position: { x: 0, y: -halfHeight },  // Top center (spray line)
            direction: 'in'
          },
          {
            id: `${id}-relief`,
            position: { x: halfWidth * 0.5, y: -halfHeight },  // Top side (relief valve)
            direction: 'out'
          }
        ];

        const pressurizer: TankComponent = {
          id,
          type: 'tank',
          label: props.name || 'Pressurizer',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: props.elevation || 5, // Pressurizers are typically elevated
          width,
          height: props.height,
          wallThickness: 0.05,  // Default (overridden by rendering if pressureRating is set)
          fillLevel: props.initialLevel / 100,
          pressureRating: props.pressureRating,
          ports: pressurizerPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, pressurizer);
        (pressurizer as any).nqa1 = props.nqa1 ?? true;
        break;
      }

      case 'pipe': {
        // Build pipe-specific fluid state from user properties
        const pipePhase = props.initialPhase || 'liquid';
        const pipeQuality = pipePhase === 'two-phase' ? (props.initialQuality ?? 0.5) :
                           (pipePhase === 'vapor' ? 1 : 0);
        const pipeFluid: Fluid = {
          temperature: props.initialTemperature ? props.initialTemperature + 273.15 : 563.15, // default 290C in K
          pressure: props.initialPressure ? props.initialPressure * 100000 : 15000000, // bar to Pa
          phase: pipePhase,
          quality: pipeQuality,
          flowRate: 0
        };

        const pipeLength = props.length || 5;
        // Pipe ports at each end - pipe is drawn from x=0 to x=length (left edge at origin)
        const pipePorts: Port[] = [
          {
            id: `${id}-left`,
            position: { x: 0, y: 0 },
            direction: 'both'
          },
          {
            id: `${id}-right`,
            position: { x: pipeLength, y: 0 },
            direction: 'both'
          }
        ];

        // Calculate endpoint position based on length and elevation change
        // Pipe starts at position (worldX, worldY) and extends in the +X direction
        const startElevation = props.elevation ?? 0;
        const elevationChange = props.elevationChange ?? 0; // Height change from inlet to outlet
        const endElevation = startElevation + elevationChange;

        const pipe: PipeComponent = {
          id,
          type: 'pipe',
          label: props.name || 'Pipe',
          position: { x: worldX, y: worldY },
          elevation: startElevation,
          rotation: 0,
          diameter: props.diameter,
          thickness: 0.01,  // 1cm default wall thickness
          length: pipeLength,
          // End position: pipe extends in +X direction from start
          endPosition: { x: worldX + pipeLength, y: worldY },
          endElevation: endElevation,
          ports: pipePorts,  // Pipes are bidirectional - flow determined by physics
          fluid: pipeFluid
        };

        this.plantState.components.set(id, pipe);
        (pipe as any).nqa1 = props.nqa1 ?? false;
        break;
      }

      case 'valve': {
        // Create valve-specific fluid state from user properties
        // If matchUpstream is true, use placeholder values - factory will override
        const matchUpstream = props.matchUpstream !== false; // Default true
        const valveFluid: Fluid = {
          temperature: props.initialTemperature !== undefined ? props.initialTemperature + 273.15 : 323.15, // Default 50°C
          pressure: props.initialPressure !== undefined ? props.initialPressure * 1e5 : 1e6, // Default 10 bar
          phase: 'liquid',
          quality: 0,
          flowRate: 0
        };

        // Regular valves (gate, globe, ball, butterfly) are bidirectional
        const valve: ValveComponent = {
          id,
          type: 'valve',
          label: props.name || 'Valve',
          position: { x: worldX, y: worldY },
          rotation: 0,
          diameter: props.diameter,
          opening: props.initialPosition / 100,
          valveType: props.type || 'gate',
          ports: bidirectionalPorts,
          fluid: valveFluid
        };
        // Store matchUpstream for factory to use
        (valve as any).matchUpstream = matchUpstream;

        this.plantState.components.set(id, valve);
        (valve as any).nqa1 = props.nqa1 ?? false;
        break;
      }

      case 'check-valve': {
        // Check valves are directional - flow only in forward direction
        const checkValve: ValveComponent = {
          id,
          type: 'valve',
          label: props.name || 'Check Valve',
          position: { x: worldX, y: worldY },
          rotation: 0,
          diameter: props.diameter,
          opening: 0,  // Starts closed, opens based on ΔP
          valveType: 'check',
          crackingPressure: (props.crackingPressure || 0.1) * 1e5,  // bar to Pa
          ports: directionalPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, checkValve);
        (checkValve as any).nqa1 = props.nqa1 ?? false;
        break;
      }

      case 'relief-valve': {
        // Relief valves are directional - inlet from system, outlet to atmosphere/tank
        const reliefValve: ValveComponent = {
          id,
          type: 'valve',
          label: props.name || 'Relief Valve',
          position: { x: worldX, y: worldY },
          rotation: 0,
          diameter: props.diameter,
          opening: 0,  // Starts closed, opens at setpoint
          valveType: 'relief',
          setpoint: (props.setpoint || 170) * 1e5,  // bar to Pa
          blowdown: (props.blowdown || 5) / 100,    // % to fraction
          capacity: props.capacity || 100,          // kg/s
          ports: directionalPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, reliefValve);
        (reliefValve as any).nqa1 = props.nqa1 ?? true;
        break;
      }

      case 'porv': {
        // PORVs are directional like relief valves, but can be manually controlled
        const porv: ValveComponent = {
          id,
          type: 'valve',
          label: props.name || 'PORV',
          position: { x: worldX, y: worldY },
          rotation: 0,
          diameter: props.diameter,
          opening: props.initialPosition === 'open' ? 1 : 0,
          valveType: 'porv',
          setpoint: (props.setpoint || 165) * 1e5,  // bar to Pa
          blowdown: (props.blowdown || 3) / 100,    // % to fraction
          capacity: props.capacity || 50,           // kg/s
          controlMode: props.initialPosition || 'auto',  // 'auto', 'open', 'closed'
          hasBlockValve: props.hasBlockValve !== false,
          ports: directionalPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, porv);
        (porv as any).nqa1 = props.nqa1 ?? true;
        break;
      }

      case 'pump': {
        // Calculate diameter based on flow capacity
        // Small pumps (~100 kg/s): ~0.3m, Large RCPs (~5000 kg/s): ~1.5m
        const flow = props.ratedFlow || 1000;
        const calculatedDiameter = 0.2 + Math.sqrt(flow / 1000) * 0.4;

        // Pump orientation is handled in rendering via transforms, not rotation
        // Rotation stays 0 for all pumps
        const pumpRotation = 0;
        const orientation = props.orientation || 'left-right';

        // Port positions for upright RCP-style pump
        // Layout: motor on top, coupling, casing, suction nozzle, inlet pipe at bottom
        // Outlet is on the side (volute discharge)
        const scale = calculatedDiameter * 1.3; // 30% bigger to match render
        const pumpCasingWidth = scale * 0.75;
        const pumpCasingHeight = scale * 0.5;
        const suctionNozzleHeight = scale * 0.35;
        const inletPipeLength = scale * 0.3;
        const voluteBulge = scale * 0.18;
        const outletPipeLength = scale * 0.45;

        // Total height: motor (0.9) + coupling (0.15) + casing (0.5) + nozzle (0.35)
        const totalHeight = scale * 1.9;
        const motorTop = -totalHeight / 2;
        const couplingBottom = motorTop + scale * 0.9 + scale * 0.15;
        const casingBottom = couplingBottom + pumpCasingHeight;
        const nozzleBottom = casingBottom + suctionNozzleHeight;

        // Base positions (for left-right orientation):
        // Inlet at bottom of inlet pipe, outlet on right side
        const baseInletY = nozzleBottom + inletPipeLength;
        const baseOutletY = couplingBottom + pumpCasingHeight * 0.35;
        const baseOutletX = pumpCasingWidth / 2 + voluteBulge + outletPipeLength;

        // Calculate port positions based on orientation
        // The rendering applies transforms, so port positions must match:
        // - left-right: inlet bottom, outlet right (default)
        // - right-left: inlet bottom, outlet left (mirrored X)
        // - bottom-top: inlet left, outlet up (rotated -90°)
        // - top-bottom: inlet right, outlet down (rotated +90°)
        // Port IDs must include component ID to be unique across multiple pumps
        let pumpPorts: Port[];
        switch (orientation) {
          case 'right-left':
            // Mirror X: inlet stays at bottom, outlet on left
            pumpPorts = [
              { id: `${id}-inlet`, position: { x: 0, y: baseInletY }, direction: 'in' },
              { id: `${id}-outlet`, position: { x: -baseOutletX, y: baseOutletY }, direction: 'out' }
            ];
            break;
          case 'bottom-top':
            // Rotate -90°: (x,y) -> (y, -x)
            // Inlet goes to left side, outlet goes to top
            pumpPorts = [
              { id: `${id}-inlet`, position: { x: -baseInletY, y: 0 }, direction: 'in' },
              { id: `${id}-outlet`, position: { x: -baseOutletY, y: -baseOutletX }, direction: 'out' }
            ];
            break;
          case 'top-bottom':
            // Rotate +90°: (x,y) -> (-y, x)
            // Inlet goes to right side, outlet goes to bottom
            pumpPorts = [
              { id: `${id}-inlet`, position: { x: baseInletY, y: 0 }, direction: 'in' },
              { id: `${id}-outlet`, position: { x: baseOutletY, y: baseOutletX }, direction: 'out' }
            ];
            break;
          default: // left-right
            pumpPorts = [
              { id: `${id}-inlet`, position: { x: 0, y: baseInletY }, direction: 'in' },
              { id: `${id}-outlet`, position: { x: baseOutletX, y: baseOutletY }, direction: 'out' }
            ];
        }

        // Create pump-specific fluid state from user properties
        // If matchUpstream is true, use placeholder values - factory will override
        const matchUpstream = props.matchUpstream !== false; // Default true
        const pumpFluid: Fluid = {
          temperature: props.initialTemperature !== undefined ? props.initialTemperature + 273.15 : 323.15, // Default 50°C
          pressure: props.initialPressure !== undefined ? props.initialPressure * 1e5 : 1e6, // Default 10 bar
          phase: 'liquid',
          quality: 0,
          flowRate: 0
        };

        const pump: PumpComponent = {
          id,
          type: 'pump',
          label: props.name || 'Pump',
          position: { x: worldX, y: worldY },
          rotation: pumpRotation,
          diameter: calculatedDiameter,
          running: props.initialState === 'on',
          speed: props.speed / 3600,  // Convert RPM to fraction
          ratedFlow: props.ratedFlow,
          ratedHead: props.ratedHead,
          ports: pumpPorts,
          fluid: pumpFluid
        };
        // Store orientation and matchUpstream for factory to use
        (pump as any).orientation = orientation;
        (pump as any).matchUpstream = matchUpstream;

        this.plantState.components.set(id, pump);
        (pump as any).nqa1 = props.nqa1 ?? false;
        break;
      }

      case 'heat-exchanger': {
        // Use user-specified dimensions first (needed for port positioning)
        // For vertical: width is diameter, height is length (tubes run vertically)
        // For horizontal: swap width/height so tubes run horizontally
        const isVertical = props.orientation === 'vertical';
        const shellDiam = props.shellDiameter || 2.5;
        const shellLen = props.shellLength || 8;

        // Calculate derived values
        const tubeOD_m = (props.tubeOD || 19) / 1000; // mm to m
        const tubeThickness_m = (props.tubeThickness || 1.2) / 1000;
        const tubeID_m = tubeOD_m - 2 * tubeThickness_m;
        const tubeCount = props.tubeCount || 3000;
        const hxType = props.hxType || 'utube';
        const tubeLength = hxType === 'utube' ? shellLen * 1.8 : shellLen;

        // Store calculated values for simulation use
        const heatTransferArea = Math.PI * tubeOD_m * tubeLength * tubeCount;
        const tubeSideVolume = Math.PI * Math.pow(tubeID_m / 2, 2) * tubeLength * tubeCount;
        const shellVolume = Math.PI * Math.pow(shellDiam / 2, 2) * shellLen;
        const shellSideVolume = Math.max(0, shellVolume - Math.PI * Math.pow(tubeOD_m / 2, 2) * tubeLength * tubeCount);

        // Calculate port positions based on HX type and orientation
        // Physical considerations:
        // - U-tube vertical: tube sheet at bottom, so tube inlet/outlet at bottom; shell inlet/outlet on sides
        // - Straight vertical: tube sheets at both ends, so tube in at bottom, out at top; shell on sides
        // - Helical vertical: similar to straight tube
        // - Horizontal: rotate the logic 90 degrees
        const displayWidth = isVertical ? shellDiam : shellLen;
        const displayHeight = isVertical ? shellLen : shellDiam;
        const halfW = displayWidth / 2;
        const halfH = displayHeight / 2;

        let hxPorts: Port[];

        // Heat exchangers are passive - flow direction is determined by physics
        // Port names indicate typical flow direction but all are bidirectional
        if (isVertical) {
          if (hxType === 'utube') {
            // U-tube vertical: both tube connections at bottom (tube sheet), shell on sides
            hxPorts = [
              { id: `${id}-tube-1`, position: { x: -halfW * 0.3, y: halfH }, direction: 'both' },
              { id: `${id}-tube-2`, position: { x: halfW * 0.3, y: halfH }, direction: 'both' },
              { id: `${id}-shell-1`, position: { x: -halfW, y: halfH * 0.3 }, direction: 'both' },
              { id: `${id}-shell-2`, position: { x: halfW, y: -halfH * 0.5 }, direction: 'both' }
            ];
          } else {
            // Straight or helical vertical: tube at top/bottom; shell on sides
            hxPorts = [
              { id: `${id}-tube-bottom`, position: { x: 0, y: halfH }, direction: 'both' },
              { id: `${id}-tube-top`, position: { x: 0, y: -halfH }, direction: 'both' },
              { id: `${id}-shell-1`, position: { x: -halfW, y: halfH * 0.3 }, direction: 'both' },
              { id: `${id}-shell-2`, position: { x: halfW, y: -halfH * 0.3 }, direction: 'both' }
            ];
          }
        } else {
          // Horizontal orientation
          if (hxType === 'utube') {
            // U-tube horizontal: both tube connections at left (tube sheet), shell on top/bottom
            hxPorts = [
              { id: `${id}-tube-1`, position: { x: -halfW, y: -halfH * 0.3 }, direction: 'both' },
              { id: `${id}-tube-2`, position: { x: -halfW, y: halfH * 0.3 }, direction: 'both' },
              { id: `${id}-shell-1`, position: { x: -halfW * 0.3, y: -halfH }, direction: 'both' },
              { id: `${id}-shell-2`, position: { x: halfW * 0.5, y: halfH }, direction: 'both' }
            ];
          } else {
            // Straight or helical horizontal: tube at left/right; shell on top/bottom
            hxPorts = [
              { id: `${id}-tube-left`, position: { x: -halfW, y: 0 }, direction: 'both' },
              { id: `${id}-tube-right`, position: { x: halfW, y: 0 }, direction: 'both' },
              { id: `${id}-shell-1`, position: { x: -halfW * 0.3, y: -halfH }, direction: 'both' },
              { id: `${id}-shell-2`, position: { x: halfW * 0.3, y: halfH }, direction: 'both' }
            ];
          }
        }

        const hx: HeatExchangerComponent = {
          id,
          type: 'heatExchanger',
          label: props.name || 'Heat Exchanger',
          position: { x: worldX, y: worldY },
          rotation: 0, // No rotation - we swap width/height for orientation
          elevation: props.elevation !== undefined ? props.elevation : 2, // Elevation for shadow rendering
          width: isVertical ? shellDiam : shellLen,
          height: isVertical ? shellLen : shellDiam,
          hxType: hxType,
          primaryFluid: {
            ...defaultFluid,
            pressure: (props.tubePressure || 150) * 100000
          },
          secondaryFluid: {
            temperature: 280 + 273.15,
            pressure: (props.shellPressure || 60) * 100000,
            phase: 'two-phase',
            quality: 0.5,
            flowRate: 0
          },
          tubeCount: 5, // Visual tube count for rendering (not the real engineering value)
          ports: hxPorts,
          pressureRating: props.shellPressure || 60
        };

        // Store additional properties for simulation (can be accessed via component)
        (hx as any).heatTransferArea = heatTransferArea;
        (hx as any).tubeSideVolume = tubeSideVolume;
        (hx as any).shellSideVolume = shellSideVolume;
        (hx as any).realTubeCount = tubeCount;
        (hx as any).tubeOD = tubeOD_m;
        (hx as any).tubeID = tubeID_m;

        console.log(`[HX] Created ${hxType} heat exchanger: ${heatTransferArea.toFixed(0)} m² area, tube-side ${tubeSideVolume.toFixed(1)} m³, shell-side ${shellSideVolume.toFixed(1)} m³`);

        this.plantState.components.set(id, hx);
        (hx as any).nqa1 = props.nqa1 ?? true;
        break;
      }

      case 'turbine-generator': {
        // Calculate turbine dimensions based on rated power
        // Realistic sizing: a single-casing turbine is ~3m minimum, ~13m for 1000 MW
        const ratedPowerMW = props.ratedPower || 1000;
        const turbineLength = 3 + (ratedPowerMW / 500) * 5;  // 3m base + 5m per 500 MW
        const exhaustDiameter = 1.5 + (ratedPowerMW / 1000) * 2;  // 1.5m base + 2m per GW

        // Calculate rated steam flow from power and efficiency
        const P_in = (props.inletPressure || 60) * 1e5;  // Pa
        const P_out = (props.exhaustPressure || 0.05) * 1e5;  // Pa
        const eta_t = (props.turbineEfficiency || 85) / 100;
        const eta_g = (props.generatorEfficiency || 98) / 100;
        const pressureRatio = P_in / P_out;
        const deltaH = 200000 * Math.log(pressureRatio);  // J/kg
        const ratedSteamFlow = (ratedPowerMW * 1e6) / (eta_t * eta_g * deltaH);  // kg/s

        const orientation = props.orientation || 'left-right';

        // Adjust port positions based on orientation and size
        // Outlet Y offset for exhaust (points slightly downward toward condenser)
        const outletY = exhaustDiameter * 0.5;  // Outlet side is larger
        const turbineGenPorts: Port[] = orientation === 'left-right' ? [
          {
            id: `${id}-inlet`,
            position: { x: -turbineLength / 2, y: 0 },
            direction: 'in'
          },
          {
            id: `${id}-outlet`,
            position: { x: turbineLength / 2, y: outletY * 0.8 },  // Exhaust points down-right
            direction: 'out'
          }
        ] : [
          {
            id: `${id}-inlet`,
            position: { x: turbineLength / 2, y: 0 },
            direction: 'in'
          },
          {
            id: `${id}-outlet`,
            position: { x: -turbineLength / 2, y: outletY * 0.8 },  // Exhaust points down-left
            direction: 'out'
          }
        ];

        // Pressure rating is 1.5x inlet pressure (provides margin for transients)
        const turbinePressureRating = (props.inletPressure || 60) * 1.5;

        // Inlet temperature should be saturation temperature at inlet pressure
        const inletTempK = saturationTemperature(P_in);

        const turbineGen: TurbineGeneratorComponent = {
          id,
          type: 'turbine-generator',
          label: props.name || 'Turbine-Generator',
          position: { x: worldX, y: worldY },
          rotation: 0,
          width: turbineLength,
          height: exhaustDiameter,
          orientation,
          stages: props.stages || 3,
          running: true,
          power: 0,
          ratedPower: ratedPowerMW * 1e6,  // Convert MW to W
          ratedSteamFlow,
          efficiency: eta_t,
          generatorEfficiency: eta_g,
          governorValve: (props.governorValve || 100) / 100,  // Convert % to 0-1
          inletFluid: {
            temperature: inletTempK,
            pressure: P_in,
            phase: 'vapor',
            quality: 1.0,
            flowRate: 0
          },
          outletFluid: {
            temperature: 40 + 273.15,
            pressure: P_out,
            phase: 'two-phase',
            quality: 0.9,
            flowRate: 0
          },
          ports: turbineGenPorts
        };
        // Add pressure rating for pipe creation
        (turbineGen as any).pressureRating = turbinePressureRating;

        this.plantState.components.set(id, turbineGen);
        (turbineGen as any).nqa1 = props.nqa1 ?? false;

        // Create exhaust pipe (like condensers come with pumps, turbines come with exhaust pipes)
        // This provides a buffer volume for the work extraction process
        const exhaustPipeId = `${id}-exhaust`;
        const exhaustPipeLength = 2 + (ratedPowerMW / 500) * 1;  // 2m base + 1m per 500 MW
        // Exhaust pipe diameter: realistic sizing for LP exhaust crossover/duct
        // Even large plants use ~1-2m diameter pipes, not turbine casing size
        const exhaustPipeDiameter = 0.6 + (ratedPowerMW / 1000) * 0.6;  // 0.6m base + 0.6m per GW (so 1.2m for 1000 MW)

        // Position the exhaust pipe below the turbine outlet
        const exhaustPipeX = orientation === 'left-right'
          ? worldX + turbineLength / 2 + exhaustPipeLength / 2 + 0.5
          : worldX - turbineLength / 2 - exhaustPipeLength / 2 - 0.5;
        const exhaustPipeY = worldY + exhaustDiameter * 0.4 + exhaustPipeLength / 2;  // Below and extending down

        const exhaustPipePorts: Port[] = [
          {
            id: `${exhaustPipeId}-top`,
            position: { x: 0, y: -exhaustPipeLength / 2 },  // Top of vertical pipe
            direction: 'both'
          },
          {
            id: `${exhaustPipeId}-bottom`,
            position: { x: 0, y: exhaustPipeLength / 2 },   // Bottom of vertical pipe
            direction: 'both'
          }
        ];

        // Exhaust steam conditions: start with saturated liquid at exhaust pressure.
        // At very low pressures (e.g., 0.05 bar), high-quality steam has extremely low density,
        // causing sanity check failures. Starting with liquid is more realistic for startup
        // conditions anyway - the simulation will evolve to steady-state two-phase conditions.
        const T_sat_exhaust = 273.15 + 33;  // ~33°C saturation temp at low condenser pressures
        const exhaustPipe: PipeComponent = {
          id: exhaustPipeId,
          type: 'pipe',
          label: 'Exhaust Pipe',
          position: { x: exhaustPipeX, y: exhaustPipeY },
          rotation: 0,
          diameter: exhaustPipeDiameter,
          thickness: 0.01,  // 1cm wall thickness
          length: exhaustPipeLength,
          ports: exhaustPipePorts,
          fluid: {
            temperature: T_sat_exhaust,  // Saturation temp at exhaust pressure
            pressure: P_out,             // Exhaust pressure (e.g., 0.05 bar = 5 kPa)
            phase: 'liquid',             // Start with liquid - will flash if needed during simulation
            quality: 0,                  // Saturated liquid
            flowRate: 0
          }
        };

        this.plantState.components.set(exhaustPipeId, exhaustPipe);

        // Automatically connect turbine outlet to exhaust pipe inlet
        this.createConnection(`${id}-outlet`, `${exhaustPipeId}-top`);

        console.log(`[Turbine] Created exhaust pipe: ${exhaustPipeLength.toFixed(1)}m long, ${exhaustPipeDiameter.toFixed(2)}m diameter`);
        break;
      }

      case 'turbine-driven-pump': {
        // Calculate dimensions based on pump flow
        const ratedPumpFlow = props.ratedPumpFlow || 50;  // kg/s
        const assemblyLength = 2 + (ratedPumpFlow / 100) * 1.5;  // 2m base + 1.5m per 100 kg/s
        const diameter = 0.5 + (ratedPumpFlow / 200) * 0.5;  // 0.5m base + 0.5m per 200 kg/s

        const P_in = (props.inletPressure || 60) * 1e5;  // Pa
        const P_out = (props.exhaustPressure || 1) * 1e5;  // Pa
        const eta_t = (props.turbineEfficiency || 70) / 100;
        const eta_p = (props.pumpEfficiency || 75) / 100;

        // Calculate required steam flow from pump power requirements
        const rho = 1000;  // kg/m³
        const g = 9.81;
        const Q = ratedPumpFlow / rho;  // m³/s
        const H = props.ratedHead || 500;
        const shaftPower = rho * g * Q * H / eta_p;

        const pressureRatio = P_in / P_out;
        const deltaH = 200000 * Math.log(pressureRatio);  // J/kg
        const ratedSteamFlow = shaftPower / (eta_t * deltaH);  // kg/s

        const orientation = props.orientation || 'left-right';

        // Ports: steam inlet, steam exhaust, pump suction, pump discharge
        // Layout: turbine on one end, pump on other
        const tdPumpPorts: Port[] = orientation === 'left-right' ? [
          // Steam side (left)
          { id: `${id}-steam-inlet`, position: { x: -assemblyLength / 2, y: -diameter / 3 }, direction: 'in' },
          { id: `${id}-steam-exhaust`, position: { x: -assemblyLength / 2, y: diameter / 3 }, direction: 'out' },
          // Pump side (right)
          { id: `${id}-pump-suction`, position: { x: assemblyLength / 2, y: diameter / 3 }, direction: 'in' },
          { id: `${id}-pump-discharge`, position: { x: assemblyLength / 2, y: -diameter / 3 }, direction: 'out' }
        ] : [
          // Steam side (right)
          { id: `${id}-steam-inlet`, position: { x: assemblyLength / 2, y: -diameter / 3 }, direction: 'in' },
          { id: `${id}-steam-exhaust`, position: { x: assemblyLength / 2, y: diameter / 3 }, direction: 'out' },
          // Pump side (left)
          { id: `${id}-pump-suction`, position: { x: -assemblyLength / 2, y: diameter / 3 }, direction: 'in' },
          { id: `${id}-pump-discharge`, position: { x: -assemblyLength / 2, y: -diameter / 3 }, direction: 'out' }
        ];

        const tdPump: TurbineDrivenPumpComponent = {
          id,
          type: 'turbine-driven-pump',
          label: props.name || 'TD Pump',
          position: { x: worldX, y: worldY },
          rotation: 0,
          width: assemblyLength,
          height: diameter,
          orientation,
          stages: props.stages || 1,
          running: true,
          // Turbine properties
          ratedSteamFlow,
          turbineEfficiency: eta_t,
          governorValve: (props.governorValve || 100) / 100,
          inletFluid: {
            temperature: 280 + 273.15,
            pressure: P_in,
            phase: 'vapor',
            quality: 1.0,
            flowRate: 0
          },
          outletFluid: {
            temperature: 100 + 273.15,
            pressure: P_out,
            phase: 'two-phase',
            quality: 0.9,
            flowRate: 0
          },
          // Pump properties
          pumpFlow: 0,
          ratedPumpFlow,
          ratedHead: props.ratedHead || 500,
          pumpEfficiency: eta_p,
          ports: tdPumpPorts
        };

        this.plantState.components.set(id, tdPump);
        (tdPump as any).nqa1 = props.nqa1 ?? true;

        // Create exhaust pipe for steam exhaust (similar to main turbine)
        // TD pump exhaust is lower pressure/flow than main turbine
        const tdExhaustPipeId = `${id}-exhaust`;
        const tdExhaustPipeLength = 1.5;  // Smaller than main turbine
        const tdExhaustPipeDiameter = 0.3 + (ratedSteamFlow / 50) * 0.2;  // 0.3m base + 0.2m per 50 kg/s

        // Position the exhaust pipe below the steam exhaust port
        const tdExhaustPipeX = orientation === 'left-right'
          ? worldX - assemblyLength / 2 - tdExhaustPipeLength / 2 - 0.3
          : worldX + assemblyLength / 2 + tdExhaustPipeLength / 2 + 0.3;
        const tdExhaustPipeY = worldY + diameter / 3 + tdExhaustPipeLength / 2;

        const tdExhaustPipePorts: Port[] = [
          {
            id: `${tdExhaustPipeId}-top`,
            position: { x: 0, y: -tdExhaustPipeLength / 2 },
            direction: 'both'
          },
          {
            id: `${tdExhaustPipeId}-bottom`,
            position: { x: 0, y: tdExhaustPipeLength / 2 },
            direction: 'both'
          }
        ];

        const tdExhaustPipe: PipeComponent = {
          id: tdExhaustPipeId,
          type: 'pipe',
          label: 'TD Pump Exhaust',
          position: { x: tdExhaustPipeX, y: tdExhaustPipeY },
          rotation: 0,
          diameter: tdExhaustPipeDiameter,
          thickness: 0.008,  // 8mm wall thickness
          length: tdExhaustPipeLength,
          ports: tdExhaustPipePorts,
          fluid: {
            temperature: 100 + 273.15,  // ~100°C exhaust steam
            pressure: P_out,
            phase: 'two-phase',
            quality: 0.9,
            flowRate: 0
          }
        };

        this.plantState.components.set(tdExhaustPipeId, tdExhaustPipe);

        // Automatically connect TD pump steam exhaust to exhaust pipe
        this.createConnection(`${id}-steam-exhaust`, `${tdExhaustPipeId}-top`);

        console.log(`[TD Pump] Created exhaust pipe: ${tdExhaustPipeLength.toFixed(1)}m long, ${tdExhaustPipeDiameter.toFixed(2)}m diameter`);
        break;
      }

      case 'condenser': {
        // Calculate dimensions from volume and height
        const condenserVolume = props.volume || 100;  // m³
        const condenserHeight = props.height || 3;    // m
        // Assuming square footprint: V = W * W * H
        const condenserWidth = Math.sqrt(condenserVolume / condenserHeight);

        // Condenser ports: steam inlet at top, condensate outlet at bottom
        // This ensures proper phase separation - steam enters high, liquid drains low
        const condenserPorts: Port[] = [
          {
            id: `${id}-inlet`,
            // Top of condenser (negative y = up in screen coords, but we use y position to indicate vertical)
            position: { x: -condenserWidth / 2, y: -condenserHeight / 2 + 0.3 },
            direction: 'in'  // Steam inlet
          },
          {
            id: `${id}-outlet`,
            // Bottom of condenser - hotwell drain
            position: { x: condenserWidth / 2, y: condenserHeight / 2 - 0.3 },
            direction: 'out'  // Condensate outlet
          }
        ];

        const condenser: CondenserComponent = {
          id,
          type: 'condenser',
          label: props.name || 'Condenser',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: props.elevation ?? 0,  // Default to ground level
          width: condenserWidth,
          height: condenserHeight,
          pressureRating: props.pressureRating ?? 1.1,  // bar (stored in bar for consistency with other components)
          heatRejection: 0,
          coolingWaterTemp: props.coolingWaterTemp + 273.15,
          coolingWaterFlow: props.coolingWaterFlow || 50000,  // kg/s
          coolingCapacity: (props.coolingCapacity || 2000) * 1e6,  // MW to W
          tubeCount: 10000,  // Default tube count
          ports: condenserPorts,  // Condensers are bidirectional - steam in, condensate out determined by physics
          fluid: {
            temperature: props.coolingWaterTemp + 273.15 + 10,
            pressure: props.operatingPressure * 100000,
            phase: 'two-phase',
            quality: 0,
            flowRate: 0
          }
        };

        this.plantState.components.set(id, condenser);
        (condenser as any).nqa1 = props.nqa1 ?? false;

        // If includesPump, also create a condensate pump
        if (props.includesPump) {
          const pumpId = this.generateComponentId('pump');
          const pumpPorts: Port[] = [
            {
              id: `${pumpId}-inlet`,
              position: { x: -0.5, y: 0 },
              direction: 'in'
            },
            {
              id: `${pumpId}-outlet`,
              position: { x: 0.5, y: 0 },
              direction: 'out'
            }
          ];
          const condensatePump: PumpComponent = {
            id: pumpId,
            type: 'pump',
            label: 'Condensate Pump',
            position: { x: worldX + condenserWidth / 2 + 0.5, y: worldY + condenserHeight / 2 + 0.5 },
            rotation: 0,
            elevation: props.elevation ?? 0,  // Same elevation as condenser
            diameter: 0.2,
            running: true,
            speed: 0.5,
            ratedFlow: 100,
            ratedHead: 200,
            ports: pumpPorts,
            fluid: {
              temperature: props.coolingWaterTemp + 273.15 + 10,
              pressure: props.operatingPressure * 100000,
              phase: 'liquid',
              quality: 0,
              flowRate: 0
            }
          };
          this.plantState.components.set(pumpId, condensatePump);

          // Automatically connect condenser outlet (bottom) to pump inlet
          this.createConnection(`${id}-outlet`, `${pumpId}-inlet`);
        }
        break;
      }

      case 'generator': {
        // Generators are mechanical components connected to turbines
        // Using tank type for simplicity (will be rendered differently)
        const generator: TankComponent = {
          id,
          type: 'tank',
          label: props.name || 'Generator',
          position: { x: worldX, y: worldY },
          rotation: 0,
          width: 1.2,
          height: 1,
          wallThickness: 0.1,
          fillLevel: 0,  // Generators don't have fluid
          ports: [
            {
              id: `${id}-shaft`,
              position: { x: -0.6, y: 0 },  // Mechanical shaft connection
              direction: 'in'
            }
          ],
          fluid: {
            temperature: 50 + 273.15,  // Ambient temp
            pressure: 101325,  // Atmospheric
            phase: 'vapor',
            quality: 1,
            flowRate: 0
          }
        };

        this.plantState.components.set(id, generator);
        (generator as any).nqa1 = props.nqa1 ?? false;
        break;
      }

      case 'core': {
        // Create a standalone core component (rendered as fuel assemblies)
        // Using vessel type but with special properties
        const coreHeight = props.height || 3.66;  // Default to typical PWR active height
        const coreDiameter = props.diameter || 3.37;  // Default to typical PWR core diameter

        // Calculate actual fuel rod count from diameter and pitch (for simulation)
        // Using square lattice approximation: rods = (π/4) * (D/pitch)² * packing_efficiency
        let actualFuelRodCount = 50000; // Default
        if (props.rodPitch) {
          const pitch_m = (props.rodPitch || 12.6) / 1000;  // mm to m
          const coreArea = Math.PI * Math.pow(coreDiameter / 2, 2);  // m²
          const pitchArea = pitch_m * pitch_m;  // m² per rod
          actualFuelRodCount = Math.floor(coreArea / pitchArea * 0.9);  // 90% packing efficiency
        }
        // Visual count for rendering (8 rods looks good, like demo plant)
        const visualFuelRodCount = 8;

        // Core has 2 connection points: inlet at bottom-center, outlet at top-center
        // This represents the core barrel - flow enters from bottom, exits from top
        const corePorts: Port[] = [
          {
            id: `${id}-inlet`,
            position: { x: 0, y: coreHeight / 2 },   // Bottom center
            direction: 'in'
          },
          {
            id: `${id}-outlet`,
            position: { x: 0, y: -coreHeight / 2 },  // Top center
            direction: 'out'
          }
        ];

        const core: VesselComponent = {
          id,
          type: 'vessel',
          label: props.name || 'Reactor Core',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: props.elevation ?? 0,  // Match container elevation in isometric mode
          innerDiameter: coreDiameter,
          wallThickness: 0,  // No vessel wall for bare core
          height: coreHeight,
          hasDome: false,  // No dome for bare core
          hasBottom: false,  // No bottom for bare core
          fuelRodCount: visualFuelRodCount,  // Visual count for rendering
          actualFuelRodCount: actualFuelRodCount,  // Real count for simulation
          fuelTemperature: 600 + 273.15,  // Initial fuel temp
          fuelMeltingPoint: 2800 + 273.15,
          controlRodCount: props.controlRodBanks || 4,  // Number of control rod banks
          controlRodPosition: (100 - (props.initialRodPosition || 50)) / 100,  // Convert to 0-1 (0=withdrawn, 1=inserted)
          ports: corePorts,
          fluid: {
            temperature: 320 + 273.15,  // Typical core outlet temp
            pressure: 15500000,  // 155 bar typical PWR pressure
            phase: 'liquid',
            quality: 0,
            flowRate: 0
          }
        };

        // Store additional properties for reference
        (core as any).rodDiameter = props.rodDiameter || 9.5;  // mm
        (core as any).rodPitch = props.rodPitch || 12.6;  // mm
        (core as any).thermalPower = (props.thermalPower || 3000) * 1e6;  // Convert MW to W

        this.plantState.components.set(id, core);
        (core as any).nqa1 = props.nqa1 ?? true;
        break;
      }

      case 'reactor-vessel': {
        // Reactor vessel with core barrel - creates two concentric hydraulic regions
        // NOTE: vesselHeight is INNER height (total internal cavity height)
        // This ensures volumes don't depend on wall thickness
        const innerHeight = props.height ?? 12;
        const vesselDiameter = props.innerDiameter ?? 4.4;
        const pressureRating = props.pressureRating ?? 175;
        const barrelDiameter = props.barrelDiameter ?? 3.4;
        const barrelThickness = props.barrelThickness ?? 0.05;
        const barrelBottomGap = props.barrelBottomGap ?? 1.0;
        const barrelTopGap = props.barrelTopGap ?? 0;  // Default: barrel extends to top
        const vesselElevation = props.elevation ?? 0;

        // Calculate wall thickness from pressure rating (ASME formula)
        // t = P*R / (S*E - 0.6*P)
        // S = 172 MPa (SA-533 Grade B Class 1 at ~320°C), E = 1.0 (full radiograph)
        const P = pressureRating * 1e5; // bar to Pa
        const vesselR = vesselDiameter / 2;
        const S = 172e6; // Pa - gives realistic wall thicknesses for PWR vessels
        const wallThickness = P * vesselR / (S * 1.0 - 0.6 * P);

        // Calculate barrel geometry accounting for dome curvature
        // The dome is hemispherical with inner radius = vesselR.
        // At the barrel's outer radius, the dome surface is at:
        // z = R - sqrt(R² - r²) from the tangent point with the cylinder
        // This is the "dome intrusion" - how far the dome curves into the cylindrical region
        // Note: barrelDiameter is the CENTER-LINE diameter (to middle of barrel wall)
        const barrelCenterR = barrelDiameter / 2;
        const barrelOuterR = barrelCenterR + barrelThickness / 2;
        const barrelInnerR = barrelCenterR - barrelThickness / 2;
        const domeIntrusion = vesselR - Math.sqrt(vesselR * vesselR - barrelOuterR * barrelOuterR);

        // Barrel positions are measured from inner geometry (no wall thickness dependence)
        // Gaps are measured from the inner dome surface at the barrel's outer radius
        const barrelBottomElev = domeIntrusion + barrelBottomGap;
        const barrelTopElev = innerHeight - domeIntrusion - barrelTopGap;
        const barrelHeight = barrelTopElev - barrelBottomElev;

        // Inside barrel volume (cylindrical) - this is the core region
        const coreVolume = Math.PI * barrelInnerR * barrelInnerR * barrelHeight;

        // Outside barrel volume = total inner vessel volume - barrel region volume
        // Inner vessel: cylinder of height (innerHeight - 2*vesselR) + two hemispherical domes
        const innerCylinderHeight = innerHeight - 2 * vesselR;
        const domeVolume = (4/3) * Math.PI * Math.pow(vesselR, 3) / 2; // hemisphere
        const cylinderVolume = Math.PI * vesselR * vesselR * innerCylinderHeight;
        const totalVesselVolume = cylinderVolume + 2 * domeVolume;
        const barrelRegionVolume = Math.PI * barrelOuterR * barrelOuterR * barrelHeight;
        const downcomerVolume = totalVesselVolume - barrelRegionVolume;

        // Use initial level from config (default 100%)
        const initialFillLevel = (props.initialLevel !== undefined ? props.initialLevel : 100) / 100;
        console.log(`[Construction] Reactor vessel initial level: ${props.initialLevel}% -> fillLevel=${initialFillLevel}`);

        // Create the core barrel ID
        const coreBarrelId = `${id}-core`;

        // Vessel ports for external piping (to the downcomer region)
        const vesselPorts: Port[] = [
          { id: `${id}-inlet-left`, position: { x: -vesselR, y: -innerHeight / 4 }, direction: 'both' },
          { id: `${id}-outlet-right`, position: { x: vesselR, y: -innerHeight / 4 }, direction: 'both' }
        ];

        // Create the main reactor vessel component - this IS the downcomer hydraulic region
        const reactorVessel: ReactorVesselComponent = {
          id,
          type: 'reactorVessel',
          label: props.name || 'Reactor Vessel',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: vesselElevation,
          innerDiameter: vesselDiameter,
          wallThickness: wallThickness,
          height: innerHeight, // Inner height (volumes don't depend on wall thickness)
          pressureRating: pressureRating,
          barrelDiameter: barrelDiameter,
          barrelThickness: barrelThickness,
          barrelBottomGap: barrelBottomGap,
          barrelTopGap: barrelTopGap,
          coreBarrelId: coreBarrelId,
          ports: vesselPorts, // Vessel now has ports for downcomer connections
          fluid: defaultFluid // Vessel fluid IS the downcomer fluid
        };
        (reactorVessel as any).volume = downcomerVolume;
        (reactorVessel as any).fillLevel = initialFillLevel;

        this.plantState.components.set(id, reactorVessel);
        (reactorVessel as any).nqa1 = props.nqa1 ?? true;

        // Create core barrel component inside the vessel (the core region)
        const coreBarrelPorts: Port[] = [
          { id: `${coreBarrelId}-bottom`, position: { x: 0, y: barrelHeight / 2 }, direction: 'both' },
          { id: `${coreBarrelId}-top`, position: { x: 0, y: -barrelHeight / 2 }, direction: 'both' }
        ];

        const coreBarrel: CoreBarrelComponent = {
          id: coreBarrelId,
          type: 'coreBarrel',
          label: `${props.name || 'RV'} Core Barrel`,
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: vesselElevation + barrelBottomElev,
          innerDiameter: barrelInnerR * 2,
          thickness: barrelThickness,
          height: barrelHeight,
          bottomGap: barrelBottomGap,
          topGap: barrelTopGap,
          ports: coreBarrelPorts,
          fluid: { ...defaultFluid },
          containedBy: id // Core barrel is inside the vessel
        };
        (coreBarrel as any).volume = coreVolume;
        (coreBarrel as any).fillLevel = initialFillLevel;
        (coreBarrel as any).isHydraulicOnly = true; // Don't render separately (vessel renders both)

        this.plantState.components.set(coreBarrelId, coreBarrel);

        // Create containment connections between vessel (downcomer) and core barrel
        // Flow area at barrel openings is the barrel inner cross-section
        const barrelOpeningArea = Math.PI * barrelInnerR * barrelInnerR;

        // Bottom connection: downcomer -> core barrel bottom (if barrel doesn't touch vessel bottom)
        if (barrelBottomGap > 0.1) {
          this.plantState.connections.push({
            fromComponentId: id,  // Vessel (downcomer)
            fromPortId: `${id}-inlet-left`,
            toComponentId: coreBarrelId,
            toPortId: `${coreBarrelId}-bottom`,
            fromElevation: barrelBottomGap / 2,
            toElevation: 0,
            flowArea: barrelOpeningArea,
            length: barrelBottomGap
          });
          console.log(`[Construction] Bottom gap connection (flow area: ${barrelOpeningArea.toFixed(2)} m²)`);
        }

        // Top connection: core barrel top -> downcomer (if barrel doesn't touch vessel top)
        if (barrelTopGap > 0.1) {
          this.plantState.connections.push({
            fromComponentId: coreBarrelId,
            fromPortId: `${coreBarrelId}-top`,
            toComponentId: id,  // Vessel (downcomer)
            toPortId: `${id}-outlet-right`,
            fromElevation: barrelHeight,
            toElevation: innerHeight - barrelTopGap / 2,
            flowArea: barrelOpeningArea,
            length: barrelTopGap
          });
          console.log(`[Construction] Top gap connection (flow area: ${barrelOpeningArea.toFixed(2)} m²)`);
        }

        console.log(`[Construction] Created reactor vessel: wall ${(wallThickness * 1000).toFixed(0)}mm, core ${coreVolume.toFixed(1)} m³, downcomer ${downcomerVolume.toFixed(1)} m³`);
        break;
      }

      case 'scram-controller': {
        // Scram controller - electrical cabinet that monitors reactor and triggers scram
        // Size: typical industrial cabinet dimensions
        const controllerWidth = 1.2;  // 1.2m wide (wider to fit text)
        const controllerHeight = 2.0; // 2m tall

        const controller: ControllerComponent = {
          id,
          type: 'controller',
          controllerType: 'scram',
          label: props.name || 'Scram Controller',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: props.elevation ?? 0,
          width: controllerWidth,
          height: controllerHeight,
          connectedCoreId: props.connectedCore || undefined,
          setpoints: {
            highPower: props.highPower ?? 125,         // % of nominal
            lowPower: props.lowPower ?? 12,            // % of nominal
            highFuelTemp: (props.highFuelTemp ?? 95) / 100,  // Convert % to fraction
            lowCoolantFlow: props.lowCoolantFlow ?? 10 // kg/s
          },
          ports: [] // Controllers have no hydraulic ports
        };

        this.plantState.components.set(id, controller);
        (controller as any).nqa1 = props.nqa1 ?? true;
        console.log(`[Construction] Created scram controller connected to ${props.connectedCore || 'no core'}`);
        break;
      }

      case 'switchyard': {
        // Switchyard - electrical interconnection to the grid
        // Visual representation: transformer, bus bars, transmission lines
        const switchyardWidth = 15;   // 15m wide (large outdoor facility)
        const switchyardHeight = 12;  // 12m tall (transformer + structures)

        const switchyard: SwitchyardComponent = {
          id,
          type: 'switchyard',
          label: props.name || 'Switchyard',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: props.elevation ?? 0,
          width: switchyardWidth,
          height: switchyardHeight,
          transmissionVoltage: 345,  // Fixed at 345 kV
          offsiteLines: props.offsiteLines ?? 2,
          transformerRating: props.transformerRating ?? 1200,
          reliabilityClass: props.reliabilityClass ?? 'standard',
          connectedGeneratorId: props.connectedGenerator || undefined,
          ports: [] // Switchyards connect electrically, not hydraulically
        };

        this.plantState.components.set(id, switchyard);
        (switchyard as any).nqa1 = props.nqa1 ?? false;
        console.log(`[Construction] Created switchyard: ${props.offsiteLines ?? 2} lines, ${props.transformerRating ?? 1200} MW, connected to ${props.connectedGenerator || 'no generator'}`);
        break;
      }

      default:
        console.error(`[Construction] Unknown component type: ${config.type}`);
        return null;
    }

    // Set containedBy if specified (component placed inside a container)
    if (config.containedBy) {
      const component = this.plantState.components.get(id);
      if (component) {
        component.containedBy = config.containedBy;
        console.log(`[Construction] Component '${id}' is contained by '${config.containedBy}'`);
      }
    }

    console.log(`[Construction] Created component '${id}' of type '${config.type}'`);
    return id;
  }

  createConnectionWithPipe(
    fromPortId: string,
    toPortId: string,
    flowArea: number,
    length: number,
    fromElevation: number,
    toElevation: number
  ): boolean {
    // Create an intermediate pipe component
    const pipeId = this.generateComponentId('pipe');
    const diameter = Math.sqrt(flowArea * 4 / Math.PI);

    // Find components by searching for which component owns each port
    let fromComponent: ReturnType<typeof this.plantState.components.get> = undefined;
    let toComponent: ReturnType<typeof this.plantState.components.get> = undefined;
    let fromPort: import('../types').Port | undefined = undefined;
    let toPort: import('../types').Port | undefined = undefined;

    for (const [, component] of this.plantState.components) {
      for (const port of component.ports) {
        if (port.id === fromPortId) {
          fromComponent = component;
          fromPort = port;
        }
        if (port.id === toPortId) {
          toComponent = component;
          toPort = port;
        }
      }
      if (fromComponent && toComponent) break;
    }

    if (!fromComponent || !toComponent || !fromPort || !toPort) {
      console.error(`[Construction] Cannot create pipe connection: component or port not found`);
      return false;
    }

    // Calculate 3D endpoint positions for the pipe
    // In isometric mode, we store both endpoints and project them during rendering
    // Position (x, y) is in the ground plane, elevation is vertical height

    // Start point: from component's world position (use port.x offset for horizontal)
    const startX = fromComponent.position.x + fromPort.position.x;
    const startY = fromComponent.position.y;  // Depth (Y in world space)

    // End point: to component's world position
    const endX = toComponent.position.x + toPort.position.x;
    const endY = toComponent.position.y;

    // Calculate absolute elevations for both endpoints
    const fromComponentElev = (fromComponent as any).elevation ?? 0;
    const toComponentElev = (toComponent as any).elevation ?? 0;
    const startElevation = fromComponentElev + fromElevation;
    const endElevation = toComponentElev + toElevation;

    // Calculate 3D distance for pipe length
    const dx = endX - startX;
    const dy = endY - startY;
    const dz = endElevation - startElevation;
    const actualDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const pipeLength = Math.max(length, actualDistance);

    // Rotation is still needed for 2D mode fallback - calculate in ground plane
    const rotation = Math.atan2(dy, dx);

    console.log(`[Pipe Positioning Debug]`);
    console.log(`  Start: (${startX.toFixed(2)}, ${startY.toFixed(2)}, elev=${startElevation.toFixed(2)})`);
    console.log(`  End: (${endX.toFixed(2)}, ${endY.toFixed(2)}, elev=${endElevation.toFixed(2)})`);
    console.log(`  3D Distance: ${actualDistance.toFixed(2)}m, Pipe length: ${pipeLength.toFixed(2)}m`);

    // Pipe ports are at the ends - bidirectional since flow is determined by physics
    const pipePorts: Port[] = [
      {
        id: `${pipeId}-left`,
        position: { x: 0, y: 0 },  // Left end of pipe
        direction: 'both'
      },
      {
        id: `${pipeId}-right`,
        position: { x: pipeLength, y: 0 },  // Right end of pipe
        direction: 'both'
      }
    ];

    // Compute average fluid properties from connected components
    const pipeFluid = this.computeAverageFluid(
      fromComponent, toComponent, fromElevation, toElevation, fromPort, toPort
    );

    // Get pressure rating from connected components - use the higher of the two
    const fromPressureRating = (fromComponent as any).pressureRating ?? 0;
    const toPressureRating = (toComponent as any).pressureRating ?? 0;
    const pipePressureRating = Math.max(fromPressureRating, toPressureRating) || 155; // Default 155 bar if neither has rating

    const pipe: PipeComponent = {
      id: pipeId,
      type: 'pipe',
      label: `Pipe ${fromComponent.id} to ${toComponent.id}`,
      position: { x: startX, y: startY },
      rotation,
      diameter,
      thickness: 0.01,
      length: pipeLength,
      pressureRating: pipePressureRating,
      ports: pipePorts,
      fluid: pipeFluid,
      // 3D endpoint data for isometric rendering
      elevation: startElevation,
      endPosition: { x: endX, y: endY },
      endElevation: endElevation
    };

    this.plantState.components.set(pipeId, pipe);

    // Pipe is small (height ≈ diameter), connection is at center
    const pipeRelElev = pipe.diameter / 2;

    // Create connections from component to pipe and pipe to component
    // Pass elevations relative to each component's bottom
    // From component → pipe: fromElevation is relative to fromComponent, pipeRelElev is relative to pipe
    this.createConnection(fromPortId, `${pipeId}-left`, fromElevation, pipeRelElev);
    // Pipe → to component: pipeRelElev is relative to pipe, toElevation is relative to toComponent
    this.createConnection(`${pipeId}-right`, toPortId, pipeRelElev, toElevation);

    console.log(`[Construction] Created pipe '${pipeId}' with diameter ${diameter.toFixed(3)}m between components`);
    return true;
  }

  createConnection(
    fromPortId: string,
    toPortId: string,
    fromElevation?: number,
    toElevation?: number,
    flowArea?: number,
    length?: number,
    fromPhaseTolerance?: number,
    toPhaseTolerance?: number
  ): boolean {
    // Find components by searching for which component owns each port
    // This is more robust than parsing port IDs, which can have varying formats
    let fromComponent: ReturnType<typeof this.plantState.components.get> = undefined;
    let toComponent: ReturnType<typeof this.plantState.components.get> = undefined;
    let fromPort: ReturnType<typeof Array.prototype.find<import('../types').Port>> = undefined;
    let toPort: ReturnType<typeof Array.prototype.find<import('../types').Port>> = undefined;

    for (const [, component] of this.plantState.components) {
      for (const port of component.ports) {
        if (port.id === fromPortId) {
          fromComponent = component;
          fromPort = port;
        }
        if (port.id === toPortId) {
          toComponent = component;
          toPort = port;
        }
      }
      if (fromComponent && toComponent) break;
    }

    if (!fromComponent || !toComponent) {
      console.error(`[Construction] Cannot create connection: component not found for ports ${fromPortId} / ${toPortId}`);
      return false;
    }

    if (!fromPort || !toPort) {
      console.error(`[Construction] Cannot create connection: port not found`);
      return false;
    }

    // Calculate relative elevations if not provided
    // Relative elevation = height above component bottom
    const calcFromElev = fromElevation ?? this.getPortRelativeElevation(fromComponent, fromPort);
    const calcToElev = toElevation ?? this.getPortRelativeElevation(toComponent, toPort);

    // Update port connections
    fromPort.connectedTo = toPortId;
    toPort.connectedTo = fromPortId;

    // Auto-detect phase tolerance for condenser outlets (bottom connections)
    // Small tolerance so it draws liquid when there's meaningful liquid present,
    // but switches to mixture/vapor when the hotwell is nearly empty.
    let effectiveFromPhaseTolerance = fromPhaseTolerance;
    if (effectiveFromPhaseTolerance === undefined && fromComponent.type === 'condenser') {
      // Check if this is a bottom port (outlet) - position.y < 0 means bottom of component
      if (fromPort.position.y < 0) {
        effectiveFromPhaseTolerance = 0.01; // Draw liquid if level > 1cm, otherwise mixture
      }
    }

    // Create connection object with elevations and flow properties
    const connection: Connection = {
      fromComponentId: fromComponent.id,
      fromPortId,
      toComponentId: toComponent.id,
      toPortId,
      fromElevation: calcFromElev,
      toElevation: calcToElev,
      fromPhaseTolerance: effectiveFromPhaseTolerance,
      toPhaseTolerance: toPhaseTolerance,
      flowArea: flowArea,
      length: length
    };

    this.plantState.connections.push(connection);

    console.log(`[Construction] Created connection from ${fromPortId} to ${toPortId} (elevations: ${calcFromElev.toFixed(1)}m → ${calcToElev.toFixed(1)}m)`);
    return true;
  }

  /**
   * Update pump port positions based on current diameter and orientation.
   * Called when ratedFlow or orientation changes.
   */
  private updatePumpPorts(component: PlantComponent): void {
    if (component.type !== 'pump' || !component.ports || component.ports.length < 2) {
      return;
    }

    const orientation = (component as any).orientation || 'left-right';
    const scale = component.diameter * 1.3;
    const pumpCasingWidth = scale * 0.75;
    const pumpCasingHeight = scale * 0.5;
    const suctionNozzleHeight = scale * 0.35;
    const inletPipeLength = scale * 0.3;
    const voluteBulge = scale * 0.18;
    const outletPipeLength = scale * 0.45;
    const totalHeight = scale * 1.9;
    const motorTop = -totalHeight / 2;
    const couplingBottom = motorTop + scale * 0.9 + scale * 0.15;
    const casingBottom = couplingBottom + pumpCasingHeight;
    const nozzleBottom = casingBottom + suctionNozzleHeight;

    // Base positions (for left-right orientation)
    const baseInletY = nozzleBottom + inletPipeLength;
    const baseOutletY = couplingBottom + pumpCasingHeight * 0.35;
    const baseOutletX = pumpCasingWidth / 2 + voluteBulge + outletPipeLength;

    // Calculate port positions based on orientation
    switch (orientation) {
      case 'right-left':
        component.ports[0].position = { x: 0, y: baseInletY };
        component.ports[1].position = { x: -baseOutletX, y: baseOutletY };
        break;
      case 'bottom-top':
        component.ports[0].position = { x: -baseInletY, y: 0 };
        component.ports[1].position = { x: -baseOutletY, y: -baseOutletX };
        break;
      case 'top-bottom':
        component.ports[0].position = { x: baseInletY, y: 0 };
        component.ports[1].position = { x: baseOutletY, y: baseOutletX };
        break;
      default: // left-right
        component.ports[0].position = { x: 0, y: baseInletY };
        component.ports[1].position = { x: baseOutletX, y: baseOutletY };
    }
  }

  /**
   * Calculate the elevation of a port relative to the component's bottom.
   * Port position.y is relative to component center, with negative Y = top.
   * Returns: height above component bottom in meters
   */
  private getPortRelativeElevation(component: PlantComponent, port: Port): number {
    const height = this.getComponentHeight(component);
    // Port y is relative to center: -halfHeight = top, +halfHeight = bottom
    // Relative elevation (from component bottom) = height/2 - port.y
    // This gives: top port (y = -h/2) → h/2 - (-h/2) = h (top of component)
    //             bottom port (y = +h/2) → h/2 - h/2 = 0 (bottom)
    //             middle port (y = 0) → h/2 (middle)
    return (height / 2) - port.position.y;
  }

  private generateComponentId(type: string): string {
    const prefix = type.substring(0, 3);

    // Find the highest existing ID number for any component type to avoid collisions
    // This handles cases where components are deleted and new ones created
    let maxExistingId = 0;
    for (const componentId of this.plantState.components.keys()) {
      const match = componentId.match(/^[a-z]+-(\d+)/);
      if (match) {
        const idNum = parseInt(match[1], 10);
        if (idNum > maxExistingId) {
          maxExistingId = idNum;
        }
      }
    }

    // Use the higher of nextComponentId or maxExistingId + 1
    const nextId = Math.max(this.nextComponentId, maxExistingId + 1);
    this.nextComponentId = nextId + 1;

    return `${prefix}-${nextId}`;
  }

  exportToSimulation(): any {
    // TODO: Convert plant state to simulation state
    // This will need to create flow nodes, thermal nodes, pumps, etc.
    console.log('[Construction] Export to simulation not yet implemented');
    return null;
  }

  /**
   * Compute average fluid properties for a pipe connecting two components.
   * Takes into account connection elevation to determine if we're in vapor/liquid space
   * for two-phase components.
   * If only one side has a valid fluid state, uses that side's fluid.
   * If neither has a valid fluid state, uses a default.
   */
  private computeAverageFluid(
    fromComponent: PlantComponent,
    toComponent: PlantComponent,
    fromElevation: number,
    toElevation: number,
    fromPort?: Port,
    toPort?: Port
  ): Fluid {
    // Default fluid if neither component has a valid state
    const defaultFluid: Fluid = {
      temperature: 300,
      pressure: 101325,  // 1 atm
      phase: 'liquid',
      quality: 0,
      flowRate: 0
    };

    // Get fluid properties at each end, considering elevation and port
    // These return null if no valid fluid state exists
    const fromFluid = this.getFluidAtElevation(fromComponent, fromElevation, fromPort);
    const toFluid = this.getFluidAtElevation(toComponent, toElevation, toPort);

    // If only one side has valid fluid, use that side entirely
    if (!fromFluid && !toFluid) {
      console.log(`[Pipe Fluid] Neither component has valid fluid, using default`);
      return defaultFluid;
    }
    if (!fromFluid) {
      console.log(`[Pipe Fluid] Only 'to' component has fluid, using: ${toFluid!.temperature.toFixed(0)}K ${toFluid!.phase}`);
      return { ...toFluid!, flowRate: 0 };
    }
    if (!toFluid) {
      console.log(`[Pipe Fluid] Only 'from' component has fluid, using: ${fromFluid.temperature.toFixed(0)}K ${fromFluid.phase}`);
      return { ...fromFluid, flowRate: 0 };
    }

    // Both sides have valid fluid - average specific internal energy (u) and specific volume (v)
    // This is thermodynamically correct, as opposed to averaging T and P directly

    // Helper to compute u and v from fluid state
    const getUV = (fluid: Fluid): { u: number; v: number } => {
      const T = fluid.temperature;
      const q = fluid.quality ?? 0;

      if (fluid.phase === 'two-phase') {
        // Two-phase: interpolate between saturated liquid and vapor
        const u_f = saturatedLiquidEnergy(T);
        const u_g = saturatedVaporEnergy(T);
        const u = u_f + q * (u_g - u_f);

        const rho_f = saturatedLiquidDensity(T);
        const rho_g = saturatedVaporDensity(T);
        const v_f = 1 / rho_f;
        const v_g = 1 / rho_g;
        const v = v_f + q * (v_g - v_f);

        return { u, v };
      } else if (fluid.phase === 'vapor') {
        // Superheated vapor: approximate u from saturated vapor energy
        // For superheated steam, u increases roughly linearly with T above saturation
        const u = saturatedVaporEnergy(T);
        const rho = saturatedVaporDensity(T);
        const v = 1 / rho;
        return { u, v };
      } else {
        // Subcooled liquid: approximate u from saturated liquid energy
        const u = saturatedLiquidEnergy(T);
        const rho = saturatedLiquidDensity(T);
        const v = 1 / rho;
        return { u, v };
      }
    };

    const fromUV = getUV(fromFluid);
    const toUV = getUV(toFluid);

    // Average u and v
    const avgU = (fromUV.u + toUV.u) / 2;
    const avgV = (fromUV.v + toUV.v) / 2;

    // Use calculateState to derive T, P, phase, quality from averaged u and v
    // calculateState takes (mass, U_total, V_total), so we use unit mass (1 kg)
    const state = calculateState(1, avgU, avgV);

    console.log(`[Pipe Fluid] From: ${fromFluid.temperature.toFixed(0)}K ${fromFluid.phase} (u=${fromUV.u.toFixed(0)}, v=${fromUV.v.toFixed(4)}), ` +
                `To: ${toFluid.temperature.toFixed(0)}K ${toFluid.phase} (u=${toUV.u.toFixed(0)}, v=${toUV.v.toFixed(4)}), ` +
                `Avg: ${state.temperature.toFixed(0)}K ${state.phase} (u=${avgU.toFixed(0)}, v=${avgV.toFixed(4)})`);

    return {
      temperature: state.temperature,
      pressure: state.pressure,
      phase: state.phase,
      quality: state.quality ?? 0,
      flowRate: 0
    };
  }

  /**
   * Get the fluid properties at a specific elevation within a component.
   * For two-phase components, high elevation = vapor space, low elevation = liquid space.
   * For components with inlet/outlet fluids (turbines, pumps), uses the appropriate fluid
   * based on which port is being connected.
   * Returns null if the component has no valid fluid state.
   */
  private getFluidAtElevation(component: PlantComponent, elevation: number, port?: Port): Fluid | null {
    // Check for inlet/outlet fluids (turbines, pumps, etc.)
    // These components have separate inlet and outlet conditions
    const compAny = component as any;
    if (compAny.inletFluid || compAny.outletFluid) {
      // Determine which fluid to use based on port direction or ID
      const isOutletPort = port?.direction === 'out' || port?.id?.includes('outlet');

      if (isOutletPort && compAny.outletFluid) {
        console.log(`[getFluidAtElevation] ${component.id}: using outletFluid (port: ${port?.id})`);
        return compAny.outletFluid;
      } else if (compAny.inletFluid) {
        console.log(`[getFluidAtElevation] ${component.id}: using inletFluid (port: ${port?.id})`);
        return compAny.inletFluid;
      }
    }

    if (!component.fluid) {
      console.log(`[getFluidAtElevation] ${component.id}: no fluid defined, returning null`);
      return null;
    }

    const fluid = component.fluid;
    const componentHeight = this.getComponentHeight(component);
    const fillLevel = this.getComponentFillLevel(component);
    const liquidLevelHeight = fillLevel * componentHeight;

    console.log(`[getFluidAtElevation] ${component.id}: phase=${fluid.phase}, fillLevel=${fillLevel.toFixed(2)}, ` +
                `height=${componentHeight.toFixed(1)}m, liquidLevel=${liquidLevelHeight.toFixed(1)}m, ` +
                `connectionElev=${elevation.toFixed(1)}m`);

    // For non-two-phase, just return the fluid as-is
    if (fluid.phase !== 'two-phase') {
      console.log(`[getFluidAtElevation] ${component.id}: not two-phase, returning as-is: ${fluid.phase}`);
      return fluid;
    }

    // For two-phase: determine if we're in vapor or liquid space based on elevation
    // If elevation is above liquid level, we're in vapor space
    if (elevation > liquidLevelHeight) {
      // Return saturated vapor properties
      const T_sat = saturationTemperature(fluid.pressure);
      console.log(`[getFluidAtElevation] ${component.id}: elev ${elevation.toFixed(1)} > liquidLevel ${liquidLevelHeight.toFixed(1)} -> VAPOR`);
      return {
        temperature: T_sat,
        pressure: fluid.pressure,
        phase: 'vapor',
        quality: 1,
        flowRate: 0
      };
    } else {
      // Return saturated liquid properties
      const T_sat = saturationTemperature(fluid.pressure);
      console.log(`[getFluidAtElevation] ${component.id}: elev ${elevation.toFixed(1)} <= liquidLevel ${liquidLevelHeight.toFixed(1)} -> LIQUID`);
      return {
        temperature: T_sat,
        pressure: fluid.pressure,
        phase: 'liquid',
        quality: 0,
        flowRate: 0
      };
    }
  }

  private getComponentHeight(component: PlantComponent): number {
    if ('height' in component) {
      return (component as any).height;
    }
    // Default heights for components without explicit height
    switch (component.type) {
      case 'pump': return 1;
      case 'valve': return 0.5;
      case 'pipe': return (component as PipeComponent).diameter || 0.3;
      default: return 2;
    }
  }

  private getComponentFillLevel(component: PlantComponent): number {
    // Get fill level (0-1) for liquid level calculation
    if ('fillLevel' in component) {
      return (component as TankComponent).fillLevel;
    }
    // Default: assume full for single-phase, or 50% for two-phase
    if (component.fluid?.phase === 'two-phase') {
      // Estimate from quality: low quality = mostly liquid = high fill
      const quality = component.fluid.quality ?? 0.5;
      return 1 - quality;  // Rough approximation
    }
    return 1; // Assume full
  }

  /**
   * Delete a component and all its connections
   */
  deleteComponent(componentId: string): boolean {
    const component = this.plantState.components.get(componentId);
    if (!component) {
      console.error(`[Construction] Cannot delete: component ${componentId} not found`);
      return false;
    }

    // Collect all component IDs to delete (includes sub-components for reactor vessels)
    const idsToDelete = new Set<string>([componentId]);

    // For reactor vessels, also include the core barrel
    if (component.type === 'reactorVessel') {
      const rv = component as ReactorVesselComponent;
      if (rv.coreBarrelId) idsToDelete.add(rv.coreBarrelId);
      // Legacy support for old save files
      if ((rv as any).insideBarrelId) idsToDelete.add((rv as any).insideBarrelId);
      if ((rv as any).outsideBarrelId) idsToDelete.add((rv as any).outsideBarrelId);
    }

    // Remove all connections involving any of these components
    const connectionsToRemove = this.plantState.connections.filter(
      conn => idsToDelete.has(conn.fromComponentId) || idsToDelete.has(conn.toComponentId)
    );

    for (const conn of connectionsToRemove) {
      // Clear connectedTo references on the ports
      const fromComp = this.plantState.components.get(conn.fromComponentId);
      const toComp = this.plantState.components.get(conn.toComponentId);

      if (fromComp) {
        const fromPort = fromComp.ports.find(p => p.id === conn.fromPortId);
        if (fromPort) fromPort.connectedTo = undefined;
      }
      if (toComp) {
        const toPort = toComp.ports.find(p => p.id === conn.toPortId);
        if (toPort) toPort.connectedTo = undefined;
      }
    }

    // Filter out the removed connections
    this.plantState.connections = this.plantState.connections.filter(
      conn => !idsToDelete.has(conn.fromComponentId) && !idsToDelete.has(conn.toComponentId)
    );

    // Remove all components
    for (const id of idsToDelete) {
      this.plantState.components.delete(id);
    }

    console.log(`[Construction] Deleted ${idsToDelete.size} component(s) and ${connectionsToRemove.length} connection(s)`);
    return true;
  }

  /**
   * Delete a specific connection
   */
  deleteConnection(fromComponentId: string, toComponentId: string): boolean {
    // Find the connection
    const connIndex = this.plantState.connections.findIndex(
      conn => (conn.fromComponentId === fromComponentId && conn.toComponentId === toComponentId) ||
              (conn.fromComponentId === toComponentId && conn.toComponentId === fromComponentId)
    );

    if (connIndex === -1) {
      console.error(`[Construction] Cannot delete: connection between ${fromComponentId} and ${toComponentId} not found`);
      return false;
    }

    const conn = this.plantState.connections[connIndex];

    // Clear connectedTo references on the ports
    const fromComp = this.plantState.components.get(conn.fromComponentId);
    const toComp = this.plantState.components.get(conn.toComponentId);

    if (fromComp) {
      const fromPort = fromComp.ports.find(p => p.id === conn.fromPortId);
      if (fromPort) fromPort.connectedTo = undefined;
    }
    if (toComp) {
      const toPort = toComp.ports.find(p => p.id === conn.toPortId);
      if (toPort) toPort.connectedTo = undefined;
    }

    // Remove the connection
    this.plantState.connections.splice(connIndex, 1);

    console.log(`[Construction] Deleted connection: ${conn.fromComponentId} → ${conn.toComponentId}`);
    return true;
  }

  /**
   * Update component properties from edited values
   */
  updateComponent(componentId: string, properties: Record<string, any>): boolean {
    const component = this.plantState.components.get(componentId) as Record<string, any>;
    if (!component) {
      console.error(`[Construction] Cannot update: component ${componentId} not found`);
      return false;
    }

    // Apply property updates with unit conversions
    if (properties.name !== undefined) {
      component.label = properties.name;
    }
    if (properties.elevation !== undefined) {
      component.elevation = properties.elevation;
    }
    if (properties.height !== undefined) {
      component.height = properties.height;
    }
    if (properties.diameter !== undefined) {
      component.diameter = properties.diameter;
    }
    if (properties.length !== undefined) {
      component.length = properties.length;
    }
    if (properties.volume !== undefined) {
      // For tanks, calculate width from volume and height
      if (component.type === 'tank' && component.height) {
        const radius = Math.sqrt(properties.volume / (Math.PI * component.height));
        component.width = radius * 2;
      }
    }

    // Pipe-specific endpoint properties
    if (component.type === 'pipe') {
      const pipe = component as PipeComponent;

      // Update start position
      if (properties.startX !== undefined) {
        pipe.position.x = properties.startX;
      }
      if (properties.startY !== undefined) {
        pipe.position.y = properties.startY;
      }

      // Update end position
      if (properties.endX !== undefined || properties.endY !== undefined) {
        if (!pipe.endPosition) {
          pipe.endPosition = { x: pipe.position.x + pipe.length, y: pipe.position.y };
        }
        if (properties.endX !== undefined) {
          pipe.endPosition.x = properties.endX;
        }
        if (properties.endY !== undefined) {
          pipe.endPosition.y = properties.endY;
        }
      }

      // Update end elevation
      if (properties.endElevation !== undefined) {
        pipe.endElevation = properties.endElevation;
      }

      // Recalculate length from endpoints (3D distance)
      if (pipe.endPosition && pipe.endElevation !== undefined && pipe.elevation !== undefined) {
        const dx = pipe.endPosition.x - pipe.position.x;
        const dy = pipe.endPosition.y - pipe.position.y;
        const dz = pipe.endElevation - pipe.elevation;
        pipe.length = Math.sqrt(dx*dx + dy*dy + dz*dz);

        // Update port positions to match new length
        const rightPort = pipe.ports.find(p => p.id.endsWith('-right'));
        if (rightPort) {
          rightPort.position.x = pipe.length;
        }
      }
    }

    // Valve-specific properties
    if (properties.type !== undefined && component.type === 'valve') {
      component.valveType = properties.type;
    }
    if (properties.initialPosition !== undefined && component.type === 'valve') {
      component.opening = properties.initialPosition / 100; // % to 0-1
    }

    // Relief valve / PORV specific
    if (properties.setpoint !== undefined) {
      component.setpoint = properties.setpoint * 1e5; // bar to Pa
    }
    if (properties.blowdown !== undefined) {
      component.blowdown = properties.blowdown / 100; // % to 0-1
    }

    // Check valve specific
    if (properties.crackingPressure !== undefined) {
      component.crackingPressure = properties.crackingPressure * 1e5; // bar to Pa
    }

    // Pump-specific properties
    if (properties.ratedFlow !== undefined) {
      component.ratedFlow = properties.ratedFlow;
      // Recalculate diameter based on new flow
      if (component.type === 'pump') {
        const flow = properties.ratedFlow;
        component.diameter = 0.2 + Math.sqrt(flow / 1000) * 0.4;
        // Recalculate port positions
        this.updatePumpPorts(component as PlantComponent);
      }
    }
    if (properties.ratedHead !== undefined) {
      component.ratedHead = properties.ratedHead;
    }
    if (properties.initialState !== undefined && component.type === 'pump') {
      component.running = properties.initialState === 'on';
    }
    if (properties.orientation !== undefined && component.type === 'pump') {
      // Store orientation - rendering handles transforms internally
      (component as any).orientation = properties.orientation;
      // Rotation stays 0 for pumps
      component.rotation = 0;
      // Recalculate port positions based on new orientation
      this.updatePumpPorts(component as PlantComponent);
    }

    // Fluid properties - update initial conditions
    if (properties.initialPressure !== undefined && component.fluid) {
      component.fluid.pressure = properties.initialPressure * 1e5; // bar to Pa
    }
    if (properties.initialTemperature !== undefined && component.fluid) {
      component.fluid.temperature = properties.initialTemperature + 273.15; // C to K
    }
    if (properties.initialPhase !== undefined && component.fluid) {
      component.fluid.phase = properties.initialPhase;
    }
    if (properties.initialQuality !== undefined && component.fluid) {
      component.fluid.quality = properties.initialQuality; // Already 0-1
    }
    if (properties.initialLevel !== undefined) {
      component.fillLevel = properties.initialLevel / 100; // % to 0-1

      // For reactor vessels, also update the core barrel
      if (component.type === 'reactorVessel') {
        const rv = component as ReactorVesselComponent;
        if (rv.coreBarrelId) {
          const coreBarrel = this.plantState.components.get(rv.coreBarrelId) as CoreBarrelComponent;
          if (coreBarrel && coreBarrel.fluid) {
            // Core barrel fill level is managed via fluid state, not fillLevel property
          }
        }
        // Legacy support for old save files
        if ((rv as any).insideBarrelId) {
          const insideBarrel = this.plantState.components.get((rv as any).insideBarrelId) as any;
          if (insideBarrel) {
            insideBarrel.fillLevel = properties.initialLevel / 100;
          }
        }
        if ((rv as any).outsideBarrelId) {
          const outsideBarrel = this.plantState.components.get((rv as any).outsideBarrelId) as any;
          if (outsideBarrel) {
            outsideBarrel.fillLevel = properties.initialLevel / 100;
          }
        }
      }
    }

    // Heat exchanger specific
    if (properties.tubeCount !== undefined) {
      component.tubeCount = properties.tubeCount;
    }
    if (properties.shellDiameter !== undefined) {
      component.width = properties.shellDiameter;
    }
    if (properties.shellLength !== undefined) {
      component.height = properties.shellLength;
    }
    if (properties.hxType !== undefined) {
      component.hxType = properties.hxType;
    }

    // Condenser specific
    if (properties.coolingCapacity !== undefined) {
      component.coolingCapacity = properties.coolingCapacity * 1e6; // MW to W
    }
    if (properties.coolingWaterTemp !== undefined) {
      component.coolingWaterTemp = properties.coolingWaterTemp + 273.15; // C to K
    }
    if (properties.coolingWaterFlow !== undefined) {
      component.coolingWaterFlow = properties.coolingWaterFlow;
    }
    if (properties.operatingPressure !== undefined) {
      component.operatingPressure = properties.operatingPressure * 1e5; // bar to Pa
    }

    // Turbine/turbine-driven-pump specific
    if (properties.ratedPower !== undefined) {
      component.ratedPower = properties.ratedPower * 1e6; // MW to W
    }
    if (properties.inletPressure !== undefined && component.inletFluid) {
      component.inletFluid.pressure = properties.inletPressure * 1e5; // bar to Pa
    }
    if (properties.exhaustPressure !== undefined && component.outletFluid) {
      component.outletFluid.pressure = properties.exhaustPressure * 1e5; // bar to Pa
    }
    if (properties.turbineEfficiency !== undefined) {
      component.turbineEfficiency = properties.turbineEfficiency / 100; // % to 0-1
      // Also update 'efficiency' for turbine-generator which uses that name
      if (component.efficiency !== undefined) {
        component.efficiency = properties.turbineEfficiency / 100;
      }
    }
    if (properties.generatorEfficiency !== undefined) {
      component.generatorEfficiency = properties.generatorEfficiency / 100; // % to 0-1
    }
    if (properties.pumpEfficiency !== undefined) {
      component.pumpEfficiency = properties.pumpEfficiency / 100; // % to 0-1
    }
    if (properties.governorValve !== undefined) {
      component.governorValve = properties.governorValve / 100; // % to 0-1
    }
    if (properties.stages !== undefined) {
      component.stages = properties.stages;
    }

    // Core-specific properties
    if (properties.diameter !== undefined && component.fuelRodCount !== undefined) {
      // This is a core (vessel with fuel)
      component.innerDiameter = properties.diameter;
    }
    if (properties.controlRodBanks !== undefined) {
      component.controlRodCount = properties.controlRodBanks;
    }
    if (properties.initialRodPosition !== undefined && component.controlRodPosition !== undefined) {
      component.controlRodPosition = (100 - properties.initialRodPosition) / 100; // Convert % to 0-1
    }
    if (properties.rodDiameter !== undefined) {
      component.rodDiameter = properties.rodDiameter;
    }
    if (properties.rodPitch !== undefined) {
      component.rodPitch = properties.rodPitch;
      // Recalculate fuel rod count if pitch changed
      if (component.innerDiameter) {
        const pitch_m = properties.rodPitch / 1000;
        const coreArea = Math.PI * Math.pow(component.innerDiameter / 2, 2);
        const pitchArea = pitch_m * pitch_m;
        component.fuelRodCount = Math.floor(coreArea / pitchArea * 0.9);
      }
    }
    if (properties.thermalPower !== undefined) {
      component.thermalPower = properties.thermalPower * 1e6; // MW to W
    }

    // Reactor vessel-specific properties
    if (component.type === 'reactorVessel') {
      if (properties.innerDiameter !== undefined) {
        component.innerDiameter = properties.innerDiameter;
      }
      if (properties.barrelDiameter !== undefined) {
        component.barrelDiameter = properties.barrelDiameter;
      }
      if (properties.barrelThickness !== undefined) {
        component.barrelThickness = properties.barrelThickness;
      }
      if (properties.barrelBottomGap !== undefined) {
        component.barrelBottomGap = properties.barrelBottomGap;
      }
      if (properties.barrelTopGap !== undefined) {
        component.barrelTopGap = properties.barrelTopGap;
      }
      if (properties.pressureRating !== undefined) {
        component.pressureRating = properties.pressureRating;
      }
    }

    // Controller-specific properties
    if (component.type === 'controller') {
      if (properties.connectedCore !== undefined) {
        component.connectedCoreId = properties.connectedCore || undefined;
      }
      if (!component.setpoints) {
        component.setpoints = { highPower: 125, lowPower: 12, highFuelTemp: 0.95, lowCoolantFlow: 10 };
      }
      if (properties.highPower !== undefined) {
        component.setpoints.highPower = properties.highPower;
      }
      if (properties.lowPower !== undefined) {
        component.setpoints.lowPower = properties.lowPower;
      }
      if (properties.highFuelTemp !== undefined) {
        component.setpoints.highFuelTemp = properties.highFuelTemp / 100; // % to 0-1
      }
      if (properties.lowCoolantFlow !== undefined) {
        component.setpoints.lowCoolantFlow = properties.lowCoolantFlow;
      }
    }

    // NQA-1 property (applies to all components)
    if (properties.nqa1 !== undefined) {
      component.nqa1 = properties.nqa1;
    }

    console.log(`[Construction] Updated component ${componentId}`);
    return true;
  }

  /**
   * Get a component by ID
   */
  getComponent(componentId: string): PlantComponent | undefined {
    return this.plantState.components.get(componentId);
  }

  /**
   * Add core properties to an existing container (tank/vessel).
   * This makes the container render with fuel rods inside, like the demo plant's reactor vessel.
   * Returns { success: boolean, error?: string } to provide error messages for display.
   */
  addCoreToContainer(containerId: string, coreProperties: Record<string, any>): { success: boolean; error?: string } {
    const container = this.plantState.components.get(containerId) as Record<string, any>;
    if (!container) {
      const error = `Container ${containerId} not found`;
      console.error(`[Construction] Cannot add core: ${error}`);
      return { success: false, error };
    }

    // Determine the available diameter for the core
    let availableDiameter: number;
    if (container.type === 'reactorVessel') {
      // For reactor vessels, core must fit inside the barrel
      // barrelDiameter is center-line diameter, so inner diameter = barrelDiameter - barrelThickness/2
      availableDiameter = container.barrelDiameter - container.barrelThickness / 2;
    } else {
      availableDiameter = container.innerDiameter || container.width || 3.37;
    }

    // Calculate actual fuel rod count from diameter and pitch (for simulation)
    const coreDiameter = coreProperties.diameter || availableDiameter;

    // Validate that core fits
    if (coreDiameter > availableDiameter) {
      const error = `Core diameter (${coreDiameter.toFixed(2)}m) exceeds available space (${availableDiameter.toFixed(2)}m) in ${container.label || containerId}`;
      console.error(`[Construction] ${error}`);
      return { success: false, error };
    }

    const rodPitch = coreProperties.rodPitch || 12.6; // mm
    const pitch_m = rodPitch / 1000;
    const coreArea = Math.PI * Math.pow(coreDiameter / 2, 2);
    const pitchArea = pitch_m * pitch_m;
    const actualFuelRodCount = Math.floor(coreArea / pitchArea * 0.9);

    // Add fuel rod properties to the container
    // fuelRodCount is for VISUAL rendering (8-12 rods look good)
    // actualFuelRodCount is the real count for simulation
    container.fuelRodCount = 8; // Visual count for rendering (like demo plant)
    container.actualFuelRodCount = actualFuelRodCount; // Real count for simulation
    container.fuelTemperature = 600 + 273.15; // Initial fuel temp in K
    container.fuelMeltingPoint = 2800 + 273.15; // UO2 melting point in K
    container.controlRodCount = coreProperties.controlRodBanks || 4;
    container.controlRodPosition = (100 - (coreProperties.initialRodPosition || 50)) / 100;

    // Store additional core properties for reference
    container.coreDiameter = coreDiameter; // Actual core diameter
    container.rodDiameter = coreProperties.rodDiameter || 9.5; // mm
    container.rodPitch = rodPitch; // mm
    container.thermalPower = (coreProperties.thermalPower || 3000) * 1e6; // W
    container.coreHeight = coreProperties.height; // Core height (may be less than container height)

    // If the container is a tank, convert it to a vessel type for proper rendering
    // (vessels render with domes and fuel rods, tanks don't have domes by default)
    if (container.type === 'tank') {
      container.type = 'vessel';
      // Add vessel-specific properties
      container.innerDiameter = container.width;
      container.wallThickness = container.wallThickness || 0.2; // 20cm for reactor vessel
      container.hasDome = true;
      container.hasBottom = true;
    }

    // Calculate and subtract fuel rod volume from the core region
    const rodDiameter_m = (coreProperties.rodDiameter || 9.5) / 1000; // mm to m
    const coreHeight_m = coreProperties.height || 3.66; // Default to typical PWR height
    const singleRodVolume = Math.PI * Math.pow(rodDiameter_m / 2, 2) * coreHeight_m;
    const totalFuelRodVolume = singleRodVolume * actualFuelRodCount;

    // Store the fuel rod volume for reference
    container.fuelRodVolume = totalFuelRodVolume;

    // For reactor vessels with new architecture, update core barrel properties
    if (container.type === 'reactorVessel') {
      const rv = container as ReactorVesselComponent;
      if (rv.coreBarrelId) {
        const coreBarrel = this.plantState.components.get(rv.coreBarrelId) as CoreBarrelComponent;
        if (coreBarrel) {
          // Transfer fuel properties to the core barrel
          coreBarrel.fuelRodCount = container.fuelRodCount;
          coreBarrel.actualFuelRodCount = actualFuelRodCount;
          coreBarrel.fuelTemperature = container.fuelTemperature;
          coreBarrel.fuelMeltingPoint = container.fuelMeltingPoint;
          coreBarrel.controlRodCount = container.controlRodCount;
          coreBarrel.controlRodPosition = container.controlRodPosition;
          // Clear from vessel (they belong on core barrel now)
          delete (container as any).fuelRodCount;
          delete (container as any).actualFuelRodCount;
          delete (container as any).fuelTemperature;
          delete (container as any).fuelMeltingPoint;
          delete (container as any).controlRodCount;
          delete (container as any).controlRodPosition;
          console.log(`[Construction] Transferred core properties to core barrel ${rv.coreBarrelId}`);
        }
      }
      // Legacy support for old save files
      if ((rv as any).insideBarrelId) {
        const insideBarrel = this.plantState.components.get((rv as any).insideBarrelId) as Record<string, any>;
        if (insideBarrel && insideBarrel.volume !== undefined) {
          const originalVolume = insideBarrel.volume;
          insideBarrel.volume = Math.max(0, originalVolume - totalFuelRodVolume);
          console.log(`[Construction] Adjusted core region volume: ${originalVolume.toFixed(2)} - ${totalFuelRodVolume.toFixed(2)} = ${insideBarrel.volume.toFixed(2)} m³`);
        }

        // Also reduce the barrel opening flow areas to account for fuel rods blocking flow
        const fuelRodCrossSection = Math.PI * Math.pow(rodDiameter_m / 2, 2) * actualFuelRodCount;
        const insideBarrelId = (rv as any).insideBarrelId as string;
        const outsideBarrelId = (rv as any).outsideBarrelId as string;

        // Find and update internal connections between barrel regions
        for (const conn of this.plantState.connections) {
          const isInternalConnection =
            (conn.fromComponentId === insideBarrelId && conn.toComponentId === outsideBarrelId) ||
            (conn.fromComponentId === outsideBarrelId && conn.toComponentId === insideBarrelId);

          if (isInternalConnection && conn.flowArea !== undefined) {
            const originalArea = conn.flowArea;
            conn.flowArea = Math.max(0.01, originalArea - fuelRodCrossSection);
            console.log(`[Construction] Adjusted barrel opening flow area: ${originalArea.toFixed(2)} - ${fuelRodCrossSection.toFixed(2)} = ${conn.flowArea.toFixed(2)} m²`);
          }
        }
      }
    }

    console.log(`[Construction] Added core to ${containerId}: ${actualFuelRodCount} fuel rods (${totalFuelRodVolume.toFixed(2)} m³), ${container.controlRodCount} control rod banks`);
    return { success: true };
  }
}
// Construction manager for creating and managing components in construction mode

import {
  PlantState,
  PlantComponent,
  TankComponent,
  PipeComponent,
  PumpComponent,
  VesselComponent,
  ReactorVesselComponent,
  ValveComponent,
  HeatExchangerComponent,
  TurbineGeneratorComponent,
  TurbineDrivenPumpComponent,
  CondenserComponent,
  Connection,
  Port,
  Fluid
} from '../types';
import { ComponentConfig } from './component-config';
import { saturationTemperature } from '../simulation/water-properties';

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
    const defaultFluid: Fluid = {
      temperature: props.initialTemperature ? props.initialTemperature + 273.15 : 300,
      pressure: props.initialPressure ? props.initialPressure * 100000 : 15000000, // Convert bar to Pa
      phase: 'liquid',
      quality: 0,
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
          wallThickness: 0.05,  // 5cm default
          fillLevel: props.initialLevel / 100,
          ports: tankPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, tank);
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
          wallThickness: 0.05,
          fillLevel: props.initialLevel / 100,
          ports: pressurizerPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, pressurizer);
        break;
      }

      case 'pipe': {
        const pipe: PipeComponent = {
          id,
          type: 'pipe',
          label: props.name || 'Pipe',
          position: { x: worldX, y: worldY },
          rotation: 0,
          diameter: props.diameter,
          thickness: 0.01,  // 1cm default wall thickness
          length: props.length,
          ports: bidirectionalPorts,  // Pipes are bidirectional - flow determined by physics
          fluid: defaultFluid
        };

        this.plantState.components.set(id, pipe);
        break;
      }

      case 'valve': {
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
          fluid: defaultFluid
        };

        this.plantState.components.set(id, valve);
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
        break;
      }

      case 'pump': {
        // Calculate diameter based on flow capacity
        // Small pumps (~100 kg/s): ~0.3m, Large RCPs (~5000 kg/s): ~1.5m
        const flow = props.ratedFlow || 1000;
        const calculatedDiameter = 0.2 + Math.sqrt(flow / 1000) * 0.4;

        // Calculate rotation based on orientation
        let pumpRotation = 0;
        const orientation = props.orientation || 'left-right';
        switch (orientation) {
          case 'left-right': pumpRotation = 0; break;
          case 'right-left': pumpRotation = Math.PI; break;
          case 'bottom-top': pumpRotation = -Math.PI / 2; break;
          case 'top-bottom': pumpRotation = Math.PI / 2; break;
        }

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

        // Inlet at bottom of inlet pipe, outlet on side
        const inletY = nozzleBottom + inletPipeLength;
        const outletY = couplingBottom + pumpCasingHeight * 0.35;
        const outletX = pumpCasingWidth / 2 + voluteBulge + outletPipeLength;

        const pumpPorts: Port[] = [
          { id: 'inlet', position: { x: 0, y: inletY }, direction: 'in' },
          { id: 'outlet', position: { x: outletX, y: outletY }, direction: 'out' }
        ];

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
          fluid: defaultFluid
        };
        // Store orientation for edit dialog
        (pump as any).orientation = orientation;

        this.plantState.components.set(id, pump);
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

        if (isVertical) {
          if (hxType === 'utube') {
            // U-tube vertical: both tube connections at bottom (tube sheet), shell on sides
            hxPorts = [
              { id: `${id}-tube-inlet`, position: { x: -halfW * 0.3, y: halfH }, direction: 'in' },
              { id: `${id}-tube-outlet`, position: { x: halfW * 0.3, y: halfH }, direction: 'out' },
              { id: `${id}-shell-inlet`, position: { x: -halfW, y: halfH * 0.3 }, direction: 'in' },
              { id: `${id}-shell-outlet`, position: { x: halfW, y: -halfH * 0.5 }, direction: 'out' }
            ];
          } else {
            // Straight or helical vertical: tube in at bottom, out at top; shell on sides
            hxPorts = [
              { id: `${id}-tube-inlet`, position: { x: 0, y: halfH }, direction: 'in' },
              { id: `${id}-tube-outlet`, position: { x: 0, y: -halfH }, direction: 'out' },
              { id: `${id}-shell-inlet`, position: { x: -halfW, y: halfH * 0.3 }, direction: 'in' },
              { id: `${id}-shell-outlet`, position: { x: halfW, y: -halfH * 0.3 }, direction: 'out' }
            ];
          }
        } else {
          // Horizontal orientation
          if (hxType === 'utube') {
            // U-tube horizontal: both tube connections at left (tube sheet), shell on top/bottom
            hxPorts = [
              { id: `${id}-tube-inlet`, position: { x: -halfW, y: -halfH * 0.3 }, direction: 'in' },
              { id: `${id}-tube-outlet`, position: { x: -halfW, y: halfH * 0.3 }, direction: 'out' },
              { id: `${id}-shell-inlet`, position: { x: -halfW * 0.3, y: -halfH }, direction: 'in' },
              { id: `${id}-shell-outlet`, position: { x: halfW * 0.5, y: halfH }, direction: 'out' }
            ];
          } else {
            // Straight or helical horizontal: tube in at left, out at right; shell on top/bottom
            hxPorts = [
              { id: `${id}-tube-inlet`, position: { x: -halfW, y: 0 }, direction: 'in' },
              { id: `${id}-tube-outlet`, position: { x: halfW, y: 0 }, direction: 'out' },
              { id: `${id}-shell-inlet`, position: { x: -halfW * 0.3, y: -halfH }, direction: 'in' },
              { id: `${id}-shell-outlet`, position: { x: halfW * 0.3, y: halfH }, direction: 'out' }
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
          ports: hxPorts
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
            temperature: 280 + 273.15,
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

        this.plantState.components.set(id, turbineGen);
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
        break;
      }

      case 'condenser': {
        // Calculate dimensions from volume and height
        const condenserVolume = props.volume || 100;  // m³
        const condenserHeight = props.height || 3;    // m
        // Assuming square footprint: V = W * W * H
        const condenserWidth = Math.sqrt(condenserVolume / condenserHeight);

        const condenser: CondenserComponent = {
          id,
          type: 'condenser',
          label: props.name || 'Condenser',
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: props.elevation ?? 0,  // Default to ground level
          width: condenserWidth,
          height: condenserHeight,
          heatRejection: 0,
          coolingWaterTemp: props.coolingWaterTemp + 273.15,
          tubeCount: 10000,  // Default tube count
          ports: bidirectionalPorts,  // Condensers are bidirectional - steam in, condensate out determined by physics
          fluid: {
            temperature: props.coolingWaterTemp + 273.15 + 10,
            pressure: props.operatingPressure * 100000,
            phase: 'two-phase',
            quality: 0,
            flowRate: 0
          }
        };

        this.plantState.components.set(id, condenser);

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

          // Automatically connect condenser to pump
          this.createConnection(`${id}-right`, `${pumpId}-inlet`);
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

        // Create IDs for the internal regions
        const insideBarrelId = `${id}-inside`;
        const outsideBarrelId = `${id}-outside`;

        // Calculate barrel positions accounting for dome curvature
        // The dome is hemispherical with inner radius = vesselR.
        // At the barrel's outer radius, the dome surface is at:
        // z = R - sqrt(R² - r²) from the tangent point with the cylinder
        // This is the "dome intrusion" - how far the dome curves into the cylindrical region
        // Note: barrelDiameter is the CENTER-LINE diameter (to middle of barrel wall)
        const barrelCenterR = barrelDiameter / 2;
        const barrelOuterR = barrelCenterR + barrelThickness;
        const barrelInnerR = barrelCenterR - barrelThickness;
        const domeIntrusion = vesselR - Math.sqrt(vesselR * vesselR - barrelOuterR * barrelOuterR);

        // Barrel positions are measured from inner geometry (no wall thickness dependence)
        // Gaps are measured from the inner dome surface at the barrel's outer radius
        const barrelBottomElev = domeIntrusion + barrelBottomGap;
        const barrelTopElev = innerHeight - domeIntrusion - barrelTopGap;
        const barrelHeight = barrelTopElev - barrelBottomElev;

        // Inside barrel volume (cylindrical)
        const insideVolume = Math.PI * barrelInnerR * barrelInnerR * barrelHeight;

        // Outside barrel volume = total inner vessel volume - barrel region volume
        // Inner vessel: cylinder of height (innerHeight - 2*vesselR) + two hemispherical domes
        const innerCylinderHeight = innerHeight - 2 * vesselR;
        const domeVolume = (4/3) * Math.PI * Math.pow(vesselR, 3) / 2; // hemisphere
        const cylinderVolume = Math.PI * vesselR * vesselR * innerCylinderHeight;
        const totalVesselVolume = cylinderVolume + 2 * domeVolume;
        const barrelRegionVolume = Math.PI * barrelOuterR * barrelOuterR * barrelHeight;
        const outsideVolume = totalVesselVolume - barrelRegionVolume;

        // Create the main reactor vessel component
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
          insideBarrelId: insideBarrelId,
          outsideBarrelId: outsideBarrelId,
          ports: [], // Main vessel doesn't have ports - the regions do
          fluid: defaultFluid
        };

        this.plantState.components.set(id, reactorVessel);

        // Create inside-barrel region as a hydraulic-only tank (rendered by vessel, not separately)
        const insideBarrelPorts: Port[] = [
          { id: `${insideBarrelId}-bottom`, position: { x: 0, y: barrelHeight / 2 }, direction: 'both' },
          { id: `${insideBarrelId}-top`, position: { x: 0, y: -barrelHeight / 2 }, direction: 'both' }
        ];

        // Use initial level from config (default 100%)
        const initialFillLevel = (props.initialLevel !== undefined ? props.initialLevel : 100) / 100;
        console.log(`[Construction] Reactor vessel initial level: ${props.initialLevel}% -> fillLevel=${initialFillLevel}`);

        // Store fillLevel on main vessel for edit dialog to read
        (reactorVessel as any).fillLevel = initialFillLevel;

        const insideBarrel: TankComponent = {
          id: insideBarrelId,
          type: 'tank',
          label: `${props.name || 'RV'} Core Region`,
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: vesselElevation + barrelBottomElev,
          width: barrelInnerR * 2,
          height: barrelHeight,
          wallThickness: 0,
          fillLevel: initialFillLevel,
          ports: insideBarrelPorts,
          fluid: { ...defaultFluid },
          containedBy: id // Part of reactor vessel
        };
        (insideBarrel as any).volume = insideVolume;
        (insideBarrel as any).isHydraulicOnly = true; // Don't render separately

        this.plantState.components.set(insideBarrelId, insideBarrel);

        // Create outside-barrel region (annulus) as hydraulic-only
        // Ports on the VESSEL, not the annulus region
        const outsideBarrelPorts: Port[] = [
          { id: `${outsideBarrelId}-inlet`, position: { x: -vesselR, y: -innerHeight / 4 }, direction: 'in' },
          { id: `${outsideBarrelId}-outlet`, position: { x: vesselR, y: -innerHeight / 4 }, direction: 'out' }
        ];

        const outsideBarrel: TankComponent = {
          id: outsideBarrelId,
          type: 'tank',
          label: `${props.name || 'RV'} Annulus`,
          position: { x: worldX, y: worldY },
          rotation: 0,
          elevation: vesselElevation,
          width: vesselDiameter,
          height: innerHeight,
          wallThickness: 0,
          fillLevel: initialFillLevel,
          ports: outsideBarrelPorts,
          fluid: { ...defaultFluid },
          containedBy: id // Part of reactor vessel
        };
        (outsideBarrel as any).volume = outsideVolume;
        (outsideBarrel as any).isHydraulicOnly = true; // Don't render separately

        this.plantState.components.set(outsideBarrelId, outsideBarrel);

        // Add the ports to the main vessel for connection purposes
        reactorVessel.ports = [...outsideBarrelPorts];

        // Create automatic connections between inside and outside regions
        // at top/bottom of barrel where there are gaps

        // Flow area at barrel openings is the barrel inner cross-section
        // (the core region only extends inside the barrel; head regions are part of annulus)
        const barrelOpeningArea = Math.PI * barrelInnerR * barrelInnerR;

        // Bottom connection (if barrel doesn't touch vessel bottom)
        if (barrelBottomGap > 0.1) {
          this.plantState.connections.push({
            fromComponentId: outsideBarrelId,
            fromPortId: `${outsideBarrelId}-inlet`, // Use existing port
            toComponentId: insideBarrelId,
            toPortId: `${insideBarrelId}-bottom`,
            fromElevation: barrelBottomGap / 2,
            toElevation: 0,
            flowArea: barrelOpeningArea,
            length: barrelBottomGap
          });
          console.log(`[Construction] Bottom gap connection (flow area: ${barrelOpeningArea.toFixed(2)} m²)`);
        }

        // Top connection (if barrel doesn't touch vessel top)
        if (barrelTopGap > 0.1) {
          this.plantState.connections.push({
            fromComponentId: insideBarrelId,
            fromPortId: `${insideBarrelId}-top`,
            toComponentId: outsideBarrelId,
            toPortId: `${outsideBarrelId}-outlet`, // Use existing port
            fromElevation: barrelHeight,
            toElevation: innerHeight - barrelTopGap / 2,
            flowArea: barrelOpeningArea,
            length: barrelTopGap
          });
          console.log(`[Construction] Top gap connection (flow area: ${barrelOpeningArea.toFixed(2)} m²)`);
        }

        console.log(`[Construction] Created reactor vessel: wall ${(wallThickness * 1000).toFixed(0)}mm, inside ${insideVolume.toFixed(1)} m³, outside ${outsideVolume.toFixed(1)} m³`);
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

    // Pipe ports are at the ends: inlet at x=0, outlet at x=length
    const pipePorts: Port[] = [
      {
        id: `${pipeId}-inlet`,
        position: { x: 0, y: 0 },  // Left end of pipe
        direction: 'in'
      },
      {
        id: `${pipeId}-outlet`,
        position: { x: pipeLength, y: 0 },  // Right end of pipe
        direction: 'out'
      }
    ];

    // Compute average fluid properties from connected components
    const pipeFluid = this.computeAverageFluid(
      fromComponent, toComponent, fromElevation, toElevation
    );

    const pipe: PipeComponent = {
      id: pipeId,
      type: 'pipe',
      label: `Pipe ${fromComponent.id} to ${toComponent.id}`,
      position: { x: startX, y: startY },
      rotation,
      diameter,
      thickness: 0.01,
      length: pipeLength,
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
    this.createConnection(fromPortId, `${pipeId}-inlet`, fromElevation, pipeRelElev);
    // Pipe → to component: pipeRelElev is relative to pipe, toElevation is relative to toComponent
    this.createConnection(`${pipeId}-outlet`, toPortId, pipeRelElev, toElevation);

    console.log(`[Construction] Created pipe '${pipeId}' with diameter ${diameter.toFixed(3)}m between components`);
    return true;
  }

  createConnection(
    fromPortId: string,
    toPortId: string,
    fromElevation?: number,
    toElevation?: number,
    flowArea?: number,
    length?: number
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

    // Create connection object with elevations and flow properties
    const connection: Connection = {
      fromComponentId: fromComponent.id,
      fromPortId,
      toComponentId: toComponent.id,
      toPortId,
      fromElevation: calcFromElev,
      toElevation: calcToElev,
      flowArea: flowArea,
      length: length
    };

    this.plantState.connections.push(connection);

    console.log(`[Construction] Created connection from ${fromPortId} to ${toPortId} (elevations: ${calcFromElev.toFixed(1)}m → ${calcToElev.toFixed(1)}m)`);
    return true;
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
    return `${prefix}-${this.nextComponentId++}`;
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
   */
  private computeAverageFluid(
    fromComponent: PlantComponent,
    toComponent: PlantComponent,
    fromElevation: number,
    toElevation: number
  ): Fluid {
    // Get fluid properties at each end, considering elevation
    const fromFluid = this.getFluidAtElevation(fromComponent, fromElevation);
    const toFluid = this.getFluidAtElevation(toComponent, toElevation);

    // Average the properties
    const avgTemp = (fromFluid.temperature + toFluid.temperature) / 2;
    const avgPressure = (fromFluid.pressure + toFluid.pressure) / 2;

    // Determine phase based on average conditions
    let phase: 'liquid' | 'vapor' | 'two-phase' = 'liquid';
    let quality = 0;

    // Check if either side is vapor/two-phase
    if (fromFluid.phase === 'vapor' && toFluid.phase === 'vapor') {
      phase = 'vapor';
      quality = 1;
    } else if (fromFluid.phase === 'two-phase' || toFluid.phase === 'two-phase') {
      // If connecting to two-phase region, use the quality based on temperature
      phase = 'two-phase';
      const fromQ = fromFluid.quality ?? 0;
      const toQ = toFluid.quality ?? 0;
      quality = (fromQ + toQ) / 2;
    } else if (fromFluid.phase === 'vapor' || toFluid.phase === 'vapor') {
      // One side vapor, one side liquid - likely two-phase in between
      phase = 'two-phase';
      quality = 0.5;
    }

    console.log(`[Pipe Fluid] From: ${fromFluid.temperature.toFixed(0)}K ${fromFluid.phase}, ` +
                `To: ${toFluid.temperature.toFixed(0)}K ${toFluid.phase}, ` +
                `Avg: ${avgTemp.toFixed(0)}K ${phase}`);

    return {
      temperature: avgTemp,
      pressure: avgPressure,
      phase,
      quality,
      flowRate: 0
    };
  }

  /**
   * Get the fluid properties at a specific elevation within a component.
   * For two-phase components, high elevation = vapor space, low elevation = liquid space.
   */
  private getFluidAtElevation(component: PlantComponent, elevation: number): Fluid {
    // Default fluid if component has none defined
    const defaultFluid: Fluid = {
      temperature: 300,
      pressure: 101325,  // 1 atm
      phase: 'liquid',
      quality: 0,
      flowRate: 0
    };

    if (!component.fluid) {
      return defaultFluid;
    }

    const fluid = component.fluid;

    // For non-two-phase, just return the fluid as-is
    if (fluid.phase !== 'two-phase') {
      return fluid;
    }

    // For two-phase: determine if we're in vapor or liquid space based on elevation
    // Get component height
    const componentHeight = this.getComponentHeight(component);
    const fillLevel = this.getComponentFillLevel(component);

    // Liquid level height = fillLevel * componentHeight
    const liquidLevelHeight = fillLevel * componentHeight;

    // If elevation is above liquid level, we're in vapor space
    if (elevation > liquidLevelHeight) {
      // Return saturated vapor properties
      const T_sat = saturationTemperature(fluid.pressure);
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

    // For reactor vessels, also include the sub-components
    if (component.type === 'reactorVessel') {
      const rv = component as any;
      if (rv.insideBarrelId) idsToDelete.add(rv.insideBarrelId);
      if (rv.outsideBarrelId) idsToDelete.add(rv.outsideBarrelId);
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

    // Valve-specific properties
    if (properties.type !== undefined && component.type === 'valve') {
      component.valveType = properties.type;
    }
    if (properties.initialPosition !== undefined && component.type === 'valve') {
      component.opening = properties.initialPosition / 100; // % to 0-1
    }

    // Pump-specific properties
    if (properties.ratedFlow !== undefined) {
      component.ratedFlow = properties.ratedFlow;
      // Recalculate diameter based on new flow
      if (component.type === 'pump') {
        const flow = properties.ratedFlow;
        component.diameter = 0.2 + Math.sqrt(flow / 1000) * 0.4;
        // Update port positions for upright RCP-style pump
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
        const inletY = nozzleBottom + inletPipeLength;
        const outletY = couplingBottom + pumpCasingHeight * 0.35;
        const outletX = pumpCasingWidth / 2 + voluteBulge + outletPipeLength;
        if (component.ports && component.ports.length >= 2) {
          component.ports[0].position = { x: 0, y: inletY };
          component.ports[1].position = { x: outletX, y: outletY };
        }
      }
    }
    if (properties.ratedHead !== undefined) {
      component.ratedHead = properties.ratedHead;
    }
    if (properties.initialState !== undefined && component.type === 'pump') {
      component.running = properties.initialState === 'on';
    }
    if (properties.orientation !== undefined && component.type === 'pump') {
      // Update pump rotation based on orientation
      const orientation = properties.orientation;
      switch (orientation) {
        case 'left-right': component.rotation = 0; break;
        case 'right-left': component.rotation = Math.PI; break;
        case 'bottom-top': component.rotation = -Math.PI / 2; break;
        case 'top-bottom': component.rotation = Math.PI / 2; break;
      }
      // Store orientation for next edit dialog
      (component as any).orientation = orientation;
    }

    // Fluid properties - update initial conditions
    if (properties.initialPressure !== undefined && component.fluid) {
      component.fluid.pressure = properties.initialPressure * 1e5; // bar to Pa
    }
    if (properties.initialTemperature !== undefined && component.fluid) {
      component.fluid.temperature = properties.initialTemperature + 273.15; // C to K
    }
    if (properties.initialLevel !== undefined) {
      component.fillLevel = properties.initialLevel / 100; // % to 0-1

      // For reactor vessels, also update the sub-components
      if (component.type === 'reactorVessel') {
        const rv = component as any;
        if (rv.insideBarrelId) {
          const insideBarrel = this.plantState.components.get(rv.insideBarrelId) as any;
          if (insideBarrel) {
            insideBarrel.fillLevel = properties.initialLevel / 100;
          }
        }
        if (rv.outsideBarrelId) {
          const outsideBarrel = this.plantState.components.get(rv.outsideBarrelId) as any;
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
      availableDiameter = container.barrelDiameter - container.barrelThickness * 2;
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

    // For reactor vessels, update the inside barrel volume and flow areas
    if (container.type === 'reactorVessel' && container.insideBarrelId) {
      const insideBarrel = this.plantState.components.get(container.insideBarrelId) as Record<string, any>;
      if (insideBarrel && insideBarrel.volume !== undefined) {
        const originalVolume = insideBarrel.volume;
        insideBarrel.volume = Math.max(0, originalVolume - totalFuelRodVolume);
        console.log(`[Construction] Adjusted core region volume: ${originalVolume.toFixed(2)} - ${totalFuelRodVolume.toFixed(2)} = ${insideBarrel.volume.toFixed(2)} m³`);
      }

      // Also reduce the barrel opening flow areas to account for fuel rods blocking flow
      const fuelRodCrossSection = Math.PI * Math.pow(rodDiameter_m / 2, 2) * actualFuelRodCount;
      const insideBarrelId = container.insideBarrelId as string;
      const outsideBarrelId = container.outsideBarrelId as string;

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

    console.log(`[Construction] Added core to ${containerId}: ${actualFuelRodCount} fuel rods (${totalFuelRodVolume.toFixed(2)} m³), ${container.controlRodCount} control rod banks`);
    return { success: true };
  }
}
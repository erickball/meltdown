// Construction manager for creating and managing components in construction mode

import {
  PlantState,
  TankComponent,
  PipeComponent,
  PumpComponent,
  VesselComponent,
  ValveComponent,
  HeatExchangerComponent,
  TurbineComponent,
  CondenserComponent,
  Connection,
  Port,
  Fluid
} from '../types';
import { ComponentConfig } from './component-config';

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

    // Create standard ports for most components
    const standardPorts: Port[] = [
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
        const width = props.volume / props.height;  // Approximate width from volume
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
        const width = props.volume / props.height;
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
          ports: standardPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, pipe);
        break;
      }

      case 'valve': {
        const valve: ValveComponent = {
          id,
          type: 'valve',
          label: props.name || 'Valve',
          position: { x: worldX, y: worldY },
          rotation: 0,
          diameter: props.diameter,
          opening: props.initialPosition / 100,
          valveType: props.type || 'gate',
          ports: standardPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, valve);
        break;
      }

      case 'pump': {
        const pump: PumpComponent = {
          id,
          type: 'pump',
          label: props.name || 'Pump',
          position: { x: worldX, y: worldY },
          rotation: 0,
          diameter: 0.3,  // Default 30cm diameter
          running: props.initialState === 'on',
          speed: props.speed / 3600,  // Convert RPM to fraction
          ratedFlow: props.ratedFlow,
          ratedHead: props.ratedHead,
          ports: standardPorts,
          fluid: defaultFluid
        };

        this.plantState.components.set(id, pump);
        break;
      }

      case 'heat-exchanger': {
        // Heat exchanger has 4 ports
        const hxPorts: Port[] = [
          {
            id: `${id}-primary-inlet`,
            position: { x: -0.5, y: -0.25 },
            direction: 'in'
          },
          {
            id: `${id}-primary-outlet`,
            position: { x: 0.5, y: -0.25 },
            direction: 'out'
          },
          {
            id: `${id}-secondary-inlet`,
            position: { x: -0.5, y: 0.25 },
            direction: 'in'
          },
          {
            id: `${id}-secondary-outlet`,
            position: { x: 0.5, y: 0.25 },
            direction: 'out'
          }
        ];

        const hx: HeatExchangerComponent = {
          id,
          type: 'heatExchanger',
          label: props.name || 'Heat Exchanger',
          position: { x: worldX, y: worldY },
          rotation: props.orientation === 'vertical' ? Math.PI / 2 : 0,
          width: props.orientation === 'vertical' ? 1 : 2,
          height: props.orientation === 'vertical' ? 2 : 1,
          primaryFluid: {
            ...defaultFluid,
            pressure: props.primaryPressure * 100000
          },
          secondaryFluid: {
            temperature: 280 + 273.15,
            pressure: props.secondaryPressure * 100000,
            phase: 'two-phase',
            quality: 0.5,
            flowRate: 0
          },
          tubeCount: props.tubeCount,
          ports: hxPorts
        };

        this.plantState.components.set(id, hx);
        break;
      }

      case 'turbine': {
        const turbine: TurbineComponent = {
          id,
          type: 'turbine',
          label: props.name || 'Turbine',
          position: { x: worldX, y: worldY },
          rotation: 0,
          width: 1.5,
          height: 1.2,
          running: true,
          power: 0,
          ratedPower: props.ratedPower * 1000000,  // Convert MW to W
          inletFluid: {
            temperature: 280 + 273.15,
            pressure: props.inletPressure * 100000,
            phase: 'vapor',
            quality: 1.0,
            flowRate: 0
          },
          outletFluid: {
            temperature: 40 + 273.15,
            pressure: props.exhaustPressure * 100000,
            phase: 'two-phase',
            quality: 0.9,
            flowRate: 0
          },
          ports: standardPorts
        };

        this.plantState.components.set(id, turbine);
        break;
      }

      case 'condenser': {
        const condenser: CondenserComponent = {
          id,
          type: 'condenser',
          label: props.name || 'Condenser',
          position: { x: worldX, y: worldY },
          rotation: 0,
          width: 2,
          height: 1,
          heatRejection: 0,
          coolingWaterTemp: props.coolingWaterTemp + 273.15,
          tubeCount: 10000,  // Default tube count
          ports: standardPorts,
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
            position: { x: worldX + 0.5, y: worldY + 1.2 },
            rotation: 0,
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
        break;
      }

      case 'core': {
        // Create a standalone core component (rendered as fuel assemblies)
        // Using vessel type but with special properties
        const coreHeight = 3.6;  // Standard PWR core height ~3.6m
        const coreDiameter = 3.4;  // Standard PWR core diameter ~3.4m

        // Core has 4 connection points for coolant flow
        const corePorts: Port[] = [
          {
            id: `${id}-inlet-1`,
            position: { x: -coreDiameter/2, y: coreHeight/2 },  // Bottom left
            direction: 'in'
          },
          {
            id: `${id}-inlet-2`,
            position: { x: coreDiameter/2, y: coreHeight/2 },   // Bottom right
            direction: 'in'
          },
          {
            id: `${id}-outlet-1`,
            position: { x: -coreDiameter/2, y: -coreHeight/2 }, // Top left
            direction: 'out'
          },
          {
            id: `${id}-outlet-2`,
            position: { x: coreDiameter/2, y: -coreHeight/2 },  // Top right
            direction: 'out'
          }
        ];

        const core: VesselComponent = {
          id,
          type: 'vessel',
          label: props.name || 'Reactor Core',
          position: { x: worldX, y: worldY },
          rotation: 0,
          innerDiameter: coreDiameter,
          wallThickness: 0,  // No vessel wall for bare core
          height: coreHeight,
          hasDome: false,  // No dome for bare core
          hasBottom: false,  // No bottom for bare core
          fuelRodCount: props.fuelAssemblies,
          fuelTemperature: 600 + 273.15,  // Initial fuel temp
          fuelMeltingPoint: 2800 + 273.15,
          controlRodCount: props.controlRods,
          controlRodPosition: (100 - props.initialRodPosition) / 100,  // Convert to 0-1
          ports: corePorts,
          fluid: {
            temperature: 320 + 273.15,  // Typical core outlet temp
            pressure: 15500000,  // 155 bar typical PWR pressure
            phase: 'liquid',
            quality: 0,
            flowRate: 0
          }
        };

        this.plantState.components.set(id, core);
        break;
      }

      default:
        console.error(`[Construction] Unknown component type: ${config.type}`);
        return null;
    }

    console.log(`[Construction] Created component '${id}' of type '${config.type}'`);
    return id;
  }

  createConnectionWithPipe(
    fromPortId: string,
    toPortId: string,
    flowArea: number,
    length: number,
    _fromElevation: number,  // TODO: Use elevation for vertical routing
    _toElevation: number     // TODO: Use elevation for vertical routing
  ): boolean {
    // Create an intermediate pipe component
    const pipeId = this.generateComponentId('pipe');
    const diameter = Math.sqrt(flowArea * 4 / Math.PI);

    // Get component positions to place pipe between them
    const fromComponentId = fromPortId.substring(0, fromPortId.lastIndexOf('-'));
    const toComponentId = toPortId.substring(0, toPortId.lastIndexOf('-'));
    const fromComponent = this.plantState.components.get(fromComponentId);
    const toComponent = this.plantState.components.get(toComponentId);

    if (!fromComponent || !toComponent) return false;

    // Find the actual ports to get their positions
    const fromPort = fromComponent.ports?.find(p => p.id === fromPortId);
    const toPort = toComponent.ports?.find(p => p.id === toPortId);

    if (!fromPort || !toPort) return false;

    // Calculate actual port positions in world space
    const fromPortWorldX = fromComponent.position.x + fromPort.position.x;
    const fromPortWorldY = fromComponent.position.y + fromPort.position.y;
    const toPortWorldX = toComponent.position.x + toPort.position.x;
    const toPortWorldY = toComponent.position.y + toPort.position.y;

    // Calculate pipe rotation to align with connection
    const dx = toPortWorldX - fromPortWorldX;
    const dy = toPortWorldY - fromPortWorldY;
    const rotation = Math.atan2(dy, dx);

    // Calculate actual distance between ports
    const actualDistance = Math.sqrt(dx * dx + dy * dy);

    // Use the actual distance as the pipe length if it's different from specified
    const pipeLength = Math.max(length, actualDistance);

    // Position pipe so its inlet (at x=0 in local coords) is at the fromPort position
    // The pipe is rendered from x=0 to x=length, so its origin is at the left end
    const pipeX = fromPortWorldX;
    const pipeY = fromPortWorldY;

    console.log(`[Pipe Positioning Debug]`);
    console.log(`  From port: (${fromPortWorldX.toFixed(2)}, ${fromPortWorldY.toFixed(2)})`);
    console.log(`  To port: (${toPortWorldX.toFixed(2)}, ${toPortWorldY.toFixed(2)})`);
    console.log(`  Distance: ${actualDistance.toFixed(2)}m, Pipe length: ${pipeLength.toFixed(2)}m`);
    console.log(`  Pipe position (left end): (${pipeX.toFixed(2)}, ${pipeY.toFixed(2)})`);
    console.log(`  Rotation: ${(rotation * 180 / Math.PI).toFixed(1)}°`);

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

    const pipe: PipeComponent = {
      id: pipeId,
      type: 'pipe',
      label: `Pipe ${fromComponentId} to ${toComponentId}`,
      position: { x: pipeX, y: pipeY },
      rotation,
      diameter,
      thickness: 0.01,
      length: pipeLength,
      ports: pipePorts,
      fluid: {
        temperature: 300,
        pressure: 15000000,
        phase: 'liquid',
        quality: 0,
        flowRate: 0
      }
    };

    this.plantState.components.set(pipeId, pipe);

    // Create connections from component to pipe and pipe to component
    this.createConnection(fromPortId, `${pipeId}-inlet`);
    this.createConnection(`${pipeId}-outlet`, toPortId);

    console.log(`[Construction] Created pipe '${pipeId}' with diameter ${diameter.toFixed(3)}m between components`);
    return true;
  }

  createConnection(fromPortId: string, toPortId: string): boolean {
    // Extract component IDs from port IDs
    const fromComponentId = fromPortId.substring(0, fromPortId.lastIndexOf('-'));
    const toComponentId = toPortId.substring(0, toPortId.lastIndexOf('-'));

    const fromComponent = this.plantState.components.get(fromComponentId);
    const toComponent = this.plantState.components.get(toComponentId);

    if (!fromComponent || !toComponent) {
      console.error(`[Construction] Cannot create connection: component not found`);
      return false;
    }

    // Find the ports
    const fromPort = fromComponent.ports.find(p => p.id === fromPortId);
    const toPort = toComponent.ports.find(p => p.id === toPortId);

    if (!fromPort || !toPort) {
      console.error(`[Construction] Cannot create connection: port not found`);
      return false;
    }

    // Update port connections
    fromPort.connectedTo = toPortId;
    toPort.connectedTo = fromPortId;

    // Create connection object
    const connection: Connection = {
      fromComponentId,
      fromPortId,
      toComponentId,
      toPortId
    };

    this.plantState.connections.push(connection);

    console.log(`[Construction] Created connection from ${fromPortId} to ${toPortId}`);
    return true;
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
}
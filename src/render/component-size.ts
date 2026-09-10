import { PlantComponent, radiantRingOf } from '../types';
import { getComponentVisualHeight } from './components';

/**
 * A component's drawn size in world metres: width across the screen and
 * the vertical extent of its front-view drawing. This is the box every
 * projection (2D, 2.5D perspective, grid) anchors the component drawing
 * with, so a second size convention anywhere else would detach shadows,
 * hit boxes and connection endpoints from the drawing.
 *
 * For plan-native components (buildings, switchyards) `height` is the plan
 * DEPTH, not a vertical extent - they are drawn from the ground plane up.
 */
export function getComponentSize(component: PlantComponent): { width: number; height: number } {
  switch (component.type) {
    case 'tank': {
      // A tank that is a radiant surface is drawn as its ring of standpipes,
      // as wide as the circle they stand on (see radiantRingOf)
      const ring = radiantRingOf(component as never);
      return { width: ring ? ring.diameter : (component as any).width, height: (component as any).height };
    }
    case 'pipe':
      return { width: (component as any).length, height: (component as any).diameter };
    case 'pump': {
      // Pump is drawn much larger than its diameter
      // Height comes from the shared visual-height helper so connection
      // elevations (stored against the same convention) stay anchored to
      // the drawn nozzles. Width includes volute bulge and outlet pipe.
      const pumpD = (component as any).diameter || 0.3;
      const pumpScale = pumpD * 1.3;
      const pumpWidth = pumpScale * 1.5;   // Casing + volute + outlet
      return { width: pumpWidth, height: getComponentVisualHeight(component) };
    }
    case 'vessel': {
      const vesselR = (component as any).innerDiameter / 2 + (component as any).wallThickness;
      return { width: vesselR * 2, height: (component as any).height };
    }
    case 'reactorVessel': {
      const rvR2 = (component as any).innerDiameter / 2 + (component as any).wallThickness;
      return { width: rvR2 * 2, height: (component as any).height };
    }
    case 'coreBarrel': {
      // Core barrel is the cylindrical region inside a reactor vessel
      const cbR = (component as any).innerDiameter / 2 + (component as any).thickness;
      return { width: cbR * 2, height: (component as any).height };
    }
    case 'valve': {
      const valveD = (component as any).diameter || 0.2;
      return { width: valveD * 2, height: getComponentVisualHeight(component) };
    }
    case 'heatExchanger':
      return { width: (component as any).width, height: (component as any).height };
    case 'turbine-generator':
      return { width: (component as any).width || 1.5, height: (component as any).height || 1.2 };
    case 'turbine-driven-pump':
      return { width: (component as any).width || 1, height: (component as any).height || 0.6 };
    case 'condenser':
      return { width: (component as any).width || 2, height: (component as any).height || 1 };
    case 'controller':
      return { width: (component as any).width || 1, height: (component as any).height || 1 };
    case 'switchyard':
      return { width: (component as any).width || 15, height: (component as any).height || 12 };
    case 'warehouse':
      // Plan-native like a switchyard: `height` here is the plan DEPTH
      return { width: (component as any).width || 6, height: (component as any).depth || 4 };
    case 'pool':
      // Front-view box, as for a tank: as wide as the pool is across and as
      // tall as it is deep. Its PLAN footprint is square (side x side) - see
      // footprintFromSize, which squares it off the width.
      return { width: (component as any).side || 12, height: (component as any).depth || 12 };
    case 'building': {
      const bldg = component as any;
      // For buildings, the footprint is width x length (depth)
      const w = bldg.shape === 'cylinder' ? (bldg.diameter || 40) : (bldg.width || 40);
      const d = bldg.shape === 'cylinder' ? (bldg.diameter || 40) : (bldg.length || 40);
      return { width: w, height: d };
    }
    case 'crossVessel':
      // Cross-vessel: length is horizontal extent, outerDiameter is the height/depth
      return { width: (component as any).length || 3, height: (component as any).outerDiameter || 1 };
    default:
      console.warn(`[getComponentSize] Unknown component type: ${(component as any).type}, using default size`);
      return { width: 1, height: 1 };
  }
}

/**
 * Typical drawn size for a component TYPE (the palette key, e.g.
 * 'reactor-vessel'), used for the placement preview before the component
 * exists. Same conventions as getComponentSize.
 */
export function getDefaultComponentSize(componentType: string): { width: number; height: number } {
  switch (componentType) {
    case 'tank':
      return { width: 2, height: 2 }; // Typical tank footprint
    case 'pressurizer':
      return { width: 2, height: 2 };
    case 'pipe':
      return { width: 10, height: 0.3 }; // Length x diameter
    case 'pump':
      return { width: 1.5, height: 2.2 }; // Pump visual size
    case 'valve':
    case 'check-valve':
    case 'relief-valve':
    case 'porv':
      return { width: 0.4, height: 0.4 };
    case 'reactor-vessel':
      return { width: 5, height: 5 }; // Vessel diameter
    case 'heat-exchanger':
      return { width: 2.5, height: 8 }; // Vertical orientation (default): width=diameter, height=length
    case 'turbine-generator':
      return { width: 6, height: 4 };
    case 'turbine-driven-pump':
      return { width: 3, height: 1.5 };
    case 'condenser':
      return { width: 8, height: 4 };
    case 'controller':
    case 'scram-controller':
    case 'pid-controller':
      return { width: 1, height: 1 };
    case 'switchyard':
      return { width: 15, height: 12 };
    case 'warehouse':
      return { width: 6, height: 4 };
    case 'building':
      return { width: 40, height: 40 };
    case 'pool':
      return { width: 12, height: 12 };
    case 'core':
      return { width: 3.4, height: 3.4 };
    case 'cross-vessel':
      return { width: 3, height: 1 };
    default:
      return { width: 2, height: 2 };
  }
}

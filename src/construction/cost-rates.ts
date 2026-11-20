/**
 * Unit prices shared by the cost estimate (cost-estimation.ts) and by the
 * building sizing (wall-sizing.ts), which picks a rectangular building's
 * frame spacing as the cheapest way to carry its rating - so the price of a
 * wall has to be known where the wall is sized. A leaf module: it imports
 * nothing but the material table.
 */

import { MATERIALS, resolveMaterial } from '../simulation/materials';

/** Price of a pressure boundary's alloy relative to the steel grade an
 *  estimator assumes for low-alloy steel (materials.ts costFactor). */
export function alloyPriceFactor(material: string | undefined): number {
  return MATERIALS[resolveMaterial(material)].costFactor;
}

// Steel prices ($/kg) for different grades
export const STEEL_PRICES = {
  carbonSteel: 2.5,           // SA-516 Gr 70, general purpose
  lowAlloySteel: 4.0,         // SA-533 Grade B, reactor vessels
  stainlessSteel: 8.0,        // 304/316 SS
};

// Fabrication cost multipliers (vs raw material cost)
export const FABRICATION_MULTIPLIERS = {
  simpleTank: 3.0,            // Basic cylindrical vessel
  pressureVessel: 5.0,        // ASME code vessel with heads
  reactorVessel: 8.0,         // Complex forging, cladding
  heatExchanger: 6.0,         // Tube bundle assembly
  piping: 4.0,                // Including fittings, supports
  pump: 1.0,                  // (base cost includes fabrication)
  valve: 1.0,                 // (base cost includes fabrication)
  turbine: 1.0,               // (base cost includes fabrication)
};

// Installation cost multipliers (vs equipment cost)
export const INSTALLATION_MULTIPLIERS = {
  simpleTank: 0.5,            // Basic rigging and setting
  pressureVessel: 0.8,        // Complex rigging, alignment
  reactorVessel: 1.5,         // Specialized heavy lift, internals
  heatExchanger: 0.7,         // Tube bundle insertion
  piping: 1.2,                // Welding, supports, hangers
  pump: 0.6,                  // Foundation, alignment, piping
  valve: 0.3,                 // Inline installation
  turbine: 1.0,               // Foundation, alignment, auxiliary systems
  condenser: 0.6,             // Placement, circulating water piping
  electrical: 0.4,            // Generator connections
};

// NQA-1 multiplier for nuclear quality components
export const NQA1_MULTIPLIER = 5.0;

// Steel density (kg/m³)
export const STEEL_DENSITY = 7850;

// ------------------------------------------------------------------ buildings

/** Grade 60 reinforcing bar delivered, $/kg. */
export const REBAR_PRICE = 1.0;
/** Cutting, bending, placing and splicing rebar, $/kg. */
export const REBAR_PLACING = 1.5;
/** Wall and dome/roof concrete installed (formwork, placement, curing;
 *  reinforcement priced separately), $/m3. */
export const CONCRETE_WALL_COST = 1000;

/** Welded plate in a building's pressure boundary, $/kg installed: the
 *  same chain as a vessel's plate (raw x alloy factor, ASME fabrication,
 *  rigging), so a solid-steel containment costs what a vessel would. */
export function buildingPlatePrice(material: string | undefined): number {
  const raw = STEEL_PRICES.carbonSteel * alloyPriceFactor(material);
  return raw * (1 + FABRICATION_MULTIPLIERS.pressureVessel) * (1 + INSTALLATION_MULTIPLIERS.pressureVessel);
}

/** Structural steel framing (rolled or built-up I-sections, A992):
 *  ~$1.2/kg delivered plus ~$3/kg to fabricate and erect, $/kg. */
export const FRAME_STEEL_PRICE = 4.2;
/** Per frame member: the lift plus its two moment-resisting end connections
 *  (to the basemat and roof, or wall to wall), $ each. This is what keeps
 *  frames from being spaced arbitrarily close: the steel tonnage of the
 *  frame barely depends on the spacing, the number of pieces does. */
export const FRAME_MEMBER_COST = 25_000;

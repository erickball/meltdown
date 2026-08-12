"""
Calculate true bulk modulus from IAPWS-IF97 equations.

The bulk modulus K is defined as:
  K = -v * (dP/dv)_T = rho * (dP/drho)_T

For Region 1 (compressed liquid), we can compute this directly from the
Gibbs free energy derivatives, or numerically from v(T,P).

This script:
1. Calculates K(T,P) using IAPWS-IF97 at many points
2. Fits polynomial models for K as a function of P at each temperature
3. Exports the coefficients for use in the simulation
"""

import csv
import numpy as np
from iapws import IAPWS97
from pathlib import Path

# Temperature range: 0°C to 370°C (just below critical at 373.95°C)
temperatures_C = list(range(0, 375, 5))  # Every 5°C

# Pressure range: from just above saturation to 50 MPa
# (Region 1 is valid up to 100 MPa but 50 MPa covers our use case)

results = []

print("Calculating bulk modulus from IAPWS-IF97...")
print("=" * 60)

for T_C in temperatures_C:
    T_K = T_C + 273.15

    # Get saturation pressure at this temperature
    try:
        sat = IAPWS97(T=T_K, x=0)  # Saturated liquid
        P_sat_MPa = sat.P
        v_sat = sat.v  # m³/kg (specific volume at saturation)
    except:
        print(f"T={T_C}°C: Could not get saturation properties (may be above critical)")
        continue

    if P_sat_MPa is None or v_sat is None:
        print(f"T={T_C}°C: Invalid saturation properties")
        continue

    # Calculate K at various pressures above saturation
    pressures_MPa = []
    K_values_GPa = []

    # Start from 1% above saturation to avoid numerical issues right at the boundary
    P_min = P_sat_MPa * 1.02
    P_max = min(50.0, 100.0)  # Up to 50 MPa

    if P_min >= P_max:
        print(f"T={T_C}°C: P_sat={P_sat_MPa:.3f} MPa is too high")
        continue

    # Use log spacing to get more points near saturation
    P_range = np.concatenate([
        np.linspace(P_min, min(5.0, P_max), 20),  # Dense near saturation
        np.linspace(5.0, P_max, 30) if P_max > 5.0 else []
    ])
    P_range = np.unique(P_range)

    for P_MPa in P_range:
        try:
            # Get water properties at this (T, P)
            water = IAPWS97(T=T_K, P=P_MPa)

            if water.v is None or water.region != 1:
                continue  # Not in compressed liquid region

            v = water.v  # m³/kg

            # Calculate bulk modulus numerically using central difference
            # K = -v * (dP/dv)_T
            # We'll use: K = v * (P2 - P1) / (v1 - v2) at constant T

            dP = 0.01  # 0.01 MPa step for derivative
            P1, P2 = P_MPa - dP, P_MPa + dP

            if P1 < P_sat_MPa * 1.01:
                P1 = P_sat_MPa * 1.01
                P2 = P1 + 2 * dP

            w1 = IAPWS97(T=T_K, P=P1)
            w2 = IAPWS97(T=T_K, P=P2)

            if w1.v is None or w2.v is None:
                continue

            v1, v2 = w1.v, w2.v

            # dP/dv = (P2 - P1) / (v2 - v1)
            # K = -v * dP/dv = -v * (P2 - P1) / (v2 - v1)
            # Note: v2 < v1 (compression), so (v2-v1) is negative, making K positive

            dPdv = (P2 - P1) / (v2 - v1)  # MPa / (m³/kg)
            K_MPa = -v * dPdv  # MPa
            K_GPa = K_MPa / 1000  # Convert to GPa

            if K_GPa > 0 and K_GPa < 10:  # Sanity check
                pressures_MPa.append(P_MPa)
                K_values_GPa.append(K_GPa)

                results.append({
                    'T_C': T_C,
                    'P_MPa': P_MPa,
                    'P_sat_MPa': P_sat_MPa,
                    'v_m3_kg': v,
                    'K_GPa': K_GPa
                })

        except Exception as e:
            continue

    if len(pressures_MPa) >= 3:
        K_arr = np.array(K_values_GPa)
        print(f"T={T_C:3d}°C: P_sat={P_sat_MPa:.4f} MPa, {len(pressures_MPa):2d} points, "
              f"K={K_arr.min():.3f}-{K_arr.max():.3f} GPa (avg {K_arr.mean():.3f})")

print(f"\nTotal: {len(results)} data points")

# Export to CSV
csv_path = Path(__file__).parent / 'iapws_bulk_modulus.csv'
with open(csv_path, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['T_C', 'P_MPa', 'P_sat_MPa', 'v_m3_kg', 'K_GPa'])
    for r in sorted(results, key=lambda x: (x['T_C'], x['P_MPa'])):
        writer.writerow([
            f"{r['T_C']:.1f}",
            f"{r['P_MPa']:.4f}",
            f"{r['P_sat_MPa']:.6f}",
            f"{r['v_m3_kg']:.8f}",
            f"{r['K_GPa']:.5f}"
        ])
print(f"Exported to {csv_path}")

# Now fit polynomial models for K(P) at each temperature
print("\n" + "=" * 60)
print("Fitting K(P) = a + b*P + c*P² at each temperature...")
print("=" * 60)

fits = []
for T_C in temperatures_C:
    pts = [r for r in results if r['T_C'] == T_C]
    if len(pts) < 5:
        continue

    P_arr = np.array([p['P_MPa'] for p in pts])
    K_arr = np.array([p['K_GPa'] for p in pts])

    # Fit quadratic: K = a + b*P + c*P²
    coeffs = np.polyfit(P_arr, K_arr, 2)
    c, b, a = coeffs  # np.polyfit returns highest degree first

    # Calculate fit quality
    K_fit = a + b * P_arr + c * P_arr**2
    residuals = K_arr - K_fit
    r_squared = 1 - np.sum(residuals**2) / np.sum((K_arr - K_arr.mean())**2)

    # Get saturation pressure
    P_sat = pts[0]['P_sat_MPa']

    # Calculate K at saturation (extrapolated)
    K_at_sat = a + b * P_sat + c * P_sat**2

    fits.append({
        'T_C': T_C,
        'P_sat_MPa': P_sat,
        'a': a,
        'b': b,
        'c': c,
        'K_at_sat': K_at_sat,
        'r_squared': r_squared,
        'n_points': len(pts)
    })

    print(f"T={T_C:3d}°C: K(P) = {a:.4f} + {b:.6f}*P + {c:.8f}*P²  "
          f"(R²={r_squared:.5f}, K@sat={K_at_sat:.3f} GPa)")

# Export fits to CSV
fits_path = Path(__file__).parent / 'iapws_bulk_modulus_fits.csv'
with open(fits_path, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['T_C', 'P_sat_MPa', 'a', 'b', 'c', 'K_at_sat', 'r_squared', 'n_points'])
    for fit in fits:
        writer.writerow([
            f"{fit['T_C']:.1f}",
            f"{fit['P_sat_MPa']:.6f}",
            f"{fit['a']:.8f}",
            f"{fit['b']:.10f}",
            f"{fit['c']:.12f}",
            f"{fit['K_at_sat']:.5f}",
            f"{fit['r_squared']:.6f}",
            fit['n_points']
        ])
print(f"\nExported polynomial fits to {fits_path}")

# Generate TypeScript code for the simulation
print("\n" + "=" * 60)
print("TypeScript bulk modulus function:")
print("=" * 60)

print("""
/**
 * Bulk modulus K(T, P) from IAPWS-IF97 polynomial fits.
 * K = a(T) + b(T)*P + c(T)*P²
 * where P is in MPa and K is returned in Pa.
 *
 * For temperatures between tabulated values, we interpolate the coefficients.
 */

// Polynomial coefficients: [T_C, a, b, c]
const BULK_MODULUS_COEFFS: [number, number, number, number][] = [""")

for fit in fits:
    print(f"  [{fit['T_C']}, {fit['a']:.8f}, {fit['b']:.10f}, {fit['c']:.12f}],")

print("""];

export function bulkModulusPressureDependent(T_C: number, P_MPa: number): number {
  // Clamp temperature to valid range
  const T = Math.max(0, Math.min(370, T_C));

  // Find bracketing entries
  let lo = 0, hi = BULK_MODULUS_COEFFS.length - 1;
  for (let i = 0; i < BULK_MODULUS_COEFFS.length - 1; i++) {
    if (BULK_MODULUS_COEFFS[i][0] <= T && BULK_MODULUS_COEFFS[i + 1][0] > T) {
      lo = i;
      hi = i + 1;
      break;
    }
  }

  // Interpolation factor
  const T_lo = BULK_MODULUS_COEFFS[lo][0];
  const T_hi = BULK_MODULUS_COEFFS[hi][0];
  const t = T_hi > T_lo ? (T - T_lo) / (T_hi - T_lo) : 0;

  // Interpolate coefficients
  const a = BULK_MODULUS_COEFFS[lo][1] + t * (BULK_MODULUS_COEFFS[hi][1] - BULK_MODULUS_COEFFS[lo][1]);
  const b = BULK_MODULUS_COEFFS[lo][2] + t * (BULK_MODULUS_COEFFS[hi][2] - BULK_MODULUS_COEFFS[lo][2]);
  const c = BULK_MODULUS_COEFFS[lo][3] + t * (BULK_MODULUS_COEFFS[hi][3] - BULK_MODULUS_COEFFS[lo][3]);

  // K(P) = a + b*P + c*P² in GPa
  const K_GPa = a + b * P_MPa + c * P_MPa * P_MPa;

  // Return in Pa
  return K_GPa * 1e9;
}
""")

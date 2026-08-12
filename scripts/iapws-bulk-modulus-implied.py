"""
Calculate IMPLIED bulk modulus from IAPWS-IF97 equations.

The implied bulk modulus (same as steam table calculation) is:
  K_implied = (P - P_sat) / ((v_f - v) / v_f)
            = (P - P_sat) * v_f / (v_f - v)

This is a secant from the saturation point, NOT the instantaneous
derivative dP/dv.
"""

import csv
import numpy as np
from iapws import IAPWS97
from pathlib import Path

# Temperature range: 0°C to 370°C (just below critical at 373.95°C)
temperatures_C = list(range(0, 375, 5))  # Every 5°C

results = []

print("Calculating IMPLIED bulk modulus from IAPWS-IF97...")
print("K_implied = (P - P_sat) / ((v_f - v) / v_f)")
print("=" * 60)

for T_C in temperatures_C:
    T_K = T_C + 273.15

    # Get saturation pressure and v_f at this temperature
    try:
        sat = IAPWS97(T=T_K, x=0)  # Saturated liquid
        P_sat_MPa = sat.P
        v_f = sat.v  # m³/kg (specific volume at saturation)
    except:
        print(f"T={T_C}°C: Could not get saturation properties")
        continue

    if P_sat_MPa is None or v_f is None:
        print(f"T={T_C}°C: Invalid saturation properties")
        continue

    # Calculate K_implied at various pressures above saturation
    pressures_MPa = []
    K_values_GPa = []

    # Start from above saturation
    P_min = P_sat_MPa * 1.02
    P_max = min(50.0, 100.0)

    if P_min >= P_max:
        print(f"T={T_C}°C: P_sat={P_sat_MPa:.3f} MPa is too high")
        continue

    # Linear spacing of pressures
    P_range = np.linspace(P_min, P_max, 50)

    for P_MPa in P_range:
        try:
            # Get water properties at this (T, P)
            water = IAPWS97(T=T_K, P=P_MPa)

            if water.v is None or water.region != 1:
                continue  # Not in compressed liquid region

            v = water.v  # m³/kg

            # Calculate compression ratio (same as steam table)
            dv = v_f - v
            if dv <= 1e-10:
                continue

            compression_ratio = dv / v_f

            # Calculate implied bulk modulus (same formula as steam table)
            dP_MPa = P_MPa - P_sat_MPa
            K_implied_GPa = dP_MPa / compression_ratio / 1000  # Convert MPa to GPa

            if K_implied_GPa > 0 and K_implied_GPa < 10:  # Sanity check
                pressures_MPa.append(P_MPa)
                K_values_GPa.append(K_implied_GPa)

                results.append({
                    'T_C': T_C,
                    'P_MPa': P_MPa,
                    'P_sat_MPa': P_sat_MPa,
                    'v_m3_kg': v,
                    'v_f_m3_kg': v_f,
                    'compression_ratio': compression_ratio,
                    'K_implied_GPa': K_implied_GPa
                })

        except Exception as e:
            continue

    if len(pressures_MPa) >= 3:
        K_arr = np.array(K_values_GPa)
        print(f"T={T_C:3d}°C: P_sat={P_sat_MPa:.4f} MPa, {len(pressures_MPa):2d} points, "
              f"K={K_arr.min():.3f}-{K_arr.max():.3f} GPa (avg {K_arr.mean():.3f})")

print(f"\nTotal: {len(results)} data points")

# Export to CSV
csv_path = Path(__file__).parent / 'iapws_bulk_modulus_implied.csv'
with open(csv_path, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['T_C', 'P_MPa', 'P_sat_MPa', 'v_m3_kg', 'v_f_m3_kg', 'compression_ratio', 'K_implied_GPa'])
    for r in sorted(results, key=lambda x: (x['T_C'], x['P_MPa'])):
        writer.writerow([
            f"{r['T_C']:.1f}",
            f"{r['P_MPa']:.4f}",
            f"{r['P_sat_MPa']:.6f}",
            f"{r['v_m3_kg']:.8f}",
            f"{r['v_f_m3_kg']:.8f}",
            f"{r['compression_ratio']:.8f}",
            f"{r['K_implied_GPa']:.5f}"
        ])
print(f"Exported to {csv_path}")

# Fit quadratic models for K(P) at each temperature
print("\n" + "=" * 60)
print("Fitting K(P) = a + b*P + c*P^2 at each temperature...")
print("=" * 60)

fits = []
for T_C in temperatures_C:
    pts = [r for r in results if r['T_C'] == T_C]
    if len(pts) < 5:
        continue

    P_arr = np.array([p['P_MPa'] for p in pts])
    K_arr = np.array([p['K_implied_GPa'] for p in pts])

    # Fit quadratic: K = a + b*P + c*P^2
    coeffs = np.polyfit(P_arr, K_arr, 2)
    c, b, a = coeffs  # np.polyfit returns highest degree first

    # Calculate fit quality
    K_fit = a + b * P_arr + c * P_arr**2
    residuals = K_arr - K_fit
    ss_res = np.sum(residuals**2)
    ss_tot = np.sum((K_arr - K_arr.mean())**2)
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 1.0

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
        'K_avg': K_arr.mean(),
        'r_squared': r_squared,
        'n_points': len(pts)
    })

    print(f"T={T_C:3d}C: K(P) = {a:.4f} + {b:.6f}*P + {c:.2e}*P^2  "
          f"(R^2={r_squared:.6f}, K@sat={K_at_sat:.3f} GPa)")

# Export fits to CSV
fits_path = Path(__file__).parent / 'iapws_bulk_modulus_implied_fits.csv'
with open(fits_path, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['T_C', 'P_sat_MPa', 'a', 'b', 'c', 'K_at_sat', 'K_avg', 'r_squared', 'n_points'])
    for fit in fits:
        writer.writerow([
            f"{fit['T_C']:.1f}",
            f"{fit['P_sat_MPa']:.6f}",
            f"{fit['a']:.8f}",
            f"{fit['b']:.10f}",
            f"{fit['c']:.12f}",
            f"{fit['K_at_sat']:.5f}",
            f"{fit['K_avg']:.5f}",
            f"{fit['r_squared']:.6f}",
            fit['n_points']
        ])
print(f"\nExported quadratic fits to {fits_path}")

# Show comparison at a few temperatures
print("\n" + "=" * 60)
print("Sample K values at different pressures:")
print("=" * 60)

for T_C in [20, 100, 200, 300]:
    pts = [r for r in results if r['T_C'] == T_C]
    if len(pts) < 3:
        continue
    pts.sort(key=lambda x: x['P_MPa'])
    print(f"\nT = {T_C}C (P_sat = {pts[0]['P_sat_MPa']:.4f} MPa):")
    for p in pts[::10]:  # Every 10th point
        print(f"  P={p['P_MPa']:6.2f} MPa: v={p['v_m3_kg']:.7f} m3/kg, "
              f"dv/v={p['compression_ratio']*100:.4f}%, K={p['K_implied_GPa']:.3f} GPa")

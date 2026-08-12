"""
Build a (u, v) grid for water property lookups - Version 3.

Better approach: Instead of solving the inverse problem (u,v) -> (T,P),
generate points by evaluating IAPWS at a (T, P) grid and recording the (u, v).

This is much more reliable and faster.
"""

import numpy as np
import json
from iapws import IAPWS97
from pathlib import Path
import time

# Read saturation dome data
sat_data = []
sat_path = Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt'
with open(sat_path, 'r') as f:
    lines = f.readlines()
    for line in lines[1:]:
        parts = line.strip().split('\t')
        if len(parts) >= 6:
            try:
                sat_data.append({
                    'P_MPa': float(parts[0]),
                    'T_C': float(parts[1]),
                    'v_f': float(parts[2]),
                    'v_g': float(parts[3]),
                    'u_f': float(parts[4]),
                    'u_g': float(parts[5]),
                })
            except:
                pass

print(f"Loaded {len(sat_data)} saturation points")

# Get saturation pressure at a given temperature
sat_data_sorted = sorted(sat_data, key=lambda x: x['T_C'])

def get_P_sat(T_C):
    """Get saturation pressure at temperature T_C."""
    if T_C < sat_data_sorted[0]['T_C']:
        return sat_data_sorted[0]['P_MPa']
    if T_C > sat_data_sorted[-1]['T_C']:
        return None  # Above critical

    for i in range(len(sat_data_sorted) - 1):
        if sat_data_sorted[i]['T_C'] <= T_C < sat_data_sorted[i+1]['T_C']:
            t = (T_C - sat_data_sorted[i]['T_C']) / (sat_data_sorted[i+1]['T_C'] - sat_data_sorted[i]['T_C'])
            return sat_data_sorted[i]['P_MPa'] + t * (sat_data_sorted[i+1]['P_MPa'] - sat_data_sorted[i]['P_MPa'])
    return sat_data_sorted[-1]['P_MPa']


print("\nGenerating (T, P) grid and computing (u, v) at each point...")

# Temperature range
T_min_C = 0
T_max_C = 600  # Well above critical (373.95 C)
T_crit_C = 373.946

# For each temperature, generate pressure points
# - Below saturation: superheated vapor
# - Above saturation: compressed liquid
# - Above critical T: single phase

results = []
start_time = time.time()

# Fine temperature grid
temperatures_C = list(np.linspace(T_min_C, 150, 30))  # Fine below 150C
temperatures_C += list(np.linspace(160, 350, 40))     # Medium 160-350C
temperatures_C += list(np.linspace(355, 380, 20))     # Fine near critical
temperatures_C += list(np.linspace(385, T_max_C, 25)) # Coarser above critical
temperatures_C = sorted(set([round(t, 1) for t in temperatures_C]))

print(f"Processing {len(temperatures_C)} temperatures...")

for T_C in temperatures_C:
    T_K = T_C + 273.15
    P_sat = get_P_sat(T_C)

    # Generate pressure points
    pressures = []

    if T_C < T_crit_C and P_sat is not None:
        # Subcritical: two regions

        # Compressed liquid: P > P_sat
        P_liq_min = P_sat * 1.02  # Just above saturation
        P_liq_max = 100  # MPa
        if P_liq_min < P_liq_max:
            # Denser near saturation, sparser at high P
            p_liq = list(np.linspace(P_liq_min, min(P_sat * 2, 30), 15))
            p_liq += list(np.linspace(min(P_sat * 2, 30), P_liq_max, 10))
            pressures += [(p, 'compressed_liquid') for p in p_liq]

        # Superheated vapor: P < P_sat
        P_vap_max = P_sat * 0.98
        P_vap_min = 0.001  # MPa (1 kPa)
        if P_vap_max > P_vap_min:
            # Log scale for vapor pressures
            p_vap = list(np.logspace(np.log10(P_vap_min), np.log10(P_vap_max), 25))
            pressures += [(p, 'superheated_vapor') for p in p_vap]

    else:
        # Supercritical: single phase
        p_super = list(np.logspace(np.log10(0.001), np.log10(100), 40))
        pressures += [(p, 'supercritical') for p in p_super]

    # Evaluate IAPWS at each (T, P)
    for P, phase_hint in pressures:
        try:
            water = IAPWS97(T=T_K, P=P)
            if water.u is None or water.v is None:
                continue
            if water.phase is None:
                continue

            # Skip two-phase
            phase = water.phase
            if 'Two' in str(phase) or (hasattr(water, 'x') and water.x is not None and 0.001 < water.x < 0.999):
                continue

            results.append({
                'u': float(water.u),
                'v': float(water.v),
                'T_K': float(T_K),
                'T_C': float(T_C),
                'P_MPa': float(P),
                'phase': phase_hint,
                'rho': float(1 / water.v),  # kg/m³
            })

        except Exception as e:
            continue

elapsed = time.time() - start_time
print(f"Generated {len(results)} points in {elapsed:.1f}s")

# Summary by phase
phases = {}
for pt in results:
    phase = pt['phase']
    phases[phase] = phases.get(phase, 0) + 1

print("\nPoints by phase:")
for phase, count in sorted(phases.items()):
    print(f"  {phase}: {count}")

# Ranges
print(f"\nu range: {min(pt['u'] for pt in results):.1f} to {max(pt['u'] for pt in results):.1f} kJ/kg")
print(f"v range: {min(pt['v'] for pt in results):.6f} to {max(pt['v'] for pt in results):.2f} m³/kg")
print(f"T range: {min(pt['T_C'] for pt in results):.1f} to {max(pt['T_C'] for pt in results):.1f} °C")
print(f"P range: {min(pt['P_MPa'] for pt in results):.4f} to {max(pt['P_MPa'] for pt in results):.2f} MPa")

# Save to JSON
output_path = Path(__file__).parent / 'uv_grid_data_v3.json'
with open(output_path, 'w') as f:
    json.dump({
        'description': 'Water properties sampled at (T, P) grid, indexed by (u, v)',
        'n_points': len(results),
        'generation_method': 'Forward evaluation: (T, P) -> (u, v, ...)',
        'points': results
    }, f, indent=2)

print(f"\nSaved to {output_path}")

# Also create a simpler CSV for easy viewing
csv_path = Path(__file__).parent / 'uv_grid_data_v3.csv'
with open(csv_path, 'w') as f:
    f.write('u_kJ_kg,v_m3_kg,T_C,P_MPa,phase,rho_kg_m3\n')
    for pt in results:
        f.write(f"{pt['u']:.4f},{pt['v']:.8f},{pt['T_C']:.2f},{pt['P_MPa']:.6f},{pt['phase']},{pt['rho']:.4f}\n")

print(f"Saved CSV to {csv_path}")

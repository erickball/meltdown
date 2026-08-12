"""
Verify IAPWS-IF97 equations against steam table data.

For several temperatures:
1. Plot steam table P vs density (rho = 1/v)
2. Calculate IAPWS points at the same (T, P) values
3. Compare v values - do they match?
4. Quantize IAPWS v to same precision as steam table and verify match
"""

import csv
import numpy as np
from iapws import IAPWS97
from pathlib import Path

# Read compressed liquid data from steam table
steam_table_points = []
with open(Path(__file__).parent.parent / 'steam-table.txt', 'r') as f:
    lines = f.readlines()
    for line in lines[1:]:  # Skip header
        parts = line.strip().split('\t')
        if len(parts) < 8:
            continue
        try:
            P_MPa = float(parts[0])
            T_C = float(parts[1])
            v = float(parts[2])
            u = float(parts[3])
            phase = parts[6].lower()
            if phase == 'liquid':
                steam_table_points.append({
                    'P_MPa': P_MPa,
                    'T_C': T_C,
                    'v': v,
                    'u': u,
                    'rho': 1/v
                })
        except ValueError:
            continue

print(f"Loaded {len(steam_table_points)} liquid points from steam table")

# Get unique temperatures
temperatures = sorted(set(p['T_C'] for p in steam_table_points))
print(f"Temperatures in steam table: {temperatures}")

# Pick several temperatures to analyze
test_temps = [20, 100, 200, 300, 350, 360, 370]

print("\n" + "=" * 80)
print("COMPARISON: Steam Table vs IAPWS-IF97")
print("=" * 80)

for T_C in test_temps:
    pts = [p for p in steam_table_points if abs(p['T_C'] - T_C) < 0.5]
    if not pts:
        print(f"\nT = {T_C}C: No steam table data")
        continue

    pts.sort(key=lambda x: x['P_MPa'])

    print(f"\n{'='*80}")
    print(f"T = {T_C}C ({len(pts)} points)")
    print(f"{'='*80}")
    print(f"{'P(MPa)':>10} | {'v_table':>12} | {'v_IAPWS':>12} | {'v_diff':>10} | {'v_diff%':>8} | {'v_quant':>12} | {'Match?':>6}")
    print("-" * 80)

    T_K = T_C + 273.15

    matches = 0
    mismatches = 0
    max_diff_pct = 0

    for p in pts:
        P_MPa = p['P_MPa']
        v_table = p['v']

        # Calculate IAPWS value at same (T, P)
        try:
            water = IAPWS97(T=T_K, P=P_MPa)
            if water.v is None:
                print(f"{P_MPa:10.4f} | {v_table:12.7f} | {'N/A':>12} | {'N/A':>10} | {'N/A':>8} | {'N/A':>12} | {'N/A':>6}")
                continue

            v_iapws = water.v
            v_diff = v_iapws - v_table
            v_diff_pct = abs(v_diff / v_table) * 100
            max_diff_pct = max(max_diff_pct, v_diff_pct)

            # Quantize IAPWS v to same precision as steam table
            # Steam table appears to have 5-7 significant figures
            # Let's try rounding to same decimal places as the table value

            # Count decimal places in table value
            v_str = f"{v_table:.10f}".rstrip('0')
            if '.' in v_str:
                decimals = len(v_str.split('.')[1])
            else:
                decimals = 0

            # Round IAPWS to same precision
            v_quantized = round(v_iapws, decimals)

            match = "YES" if abs(v_quantized - v_table) < 1e-10 else "NO"
            if match == "YES":
                matches += 1
            else:
                mismatches += 1

            print(f"{P_MPa:10.4f} | {v_table:12.7f} | {v_iapws:12.7f} | {v_diff:10.2e} | {v_diff_pct:7.4f}% | {v_quantized:12.7f} | {match:>6}")

        except Exception as e:
            print(f"{P_MPa:10.4f} | {v_table:12.7f} | ERROR: {e}")

    print("-" * 80)
    print(f"Summary: {matches} matches, {mismatches} mismatches, max diff = {max_diff_pct:.4f}%")

# Now let's specifically look at implied bulk modulus comparison
print("\n\n" + "=" * 80)
print("IMPLIED BULK MODULUS COMPARISON")
print("=" * 80)

# Read saturated steam table for v_f values
sat_data = []
with open(Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt', 'r') as f:
    lines = f.readlines()
    for line in lines[1:]:
        parts = line.strip().split('\t')
        if len(parts) < 6:
            continue
        try:
            P_MPa = float(parts[0])
            T_C = float(parts[1])
            v_f = float(parts[2])
            sat_data.append({'P_MPa': P_MPa, 'T_C': T_C, 'v_f': v_f})
        except ValueError:
            continue

sat_data.sort(key=lambda x: x['T_C'])

def get_sat_props(T_C):
    """Get saturation properties from steam table."""
    for i in range(len(sat_data) - 1):
        if sat_data[i]['T_C'] <= T_C < sat_data[i+1]['T_C']:
            t = (T_C - sat_data[i]['T_C']) / (sat_data[i+1]['T_C'] - sat_data[i]['T_C'])
            return {
                'P_sat': sat_data[i]['P_MPa'] + t * (sat_data[i+1]['P_MPa'] - sat_data[i]['P_MPa']),
                'v_f': sat_data[i]['v_f'] + t * (sat_data[i+1]['v_f'] - sat_data[i]['v_f']),
            }
    return None

def get_iapws_sat_props(T_C):
    """Get saturation properties from IAPWS."""
    T_K = T_C + 273.15
    try:
        sat = IAPWS97(T=T_K, x=0)
        return {'P_sat': sat.P, 'v_f': sat.v}
    except:
        return None

print("\nSaturation properties comparison:")
print(f"{'T(C)':>6} | {'P_sat_table':>12} | {'P_sat_IAPWS':>12} | {'v_f_table':>12} | {'v_f_IAPWS':>12}")
print("-" * 70)

for T_C in test_temps:
    sat_table = get_sat_props(T_C)
    sat_iapws = get_iapws_sat_props(T_C)

    if sat_table and sat_iapws:
        print(f"{T_C:6.0f} | {sat_table['P_sat']:12.6f} | {sat_iapws['P_sat']:12.6f} | {sat_table['v_f']:12.7f} | {sat_iapws['v_f']:12.7f}")

print("\n\nImplied K comparison at specific points:")
print(f"{'T(C)':>6} | {'P(MPa)':>8} | {'K_table':>10} | {'K_IAPWS':>10} | {'K_diff%':>10}")
print("-" * 60)

for T_C in [20, 100, 200, 300, 350]:
    pts = [p for p in steam_table_points if abs(p['T_C'] - T_C) < 0.5]
    if not pts:
        continue

    sat_table = get_sat_props(T_C)
    sat_iapws = get_iapws_sat_props(T_C)

    if not sat_table or not sat_iapws:
        continue

    T_K = T_C + 273.15

    # Pick a few pressure points
    for p in pts[::max(1, len(pts)//5)]:  # Every ~5th point
        P_MPa = p['P_MPa']
        v_table = p['v']

        # Skip if at or below saturation
        if P_MPa <= sat_table['P_sat'] * 1.01:
            continue

        # Calculate K from steam table
        dv_table = sat_table['v_f'] - v_table
        if dv_table <= 0:
            continue
        compression_table = dv_table / sat_table['v_f']
        K_table = (P_MPa - sat_table['P_sat']) / compression_table / 1000  # GPa

        # Calculate K from IAPWS
        try:
            water = IAPWS97(T=T_K, P=P_MPa)
            if water.v is None:
                continue
            v_iapws = water.v

            dv_iapws = sat_iapws['v_f'] - v_iapws
            if dv_iapws <= 0:
                continue
            compression_iapws = dv_iapws / sat_iapws['v_f']
            K_iapws = (P_MPa - sat_iapws['P_sat']) / compression_iapws / 1000  # GPa

            K_diff_pct = (K_iapws - K_table) / K_table * 100

            print(f"{T_C:6.0f} | {P_MPa:8.2f} | {K_table:10.4f} | {K_iapws:10.4f} | {K_diff_pct:+10.2f}%")

        except Exception as e:
            continue

print("\n\nDone!")

"""
Verify that IAPWS-IF97 reproduces the saturation steam table data.

This is a critical sanity check - if IAPWS doesn't match the saturation table,
we have a fundamental problem with either the data or the IAPWS library.
"""

import csv
from iapws import IAPWS97
from pathlib import Path

# Read the saturation steam table
sat_table = []
with open(Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt', 'r') as f:
    lines = f.readlines()
    header = lines[0].strip().split('\t')
    print(f"Header: {header}")

    for line in lines[1:]:
        parts = line.strip().split('\t')
        if len(parts) < 6:
            continue
        try:
            sat_table.append({
                'P_MPa': float(parts[0]),
                'T_C': float(parts[1]),
                'v_f': float(parts[2]),  # VL (liquid specific volume)
                'v_g': float(parts[3]),  # VV (vapor specific volume)
                'u_f': float(parts[4]),  # UL (liquid internal energy)
                'u_g': float(parts[5]),  # UV (vapor internal energy)
            })
        except (ValueError, IndexError):
            continue

print(f"Loaded {len(sat_table)} saturation points from steam table")

# Check IAPWS vs steam table for ALL saturation points
print("\n" + "=" * 100)
print("SATURATION DATA COMPARISON: Steam Table vs IAPWS-IF97")
print("=" * 100)

print(f"\n{'T(C)':>8} | {'P_table':>10} | {'P_IAPWS':>10} | {'P_diff%':>8} | "
      f"{'v_f_table':>12} | {'v_f_IAPWS':>12} | {'v_f_diff%':>9} | "
      f"{'v_g_table':>12} | {'v_g_IAPWS':>12} | {'v_g_diff%':>9}")
print("-" * 120)

large_diffs = []

for pt in sat_table:
    T_C = pt['T_C']
    T_K = T_C + 273.15

    # Get IAPWS saturation properties at this temperature
    try:
        sat_liq = IAPWS97(T=T_K, x=0)  # Saturated liquid
        sat_vap = IAPWS97(T=T_K, x=1)  # Saturated vapor

        if sat_liq.P is None or sat_liq.v is None:
            print(f"{T_C:8.2f} | IAPWS returned None for liquid")
            continue
        if sat_vap.v is None:
            print(f"{T_C:8.2f} | IAPWS returned None for vapor")
            continue

        P_iapws = sat_liq.P
        v_f_iapws = sat_liq.v
        v_g_iapws = sat_vap.v

        # Calculate differences
        P_diff_pct = (P_iapws - pt['P_MPa']) / pt['P_MPa'] * 100
        v_f_diff_pct = (v_f_iapws - pt['v_f']) / pt['v_f'] * 100
        v_g_diff_pct = (v_g_iapws - pt['v_g']) / pt['v_g'] * 100

        # Flag large differences
        if abs(v_f_diff_pct) > 0.1 or abs(v_g_diff_pct) > 0.1 or abs(P_diff_pct) > 0.1:
            flag = " <-- LARGE"
            large_diffs.append({
                'T_C': T_C,
                'P_diff': P_diff_pct,
                'v_f_diff': v_f_diff_pct,
                'v_g_diff': v_g_diff_pct
            })
        else:
            flag = ""

        print(f"{T_C:8.2f} | {pt['P_MPa']:10.6f} | {P_iapws:10.6f} | {P_diff_pct:+7.4f}% | "
              f"{pt['v_f']:12.7f} | {v_f_iapws:12.7f} | {v_f_diff_pct:+8.4f}% | "
              f"{pt['v_g']:12.5f} | {v_g_iapws:12.5f} | {v_g_diff_pct:+8.4f}%{flag}")

    except Exception as e:
        print(f"{T_C:8.2f} | ERROR: {e}")

print("\n" + "=" * 100)
print(f"Found {len(large_diffs)} points with >0.1% difference")

if large_diffs:
    print("\nLarge differences summary:")
    for d in large_diffs:
        print(f"  T={d['T_C']:.1f}C: P diff={d['P_diff']:+.4f}%, v_f diff={d['v_f_diff']:+.4f}%, v_g diff={d['v_g_diff']:+.4f}%")

# Now specifically look at high temperatures near critical point
print("\n" + "=" * 100)
print("DETAILED VIEW: Near Critical Point (T > 340C)")
print("Critical point: T_c = 373.946 C, P_c = 22.064 MPa")
print("=" * 100)

for pt in sat_table:
    if pt['T_C'] < 340:
        continue

    T_C = pt['T_C']
    T_K = T_C + 273.15

    try:
        sat_liq = IAPWS97(T=T_K, x=0)
        sat_vap = IAPWS97(T=T_K, x=1)

        print(f"\nT = {T_C} C:")
        print(f"  Steam table:  P = {pt['P_MPa']:.6f} MPa, v_f = {pt['v_f']:.7f} m3/kg, v_g = {pt['v_g']:.6f} m3/kg")
        print(f"  IAPWS-IF97:   P = {sat_liq.P:.6f} MPa, v_f = {sat_liq.v:.7f} m3/kg, v_g = {sat_vap.v:.6f} m3/kg")
        print(f"  Difference:   P = {(sat_liq.P - pt['P_MPa'])/pt['P_MPa']*100:+.4f}%, "
              f"v_f = {(sat_liq.v - pt['v_f'])/pt['v_f']*100:+.4f}%, "
              f"v_g = {(sat_vap.v - pt['v_g'])/pt['v_g']*100:+.4f}%")

        # Also check: what's the ratio v_g/v_f? This should approach 1 at critical point
        print(f"  v_g/v_f ratio: table = {pt['v_g']/pt['v_f']:.2f}, IAPWS = {sat_vap.v/sat_liq.v:.2f}")

    except Exception as e:
        print(f"\nT = {T_C} C: ERROR - {e}")

# Check if steam table might be using a different standard
print("\n" + "=" * 100)
print("CHECKING: What standard does the steam table use?")
print("=" * 100)

# Compare at a well-known reference point: triple point and 100C
print("\nTriple point (T = 0.01 C):")
try:
    triple = IAPWS97(T=273.16, x=0)
    print(f"  IAPWS: P = {triple.P*1000:.4f} kPa, v_f = {triple.v:.8f} m3/kg")
except:
    print("  IAPWS: Could not calculate")

# Find closest in table
closest = min(sat_table, key=lambda x: abs(x['T_C'] - 0.01))
print(f"  Table (T={closest['T_C']}C): P = {closest['P_MPa']*1000:.4f} kPa, v_f = {closest['v_f']:.8f} m3/kg")

print("\nBoiling point (T = 100 C):")
try:
    boiling = IAPWS97(T=373.15, x=0)
    print(f"  IAPWS: P = {boiling.P:.6f} MPa, v_f = {boiling.v:.7f} m3/kg")
except:
    print("  IAPWS: Could not calculate")

closest = min(sat_table, key=lambda x: abs(x['T_C'] - 100))
print(f"  Table (T={closest['T_C']}C): P = {closest['P_MPa']:.6f} MPa, v_f = {closest['v_f']:.7f} m3/kg")

# Check critical point specifically
print("\nCritical point comparison:")
print("  IAPWS-IF97 critical point: T_c = 647.096 K (373.946 C), P_c = 22.064 MPa")
try:
    # Get properties very close to critical
    near_crit = IAPWS97(T=647.0, x=0)
    print(f"  IAPWS at T=646.9K: P = {near_crit.P:.4f} MPa, v = {near_crit.v:.6f} m3/kg")
except Exception as e:
    print(f"  IAPWS at T=647K: {e}")

# Find highest T in table
max_T_pt = max(sat_table, key=lambda x: x['T_C'])
print(f"  Highest T in steam table: {max_T_pt['T_C']} C, P = {max_T_pt['P_MPa']:.4f} MPa")

"""
Try to identify the source of the steam table by comparing against different standards.

IAPWS-IF97 (1997) - Industrial formulation, used in most modern tables
IAPWS-95 - Scientific formulation, more accurate but slower
IFC-67 (1967) - Older industrial formulation, used in older textbooks

The iapws library supports both IF97 and IAPWS95.
"""

from iapws import IAPWS97, IAPWS95
from pathlib import Path

# Read a few points from our steam table
print("Comparing steam table values against different IAPWS formulations")
print("=" * 100)

# Test points at various temperatures
test_points = [
    # T_C, P_MPa, v_f from our saturation table
    (0.01, 0.000612, 0.0010000),
    (20.0, 0.002339, 0.0010018),  # Interpolated
    (100.0, 0.101418, 0.0010435),
    (200.0, 1.5547, 0.0011565),
    (300.0, 8.5877, 0.0014042),
    (350.0, 16.529, 0.0017401),
    (370.0, 21.043, 0.0022221),
]

print(f"\n{'T(C)':>8} | {'P_table':>10} | {'P_IF97':>10} | {'P_95':>10} | "
      f"{'v_f_table':>12} | {'v_f_IF97':>12} | {'v_f_95':>12}")
print("-" * 100)

for T_C, P_table, v_f_table in test_points:
    T_K = T_C + 273.15

    try:
        # IAPWS-IF97 (industrial)
        sat_if97 = IAPWS97(T=T_K, x=0)
        P_if97 = sat_if97.P if sat_if97.P else float('nan')
        v_f_if97 = sat_if97.v if sat_if97.v else float('nan')
    except:
        P_if97 = float('nan')
        v_f_if97 = float('nan')

    try:
        # IAPWS-95 (scientific)
        sat_95 = IAPWS95(T=T_K, x=0)
        P_95 = sat_95.P if sat_95.P else float('nan')
        v_f_95 = sat_95.v if sat_95.v else float('nan')
    except:
        P_95 = float('nan')
        v_f_95 = float('nan')

    print(f"{T_C:8.2f} | {P_table:10.6f} | {P_if97:10.6f} | {P_95:10.6f} | "
          f"{v_f_table:12.7f} | {v_f_if97:12.7f} | {v_f_95:12.7f}")

# Now check the differences more precisely
print("\n\nDifferences from steam table (in %):")
print("=" * 80)
print(f"{'T(C)':>8} | {'P_diff_IF97':>12} | {'P_diff_95':>12} | "
      f"{'v_f_diff_IF97':>14} | {'v_f_diff_95':>14}")
print("-" * 80)

for T_C, P_table, v_f_table in test_points:
    T_K = T_C + 273.15

    try:
        sat_if97 = IAPWS97(T=T_K, x=0)
        P_if97 = sat_if97.P
        v_f_if97 = sat_if97.v
        P_diff_if97 = (P_if97 - P_table) / P_table * 100 if P_table > 0 else 0
        v_f_diff_if97 = (v_f_if97 - v_f_table) / v_f_table * 100
    except:
        P_diff_if97 = float('nan')
        v_f_diff_if97 = float('nan')

    try:
        sat_95 = IAPWS95(T=T_K, x=0)
        P_95 = sat_95.P
        v_f_95 = sat_95.v
        P_diff_95 = (P_95 - P_table) / P_table * 100 if P_table > 0 else 0
        v_f_diff_95 = (v_f_95 - v_f_table) / v_f_table * 100
    except:
        P_diff_95 = float('nan')
        v_f_diff_95 = float('nan')

    print(f"{T_C:8.2f} | {P_diff_if97:+11.6f}% | {P_diff_95:+11.6f}% | "
          f"{v_f_diff_if97:+13.6f}% | {v_f_diff_95:+13.6f}%")

# Check: what precision does the steam table use?
print("\n\nSteam table precision analysis:")
print("=" * 60)

# Read actual values from the table
sat_table = []
with open(Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt', 'r') as f:
    for line in f.readlines()[1:]:
        parts = line.strip().split('\t')
        if len(parts) >= 4:
            try:
                sat_table.append({
                    'P': parts[0],
                    'T': parts[1],
                    'v_f': parts[2],
                    'v_g': parts[3],
                })
            except:
                pass

# Look at the precision of a few entries
print("\nSample entries (raw strings):")
for pt in sat_table[:5] + sat_table[100:105] + sat_table[-5:]:
    print(f"  P={pt['P']:>12}, T={pt['T']:>8}, v_f={pt['v_f']:>12}, v_g={pt['v_g']:>12}")

# Check if IAPWS-95 matches better
print("\n\nDirect comparison at T=100C:")
T_K = 373.15

if97 = IAPWS97(T=T_K, x=0)
i95 = IAPWS95(T=T_K, x=0)

print(f"  IAPWS-IF97: P = {if97.P:.10f} MPa, v_f = {if97.v:.10f} m3/kg")
print(f"  IAPWS-95:   P = {i95.P:.10f} MPa, v_f = {i95.v:.10f} m3/kg")
print(f"  Steam table: P = 0.101418 MPa (interpolated), v_f = 0.0010435 m3/kg")

# Check rounding
print(f"\n  IF97 v_f rounded to 7 decimals: {round(if97.v, 7)}")
print(f"  IF95 v_f rounded to 7 decimals: {round(i95.v, 7)}")

"""
Check if the steam table values are simply rounded IAPWS-IF97 values.
"""

from iapws import IAPWS97
from pathlib import Path

# Read the EXACT values from the steam table
sat_table = []
with open(Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt', 'r') as f:
    for line in f.readlines()[1:]:
        parts = line.strip().split('\t')
        if len(parts) >= 4:
            try:
                sat_table.append({
                    'P_MPa': float(parts[0]),
                    'T_C': float(parts[1]),
                    'v_f': float(parts[2]),
                    'v_g': float(parts[3]),
                })
            except:
                pass

print("Checking if steam table = rounded IAPWS-IF97")
print("=" * 100)

# For each table entry, compute IAPWS-IF97 at the EXACT temperature given,
# then check if rounding to the table's precision gives an exact match

matches = 0
mismatches = []

for pt in sat_table:
    T_K = pt['T_C'] + 273.15

    try:
        sat = IAPWS97(T=T_K, x=0)
        sat_v = IAPWS97(T=T_K, x=1)
    except:
        continue

    if sat.P is None or sat.v is None or sat_v.v is None:
        continue

    # Determine the precision of each table value
    # by counting significant figures after decimal point
    P_str = f"{pt['P_MPa']}"
    v_f_str = f"{pt['v_f']}"
    v_g_str = f"{pt['v_g']}"

    # Round IAPWS values to match table precision
    # The table uses variable precision, so we need to match formats

    # For P: round to same number of decimal places
    if '.' in P_str:
        P_decimals = len(P_str.split('.')[1].rstrip('0')) if '.' in P_str else 0
    else:
        P_decimals = 0

    # For v_f and v_g: they seem to use 4 sig figs typically
    # Let's just check if they match when rounded to the table's displayed precision

    P_iapws_rounded = round(sat.P, max(P_decimals, 4))
    P_table_check = round(pt['P_MPa'], max(P_decimals, 4))

    # For v, count decimals shown
    if '.' in v_f_str:
        v_f_decimals = len(v_f_str.split('.')[1])
    else:
        v_f_decimals = 0

    v_f_iapws_rounded = round(sat.v, v_f_decimals)
    v_f_table_check = round(pt['v_f'], v_f_decimals)

    v_g_iapws_rounded = round(sat_v.v, 4)
    v_g_table_check = round(pt['v_g'], 4)

    # Check if they match
    P_match = abs(P_iapws_rounded - P_table_check) < 1e-10
    v_f_match = abs(v_f_iapws_rounded - v_f_table_check) < 1e-10
    v_g_match = abs(v_g_iapws_rounded - v_g_table_check) < 1e-8

    if P_match and v_f_match and v_g_match:
        matches += 1
    else:
        mismatches.append({
            'T_C': pt['T_C'],
            'P_table': pt['P_MPa'],
            'P_iapws': sat.P,
            'P_match': P_match,
            'v_f_table': pt['v_f'],
            'v_f_iapws': sat.v,
            'v_f_match': v_f_match,
            'v_g_table': pt['v_g'],
            'v_g_iapws': sat_v.v,
            'v_g_match': v_g_match,
        })

print(f"\nTotal entries: {len(sat_table)}")
print(f"Matches: {matches}")
print(f"Mismatches: {len(mismatches)}")

if mismatches:
    print(f"\nShowing first 20 mismatches:")
    print("-" * 100)
    for m in mismatches[:20]:
        print(f"T={m['T_C']:.2f}C:")
        if not m['P_match']:
            print(f"  P: table={m['P_table']}, IAPWS={m['P_iapws']:.6f}")
        if not m['v_f_match']:
            print(f"  v_f: table={m['v_f_table']}, IAPWS={m['v_f_iapws']:.7f}")
        if not m['v_g_match']:
            print(f"  v_g: table={m['v_g_table']}, IAPWS={m['v_g_iapws']:.6f}")

# Now check: are the mismatches just off-by-one in the last digit?
print("\n\nAnalyzing mismatch patterns:")
print("=" * 60)

off_by_one = 0
larger_diff = 0

for m in mismatches:
    # Check v_f difference
    v_f_diff = abs(m['v_f_iapws'] - m['v_f_table'])
    # What's the last-digit precision?
    v_f_str = f"{m['v_f_table']}"
    if '.' in v_f_str:
        last_digit_value = 10 ** (-len(v_f_str.split('.')[1]))
    else:
        last_digit_value = 1

    if v_f_diff <= last_digit_value * 1.1:  # Allow for rounding
        off_by_one += 1
    else:
        larger_diff += 1
        if larger_diff <= 5:
            print(f"  T={m['T_C']:.1f}C: v_f diff = {v_f_diff:.2e}, last digit = {last_digit_value:.0e}")

print(f"\nOff by ~1 in last digit: {off_by_one}")
print(f"Larger differences: {larger_diff}")

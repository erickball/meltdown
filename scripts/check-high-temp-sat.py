"""
Check IAPWS vs steam table at high temperatures (360-374 C)
"""

from iapws import IAPWS97

# Data from steam table at high temperatures
steam_table = [
    {'T_C': 359.7, 'P_MPa': 18.6, 'v_f': 0.001890, 'v_g': 0.007003},
    {'T_C': 360.6, 'P_MPa': 18.8, 'v_f': 0.001908, 'v_g': 0.006840},
    {'T_C': 361.5, 'P_MPa': 19.0, 'v_f': 0.001927, 'v_g': 0.006677},
    {'T_C': 365.7, 'P_MPa': 20.0, 'v_f': 0.002040, 'v_g': 0.005865},
    {'T_C': 369.8, 'P_MPa': 21.0, 'v_f': 0.002206, 'v_g': 0.004996},
    {'T_C': 372.2, 'P_MPa': 21.6, 'v_f': 0.002388, 'v_g': 0.004351},
    {'T_C': 373.7, 'P_MPa': 22.0, 'v_f': 0.002704, 'v_g': 0.003648},
    {'T_C': 373.9, 'P_MPa': 22.06, 'v_f': 0.003106, 'v_g': 0.003106},  # Critical point
]

print("High-temperature saturation comparison")
print("=" * 100)
print(f"{'T(C)':>8} | {'P_table':>8} | {'P_IAPWS':>8} | {'P_diff%':>8} | "
      f"{'v_f_table':>10} | {'v_f_IAPWS':>10} | {'v_f_diff%':>9} | "
      f"{'v_g_table':>10} | {'v_g_IAPWS':>10} | {'v_g_diff%':>9}")
print("-" * 100)

for pt in steam_table:
    T_K = pt['T_C'] + 273.15

    try:
        sat_liq = IAPWS97(T=T_K, x=0)
        sat_vap = IAPWS97(T=T_K, x=1)

        if sat_liq.P is None or sat_liq.v is None or sat_vap.v is None:
            print(f"{pt['T_C']:8.1f} | IAPWS returned None")
            continue

        P_diff = (sat_liq.P - pt['P_MPa']) / pt['P_MPa'] * 100
        v_f_diff = (sat_liq.v - pt['v_f']) / pt['v_f'] * 100
        v_g_diff = (sat_vap.v - pt['v_g']) / pt['v_g'] * 100

        print(f"{pt['T_C']:8.1f} | {pt['P_MPa']:8.2f} | {sat_liq.P:8.4f} | {P_diff:+7.3f}% | "
              f"{pt['v_f']:10.6f} | {sat_liq.v:10.6f} | {v_f_diff:+8.4f}% | "
              f"{pt['v_g']:10.6f} | {sat_vap.v:10.6f} | {v_g_diff:+8.4f}%")

    except Exception as e:
        print(f"{pt['T_C']:8.1f} | ERROR: {e}")

print("\n" + "=" * 100)
print("IAPWS-IF97 critical point constants:")
print("  T_c = 647.096 K = 373.946 C")
print("  P_c = 22.064 MPa")
print("  rho_c = 322 kg/m3 (v_c = 0.003106 m3/kg)")

# Also check: what happens if we use P as the input instead of T?
print("\n" + "=" * 100)
print("Alternative: Using P as input instead of T")
print("=" * 100)

for pt in steam_table:
    P_MPa = pt['P_MPa']

    try:
        sat_liq = IAPWS97(P=P_MPa, x=0)
        sat_vap = IAPWS97(P=P_MPa, x=1)

        if sat_liq.T is None or sat_liq.v is None:
            print(f"P={P_MPa:5.2f} MPa | IAPWS returned None")
            continue

        T_iapws = sat_liq.T - 273.15
        T_diff = T_iapws - pt['T_C']
        v_f_diff = (sat_liq.v - pt['v_f']) / pt['v_f'] * 100
        v_g_diff = (sat_vap.v - pt['v_g']) / pt['v_g'] * 100

        print(f"P={P_MPa:5.2f} MPa | T_table={pt['T_C']:6.1f} | T_IAPWS={T_iapws:6.2f} | T_diff={T_diff:+5.2f}C | "
              f"v_f_diff={v_f_diff:+7.4f}% | v_g_diff={v_g_diff:+7.4f}%")

    except Exception as e:
        print(f"P={P_MPa:5.2f} MPa | ERROR: {e}")

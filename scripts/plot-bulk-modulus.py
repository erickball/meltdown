"""
Analyze steam table data to calculate implied bulk modulus values
and generate plots showing K vs P for each temperature.

Usage:
  python plot-bulk-modulus.py          # Generate CSV and show plots
  python plot-bulk-modulus.py --csv    # Generate CSV only (no plots)
"""

import csv
import sys
import matplotlib.pyplot as plt
import numpy as np
from pathlib import Path

# Check for --csv flag
CSV_ONLY = '--csv' in sys.argv

# Read detailed saturated steam table
sat_data = []
with open(Path(__file__).parent.parent / 'public' / 'saturated-steam-table.txt', 'r') as f:
    lines = f.readlines()
    for line in lines[1:]:  # Skip header
        parts = line.strip().split('\t')
        if len(parts) < 6:
            continue
        try:
            P_MPa = float(parts[0])
            T_C = float(parts[1])
            v_f = float(parts[2])  # VL (m³/kg)
            u_f = float(parts[4])  # UL (kJ/kg)
            sat_data.append({'P_MPa': P_MPa, 'T_C': T_C, 'v_f': v_f, 'u_f': u_f})
        except ValueError:
            continue

# Sort by temperature
sat_data.sort(key=lambda x: x['T_C'])
print(f"Loaded {len(sat_data)} saturation points")

def interpolate_saturation(T_C):
    """Interpolate saturation properties at a given temperature."""
    if T_C <= sat_data[0]['T_C']:
        return sat_data[0]
    if T_C >= sat_data[-1]['T_C']:
        return sat_data[-1]

    # Binary search
    lo, hi = 0, len(sat_data) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if sat_data[mid]['T_C'] <= T_C:
            lo = mid
        else:
            hi = mid

    # Linear interpolation
    p1, p2 = sat_data[lo], sat_data[hi]
    t = (T_C - p1['T_C']) / (p2['T_C'] - p1['T_C'])
    return {
        'P_MPa': p1['P_MPa'] + t * (p2['P_MPa'] - p1['P_MPa']),
        'T_C': T_C,
        'v_f': p1['v_f'] + t * (p2['v_f'] - p1['v_f']),
        'u_f': p1['u_f'] + t * (p2['u_f'] - p1['u_f']),
    }

# Read compressed liquid data (all temperatures up to 250°C)
liquid_points = []
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
            if phase == 'liquid' and T_C <= 375:
                liquid_points.append({'P_MPa': P_MPa, 'T_C': T_C, 'v': v, 'u': u})
        except ValueError:
            continue

print(f"Found {len(liquid_points)} compressed liquid points up to 375°C")

# Calculate implied bulk modulus for each point
results = []
for pt in liquid_points:
    sat = interpolate_saturation(pt['T_C'])

    # Skip if at or below saturation
    if pt['P_MPa'] <= sat['P_MPa'] * 1.01:
        continue

    # Calculate compression
    dv = sat['v_f'] - pt['v']
    if dv <= 1e-8:
        continue

    compression_ratio = dv / sat['v_f']
    dP_MPa = pt['P_MPa'] - sat['P_MPa']
    K_implied_GPa = dP_MPa / compression_ratio / 1000

    results.append({
        'T_C': pt['T_C'],
        'P_MPa': pt['P_MPa'],
        'P_sat_MPa': sat['P_MPa'],
        'v': pt['v'],
        'v_f': sat['v_f'],
        'compression_ratio': compression_ratio,
        'K_implied_GPa': K_implied_GPa,
    })

print(f"Calculated {len(results)} implied bulk modulus values")

# Export to CSV
csv_path = Path(__file__).parent / 'bulk_modulus_data.csv'
with open(csv_path, 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['T_C', 'P_MPa', 'P_sat_MPa', 'v_m3_kg', 'v_f_m3_kg', 'compression_ratio', 'K_implied_GPa'])
    for r in sorted(results, key=lambda x: (x['T_C'], x['P_MPa'])):
        writer.writerow([
            f"{r['T_C']:.2f}",
            f"{r['P_MPa']:.4f}",
            f"{r['P_sat_MPa']:.6f}",
            f"{r['v']:.7f}",
            f"{r['v_f']:.7f}",
            f"{r['compression_ratio']:.6f}",
            f"{r['K_implied_GPa']:.4f}"
        ])
print(f"Exported to {csv_path}")

# Get unique temperatures
temperatures = sorted(set(r['T_C'] for r in results))
print(f"Found {len(temperatures)} unique temperatures")

# Filter to temperatures with enough data points
temps_with_data = []
for T in temperatures:
    pts = [r for r in results if r['T_C'] == T]
    if len(pts) >= 3:
        temps_with_data.append(T)

print(f"Temperatures with >=3 data points: {len(temps_with_data)}")

# Load IAPWS implied bulk modulus quadratic fits
iapws_fits = {}
iapws_fits_path = Path(__file__).parent / 'iapws_bulk_modulus_implied_fits.csv'
if iapws_fits_path.exists():
    with open(iapws_fits_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            T = float(row['T_C'])
            iapws_fits[T] = {
                'a': float(row['a']),
                'b': float(row['b']),
                'c': float(row['c']),
                'P_sat': float(row['P_sat_MPa']),
            }
    print(f"Loaded {len(iapws_fits)} IAPWS implied K quadratic fits")
else:
    print("WARNING: IAPWS fits not found. Run iapws-bulk-modulus-implied.py first.")

def get_iapws_fit(T_C):
    """Get interpolated IAPWS quadratic fit coefficients for a temperature."""
    if not iapws_fits:
        return None

    temps = sorted(iapws_fits.keys())
    if T_C <= temps[0]:
        return iapws_fits[temps[0]]
    if T_C >= temps[-1]:
        return iapws_fits[temps[-1]]

    # Find bracketing temperatures
    for i in range(len(temps) - 1):
        if temps[i] <= T_C < temps[i + 1]:
            T_lo, T_hi = temps[i], temps[i + 1]
            t = (T_C - T_lo) / (T_hi - T_lo)
            fit_lo = iapws_fits[T_lo]
            fit_hi = iapws_fits[T_hi]
            return {
                'a': fit_lo['a'] + t * (fit_hi['a'] - fit_lo['a']),
                'b': fit_lo['b'] + t * (fit_hi['b'] - fit_lo['b']),
                'c': fit_lo['c'] + t * (fit_hi['c'] - fit_lo['c']),
                'P_sat': fit_lo['P_sat'] + t * (fit_hi['P_sat'] - fit_lo['P_sat']),
            }
    return None

if CSV_ONLY:
    print("CSV export complete. Skipping plots (--csv flag).")
    sys.exit(0)

# Interactive plotting - show K vs P for each temperature
plt.ion()  # Interactive mode
fig, ax = plt.subplots(figsize=(10, 7))

for T in temps_with_data:
    pts = [r for r in results if r['T_C'] == T]
    pts.sort(key=lambda x: x['P_MPa'])

    P_arr = np.array([p['P_MPa'] for p in pts])
    K_arr = np.array([p['K_implied_GPa'] for p in pts])
    P_sat = pts[0]['P_sat_MPa']
    v_f = pts[0]['v_f']

    # Get unique v values to show quantization
    v_values = sorted(set(p['v'] for p in pts), reverse=True)

    ax.clear()

    # Color points by their v value to show quantization
    v_to_color = {v: i for i, v in enumerate(v_values)}
    colors = [v_to_color[p['v']] for p in pts]

    scatter = ax.scatter(P_arr, K_arr, c=colors, cmap='tab10', s=50, alpha=0.7,
                          label='Steam table (quantized)')

    # IAPWS-IF97 implied K quadratic fit: K = a + b*P + c*P^2
    iapws_fit = get_iapws_fit(T)
    if iapws_fit:
        a, b, c = iapws_fit['a'], iapws_fit['b'], iapws_fit['c']
        P_fit = np.linspace(max(0.1, P_sat), max(P_arr) * 1.05, 100)
        K_fit = a + b * P_fit + c * P_fit**2
        ax.plot(P_fit, K_fit, 'r-', linewidth=2.5, alpha=0.9,
                label=f'IAPWS-IF97: K = {a:.3f} + {b:.5f}*P + {c:.2e}*P^2')

    ax.set_xlabel('Pressure (MPa)', fontsize=12)
    ax.set_ylabel('Implied Bulk Modulus K (GPa)', fontsize=12)
    ax.set_title(f'K vs P at T = {T:.1f}°C\n'
                 f'P_sat = {P_sat:.4f} MPa, v_f = {v_f:.6f} m³/kg\n'
                 f'{len(pts)} points, {len(v_values)} unique v values (colors)',
                 fontsize=11)

    # Set y limits to show range but not crazy outliers
    K_median = np.median(K_arr)
    ax.set_ylim(0, min(max(K_arr) * 1.1, K_median * 3, 8))
    ax.set_xlim(0, max(P_arr) * 1.05)

    ax.legend(loc='upper right')
    ax.grid(True, alpha=0.3)

    # Add text showing statistics
    iapws_fit = get_iapws_fit(T)
    if iapws_fit:
        K_iapws_at_Pmax = iapws_fit['a'] + iapws_fit['b'] * P_arr.max() + iapws_fit['c'] * P_arr.max()**2
        K_iapws_at_Psat = iapws_fit['a'] + iapws_fit['b'] * P_sat + iapws_fit['c'] * P_sat**2
        stats_text = (f'Steam table scatter:\n'
                      f'  K = {K_arr.min():.3f} - {K_arr.max():.3f} GPa\n'
                      f'  Spread = {(K_arr.max()-K_arr.min())/K_arr.mean()*100:.0f}%\n\n'
                      f'IAPWS-IF97 (true):\n'
                      f'  K@P_sat = {K_iapws_at_Psat:.3f} GPa\n'
                      f'  K@{P_arr.max():.0f}MPa = {K_iapws_at_Pmax:.3f} GPa')
    else:
        stats_text = (f'K_min = {K_arr.min():.3f} GPa\n'
                      f'K_max = {K_arr.max():.3f} GPa\n'
                      f'K_avg = {K_arr.mean():.3f} GPa\n'
                      f'Spread = {(K_arr.max()-K_arr.min())/K_arr.mean()*100:.0f}%')
    ax.text(0.02, 0.98, stats_text, transform=ax.transAxes,
            verticalalignment='top', fontsize=10,
            bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))

    plt.tight_layout()
    plt.draw()
    plt.pause(1.0)  # Pause to see each plot

plt.ioff()
plt.show()

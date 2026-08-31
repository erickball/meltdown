# Pair up two check-liquid-htc.ts captures and print the ratio per connection.
#
# The two captures may not have identical columns (the probe grew a
# natural/forced breakdown), so the total is located structurally: Reynolds is
# the only field in scientific notation, and the total is the column before it.
#
# Usage: python scripts/diff-liquid-h.py before.txt after.txt
import sys, re

def parse(path):
    out, preset = {}, None
    for line in open(path, encoding='utf-8', errors='replace'):
        m = re.match(r'=== (\S+) ', line.strip())
        if m:
            preset = m.group(1)
            continue
        parts = line.split()
        if not parts or not parts[0].startswith('convection-'):
            continue
        sci = [i for i, p in enumerate(parts) if re.fullmatch(r'-?\d\.\de[+-]\d+', p)]
        if not sci:
            continue
        try:
            total = float(parts[sci[0] - 1])
            t_fl = float(parts[1])
        except (ValueError, IndexError):
            continue
        out[(preset, parts[0])] = (total, t_fl)
    return out

before, after = parse(sys.argv[1]), parse(sys.argv[2])
print(f"{'preset':10s} {'connection':34s} {'T_fl(C)':>8s} {'before':>9s} {'after':>9s} {'ratio':>7s}")
print('-' * 82)
ratios = []
for key in before:
    if key not in after:
        continue
    b, tb = before[key]
    a, ta = after[key]
    ratio = a / b if b else float('nan')
    ratios.append(ratio)
    print(f"{key[0]:10s} {key[1][:34]:34s} {ta:8.1f} {b:9.0f} {a:9.0f} {ratio:6.2f}x")
if ratios:
    ratios.sort()
    print(f"\n  median {ratios[len(ratios)//2]:.2f}x, range {ratios[0]:.2f}x - {ratios[-1]:.2f}x")
missing = [k for k in before if k not in after] + [k for k in after if k not in before]
if missing:
    print('\nonly on one side:', missing)

#!/bin/sh
# Regenerates firmware_c_output.json from Betaflight's own simplified_tuning.c.
#   ./generate.sh /path/to/betaflight-firmware
# Reference used: betaflight-firmware 435ac767 (2026.6.2; simplified_tuning.c unchanged since 43875a55a).
set -eu
FW="${1:?path to betaflight-firmware}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
gcc -std=gnu11 -O2 -I"$HERE/stub" -o "$OUT/simplified" "$HERE/driver.c" "$FW/src/main/config/simplified_tuning.c"
"$OUT/simplified" < "$HERE/cases.txt" > "$HERE/firmware_c_output.json"
rm -rf "$OUT"

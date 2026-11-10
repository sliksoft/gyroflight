#!/bin/bash
# One command for the SITL loop-reference test (PROTOCOL.md v1 in the dossier). Simulator only.
#   scripts/sim/reference/run_reference.sh <new output dir> [--only-arm A|B] [--smoke]
# Refuses an existing output directory, a wrong ELF hash, a wrong VliegAI HEAD or GyroFlight scripts that differ from HEAD.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:?output dir}"; shift || true
ONLY_ARM=""; SMOKE=0
while [ $# -gt 0 ]; do case "$1" in --only-arm) ONLY_ARM="$2"; shift 2;; --smoke) SMOKE=1; shift;; *) echo "unknown $1"; exit 2;; esac; done
[ -e "$OUT" ] && { echo "STOP: output_dir_exists:$OUT"; exit 2; }

DOSSIER=$HOME/Gyroflight-audits/autotune-v2-sitl-loop-reference-2026-11-10
VLIEGAI=$HOME/VliegAI/_worktrees/air65-sim-review-20261028
VLIEGAI_HEAD_EXPECTED=20f6af5a7ebd40daacc6a2efe9a7160a1d55e0d7
PY=$HOME/VliegAI/_envs/65mm-vision-foundation/bin/python
ELF=$DOSSIER/build/bf-src/obj/main/betaflight_SITL.elf
ELF_SHA_EXPECTED=6db21d7ece7681d281c82f5702bd1621381caca6396b003d697bedbf101eae13
BF_COMMIT=32c55793589ebc060e65dff2d50dfada5c838782
OVERLAY=$VLIEGAI/configs/control/air65_ctbr_betaflight_oct19_candidate_v2.cfg
RUNTIME_ROOT=/dev/shm/gf_sitl

ELF_SHA=$(sha256sum "$ELF" | cut -d' ' -f1)
[ "$ELF_SHA" = "$ELF_SHA_EXPECTED" ] || { echo "STOP: elf_sha256:$ELF_SHA"; exit 2; }
VH=$(git -C "$VLIEGAI" rev-parse HEAD)
[ "$VH" = "$VLIEGAI_HEAD_EXPECTED" ] || { echo "STOP: vliegai_head:$VH"; exit 2; }
DIRTY=$(git -C "$REPO" status --porcelain -- scripts/sim/reference test/gyrocore/sitl_loop_reference.local.test.ts)
[ -z "$DIRTY" ] || { echo "STOP: reference scripts differ from HEAD:"; echo "$DIRTY"; exit 2; }

mkdir -p "$OUT/runs" "$RUNTIME_ROOT"
{
  echo "{\"startedAt\":\"$(date -u +%FT%TZ)\",\"gyroflightHead\":\"$(git -C "$REPO" rev-parse HEAD)\",\"vliegaiHead\":\"$VH\",\"elfSha256\":\"$ELF_SHA\",\"betaflightCommit\":\"$BF_COMMIT\","
  echo "\"protocolSha256\":\"$(sha256sum "$DOSSIER/PROTOCOL.md" | cut -d' ' -f1)\",\"scripts\":{"
  for f in air65_chirp_sitl.py reference_loop.py compare.py run_reference.sh; do echo "\"$f\":\"$(sha256sum "$HERE/$f" | cut -d' ' -f1)\","; done
  echo "\"test\":\"$(sha256sum "$REPO/test/gyrocore/sitl_loop_reference.local.test.ts" | cut -d' ' -f1)\"},\"argv\":\"$*\"}"
} > "$OUT/provenance.json"

# runs: arm A (ANGLE) 56/45/70 x 3, arm B (ACRO) 56 x 3; chirp start ticks 200/250/300
RUNS=()
add() { RUNS+=("$1|$2|$3|$4|$5|$6|$7"); }  # id arm angle p i d start
i=0
for spec in "A:1:56" "A:1:45" "A:1:70" "B:0:56"; do
  arm=${spec%%:*}; rest=${spec#*:}; angle=${rest%%:*}; p=${rest#*:}
  [ -n "$ONLY_ARM" ] && [ "$arm" != "$ONLY_ARM" ] && continue
  for start in 200 250 300; do
    i=$((i+1)); add "$(printf '%02d' $i)_${arm}_${p}_79_30_s${start}" "$arm" "$angle" "$p" 79 30 "$start"
    [ $SMOKE = 1 ] && break
  done
done
JOBS="["; LIST="["
for r in "${RUNS[@]}"; do
  IFS='|' read -r id arm angle p ii d start <<< "$r"
  dir="$OUT/runs/$id"
  cat > "$OUT/runs/$id.request.json" <<EOF
{"vliegaiRoot":"$VLIEGAI","baseOverlay":"$OVERLAY","elf":"$ELF","elfSha256":"$ELF_SHA_EXPECTED",
 "betaflightCommit":"$BF_COMMIT","betaflightSource":"$DOSSIER/build/bf-src",
 "rollPid":{"p":$p,"i":$ii,"d":$d,"dMax":40},
 "chirpSettings":{"chirp_frequency_start_deci_hz":20,"chirp_frequency_end_deci_hz":1000,"chirp_time_seconds":20,"chirp_amplitude_roll":230,"chirp_lag_freq_hz":3,"chirp_lead_freq_hz":30},
 "totalTicks":2500,"chirpStartTick":$start,"angleMode":$([ "$angle" = 1 ] && echo true || echo false),
 "outDir":"$dir","runtimeRoot":"$RUNTIME_ROOT","label":"$id"}
EOF
  echo "$(date -u +%T) run $id"
  (cd "$VLIEGAI" && CUDA_VISIBLE_DEVICES= "$PY" "$HERE/air65_chirp_sitl.py" "$OUT/runs/$id.request.json" > "$OUT/runs/$id.stderr.log" 2>&1) || echo "  adapter exit $?"
  if [ -f "$dir/case/controller_trace.npz" ]; then
    "$PY" "$HERE/reference_loop.py" "$dir/case/controller_trace.npz" "$dir/reference.json" | sed 's/^/  ref /'
  fi
  if [ -f "$dir/chirp.BFL" ]; then JOBS="$JOBS{\"log\":\"$dir/chirp.BFL\",\"out\":\"$dir/gyroflight.json\"},"; fi
  LIST="$LIST{\"id\":\"$id\",\"arm\":\"$arm\",\"tune\":\"$p/$ii/$d\",\"rep\":\"s$start\",\"dir\":\"$dir\"},"
done
JOBS="${JOBS%,}]"; LIST="${LIST%,}]"
echo "$LIST" > "$OUT/runs.json"
echo "$(date -u +%T) GyroFlight engine on $(echo "$JOBS" | grep -o chirp.BFL | wc -l) logs"
(cd "$REPO" && GYROFLIGHT_REF_JOBS="$JOBS" npx vitest run test/gyrocore/sitl_loop_reference.local.test.ts --maxWorkers=1 > "$OUT/gyroflight_vitest.log" 2>&1) || echo "  vitest exit $? (see gyroflight_vitest.log)"
"$PY" "$HERE/compare.py" "$OUT" "$OUT/runs.json"
echo "done: $OUT/RESULTS.md"

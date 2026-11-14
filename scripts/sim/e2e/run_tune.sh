#!/bin/bash
# End-to-end roll autotune proof in the Betaflight SITL (dossier autotune-v2-sitl-e2e-roll-2026-11-10, PROTOCOL.md):
# records one roll tune N times (ANGLE, Blackbox high resolution ON, CHIRP 2–100 Hz, 20 s) with the reviewed
# loop-reference harness (scripts/sim/reference), measures every run with the independent reference and runs the
# GyroFlight engine on the logs exactly as the app imports them (first log primary, the others as repeats).
#   scripts/sim/e2e/run_tune.sh <new out dir> --tune P/I/D/DMAX [--starts 200,250,300] [--no-gyroflight]
#       [--settings k=v,k=v]   extra `set` lines (filters) appended to the overlay after the roll PID (joint proof, 2026-11-11)
#       [--noise std:seed[:hpHz:order]]  seeded Gaussian gyro noise (deg/s) shaped by `order` RC high-pass stages at hpHz
#       [--gyrounfilt]         log gyroUnfilt (the recipe disables it); needed for the gyro chain model
#       [--sweeps N]           N CHIRP activations per run (block 13): roll, then pitch, …; window k = [s + 2200·k, s + 2200·k + 2100)
#                              outer ticks for the run's start tick s; a reference is written per swept axis (reference.json for
#                              roll, reference_pitch.json for pitch)
#       [--ticks T]            total outer ticks per run (default 2500)
# With --noise the independent noise reference (scripts/sim/reference/noise_metrics.py) is written per run (noise.json).
# Refuses an existing out dir, a wrong ELF hash, a wrong VliegAI HEAD or harness scripts that differ from HEAD.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
REF="$REPO/scripts/sim/reference"
OUT="${1:?output dir}"; shift || true
TUNE=""; STARTS="200,250,300"; GF=1; SETTINGS=""; NOISE=""; GYROUNFILT=0; SWEEPS=1; TICKS=2500
while [ $# -gt 0 ]; do case "$1" in
  --tune) TUNE="$2"; shift 2;; --starts) STARTS="$2"; shift 2;; --no-gyroflight) GF=0; shift;;
  --settings) SETTINGS="$2"; shift 2;; --noise) NOISE="$2"; shift 2;; --gyrounfilt) GYROUNFILT=1; shift;;
  --sweeps) SWEEPS="$2"; shift 2;; --ticks) TICKS="$2"; shift 2;;
  *) echo "unknown $1"; exit 2;; esac; done
# JSON fragments of the optional parts (empty when not given)
SETTINGS_JSON=$(python3 -c "import json,sys; s=sys.argv[1]; print(json.dumps({k: int(v) for k, v in (kv.split('=') for kv in s.split(',') if kv)}))" "$SETTINGS")
NOISE_JSON=$(python3 -c "
import json,sys; s=sys.argv[1]
if not s: print('null'); raise SystemExit
p=s.split(':'); print(json.dumps({'stdDps': float(p[0]), 'seed': int(p[1]), 'highpassHz': float(p[2]) if len(p)>2 else 0, 'highpassOrder': int(p[3]) if len(p)>3 else 0}))" "$NOISE")
GYROUNFILT_JSON=$([ $GYROUNFILT = 1 ] && echo true || echo false)
[ -n "$TUNE" ] || { echo "STOP: --tune P/I/D/DMAX required"; exit 2; }
[ -e "$OUT" ] && { echo "STOP: output_dir_exists:$OUT"; exit 2; }
IFS='/' read -r P I D DMAX <<< "$TUNE"
[ -n "${DMAX:-}" ] || { echo "STOP: tune needs four values P/I/D/DMAX"; exit 2; }

DOSSIER_REF=$HOME/Gyroflight-audits/autotune-v2-sitl-loop-reference-2026-11-10
VLIEGAI=$HOME/VliegAI/_worktrees/air65-sim-review-20261028
VLIEGAI_HEAD_EXPECTED=20f6af5a7ebd40daacc6a2efe9a7160a1d55e0d7
PY=$HOME/VliegAI/_envs/65mm-vision-foundation/bin/python
export PYTHONDONTWRITEBYTECODE=1
ELF=$DOSSIER_REF/build/bf-src/obj/main/betaflight_SITL.elf
ELF_SHA_EXPECTED=6db21d7ece7681d281c82f5702bd1621381caca6396b003d697bedbf101eae13
BF_COMMIT=32c55793589ebc060e65dff2d50dfada5c838782
OVERLAY=$VLIEGAI/configs/control/air65_ctbr_betaflight_oct19_candidate_v2.cfg
RUNTIME_ROOT=/dev/shm/gf_sitl

ELF_SHA=$(sha256sum "$ELF" | cut -d' ' -f1)
[ "$ELF_SHA" = "$ELF_SHA_EXPECTED" ] || { echo "STOP: elf_sha256:$ELF_SHA"; exit 2; }
VH=$(git -C "$VLIEGAI" rev-parse HEAD)
[ "$VH" = "$VLIEGAI_HEAD_EXPECTED" ] || { echo "STOP: vliegai_head:$VH"; exit 2; }
DIRTY=$(git -C "$REPO" status --porcelain -- scripts/sim/reference scripts/sim/e2e test/gyrocore/sitl_loop_reference.local.test.ts)
[ -z "$DIRTY" ] || { echo "STOP: harness scripts differ from HEAD:"; echo "$DIRTY"; exit 2; }
pgrep -f betaflight_SITL.elf > /dev/null && { echo "STOP: a SITL process is already running"; exit 2; }

mkdir -p "$OUT/runs" "$RUNTIME_ROOT"
{
  echo "{\"startedAt\":\"$(date -u +%FT%TZ)\",\"gyroflightHead\":\"$(git -C "$REPO" rev-parse HEAD)\",\"vliegaiHead\":\"$VH\",\"elfSha256\":\"$ELF_SHA\",\"betaflightCommit\":\"$BF_COMMIT\","
  echo "\"tune\":{\"p\":$P,\"i\":$I,\"d\":$D,\"dMax\":$DMAX},\"starts\":[$STARTS],\"highResolution\":true,\"angleMode\":true,"
  echo "\"settings\":$SETTINGS_JSON,\"gyroNoise\":$NOISE_JSON,\"logGyroUnfilt\":$GYROUNFILT_JSON,\"sweeps\":$SWEEPS,\"totalTicks\":$TICKS,\"scripts\":{"
  for f in air65_chirp_sitl.py reference_loop.py noise_metrics.py; do echo "\"reference/$f\":\"$(sha256sum "$REF/$f" | cut -d' ' -f1)\","; done
  for f in run_tune.sh summarize_tune.py; do echo "\"e2e/$f\":\"$(sha256sum "$HERE/$f" | cut -d' ' -f1)\","; done
  echo "\"test\":\"$(sha256sum "$REPO/test/gyrocore/sitl_loop_reference.local.test.ts" | cut -d' ' -f1)\"}}"
} > "$OUT/provenance.json"

n=0; LOGS=(); LIST="["
IFS=',' read -ra START_LIST <<< "$STARTS"
for start in "${START_LIST[@]}"; do
  n=$((n+1)); id="$(printf '%02d' $n)_${P}_${I}_${D}_${DMAX}_s${start}"; dir="$OUT/runs/$id"
  WINDOWS=$(python3 -c "import json,sys; s,n=int(sys.argv[1]),int(sys.argv[2]); print(json.dumps([[s+2200*k, s+2200*k+2100] for k in range(n)]) if n>1 else 'null')" "$start" "$SWEEPS")
  cat > "$OUT/runs/$id.request.json" <<EOR
{"vliegaiRoot":"$VLIEGAI","baseOverlay":"$OVERLAY","elf":"$ELF","elfSha256":"$ELF_SHA_EXPECTED",
 "betaflightCommit":"$BF_COMMIT","betaflightSource":"$DOSSIER_REF/build/bf-src",
 "rollPid":{"p":$P,"i":$I,"d":$D,"dMax":$DMAX},
 "chirpSettings":{"chirp_frequency_start_deci_hz":20,"chirp_frequency_end_deci_hz":1000,"chirp_time_seconds":20,"chirp_amplitude_roll":230,"chirp_lag_freq_hz":3,"chirp_lead_freq_hz":30},
 "totalTicks":$TICKS,"chirpStartTick":$start,"chirpWindows":$WINDOWS,"angleMode":true,"highResolution":true,
 "settings":$SETTINGS_JSON,"gyroNoise":$NOISE_JSON,"logGyroUnfilt":$GYROUNFILT_JSON,
 "outDir":"$dir","runtimeRoot":"$RUNTIME_ROOT","label":"$id"}
EOR
  echo "$(date -u +%T) run $id"
  (cd "$VLIEGAI" && CUDA_VISIBLE_DEVICES= "$PY" "$REF/air65_chirp_sitl.py" "$OUT/runs/$id.request.json" > "$OUT/runs/$id.stderr.log" 2>&1) || echo "  adapter exit $?"
  if [ -f "$dir/case/controller_trace.npz" ]; then
    "$PY" "$REF/reference_loop.py" "$dir/case/controller_trace.npz" "$dir/reference.json" --scale 0.1 | sed 's/^/  ref /'
    [ "$SWEEPS" -ge 2 ] && "$PY" "$REF/reference_loop.py" "$dir/case/controller_trace.npz" "$dir/reference_pitch.json" --scale 0.1 --axis 1 | sed 's/^/  ref pitch /'
    "$PY" "$REF/noise_metrics.py" "$dir/case/controller_trace.npz" "$dir/noise.json" | sed 's/^/  noise /'
  fi
  [ -f "$dir/chirp.BFL" ] && LOGS+=("$dir/chirp.BFL")
  LIST="$LIST{\"id\":\"$id\",\"tune\":\"$P/$I/$D/$DMAX\",\"start\":$start,\"dir\":\"$dir\"},"
done
echo "${LIST%,}]" > "$OUT/runs.json"

if [ $GF = 1 ] && [ ${#LOGS[@]} -gt 0 ]; then
  JOBS="["
  for l in "${LOGS[@]}"; do JOBS="$JOBS{\"log\":\"$l\",\"out\":\"$(dirname "$l")/gyroflight.json\"},"; done
  if [ ${#LOGS[@]} -gt 1 ]; then
    OTHERS=$(printf '"%s",' "${LOGS[@]:1}"); OTHERS="[${OTHERS%,}]"
    JOBS="$JOBS{\"log\":\"${LOGS[0]}\",\"others\":$OTHERS,\"out\":\"$OUT/gyroflight.combined.json\"},"
  fi
  JOBS="${JOBS%,}]"
  echo "$(date -u +%T) GyroFlight engine on ${#LOGS[@]} logs (+ combined)"
  (cd "$REPO" && GYROFLIGHT_REF_HEAD="$(git rev-parse HEAD)" GYROFLIGHT_REF_JOBS="$JOBS" npx vitest run test/gyrocore/sitl_loop_reference.local.test.ts --maxWorkers=1 > "$OUT/gyroflight_vitest.log" 2>&1) || echo "  vitest exit $? (see gyroflight_vitest.log)"
fi
"$PY" "$HERE/summarize_tune.py" "$OUT"
echo "done: $OUT/summary.json"

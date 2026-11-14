#!/bin/bash
# The restore paths on the real SITL bench (pilot seed 4, start tune A; outside the proof of block 14).
#   scripts/sim/session/run_restore_paths.sh <out dir> [path ...]     (no path named: all of them, in this order)
# Paths (each a fresh bench and session dir):
#   P0 end_verified          budget right after the start measurement; the end read equals the accepted tune → finish
#   P1 end_mismatch          the same, with end_flash_drift: the SITL holds pitch P+1 at the end read → abort, restore, read back
#   P3 stop_after_accept     Stop during step 2 run 2 (after an ACCEPT) → verified restore closes the bench session
#   P4 drop_after_accept     the page closes during step 2 run 2 (after an ACCEPT) → restore on the lost connection
#   H1 retry_after_stop      Stop during step 1 run 2 with restore_fail_first:1 → attempt 1 fails, attempt 2 reads the
#                            accepted tune back, on the same connection → aborted, finish
#   H1b retry_after_restore  restore-test-1 (step 1 roll D ×1.6, decided RESTORE) with restore_fail_first:1 → the app's
#                            restore: attempt 1 fails, attempt 2 exact; only then the session goes on
#   H2 unconfirmed           Stop during step 1 run 2 with restore_fail_always → three failed attempts, restore_unconfirmed,
#                            no finish; the bench refuses setTune / measure / commitAccepted (probe over the same
#                            connection); the page then closes → three more failed attempts on the lost connection
# (P2, restore_fail_once without retries, was replaced by H1/H2 when the bench got its bounded retries.)
# After each path: the bench is stopped and a separate process reads the flash over MSP (independent_read).
# Then restore_paths_report.py writes paths.json / PATHS.md.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${1:?out dir}"
TUNE_A='{"roll":{"p":100,"i":79,"d":30,"dMax":40},"pitch":{"p":82,"i":117,"d":61,"dMax":0},"yaw":{"p":56,"i":79,"d":0,"dMax":0}}'
export PYTHONDONTWRITEBYTECODE=1
mkdir -p "$OUT"
pgrep -f "betaflight_SITL.elf --ip" > /dev/null && { echo "STOP: a SITL process is already running"; exit 2; }
ls /dev/shm/gf_sitl 2>/dev/null | grep -q . && { echo "STOP: /dev/shm/gf_sitl is not empty (stale runtime dir)"; exit 2; }
git -C "$REPO" rev-parse HEAD > "$OUT/head.txt"
git -C "$REPO" status --porcelain -- scripts/sim/session src/gyrocore/sitlSession src/composables/useSitlSession.ts > "$OUT/dirty.txt"
(cd "$REPO" && setsid nohup npx vite --port 5199 --strictPort > "$OUT/vite.log" 2>&1 &)
for _ in $(seq 1 120); do ss -ltn | grep -q ':5199 ' && break; sleep 1; done; sleep 3
run_path() {
  local id="$1" inject="$2" uiargs="$3"
  local S="$OUT/$id"; mkdir -p "$S"
  echo '{"id":"base_filters","fixedSettings":{},"scripts":{"end-now":{"steps":[],"maxTrialSteps":0},"restore-test-1":{"steps":[{"step":1,"axis":"roll","dScale":1.6}],"maxTrialSteps":2}}}' > "$S/scenario.json"
  echo "$TUNE_A" > "$S/start_tune.json"
  local INJ=(); for f in $inject; do INJ+=(--inject "$f"); done
  echo "$(date -u +%T) path $id inject=[$inject] ui=[$uiargs]"
  node "$HERE/bench_server.mjs" --dir "$S" --scenario "$S/scenario.json" --seed 4 --starts 400,450,500 --port 5299 --start-tune "$S/start_tune.json" "${INJ[@]}" > "$S/bench.log" 2>&1 &
  local BP=$!
  for _ in $(seq 1 120); do grep -q "bench ready" "$S/bench.log" && break; sleep 1; done
  # shellcheck disable=SC2086
  node "$HERE/session_ui.mjs" "$S/ui" 5299 $uiargs > "$S/ui.log" 2>&1
  # the page is closed now: if the bench saw the connection drop with its session open, wait for that restore's abort record
  for _ in $(seq 1 180); do
    python3 - "$S/journal.jsonl" <<'PYEOF' && break
import json, sys
j = [json.loads(x) for x in open(sys.argv[1]) if x.strip()]
d = [k for k, e in enumerate(j) if e["op"] == "disconnected"]
if not d: raise SystemExit(1)
k = d[-1]
if not j[k].get("sessionOpen"): raise SystemExit(0)
raise SystemExit(0 if any(e["op"] == "abort" and e.get("why") == "connection_lost" for e in j[k:]) else 1)
PYEOF
    sleep 1
  done
  sleep 3
  kill "$BP" 2>/dev/null; wait "$BP" 2>/dev/null
  for _ in $(seq 1 30); do pgrep -f "betaflight_SITL.elf --ip" > /dev/null || break; sleep 1; done
  echo "sitl_left=$(pgrep -fc 'betaflight_SITL.elf --ip')" > "$S/after.txt"
  python3 "$HERE/bench_run.py" read "$S/independent_read" "$S/flash" >> "$S/after.txt"
}
PATHS=("${@:2}"); [ ${#PATHS[@]} -eq 0 ] && PATHS=(P0 P1 P3 P4 H1 H1b H2)
for path in "${PATHS[@]}"; do
  case "$path" in
    P0) run_path P0_end_verified "" "--script end-now" ;;
    P1) run_path P1_end_mismatch "end_flash_drift" "--script end-now" ;;
    P3) run_path P3_stop_after_accept "" "--stop-at 2:2" ;;
    P4) run_path P4_drop_after_accept "" "--disconnect-at 2:2" ;;
    H1) run_path H1_retry_after_stop "restore_fail_first:1" "--stop-at 1:2" ;;
    H1b) run_path H1b_retry_after_restore "restore_fail_first:1" "--script restore-test-1" ;;
    H2) run_path H2_unconfirmed "restore_fail_always" "--stop-at 1:2 --probe-locked $(echo "$TUNE_A" | tr -d ' ')" ;;
    *) echo "STOP: unknown path $path"; exit 2 ;;
  esac
done
VP=$(ss -ltnp | grep ':5199 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$VP" ] && kill "$VP"
python3 "$HERE/restore_paths_report.py" "$OUT"
rm -rf "$HERE/__pycache__"

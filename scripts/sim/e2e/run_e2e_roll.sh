#!/bin/bash
# One command for the end-to-end roll autotune proof in the Betaflight SITL (dossier PROTOCOL.md):
#   scripts/sim/e2e/run_e2e_roll.sh <dossier dir>      (protocol.json must already be there; phases already done are kept)
# Phases: start tune (3 SITL runs + reference + engine) → positive control (same) → app (Vite + headless Chrome: import the
# start logs, Calculate, read "Tuning and apply") → candidate remeasurement (the app's roll items, 3 runs) → verdict.
# The positive control's logs are never imported into the app. Simulator only; nothing is written to a flight controller.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DOSSIER="${1:?dossier dir with protocol.json}"
PY=$HOME/VliegAI/_envs/65mm-vision-foundation/bin/python
PROTO="$DOSSIER/protocol.json"
[ -f "$PROTO" ] || { echo "STOP: $PROTO missing"; exit 2; }
jq_() { python3 -c "import json,sys; d=json.load(open('$PROTO')); print(eval(sys.argv[1], {'d': d}))" "$1"; }
START=$(jq_ "'/'.join(str(d['start'][k]) for k in ('p','i','d','dMax'))")
CONTROL=$(jq_ "'/'.join(str(d['control'][k]) for k in ('p','i','d','dMax'))")
STARTS=$(jq_ "','.join(str(x) for x in d['chirpStartTicks'])")
PORT=$(jq_ "d.get('vitePort', 5199)")
echo "protocol: start $START, control $CONTROL, starts $STARTS, head $(git -C "$REPO" rev-parse --short HEAD)"

[ -f "$DOSSIER/start/summary.json" ] || "$HERE/run_tune.sh" "$DOSSIER/start" --tune "$START" --starts "$STARTS"
[ -f "$DOSSIER/control/summary.json" ] || "$HERE/run_tune.sh" "$DOSSIER/control" --tune "$CONTROL" --starts "$STARTS"

if [ ! -f "$DOSSIER/app/tuning_and_apply.json" ]; then
  mkdir -p "$DOSSIER/app"
  LOGS=$(python3 -c "import json; print(' '.join(r['dir']+'/chirp.BFL' for r in json.load(open('$DOSSIER/start/runs.json'))))")
  if ss -ltn | grep -q ":$PORT "; then echo "STOP: port $PORT in use"; exit 2; fi
  (cd "$REPO" && setsid nohup npx vite --port "$PORT" --strictPort > "$DOSSIER/app/vite.log" 2>&1 &)
  for i in $(seq 1 60); do ss -ltn | grep -q ":$PORT " && break; sleep 1; done
  sleep 3
  (cd "$REPO" && node "$HERE/ui_calculate.mjs" "$DOSSIER/app" $LOGS | tee "$DOSSIER/app/run.log") || echo "  ui exit $?"
  VPID=$(ss -ltnp | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$VPID" ] && kill "$VPID" || true
  # the engine on exactly the imported logs (first log + others), for the predicted margins at full precision
  cp "$DOSSIER/start/gyroflight.combined.json" "$DOSSIER/app/engine.json"
  python3 - "$DOSSIER" <<'EOP'
import json, sys
d = sys.argv[1]
app = json.load(open(f"{d}/app/tuning_and_apply.json"))
start = json.load(open(f"{d}/protocol.json"))["start"]
v = dict(start)
for it in app["rollItems"]:
    v[{"p": "p", "i": "i", "d": "d", "d_max": "dMax"}[it["key"].replace("_roll", "")]] = int(it["cells"][2])
json.dump({"shown": app["rollShown"], "candidate": v if app["rollItems"] else None}, open(f"{d}/app/candidate.json", "w"), indent=1)
print("app:", app["rollShown"], v if app["rollItems"] else None)
EOP
fi

CAND=$(python3 -c "import json; c=json.load(open('$DOSSIER/app/candidate.json'))['candidate']; print('/'.join(str(c[k]) for k in ('p','i','d','dMax')) if c else '')")
if [ -n "$CAND" ] && [ ! -f "$DOSSIER/candidate/summary.json" ]; then
  "$HERE/run_tune.sh" "$DOSSIER/candidate" --tune "$CAND" --starts "$STARTS"
fi
"$PY" "$HERE/e2e_verdict.py" "$DOSSIER"

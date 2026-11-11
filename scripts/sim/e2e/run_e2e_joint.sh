#!/bin/bash
# One command for the end-to-end joint PID + filter autotune proof in the Betaflight SITL (dossier PROTOCOL.md, v2):
#   scripts/sim/e2e/run_e2e_joint.sh <dossier dir>      (protocol.json must already be there; phases already done are kept)
# Phases: provenance (before anything runs) → start tune with its filter settings and the seeded gyro noise (3 SITL runs +
# reference + noise reference + engine) → positive control (same, other start ticks) → app (Vite + headless Chrome: import the
# start logs, Calculate, read "Tuning and apply" and the joint block) → candidate remeasurement (the app's roll PID items and
# filter items, 3 runs) → verdict (e2e_joint_verdict.py).
# The positive control's logs are never imported into the app. Simulator only; nothing is written to a flight controller.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DOSSIER="${1:?dossier dir with protocol.json}"
PY=$HOME/VliegAI/_envs/65mm-vision-foundation/bin/python
PROTO="$DOSSIER/protocol.json"
[ -f "$PROTO" ] || { echo "STOP: $PROTO missing"; exit 2; }
jq_() { python3 -c "import json,sys; d=json.load(open('$PROTO')); print(eval(sys.argv[1], {'d': d}))" "$1"; }
pid_() { jq_ "'/'.join(str(d['$1'][k]) for k in ('p','i','d','dMax'))"; }
settings_() { jq_ "','.join(f'{k}={v}' for k, v in (d['$1'].get('settings') or {}).items())"; }
START=$(pid_ start); CONTROL=$(pid_ control)
START_SET=$(settings_ start); CONTROL_SET=$(settings_ control)
STARTS=$(jq_ "','.join(str(x) for x in d['chirpStartTicks'])")
CONTROL_STARTS=$(jq_ "','.join(str(x) for x in (d['control'].get('chirpStartTicks') or d['chirpStartTicks']))")
NOISE=$(jq_ "':'.join(str(d['gyroNoise'][k]) for k in ('stdDps','seed','highpassHz','highpassOrder'))")
PORT=$(jq_ "d.get('vitePort', 5199)")
UNFILT=$(jq_ "'--gyrounfilt' if d.get('logGyroUnfilt', True) else ''")
echo "protocol v$(jq_ "d['version']"): start $START [$START_SET], control $CONTROL [$CONTROL_SET] ticks $CONTROL_STARTS, starts $STARTS, noise $NOISE, head $(git -C "$REPO" rev-parse --short HEAD)"

# Provenance of the whole proof, written before any phase runs: code, build and input.
if [ ! -f "$DOSSIER/provenance.json" ]; then
  REFD=$HOME/Gyroflight-audits/autotune-v2-sitl-loop-reference-2026-11-10
  {
    echo "{\"startedAt\":\"$(date -u +%FT%TZ)\",\"gyroflightHead\":\"$(git -C "$REPO" rev-parse HEAD)\","
    echo "\"gyroflightDirty\":\"$(git -C "$REPO" status --porcelain -- src scripts/sim test package.json | tr '\n' ' ' | sed 's/"/\\\\"/g')\","
    echo "\"vliegaiHead\":\"$(git -C $HOME/VliegAI/_worktrees/air65-sim-review-20261028 rev-parse HEAD)\","
    echo "\"elfSha256\":\"$(sha256sum $REFD/build/bf-src/obj/main/betaflight_SITL.elf | cut -d' ' -f1)\","
    echo "\"protocolSha256\":\"$(sha256sum "$PROTO" | cut -d' ' -f1)\",\"protocolMdSha256\":\"$([ -f "$DOSSIER/PROTOCOL.md" ] && sha256sum "$DOSSIER/PROTOCOL.md" | cut -d' ' -f1)\","
    echo "\"scripts\":{"
    for f in run_e2e_joint.sh run_tune.sh summarize_tune.py ui_calculate.mjs e2e_verdict.py e2e_joint_verdict.py; do echo "\"e2e/$f\":\"$(sha256sum "$HERE/$f" | cut -d' ' -f1)\","; done
    for f in air65_chirp_sitl.py reference_loop.py noise_metrics.py; do echo "\"reference/$f\":\"$(sha256sum "$REPO/scripts/sim/reference/$f" | cut -d' ' -f1)\","; done
    echo "\"test/sitl_loop_reference.local.test.ts\":\"$(sha256sum "$REPO/test/gyrocore/sitl_loop_reference.local.test.ts" | cut -d' ' -f1)\"}}"
  } > "$DOSSIER/provenance.json"
  python3 -c "import json; json.load(open('$DOSSIER/provenance.json'))" || { echo "STOP: provenance.json malformed"; exit 2; }
fi

tune_() { # <subdir> <tune> <settings> <starts>
  local args=("$DOSSIER/$1" --tune "$2" --starts "$4" --noise "$NOISE")
  [ -n "$3" ] && args+=(--settings "$3")
  [ -n "$UNFILT" ] && args+=("$UNFILT")
  "$HERE/run_tune.sh" "${args[@]}"
}
[ -f "$DOSSIER/start/summary.json" ] || tune_ start "$START" "$START_SET" "$STARTS"
[ -f "$DOSSIER/control/summary.json" ] || tune_ control "$CONTROL" "$CONTROL_SET" "$CONTROL_STARTS"

if [ ! -f "$DOSSIER/app/tuning_and_apply.json" ]; then
  mkdir -p "$DOSSIER/app"
  LOGS=$(python3 -c "import json; print(' '.join(r['dir']+'/chirp.BFL' for r in json.load(open('$DOSSIER/start/runs.json'))))")
  if ss -ltn | grep -q ":$PORT "; then echo "STOP: port $PORT in use"; exit 2; fi
  (cd "$REPO" && setsid nohup npx vite --port "$PORT" --strictPort > "$DOSSIER/app/vite.log" 2>&1 &)
  for i in $(seq 1 60); do ss -ltn | grep -q ":$PORT " && break; sleep 1; done
  sleep 3
  python3 - "$DOSSIER" "$REPO" "$HERE" "$PORT" <<'EOP'
import hashlib, json, subprocess, sys, datetime
d, repo, here, port = sys.argv[1:5]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
prov = {"startedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gyroflightHead": subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"], text=True).strip(),
        "srcDirty": subprocess.check_output(["git", "-C", repo, "status", "--porcelain", "--", "src", "package.json"], text=True),
        "srcDirtyRecordedAtCalculate": True, "port": int(port),
        "scripts": {f"e2e/{f}": sha(f"{here}/{f}") for f in ("run_e2e_joint.sh", "run_tune.sh", "summarize_tune.py", "ui_calculate.mjs", "e2e_joint_verdict.py")}}
prov["scripts"]["reference/reference_loop.py"] = sha(f"{repo}/scripts/sim/reference/reference_loop.py")
json.dump(prov, open(f"{d}/app/provenance.json", "w"), indent=1)
EOP
  (cd "$REPO" && node "$HERE/ui_calculate.mjs" "$DOSSIER/app" $LOGS | tee "$DOSSIER/app/run.log") || echo "  ui exit $?"
  VPID=$(ss -ltnp | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$VPID" ] && kill "$VPID" || true
  # the engine on exactly the imported logs (first log + others), for the predicted margins and noise at full precision
  cp "$DOSSIER/start/gyroflight.combined.json" "$DOSSIER/app/engine.json"
fi
# the candidate = the roll PID items of 4b applied to the start tune plus the filter items applied to the start settings
[ -f "$DOSSIER/app/candidate.json" ] || python3 - "$DOSSIER" <<'EOP'
import json, sys
d = sys.argv[1]
app = json.load(open(f"{d}/app/tuning_and_apply.json"))
proto = json.load(open(f"{d}/protocol.json"))
v = {k: proto["start"][k] for k in ("p", "i", "d", "dMax")}
for it in app.get("rollItems") or []:
    v[{"p": "p", "i": "i", "d": "d", "d_max": "dMax"}[it["key"].replace("_roll", "")]] = int(it["cells"][2])
settings = dict(proto["start"].get("settings") or {})
for it in app.get("filterItems") or []:
    settings[it["key"]] = int(it["cells"][2])
shown = app["read"].get("jointShown")
has = bool(app.get("rollItems"))
json.dump({"shown": shown, "rollShown": app["read"].get("rollShown"), "candidate": {**v, "settings": settings} if has else None,
           "filterItems": [(it["key"], it["cells"][1], it["cells"][2]) for it in app.get("filterItems") or []]}, open(f"{d}/app/candidate.json", "w"), indent=1)
print("app:", shown, v if has else None, settings if has else None)
EOP

CAND=$(python3 -c "import json; c=json.load(open('$DOSSIER/app/candidate.json'))['candidate']; print('/'.join(str(c[k]) for k in ('p','i','d','dMax')) if c else '')")
CAND_SET=$(python3 -c "import json; c=json.load(open('$DOSSIER/app/candidate.json'))['candidate']; print(','.join(f'{k}={v}' for k, v in (c['settings'] if c else {}).items()))")
if [ -n "$CAND" ] && [ ! -f "$DOSSIER/candidate/summary.json" ]; then
  tune_ candidate "$CAND" "$CAND_SET" "$STARTS"
fi
"$PY" "$HERE/e2e_joint_verdict.py" "$DOSSIER"

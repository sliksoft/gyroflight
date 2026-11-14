#!/bin/bash
# One command for the joint PID + filter proof with the every-axis motor rule (block 13, dossier PROTOCOL.md v3 or v4; the dossier's
# protocol must equal the committed scripts/sim/e2e/protocols/joint3_protocol_v<version>.json and joint3_PROTOCOL_v<version>.md):
#   scripts/sim/e2e/run_e2e_joint3.sh <dossier dir>      (protocol.json must already be there; phases already done are kept)
# Phases: provenance (before anything runs, with both evaluator selftests) → regression (the v2 candidate: the new engine on the
# v2 start logs and the hover per-motor measure of the v2 runs; no new SITL run) → start (roll then pitch sweep per run, seeded
# gyro noise, 3 runs + references + noise reference + engine) → positive control (other start ticks, never imported) → app
# (Vite + headless Chrome: import the start logs, Calculate, read "Tuning and apply" incl. the every-axis effects table) →
# candidate remeasurement (the app's PID items for every axis and its filter items, 3 runs) → verdict (e2e_joint3_verdict.py).
# Simulator and existing logs only; nothing is written to a flight controller.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DOSSIER="${1:?dossier dir with protocol.json}"
PY=$HOME/VliegAI/_envs/65mm-vision-foundation/bin/python
export PYTHONDONTWRITEBYTECODE=1
PROTO="$DOSSIER/protocol.json"
[ -f "$PROTO" ] || { echo "STOP: $PROTO missing"; exit 2; }
mkdir -p /dev/shm/gf_sitl
jq_() { python3 -c "import json,sys; d=json.load(open('$PROTO')); print(eval(sys.argv[1], {'d': d}))" "$1"; }
pid_() { jq_ "'/'.join(str(d['$1'][k]) for k in ('p','i','d','dMax'))"; }
settings_() { jq_ "','.join(f'{k}={v}' for k, v in (d['$1'].get('settings') or {}).items())"; }
START=$(pid_ start); CONTROL=$(pid_ control)
START_SET=$(settings_ start); CONTROL_SET=$(settings_ control)
STARTS=$(jq_ "','.join(str(x) for x in d['chirpStartTicks'])")
CONTROL_STARTS=$(jq_ "','.join(str(x) for x in (d['control'].get('chirpStartTicks') or d['chirpStartTicks']))")
NOISE=$(jq_ "':'.join(str(d['gyroNoise'][k]) for k in ('stdDps','seed','highpassHz','highpassOrder'))")
SWEEPS=$(jq_ "d.get('sweeps', 1)"); TICKS=$(jq_ "d.get('totalTicks', 2500)")
PORT=$(jq_ "d.get('vitePort', 5199)")
V2=$(jq_ "d['regression']['dossier']"); V2="${V2/#\~/$HOME}"
echo "protocol v$(jq_ "d['version']"): start $START [$START_SET], control $CONTROL [$CONTROL_SET] ticks $CONTROL_STARTS, starts $STARTS, sweeps $SWEEPS, ticks $TICKS, noise $NOISE, head $(git -C "$REPO" rev-parse --short HEAD)"

# The dossier's protocol must be the one committed with the code (pre-registration).
VER=$(jq_ "d['version']")
for f in protocol.json:joint3_protocol_v${VER}.json PROTOCOL.md:joint3_PROTOCOL_v${VER}.md; do
  cmp -s "$DOSSIER/${f%%:*}" "$HERE/protocols/${f##*:}" || { echo "STOP: $DOSSIER/${f%%:*} differs from the committed $HERE/protocols/${f##*:}"; exit 2; }
done
# 0. Provenance of the whole proof, written before any phase runs: code, build, input, both evaluator selftests.
if [ ! -f "$DOSSIER/provenance.json" ]; then
  python3 - "$DOSSIER" "$REPO" "$HERE" <<'EOP'
import datetime, hashlib, json, os, subprocess, sys
d, repo, here = sys.argv[1:4]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
git = lambda *a: subprocess.check_output(["git", "-C", repo, *a], text=True).strip()
refd = os.path.expanduser("~/Gyroflight-audits/autotune-v2-sitl-loop-reference-2026-11-10")
selftest = lambda script: subprocess.run(["python3", f"{here}/{script}", "--selftest"], capture_output=True, text=True, env={"PYTHONDONTWRITEBYTECODE": "1", "PATH": "/usr/bin:/bin"}).stdout.strip().splitlines()[-1]
prov = {
    "startedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "gyroflightHead": git("rev-parse", "HEAD"),
    "gyroflightDirty": git("status", "--porcelain", "--", "src", "scripts/sim", "test", "package.json"),
    "vliegaiHead": subprocess.check_output(["git", "-C", os.path.expanduser("~/VliegAI/_worktrees/air65-sim-review-20261028"), "rev-parse", "HEAD"], text=True).strip(),
    "elfSha256": sha(f"{refd}/build/bf-src/obj/main/betaflight_SITL.elf"),
    "protocolSha256": sha(f"{d}/protocol.json"),
    "protocolMdSha256": sha(f"{d}/PROTOCOL.md"),
    "evaluatorSelftest": selftest("e2e_verdict.py"),
    "joint3Selftest": selftest("e2e_joint3_verdict.py"),
    "scripts": {f"e2e/{f}": sha(f"{here}/{f}") for f in ("run_e2e_joint3.sh", "run_tune.sh", "summarize_tune.py", "ui_calculate.mjs", "e2e_joint3_verdict.py", "e2e_joint_verdict.py", "e2e_verdict.py", "regression_v2.py")},
}
for f in ("air65_chirp_sitl.py", "reference_loop.py", "noise_metrics.py"):
    prov["scripts"][f"reference/{f}"] = sha(f"{repo}/scripts/sim/reference/{f}")
prov["scripts"]["test/sitl_loop_reference.local.test.ts"] = sha(f"{repo}/test/gyrocore/sitl_loop_reference.local.test.ts")
json.dump(prov, open(f"{d}/provenance.json", "w"), indent=1)
print("provenance:", prov["gyroflightHead"][:9], "dirty:", repr(prov["gyroflightDirty"]), prov["evaluatorSelftest"], "/", prov["joint3Selftest"])
if prov["evaluatorSelftest"] != "selftest PASS" or prov["joint3Selftest"] != "selftest PASS":
    raise SystemExit("STOP: an evaluator selftest failed")
EOP
fi

# 1. Regression: the v2 candidate under the new engine and the protocol v3 motor measure (existing v2 logs only).
if [ ! -f "$DOSSIER/regression/regression.json" ]; then
  mkdir -p "$DOSSIER/regression/noise/start" "$DOSSIER/regression/noise/candidate"
  for role in start candidate; do
    for t in "$V2"/$role/runs/*/case/controller_trace.npz; do
      run=$(basename "$(dirname "$(dirname "$t")")")
      "$PY" "$REPO/scripts/sim/reference/noise_metrics.py" "$t" "$DOSSIER/regression/noise/$role/$run.json" > /dev/null
    done
  done
  JOBS=$(python3 - "$V2" "$DOSSIER" "$PROTO" <<'EOP'
import json, glob, sys
v2, d, proto = sys.argv[1:4]
p = json.load(open(proto))["regression"]
logs = sorted(glob.glob(f"{v2}/start/runs/*/chirp.BFL"))
probes = [{"label": "regression_v2_candidate", "pids": p["candidate"], "gyroScale": p["gyroScale"], "dtermScale": p["dtermScale"]}]
print(json.dumps([{"log": logs[0], "others": logs[1:], "out": f"{d}/regression/engine.json", "jointProbes": probes}]))
EOP
)
  (cd "$REPO" && GYROFLIGHT_REF_HEAD="$(git rev-parse HEAD)" GYROFLIGHT_REF_JOBS="$JOBS" npx vitest run test/gyrocore/sitl_loop_reference.local.test.ts --maxWorkers=1 > "$DOSSIER/regression/vitest.log" 2>&1) || echo "  regression engine exit $?"
  python3 "$HERE/regression_v2.py" "$DOSSIER" "$V2" "$DOSSIER/regression/engine.json"
fi

tune_() { # <subdir> <tune> <settings> <starts> [probes json]
  local args=("$DOSSIER/$1" --tune "$2" --starts "$4" --noise "$NOISE" --gyrounfilt --sweeps "$SWEEPS" --ticks "$TICKS")
  [ -n "$3" ] && args+=(--settings "$3")
  "$HERE/run_tune.sh" "${args[@]}"
}
[ -f "$DOSSIER/start/summary.json" ] || tune_ start "$START" "$START_SET" "$STARTS"
[ -f "$DOSSIER/control/summary.json" ] || tune_ control "$CONTROL" "$CONTROL_SET" "$CONTROL_STARTS"

if [ ! -f "$DOSSIER/app/tuning_and_apply.json" ]; then
  mkdir -p "$DOSSIER/app"
  LOGS=$(python3 -c "import json; print(' '.join(r['dir']+'/chirp.BFL' for r in json.load(open('$DOSSIER/start/runs.json'))))")
  if ss -ltn | grep -q ":$PORT "; then echo "STOP: port $PORT in use"; exit 2; fi
  (cd "$REPO" && setsid nohup npx vite --port "$PORT" --strictPort > "$DOSSIER/app/vite.log" 2>&1 &)
  for i in $(seq 1 90); do ss -ltn | grep -q ":$PORT " && break; sleep 1; done
  sleep 3
  python3 - "$DOSSIER" "$REPO" "$HERE" "$PORT" <<'EOP'
import hashlib, json, subprocess, sys, datetime
d, repo, here, port = sys.argv[1:5]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
prov = {"startedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gyroflightHead": subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"], text=True).strip(),
        "srcDirty": subprocess.check_output(["git", "-C", repo, "status", "--porcelain", "--", "src", "package.json"], text=True),
        "srcDirtyRecordedAtCalculate": True, "port": int(port),
        "scripts": {f"e2e/{f}": sha(f"{here}/{f}") for f in ("run_e2e_joint3.sh", "ui_calculate.mjs", "e2e_joint3_verdict.py")}}
json.dump(prov, open(f"{d}/app/provenance.json", "w"), indent=1)
EOP
  (cd "$REPO" && node "$HERE/ui_calculate.mjs" "$DOSSIER/app" $LOGS | tee "$DOSSIER/app/run.log") || echo "  ui exit $?"
  VPID=$(ss -ltnp | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$VPID" ] && kill "$VPID" || true
  cp "$DOSSIER/start/gyroflight.combined.json" "$DOSSIER/app/engine.json"
fi
# The candidate = the app's PID items (roll → the roll tune, pitch → p_/i_/d_/d_max_pitch) and filter items on the start.
[ -f "$DOSSIER/app/candidate.json" ] || python3 - "$DOSSIER" <<'EOP'
import json, sys
d = sys.argv[1]
app = json.load(open(f"{d}/app/tuning_and_apply.json"))
proto = json.load(open(f"{d}/protocol.json"))
roll = {k: proto["start"][k] for k in ("p", "i", "d", "dMax")}
settings = dict(proto["start"].get("settings") or {})
field = {"p": "p", "i": "i", "d": "d", "d_max": "dMax"}
for it in app.get("pidItems") or []:
    term, axis = it["key"].rsplit("_", 1)
    if axis == "roll":
        roll[field[term]] = int(it["cells"][2])
    else:
        settings[f"{term}_{axis}"] = int(it["cells"][2])
for it in app.get("filterItems") or []:
    settings[it["key"]] = int(it["cells"][2])
has = bool(app.get("pidItems"))
json.dump({"shown": app["read"].get("jointShown"), "candidate": {**roll, "settings": settings} if has else None,
           "items": [(it["key"], it["cells"][1], it["cells"][2], it.get("source")) for it in (app.get("pidItems") or []) + (app.get("filterItems") or [])]},
          open(f"{d}/app/candidate.json", "w"), indent=1)
print("app:", app["read"].get("jointShown"), roll if has else None, settings if has else None)
EOP

CAND=$(python3 -c "import json; c=json.load(open('$DOSSIER/app/candidate.json'))['candidate']; print('/'.join(str(c[k]) for k in ('p','i','d','dMax')) if c else '')")
CAND_SET=$(python3 -c "import json; c=json.load(open('$DOSSIER/app/candidate.json'))['candidate']; print(','.join(f'{k}={v}' for k, v in (c['settings'] if c else {}).items()))")
if [ -n "$CAND" ] && [ ! -f "$DOSSIER/candidate/summary.json" ]; then
  tune_ candidate "$CAND" "$CAND_SET" "$STARTS"
fi
"$PY" "$HERE/e2e_joint3_verdict.py" "$DOSSIER"

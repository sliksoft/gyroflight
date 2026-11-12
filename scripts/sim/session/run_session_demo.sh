#!/bin/bash
# AutoTune session proof in Betaflight SITL (block 14, protocol session_v1): one command.
#   scripts/sim/session/run_session_demo.sh <dossier> [--only SESSION_ID] [--no-final] [--no-verdict]
# Per session of the protocol (in order): start the SITL bench (bench_server.mjs) with the session's start tune and
# scenario, run the session in the normal GyroFlight app (Vite dev server on 5199, Playwright: session_ui.mjs presses
# Start; for the stop / disconnect tests it presses Stop or closes the page during the named candidate run), stop the
# bench, read the bench's flash once more over MSP in a separate process (independent_read). Then the independent final
# measurement of every normal session with an ACCEPT (measure_tune.py, final seed and start ticks) and the verdict.
# Sessions with sessions/<id>/DONE are skipped. Refuses a protocol that differs from the committed one, a dirty tree in
# the session code, a wrong ELF or VliegAI head, and a SITL already running.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
D="${1:?dossier}"; shift || true
ONLY=""; FINAL=1; VERDICT=1
while [ $# -gt 0 ]; do case "$1" in
  --only) ONLY="$2"; shift 2;; --no-final) FINAL=0; shift;; --no-verdict) VERDICT=0; shift;;
  *) echo "unknown $1"; exit 2;; esac; done
export PYTHONDONTWRITEBYTECODE=1
CFG="$HERE/bench_config.json"
PY=$(python3 -c "import json,os;print(os.path.expanduser(json.load(open('$CFG'))['python']))")
VL=$(python3 -c "import json,os;print(os.path.expanduser(json.load(open('$CFG'))['vliegaiRoot']))")
VH_EXPECTED=$(python3 -c "import json,os;print(os.path.expanduser(json.load(open('$CFG'))['vliegaiHead']))")
ELF=$(python3 -c "import json,os;print(os.path.expanduser(json.load(open('$CFG'))['elf']))")
ELF_SHA=$(python3 -c "import json,os;print(os.path.expanduser(json.load(open('$CFG'))['elfSha256']))")
PROTO_SRC="$REPO/scripts/sim/e2e/protocols/session_protocol_v1.json"
mkdir -p "$D/sessions" "$D/final"
[ "$(sha256sum "$ELF" | cut -d' ' -f1)" = "$ELF_SHA" ] || { echo "STOP: elf sha"; exit 2; }
[ "$(git -C "$VL" rev-parse HEAD)" = "$VH_EXPECTED" ] || { echo "STOP: vliegai head"; exit 2; }
DIRTY=$(git -C "$REPO" status --porcelain -- scripts/sim/session scripts/sim/reference scripts/sim/e2e/protocols src/gyrocore/sitlSession src/gyrocore/engine src/composables/useSitlSession.ts src/gyrocore/components/SitlSessionPanel.vue)
[ -z "$DIRTY" ] || { echo "STOP: session code differs from HEAD:"; echo "$DIRTY"; exit 2; }
if [ -f "$D/protocol.json" ]; then cmp -s "$D/protocol.json" "$PROTO_SRC" || { echo "STOP: dossier protocol.json differs from the committed protocol"; exit 2; }
else cp "$PROTO_SRC" "$D/protocol.json"; cp "$REPO/scripts/sim/e2e/protocols/session_PROTOCOL_v1.md" "$D/PROTOCOL.md"; fi
[ -f "$D/provenance.json" ] || python3 - "$D" "$REPO" <<'EOF'
import json, subprocess, sys, hashlib, pathlib
d, repo = pathlib.Path(sys.argv[1]), sys.argv[2]
h = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
files = [f for f in subprocess.check_output(["git", "-C", repo, "ls-files", "scripts/sim/session", "scripts/sim/reference", "src/gyrocore/sitlSession"]).decode().split()]
json.dump({"gyroflightHead": subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"]).decode().strip(),
           "files": {f: h(f"{repo}/{f}") for f in files}}, open(d / "provenance.json", "w"), indent=1)
EOF
pgrep -f "betaflight_SITL.elf --ip" > /dev/null && { echo "STOP: a SITL process is already running"; exit 2; }

VITE_PID=""
cleanup() { [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true; [ -n "${BENCH_PID:-}" ] && kill "$BENCH_PID" 2>/dev/null || true; }
trap cleanup EXIT
start_vite() {
  [ -n "$VITE_PID" ] && return
  (cd "$REPO" && setsid nohup npx vite --port 5199 --strictPort > "$D/vite.log" 2>&1 & echo $! > "$D/vite.pid")
  for _ in $(seq 1 120); do ss -ltn | grep -q ':5199 ' && break; sleep 1; done
  VITE_PID=$(ss -ltnp | grep ':5199 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  sleep 3
}

N=$(python3 -c "import json;print(len(json.load(open('$D/protocol.json'))['sessions']))")
for k in $(seq 0 $((N-1))); do
  eval "$(python3 - "$D" "$k" <<'EOF'
import json, sys, shlex
d, k = sys.argv[1], int(sys.argv[2])
p = json.load(open(f"{d}/protocol.json")); s = p["sessions"][k]
sc = dict(p["scenarios"][s["scenario"]]); sc["id"] = s["scenario"]
if s.get("script"): sc["scripts"] = {s["script"]: p["scripts"][s["script"]]}
import pathlib
sd = pathlib.Path(d) / "sessions" / s["id"]; sd.mkdir(parents=True, exist_ok=True)
(sd / "scenario.json").write_text(json.dumps(sc, indent=1)); (sd / "start_tune.json").write_text(json.dumps(p["startTunes"][s["start"]]))
print(f"SID={shlex.quote(s['id'])}; KIND={shlex.quote(s['kind'])}; SCRIPT={shlex.quote(s.get('script') or '')}; STOPAT={shlex.quote(s.get('stopAt') or '')}; DROPAT={shlex.quote(s.get('disconnectAt') or '')}")
print(f"SEED={p['measurement']['sessionSeed']}; STARTS={','.join(map(str, p['measurement']['sessionStarts']))}")
EOF
)"
  [ -n "$ONLY" ] && [ "$ONLY" != "$SID" ] && continue
  SD="$D/sessions/$SID"
  [ -f "$SD/DONE" ] && { echo "skip $SID (done)"; continue; }
  [ -e "$SD/journal.jsonl" ] && { echo "STOP: $SID has a journal but no DONE: inspect and remove it"; exit 2; }
  start_vite
  echo "$(date -u +%T) session $SID ($KIND)"
  node "$HERE/bench_server.mjs" --dir "$SD" --scenario "$SD/scenario.json" --seed "$SEED" --starts "$STARTS" --port 5299 --start-tune "$SD/start_tune.json" > "$SD/bench.log" 2>&1 &
  BENCH_PID=$!
  for _ in $(seq 1 120); do grep -q "bench ready" "$SD/bench.log" 2>/dev/null && break; sleep 1; done
  grep -q "bench ready" "$SD/bench.log" || { echo "STOP: bench did not start"; cat "$SD/bench.log"; exit 2; }
  UIARGS=()
  [ -n "$SCRIPT" ] && UIARGS+=(--script "$SCRIPT")
  [ -n "$STOPAT" ] && UIARGS+=(--stop-at "$STOPAT")
  [ -n "$DROPAT" ] && UIARGS+=(--disconnect-at "$DROPAT")
  node "$HERE/session_ui.mjs" "$SD/ui" 5299 "${UIARGS[@]}" > "$SD/ui.log" 2>&1 || echo "  ui exit $?"
  # A session that should have ended on its own but the page is gone (e.g. the UI timed out): let the bench finish the
  # restore it starts on the lost connection before it is stopped.
  if [ -z "$DROPAT" ] && ! grep -q '"op":"finish"' "$SD/journal.jsonl" 2>/dev/null; then
    for _ in $(seq 1 600); do grep -q '"op":"abort"' "$SD/journal.jsonl" && break; sleep 1; done
  fi
  # The bench finishes its own restore after a lost connection: wait for its abort record.
  if [ -n "$DROPAT" ]; then for _ in $(seq 1 600); do grep -q '"op": *"abort"\|"op":"abort"' "$SD/journal.jsonl" && break; sleep 1; done; fi
  sleep 2
  kill "$BENCH_PID" 2>/dev/null || true; wait "$BENCH_PID" 2>/dev/null || true; BENCH_PID=""
  for _ in $(seq 1 30); do pgrep -f "betaflight_SITL.elf --ip" > /dev/null || break; sleep 1; done
  python3 "$HERE/bench_run.py" read "$SD/independent_read" "$SD/flash" | tee "$SD/independent_read.txt"
  touch "$SD/DONE"
done
[ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true; VITE_PID=""

if [ $FINAL = 1 ]; then
  python3 - "$D" > "$D/final/plan.txt" <<'EOF'
import json, sys, pathlib
d = pathlib.Path(sys.argv[1]); p = json.load(open(d / "protocol.json"))
for s in p["sessions"]:
    if s["kind"] != "normal": continue
    j = d / "sessions" / s["id"] / "journal.jsonl"
    if not j.is_file(): continue
    fin = [json.loads(x) for x in j.read_text().splitlines() if '"finish"' in x]
    if not fin: continue
    r = fin[-1]["result"]
    if not any(x["verdict"] == "ACCEPT" for x in r["steps"]): continue
    # compact JSON: the shell reads the four fields of this line with `read`
    c = dict(separators=(",", ":"))
    print(s["id"], s["scenario"], json.dumps(r["startTune"], **c), json.dumps(r["bestTune"], **c))
EOF
  while read -r SID SCEN START BEST; do
    for which in start best; do
      OUTF="$D/final/$SID/$which"; [ -f "$OUTF/measurement.json" ] && continue
      [ -e "$OUTF" ] && { echo "STOP: $OUTF incomplete"; exit 2; }
      mkdir -p "$D/final/$SID"
      [ $which = start ] && echo "$START" > "$D/final/$SID/${which}_tune.json" || echo "$BEST" > "$D/final/$SID/${which}_tune.json"
      python3 -c "import json;p=json.load(open('$D/protocol.json'));json.dump({'id':'$SCEN',**p['scenarios']['$SCEN']},open('$D/final/$SID/scenario.json','w'))"
      SEEDF=$(python3 -c "import json;print(json.load(open('$D/protocol.json'))['measurement']['finalSeed'])")
      STARTSF=$(python3 -c "import json;print(','.join(map(str,json.load(open('$D/protocol.json'))['measurement']['finalStarts'])))")
      echo "$(date -u +%T) final $SID $which"
      python3 "$HERE/measure_tune.py" "$OUTF" "$D/final/$SID/scenario.json" "$D/final/$SID/${which}_tune.json" --seed "$SEEDF" --starts "$STARTSF" > "$OUTF.log" 2>&1
    done
  done < "$D/final/plan.txt"
fi
[ $VERDICT = 1 ] && python3 "$HERE/e2e_session_verdict.py" "$D"
rm -rf "$HERE/__pycache__"

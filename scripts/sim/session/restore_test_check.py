"""Independent check of the restore tests' scripted steps (block 14, supplementary; not a pre-registered criterion).

restore_test_check.py <dossier> <session> <scripted step>
For the scripted step's measurement and the accepted measurement it was tried from, reads every run's decoded trace
(controller_trace.npz in the bench's ops dirs) with the Python references only — step_metrics.py for the step block and
noise_metrics.py --cut for the per-motor hover band — and prints the per-motor median ratio candidate/accepted against the
G1 limit 1.10. No GyroFlight code.
"""

import json
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "bench_config.json").read_text().replace('"~/', '"' + str(Path.home()) + '/'))


def motor_band(npz: Path, spec: dict, work: Path) -> list:
    work.mkdir(parents=True, exist_ok=True)
    (work / "schedule.json").write_text(json.dumps(spec))
    subprocess.run([CFG["python"], str(HERE / "step_metrics.py"), str(npz), str(work / "schedule.json"), str(work / "steps.json")], check=True, capture_output=True)
    t0 = json.loads((work / "steps.json").read_text())["blockStartTimeS"]
    blen = (spec["stepBlocks"][-1]["endTick"] - spec["stepBlocks"][0]["startTick"]) / 100.0
    subprocess.run([CFG["python"], str(HERE.parent / "reference" / "noise_metrics.py"), str(npz), str(work / "noise.json"), "--cut", f"{t0 - 0.6}:{t0 + blen + 0.2}"],
                   check=True, capture_output=True)
    return json.loads((work / "noise.json").read_text())["motorBandHover"]


def main():
    D, sid, k = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
    sd = D / "sessions" / sid
    j = [json.loads(x) for x in (sd / "journal.jsonl").read_text().splitlines() if x.strip()]
    fin = [e for e in j if e["op"] == "finish"][-1]["result"]
    step = next(s for s in fin["steps"] if s["index"] == k)
    base_id = step["baseMeasurementId"]
    meas = [e for e in j if e["op"] == "measure"]
    label_of = {}
    for e in meas:
        mid = "+".join((r.get("logSha256") or "none")[:12] for r in e["runs"])
        label_of[mid] = e
    out = {"session": sid, "step": k, "baseMeasurementId": base_id, "candidateMeasurementId": step["measurementId"], "appVerdict": step["verdict"],
           "appReasons": step["reasons"]}
    bands = {}
    for role, mid in (("accepted", base_id), ("candidate", step["measurementId"])):
        e = label_of[mid]
        per = []
        for r in e["runs"]:
            run_dir = Path(r["logPath"]).parent
            spec = json.loads((run_dir.parent / (run_dir.name + ".request.json")).read_text())["measure"]
            per.append(motor_band(run_dir / "case" / "controller_trace.npz", spec, sd / "independent_check" / f"step{k}" / role / run_dir.name))
        bands[role] = [statistics.median(p[m] for p in per) for m in range(4)]
    out["motorBand"] = bands
    out["ratio"] = [bands["candidate"][m] / bands["accepted"][m] for m in range(4)]
    out["g1Exceeded"] = max(out["ratio"]) > 1.10
    (sd / "independent_check" / f"step{k}.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k_: out[k_] for k_ in ("session", "step", "appVerdict", "ratio", "g1Exceeded")}))


if __name__ == "__main__":
    main()

"""Measure one tune with the SITL bench outside the app (pilot and independent final measurement, block 14).

measure_tune.py <out dir> <scenario.json> <tune.json> --seed N --starts 400,450,500
  provisions the tune into a fresh flash under <out dir>/flash, reads it back over MSP, flies one run per start tick with
  the session schedule (schedule.py) and gyro noise (2 deg/s, 2x RC high-pass 150 Hz, seed N), then runs the independent
  references per run: reference_loop.py (roll, pitch), noise_metrics.py (hover outside CHIRP and step block ± 0.5 s) and
  step_metrics.py. Writes <out dir>/measurement.json (per run and medians/spreads). No GyroFlight code is used.
"""

import json
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REF = HERE.parent / "reference"
sys.path.insert(0, str(HERE))
import bench_run  # noqa: E402
import schedule  # noqa: E402

CFG = json.loads((HERE / "bench_config.json").read_text().replace('"~/', '"' + str(Path.home()) + '/'))
PY = CFG["python"]


def gm_sigma_db(coh):
    """GM rule v4 (protocol joint3 v4): σ = 20·log10(1 + ε), ε = √(1 − γ²)/(|γ|·√2) with γ² the coherence, n_d = 1."""
    if coh is None or coh <= 0:
        return None
    import math
    g = math.sqrt(coh)
    return 20 * math.log10(1 + math.sqrt(max(0.0, 1 - coh)) / (g * math.sqrt(2)))


def med_spread(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None, None
    return statistics.median(xs), max(xs) - min(xs)


def main():
    out = Path(sys.argv[1])
    scenario = json.loads(Path(sys.argv[2]).read_text())
    tune = json.loads(Path(sys.argv[3]).read_text())
    args = sys.argv[4:]
    seed = int(args[args.index("--seed") + 1])
    starts = [int(x) for x in args[args.index("--starts") + 1].split(",")]
    out.mkdir(parents=True, exist_ok=False)
    flash = out / "flash"
    fixed = dict(CFG["fixedSettings"], **scenario.get("fixedSettings", {}))
    prov = bench_run.run("provision", str(out / "provision"), str(flash), {"tune": tune, "fixedSettings": fixed})
    if prov["status"] != "ok":
        raise SystemExit(f"provision failed: {prov}")
    read = bench_run.run("read", str(out / "read"), str(flash), {})
    runs = []
    noise = {"stdDps": 2.0, "seed": seed, "highpassHz": 150, "highpassOrder": 2}
    for s in starts:
        spec = schedule.build(s)
        spec["gyroNoise"] = noise
        d = out / f"run_s{s}"
        r = bench_run.run("measure", str(d), str(flash), {"measure": spec})
        row = {"start": s, "status": r["status"], "reason": r.get("reason"), "active": (r.get("active") or {}).get("decoded"), "plant": r.get("plant")}
        if r["status"] == "ok":
            npz = r["controller_trace_npz"]
            (d / "schedule.json").write_text(json.dumps(spec))
            subprocess.run([PY, str(HERE / "step_metrics.py"), npz, str(d / "schedule.json"), str(d / "steps.json")], check=True, capture_output=True)
            steps = json.loads((d / "steps.json").read_text())
            subprocess.run([PY, str(REF / "reference_loop.py"), npz, str(d / "reference.json"), "--scale", "0.1"], check=True, capture_output=True)
            subprocess.run([PY, str(REF / "reference_loop.py"), npz, str(d / "reference_pitch.json"), "--scale", "0.1", "--axis", "1"], check=True, capture_output=True)
            t0 = steps.get("blockStartTimeS")
            cut = []
            if t0 is not None:
                # acro lead (0.6 s) before the block, block length, 0.2 s tail
                blen = (spec["stepBlocks"][-1]["endTick"] - spec["stepBlocks"][0]["startTick"]) / 100.0
                cut = ["--cut", f"{t0 - 0.6}:{t0 + blen + 0.2}"]
            subprocess.run([PY, str(REF / "noise_metrics.py"), npz, str(d / "noise.json"), *cut], check=True, capture_output=True)
            row["steps"] = steps
            row["ref"] = {}
            for axis, f in (("roll", "reference.json"), ("pitch", "reference_pitch.json")):
                m = json.loads((d / f).read_text())["margins"]
                coh = m.get("coherenceAtPhaseCrossing")
                row["ref"][axis] = {"fc": m["crossoverHz"], "pm": m["phaseMarginDeg"], "gm": m["gainMarginDb"], "gmHz": m.get("phaseCrossingHz"),
                                    "gmCoherence": coh, "gmSigmaDb": gm_sigma_db(coh), "s": m["sensitivityPeakDb"],
                                    "minCohG": m["minCoherencePlantInBand"], "minCohD": m["minCoherenceDtermInBand"]}
            nz = json.loads((d / "noise.json").read_text())
            row["noise"] = {k: nz.get(k) for k in ("hover", "motorBandHover", "axisCtrlHover", "motorClip")}
            row["log"] = r["blackbox_log"]
            row["header"] = {k: r["header"].get(k) for k in ("rollPID", "pitchPID", "yawPID", "d_max", "gyro_lpf1_static_hz", "dterm_lpf1_static_hz", "dterm_lpf1_dyn_hz")}
        runs.append(row)
    summary = {"tune": tune, "scenario": scenario.get("id"), "seed": seed, "starts": starts, "read": (read.get("active") or {}).get("decoded"), "readStatus": read["status"], "runs": runs}
    ok = [r for r in runs if r["status"] == "ok"]
    med = {}
    for axis in ("roll", "pitch"):
        m = {}
        for key, path in (("fc", ("ref", axis, "fc")), ("pm", ("ref", axis, "pm")), ("gm", ("ref", axis, "gm")), ("s", ("ref", axis, "s")),
                          ("tracking", ("steps", "axes", axis, "trackingRel")), ("overshoot", ("steps", "axes", axis, "overshoot")),
                          ("riseMs", ("steps", "axes", axis, "riseMs")), ("oscillation", ("steps", "axes", axis, "oscillation"))):
            vals = []
            for r in ok:
                v = r
                for p in path:
                    v = v.get(p) if isinstance(v, dict) else None
                vals.append(v if isinstance(v, (int, float)) else None)
            m[key] = dict(zip(("median", "spread"), med_spread(vals)))
        med[axis] = m
    med["motors"] = [dict(zip(("median", "spread"), med_spread([r["noise"]["motorBandHover"][k] for r in ok]))) for k in range(4)] if ok else None
    summary["medians"] = med
    (out / "measurement.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(med))


if __name__ == "__main__":
    main()

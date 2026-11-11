"""AIR65 comparison for the joint PID + filter search (block 12): current tune, best PID-only candidate and best joint
candidate per axis, from the trace JSON the local test writes (test/gyrocore/air65_nov_candidate_trace.local.test.ts with
GYROFLIGHT_TRACE_OUT). Reads only; writes <out dir>/air65_joint_compare.md and .json.

Usage: air65_joint_compare.py <trace dir> [<out dir>]
Per run and axis:
  current        the logged tune and its measured in-band margins (candidate decision `current`);
  PID-only       the offered candidate (candidate_found) or, without one, the safest within ±30 % (highest PM) and the wider
                 target search's target / best (information: not offered);
  joint          the chosen candidate (candidate_found) or, without one, the readable candidate with the highest PM over all
                 filter combinations (the "safest"), with its filters, predicted noise ratio and whether it was eligible.
Noise evidence per run: the chain validation per axis, which filter parameters were searched and which not (with the missing
evidence), and the engine's noise basis (gyroUnfilt logged, eRPM logged).
"""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

TARGETS = {"pm": 45.0, "gm": 6.0, "s": 6.0}


def f(x, p=1):
    return "–" if x is None else f"{x:.{p}f}"


def pid(v):
    return f"{v['p']}/{v['i']}/{v['d']}, d_max {v['dMax']}" if v else "–"


def meets(r):
    return r and r.get("pmDeg") is not None and r["pmDeg"] >= TARGETS["pm"] and r.get("gmDb") is not None and r["gmDb"] >= TARGETS["gm"] and r.get("sDb") is not None and r["sDb"] <= TARGETS["s"]


def misses(r):
    out = []
    if r is None:
        return ["unknown"]
    if r.get("pmDeg") is None or r["pmDeg"] < TARGETS["pm"]:
        out.append(f"PM {f(r.get('pmDeg'), 1)}")
    if r.get("gmDb") is None or r["gmDb"] < TARGETS["gm"]:
        out.append(f"GM {f(r.get('gmDb'), 1)}")
    if r.get("sDb") is None or r["sDb"] > TARGETS["s"]:
        out.append(f"|S| {f(r.get('sDb'), 2)}")
    return out


def main() -> int:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else src
    rows = []
    md = ["# AIR65 — current tune, best PID-only candidate, best joint PID + filter candidate (per run and axis)", ""]
    md += ["Measured in-band margins of the loop reconstruction (MEASURED; nothing validated by a flight). Filters: g = gyro lowpass group, d = D-term lowpass group (scale of every cutoff). Noise ratio: predicted controller-output noise above 100 Hz against the current tune (simulated on the logged gyroUnfilt).", ""]
    md += ["| run | axis | tune | filters | fc (Hz) | PM (°) | GM (dB) | \\|S\\| (dB) | noise ratio | meets | role |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for path in sorted(glob.glob(str(src / "air65_trace_*.json"))):
        g = json.loads(Path(path).read_text())
        run = g["run"]
        j = g.get("joint") or {}
        chain = g.get("chain") or {}
        cur_filters = (j.get("current") or {}).get("filters") or {}
        fl = lambda sg, sd: f"g ×{sg}, d ×{sd}"  # noqa: E731
        for axis in ("roll", "pitch", "yaw"):
            dec = ((g.get("candidateDecisions") or {}).get(axis) or {}).get("primary")
            if not dec:
                continue
            cur = dec.get("current")
            curpid = (dec.get("candidate") or {}).get("current") or ((j.get("current") or {}).get("axes") or {}).get(axis, {}).get("pid")
            rows.append({"run": run, "axis": axis, "role": "current", "pid": curpid, "filters": "as logged", "read": cur, "status": dec["status"]})
            md.append(f"| {run} | {axis} | {pid(curpid)} | as logged | {f(cur and cur['crossoverHz'])} | {f(cur and cur['pmDeg'])} | {f(cur and cur['gmDb'])} | {f(cur and cur['sDb'], 2)} | 1.00 | {'yes' if meets(cur) else 'no: ' + ', '.join(misses(cur))} | current ({dec['status']}) |")
            c = dec.get("candidate")
            if c:
                pm_ = c["proposedMargins"]
                r = {"crossoverHz": pm_["crossoverHz"], "pmDeg": pm_["phaseMarginDeg"], "gmDb": pm_["gainMarginDb"] if pm_["gainMarginDb"] is not None else pm_["measured"]["gainMarginDb"], "sDb": pm_["sensitivityPeakDb"] if pm_["sensitivityPeakDb"] is not None else pm_["measured"]["sensitivityPeakDb"]}
                po = (j.get("pidOnly") or {}).get(axis)
                role = "PID-only offered" if dec["status"] == "candidate_found" else "PID-only safest within ±30 % (not offered)"
                rows.append({"run": run, "axis": axis, "role": role, "pid": c["proposed"], "filters": "unchanged", "read": r, "noise": po and po["noise"]["ratio"]})
                md.append(f"| {run} | {axis} | {pid(c['proposed'])} | unchanged | {f(r['crossoverHz'])} | {f(r['pmDeg'])} | {f(r['gmDb'])} | {f(r['sDb'], 2)} | {f(po and po['noise']['ratio'], 2)} | {'yes' if meets(r) else 'no: ' + ', '.join(misses(r))} | {role} |")
            t = dec.get("target")
            if t and (t.get("target") or t.get("best")):
                tr = t.get("target") or t.get("best")
                role = "wider target search: target (beyond one Apply, not offered)" if t.get("target") else f"wider target search: best{' (on its edge)' if t.get('bestOnEdge') else ''} (not offered)"
                rows.append({"run": run, "axis": axis, "role": role, "pid": tr["values"], "filters": "unchanged", "read": tr})
                md.append(f"| {run} | {axis} | {pid(tr['values'])} | unchanged | {f(tr['crossoverHz'])} | {f(tr['pmDeg'])} | {f(tr['gmDb'])} | {f(tr['sDb'], 2)} | – | {'yes' if meets(tr) else 'no: ' + ', '.join(misses(tr))} | {role} |")
            # joint: chosen, else the safest over all combinations
            ch = (j.get("chosen") or {}).get("axes", {}).get(axis) if j.get("chosen") else None
            if ch:
                r = ch["read"]
                rows.append({"run": run, "axis": axis, "role": "joint chosen (offered)", "pid": r["pid"], "filters": fl(r["gyroScale"], r["dtermScale"]), "read": r, "noise": r["noise"]["ratio"]})
                md.append(f"| {run} | {axis} | {pid(r['pid'])} | {fl(r['gyroScale'], r['dtermScale'])} | {f(r['crossoverHz'])} | {f(r['pmDeg'])} | {f(r['gmDb'])} | {f(r['sDb'], 2)} | {f(r['noise']['ratio'], 2)} | yes | joint chosen (offered) |")
            else:
                best = None
                for cb in j.get("combos") or []:
                    ax = next((x for x in cb["axes"] if x["axis"] == axis), None)
                    for cand in ([ax["best"]] if ax and ax["best"] else []) + ([ax["safest"]] if ax and ax["safest"] else []):
                        if cand and (best is None or cand["pmDeg"] > best["pmDeg"]):
                            best = cand
                if best:
                    elig = meets(best) and best["noise"]["ratio"] is not None and best["noise"]["ratio"] <= 1.1 and (best["crossoverGain"] or 0) >= 0.8
                    role = f"joint: highest PM over all combinations ({'eligible' if elig else 'not eligible: ' + ('noise' if best['noise']['ratio'] is not None and best['noise']['ratio'] > 1.1 else 'misses targets' if not meets(best) else 'bandwidth')}), not offered"
                    rows.append({"run": run, "axis": axis, "role": role, "pid": best["pid"], "filters": fl(best["gyroScale"], best["dtermScale"]), "read": best, "noise": best["noise"]["ratio"]})
                    md.append(f"| {run} | {axis} | {pid(best['pid'])} | {fl(best['gyroScale'], best['dtermScale'])} | {f(best['crossoverHz'])} | {f(best['pmDeg'])} | {f(best['gmDb'])} | {f(best['sDb'], 2)} | {f(best['noise']['ratio'], 2)} | {'yes' if meets(best) else 'no: ' + ', '.join(misses(best))} | {role} |")
        md.append(f"| {run} | – | joint status | {j.get('status')} | – | – | – | – | – | – | {'; '.join(j.get('reasons') or [])[:160]} ({j.get('candidatesUsable')} usable of {j.get('candidatesTried')}, {j.get('searchMs')} ms) |")
    md += ["", "## Noise evidence per run", ""]
    for path in sorted(glob.glob(str(src / "air65_trace_*.json"))):
        g = json.loads(Path(path).read_text())
        j = g.get("joint") or {}
        chain = g.get("chain") or {}
        val = ", ".join(f"axis {v['axis']}: control {v['controlBand']}, noise band {v['noiseBand']}" for v in chain.get("validation") or [])
        ns = [p for p in j.get("parameters") or [] if not p["searched"]]
        s_ = [p["key"] for p in j.get("parameters") or [] if p["searched"]]
        md.append(f"- **{g['run']}**: chain validation {val or 'none'}; notes {chain.get('notes') or []}; searched: {', '.join(s_) or 'none'}; not searched: " + "; ".join(f"{p['key']} ({', '.join(p['missing'])})" for p in ns))
    (out / "air65_joint_compare.md").write_text("\n".join(md) + "\n")
    (out / "air65_joint_compare.json").write_text(json.dumps(rows, indent=1, default=float) + "\n")
    print("\n".join(md))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Regression case of protocol v3: the v2 joint candidate (roll 70/55/27/36 with gyro lowpass ×1.5 and D-term lowpass ×1.25,
the "1.45× motor band" candidate of 2026-11-11) must be rejected by the every-axis motor rule.

Usage: regression_v2.py <v3 dossier> <v2 dossier> <engine.json>
  <engine.json>  the new engine on the v2 start logs (run_tune.sh's combined job form, with the probe
                 "regression_v2_candidate"), written by run_e2e_joint3.sh.
Reads the per-run hover measure (noise_metrics.py, protocol v3 window) the driver wrote to <v3>/regression/noise/<role>/<run>.json;
writes <v3>/regression/regression.json:
  engineChosen            the engine's joint choice on the v2 start logs (null: none), and whether it is the v2 candidate;
  predictedMaxMotorRatio  the engine's prediction for the v2 candidate (probe);
  measuredMotorRatios     per motor, median over the three v2 candidate runs / median over the three v2 start runs;
  holds                   engine does not choose it, prediction > limit, measured > limit (with no clipping and a valid
                          spread), else false with the reason.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def main() -> int:
    v3, v2, eng_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    proto = json.loads((v3 / "protocol.json").read_text())
    rule = proto["motorRule"]
    reg = proto["regression"]
    out = {"candidate": reg["candidate"], "gyroScale": reg["gyroScale"], "dtermScale": reg["dtermScale"], "limit": rule["maxMotorRatio"]}
    eng = json.loads(eng_path.read_text())
    j = eng.get("joint") or {}
    ch = j.get("chosen")
    out["engineStatus"] = j.get("status")
    out["engineChosen"] = ch and {"gyroScale": ch["gyroScale"], "dtermScale": ch["dtermScale"], "pids": {a: x["read"]["pid"] for a, x in ch["axes"].items()}}
    is_v2 = bool(ch) and ch["gyroScale"] == reg["gyroScale"] and ch["dtermScale"] == reg["dtermScale"] and (ch["axes"].get("roll") or {}).get("read", {}).get("pid") == reg["candidate"]["roll"]
    out["engineChoosesIt"] = is_v2
    probe = next((p for p in j.get("probes") or [] if p["label"] == "regression_v2_candidate"), None)
    out["predictedMotorRatios"] = probe and probe["motor"]["motorRatios"]
    out["predictedMaxMotorRatio"] = probe and probe["motor"]["maxMotorRatio"]
    out["predictedAxisRatios"] = probe and probe["motor"]["axisRatios"]
    hov = {}
    issues = []
    for role in ("start", "candidate"):
        rows = [json.loads(p.read_text()) for p in sorted((v3 / "regression" / "noise" / role).glob("*.json"))]
        for r in rows:
            if (r.get("motorClip") or 0) > 0:
                issues.append(f"{role}:motor_clip")
            if (r.get("hover") or {}).get("samples", 0) < rule["minHoverSamples"]:
                issues.append(f"{role}:hover_samples_{(r.get('hover') or {}).get('samples')}")
        med = [statistics.median(r["motorBandHover"][m] for r in rows) for m in range(4)]
        spread = [(max(r["motorBandHover"][m] for r in rows) - min(r["motorBandHover"][m] for r in rows)) / med[m] for m in range(4)]
        if any(s > rule["maxRunSpreadRel"] for s in spread):
            issues.append(f"{role}:run_spread_{[round(s, 3) for s in spread]}")
        axis = [statistics.median(r["axisCtrlHover"][a] for r in rows) for a in range(3)]
        hov[role] = {"n": len(rows), "motorHoverMedian": med, "motorHoverSpreadRel": spread, "axisCtrlHoverMedian": axis}
    out["hover"] = hov
    out["measuredMotorRatios"] = [c / s for c, s in zip(hov["candidate"]["motorHoverMedian"], hov["start"]["motorHoverMedian"])]
    out["measuredAxisRatios"] = [c / s if s else None for c, s in zip(hov["candidate"]["axisCtrlHoverMedian"], hov["start"]["axisCtrlHoverMedian"])]
    out["issues"] = issues
    # The ratio the v2 report quoted (old window: from 2 s on, with disarmed time, take-off and the CHIRP), for recognition.
    v2v = json.loads((v2 / "verdict.json").read_text())
    out["v2ReportedMotorNoiseRatio"] = (v2v.get("candidate") or {}).get("motorNoiseRatio")
    why = []
    if is_v2:
        why.append("the engine still chooses the v2 candidate")
    if not out["predictedMaxMotorRatio"] or out["predictedMaxMotorRatio"] <= rule["maxMotorRatio"]:
        why.append(f"predicted max motor ratio {out['predictedMaxMotorRatio']} not above the limit")
    if issues:
        why.append(f"measurement not valid: {issues}")
    if max(out["measuredMotorRatios"]) <= rule["maxMotorRatio"]:
        why.append(f"measured motor ratios {out['measuredMotorRatios']} not above the limit")
    out["holds"] = not why
    out["why"] = "; ".join(why) or None
    (v3 / "regression" / "regression.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: out[k] for k in ("engineStatus", "engineChoosesIt", "predictedMaxMotorRatio", "measuredMotorRatios", "v2ReportedMotorNoiseRatio", "holds", "why")}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

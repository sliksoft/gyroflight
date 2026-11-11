"""Summarise one run_tune.sh output directory: per run the independent reference (fc, PM, GM, |S|), its validity,
the GyroFlight engine's read of the same log, and medians over the repeats. Writes <out>/summary.json.

Usage: summarize_tune.py <out dir>
Validity per run (PROTOCOL.md of the loop-reference test, limits reused): sample period 1.000 ms, generator 2–100 Hz,
coherence of G and C_D >= 0.99 on every bin in 5–50 Hz, |PM(I) − PM(I=0)| <= 3°. GM counts as assessable only with a
phase crossing inside 5–85 Hz and reference coherence >= 0.99 there (limit 4); otherwise it is reported but not used.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

TARGETS = {"pmDeg": 45.0, "gmDb": 6.0, "sDb": 6.0}
GM_BAND = (5.0, 85.0)


def meets(fc, pm, gm, s):
    return pm is not None and pm >= TARGETS["pmDeg"] and gm is not None and gm >= TARGETS["gmDb"] and s is not None and s <= TARGETS["sDb"]


def main() -> int:
    out = Path(sys.argv[1])
    prov = json.loads((out / "provenance.json").read_text())
    runs = json.loads((out / "runs.json").read_text())
    tune = prov["tune"]
    rows = []
    for run in runs:
        d = Path(run["dir"])
        row = {**run, "status": "ok", "issues": [], "ref": None, "gf": None}
        r = json.loads((d / "result.json").read_text()) if (d / "result.json").is_file() else None
        if not r or r.get("status") != "ok":
            row["status"] = "INSUFFICIENT"
            row["issues"].append(f"sitl:{None if not r else r.get('reason')}")
            rows.append(row)
            continue
        h = r["header"]["values"]
        want_pid = f"{tune['p']},{tune['i']},{tune['d']}"
        if h.get("rollPID") != want_pid or not h.get("d_max", "").startswith(f"{tune['dMax']},"):
            row["issues"].append(f"header:rollPID={h.get('rollPID')} d_max={h.get('d_max')} (wanted {want_pid}, {tune['dMax']})")
        if h.get("blackbox_high_resolution") != "1" or h.get("debug_mode") != "96" or h.get("looptime") != "1000":
            row["issues"].append(f"header:hires={h.get('blackbox_high_resolution')} debug={h.get('debug_mode')} looptime={h.get('looptime')}")
        # Filter settings the run was asked for (joint proof): each checked in the header (dyn min/max share one header key).
        HEADER_OF = {"gyro_lpf1_dyn_min_hz": ("gyro_lpf1_dyn_hz", 0), "gyro_lpf1_dyn_max_hz": ("gyro_lpf1_dyn_hz", 1),
                     "dterm_lpf1_dyn_min_hz": ("dterm_lpf1_dyn_hz", 0), "dterm_lpf1_dyn_max_hz": ("dterm_lpf1_dyn_hz", 1),
                     "p_pitch": ("pitchPID", 0), "i_pitch": ("pitchPID", 1), "d_pitch": ("pitchPID", 2), "d_max_pitch": ("d_max", 1),
                     "p_yaw": ("yawPID", 0), "i_yaw": ("yawPID", 1), "d_yaw": ("yawPID", 2)}
        for key, want in (prov.get("settings") or {}).items():
            hk, idx = HEADER_OF.get(key, (key, 0))
            got = (h.get(hk) or "").split(",")
            got_v = got[idx] if idx < len(got) else None
            if got_v is None or int(got_v) != int(want):
                row["issues"].append(f"header:{key}={got_v} (wanted {want})")
        if prov.get("logGyroUnfilt") and "gyroUnfilt[0]" not in (h.get("Field I name") or ""):
            row["issues"].append("header:gyroUnfilt_not_logged")
        noise_req = prov.get("gyroNoise")
        got_noise = r.get("gyroNoise")
        if noise_req and (not got_noise or abs(float(got_noise.get("stdDps", -1)) - float(noise_req["stdDps"])) > 1e-9 or int(got_noise.get("seed", -1)) != int(noise_req["seed"])):
            row["issues"].append(f"sitl:gyro_noise_not_applied:{got_noise}")
        row["gyroNoise"] = got_noise
        row["header"] = {k: h.get(k) for k in ("rollPID", "pitchPID", "d_max", "debug_mode", "looptime", "blackbox_high_resolution", "Firmware revision",
                                                 "gyro_lpf1_static_hz", "gyro_lpf1_dyn_hz", "gyro_lpf2_static_hz", "dterm_lpf1_static_hz", "dterm_lpf1_dyn_hz", "dterm_lpf2_static_hz")}
        nz = json.loads((d / "noise.json").read_text()) if (d / "noise.json").is_file() else None
        row["noise"] = nz if nz and nz.get("status") == "ok" else None
        row["logSha256"] = r.get("blackbox_log_sha256")
        row["plant"] = r.get("plant")
        if (r.get("plant") or {}).get("maxAbsRollDeg", 0) > 45 or (r.get("plant") or {}).get("minZ", 1) < 0.3:
            row["issues"].append("envelope")
        ref = json.loads((d / "reference.json").read_text()) if (d / "reference.json").is_file() else None
        if not ref or ref.get("status") != "ok":
            row["status"] = "INSUFFICIENT"
            row["issues"].append(f"reference:{None if not ref else ref.get('reason')}")
            rows.append(row)
            continue
        m = ref["margins"]
        if abs(ref["samplePeriodMaxS"] - 0.001) > 1e-6:
            row["issues"].append(f"reference:sample_period_{ref['samplePeriodMaxS']}")
        if not (abs(ref["generatorHz"][0] - 2.0) < 0.3 and abs(ref["generatorHz"][1] - 100.0) < 1.0):
            row["issues"].append(f"reference:generator_{ref['generatorHz']}")
        if m["minCoherencePlantInBand"] < 0.99 or m["minCoherenceDtermInBand"] < 0.99:
            row["issues"].append(f"reference:coherence_G{m['minCoherencePlantInBand']:.3f}_D{m['minCoherenceDtermInBand']:.3f}")
        if m["crossoverHz"] is None:
            row["issues"].append("reference:no_crossover")
        i0 = ref["marginsIZero"]
        sens = None
        if m["phaseMarginDeg"] is not None and i0["phaseMarginDeg"] is not None:
            sens = m["phaseMarginDeg"] - i0["phaseMarginDeg"]
            if abs(sens) > 3:
                row["issues"].append("reference:iterm_state_pm_>3deg")
        gm_ok = (
            m.get("gainMarginDb") is not None
            and m.get("phaseCrossingHz") is not None
            and GM_BAND[0] <= m["phaseCrossingHz"] <= GM_BAND[1]
            and (m.get("coherenceAtPhaseCrossing") or 0) >= 0.99
        )
        row["ref"] = {
            "fc": m["crossoverHz"], "pm": m["phaseMarginDeg"], "gm": m.get("gainMarginDb"), "gmHz": m.get("phaseCrossingHz"),
            "gmCoherence": m.get("coherenceAtPhaseCrossing"), "gmAssessable": gm_ok, "s": m["sensitivityPeakDb"], "sHz": m["sensitivityPeakHz"],
            "kp": ref["kp"], "pmItermSensitivityDeg": sens, "minCohG": m["minCoherencePlantInBand"], "minCohD": m["minCoherenceDtermInBand"],
            "meetsTargets": bool(gm_ok and meets(m["crossoverHz"], m["phaseMarginDeg"], m["gainMarginDb"], m["sensitivityPeakDb"])),
        }
        if any(x.startswith("reference:") for x in row["issues"]):
            row["status"] = "INSUFFICIENT"
        # Block 13: the pitch sweep's own reference (two-axis runs), the same validity rules.
        if (prov.get("sweeps") or 1) >= 2:
            refp = json.loads((d / "reference_pitch.json").read_text()) if (d / "reference_pitch.json").is_file() else None
            if not refp or refp.get("status") != "ok":
                row["status"] = "INSUFFICIENT"
                row["issues"].append(f"reference_pitch:{None if not refp else refp.get('reason')}")
                row["refPitch"] = None
            else:
                mp = refp["margins"]
                if mp["minCoherencePlantInBand"] < 0.99 or mp["minCoherenceDtermInBand"] < 0.99:
                    row["issues"].append(f"reference_pitch:coherence_G{mp['minCoherencePlantInBand']:.3f}_D{mp['minCoherenceDtermInBand']:.3f}")
                if not (abs(refp["generatorHz"][0] - 2.0) < 0.3 and abs(refp["generatorHz"][1] - 100.0) < 1.0):
                    row["issues"].append(f"reference_pitch:generator_{refp['generatorHz']}")
                if mp["crossoverHz"] is None:
                    row["issues"].append("reference_pitch:no_crossover")
                i0p = refp["marginsIZero"]
                sensp = mp["phaseMarginDeg"] - i0p["phaseMarginDeg"] if mp["phaseMarginDeg"] is not None and i0p["phaseMarginDeg"] is not None else None
                if sensp is not None and abs(sensp) > 3:
                    row["issues"].append("reference_pitch:iterm_state_pm_>3deg")
                gm_okp = (mp.get("gainMarginDb") is not None and mp.get("phaseCrossingHz") is not None
                          and GM_BAND[0] <= mp["phaseCrossingHz"] <= GM_BAND[1] and (mp.get("coherenceAtPhaseCrossing") or 0) >= 0.99)
                row["refPitch"] = {
                    "fc": mp["crossoverHz"], "pm": mp["phaseMarginDeg"], "gm": mp.get("gainMarginDb"), "gmHz": mp.get("phaseCrossingHz"),
                    "gmCoherence": mp.get("coherenceAtPhaseCrossing"), "gmAssessable": gm_okp, "s": mp["sensitivityPeakDb"], "sHz": mp["sensitivityPeakHz"],
                    "kp": refp["kp"], "pmItermSensitivityDeg": sensp, "minCohG": mp["minCoherencePlantInBand"], "minCohD": mp["minCoherenceDtermInBand"],
                    "meetsTargets": bool(gm_okp and meets(mp["crossoverHz"], mp["phaseMarginDeg"], mp["gainMarginDb"], mp["sensitivityPeakDb"])),
                }
                if any(x.startswith("reference_pitch:") for x in row["issues"]):
                    row["status"] = "INSUFFICIENT"
        # Per-motor hover measure (protocol v3): band power per motor, clip check.
        if row.get("noise") and row["noise"].get("motorBandHover") is not None:
            if (row["noise"].get("motorClip") or 0) > 0:
                row["issues"].append(f"noise:motor_clip_{row['noise']['motorClip']:.4f}")
            if (row["noise"].get("hover") or {}).get("samples", 0) < 3072:
                row["issues"].append(f"noise:hover_samples_{(row['noise'].get('hover') or {}).get('samples')}")
        gf = json.loads((d / "gyroflight.json").read_text()) if (d / "gyroflight.json").is_file() else None
        if gf and gf.get("margins"):
            gm_ = gf["margins"]
            me = gm_["measured"]
            dec = ((gf.get("decisionRoll") or {}).get("primary")) or None
            row["gf"] = {
                "fc": gm_["crossoverHz"], "pm": me["phaseMarginDeg"], "gm": me["gainMarginDb"], "s": me["sensitivityPeakDb"],
                "evidence": gm_["evidence"]["level"], "band": gm_["evidence"]["bandHz"], "chirpState": (gf.get("chirpRoll") or {}).get("state"),
                "decisionStatus": dec and dec["status"], "candidate": dec and dec.get("candidate") and dec["candidate"]["proposed"],
            }
        rows.append(row)
    ok = [r for r in rows if r["status"] == "ok" and r["ref"]]
    med = lambda k: statistics.median(r["ref"][k] for r in ok) if ok and all(r["ref"][k] is not None for r in ok) else None  # noqa: E731
    summary = {
        "tune": tune,
        "n": len(rows),
        "nValid": len(ok),
        "runs": rows,
        "refMedian": {k: med(k) for k in ("fc", "pm", "gm", "s")} if ok else None,
        "refSpread": {k: (max(r["ref"][k] for r in ok) - min(r["ref"][k] for r in ok)) if ok and all(r["ref"][k] is not None for r in ok) else None for k in ("fc", "pm", "gm", "s")} if ok else None,
        "gmAssessableAll": bool(ok) and all(r["ref"]["gmAssessable"] for r in ok),
        "gfMedian": None,
        "combined": None,
        "settings": prov.get("settings") or {},
        "gyroNoise": prov.get("gyroNoise"),
        "noiseMedian": None,
    }
    # Two-axis runs: pitch medians, spreads, GM assessable.
    okp = [r for r in ok if r.get("refPitch")]
    if (prov.get("sweeps") or 1) >= 2:
        medp = lambda k: statistics.median(r["refPitch"][k] for r in okp) if okp and all(r["refPitch"][k] is not None for r in okp) else None  # noqa: E731
        summary["refPitchMedian"] = {k: medp(k) for k in ("fc", "pm", "gm", "s")} if okp else None
        summary["refPitchSpread"] = {k: (max(r["refPitch"][k] for r in okp) - min(r["refPitch"][k] for r in okp)) if okp and all(r["refPitch"][k] is not None for r in okp) else None for k in ("fc", "pm", "gm", "s")} if okp else None
        summary["gmAssessableAllPitch"] = bool(okp) and len(okp) == len(ok) and all(r["refPitch"]["gmAssessable"] for r in okp)
    # Per-motor hover medians and spreads (protocol v3); the clip and hover-length issues are per run.
    hov = [r["noise"] for r in ok if r.get("noise") and r["noise"].get("motorBandHover")]
    if hov:
        nm_ = len(hov[0]["motorBandHover"])
        summary["motorHoverMedian"] = [statistics.median(h["motorBandHover"][m] for h in hov) for m in range(nm_)]
        summary["motorHoverSpreadRel"] = [(max(h["motorBandHover"][m] for h in hov) - min(h["motorBandHover"][m] for h in hov)) / statistics.median(h["motorBandHover"][m] for h in hov) for m in range(nm_)]
        summary["axisCtrlHoverMedian"] = [statistics.median(h["axisCtrlHover"][a] for h in hov) if all(h["axisCtrlHover"][a] is not None for h in hov) else None for a in range(3)]
        summary["motorIssues"] = [i for r in ok for i in r["issues"] if i.startswith("noise:")]
    nzs = [r["noise"] for r in ok if r.get("noise")]
    if nzs:
        summary["noiseMedian"] = {k: statistics.median(n[k] for n in nzs) if all(n.get(k) is not None for n in nzs) else None for k in ("gyroBand", "ptermBand", "dtermBand", "pidSumBand", "ctrlBand", "motorBand", "kp")}
    gfs = [r["gf"] for r in ok if r["gf"] and r["gf"]["fc"] is not None and r["gf"]["pm"] is not None]
    if gfs:
        summary["gfMedian"] = {k: statistics.median(g[k] for g in gfs) if all(g[k] is not None for g in gfs) else None for k in ("fc", "pm", "gm", "s")}
    if summary["refMedian"]:
        rm = summary["refMedian"]
        summary["refMeetsTargets"] = bool(summary["gmAssessableAll"] and meets(rm["fc"], rm["pm"], rm["gm"], rm["s"]))
        summary["refMisses"] = [k for k, ok_ in (("pm", rm["pm"] is not None and rm["pm"] >= 45), ("gm", rm["gm"] is not None and rm["gm"] >= 6), ("s", rm["s"] is not None and rm["s"] <= 6)) if not ok_]
    comb = out / "gyroflight.combined.json"
    if comb.is_file():
        g = json.loads(comb.read_text())
        dec = ((g.get("decisionRoll") or {}).get("primary")) or None
        c = dec and dec.get("candidate")
        pm_ = c and c["proposedMargins"]
        summary["combined"] = {
            "file": str(comb),
            "others": g.get("others"),
            "current": dec and dec.get("current"),
            "status": dec and dec["status"],
            "firstCause": dec and dec.get("firstCause") and {"rule": dec["firstCause"]["rule"], "value": dec["firstCause"]["value"]},
            "candidate": c and {"proposed": c["proposed"], "outcome": c["outcome"], "changed": c["changed"],
                                 "fc": pm_["crossoverHz"], "pm": pm_["phaseMarginDeg"],
                                 "gm": pm_["gainMarginDb"] if pm_["gainMarginDb"] is not None else pm_["measured"]["gainMarginDb"],
                                 "s": pm_["sensitivityPeakDb"] if pm_["sensitivityPeakDb"] is not None else pm_["measured"]["sensitivityPeakDb"]},
            "searchRan": dec and dec.get("searchRan"), "tried": dec and dec.get("candidatesTried"), "usable": dec and dec.get("candidatesUsable"),
            "combination": dec and dec.get("combination") and {k: dec["combination"][k] for k in ("flights", "rejected", "consistent", "commonBins")},
        }
        # Joint PID + filter search (block 12) and the experimental items the app would build from it.
        j = g.get("joint")
        ch = j and j.get("chosen")
        roll = ch and (ch.get("axes") or {}).get("roll")
        summary["combined"]["joint"] = j and {
            "status": j["status"], "reasons": j["reasons"], "tried": j["candidatesTried"], "usable": j["candidatesUsable"], "searchMs": j.get("searchMs"),
            "searched": j["searched"], "currentFilters": j["current"]["filters"],
            "parametersNotSearched": [{"key": p["key"], "missing": p["missing"]} for p in j["parameters"] if not p["searched"]],
            "chosen": ch and {"gyroScale": ch["gyroScale"], "dtermScale": ch["dtermScale"], "filters": ch["filters"], "reason": ch["reason"], "pidOnly": ch["pidOnly"],
                              "roll": roll and {"pid": roll["read"]["pid"], "fc": roll["read"]["crossoverHz"], "pm": roll["read"]["pmDeg"], "gm": roll["read"]["gmDb"], "s": roll["read"]["sDb"],
                                                "noise": roll["read"]["noise"], "crossoverGain": roll["read"]["crossoverGain"], "outcome": roll["proposal"]["outcome"]}},
            "pidOnlyRoll": (j.get("pidOnly") or {}).get("roll"),
        }
        summary["combined"]["experimentalItems"] = (g.get("experimental") or {}).get("items") if g.get("experimental") else None
    (out / "summary.json").write_text(json.dumps(summary, indent=1, default=float) + "\n")
    f = lambda v, p=1: "–" if v is None else f"{v:.{p}f}"  # noqa: E731
    print(f"tune {tune['p']}/{tune['i']}/{tune['d']}/{tune['dMax']}: {len(ok)}/{len(rows)} valid runs")
    for r in rows:
        rf, gf = r.get("ref") or {}, r.get("gf") or {}
        print(f"  {r['id']}: ref fc {f(rf.get('fc'))} PM {f(rf.get('pm'))} GM {f(rf.get('gm'))}{'' if rf.get('gmAssessable') else ' (not assessable)'} |S| {f(rf.get('s'), 2)}"
              f" | GF fc {f(gf.get('fc'))} PM {f(gf.get('pm'))} GM {f(gf.get('gm'))} |S| {f(gf.get('s'), 2)} {gf.get('decisionStatus') or ''} {r['status']} {';'.join(r['issues'])}")
    if summary["refMedian"]:
        rm = summary["refMedian"]
        print(f"  median ref: fc {f(rm['fc'])} PM {f(rm['pm'])} GM {f(rm['gm'])} |S| {f(rm['s'], 2)} meets={summary.get('refMeetsTargets')} misses={summary.get('refMisses')} gmAssessableAll={summary['gmAssessableAll']}")
    if summary.get("refPitchMedian"):
        rp = summary["refPitchMedian"]
        print(f"  median ref pitch: fc {f(rp['fc'])} PM {f(rp['pm'])} GM {f(rp['gm'])} |S| {f(rp['s'], 2)} gmAssessableAll={summary.get('gmAssessableAllPitch')} spread PM {f((summary.get('refPitchSpread') or {}).get('pm'), 3)}")
    if summary.get("motorHoverMedian"):
        print(f"  hover per motor (100–500 Hz): {[round(x, 4) for x in summary['motorHoverMedian']]} spread {[round(x, 3) for x in summary['motorHoverSpreadRel']]} axis P+D {[None if x is None else round(x, 4) for x in summary['axisCtrlHoverMedian']]} issues {summary.get('motorIssues')}")
    if summary["noiseMedian"]:
        nm = summary["noiseMedian"]
        print(f"  median noise bands (100–500 Hz): gyro {nm['gyroBand']:.4g} P {nm['ptermBand']:.4g} D {nm['dtermBand']:.4g} pidSum {nm['pidSumBand']:.4g} ctrl(Kp·gyro+D) {nm['ctrlBand'] and round(nm['ctrlBand'], 4)} motors {nm['motorBand']:.4g}")
    if summary["combined"]:
        c = summary["combined"]
        print(f"  engine (combined {len(c.get('others') or [])+1} logs): {c['status']} cand {c['candidate'] and c['candidate']['proposed']} "
              f"{c['candidate'] and 'fc %.1f PM %.1f GM %.1f |S| %.2f' % (c['candidate']['fc'], c['candidate']['pm'], c['candidate']['gm'], c['candidate']['s'])}")
        j = c.get("joint")
        if j:
            ch = j.get("chosen")
            print(f"  joint: {j['status']} ({j['usable']} usable of {j['tried']}, {j.get('searchMs')} ms) " + (f"chosen gyro x{ch['gyroScale']} dterm x{ch['dtermScale']} roll {ch['roll'] and ch['roll']['pid']} "
                  f"{ch['roll'] and 'fc %.1f PM %.1f GM %.1f |S| %.2f noise %.2f' % (ch['roll']['fc'], ch['roll']['pm'], ch['roll']['gm'], ch['roll']['s'], ch['roll']['noise']['ratio'] or float('nan'))}" if ch else "no chosen"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

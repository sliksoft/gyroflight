"""Verdict of the end-to-end joint PID + filter autotune proof (dossier PROTOCOL.md v2, fixed before Calculate).

Usage: e2e_joint_verdict.py <dossier dir>
Reads protocol.json, start/summary.json, control/summary.json, app/tuning_and_apply.json, app/candidate.json, app/engine.json
(the engine on the same logs, from run_tune.sh's combined job) and candidate/summary.json; writes VERDICT.md and verdict.json.

Verdict rules (protocol v2):
  INSUFFICIENT  the start is not measured (3/3 valid, GM assessable, PM spread < 1°) or does not miss a target; the PID-only
                search of the engine on the start logs already offers a candidate (the scenario does not need filters); the
                positive control fails (not a point of the joint search space, or its reference does not meet all three targets
                with GM assessable, or it does not improve as required, or its independent noise ratio exceeds the allowance);
                a tune the verdict needs is not measured or not remeasured.
  FAIL          first decisive step: (1) candidate_missing_in_grid — the chosen candidate is not a point of the joint search
                space (PID on the ±30 % grid at 0.1 steps, every gyro lowpass cutoff scaled by one scale of the gyro set, every
                D-term lowpass cutoff by one scale of the D-term set); (2) candidate_rejected — the app shows no PID + filter
                proposal for roll (PID-only items, an informative step only, a block, or an Apply route blocked for a reason
                about the candidate itself); (3) remeasurement_does_not_confirm — the remeasured reference misses a target,
                does not improve as required, or its independent controller-output noise ratio (Kp·gyro + D, 100–500 Hz)
                exceeds the allowance.
  PASS          the app chose a roll PID + filter candidate on its own (a proposal with filter items, Apply route), its
                remeasured reference meets PM >= 45°, GM >= 6 dB (assessable), |S| <= 6 dB, improves every target the start
                misses by at least the reference tolerance (PM 5°, GM 1.5 dB, |S| 1 dB) while no met target is lost, and the
                remeasured controller-output noise band power (Kp·gyro + D, 100–500 Hz, independent reference) is at most
                1.1 × the start's (noiseRule.maxCtrlBandRatio); the pidSum and motor band ratios are reported beside it.
Prediction accuracy (app's predicted margins and noise ratio of the candidate vs the remeasured reference) is reported
separately: margins with the loop-reference tolerances (fc 10 %, PM 5°, |S| 1 dB, GM 1.5 dB), the noise ratio with an absolute
tolerance of 0.25 (informative: a new, uncalibrated metric).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_verdict import TARGETS, TOL, improvement, js_round, misses  # noqa: E402

GYRO_KEYS = ["gyro_lpf1_static_hz", "gyro_lpf1_dyn_min_hz", "gyro_lpf1_dyn_max_hz", "gyro_lpf2_static_hz"]
DTERM_KEYS = ["dterm_lpf1_static_hz", "dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_max_hz", "dterm_lpf2_static_hz"]
# Blocks of the experimental Apply route that do not reject the candidate itself (see e2e_verdict.py).
APPLY_BLOCKS_NOT_ABOUT_THE_CANDIDATE = {"fc:not_connected", "experimental:not_acknowledged", "fc_identity_binding:log_board_missing"}


def pid_scales(step: float) -> list[float]:
    out = []
    k = round(0.7 / step)
    while k * step <= 1.3 + 1e-9:
        out.append(round(k * step, 2))
        k += 1
    return out


def joint_pid_point(start: dict, v: dict, step: float) -> bool:
    """Is v a point of the joint PID grid around start (jointSearch jointPidGrid: P, I, D each on 0.7..1.3 at `step`, d_max on D's scale)?"""
    scales = pid_scales(step)
    for ps in scales:
        if js_round(start["p"] * ps) != v["p"]:
            continue
        for is_ in scales if start["i"] > 0 else [1]:
            if js_round(start["i"] * is_) != v["i"]:
                continue
            for ds in scales if start["d"] > 0 else [1]:
                d = js_round(start["d"] * ds)
                dmax = max(js_round(start["dMax"] * ds), d) if start["dMax"] > 0 else 0
                if d == v["d"] and dmax == v["dMax"]:
                    return True
    return False


def clamp_hz(x: float) -> int:
    return int(min(1000, max(0, js_round(x))))


def filter_scale(start: dict, cand: dict, keys: list[str], scales: list[float]) -> float | None:
    """The one scale of `scales` that maps every start cutoff of `keys` onto the candidate's (as jointSearch scaledChain /
    scaledDterm form them: Math.round, clamped 0–1000); None when no scale fits."""
    for s in scales:
        if all(clamp_hz(int(start[k]) * s) == int(cand[k]) for k in keys if k in start and k in cand):
            return s
    return None


def noise_ratio(cand: dict | None, start: dict | None, key: str = "ctrlBand") -> float | None:
    a = (cand or {}).get("noiseMedian") or {}
    b = (start or {}).get("noiseMedian") or {}
    if a.get(key) is None or not b.get(key):
        return None
    return a[key] / b[key]


def main() -> int:
    dossier = Path(sys.argv[1])
    proto = json.loads((dossier / "protocol.json").read_text())
    load = lambda rel: json.loads((dossier / rel).read_text()) if (dossier / rel).is_file() else None  # noqa: E731
    start = load("start/summary.json")
    control = load("control/summary.json")
    app = load("app/tuning_and_apply.json")
    cand_file = load("app/candidate.json")
    engine = load("app/engine.json")
    cand = load("candidate/summary.json")
    space = proto["jointSpace"]
    noise_rule = proto["noiseRule"]
    v = {"protocol": proto, "steps": [], "verdict": None, "firstDecisiveStep": None, "prediction": None}
    notes = v["steps"]

    def stop(verdict, why):
        v["verdict"] = verdict
        v["why"] = why
        notes.append(f"{verdict}: {why}")

    prov = load("provenance.json")
    if not prov:
        notes.append("WARNING: provenance.json missing (code, build and input not recorded before the run)")
    else:
        if prov.get("gyroflightDirty"):
            notes.append(f"WARNING: GyroFlight worktree not clean at the start of the proof: {prov['gyroflightDirty'].strip()}")
        notes.append(f"provenance: GyroFlight {prov.get('gyroflightHead')}, VliegAI {prov.get('vliegaiHead')}, ELF {str(prov.get('elfSha256'))[:12]}…, protocol.json {str(prov.get('protocolSha256'))[:12]}…")

    start_tune = dict(proto["start"])
    start_settings = start_tune.get("settings") or {}
    # 1. start: measured, room for improvement, GM assessable, repeats, noise applied, PID-only finds nothing
    sm = None
    if not start or not start.get("refMedian"):
        stop("INSUFFICIENT", "start tune not measured")
    else:
        sm = start["refMedian"]
        v["start"] = {"tune": start["tune"], "settings": start.get("settings"), "ref": sm, "spread": start["refSpread"], "gmAssessableAll": start["gmAssessableAll"],
                      "misses": misses(sm), "gf": start.get("gfMedian"), "noise": start.get("noiseMedian"), "gyroNoise": start.get("gyroNoise"), "nValid": start["nValid"], "n": start["n"]}
        comb = start.get("combined") or {}
        if start["nValid"] != start["n"]:
            stop("INSUFFICIENT", f"start: {start['nValid']}/{start['n']} valid runs: " + "; ".join(i for r in start["runs"] for i in r["issues"]))
        elif not start["gmAssessableAll"]:
            stop("INSUFFICIENT", "start: GM not assessable (phase crossing outside 5–85 Hz or coherence < 0.99)")
        elif start["refSpread"]["pm"] >= TOL["repeatPmDeg"]:
            stop("INSUFFICIENT", f"start: PM spread {start['refSpread']['pm']:.2f}° >= 1°")
        elif not misses(sm):
            stop("INSUFFICIENT", "start meets all three targets: no room for improvement under the protocol")
        elif not start.get("noiseMedian"):
            stop("INSUFFICIENT", "start: no independent noise reference")
        elif proto.get("requirePidOnlyNoCandidate", True) and comb.get("status") == "candidate_found":
            stop("INSUFFICIENT", f"the PID-only search already offers {comb.get('candidate', {}).get('proposed')} on the start logs: the scenario does not need filters")
        else:
            notes.append(f"start {start['tune']} {start_settings}: ref fc {sm['fc']:.1f} Hz, PM {sm['pm']:.1f}°, GM {sm['gm']:.1f} dB, |S| {sm['s']:.2f} dB; misses {misses(sm)}; PID-only engine status {comb.get('status')}")
    # 2. positive control: in the joint space, meets, improves, noise within allowance
    if v["verdict"] is None:
        if not control or not control.get("refMedian"):
            stop("INSUFFICIENT", "positive control not measured")
        else:
            cm = control["refMedian"]
            cs = control.get("settings") or {}
            in_pid = joint_pid_point(start["tune"], control["tune"], space["pidStep"])
            sg = filter_scale(start_settings, cs, GYRO_KEYS, space["gyroLpfScales"])
            sd = filter_scale(start_settings, cs, DTERM_KEYS, space["dtermLpfScales"])
            imp = improvement(sm, cm, misses(sm))
            nr = noise_ratio(control, start)
            v["control"] = {"tune": control["tune"], "settings": cs, "ref": cm, "spread": control["refSpread"], "gmAssessableAll": control["gmAssessableAll"], "inPidGrid": in_pid,
                            "gyroScale": sg, "dtermScale": sd, "meetsTargets": control.get("refMeetsTargets"), "improvement": imp, "noiseRatio": nr, "noise": control.get("noiseMedian"),
                            "nValid": control["nValid"], "n": control["n"]}
            if control["nValid"] != control["n"]:
                stop("INSUFFICIENT", f"control: {control['nValid']}/{control['n']} valid runs")
            elif not in_pid or sg is None or sd is None:
                v["firstDecisiveStep"] = "candidate_missing_in_grid"
                stop("FAIL", f"positive control is not a point of the joint search space (PID in grid: {in_pid}, gyro scale {sg}, D-term scale {sd})")
            elif not control["gmAssessableAll"]:
                stop("INSUFFICIENT", "control: GM not assessable")
            elif not control.get("refMeetsTargets"):
                stop("INSUFFICIENT", f"positive control misses {misses(cm)}: no candidate inside the space is shown to meet the targets")
            elif not imp["ok"]:
                stop("INSUFFICIENT", f"positive control does not improve as required: {imp['detail']}")
            elif nr is None or nr > noise_rule["maxCtrlBandRatio"]:
                stop("INSUFFICIENT", f"positive control's independent noise ratio {nr} exceeds {noise_rule['maxPidSumBandRatio']}")
            elif control["refSpread"]["pm"] >= TOL["repeatPmDeg"]:
                stop("INSUFFICIENT", f"control: PM spread {control['refSpread']['pm']:.2f}° >= 1°")
            else:
                notes.append(f"positive control {control['tune']} gyro ×{sg}, D-term ×{sd}: ref fc {cm['fc']:.1f} Hz, PM {cm['pm']:.1f}°, GM {cm['gm']:.1f} dB, |S| {cm['s']:.2f} dB, noise ratio {nr:.2f} — in the space, meets all three, improvement {imp['detail']}")
    # 3. the app
    chosen = None
    pred = None
    if v["verdict"] is None:
        if not app or not cand_file:
            stop("INSUFFICIENT", "app step not recorded (app/tuning_and_apply.json or app/candidate.json missing)")
        else:
            read = app.get("read") or {}
            items = app.get("rollItems") or []
            fitems = app.get("filterItems") or []
            apply_btn = read.get("applyButton") or {}
            blocks = [b.strip() for b in "; ".join(read.get("blocks") or []).split(";") if b.strip()]
            candidate_blocks = [b for b in blocks if b not in APPLY_BLOCKS_NOT_ABOUT_THE_CANDIDATE]
            joint_items = bool(items) and bool(fitems) and all(it.get("source") == "joint_search" for it in items)
            shown = ("pid_and_filter_proposal" if joint_items and apply_btn.get("present") and not candidate_blocks
                     else "items_with_apply_route_blocked" if joint_items else read.get("jointShown"))
            chosen = cand_file.get("candidate") if items else None
            jeng = ((engine or {}).get("joint") or {}) if engine else {}
            jch = jeng.get("chosen") or {}
            jroll = (jch.get("axes") or {}).get("roll")
            eng_cand = jroll and {**jroll["read"]["pid"], "settings": {**start_settings, **{k: vv["to"] for k, vv in (jch.get("filters") or {}).items()}}}
            if jroll and chosen and eng_cand == chosen:
                r_ = jroll["read"]
                pred = {"fc": r_["crossoverHz"], "pm": r_["pmDeg"], "gm": r_["gmDb"], "s": r_["sDb"], "noiseRatio": r_["noise"]["ratio"]}
            aprov = load("app/provenance.json")
            v["app"] = {"shown": shown, "jointShownByPage": read.get("jointShown"), "rollShownByPage": read.get("rollShown"), "chosen": chosen, "applyButton": apply_btn,
                        "blocks": blocks, "blocksAboutTheCandidate": candidate_blocks, "itemStatuses": sorted({it.get("status") for it in items + fitems}),
                        "itemSources": sorted({it.get("source") for it in items + fitems}), "filterItems": cand_file.get("filterItems"),
                        "engineJointStatus": jeng.get("status"), "engineJointReasons": jeng.get("reasons"), "engineCandidate": eng_cand, "enginePredicted": pred,
                        "engineJointBlock": read.get("joint") and {k: read["joint"][k] for k in ("status", "statusText", "filters")}, "errs": app.get("errs"), "provenance": aprov}
            if not aprov:
                notes.append("WARNING: app/provenance.json missing")
            elif aprov.get("srcDirty"):
                notes.append(f"WARNING: src/ was not clean at Calculate: {aprov.get('srcDirty')}")
            if chosen:
                in_pid = joint_pid_point(start["tune"], {k: chosen[k] for k in ("p", "i", "d", "dMax")}, space["pidStep"])
                sg = filter_scale(start_settings, chosen["settings"], GYRO_KEYS, space["gyroLpfScales"])
                sd = filter_scale(start_settings, chosen["settings"], DTERM_KEYS, space["dtermLpfScales"])
                v["app"]["inPidGrid"], v["app"]["gyroScale"], v["app"]["dtermScale"] = in_pid, sg, sd
            if chosen and (not v["app"]["inPidGrid"] or v["app"]["gyroScale"] is None or v["app"]["dtermScale"] is None):
                v["firstDecisiveStep"] = "candidate_missing_in_grid"
                stop("FAIL", f"the chosen candidate {chosen} is not a point of the joint search space (PID in grid {v['app']['inPidGrid']}, gyro scale {v['app']['gyroScale']}, D-term scale {v['app']['dtermScale']})")
            elif shown != "pid_and_filter_proposal" or not chosen:
                v["firstDecisiveStep"] = "candidate_rejected"
                stop("FAIL", f"the app offers no roll PID + filter proposal ({shown}; roll items {len(items)}, filter items {len(fitems)}, blocks about the candidate {candidate_blocks}); engine joint status {jeng.get('status')}: {jeng.get('reasons')}")
            else:
                if eng_cand and eng_cand != chosen:
                    notes.append(f"WARNING: engine joint candidate {eng_cand} differs from the app's items {chosen}; no prediction accuracy reported")
                notes.append(f"app chose {chosen} (gyro ×{v['app']['gyroScale']}, D-term ×{v['app']['dtermScale']}; shown: {shown}; Apply route blocks {blocks}; item statuses {v['app']['itemStatuses']}, sources {v['app']['itemSources']}); predicted {pred}")
    # 4. remeasurement
    if v["verdict"] is None:
        if not cand or not cand.get("refMedian"):
            stop("INSUFFICIENT", "candidate not remeasured")
        elif cand["tune"] != {k: chosen[k] for k in ("p", "i", "d", "dMax")} or (cand.get("settings") or {}) != chosen["settings"]:
            stop("INSUFFICIENT", f"remeasured tune {cand['tune']} {cand.get('settings')} is not the chosen candidate {chosen}")
        else:
            rm = cand["refMedian"]
            imp = improvement(sm, rm, misses(sm))
            nr = noise_ratio(cand, start)
            nr_motor = noise_ratio(cand, start, "motorBand")
            nr_pidsum = noise_ratio(cand, start, "pidSumBand")
            v["candidate"] = {"tune": cand["tune"], "settings": cand.get("settings"), "ref": rm, "spread": cand["refSpread"], "gmAssessableAll": cand["gmAssessableAll"], "misses": misses(rm),
                              "improvement": imp, "noiseRatio": nr, "motorNoiseRatio": nr_motor, "pidSumNoiseRatio": nr_pidsum, "noise": cand.get("noiseMedian"), "nValid": cand["nValid"], "n": cand["n"], "gf": cand.get("gfMedian")}
            if cand["nValid"] != cand["n"]:
                stop("INSUFFICIENT", f"candidate: {cand['nValid']}/{cand['n']} valid runs: " + "; ".join(i for r in cand["runs"] for i in r["issues"]))
            elif not cand["gmAssessableAll"]:
                stop("INSUFFICIENT", "candidate: GM not assessable")
            elif cand["refSpread"]["pm"] >= TOL["repeatPmDeg"]:
                stop("INSUFFICIENT", f"candidate: PM spread {cand['refSpread']['pm']:.2f}° >= 1°")
            elif nr is None:
                stop("INSUFFICIENT", "candidate: no independent noise reference")
            elif misses(rm) or not imp["ok"] or nr > noise_rule["maxCtrlBandRatio"]:
                v["firstDecisiveStep"] = "remeasurement_does_not_confirm"
                stop("FAIL", f"remeasured candidate misses {misses(rm)}; improvement {imp['detail']}; noise ratio {nr:.2f} (allowed {noise_rule['maxPidSumBandRatio']})")
            else:
                v["verdict"] = "PASS"
                notes.append(f"PASS: remeasured {cand['tune']} {cand.get('settings')}: fc {rm['fc']:.1f} Hz, PM {rm['pm']:.1f}°, GM {rm['gm']:.1f} dB, |S| {rm['s']:.2f} dB; improvement {imp['detail']}; noise ratio {nr:.2f} (pidSum {nr_pidsum and round(nr_pidsum, 2)}, motors {nr_motor and round(nr_motor, 2)})")
            if pred:
                acc = {"fcRel": (pred["fc"] - rm["fc"]) / rm["fc"] if pred["fc"] and rm["fc"] else None,
                       "pmDeg": pred["pm"] - rm["pm"] if pred["pm"] is not None and rm["pm"] is not None else None,
                       "gmDb": pred["gm"] - rm["gm"] if pred["gm"] is not None and rm["gm"] is not None else None,
                       "sDb": pred["s"] - rm["s"] if pred["s"] is not None and rm["s"] is not None else None,
                       "noiseRatio": pred["noiseRatio"] - nr if pred["noiseRatio"] is not None and nr is not None else None}
                tol_n = proto.get("noisePredictionToleranceAbs", 0.25)
                acc["within"] = {"fc": acc["fcRel"] is not None and abs(acc["fcRel"]) <= TOL["fcRel"], "pm": acc["pmDeg"] is not None and abs(acc["pmDeg"]) <= TOL["pmDeg"],
                                 "gm": acc["gmDb"] is not None and abs(acc["gmDb"]) <= TOL["gmDb"], "s": acc["sDb"] is not None and abs(acc["sDb"]) <= TOL["sDb"],
                                 "noise": acc["noiseRatio"] is not None and abs(acc["noiseRatio"]) <= tol_n}
                v["prediction"] = {"predicted": pred, "remeasured": {**rm, "noiseRatio": nr}, "diff": acc, "tolerances": {**TOL, "noiseRatioAbs": tol_n}}
    (dossier / "verdict.json").write_text(json.dumps(v, indent=1, default=float) + "\n")
    f = lambda x, p=1: "–" if x is None else f"{x:.{p}f}"  # noqa: E731
    lines = [f"# E2E joint PID + filter proof — verdict: **{v['verdict']}**", ""]
    if v["firstDecisiveStep"]:
        lines.append(f"First decisive step: `{v['firstDecisiveStep']}`")
    lines += ["", "| tune | filters | role | fc (Hz) | PM (°) | GM (dB) | \\|S\\| (dB) | noise ratio | meets | n |", "|---|---|---|---|---|---|---|---|---|---|"]
    fl = lambda st: ", ".join(f"{k.replace('_hz', '').replace('_static', '').replace('gyro_lpf', 'g').replace('dterm_lpf', 'd').replace('_dyn_min', 'min').replace('_dyn_max', 'max')} {vv}" for k, vv in (st or {}).items())  # noqa: E731
    for role in ("start", "control", "candidate"):
        s = v.get(role)
        if s:
            m = s["ref"]
            nr = "1.00" if role == "start" else f(s.get("noiseRatio"), 2)
            lines.append(f"| {s['tune']['p']}/{s['tune']['i']}/{s['tune']['d']}/{s['tune']['dMax']} | {fl(s.get('settings'))} | {role} (reference) | {f(m['fc'])} | {f(m['pm'])} | {f(m['gm'])}{'' if s['gmAssessableAll'] else ' (not assessable)'} | {f(m['s'], 2)} | {nr} | {'yes' if not misses(m) and s['gmAssessableAll'] else 'no: ' + ','.join(misses(m))} | {s['nValid']}/{s['n']} |")
    a = v.get("app")
    if a and a.get("enginePredicted"):
        pr = a["enginePredicted"]
        c = a["chosen"]
        lines.append(f"| {c['p']}/{c['i']}/{c['d']}/{c['dMax']} | {fl(c['settings'])} | app prediction | {f(pr['fc'])} | {f(pr['pm'])} | {f(pr['gm'])} | {f(pr['s'], 2)} | {f(pr['noiseRatio'], 2)} | {'yes' if not misses(pr) else 'no'} | – |")
    if v.get("prediction"):
        d = v["prediction"]["diff"]
        lines += ["", f"Prediction vs remeasurement: fc {d['fcRel'] * 100:+.1f} % (±10 %: {d['within']['fc']}), PM {d['pmDeg']:+.1f}° (±5°: {d['within']['pm']}), GM {d['gmDb']:+.2f} dB (±1.5 dB: {d['within']['gm']}), |S| {d['sDb']:+.2f} dB (±1 dB: {d['within']['s']}), noise ratio {d['noiseRatio']:+.2f} (±{v['prediction']['tolerances']['noiseRatioAbs']}: {d['within']['noise']})."]
    lines += ["", "## Steps", ""] + [f"- {n}" for n in notes]
    (dossier / "VERDICT.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

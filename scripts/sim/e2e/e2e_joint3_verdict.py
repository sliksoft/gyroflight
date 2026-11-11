"""Verdict of the end-to-end joint PID + filter proof with the every-axis motor rule (block 13, PROTOCOL.md v3, fixed
before Calculate).

Usage: e2e_joint3_verdict.py <dossier dir>
       e2e_joint3_verdict.py --selftest   (the motor rule and the regression expectation on the fixtures of the 2026-11-11
                                           v2 proof, test/fixtures/sitl_e2e_joint_regression_v2: the 1.45× candidate must
                                           FAIL the motor rule, an unchanged tune must pass it)
Reads protocol.json, start/, control/, candidate/ summary.json (two swept axes: roll and pitch), app/tuning_and_apply.json,
app/candidate.json, app/engine.json and regression/ (the v2 regression case); writes VERDICT.md and verdict.json.

Rules (protocol v3):
  Motor rule      per motor m: the median over the three runs of a tune of the hover band power of motor[m] (noise_metrics.py
                  motorBandHover: 100–500 Hz, armed ≥ 1 s, outside every CHIRP ± 0.5 s); ratio = candidate median / start
                  median; the highest motor ratio must be ≤ motorRule.maxMotorRatio. Valid only with no motor clipping, at
                  least minHoverSamples hover samples per run and a per-motor run spread (max − min) / median ≤ maxRunSpreadRel
                  in both tunes (else INSUFFICIENT).
  Regression      the new engine on the v2 start logs does not choose the v2 candidate, its predicted highest motor ratio
                  exceeds the limit, and the measured hover per-motor ratio of its v2 remeasurement exceeds the limit. A
                  regression that does not hold → FAIL (first decisive step regression_case_not_rejected).
  INSUFFICIENT    start not valid on both swept axes (3/3, GM assessable, PM spread < 1°) or missing no target on any axis;
                  positive control not valid, outside the space (→ FAIL candidate_missing_in_grid), missing a target on an
                  axis, not improving as required, or over the motor limit; a tune not measured.
  FAIL            candidate_missing_in_grid; candidate_rejected (no PID + filter proposal: PID items with source
                  joint_search and filter items, Apply route present, no block about the candidate itself);
                  remeasurement_does_not_confirm (a swept axis misses a target or does not improve, or the motor rule fails).
  PASS            the app chose a PID + filter candidate itself and its remeasurement meets PM ≥ 45°, GM ≥ 6 dB (assessable),
                  |S| ≤ 6 dB on roll and pitch, improves every target the start misses on each axis by the reference tolerance
                  without losing a met one, and keeps every motor's hover band power within the limit.
Prediction accuracy (margins per axis with the loop-reference tolerances; per-motor ratios with motorPredictionToleranceRel) is
reported separately.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ in the harness tree (run_tune.sh refuses a dirty harness)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from e2e_joint_verdict import DTERM_KEYS, GYRO_KEYS, filter_scale, joint_pid_point  # noqa: E402
from e2e_verdict import TOL, improvement, misses  # noqa: E402

APPLY_BLOCKS_NOT_ABOUT_THE_CANDIDATE = {"fc:not_connected", "experimental:not_acknowledged", "fc_identity_binding:log_board_missing"}
AXES = ("roll", "pitch")
PITCH_KEYS = {"p": "p_pitch", "i": "i_pitch", "d": "d_pitch", "dMax": "d_max_pitch"}


GM_RULE = {"rule": "coherence_0.99"}


def axis_ref(summary: dict, axis: str):
    """(median, spread, gmAssessableAll) of one swept axis of a tune summary. Under the protocol v4 GM rule the GM used against
    the targets is the lower bound (median − 2σ) and assessability comes from σ; the GM read is kept as gmRead."""
    if axis == "roll":
        med, spread, ok = summary.get("refMedian"), summary.get("refSpread"), summary.get("gmAssessableAll")
    else:
        med, spread, ok = summary.get("refPitchMedian"), summary.get("refPitchSpread"), summary.get("gmAssessableAllPitch")
    if GM_RULE["rule"] == "uncertainty_v4" and med:
        g = (summary.get("gmV4") or {}).get(axis) or {}
        med = {**med, "gmRead": med.get("gm"), "gm": g.get("lowerBound"), "gmSigmaDb": g.get("maxSigmaDb"), "gmAssessableCoherence099": ok}
        ok = g.get("assessableAll", False)
    return med, spread, ok


def pid_of(tune: dict, settings: dict, axis: str) -> dict:
    if axis == "roll":
        return {k: tune[k] for k in ("p", "i", "d", "dMax")}
    return {k: int(settings[PITCH_KEYS[k]]) for k in ("p", "i", "d", "dMax")}


def motor_rule(start: dict | None, cand: dict | None, rule: dict) -> dict:
    """The per-motor hover rule between two tune summaries (motorHoverMedian, spreads, issues)."""
    out = {"ok": False, "valid": False, "ratios": None, "max": None, "issues": []}
    if not start or not cand or not start.get("motorHoverMedian") or not cand.get("motorHoverMedian"):
        out["issues"].append("motor_hover_not_measured")
        return out
    for name, s in (("start", start), ("candidate", cand)):
        for i in s.get("motorIssues") or []:
            out["issues"].append(f"{name}:{i}")
        for m, sp in enumerate(s.get("motorHoverSpreadRel") or []):
            if sp > rule["maxRunSpreadRel"]:
                out["issues"].append(f"{name}:motor{m + 1}_run_spread_{sp:.3f}>{rule['maxRunSpreadRel']}")
    ratios = [c / s for c, s in zip(cand["motorHoverMedian"], start["motorHoverMedian"])]
    out.update({"ratios": ratios, "max": max(ratios), "valid": not out["issues"]})
    out["ok"] = out["valid"] and out["max"] <= rule["maxMotorRatio"]
    return out


def selftest() -> int:
    """Motor rule and regression expectation on the fixtures of the v2 proof (the 1.45× candidate)."""
    fx = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "sitl_e2e_joint_regression_v2"
    rule = {"maxMotorRatio": 1.10, "maxRunSpreadRel": 0.15}
    start = json.loads((fx / "start_hover.json").read_text())
    cand = json.loads((fx / "candidate_hover.json").read_text())
    cases = [
        ("v2 candidate (x1.45 in the v2 window, x2.5 in hover) fails the motor rule", motor_rule(start, cand, rule), False),
        ("an unchanged tune passes it", motor_rule(start, start, rule), True),
        ("a clipped run makes it invalid", motor_rule(start, {**cand, "motorIssues": ["noise:motor_clip_0.0010"]}, rule), False),
        ("a run spread above the limit makes it invalid", motor_rule(start, {**start, "motorHoverSpreadRel": [0.2, 0, 0, 0]}, rule), False),
    ]
    ok = True
    for name, r, want in cases:
        good = r["ok"] is want
        ok = ok and good
        print(f"{'ok  ' if good else 'FAIL'} {name}: ok={r['ok']} max={None if r['max'] is None else round(r['max'], 3)} issues={r['issues']}")
    # The protocol v4 GM uncertainty (summarize_tune.py gm_sigma_db): fixed reference values.
    from summarize_tune import gm_sigma_db
    for coh, want in ((0.946, 1.36), (0.99, 0.60), (0.995, 0.42)):
        good = abs(gm_sigma_db(coh) - want) < 0.01
        ok = ok and good
        print(f"{'ok  ' if good else 'FAIL'} GM sigma at coherence {coh}: {gm_sigma_db(coh):.3f} dB (expected {want})")
    # The engine expectation recorded with the fixtures: no candidate chosen on the v2 start logs, predicted max > limit.
    eng = json.loads((fx / "engine_expectation.json").read_text())
    good = eng["chosen"] is None and eng["predictedMaxMotorRatio"] > rule["maxMotorRatio"]
    ok = ok and good
    print(f"{'ok  ' if good else 'FAIL'} engine on the v2 start logs: chosen={eng['chosen']} predicted max={eng['predictedMaxMotorRatio']:.3f}")
    print("selftest", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    if sys.argv[1:] == ["--selftest"]:
        return selftest()
    dossier = Path(sys.argv[1])
    proto = json.loads((dossier / "protocol.json").read_text())
    load = lambda rel: json.loads((dossier / rel).read_text()) if (dossier / rel).is_file() else None  # noqa: E731
    start, control, cand = load("start/summary.json"), load("control/summary.json"), load("candidate/summary.json")
    app, cand_file, engine = load("app/tuning_and_apply.json"), load("app/candidate.json"), load("app/engine.json")
    space, rule = proto["jointSpace"], proto["motorRule"]
    GM_RULE["rule"] = proto.get("gmRule", {}).get("rule", "coherence_0.99") if isinstance(proto.get("gmRule"), dict) else "coherence_0.99"
    v = {"protocol": proto, "steps": [], "verdict": None, "firstDecisiveStep": None, "prediction": None}
    notes = v["steps"]

    def stop(verdict, why):
        v["verdict"] = verdict
        v["why"] = why
        notes.append(f"{verdict}: {why}")

    prov = load("provenance.json")
    if not prov:
        notes.append("WARNING: provenance.json missing")
    else:
        if prov.get("gyroflightDirty"):
            notes.append(f"WARNING: GyroFlight worktree not clean at the start of the proof: {prov['gyroflightDirty'].strip()}")
        notes.append(f"provenance: GyroFlight {prov.get('gyroflightHead')}, VliegAI {prov.get('vliegaiHead')}, ELF {str(prov.get('elfSha256'))[:12]}…, protocol.json {str(prov.get('protocolSha256'))[:12]}…, selftest {prov.get('evaluatorSelftest')}")

    # 0. regression: the v2 candidate (1.45x) must be rejected by the engine and fail the measured motor rule
    reg = load("regression/regression.json")
    v["regression"] = reg
    if not reg:
        stop("INSUFFICIENT", "regression case not evaluated (regression/regression.json missing)")
    elif not reg.get("holds"):
        v["firstDecisiveStep"] = "regression_case_not_rejected"
        stop("FAIL", f"regression case not rejected: {reg.get('why')}")
    else:
        notes.append(f"regression: engine on the v2 start logs chose {reg['engineChosen']}, predicted max motor ratio of the v2 candidate {reg['predictedMaxMotorRatio']:.2f}; measured hover per-motor ratio {[round(x, 2) for x in reg['measuredMotorRatios']]} (> {rule['maxMotorRatio']}) — rejected as required")

    start_settings = proto["start"].get("settings") or {}
    sm = {}
    # 1. start: both swept axes valid, at least one target missed
    if v["verdict"] is None:
        if not start or not start.get("refMedian"):
            stop("INSUFFICIENT", "start tune not measured")
        else:
            v["start"] = {"tune": start["tune"], "settings": start.get("settings"), "axes": {}, "motorHover": start.get("motorHoverMedian"), "motorSpread": start.get("motorHoverSpreadRel"), "nValid": start["nValid"], "n": start["n"]}
            bad = None
            for ax in AXES:
                med, spread, gm_ok = axis_ref(start, ax)
                v["start"]["axes"][ax] = {"ref": med, "spread": spread, "gmAssessableAll": gm_ok, "misses": misses(med) if med else None}
                if start["nValid"] != start["n"] or not med:
                    bad = f"start: {start['nValid']}/{start['n']} valid runs ({ax})"
                elif not gm_ok:
                    bad = f"start: GM not assessable on {ax}"
                elif spread["pm"] >= TOL["repeatPmDeg"]:
                    bad = f"start: {ax} PM spread {spread['pm']:.2f}° >= 1°"
                sm[ax] = med
            if bad:
                stop("INSUFFICIENT", bad + "; " + "; ".join(i for r in start["runs"] for i in r["issues"]))
            elif not any(misses(sm[ax]) for ax in AXES):
                stop("INSUFFICIENT", "start meets every target on both axes: no room for improvement")
            else:
                comb = start.get("combined") or {}
                notes.append(f"start {start['tune']} {start_settings}: " + "; ".join(f"{ax} fc {sm[ax]['fc']:.1f} PM {sm[ax]['pm']:.1f} GM {sm[ax]['gm']:.1f} |S| {sm[ax]['s']:.2f} misses {misses(sm[ax])}" for ax in AXES) + f"; PID-only engine roll status {comb.get('status')} (information)")
    # 2. positive control
    if v["verdict"] is None:
        if not control or not control.get("refMedian"):
            stop("INSUFFICIENT", "positive control not measured")
        else:
            cs = control.get("settings") or {}
            ctrl = {"tune": control["tune"], "settings": cs, "axes": {}, "nValid": control["nValid"], "n": control["n"]}
            v["control"] = ctrl
            in_space = all(joint_pid_point(pid_of(start["tune"], start_settings, ax), pid_of(control["tune"], cs, ax), space["pidStep"]) for ax in AXES)
            sg = filter_scale(start_settings, cs, GYRO_KEYS, space["gyroLpfScales"])
            sd = filter_scale(start_settings, cs, DTERM_KEYS, space["dtermLpfScales"])
            mot = motor_rule(start, control, rule)
            ctrl.update({"inPidGrid": in_space, "gyroScale": sg, "dtermScale": sd, "motor": mot})
            fail = None
            for ax in AXES:
                med, spread, gm_ok = axis_ref(control, ax)
                imp = improvement(sm[ax], med, misses(sm[ax])) if med else None
                ctrl["axes"][ax] = {"ref": med, "spread": spread, "gmAssessableAll": gm_ok, "improvement": imp}
                if not fail:
                    if control["nValid"] != control["n"] or not med:
                        fail = f"control: {control['nValid']}/{control['n']} valid runs ({ax})"
                    elif not gm_ok:
                        fail = f"control: GM not assessable on {ax}"
                    elif misses(med):
                        fail = f"positive control misses {misses(med)} on {ax}"
                    elif not imp["ok"]:
                        fail = f"positive control does not improve {ax} as required: {imp['detail']}"
                    elif spread["pm"] >= TOL["repeatPmDeg"]:
                        fail = f"control: {ax} PM spread {spread['pm']:.2f}° >= 1°"
            if not in_space or sg is None or sd is None:
                v["firstDecisiveStep"] = "candidate_missing_in_grid"
                stop("FAIL", f"positive control outside the joint space (PID {in_space}, gyro ×{sg}, D-term ×{sd})")
            elif fail:
                stop("INSUFFICIENT", fail)
            elif not mot["valid"]:
                stop("INSUFFICIENT", f"control: motor rule not valid: {mot['issues']}")
            elif not mot["ok"]:
                stop("INSUFFICIENT", f"positive control exceeds the motor limit: max {mot['max']:.3f} > {rule['maxMotorRatio']}")
            else:
                notes.append(f"positive control gyro ×{sg}, D-term ×{sd}: " + "; ".join(f"{ax} {ctrl['axes'][ax]['ref']['pm']:.1f}° / {ctrl['axes'][ax]['ref']['gm']:.1f} dB / {ctrl['axes'][ax]['ref']['s']:.2f} dB" for ax in AXES) + f"; motor ratios {[round(x, 3) for x in mot['ratios']]} — in the space, meets every target on both axes, within the motor limit")
    # 3. the app
    chosen = None
    pred = None
    if v["verdict"] is None:
        if not app or not cand_file:
            stop("INSUFFICIENT", "app step not recorded")
        else:
            read = app.get("read") or {}
            pid_items = app.get("pidItems") or []
            fitems = app.get("filterItems") or []
            apply_btn = read.get("applyButton") or {}
            blocks = [b.strip() for b in "; ".join(read.get("blocks") or []).split(";") if b.strip()]
            candidate_blocks = [b for b in blocks if b not in APPLY_BLOCKS_NOT_ABOUT_THE_CANDIDATE]
            joint_items = bool(pid_items) and bool(fitems) and all(it.get("source") == "joint_search" for it in pid_items + fitems)
            shown = ("pid_and_filter_proposal" if joint_items and apply_btn.get("present") and not candidate_blocks
                     else "items_with_apply_route_blocked" if joint_items else read.get("jointShown"))
            chosen = cand_file.get("candidate")
            j = (engine or {}).get("joint") or {}
            ch = j.get("chosen") or {}
            asmt = ch.get("assessment") or {}
            if ch:
                eng_cand_settings = {**start_settings, **{k: vv["to"] for k, vv in (ch.get("filters") or {}).items()}}
                for ax, a in (ch.get("axes") or {}).items():
                    if ax == "pitch":
                        for k, key in PITCH_KEYS.items():
                            eng_cand_settings[key] = a["read"]["pid"][k]
                roll_pid = (ch.get("axes") or {}).get("roll", {}).get("read", {}).get("pid") or {k: start["tune"][k] for k in ("p", "i", "d", "dMax")}
                eng_cand = {**roll_pid, "settings": eng_cand_settings}
                if chosen and eng_cand == chosen:
                    pred = {"axes": {a["axis"]: a["margins"]["read"] for a in asmt.get("axes", []) if a["margins"]["read"]},
                            "axisNoise": {a["axis"]: a["noise"]["ratio"] for a in asmt.get("axes", [])},
                            "motorRatios": (asmt.get("motor") or {}).get("motorRatios")}
            else:
                eng_cand = None
            aprov = load("app/provenance.json")
            v["app"] = {"shown": shown, "jointShownByPage": read.get("jointShown"), "chosen": chosen, "applyButton": apply_btn, "blocks": blocks,
                        "blocksAboutTheCandidate": candidate_blocks, "itemSources": sorted({it.get("source") for it in pid_items + fitems}),
                        "itemStatuses": sorted({it.get("status") for it in pid_items + fitems}), "engineJointStatus": j.get("status"),
                        "engineCandidate": eng_cand, "enginePredicted": pred, "effects": (read.get("joint") or {}).get("effects"),
                        "errs": app.get("errs"), "provenance": aprov,
                        "pidOnly": {ax: (pv and {"pid": pv["pid"], "pm": pv["pmDeg"], "meets": pv["meetsTargets"], "motorMax": (pv.get("motor") or {}).get("max")}) for ax, pv in (j.get("pidOnly") or {}).items()}}
            if not aprov:
                notes.append("WARNING: app/provenance.json missing")
            elif aprov.get("srcDirty"):
                notes.append(f"WARNING: src/ was not clean at Calculate: {aprov.get('srcDirty')}")
            in_space = sg_ = sd_ = None
            if chosen:
                cset = chosen["settings"]
                in_space = all(joint_pid_point(pid_of(start["tune"], start_settings, ax), pid_of(chosen, cset, ax), space["pidStep"]) for ax in AXES)
                sg_ = filter_scale(start_settings, cset, GYRO_KEYS, space["gyroLpfScales"])
                sd_ = filter_scale(start_settings, cset, DTERM_KEYS, space["dtermLpfScales"])
                v["app"].update({"inPidGrid": in_space, "gyroScale": sg_, "dtermScale": sd_})
            if chosen and (not in_space or sg_ is None or sd_ is None):
                v["firstDecisiveStep"] = "candidate_missing_in_grid"
                stop("FAIL", f"the chosen candidate is outside the joint space (PID {in_space}, gyro ×{sg_}, D-term ×{sd_})")
            elif shown != "pid_and_filter_proposal" or not chosen:
                v["firstDecisiveStep"] = "candidate_rejected"
                stop("FAIL", f"the app offers no PID + filter proposal ({shown}; PID items {len(pid_items)}, filter items {len(fitems)}, blocks about the candidate {candidate_blocks}); engine joint status {j.get('status')}: {j.get('reasons')}")
            else:
                if eng_cand and eng_cand != chosen:
                    notes.append(f"WARNING: engine candidate {eng_cand} differs from the app's items {chosen}; no prediction accuracy reported")
                notes.append(f"app chose {chosen} (gyro ×{sg_}, D-term ×{sd_}; Apply route blocks {blocks}; sources {v['app']['itemSources']}, statuses {v['app']['itemStatuses']}); predicted {pred}")
    # 4. remeasurement
    if v["verdict"] is None:
        cset = chosen["settings"]
        if not cand or not cand.get("refMedian"):
            stop("INSUFFICIENT", "candidate not remeasured")
        elif cand["tune"] != {k: chosen[k] for k in ("p", "i", "d", "dMax")} or (cand.get("settings") or {}) != cset:
            stop("INSUFFICIENT", f"remeasured tune {cand['tune']} {cand.get('settings')} is not the chosen candidate {chosen}")
        else:
            mot = motor_rule(start, cand, rule)
            cv = {"tune": cand["tune"], "settings": cand.get("settings"), "axes": {}, "motor": mot, "nValid": cand["nValid"], "n": cand["n"],
                  "axisCtrlHover": cand.get("axisCtrlHoverMedian"), "startAxisCtrlHover": start.get("axisCtrlHoverMedian")}
            v["candidate"] = cv
            insufficient = fail = None
            for ax in AXES:
                med, spread, gm_ok = axis_ref(cand, ax)
                imp = improvement(sm[ax], med, misses(sm[ax])) if med else None
                cv["axes"][ax] = {"ref": med, "spread": spread, "gmAssessableAll": gm_ok, "misses": misses(med) if med else None, "improvement": imp}
                if insufficient or fail:
                    continue
                if cand["nValid"] != cand["n"] or not med:
                    insufficient = f"candidate: {cand['nValid']}/{cand['n']} valid runs ({ax}): " + "; ".join(i for r in cand["runs"] for i in r["issues"])
                elif not gm_ok:
                    insufficient = f"candidate: GM not assessable on {ax}"
                elif spread["pm"] >= TOL["repeatPmDeg"]:
                    insufficient = f"candidate: {ax} PM spread {spread['pm']:.2f}° >= 1°"
                elif misses(med) or not imp["ok"]:
                    fail = f"{ax} misses {misses(med)}; improvement {imp['detail']}"
            if insufficient:
                stop("INSUFFICIENT", insufficient)
            elif not mot["valid"]:
                stop("INSUFFICIENT", f"candidate: motor rule not valid: {mot['issues']}")
            elif fail or not mot["ok"]:
                v["firstDecisiveStep"] = "remeasurement_does_not_confirm"
                stop("FAIL", (fail + "; " if fail else "") + f"motor ratios {[round(x, 3) for x in mot['ratios']]} (limit {rule['maxMotorRatio']})")
            else:
                v["verdict"] = "PASS"
                notes.append("PASS: remeasured " + "; ".join(f"{ax} fc {cv['axes'][ax]['ref']['fc']:.1f} Hz PM {cv['axes'][ax]['ref']['pm']:.1f}° GM {cv['axes'][ax]['ref']['gm']:.1f} dB |S| {cv['axes'][ax]['ref']['s']:.2f} dB, improvement {cv['axes'][ax]['improvement']['detail']}" for ax in AXES) + f"; motor ratios {[round(x, 3) for x in mot['ratios']]} ≤ {rule['maxMotorRatio']}")
            if pred:
                acc = {"axes": {}, "motor": None}
                for ax in AXES:
                    p_, r_ = pred["axes"].get(ax), cv["axes"][ax]["ref"]
                    if p_ and r_:
                        # GM prediction against the GM as read (median), not against the v4 lower bound (Grok block 13 r1, note 13).
                        gm_read = r_.get("gmRead", r_["gm"])
                        d = {"fcRel": (p_["crossoverHz"] - r_["fc"]) / r_["fc"], "pmDeg": p_["pmDeg"] - r_["pm"], "gmDb": p_["gmDb"] - gm_read, "sDb": p_["sDb"] - r_["s"]}
                        d["within"] = {"fc": abs(d["fcRel"]) <= TOL["fcRel"], "pm": abs(d["pmDeg"]) <= TOL["pmDeg"], "gm": abs(d["gmDb"]) <= TOL["gmDb"], "s": abs(d["sDb"]) <= TOL["sDb"]}
                        acc["axes"][ax] = d
                if pred.get("motorRatios") and mot.get("ratios"):
                    rel = [(p_ - m_) / m_ for p_, m_ in zip(pred["motorRatios"], mot["ratios"])]
                    acc["motor"] = {"predicted": pred["motorRatios"], "measured": mot["ratios"], "relError": rel, "within": all(abs(x) <= proto.get("motorPredictionToleranceRel", 0.15) for x in rel)}
                v["prediction"] = {"predicted": pred, "diff": acc, "tolerances": {**TOL, "motorRel": proto.get("motorPredictionToleranceRel", 0.15)}}
    (dossier / "verdict.json").write_text(json.dumps(v, indent=1, default=float) + "\n")
    f = lambda x, p=1: "–" if x is None else f"{x:.{p}f}"  # noqa: E731
    lines = [f"# E2E joint PID + filter proof with the every-axis motor rule — verdict: **{v['verdict']}**", ""]
    if v["firstDecisiveStep"]:
        lines.append(f"First decisive step: `{v['firstDecisiveStep']}`")
    lines += ["", "| tune | role | axis | fc (Hz) | PM (°) | GM (dB) | \\|S\\| (dB) | motors (hover band power, ratio to start) |", "|---|---|---|---|---|---|---|---|"]
    for role in ("start", "control", "candidate"):
        s = v.get(role)
        if not s or not s.get("axes"):
            continue
        mot = s.get("motor")
        for ax in AXES:
            m = (s["axes"].get(ax) or {}).get("ref")
            if not m:
                continue
            motors = "1.00 (reference)" if role == "start" else (", ".join(f"{x:.2f}" for x in mot["ratios"]) if mot and mot.get("ratios") else "–")
            pid = pid_of(s["tune"], s.get("settings") or {}, ax)
            lines.append(f"| {pid['p']}/{pid['i']}/{pid['d']}/{pid['dMax']} | {role} | {ax} | {f(m['fc'])} | {f(m['pm'])} | {f(m['gm'])} | {f(m['s'], 2)} | {motors if ax == 'roll' else ''} |")
    if v.get("prediction"):
        pr = v["prediction"]
        for ax, d in pr["diff"]["axes"].items():
            lines.append(f"\nPrediction − remeasurement {ax}: fc {d['fcRel'] * 100:+.1f} %, PM {d['pmDeg']:+.1f}°, GM {d['gmDb']:+.2f} dB, |S| {d['sDb']:+.2f} dB (within: {d['within']}).")
        if pr["diff"]["motor"]:
            mo = pr["diff"]["motor"]
            lines.append(f"\nMotor ratios predicted {[round(x, 3) for x in mo['predicted']]} vs measured {[round(x, 3) for x in mo['measured']]} (relative error {[round(x, 3) for x in mo['relError']]}, within ±{pr['tolerances']['motorRel']:.0%}: {mo['within']}).")
    lines += ["", "## Steps", ""] + [f"- {n}" for n in notes]
    (dossier / "VERDICT.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Verdict of the end-to-end roll autotune proof (dossier PROTOCOL.md, fixed before Calculate).

Usage: e2e_verdict.py <dossier dir>
       e2e_verdict.py --selftest   (the evaluator on the fixtures of the 2026-11-10 proof, test/fixtures/sitl_e2e_roll_2026-11-10:
                                   the recorded data must give PASS, and each mutation its named verdict)
Reads protocol.json, start/summary.json, control/summary.json, app/tuning_and_apply.json, app/engine.json (the engine on the
same logs, from run_tune.sh's combined job) and candidate/summary.json; writes VERDICT.md and verdict.json.

Verdict rules (protocol):
  INSUFFICIENT  the positive control fails (control not inside the ±MAX_STEP grid of the start, or its reference does not
                meet all three targets with GM assessable, or it does not improve the start's missed target by the
                reference tolerance), the start does not miss a target (no room), GM not assessable on a tune the verdict
                needs, or repeats spread >= 1° PM.
  FAIL          first decisive step: (1) candidate_missing_in_grid — the positive control or the chosen candidate is not a
                point of the ±30 % grid as searchGrid forms it; (2) candidate_rejected — the app shows no proposal for roll
                (a block, an informative step only, or an Apply route blocked for a reason about the candidate itself), with
                the app's first cause; (3) remeasurement_does_not_confirm — the proposal's remeasured reference does not
                meet all three targets or does not improve as required.
  PASS          the app chose a roll candidate on its own (a proposal, Apply route), its remeasured reference meets PM >= 45°,
                GM >= 6 dB (assessable), |S| <= 6 dB and improves the start's missed target(s) by at least the reference
                tolerance while no met target is lost.
Prediction accuracy (app's predicted margins of the candidate vs the remeasured reference) is reported separately with the
loop-reference tolerances: fc 10 %, PM 5°, |S| 1 dB, GM 1.5 dB.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

TOL = {"fcRel": 0.10, "pmDeg": 5.0, "sDb": 1.0, "gmDb": 1.5, "repeatPmDeg": 1.0}
TARGETS = {"pm": 45.0, "gm": 6.0, "s": 6.0}
SCALES = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3]
# Blocks of the experimental Apply route that do not reject the candidate itself: no flight controller, no acknowledgement
# (both expected in this headless run), and a SITL log without a board identity (fc_identity_binding: the SITL header names no
# board; a property of the log, not of the candidate). Any other block counts as the app rejecting the candidate.
APPLY_BLOCKS_NOT_ABOUT_THE_CANDIDATE = {"fc:not_connected", "experimental:not_acknowledged", "fc_identity_binding:log_board_missing"}


def js_round(x: float) -> int:
    """Math.round: half away from zero for positive values (Python round is half-even)."""
    return int(math.floor(x + 0.5))


def grid_point(start: dict, v: dict) -> bool:
    """Is v a point of the ±30 % grid around start (pidOptimizer searchGrid: P, I, D each on SCALES, d_max on D's scale)?"""
    for ps in SCALES:
        if js_round(start["p"] * ps) != v["p"]:
            continue
        for is_ in (SCALES if start["i"] > 0 else [1]):
            if js_round(start["i"] * is_) != v["i"]:
                continue
            for ds in (SCALES if start["d"] > 0 else [1]):
                d = js_round(start["d"] * ds)
                dmax = max(js_round(start["dMax"] * ds), d) if start["dMax"] > 0 else 0
                if d == v["d"] and dmax == v["dMax"]:
                    return True
    return False


def misses(m: dict) -> list[str]:
    out = []
    if m["pm"] is None or m["pm"] < TARGETS["pm"]:
        out.append("pm")
    if m["gm"] is None or m["gm"] < TARGETS["gm"]:
        out.append("gm")
    if m["s"] is None or m["s"] > TARGETS["s"]:
        out.append("s")
    return out


def improvement(start: dict, after: dict, missed: list[str]) -> dict:
    """Each target the start misses must move by at least its reference tolerance in the right direction; no met target lost."""
    out = {"ok": True, "detail": {}}
    for k, tol, sign in (("pm", TOL["pmDeg"], 1), ("gm", TOL["gmDb"], 1), ("s", TOL["sDb"], -1)):
        if after[k] is None or start[k] is None:
            out["ok"] = False
            out["detail"][k] = "unknown"
            continue
        delta = (after[k] - start[k]) * sign
        if k in missed:
            ok = delta >= tol
            out["detail"][k] = f"{'+' if delta >= 0 else ''}{delta:.2f} (needs >= {tol})"
        else:
            ok = k not in misses(after)
            out["detail"][k] = f"{'+' if delta >= 0 else ''}{delta:.2f} (must stay within target)"
        out["ok"] = out["ok"] and ok
    return out


def parse_candidate(start: dict, app: dict) -> dict | None:
    items = app.get("rollItems") or []
    if not items:
        return None
    v = dict(start)
    for it in items:
        key = it["key"].replace("_roll", "")
        field = {"p": "p", "i": "i", "d": "d", "d_max": "dMax"}[key]
        v[field] = int(it["cells"][2])
    return v


def parse_shown_margins(app: dict) -> dict | None:
    """The rounded margins the UI shows for the offered candidate: the 'offered (experimental): …' line of the roll decision
    row when that table is rendered, else the improvement-step row ('PM 39° → 46°', 'GM 12.1 dB → 12.2 dB', '|S| 5.6 dB → 5.0 dB')."""
    dec = app.get("rollDecision") or {}
    for line in dec.get("values") or []:
        m = re.match(r"offered \(experimental\): P (\d+), I (\d+), D (\d+): PM (-?[\d.]+)°, GM (-?[\d.]+) dB, \|S\| (-?[\d.]+) dB", line)
        if m:
            return {"source": "decision_row", "p": int(m[1]), "i": int(m[2]), "d": int(m[3]), "pm": float(m[4]), "gm": float(m[5]), "s": float(m[6])}
    text = (app.get("rollStep") or {}).get("text") or ""
    pm = re.search(r"PM -?[\d.]+° → (-?[\d.]+)°", text)
    gm = re.search(r"GM -?[\d.]+ dB → (-?[\d.]+) dB", text)
    s = re.search(r"\|S\| -?[\d.]+ dB → (-?[\d.]+) dB", text)
    fc = re.search(r"crossover -?[\d.]+ → (-?[\d.]+) Hz", text)
    if pm and gm and s and "also the offered experimental candidate" in text:
        return {"source": "improvement_step_row", "pm": float(pm[1]), "gm": float(gm[1]), "s": float(s[1]), "fc": float(fc[1]) if fc else None}
    return None


def selftest() -> int:
    """The evaluator against the recorded proof and mutations of it (regression of the verdict rules)."""
    import shutil
    import tempfile

    fixtures = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "sitl_e2e_roll_2026-11-10"
    cases = []

    def run(name, mutate):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp) / "dossier"
            shutil.copytree(fixtures, d)
            mutate(d)
            saved = sys.argv
            sys.argv = ["e2e_verdict.py", str(d)]
            try:
                import io
                import contextlib

                with contextlib.redirect_stdout(io.StringIO()):
                    main()
            finally:
                sys.argv = saved
            v = json.loads((d / "verdict.json").read_text())
            cases.append((name, v["verdict"], v.get("firstDecisiveStep"), v.get("why")))
            return v

    def edit(rel, fn):
        def m(d):
            p = d / rel
            data = json.loads(p.read_text())
            fn(data)
            p.write_text(json.dumps(data))
        return m

    def set_pm(summary, pm):
        summary["refMedian"]["pm"] = pm
        for r in summary["runs"]:
            r["ref"]["pm"] = pm
        summary["refMeetsTargets"] = pm >= TARGETS["pm"] and not [k for k in misses(summary["refMedian"]) if k != "pm"]
        summary["refMisses"] = misses(summary["refMedian"])

    expected = [
        ("recorded", lambda d: None, "PASS", None),
        ("candidate misses PM", edit("candidate/summary.json", lambda s: set_pm(s, 44.0)), "FAIL", "remeasurement_does_not_confirm"),
        ("candidate improves PM by less than 5°", edit("candidate/summary.json", lambda s: set_pm(s, 44.5)), "FAIL", "remeasurement_does_not_confirm"),
        ("control outside the grid", edit("control/summary.json", lambda s: s["tune"].update({"p": 69})), "FAIL", "candidate_missing_in_grid"),
        ("control misses the targets", edit("control/summary.json", lambda s: set_pm(s, 40.0)), "INSUFFICIENT", None),
        ("start already meets the targets", edit("start/summary.json", lambda s: set_pm(s, 50.0)), "INSUFFICIENT", None),
        ("start GM not assessable", edit("start/summary.json", lambda s: s.update({"gmAssessableAll": False})), "INSUFFICIENT", None),
        ("app shows no roll items", edit("app/tuning_and_apply.json", lambda a: (a.update({"rollItems": []}), a["read"].update({"rollShown": "informative_step_only"}))), "FAIL", "candidate_rejected"),
        ("Apply blocked for a reason about the candidate", edit("app/tuning_and_apply.json", lambda a: a["read"].update({"blocks": ["plausible_step:step_too_large:p_roll"]})), "FAIL", "candidate_rejected"),
        ("chosen candidate outside the grid", edit("app/tuning_and_apply.json", lambda a: a["rollItems"][0]["cells"].__setitem__(2, "79")), "FAIL", "candidate_missing_in_grid"),
        ("candidate not remeasured", lambda d: (d / "candidate" / "summary.json").unlink(), "INSUFFICIENT", None),
    ]
    ok = True
    for name, mutate, verdict, step in expected:
        v = run(name, mutate)
        good = v["verdict"] == verdict and v.get("firstDecisiveStep") == step
        ok = ok and good
        print(f"{'ok  ' if good else 'FAIL'} {name}: {v['verdict']} {v.get('firstDecisiveStep') or ''} (expected {verdict} {step or ''})")
    print("selftest", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    if sys.argv[1:] == ["--selftest"]:
        return selftest()
    dossier = Path(sys.argv[1])
    proto = json.loads((dossier / "protocol.json").read_text())
    load = lambda rel: json.loads((dossier / rel).read_text()) if (dossier / rel).is_file() else None  # noqa: E731
    start = load("start/summary.json")
    control = load("control/summary.json")
    app = load("app/tuning_and_apply.json")
    engine = load("app/engine.json")
    cand = load("candidate/summary.json")
    v = {"protocol": proto, "steps": [], "verdict": None, "firstDecisiveStep": None, "prediction": None}
    notes = v["steps"]

    def stop(verdict, why):
        v["verdict"] = verdict
        v["why"] = why
        notes.append(f"{verdict}: {why}")

    # 1. start: measured, room for improvement, GM assessable, repeats
    if not start or not start.get("refMedian"):
        stop("INSUFFICIENT", "start tune not measured")
    else:
        sm = start["refMedian"]
        v["start"] = {"tune": start["tune"], "ref": sm, "spread": start["refSpread"], "gmAssessableAll": start["gmAssessableAll"], "misses": misses(sm), "gf": start.get("gfMedian"), "nValid": start["nValid"], "n": start["n"]}
        if start["nValid"] != start["n"]:
            stop("INSUFFICIENT", f"start: {start['nValid']}/{start['n']} valid runs")
        elif not start["gmAssessableAll"]:
            stop("INSUFFICIENT", "start: GM not assessable (phase crossing outside 5–85 Hz or coherence < 0.99)")
        elif start["refSpread"]["pm"] >= TOL["repeatPmDeg"]:
            stop("INSUFFICIENT", f"start: PM spread {start['refSpread']['pm']:.2f}° >= 1°")
        elif not misses(sm):
            stop("INSUFFICIENT", "start meets all three targets: no room for improvement under the protocol")
        else:
            notes.append(f"start {start['tune']}: ref fc {sm['fc']:.1f} Hz, PM {sm['pm']:.1f}°, GM {sm['gm']:.1f} dB, |S| {sm['s']:.2f} dB; misses {misses(sm)}")
    # 2. positive control
    if v["verdict"] is None:
        if not control or not control.get("refMedian"):
            stop("INSUFFICIENT", "positive control not measured")
        else:
            cm = control["refMedian"]
            in_grid = grid_point(start["tune"], control["tune"])
            imp = improvement(sm, cm, misses(sm))
            v["control"] = {"tune": control["tune"], "ref": cm, "spread": control["refSpread"], "gmAssessableAll": control["gmAssessableAll"], "inGrid": in_grid, "meetsTargets": control.get("refMeetsTargets"), "improvement": imp, "nValid": control["nValid"], "n": control["n"]}
            if control["nValid"] != control["n"]:
                stop("INSUFFICIENT", f"control: {control['nValid']}/{control['n']} valid runs")
            elif not in_grid:
                v["firstDecisiveStep"] = "candidate_missing_in_grid"
                stop("FAIL", "positive control is not a point of the ±30 % grid around the start (grid rule differs from searchGrid)")
            elif not control["gmAssessableAll"]:
                stop("INSUFFICIENT", "control: GM not assessable")
            elif not control.get("refMeetsTargets"):
                stop("INSUFFICIENT", f"positive control misses {misses(cm)}: no candidate inside the grid is shown to meet the targets")
            elif not imp["ok"]:
                stop("INSUFFICIENT", f"positive control does not improve as required: {imp['detail']}")
            elif control["refSpread"]["pm"] >= TOL["repeatPmDeg"]:
                stop("INSUFFICIENT", f"control: PM spread {control['refSpread']['pm']:.2f}° >= 1°")
            else:
                notes.append(f"positive control {control['tune']}: ref fc {cm['fc']:.1f} Hz, PM {cm['pm']:.1f}°, GM {cm['gm']:.1f} dB, |S| {cm['s']:.2f} dB — in grid, meets all three, improvement {imp['detail']}")
    # 3. the app
    if v["verdict"] is None:
        if not app:
            stop("INSUFFICIENT", "app step not recorded (app/tuning_and_apply.json missing)")
        else:
            read = app.get("read") or {}
            items = app.get("rollItems") or []
            apply_btn = read.get("applyButton") or {}
            blocks = [b.strip() for b in "; ".join(read.get("blocks") or []).split(";") if b.strip()]
            candidate_blocks = [b for b in blocks if b not in APPLY_BLOCKS_NOT_ABOUT_THE_CANDIDATE]
            # A proposal: roll items in 4b with the Apply route present and no block about the candidate itself.
            shown = "proposal" if items and apply_btn.get("present") and not candidate_blocks else ("items_with_apply_route_blocked" if items else read.get("rollShown"))
            chosen = parse_candidate(start["tune"], app) if items else None
            shown_m = parse_shown_margins(app)
            eng = (engine or {}).get("decisionRoll", {}).get("primary") if engine else None
            ec = eng and eng.get("candidate")
            pred = None
            if ec and ec.get("proposedMargins") and ec.get("proposed") == chosen:
                pm_ = ec["proposedMargins"]
                pred = {"fc": pm_["crossoverHz"], "pm": pm_["phaseMarginDeg"],
                        "gm": pm_["gainMarginDb"] if pm_["gainMarginDb"] is not None else pm_["measured"]["gainMarginDb"],
                        "s": pm_["sensitivityPeakDb"] if pm_["sensitivityPeakDb"] is not None else pm_["measured"]["sensitivityPeakDb"]}
            prov = load("app/provenance.json")
            v["app"] = {"rollShown": shown, "rollShownByPage": read.get("rollShown"), "chosen": chosen, "shownMargins": shown_m, "applyButton": apply_btn,
                        "blocks": blocks, "blocksAboutTheCandidate": candidate_blocks, "itemStatuses": sorted({it.get("status") for it in items}),
                        "engineStatus": eng and eng.get("status"), "engineCandidate": ec and ec.get("proposed"), "enginePredicted": pred,
                        "engineCurrent": eng and eng.get("current"), "firstCause": eng and eng.get("firstCause") and {"rule": eng["firstCause"]["rule"], "value": eng["firstCause"]["value"]},
                        "rollStep": app.get("rollStep"), "errs": app.get("errs"), "provenance": prov}
            if not prov:
                notes.append("WARNING: app/provenance.json missing (HEAD and src state at Calculate not recorded by the harness)")
            elif prov.get("reconstructed") or prov.get("srcDirtyRecordedAtCalculate") is False or prov.get("srcDirty") is None:
                notes.append(f"WARNING: app provenance reconstructed after the fact (HEAD {prov.get('gyroflightHead')}); the state of src/ at Calculate was not recorded")
            elif prov.get("srcDirty"):
                notes.append(f"WARNING: src/ was not clean at Calculate: {prov.get('srcDirty')}")
            # Protocol step (1) first whenever the candidate is known, then (2).
            if chosen and not grid_point(start["tune"], chosen):
                v["firstDecisiveStep"] = "candidate_missing_in_grid"
                stop("FAIL", f"the chosen candidate {chosen} is not a point of the ±30 % grid around the start")
            elif shown != "proposal" or not chosen:
                v["firstDecisiveStep"] = "candidate_rejected"
                cause = (eng or {}).get("firstCause") or {}
                stop("FAIL", f"the app offers no roll proposal ({shown}; blocks about the candidate: {candidate_blocks}); engine status {eng and eng.get('status')}, first cause {cause.get('rule')}={str(cause.get('value'))[:160]}")
            else:
                if ec and ec.get("proposed") != chosen:
                    notes.append(f"WARNING: engine candidate {ec.get('proposed')} differs from the app's items {chosen}; no prediction accuracy reported")
                if shown_m and pred and (round(pred["pm"]) != round(shown_m["pm"]) or abs(pred["gm"] - shown_m["gm"]) > 0.051 or abs(pred["s"] - shown_m["s"]) > 0.051):
                    notes.append(f"WARNING: UI margins {shown_m} differ from engine prediction {pred}")
                notes.append(f"app chose {chosen} (shown: {shown}; Apply route blocks {blocks}; item status {v['app']['itemStatuses']}); predicted {pred}")
    # 4. remeasurement
    if v["verdict"] is None:
        if not cand or not cand.get("refMedian"):
            stop("INSUFFICIENT", "candidate not remeasured")
        elif cand["tune"] != chosen:
            stop("INSUFFICIENT", f"remeasured tune {cand['tune']} is not the chosen candidate {chosen}")
        else:
            rm = cand["refMedian"]
            imp = improvement(sm, rm, misses(sm))
            v["candidate"] = {"tune": cand["tune"], "ref": rm, "spread": cand["refSpread"], "gmAssessableAll": cand["gmAssessableAll"], "misses": misses(rm), "improvement": imp, "nValid": cand["nValid"], "n": cand["n"], "gf": cand.get("gfMedian")}
            if cand["nValid"] != cand["n"]:
                stop("INSUFFICIENT", f"candidate: {cand['nValid']}/{cand['n']} valid runs")
            elif not cand["gmAssessableAll"]:
                stop("INSUFFICIENT", "candidate: GM not assessable")
            elif cand["refSpread"]["pm"] >= TOL["repeatPmDeg"]:
                stop("INSUFFICIENT", f"candidate: PM spread {cand['refSpread']['pm']:.2f}° >= 1°")
            elif misses(rm) or not imp["ok"]:
                v["firstDecisiveStep"] = "remeasurement_does_not_confirm"
                stop("FAIL", f"remeasured candidate misses {misses(rm)}; improvement {imp['detail']}")
            else:
                v["verdict"] = "PASS"
                notes.append(f"PASS: remeasured {cand['tune']}: fc {rm['fc']:.1f} Hz, PM {rm['pm']:.1f}°, GM {rm['gm']:.1f} dB, |S| {rm['s']:.2f} dB; improvement {imp['detail']}")
            if pred:
                acc = {"fcRel": (pred["fc"] - rm["fc"]) / rm["fc"] if pred["fc"] and rm["fc"] else None,
                       "pmDeg": pred["pm"] - rm["pm"] if pred["pm"] is not None and rm["pm"] is not None else None,
                       "gmDb": pred["gm"] - rm["gm"] if pred["gm"] is not None and rm["gm"] is not None else None,
                       "sDb": pred["s"] - rm["s"] if pred["s"] is not None and rm["s"] is not None else None}
                acc["within"] = {"fc": acc["fcRel"] is not None and abs(acc["fcRel"]) <= TOL["fcRel"], "pm": acc["pmDeg"] is not None and abs(acc["pmDeg"]) <= TOL["pmDeg"],
                                 "gm": acc["gmDb"] is not None and abs(acc["gmDb"]) <= TOL["gmDb"], "s": acc["sDb"] is not None and abs(acc["sDb"]) <= TOL["sDb"]}
                v["prediction"] = {"predicted": pred, "remeasured": rm, "diff": acc, "tolerances": TOL}
    (dossier / "verdict.json").write_text(json.dumps(v, indent=1, default=float) + "\n")
    f = lambda x, p=1: "–" if x is None else f"{x:.{p}f}"  # noqa: E731
    lines = [f"# E2E roll proof — verdict: **{v['verdict']}**", ""]
    if v["firstDecisiveStep"]:
        lines.append(f"First decisive step: `{v['firstDecisiveStep']}`")
    lines += ["", "| tune | role | fc (Hz) | PM (°) | GM (dB) | \\|S\\| (dB) | meets | n |", "|---|---|---|---|---|---|---|---|"]
    for role in ("start", "control", "candidate"):
        s = v.get(role)
        if s:
            m = s["ref"]
            lines.append(f"| {s['tune']['p']}/{s['tune']['i']}/{s['tune']['d']}/{s['tune']['dMax']} | {role} (reference) | {f(m['fc'])} | {f(m['pm'])} | {f(m['gm'])}{'' if s['gmAssessableAll'] else ' (not assessable)'} | {f(m['s'], 2)} | {'yes' if not misses(m) and s['gmAssessableAll'] else 'no: ' + ','.join(misses(m))} | {s['nValid']}/{s['n']} |")
    a = v.get("app")
    if a and a.get("enginePredicted"):
        pr = a["enginePredicted"]
        c = a["chosen"]
        lines.append(f"| {c['p']}/{c['i']}/{c['d']}/{c['dMax']} | app prediction | {f(pr['fc'])} | {f(pr['pm'])} | {f(pr['gm'])} | {f(pr['s'], 2)} | {'yes' if not misses(pr) else 'no'} | – |")
    if v.get("prediction"):
        d = v["prediction"]["diff"]
        lines += ["", f"Prediction vs remeasurement: fc {d['fcRel'] * 100:+.1f} % (±10 %: {d['within']['fc']}), PM {d['pmDeg']:+.1f}° (±5°: {d['within']['pm']}), GM {d['gmDb']:+.2f} dB (±1.5 dB: {d['within']['gm']}), |S| {d['sDb']:+.2f} dB (±1 dB: {d['within']['s']})."]
    lines += ["", "## Steps", ""] + [f"- {n}" for n in notes]
    (dossier / "VERDICT.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

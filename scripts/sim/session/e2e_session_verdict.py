"""Verdict of the AutoTune session proof (block 14, protocol session_v1). No GyroFlight code: the decision rule is
re-implemented here and applied to the independent final measurements (measure_tune.py: reference_loop.py,
noise_metrics.py, step_metrics.py on a separate seed and separate start ticks).

  e2e_session_verdict.py <dossier> [--selftest]

Evidence per session dir <dossier>/sessions/<id>/ (bench dir): journal.jsonl (every bench operation, with the MSP
read-backs), accepted.json, ui/session_ui.json (what the app showed), independent_read/result.json (a separate MSP read
of the bench's flash after the session). Final measurements: <dossier>/final/<id>/{start,best}/measurement.json.

Criteria (protocol session_v1 §5):
  C1  every session ends with a stop reason and no error; every set and every restore read back over MSP equals the
      requested tune; every measurement run's MSP read before arming equals the tune measured.
  C2  at least one normal session finds an improvement on its own (an ACCEPT), and the independent final measurement
      confirms it: the best tune against the start tune passes every guard G1–G6 and V1 or V2 on an axis it changed.
  C3  each restore test: the scripted step's measurement is valid and its verdict is RESTORE with a guard (G*) as reason;
      the MSP read-back after the restore equals the accepted tune; the next step is chosen on the last accepted
      measurement; restore test 2's scripted step follows an ACCEPT.
  C4  no normal session whose independent final measurement shows its best tune failing a guard against its start tune.
  C5  each stop / disconnect test: the bench stopped its helper (no SITL left), restored the accepted tune and read it
      back exactly; the independent MSP read afterwards equals the accepted tune (the start tune, or the tune accepted
      before the interrupted step).
PASS when C1–C5 hold; FAIL otherwise (the failing criteria named); INSUFFICIENT when evidence is missing.
Reported separately: whether a normal session restored a step on its own (spontaneous RESTORE).
"""

import json
import sys
from pathlib import Path

P = {
    "targets": {"pm": 45.0, "gm": 6.0, "s": 6.0},
    "tolerance": {"pm": 5.0, "gm": 1.5, "s": 1.0},
    "guards": {"motor": 1.10, "overshootAbs": 0.02, "trackingRel": 1.05, "riseRel": 1.15, "riseAbsMs": 2.0, "fcMinRel": 0.9,
               "oscillationMax": 0.08, "sMaxDb": 10.0},
    "gmMaxSigmaDb": 1.5,
    "gmBand": (5.0, 85.0),
    "v1MinDrop": 0.5,
    "v2K": 2.0,
}
AXES = ("roll", "pitch")
TUNE_AXES = ("roll", "pitch", "yaw")


def tune_eq(a, b):
    return all(int(a[x][k]) == int(b[x][k]) for x in TUNE_AXES for k in ("p", "i", "d", "dMax"))


def stat(xs):
    xs = sorted(xs)
    n = len(xs)
    med = xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2
    return {"median": med, "spread": xs[-1] - xs[0]}


def summary_of(meas):
    """Medians and spreads of an independent measurement (measure_tune.py measurement.json)."""
    runs = [r for r in meas["runs"] if r["status"] == "ok"]
    out = {"valid": len(runs) == len(meas["runs"]) == 3, "issues": [], "axes": {}}
    for r in meas["runs"]:
        pl = r.get("plant") or {}
        if r["status"] != "ok":
            out["issues"].append(f"run_{r['start']}:{r['status']}")
        elif max(pl.get("maxAbsRollDeg", 99), pl.get("maxAbsPitchDeg", 99)) > 45 or pl.get("minZ", 0) < 0.3:
            out["issues"].append(f"run_{r['start']}:envelope")
        a = {k: int(v) for k, v in (r.get("active") or {}).get("roll", {}).items()} if r.get("active") else None
        if not r.get("active") or not tune_eq({x: r["active"][x] for x in TUNE_AXES}, meas["tune"]):
            out["issues"].append(f"run_{r['start']}:active_tune_differs")
    for ax in AXES:
        ref = [r["ref"][ax] for r in runs]
        st = [r["steps"]["axes"][ax] for r in runs]
        sig = [x.get("gmSigmaDb") for x in ref]
        gm_assess = all(x.get("gmHz") is not None and P["gmBand"][0] <= x["gmHz"] <= P["gmBand"][1] and x.get("gmSigmaDb") is not None
                        and x["gmSigmaDb"] <= P["gmMaxSigmaDb"] for x in ref)
        gm = stat([x["gm"] for x in ref])
        smax = max((x if x is not None else P["gmMaxSigmaDb"]) for x in sig)
        out["axes"][ax] = {
            "fc": stat([x["fc"] for x in ref]), "pm": stat([x["pm"] for x in ref]), "gm": gm, "gmLow": gm["median"] - 2 * smax,
            "gmAssessable": gm_assess, "s": stat([x["s"] for x in ref]),
            "tracking": stat([x["trackingRel"] for x in st]), "overshoot": stat([x["overshoot"] for x in st]),
            "riseMs": stat([x["riseMs"] for x in st]), "oscillation": stat([x["oscillation"] for x in st]),
        }
        a = out["axes"][ax]
        if a["pm"]["spread"] > 1.0:
            out["issues"].append(f"pm_spread:{ax}")
        if a["s"]["spread"] > 0.3:
            out["issues"].append(f"s_spread:{ax}")
    out["motors"] = [stat([r["noise"]["motorBandHover"][m] for r in runs]) for m in range(4)]
    for r in runs:
        if (r["noise"]["hover"]["samples"] or 0) < 3072:
            out["issues"].append(f"run_{r['start']}:hover_samples")
        if (r["noise"].get("motorClip") or 0) > 0:
            out["issues"].append(f"run_{r['start']}:motor_clip")
    out["valid"] = out["valid"] and not out["issues"]
    return out


def shortfall(a):
    t, tol = P["targets"], P["tolerance"]
    return max(0, t["pm"] - a["pm"]["median"]) / tol["pm"] + max(0, t["gm"] - a["gmLow"]) / tol["gm"] + max(0, a["s"]["median"] - t["s"]) / tol["s"]


def meets(a):
    return {"pm": a["pm"]["median"] >= 45, "gm": a["gmAssessable"] and a["gmLow"] >= 6, "s": a["s"]["median"] <= 6}


def decide(base, cand, start, changed_axes):
    """The session_v1 rule: guards on both axes, improvement on (any of) the changed axes. Returns (verdict, failed, why)."""
    if not cand["valid"]:
        return "INVALID", cand["issues"], []
    G = P["guards"]
    failed = []
    for m in range(4):
        if cand["motors"][m]["median"] / base["motors"][m]["median"] > G["motor"]:
            failed.append(f"G1_motor_vs_accepted:m{m + 1}")
        if cand["motors"][m]["median"] / start["motors"][m]["median"] > G["motor"]:
            failed.append(f"G1_motor_vs_start:m{m + 1}")
    for ax in AXES:
        A, C = base["axes"][ax], cand["axes"][ax]
        u = lambda k: max(A[k]["spread"], C[k]["spread"])  # noqa: E731
        mA, mC = meets(A), meets(C)
        for k in ("pm", "gm", "s"):
            if mA[k] and not mC[k]:
                failed.append(f"G2_{k}_stays_met:{ax}")
        if C["pm"]["median"] < A["pm"]["median"] - 5:
            failed.append(f"G2_pm_not_worse:{ax}")
        if C["gmLow"] < A["gmLow"] - 1.5:
            failed.append(f"G2_gm_not_worse:{ax}")
        if C["s"]["median"] > A["s"]["median"] + 1:
            failed.append(f"G2_s_not_worse:{ax}")
        if C["overshoot"]["median"] > A["overshoot"]["median"] + G["overshootAbs"] + u("overshoot"):
            failed.append(f"G3_overshoot:{ax}")
        if C["tracking"]["median"] > G["trackingRel"] * A["tracking"]["median"] + u("tracking"):
            failed.append(f"G4_tracking:{ax}")
        if C["riseMs"]["median"] > G["riseRel"] * A["riseMs"]["median"] + G["riseAbsMs"] + u("riseMs"):
            failed.append(f"G5_rise:{ax}")
        if C["fc"]["median"] < G["fcMinRel"] * A["fc"]["median"] - u("fc"):
            failed.append(f"G5_crossover:{ax}")
        osc_lim = max(G["oscillationMax"], A["oscillation"]["median"] + u("oscillation"))
        if C["oscillation"]["median"] > osc_lim:
            failed.append(f"G6_oscillation:{ax}")
        if C["s"]["median"] > max(G["sMaxDb"], A["s"]["median"] + u("s")):
            failed.append(f"G6_s_peak:{ax}")
        if A["gmAssessable"] and not C["gmAssessable"]:
            failed.append(f"G6_gm_assessable:{ax}")
    why = []
    for ax in changed_axes:
        A, C = base["axes"][ax], cand["axes"][ax]
        u = {k: max(A[k]["spread"], C[k]["spread"]) for k in ("pm", "gm", "s")}
        dA, dC = shortfall(A), shortfall(C)
        uD = u["pm"] / 5 + u["gm"] / 1.5 + u["s"] / 1
        if dA - dC >= P["v1MinDrop"] and dA - dC > uD:
            why.append(f"V1:{ax}:{dA:.2f}->{dC:.2f}")
        mA = meets(A)
        if not mA["pm"] and C["pm"]["median"] - 45 >= P["v2K"] * u["pm"]:
            why.append(f"V2:{ax}:pm")
        if not mA["gm"] and C["gmAssessable"] and C["gmLow"] - 6 >= P["v2K"] * u["gm"]:
            why.append(f"V2:{ax}:gm")
        if not mA["s"] and 6 - C["s"]["median"] >= P["v2K"] * u["s"]:
            why.append(f"V2:{ax}:s")
    if failed:
        return "RESTORE", failed, why
    if not why:
        return "RESTORE", ["no_improvement"], why
    return "ACCEPT", [], why


def load_journal(d):
    p = d / "journal.jsonl"
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.is_file() else None


def session_evidence(d):
    """C1 checks of one session from its bench journal; returns (ok, notes, finish record)."""
    j = load_journal(d)
    if j is None:
        return None, ["journal_missing"], None
    notes = []
    for e in j:
        if e["op"] == "setTune":
            rb = e.get("readback") or {}
            if not rb or not tune_eq(rb["tune"], e["tune"]) or rb.get("pidProfile") != 0 or rb.get("armed"):
                notes.append(f"set_readback_differs:{e['at']}")
        if e["op"] == "restore" and not e.get("exact"):
            notes.append(f"restore_readback_differs:{e['at']}")
        if e["op"] == "measure":
            for r in e["runs"]:
                a = r.get("active")
                if r["status"] == "ok" and (not a or a.get("armed") or a.get("pidProfile") != 0):
                    notes.append(f"measure_active_missing:{e['label']}:{r['start']}")
    fin = next((e for e in reversed(j) if e["op"] == "finish"), None)
    # every run of a measurement must read the tune it measured: the tune set (or committed/started) before it
    tune_now = None
    for e in j:
        if e["op"] in ("craft_start_tune",):
            tune_now = e["tune"]
        elif e["op"] == "readActive":
            tune_now = e["active"]["tune"]
        elif e["op"] == "setTune":
            tune_now = e["tune"]
        elif e["op"] == "restore":
            tune_now = (e.get("accepted") or {}).get("tune", tune_now)
        elif e["op"] == "measure" and tune_now:
            for r in e["runs"]:
                if r["status"] == "ok" and r.get("active") and not tune_eq(r["active"]["tune"], tune_now):
                    notes.append(f"measure_active_differs:{e['label']}:{r['start']}")
    return not notes, notes, fin


def selftest():
    def meas(pm, motor=7.8, ov=0.1, s=5.6):
        run = lambda k: {"start": 420 + k, "status": "ok", "plant": {"maxAbsRollDeg": 15, "maxAbsPitchDeg": 15, "minZ": 1.0},  # noqa: E731
                         "active": T, "ref": {ax: {"fc": 30, "pm": pm if ax == "roll" else 50, "gm": 12, "gmHz": 67, "gmSigmaDb": 0.5, "s": s} for ax in AXES},
                         "steps": {"axes": {ax: {"trackingRel": 0.47, "overshoot": ov, "riseMs": 14, "oscillation": 0.02} for ax in AXES}},
                         "noise": {"motorBandHover": [motor] * 4, "hover": {"samples": 11000}, "motorClip": 0}}
        return {"tune": T, "runs": [run(k) for k in range(3)]}
    T = {x: {"p": 1, "i": 1, "d": 1, "dMax": 0} for x in TUNE_AXES}
    s0 = summary_of(meas(39.7))
    cases = [
        ("improvement accepted", decide(s0, summary_of(meas(45.5)), s0, ["roll"])[0], "ACCEPT"),
        ("motor guard", decide(s0, summary_of(meas(45.5, motor=8.8)), s0, ["roll"])[0], "RESTORE"),
        ("overshoot guard", decide(s0, summary_of(meas(45.5, ov=0.13)), s0, ["roll"])[0], "RESTORE"),
        ("no improvement", decide(s0, summary_of(meas(39.9)), s0, ["roll"])[1], ["no_improvement"]),
        ("narrow miss newly met (V2)", decide(summary_of(meas(44.8)), summary_of(meas(45.3)), s0, ["roll"])[0], "ACCEPT"),
    ]
    ok = True
    for name, got, want in cases:
        good = got == want
        ok &= good
        print(("ok  " if good else "FAIL"), name, got)
    print("selftest", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main():
    if "--selftest" in sys.argv:
        return selftest()
    D = Path(sys.argv[1])
    proto = json.loads((D / "protocol.json").read_text())
    res = {"protocol": proto["version"], "sessions": {}, "criteria": {}, "spontaneousRestore": []}
    c1, c2_hits, c3, c4, c5 = [], [], [], [], []
    for s in proto["sessions"]:
        sid = s["id"]
        d = D / "sessions" / sid
        ok, notes, fin = session_evidence(d)
        row = {"kind": s["kind"], "evidence": ok, "notes": notes}
        acc = json.loads((d / "accepted.json").read_text()) if (d / "accepted.json").is_file() else None
        ind = d / "independent_read" / "result.json"
        ind_read = json.loads(ind.read_text()) if ind.is_file() else None
        ind_tune = None
        if ind_read and ind_read.get("status") == "ok":
            dec = ind_read["active"]["decoded"]
            ind_tune = {x: {k: dec[x][k] for k in ("p", "i", "d", "dMax")} for x in TUNE_AXES}
        row["accepted"] = acc
        row["independentRead"] = ind_tune
        row["independentReadEqualsAccepted"] = bool(acc and ind_tune and tune_eq(acc["tune"], ind_tune))
        if s["kind"] in ("normal", "restore_test"):
            if not fin:
                c1.append(f"{sid}:no_finish")
            else:
                r = fin["result"]
                row["stopReason"] = r["stopReason"]
                row["status"] = r["status"]
                row["steps"] = [{k: x[k] for k in ("index", "axis", "scripted", "verdict", "reasons", "baseMeasurementId", "measurementId")} for x in r["steps"]]
                if r["status"] != "finished" or r.get("error"):
                    c1.append(f"{sid}:status_{r['status']}:{r.get('error')}")
                for x in r["steps"]:
                    if x.get("restore") is not None and not x["restore"]["exact"]:
                        c1.append(f"{sid}:step{x['index']}:restore_not_exact")
            if not ok:
                c1.append(f"{sid}:{','.join(notes)}")
            if not row["independentReadEqualsAccepted"]:
                c1.append(f"{sid}:independent_read_differs_from_accepted")
        if s["kind"] == "normal" and fin:
            steps = fin["result"]["steps"]
            row["spontaneousRestore"] = [x["index"] for x in steps if x["verdict"] == "RESTORE" and not x["scripted"]]
            if row["spontaneousRestore"]:
                res["spontaneousRestore"].append({"session": sid, "steps": row["spontaneousRestore"]})
            accepted_axes = sorted({x["axis"] for x in steps if x["verdict"] == "ACCEPT"})
            fdir = D / "final" / sid
            if accepted_axes:
                if (fdir / "start" / "measurement.json").is_file() and (fdir / "best" / "measurement.json").is_file():
                    st = summary_of(json.loads((fdir / "start" / "measurement.json").read_text()))
                    be = summary_of(json.loads((fdir / "best" / "measurement.json").read_text()))
                    v, failed, why = decide(st, be, st, accepted_axes)
                    row["final"] = {"verdict": v, "failed": failed, "why": why, "startValid": st["valid"], "bestValid": be["valid"],
                                    "startIssues": st["issues"], "bestIssues": be["issues"],
                                    "start": {ax: {k: (st["axes"][ax][k]["median"] if isinstance(st["axes"][ax][k], dict) else st["axes"][ax][k]) for k in st["axes"][ax]} for ax in AXES},
                                    "best": {ax: {k: (be["axes"][ax][k]["median"] if isinstance(be["axes"][ax][k], dict) else be["axes"][ax][k]) for k in be["axes"][ax]} for ax in AXES},
                                    "motorRatio": [be["motors"][m]["median"] / st["motors"][m]["median"] for m in range(4)]}
                    if v == "ACCEPT":
                        c2_hits.append(sid)
                    if any(f.startswith("G") for f in failed):
                        c4.append(f"{sid}:{','.join(f for f in failed if f.startswith('G'))}")
                else:
                    row["final"] = None
                    c4.append(f"{sid}:final_missing")
        if s["kind"] == "restore_test" and fin:
            steps = fin["result"]["steps"]
            k = int(s["scriptedStep"])
            x = next((y for y in steps if y["index"] == k), None)
            prob = []
            if not x or not x["scripted"]:
                prob.append("scripted_step_missing")
            else:
                if x["verdict"] != "RESTORE" or not any(r.startswith("G") for r in x["reasons"]):
                    prob.append(f"verdict_{x['verdict']}:{x['reasons']}")
                if not (x.get("restore") or {}).get("exact"):
                    prob.append("restore_not_exact")
                prev_acc = [y for y in steps if y["index"] < k and y["verdict"] == "ACCEPT"]
                base_id = prev_acc[-1]["measurementId"] if prev_acc else (fin["result"].get("startMeasurement") or {}).get("id")
                if x["baseMeasurementId"] != base_id:
                    prob.append("scripted_step_base_not_last_accepted")
                nxt = next((y for y in steps if y["index"] == k + 1), None)
                if nxt is None and fin["result"]["stopReason"] not in ("no_eligible_candidate", "targets_met", "step_floor"):
                    prob.append(f"no_next_step:{fin['result']['stopReason']}")
                if nxt is not None and nxt["baseMeasurementId"] != base_id:
                    prob.append("next_step_base_not_last_accepted")
                if s.get("afterAccept") and not prev_acc:
                    prob.append("no_accept_before_scripted_step")
            row["restoreTest"] = prob or "ok"
            if prob:
                c3.append(f"{sid}:{','.join(prob)}")
        if s["kind"] in ("stop_test", "disconnect_test"):
            j = load_journal(d) or []
            ab = [e for e in j if e["op"] == "abort"]
            prob = []
            if len(ab) != 1:
                prob.append(f"aborts:{len(ab)}")
            else:
                a = ab[0]
                if not a.get("helperStopped"):
                    prob.append("helper_not_stopped")
                if not a.get("restoredExact"):
                    prob.append("restore_not_exact")
                want_why = "stop" if s["kind"] == "stop_test" else "connection_lost"
                if a.get("why") != want_why:
                    prob.append(f"abort_why_{a.get('why')}")
            # commits: "start" (the read tune), the start measurement's id, then one per ACCEPT
            commits = [e for e in j if e["op"] == "commitAccepted"]
            accepts = len(commits) - 2
            if s.get("afterAccept") and accepts < 1:
                prob.append("no_accept_before_interruption")
            if not s.get("afterAccept") and accepts != 0:
                prob.append(f"accepts_before_interruption:{accepts}")
            if a_tune := (acc or {}).get("tune"):
                restored = (ab[0].get("restored") if ab else None) or None
                rs = [e for e in j if e["op"] == "restore"]
                if not rs or not rs[-1].get("readback") or not tune_eq(rs[-1]["readback"]["tune"], a_tune):
                    prob.append("restore_readback_not_accepted_tune")
            if not row["independentReadEqualsAccepted"]:
                prob.append("independent_read_differs_from_accepted")
            row["interruptTest"] = prob or "ok"
            if prob:
                c5.append(f"{sid}:{','.join(prob)}")
        res["sessions"][sid] = row
    res["criteria"] = {
        "C1_evidence": c1 or "ok",
        "C2_confirmed_improvement": c2_hits or "none",
        "C3_restore_tests": c3 or "ok",
        "C4_no_worse": c4 or "ok",
        "C5_interrupt_tests": c5 or "ok",
    }
    fails = [k for k, v in res["criteria"].items() if (v != "ok" and k != "C2_confirmed_improvement") or (k == "C2_confirmed_improvement" and v == "none")]
    res["verdict"] = "PASS" if not fails else "FAIL"
    res["failing"] = fails
    (D / "verdict.json").write_text(json.dumps(res, indent=1))
    lines = [f"# Verdict {res['verdict']} (protocol {res['protocol']})", ""]
    for k, v in res["criteria"].items():
        lines.append(f"- {k}: {v}")
    lines.append(f"- spontaneous RESTORE in normal sessions: {res['spontaneousRestore'] or 'none'}")
    (D / "VERDICT.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

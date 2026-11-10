"""Compare GyroFlight's roll margins with the independent reference per run and apply PROTOCOL.md (v1).

Usage: compare.py <out dir> runs.json   (runs.json: [{"id","arm","tune","rep","dir"}], each dir holding result.json,
reference.json and gyroflight.json). Writes <out dir>/results.json and <out dir>/RESULTS.md.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

import numpy as np

LIMITS = {"fcRel": 0.10, "pmDeg": 5.0, "sDb": 1.0, "gmDb": 1.5, "dPmDeg": 3.0, "dFcRel": 0.10, "repeatPmDeg": 1.0}
BAND = (5.0, 50.0)
GM_BAND = (5.0, 85.0)


def cplx(v):
    return complex(v[0], v[1])


def margins_of(f, L, lo, hi):
    band = (f >= lo) & (f <= hi)
    fb, Lb = f[band], L[band]
    g = 20 * np.log10(np.abs(Lb))
    ph = np.degrees(np.unwrap(np.angle(Lb)))
    fc = pm = None
    for k in range(1, len(fb)):
        if g[k - 1] > 0 >= g[k]:
            t = (0 - g[k - 1]) / (g[k] - g[k - 1])
            fc = fb[k - 1] + t * (fb[k] - fb[k - 1])
            pm = (180 + np.interp(fc, fb, ph) + 180) % 360 - 180
            break
    S = 1 / np.abs(1 + Lb)
    return {"fc": None if fc is None else float(fc), "pm": None if pm is None else float(pm), "s": float(20 * np.log10(S.max()))}


def load(dir_: Path):
    r = json.loads((dir_ / "result.json").read_text())
    ref = json.loads((dir_ / "reference.json").read_text()) if (dir_ / "reference.json").is_file() else None
    gf = json.loads((dir_ / "gyroflight.json").read_text()) if (dir_ / "gyroflight.json").is_file() else None
    return r, ref, gf


def assess_run(run, r, ref, gf):
    out = {**run, "status": None, "issues": [], "gf": {}, "ref": {}, "diff": {}, "split": None}
    if r.get("status") != "ok":
        out["status"] = "INSUFFICIENT"
        out["issues"].append(f"sitl:{r.get('reason')}")
        return out
    plant = r.get("plant", {})
    if plant.get("maxAbsRollDeg", 0) > 45 or plant.get("minZ", 1) < 0.3:
        out["issues"].append(f"envelope:roll{plant.get('maxAbsRollDeg'):.1f}_z{plant.get('minZ'):.2f}")
    if ref is None or ref.get("status") != "ok":
        out["status"] = "INSUFFICIENT"
        out["issues"].append(f"reference:{None if ref is None else ref.get('reason')}")
        return out
    # reference validity
    if abs(ref["samplePeriodMaxS"] - 0.001) > 1e-6:
        out["issues"].append(f"reference:sample_period_{ref['samplePeriodMaxS']}")
    if not (abs(ref["generatorHz"][0] - 2.0) < 0.3 and abs(ref["generatorHz"][1] - 100.0) < 1.0):
        out["issues"].append(f"reference:generator_{ref['generatorHz']}")
    rm = ref["margins"]
    if rm["minCoherencePlantInBand"] < 0.99 or rm["minCoherenceDtermInBand"] < 0.99:
        out["issues"].append(f"reference:coherence_G{rm['minCoherencePlantInBand']:.3f}_D{rm['minCoherenceDtermInBand']:.3f}")
    if rm["crossoverHz"] is None:
        out["issues"].append("reference:no_crossover")
    i0 = ref["marginsIZero"]
    if rm["phaseMarginDeg"] is not None and i0["phaseMarginDeg"] is not None:
        out["ref"]["pmItermSensitivityDeg"] = rm["phaseMarginDeg"] - i0["phaseMarginDeg"]
        if abs(out["ref"]["pmItermSensitivityDeg"]) > 3:
            out["issues"].append("reference:iterm_state_pm_>3deg")
    out["ref"].update({"fc": rm["crossoverHz"], "pm": rm["phaseMarginDeg"], "gm": rm["gainMarginDb"], "gmHz": rm.get("phaseCrossingHz"), "s": rm["sensitivityPeakDb"], "sHz": rm["sensitivityPeakHz"], "kp": ref["kp"]})
    if any(x.startswith("reference:") for x in out["issues"]):
        out["status"] = "INSUFFICIENT"
        return out
    # GyroFlight validity
    if gf is None or not gf.get("margins") or gf["chirpRoll"] is None or gf["chirpRoll"]["state"] != "usable":
        out["status"] = "INSUFFICIENT"
        out["issues"].append(f"gyroflight:{None if gf is None else gf.get('chirpRoll')}")
        return out
    gm_ = gf["margins"]
    meas = gm_["measured"]
    out["gf"].update({"fc": gm_["crossoverHz"], "pm": meas["phaseMarginDeg"], "gm": meas["gainMarginDb"], "s": meas["sensitivityPeakDb"], "evidence": gm_["evidence"]["level"], "band": gm_["evidence"]["bandHz"], "status": gm_["status"], "reasons": gm_["reasons"], "dtermAccepted": (gf.get("dterm") or {}).get("accepted"), "dtermNrmse": (gf.get("dterm") or {}).get("nrmse"), "itermRelax": gf.get("itermRelax")})
    if gm_["crossoverHz"] is None or meas["phaseMarginDeg"] is None:
        out["status"] = "INSUFFICIENT"
        out["issues"].append(f"gyroflight:no_measured_margin:{gm_['reasons']}")
        return out
    d = out["diff"]
    d["fcRel"] = (out["gf"]["fc"] - out["ref"]["fc"]) / out["ref"]["fc"]
    d["pmDeg"] = out["gf"]["pm"] - out["ref"]["pm"]
    d["sDb"] = None if meas["sensitivityPeakDb"] is None else meas["sensitivityPeakDb"] - out["ref"]["s"]
    gm_assessed = out["ref"]["gm"] is not None and meas["gainMarginDb"] is not None and GM_BAND[0] <= (out["ref"]["gmHz"] or 0) <= GM_BAND[1]
    d["gmDb"] = (meas["gainMarginDb"] - out["ref"]["gm"]) if gm_assessed else None
    d["gmAssessed"] = gm_assessed
    fails = []
    if abs(d["fcRel"]) > LIMITS["fcRel"]:
        fails.append(f"fc {d['fcRel'] * 100:+.1f}% (limit ±10%)")
    if abs(d["pmDeg"]) > LIMITS["pmDeg"]:
        fails.append(f"PM {d['pmDeg']:+.1f}° (limit ±5°)")
    if d["sDb"] is None:
        fails.append("|S| GyroFlight null")
    elif abs(d["sDb"]) > LIMITS["sDb"]:
        fails.append(f"|S| {d['sDb']:+.2f} dB (limit ±1 dB)")
    if gm_assessed and abs(d["gmDb"]) > LIMITS["gmDb"]:
        fails.append(f"GM {d['gmDb']:+.2f} dB (limit ±1.5 dB)")
    out["fails"] = fails
    out["status"] = "FAIL" if fails else "PASS"
    out["split"] = split(ref, gf)
    return out


def split(ref, gf):
    """Controller and plant each against the reference, on the reference grid inside 5-50 Hz."""
    rb = [b for b in ref["bins"] if BAND[0] <= b["f"] <= BAND[1]]
    f = np.array([b["f"] for b in rb])
    Cref_ref = np.array([cplx(b["Cfb"]) for b in rb])
    G_ref = np.array([cplx(b["G"]) for b in rb])
    gb = gf.get("controllerBins") or []
    if not gb:
        return {"available": False}
    gfF = np.array([b["f"] for b in gb])
    def at(key):
        z = np.array([cplx(b[key]) for b in gb])
        return np.interp(f, gfF, z.real) + 1j * np.interp(f, gfF, z.imag)
    C_gf = at("Cfb")
    C_gf_sweep = at("CfbSweep")
    Cr_gf_sweep = at("CrefSweep")
    def cmp(a, b):
        return {"magDbMean": float(np.mean(20 * np.log10(np.abs(a) / np.abs(b)))), "magDbMax": float(np.max(np.abs(20 * np.log10(np.abs(a) / np.abs(b))))), "phaseDegMean": float(np.mean(np.degrees(np.angle(a / b)))), "phaseDegMax": float(np.max(np.abs(np.degrees(np.angle(a / b)))))}
    # controller as the engine reads margins (cfg) and as it extracts the plant (sweepCfg) vs the firmware's own
    out = {"available": True, "controller_cfg_vs_ref": cmp(C_gf, Cref_ref), "controller_sweepCfg_vs_ref": cmp(C_gf_sweep, Cref_ref)}
    # margins of the reference plant with GyroFlight's controller: isolates the controller's contribution
    Lc = C_gf * G_ref
    out["marginsRefPlantGfController"] = margins_of(f, Lc, *BAND)
    # GyroFlight-style plant from T with GyroFlight's sweep controller, if T is in the reference bins
    if "T" in rb[0]:
        T = np.array([cplx(b["T"]) for b in rb])
        G_gfstyle = T / (Cr_gf_sweep - T * C_gf_sweep)
        out["plant_gfstyle_vs_ref"] = cmp(G_gfstyle, G_ref)
        out["marginsGfStylePlantGfController"] = margins_of(f, G_gfstyle * C_gf, *BAND)
    out["per_bin"] = [{"f": float(f[k]), "CmagDb": float(20 * np.log10(abs(C_gf[k]) / abs(Cref_ref[k]))), "CphaseDeg": float(np.degrees(np.angle(C_gf[k] / Cref_ref[k])))} for k in range(0, len(f), 4)]
    return out


def main():
    out_dir = Path(sys.argv[1])
    runs = json.loads(Path(sys.argv[2]).read_text())
    rows = []
    for run in runs:
        r, ref, gf = load(Path(run["dir"]))
        rows.append(assess_run(run, r, ref, gf))
    # per tune (arm A), medians and the sign test
    tunes = {}
    for row in rows:
        if row["arm"] != "A" or row["status"] not in ("PASS", "FAIL"):
            continue
        tunes.setdefault(row["tune"], []).append(row)
    per_tune = {}
    for tune, rs in tunes.items():
        per_tune[tune] = {
            "n": len(rs),
            "gf": {k: statistics.median(x["gf"][k] for x in rs) for k in ("fc", "pm", "s")},
            "ref": {k: statistics.median(x["ref"][k] for x in rs) for k in ("fc", "pm", "s")},
            "repeatPmRangeGf": max(x["gf"]["pm"] for x in rs) - min(x["gf"]["pm"] for x in rs),
            "repeatPmRangeRef": max(x["ref"]["pm"] for x in rs) - min(x["ref"]["pm"] for x in rs),
        }
    sign = None
    if "56/79/30" in per_tune and "45/79/30" in per_tune:
        a, b = per_tune["56/79/30"], per_tune["45/79/30"]
        dpm_gf, dpm_ref = b["gf"]["pm"] - a["gf"]["pm"], b["ref"]["pm"] - a["ref"]["pm"]
        dfc_gf, dfc_ref = b["gf"]["fc"] - a["gf"]["fc"], b["ref"]["fc"] - a["ref"]["fc"]
        spread_gf = max(a["repeatPmRangeGf"], b["repeatPmRangeGf"])
        spread_ref = max(a["repeatPmRangeRef"], b["repeatPmRangeRef"])
        def sgn(v, spread):
            return 0 if abs(v) <= spread else (1 if v > 0 else -1)
        sign = {
            "dPmGf": dpm_gf, "dPmRef": dpm_ref, "dFcGf": dfc_gf, "dFcRef": dfc_ref,
            "pmSignOk": sgn(dpm_gf, spread_gf) == sgn(dpm_ref, spread_ref), "pmWithin3": abs(dpm_gf - dpm_ref) <= LIMITS["dPmDeg"],
            "fcSignOk": np.sign(dfc_gf) == np.sign(dfc_ref) or (abs(dfc_gf) < 0.02 * a["ref"]["fc"] and abs(dfc_ref) < 0.02 * a["ref"]["fc"]),
            "fcWithin10pct": abs(dfc_gf - dfc_ref) <= LIMITS["dFcRel"] * a["ref"]["fc"],
        }
    repeat_ok = all(t["repeatPmRangeGf"] < LIMITS["repeatPmDeg"] and t["repeatPmRangeRef"] < LIMITS["repeatPmDeg"] for t in per_tune.values()) if per_tune else None
    arm_a = [r for r in rows if r["arm"] == "A"]
    if any(r["status"] == "INSUFFICIENT" for r in arm_a) or len(arm_a) < 9 or sign is None:
        verdict = "INSUFFICIENT"
    elif all(r["status"] == "PASS" for r in arm_a) and sign["pmSignOk"] and sign["pmWithin3"] and sign["fcSignOk"] and sign["fcWithin10pct"] and repeat_ok:
        verdict = "PASS"
    else:
        verdict = "FAIL"
    results = {"verdict": verdict, "limits": LIMITS, "runs": rows, "perTune": per_tune, "signTest56to45": sign, "repeatOk": repeat_ok}
    (out_dir / "results.json").write_text(json.dumps(results, indent=1, default=float) + "\n")
    # markdown table
    lines = [f"# Resultaten (protocol v1) — oordeel: **{verdict}**", "", "| run | arm | tune | fc GF / ref (Hz) | Δfc | PM GF / ref (°) | ΔPM | |S| GF / ref (dB) | Δ|S| | GM GF / ref (dB) | status |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    def fmt(v, p=1):
        return "–" if v is None else f"{v:.{p}f}"
    for r in rows:
        g, rf, d = r["gf"], r["ref"], r["diff"]
        lines.append(f"| {r['id']} | {r['arm']} | {r['tune']} | {fmt(g.get('fc'))} / {fmt(rf.get('fc'))} | {fmt(None if not d else d['fcRel'] * 100)} % | {fmt(g.get('pm'))} / {fmt(rf.get('pm'))} | {fmt(None if not d else d['pmDeg'])} | {fmt(g.get('s'), 2)} / {fmt(rf.get('s'), 2)} | {fmt(None if not d else d['sDb'], 2)} | {fmt(g.get('gm'))} / {fmt(rf.get('gm'))}{'' if not d or d.get('gmAssessed') else ' (onbeoordeeld)'} | {r['status']}{(' — ' + '; '.join(r.get('fails') or r['issues'])) if (r.get('fails') or r['issues']) else ''} |")
    lines += ["", "## Per tune (mediaan, arm A)", "", "| tune | n | fc GF / ref | PM GF / ref | |S| GF / ref | PM-spreiding GF / ref |", "|---|---|---|---|---|---|"]
    for t, v in per_tune.items():
        lines.append(f"| {t} | {v['n']} | {v['gf']['fc']:.1f} / {v['ref']['fc']:.1f} | {v['gf']['pm']:.1f} / {v['ref']['pm']:.1f} | {v['gf']['s']:.2f} / {v['ref']['s']:.2f} | {v['repeatPmRangeGf']:.2f} / {v['repeatPmRangeRef']:.2f} |")
    if sign:
        lines += ["", f"P56 → P45: ΔPM GF {sign['dPmGf']:+.1f}° / ref {sign['dPmRef']:+.1f}° (teken gelijk: {sign['pmSignOk']}, binnen 3°: {sign['pmWithin3']}); Δfc GF {sign['dFcGf']:+.2f} / ref {sign['dFcRef']:+.2f} Hz (teken gelijk: {sign['fcSignOk']}, binnen 10 %: {sign['fcWithin10pct']}). Herhaalbaarheid < 1°: {repeat_ok}."]
    (out_dir / "RESULTS.md").write_text("\n".join(lines) + "\n")
    print(verdict)


if __name__ == "__main__":
    main()

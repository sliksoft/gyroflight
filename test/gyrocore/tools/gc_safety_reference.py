# This file is part of Gyroflight, a derivative of the Betaflight App (GPL-3.0-or-later).
#
# WU4 Safety-engine parity reference (first drafted by a read-only audit agent, extended in WU4A).
# Writes one JSON document, split by test/gyrocore/tools/split_safety_reference.py into
# test/gyrocore/fixtures/safety/safety_{foundation,product_path,harness}_reference.json, by evaluating GyroCore's Python
# reference (core/gyrocore/autotune/absolute.py, current_tune.py, betaflight/simplified_tuning.py,
# safety/*.py) on fixed inputs. Only imports GyroCore; writes nothing into the GyroCore repository.
# Run from a scratch directory with
#   PYTHONHASHSEED=0 TMPDIR=$PWD PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/GyroCore:~/GyroCore/core \
#     python3 -B gc_safety_reference.py > safety_reference.json
#
# Sections:
#   foundation.*        deterministic, no analysis evidence anywhere (product-relevant)
#   product_path        run_safety_pipeline(analysis=None, require_analysis=True): the only
#                       full-pipeline verdict the product can honestly reach today
#   harness.*           TEST-HARNESS ONLY: reference-test analysis dicts / mechanical gate kwargs.
#                       Not product evidence; never feed these into the product path.
import copy, json, math, os, subprocess, sys
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from gyrocore.autotune.absolute import extract_absolute_tune, propose_absolute_tune
from gyrocore.autotune.current_tune import extract_current_tune
from gyrocore.autotune.engine import AutotuneRecommendationResult, AxisRecommendation, RecommendationStatus
from gyrocore.betaflight import simplified_tuning as st
from gyrocore.betaflight.simplified_tuning import FieldMismatch, SliderValidity
from gyrocore.safety import (
    DEFAULT_MAX_DELTA, SafetyVerdict, apply_to_baseline, build_mechanical_safety_gate,
    clamp_safe_tune, evaluate_mechanical_safety, evaluate_tuning_output_safety,
    finalize_safe_tune, run_safety_pipeline,
)
from gyrocore.safety.clamps import apply_safety, apply_safety_autotune, record_numeric_clamps, scale_max_delta
from gyrocore.safety.output import _values_within_firmware
from gyrocore.safety.results import make_safe_tune_candidate
from gyrocore.safety.safe_tune import absolute_tune_to_config
from gyrocore.safety.thermal import (
    clamp_targets_to_baseline_thermal, classify_thermal_motor_risk, rpm_dshot_health_gate,
    should_enforce_baseline_envelope,
)

# ---------------------------------------------------------------- inputs
# Betaflight 2025.12+/2026.x firmware defaults (simplified_tuning.py PID_*_DEFAULT, D_MAX_DEFAULT,
# filter defaults) == tests/core/cli/helpers.py NOMINAL_CLI.
def cli_text(**over):
    v = dict(
        p_roll=45, i_roll=80, d_roll=30, f_roll=120, d_max_roll=40,
        p_pitch=47, i_pitch=84, d_pitch=34, f_pitch=125, d_max_pitch=46,
        p_yaw=45, i_yaw=80, d_yaw=0, f_yaw=120, d_max_yaw=0,
        dterm_lpf1_dyn_min_hz=75, dterm_lpf1_dyn_max_hz=150, dterm_lpf1_static_hz=75, dterm_lpf2_static_hz=150,
        gyro_lpf1_dyn_min_hz=250, gyro_lpf1_dyn_max_hz=500, gyro_lpf1_static_hz=250, gyro_lpf2_static_hz=500,
        simplified_pids_mode="RPY", simplified_master_multiplier=100, simplified_pi_gain=100,
        simplified_i_gain=100, simplified_d_gain=100, simplified_d_max_gain=100,
        simplified_feedforward_gain=100, simplified_pitch_pi_gain=100, simplified_pitch_d_gain=100,
        simplified_dterm_filter="ON", simplified_dterm_filter_multiplier=100,
        simplified_gyro_filter="ON", simplified_gyro_filter_multiplier=100,
    )
    for k, x in over.items():
        if x is None:
            v.pop(k, None)
        else:
            v[k] = x
    lines = ["# Betaflight / STM32F7X2 2026.6.2", "profile 0"]
    lines += [f"set {k} = {x}" for k, x in v.items()]
    lines.append("profile 0")
    return "\n".join(lines) + "\n"

NOMINAL_CLI = cli_text()

# Betaflight 4.5 defaults with 4.5 names (d_roll = D max, d_min_roll = D min; simplified_dmin_ratio).
BF45_CLI = """# Betaflight / STM32F7X2 4.5.1
profile 0
set p_roll = 45
set i_roll = 80
set d_roll = 40
set f_roll = 120
set d_min_roll = 30
set p_pitch = 47
set i_pitch = 84
set d_pitch = 46
set f_pitch = 125
set d_min_pitch = 34
set p_yaw = 45
set i_yaw = 80
set d_yaw = 0
set f_yaw = 120
set d_min_yaw = 0
set dterm_lpf1_dyn_min_hz = 75
set dterm_lpf1_dyn_max_hz = 150
set dterm_lpf1_static_hz = 75
set dterm_lpf2_static_hz = 150
set gyro_lpf1_dyn_min_hz = 250
set gyro_lpf1_dyn_max_hz = 500
set gyro_lpf1_static_hz = 250
set gyro_lpf2_static_hz = 500
set simplified_pids_mode = RPY
set simplified_master_multiplier = 100
set simplified_pi_gain = 100
set simplified_i_gain = 100
set simplified_d_gain = 100
set simplified_dmin_ratio = 100
set simplified_feedforward_gain = 100
set simplified_pitch_pi_gain = 100
set simplified_pitch_d_gain = 100
set simplified_dterm_filter = ON
set simplified_dterm_filter_multiplier = 100
set simplified_gyro_filter = ON
set simplified_gyro_filter_multiplier = 100
profile 0
"""

# Gyroflight test/gyrocore/harness/chirpSim.ts FULL_TUNE_HEADERS (what the WU3 generated logs carry).
GYROFLIGHT_FULL_TUNE_HEADERS = "\n".join("H " + h for h in [
    "Product:Blackbox flight data recorder by Nicholas Sherlock",
    "Firmware revision:Betaflight 2026.6.2 (synthetic) STM32F7X2",
    "rollPID:45,80,30", "pitchPID:47,84,34", "yawPID:45,80,0",
    "simplified_pids_mode:2", "simplified_master_multiplier:100", "simplified_pi_gain:100",
    "simplified_i_gain:100", "simplified_d_gain:100", "simplified_feedforward_gain:100",
    "simplified_dterm_filter:1", "simplified_dterm_filter_multiplier:100", "simplified_d_max_gain:100",
    "simplified_pitch_d_gain:100", "simplified_pitch_pi_gain:100", "simplified_gyro_filter:1",
    "simplified_gyro_filter_multiplier:100",
]) + "\n"

KEYS = ["slider_master_multiplier", "slider_pi_gain", "slider_i_gain", "slider_d_gain",
        "slider_feedforward_gain", "slider_dterm_filter_multiplier"]

def sliders(value=100, **o):
    s = {k: value for k in KEYS}
    s.update(o)
    return s

WU3_POSITIVE = sliders(100, slider_pi_gain=138, slider_feedforward_gain=138)

@dataclass
class Stub:
    proposed: dict

def axis(a, proposed, blocked=False):
    return AxisRecommendation(
        axis=a, status=RecommendationStatus.BLOCKED if blocked else RecommendationStatus.PROPOSED,
        blocked_reasons=("sysid_unusable",) if blocked else (), warnings=(), system_id=None,
        recommendation=None if blocked else Stub(proposed or {}), current_sliders=None,
        sample_rate_hz=None, upstream_sample_rate_hz=None)

def build_proposal(axes_in, *, cli=None, headers=None):
    tune = extract_current_tune(cli_dump=cli, headers=headers)
    axes = [axis(a, p, b) for a, p, b in axes_in]
    blocked = tuple(dict.fromkeys(r for x in axes for r in x.blocked_reasons))
    rec = AutotuneRecommendationResult(
        status=RecommendationStatus.BLOCKED if blocked else RecommendationStatus.PROPOSED,
        target_phase_margin_deg=60.0, current_tune=tune, axes={x.axis: x for x in axes},
        blocked_reasons=blocked, provenance={"test": True})
    return propose_absolute_tune(rec, cli_dump=cli, headers=headers)

def three(s):
    return [(0, s, False), (1, s, False), (2, s, False)]

# TEST-HARNESS ONLY (tests/core/safety/test_pipeline.py _clean_analysis == tests/core/cli/helpers.py
# clean_analysis). Not product evidence.
HARNESS_CLEAN_ANALYSIS = {
    "ok": True,
    "quality": {"status": "ok", "score": 90},
    "confidence": {"score": 0.92, "label": "high"},
    "problems": {"problems": []},
    "metrics": {"noise": {"value": 90.0, "hf_ratio": 0.05, "level": "LOW"}},
    "motors": {"diagnostics": {"motors": [], "health": 100}},
    "resonance": {"severity": "low"},
}

# ---------------------------------------------------------------- encoding
def clean(o):
    if isinstance(o, float):
        if math.isnan(o):
            return "NaN"
        if math.isinf(o):
            return "Infinity" if o > 0 else "-Infinity"
        return o
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if hasattr(o, "value") and o.__class__.__name__ in ("SafetyVerdict", "ValueSource", "RecommendationStatus"):
        return o.value
    return o

def tv(t):
    return {"value": t.value, "source": t.source.value} if t.present else {"value": None, "source": t.source.value, "note": t.note}

def flat_tune(t):
    if t is None:
        return None
    out = {}
    for ax in ("roll", "pitch", "yaw"):
        a = t.axis(ax)
        for c in ("p", "i", "d", "f", "d_max"):
            out[f"{ax}.{c}"] = tv(getattr(a, c))
    for pre in ("dterm", "gyro"):
        f = getattr(t, pre)
        for c in ("lpf1_dyn_min_hz", "lpf1_dyn_max_hz", "lpf1_static_hz", "lpf2_static_hz"):
            out[f"{pre}.{c}"] = tv(getattr(f, c))
    return out

def ints(t):
    """Value-only integer view of an AbsoluteTune (None when missing)."""
    if t is None:
        return None
    return {k: v["value"] for k, v in flat_tune(t).items()}

def validity(v):
    return None if v is None else v.to_dict()

def tv_full(t):
    d = t.to_dict()
    if isinstance(d["value"], list):
        d["value"] = [clean(x) for x in d["value"]]
    return d

def flat_tune_full(t):
    out = {}
    for ax in ("roll", "pitch", "yaw"):
        a = t.axis(ax)
        for c in ("p", "i", "d", "f", "d_max"):
            out[f"{ax}.{c}"] = tv_full(getattr(a, c))
    for pre in ("dterm", "gyro"):
        f = getattr(t, pre)
        for c in ("lpf1_dyn_min_hz", "lpf1_dyn_max_hz", "lpf1_static_hz", "lpf2_static_hz"):
            out[f"{pre}.{c}"] = tv_full(getattr(f, c))
    return out

def proj_proposal(p):
    return {
        "current_warnings": list(p.current.warnings),
        "current_full": flat_tune_full(p.current),
        "status": p.status,
        "blocked_reasons": list(p.blocked_reasons),
        "review_reasons": list(p.review_reasons),
        "warnings": list(p.warnings),
        "merge_status": p.merge.status,
        "merged_sliders": p.merge.proposed_sliders,
        "current_sliders": p.current.sliders.to_dict(),
        "current": flat_tune(p.current),
        "proposed": ints(p.proposed),
        "current_validity": validity(p.current_validity),
        "proposed_validity": validity(p.proposed_validity),
        "deltas": p.deltas,
    }

def checks(cs):
    return [{"rule_id": c.rule_id, "verdict": c.verdict.value, "before": c.before, "after": c.after} for c in cs]

def proj_mech(m):
    return {
        "status": m.status.value, "mechanical_block": m.mechanical_block,
        "mechanical_limited": m.mechanical_limited, "mechanical_caution": m.mechanical_caution,
        "mechanical_outcome": m.mechanical_outcome, "recommended_action": m.recommended_action,
        "reasons": list(m.reasons), "blocking_reasons": list(m.blocking_reasons),
        "limited_reasons": list(m.limited_reasons), "caution_reasons": list(m.caution_reasons),
        "max_delta_scale": m.max_delta_scale, "limited_tier": m.raw.get("limited_tier"),
        "checks": checks(m.checks),
    }

def proj_cand(c):
    return {
        "status": c.status.value, "clamp_ids": list(c.clamp_ids), "blocked_reasons": list(c.blocked_reasons),
        "warnings": list(c.warnings), "max_delta_used": c.max_delta_used,
        "current_config": c.current_config, "proposed_config": c.proposed_config,
        "clamped_config": c.clamped_config, "clamped_tune": ints(c.clamped_tune), "checks": checks(c.checks),
    }

def proj_tos(t):
    return {"status": t.status.value, "donor_status": t.donor_status,
            "blocking_reasons": list(t.blocking_reasons), "warning_reasons": list(t.warning_reasons),
            "checks": [{"rule_id": c.rule_id, "verdict": c.verdict.value} for c in t.checks],
            "legacy": {k: v for k, v in t.to_legacy_dict().items() if k != "mechanical"}}

def proj_final(f):
    return {
        "proposal": proj_proposal(f.proposal), "mechanical": proj_mech(f.mechanical),
        "candidate": proj_cand(f.candidate), "tuning_output_safety": proj_tos(f.output_safety),
        "final": {"status": f.status.value, "blocked_reasons": list(f.blocked_reasons),
                  "warnings": list(f.warnings), "actionable": f.actionable},
    }

def guarded(fn):
    try:
        return {"expected": fn(), "error": None}
    except Exception as e:
        return {"expected": None, "error": type(e).__name__}

# Betaflight 2026.6.2 / master blackbox.c header lines (writeHeader): CSV d_max, ff_weight, *_lpf1_dyn_hz.
def bf_headers(**over):
    v = {
        "rollPID": "45,80,30", "pitchPID": "47,84,34", "yawPID": "45,80,0",
        "d_max": "40,46,0", "ff_weight": "120,125,120",
        "dterm_lpf1_static_hz": "75", "dterm_lpf1_dyn_hz": "75,150", "dterm_lpf2_static_hz": "150",
        "gyro_lpf1_static_hz": "250", "gyro_lpf1_dyn_hz": "250,500", "gyro_lpf2_static_hz": "500",
        "simplified_pids_mode": "2", "simplified_master_multiplier": "100", "simplified_i_gain": "100",
        "simplified_d_gain": "100", "simplified_pi_gain": "100", "simplified_d_max_gain": "100",
        "simplified_feedforward_gain": "100", "simplified_pitch_d_gain": "100", "simplified_pitch_pi_gain": "100",
        "simplified_dterm_filter": "1", "simplified_dterm_filter_multiplier": "100",
        "simplified_gyro_filter": "1", "simplified_gyro_filter_multiplier": "100",
    }
    for k, x in over.items():
        if x is None:
            v.pop(k, None)
        else:
            v[k] = x
    lines = ["Product:Blackbox flight data recorder by Nicholas Sherlock",
             "Firmware revision:Betaflight 2026.6.2 (synthetic) STM32F7X2"]
    lines += [f"{k}:{x}" for k, x in v.items()]
    return "\n".join("H " + h for h in lines) + "\n"

BF_HEADERS = bf_headers()

# ---------------------------------------------------------------- foundation.absolute
ABSOLUTE_CASES = [
    # id, branch, source kind, source, axes
    ("nominal_noop", "proposed, no deltas", "cli", NOMINAL_CLI, three(sliders(100))),
    ("wu3_positive_nominal", "WU3 safe positive on firmware-default absolutes", "cli", NOMINAL_CLI, three(WU3_POSITIVE)),
    ("wu3_positive_gyroflight_headers", "WU3 safe positive on Gyroflight FULL_TUNE_HEADERS (no f/d_max/Hz)", "headers", GYROFLIGHT_FULL_TUNE_HEADERS, three(WU3_POSITIVE)),
    ("bf45_names_noop", "BF 4.5 d/d_min naming + simplified_dmin_ratio", "cli", BF45_CLI, three(sliders(100))),
    ("merge_review", "merge requires_review -> proposed None", "cli", NOMINAL_CLI,
        [(0, sliders(110), False), (1, sliders(150), False), (2, sliders(100), False)]),
    ("sysid_axis_blocked", "blocked axis -> recommendation.blocked_reasons -> proposal blocked", "cli", NOMINAL_CLI,
        [(0, None, True), (1, sliders(100), False), (2, sliders(100), False)]),
    ("pids_mode_off", "simplified_pids_mode_off mapping block", "cli", cli_text(simplified_pids_mode="OFF"), three(sliders(110))),
    ("pids_mode_rp", "RP mode, yaw not mapped", "cli", cli_text(simplified_pids_mode="RP"), three(sliders(105))),
    ("missing_d_max_gain", "proposed_pid_sliders_incomplete", "cli", cli_text(simplified_d_max_gain=None), three(sliders(100))),
    ("missing_dterm_filter_multiplier_current", "current slider missing", "cli", cli_text(simplified_dterm_filter_multiplier=None), three(sliders(100))),
    ("dterm_filter_off", "dterm filter OFF -> Hz unscaled", "cli", cli_text(simplified_dterm_filter="OFF"), three(sliders(100, slider_dterm_filter_multiplier=150))),
    ("missing_filter_hz", "missing Hz seeds 0 (not defaulted) + warning", "cli", cli_text(dterm_lpf1_static_hz=None, gyro_lpf2_static_hz=None), three(sliders(100))),
    ("missing_pids", "baseline incomplete", "cli", "set simplified_pids_mode = RPY\nset simplified_pi_gain = 100\n", three(sliders(100))),
    ("current_inconsistent_with_sliders", "current p_roll != slider mapping -> current_validity mismatch", "cli", cli_text(p_roll=60), three(sliders(100))),
    ("sliders_outside_cli_range", "25/250 sliders -> proposed_sliders_outside_cli_minmax warning", "cli", NOMINAL_CLI, three(sliders(100, slider_pi_gain=250, slider_dterm_filter_multiplier=25))),
    ("unparseable_value", "unparseable CLI value stays missing", "cli", cli_text(p_roll="abc"), three(sliders(100))),
    ("nan_slider_proposal", "NaN in per-axis proposal", "cli", NOMINAL_CLI, three(sliders(100, slider_pi_gain=float("nan")))),
    # WU4A: real Betaflight header format (no CLI dump, as in Gyroflight).
    ("hdr_bf_noop", "BF header lines, no-op", "headers", BF_HEADERS, three(sliders(100))),
    ("hdr_bf_wu3_positive", "BF header lines, WU3 safe positive", "headers", BF_HEADERS, three(WU3_POSITIVE)),
    ("hdr_bf_rp_mode", "BF header lines, RP mode", "headers", bf_headers(simplified_pids_mode="1"), [(0, sliders(105), False), (1, sliders(105), False)]),
    ("hdr_bf_pids_off", "BF header lines, pids OFF", "headers", bf_headers(simplified_pids_mode="0"), three(sliders(110))),
    ("hdr_bf_nan_pid", "non-numeric rollPID element", "headers", bf_headers(rollPID="45,x,30"), three(sliders(100))),
    ("hdr_bf_short_pid", "rollPID with two elements", "headers", bf_headers(rollPID="45,80"), three(sliders(100))),
    ("hdr_bf_gyro_multiplier_missing", "gyro filter ON, multiplier missing", "headers", bf_headers(simplified_gyro_filter_multiplier=None), three(sliders(100))),
    ("hdr_bf_gyro_filter_missing", "gyro filter switch missing", "headers", bf_headers(simplified_gyro_filter=None), three(sliders(100))),
    ("hdr_bf_dterm_off", "dterm filter OFF", "headers", bf_headers(simplified_dterm_filter="0"), three(sliders(100, slider_dterm_filter_multiplier=150))),
    ("hdr_bf_dterm_150", "dterm multiplier 150", "headers", BF_HEADERS, three(sliders(100, slider_dterm_filter_multiplier=150))),
    ("hdr_bf_current_inconsistent", "logged rollPID inconsistent with sliders", "headers", bf_headers(rollPID="60,80,30"), three(sliders(100))),
    ("hdr_bf_slider_unparseable", "slider header not an integer", "headers", bf_headers(simplified_pi_gain="abc"), three(sliders(100))),
    ("hdr_bf_mode_text", "pids mode given as text", "headers", bf_headers(simplified_pids_mode="RPY", simplified_dterm_filter="ON", simplified_gyro_filter="ON"), three(sliders(100))),
    ("hdr_bf45_dmin", "4.5-style d_min CSV and simplified_dmin_ratio", "headers",
        bf_headers(d_max=None, simplified_d_max_gain=None) + "H d_min:30,34,0\nH simplified_dmin_ratio:100\n", three(sliders(100))),
    ("hdr_bf_master_150", "master 150 (proposal over the step caps)", "headers", BF_HEADERS, three(sliders(150))),
]

def absolute_section():
    out = []
    for cid, branch, kind, src, axes_in in ABSOLUTE_CASES:
        kw = {"cli": src} if kind == "cli" else {"headers": src}
        out.append({"case_id": cid, "branch": branch,
                    "input": {kind: src, "axes": [{"axis": a, "blocked": b, "proposed": p} for a, p, b in axes_in]},
                    **guarded(lambda: proj_proposal(build_proposal(axes_in, **kw)))})
    return out

# ---------------------------------------------------------------- foundation.simplified_tuning
def simplified_section():
    cases = []
    for cid, s in [
        ("defaults", {}),
        ("master_200", {"master_multiplier": 200}),
        ("pi_138_ff_138", {"pi_gain": 138, "feedforward_gain": 138}),
        ("all_25", {k: 25 for k in ("master_multiplier", "pi_gain", "i_gain", "d_gain", "feedforward_gain", "d_max_gain", "pitch_d_gain", "pitch_pi_gain")}),
        ("all_250", {k: 250 for k in ("master_multiplier", "pi_gain", "i_gain", "d_gain", "feedforward_gain", "d_max_gain", "pitch_d_gain", "pitch_pi_gain")}),
        ("d_max_gain_0", {"d_max_gain": 0}),
        ("pids_rp", {"pids_mode": 1, "pi_gain": 120}),
        ("pids_off", {"pids_mode": 0, "pi_gain": 120}),
        ("dterm_mult_50", {"dterm_filter_multiplier": 50}),
        ("dterm_mult_200", {"dterm_filter_multiplier": 200}),
        ("gyro_mult_200", {"gyro_filter_multiplier": 200}),
        ("dterm_off_gyro_off", {"dterm_filter": 0, "gyro_filter": 0, "dterm_filter_multiplier": 150}),
    ]:
        def run(s=s):
            base_p, base_g = st.firmware_default_pid_profile(), st.firmware_default_gyro()
            sl = replace(base_p.sliders, **s)
            prof, gyro = replace(base_p, sliders=sl), replace(base_g, sliders=sl)
            mp, mg = st.apply_simplified_tuning(prof, gyro)
            return {"sliders": sl.to_dict(), "profile": mp.to_dict(), "gyro": mg.to_dict(),
                    "validity_of_mapped": st.validate_simplified_tuning(mp, mg).to_dict(),
                    "validity_of_unmapped_defaults": st.validate_simplified_tuning(prof, gyro).to_dict(),
                    "outside_cli_range": list(st.sliders_outside_cli_range(sl))}
        cases.append({"case_id": cid, "input": {"slider_overrides": s}, **guarded(run)})
    return cases

def mapping_sweep():
    """Firmware PID mapping (calculateNewPidValues, RPY) over a fixed slider set: single-slider sweeps 0..255
    and a seeded random sample. Rows: [master, pi, i, d, ff, d_max_gain, pitch_d, pitch_pi] -> 15 ints."""
    import random
    names = ("master_multiplier", "pi_gain", "i_gain", "d_gain", "feedforward_gain", "d_max_gain", "pitch_d_gain", "pitch_pi_gain")
    combos = []
    for j in range(len(names)):
        for v in range(256):
            row = [100] * len(names)
            row[j] = v
            combos.append(row)
    rnd = random.Random(20261009)
    for _ in range(2000):
        combos.append([rnd.randint(0, 255) for _ in names])
    base = st.firmware_default_pid_profile()
    rows = []
    for row in combos:
        sl = replace(base.sliders, **dict(zip(names, row)))
        p = st.calculate_new_pid_values(replace(base, sliders=sl))
        out = []
        for a in (p.roll, p.pitch, p.yaw):
            out += [a.p, a.i, a.d, a.f, a.d_max]
        rows.append([row, out])
    return {"slider_order": list(names), "axis_fields": ["p", "i", "d", "f", "d_max"], "rows": rows}

# ---------------------------------------------------------------- foundation.safe_tune / output
# Mechanical results that need NO analysis evidence:
#   mech_none_not_required: evaluate_mechanical_safety(None, require_analysis=False) -> PASS, scale 1.0
#   mech_none_required:     evaluate_mechanical_safety(None, require_analysis=True)  -> BLOCK (product today)
def mech_clear():
    return evaluate_mechanical_safety(None, require_analysis=False)

def mech_missing():
    return evaluate_mechanical_safety(None, require_analysis=True)

def stage(proposal, mech, *, require_analysis, hardware=None):
    cand = clamp_safe_tune(proposal, mech, analysis=None, hardware=hardware)
    tos = evaluate_tuning_output_safety(cand, analysis=None, require_analysis=require_analysis)
    return proj_final(finalize_safe_tune(tos))

CLAMP_CASES = [
    # id, branch, cli, sliders, hardware
    ("noop", "PASS no clamp", NOMINAL_CLI, sliders(100), None),
    ("min_change_pi_99", "smallest change, PASS", NOMINAL_CLI, sliders(100, slider_pi_gain=99), None),
    ("min_change_pi_101_no_effect", "slider move with no absolute change", NOMINAL_CLI, sliders(100, slider_pi_gain=101), None),
    ("pi_110_at_cap", "P +4 / I +8 exactly at cap, PASS", NOMINAL_CLI, sliders(100, slider_pi_gain=110), None),
    ("pi_111_over_cap", "pitch P +5 / I +9 -> step clamp WARN", NOMINAL_CLI, sliders(100, slider_pi_gain=111), None),
    ("pi_92_at_cap_down", "P -4 at cap (decrease), PASS", NOMINAL_CLI, sliders(100, slider_pi_gain=92), None),
    ("pi_91_over_cap_down", "P -5 -> step clamp WARN", NOMINAL_CLI, sliders(100, slider_pi_gain=91), None),
    ("i_110_at_cap", "I +8 at cap", NOMINAL_CLI, sliders(100, slider_i_gain=110), None),
    ("i_111_over_cap", "pitch I +9 over cap", NOMINAL_CLI, sliders(100, slider_i_gain=111), None),
    ("i_91_at_cap_down", "I -8", NOMINAL_CLI, sliders(100, slider_i_gain=91), None),
    ("i_90_over_cap_down", "pitch I -9", NOMINAL_CLI, sliders(100, slider_i_gain=90), None),
    ("d_115_at_cap", "d_max +6 at cap", NOMINAL_CLI, sliders(100, slider_d_gain=115), None),
    ("d_116_over_cap", "pitch d_max +7 (d_max uses D cap)", NOMINAL_CLI, sliders(100, slider_d_gain=116), None),
    ("d_121_d_over_cap", "pitch D +7", NOMINAL_CLI, sliders(100, slider_d_gain=121), None),
    ("d_87_at_cap_down", "d_max -6 at cap", NOMINAL_CLI, sliders(100, slider_d_gain=87), None),
    ("d_86_over_cap_down", "pitch d_max -7", NOMINAL_CLI, sliders(100, slider_d_gain=86), None),
    ("ff_107_at_cap", "FF +8", NOMINAL_CLI, sliders(100, slider_feedforward_gain=107), None),
    ("ff_108_over_cap", "FF +9/+10", NOMINAL_CLI, sliders(100, slider_feedforward_gain=108), None),
    ("ff_94_at_cap_down", "FF -8", NOMINAL_CLI, sliders(100, slider_feedforward_gain=94), None),
    ("ff_93_over_cap_down", "FF -9", NOMINAL_CLI, sliders(100, slider_feedforward_gain=93), None),
    ("master_107_at_cap", "all components within cap", NOMINAL_CLI, sliders(100, slider_master_multiplier=107), None),
    ("master_200", "many simultaneous step clamps", NOMINAL_CLI, sliders(100, slider_master_multiplier=200), None),
    ("dterm_101_no_static_change", "dterm multiplier move that leaves lpf1_static unchanged, PASS", NOMINAL_CLI, sliders(100, slider_dterm_filter_multiplier=101), None),
    ("dterm_102_static_frozen", "dterm_lpf1_static_hz has no max_delta entry -> cap 0 -> frozen, WARN", NOMINAL_CLI, sliders(100, slider_dterm_filter_multiplier=102), None),
    ("dterm_94_no_hard", "decrease, step only", NOMINAL_CLI, sliders(100, slider_dterm_filter_multiplier=94), None),
    ("dterm_93_hard_min_70", "dyn_min 69 -> hard min 70", NOMINAL_CLI, sliders(100, slider_dterm_filter_multiplier=93), None),
    ("dterm_50_step_and_hard", "step + hard + dyn_max", NOMINAL_CLI, sliders(100, slider_dterm_filter_multiplier=50), None),
    ("dterm_200_step", "filter increases step-capped", NOMINAL_CLI, sliders(100, slider_dterm_filter_multiplier=200), None),
    ("wu3_positive", "WU3 safe positive, step clamps", NOMINAL_CLI, WU3_POSITIVE, None),
    # PID hard limits via out-of-range current tunes (stepped toward the default proposal)
    ("p_hard_max_inside", "current P 104 -> 100 exactly (inside)", cli_text(p_roll=104), sliders(100), None),
    ("p_hard_max_outside", "current P 105 -> 101 -> clamp 100", cli_text(p_roll=105), sliders(100), None),
    ("p_hard_min_inside", "current P 6 -> 10 exactly", cli_text(p_roll=6), sliders(100), None),
    ("p_hard_min_outside", "current P 5 -> 9 -> clamp 10", cli_text(p_roll=5), sliders(100), None),
    ("d_hard_max_inside", "current D 91 -> 85", cli_text(d_roll=91), sliders(100), None),
    ("d_hard_max_outside", "current D 92 -> 86 -> 85", cli_text(d_roll=92), sliders(100), None),
    ("ff_hard_max_inside", "current FF 228 -> 220", cli_text(f_roll=228), sliders(100), None),
    ("ff_hard_max_outside", "current FF 229 -> 221 -> 220", cli_text(f_roll=229), sliders(100), None),
    ("i_firmware_max_outside", "current I 259 -> 251 -> firmware 250", cli_text(i_roll=259), sliders(100), None),
    ("yaw_d_zero_preserved", "yaw D 0 is not raised to donor min 5", NOMINAL_CLI, sliders(100), None),
    # filter hard limits from current values (unchanged by Autotune keys, still hard-clamped)
    ("gyro_static_below_120", "gyro_lpf1_static 100 -> 120", cli_text(gyro_lpf1_static_hz=100), sliders(100), None),
    ("gyro_static_above_300", "gyro_lpf1_static 400 -> 300", cli_text(gyro_lpf1_static_hz=400), sliders(100), None),
    ("gyro_static_zero_off", "gyro_lpf1_static 0 preserved (OFF)", cli_text(gyro_lpf1_static_hz=0), sliders(100), None),
    ("gyro_lpf2_zero_off", "gyro_lpf2 0 preserved", cli_text(gyro_lpf2_static_hz=0), sliders(100), None),
    ("gyro_lpf2_below_80", "gyro_lpf2 50 -> 80", cli_text(gyro_lpf2_static_hz=50), sliders(100), None),
    ("gyro_dyn_max_below_min", "gyro dyn_max raised to dyn_min", cli_text(gyro_lpf1_dyn_min_hz=400, gyro_lpf1_dyn_max_hz=300), sliders(100), None),
    ("dterm_dyn_max_raise", "dterm dyn_max raised to dyn_min+10", cli_text(dterm_lpf1_dyn_min_hz=150, dterm_lpf1_dyn_max_hz=150), sliders(100), None),
    ("dterm_lpf2_above_250", "dterm_lpf2 300 -> 250 (after step)", cli_text(dterm_lpf2_static_hz=300), sliders(100), None),
    # hardware weight
    ("weight_800", "weight 800 (not > 800): no scale", NOMINAL_CLI, sliders(100), {"weight": 800}),
    ("weight_801", "weight 801: D and d_max x0.9 (float, rounded half-even)", NOMINAL_CLI, sliders(100), {"weight": 801}),
    ("weight_801_half_even", "current D 19 -> step 25 -> x0.9 = 22.5 -> Python round 22 (JS Math.round 23)", cli_text(d_roll=19), sliders(100), {"weight": 801}),
    ("weight_nan", "NaN weight ignored", NOMINAL_CLI, sliders(100), {"weight": float("nan")}),
    # current tune invalid / missing
    ("missing_pids_baseline", "missing_required_pid_or_filter_baseline", "set simplified_pids_mode = RPY\nset simplified_pi_gain = 100\n", sliders(100), None),
    ("missing_one_filter", "missing dterm_lpf1_static_hz", cli_text(dterm_lpf1_static_hz=None), sliders(100), None),
    ("missing_d_max_only", "d_max missing is not critical; proposed d_max passes unclamped", cli_text(d_max_roll=None, d_max_pitch=None, d_max_yaw=None), sliders(100, slider_d_gain=138), None),
    ("pids_mode_off", "proposal blocked", cli_text(simplified_pids_mode="OFF"), sliders(110), None),
    ("bf45_names", "BF 4.5 naming", BF45_CLI, sliders(100), None),
]

def clamp_section():
    out = []
    for cid, branch, cli, s, hw in CLAMP_CASES:
        p_axes = three(s)
        out.append({
            "case_id": cid, "branch": branch,
            "input": {"cli": cli, "axes": [{"axis": a, "blocked": b, "proposed": p} for a, p, b in p_axes],
                      "hardware": hw, "analysis": None, "mechanical": "evaluate_mechanical_safety(None, require_analysis=False)",
                      "require_analysis": False},
            **guarded(lambda: stage(build_proposal(p_axes, cli=cli), mech_clear(), require_analysis=False, hardware=hw)),
        })
    # Structural (non-slider) proposal branches.
    extra = [
        ("merge_review", [(0, sliders(110), False), (1, sliders(150), False), (2, sliders(100), False)], NOMINAL_CLI),
        ("sysid_axis_blocked", [(0, None, True), (1, sliders(100), False), (2, sliders(100), False)], NOMINAL_CLI),
    ]
    for cid, axes_in, cli in extra:
        out.append({"case_id": cid, "branch": cid, "input": {"cli": cli, "axes": [{"axis": a, "blocked": b, "proposed": p} for a, p, b in axes_in],
                    "hardware": None, "analysis": None, "require_analysis": False},
                    **guarded(lambda: stage(build_proposal(axes_in, cli=cli), mech_clear(), require_analysis=False))})
    return out

# Construct-only TOS branches (unreachable from propose_absolute_tune with real inputs).
def construct_only_section():
    out = []
    base = build_proposal(three(sliders(100)), cli=NOMINAL_CLI)

    def slider_inconsistent():
        p = replace(base, proposed_validity=SliderValidity(False, True, True, pid_mismatches=(FieldMismatch("roll.p", 45, 60),)))
        return stage(p, mech_clear(), require_analysis=False)

    def invalid_simplified():
        p = replace(base, proposed_validity=SliderValidity(False, False, False, skipped_reasons=("pids_mode_off",)))
        return stage(p, mech_clear(), require_analysis=False)

    def values_invalid():
        mech = mech_clear()
        cand = clamp_safe_tune(base, mech)
        bad = copy.deepcopy(dict(cand.clamped_config))
        bad["pid"]["roll"]["p"] = 251.0
        bad["filters"]["gyro_lpf1_static_hz"] = float("nan")
        cand2 = make_safe_tune_candidate(status=cand.status, proposal=cand.proposal, mechanical=mech,
            current_config=cand.current_config, proposed_config=cand.proposed_config, clamped_config=bad,
            clamped_tune=cand.clamped_tune, max_delta_used=cand.max_delta_used, clamp_ids=cand.clamp_ids,
            checks=cand.checks, blocked_reasons=(), warnings=cand.warnings, provenance={})
        return proj_final(finalize_safe_tune(evaluate_tuning_output_safety(cand2, analysis=None, require_analysis=False)))

    def missing_current_tune():
        p = replace(base, current=replace(base.current, current_tune=None), blocked_reasons=("missing_current_tune",), status="blocked")
        return stage(p, mech_clear(), require_analysis=False)

    def blocked_none_proposed():
        p = replace(base, proposed=None, status="blocked", blocked_reasons=("system_id_unusable_axis",))
        return stage(p, mech_clear(), require_analysis=False)

    for cid, fn in [("slider_inconsistency", slider_inconsistent), ("invalid_simplified_state", invalid_simplified),
                    ("resulting_values_invalid", values_invalid), ("missing_current_tune", missing_current_tune),
                    ("malformed_blocked_proposal_sysid", blocked_none_proposed)]:
        out.append({"case_id": cid, "construction": "dataclasses.replace / make_safe_tune_candidate (construct-only)", **guarded(fn)})
    return out

# ---------------------------------------------------------------- foundation.stages (pure functions)
def cfg(**over):
    c = {"pid": {"roll": {"p": 45.0, "i": 80.0, "d": 30.0, "ff": 120.0, "d_max": 40.0},
                 "pitch": {"p": 47.0, "i": 84.0, "d": 34.0, "ff": 125.0, "d_max": 46.0},
                 "yaw": {"p": 45.0, "i": 80.0, "d": 0.0, "ff": 120.0, "d_max": 0.0}},
         "filters": {"dterm_lpf1_dyn_min_hz": 75.0, "dterm_lpf1_dyn_max_hz": 150.0, "dterm_lpf1_static_hz": 75.0,
                     "dterm_lpf2_static_hz": 150.0, "gyro_lpf1_dyn_min_hz": 250.0, "gyro_lpf1_dyn_max_hz": 500.0,
                     "gyro_lpf1_static_hz": 250.0, "gyro_lpf2_static_hz": 500.0}}
    for k, v in over.items():
        if "." in k:
            a, comp = k.split(".")
            c["pid"][a][comp] = v
        else:
            c["filters"][k] = v
    return c

def stages_section():
    out = {}
    out["scale_max_delta"] = [{"scale": s, **guarded(lambda s=s: scale_max_delta(DEFAULT_MAX_DELTA, s))}
                              for s in (1.0, 0.75, 0.65, 0.5, 0.0, 1.5, -1.0, float("nan"), "x")]
    atb = [
        ("caps_up", cfg(), cfg(**{"roll.p": 90, "roll.i": 200, "roll.d": 90, "roll.ff": 250, "roll.d_max": 90, "gyro_lpf1_static_hz": 100, "dterm_lpf1_dyn_min_hz": 40}), DEFAULT_MAX_DELTA),
        ("scaled_075_half_values", cfg(), cfg(**{"roll.d": 40, "roll.p": 50}), scale_max_delta(DEFAULT_MAX_DELTA, 0.75)),
        ("scaled_065", cfg(), cfg(**{"roll.p": 50}), scale_max_delta(DEFAULT_MAX_DELTA, 0.65)),
        ("zero_scale", cfg(), cfg(**{"roll.p": 50}), scale_max_delta(DEFAULT_MAX_DELTA, 0.0)),
        ("bad_max_delta_entries", cfg(), cfg(**{"roll.p": 50, "gyro_lpf2_static_hz": 400}),
            {"pid": {"roll": {"p": -1}}, "filters": {"gyro_lpf2_static_hz": float("nan")}}),
        ("d_max_fallback_to_d_cap", cfg(), cfg(**{"roll.d_max": 60}), {"pid": {"roll": {"d": 6}}}),
        ("target_key_not_in_base", cfg(), {"filters": {"unknown_hz": 1}, "pid": {"roll": {"x": 1}}}, DEFAULT_MAX_DELTA),
    ]
    out["apply_to_baseline"] = [{"case_id": c, "base": b, "target": t, "max_delta": m, **guarded(lambda b=b, t=t, m=m: apply_to_baseline(b, t, m))} for c, b, t, m in atb]

    sc = {"dyn_notch_width_percent": 30, "rpm_filter_min_hz": 10, "rpm_filter_max_hz": 3000, "rpm_filter_fade_range_hz": -1,
          "dyn_idle_min_rpm": 250, "anti_gravity_gain": 30000, "anti_gravity_cutoff": 300, "anti_gravity_p_gain": 2000,
          "feedforward_smooth_factor": 101, "feedforward_jitter_factor": -1, "feedforward_boost": 101, "feedforward_transition": 101,
          "rc_smoothing": 2, "rc_smoothing_feedforward": 101, "iterm_relax": 4, "iterm_rotation": 2, "tpa_rate": 101,
          "tpa_breakpoint": 900, "throttle_boost": 101, "motor_output_limit": 0}
    asf = [
        ("nominal", cfg(), {}),
        ("scalar_ranges_all_out", {"pid": {}, "filters": dict(sc)}, {}),
        ("scalar_ranges_all_edges_inside", {"pid": {}, "filters": {"tpa_breakpoint": 1000, "motor_output_limit": 1, "rpm_filter_min_hz": 20, "rpm_filter_max_hz": 2000}}, {}),
        ("hz_edges", cfg(gyro_lpf1_static_hz=120, gyro_lpf1_dyn_min_hz=1000, gyro_lpf1_dyn_max_hz=601, gyro_lpf2_static_hz=79,
                         dterm_lpf1_dyn_min_hz=151, dterm_lpf1_dyn_max_hz=301, dterm_lpf2_static_hz=251), {}),
        ("hz_zero_off_autotune", cfg(gyro_lpf1_static_hz=0, gyro_lpf1_dyn_min_hz=0, gyro_lpf1_dyn_max_hz=0, dterm_lpf1_dyn_min_hz=0,
                                     dterm_lpf1_dyn_max_hz=0, dterm_lpf2_static_hz=0, gyro_lpf2_static_hz=0), {}),
        ("hz_zero_not_skipped_donor_mode", cfg(gyro_lpf1_static_hz=0, dterm_lpf1_dyn_min_hz=0), {"autotune": False}),
        ("tiny_positive_hz_1e-7", cfg(gyro_lpf1_static_hz=1e-7), {}),
        ("pid_edges", cfg(**{"roll.p": 100, "pitch.p": 100.5, "roll.d": 85, "pitch.d": 4.9, "roll.ff": 220, "pitch.ff": 221, "yaw.d": 0, "yaw.p": 0}), {}),
        ("firmware_ceilings", cfg(**{"roll.i": 251, "roll.d_max": 300, "pitch.i": -1}), {}),
        ("confidence_039_blend", cfg(**{"roll.p": 49}), {"confidence": 0.39, "baseline": cfg()}),
        ("confidence_040_no_blend", cfg(**{"roll.p": 49}), {"confidence": 0.4, "baseline": cfg()}),
        ("confidence_0_blend", cfg(**{"roll.p": 49}), {"confidence": 0.0, "baseline": cfg()}),
        ("confidence_nan_ignored", cfg(**{"roll.p": 49}), {"confidence": float("nan"), "baseline": cfg()}),
        ("confidence_low_no_baseline", cfg(**{"roll.p": 49}), {"confidence": 0.1}),
        ("weight_801", cfg(), {"hardware": {"weight": 801}}),
        ("weight_800", cfg(), {"hardware": {"weight": 800}}),
        ("weight_string", cfg(), {"hardware": {"weight": "heavy"}}),
    ]
    rows = []
    for c, conf, opt in asf:
        def run(conf=conf, opt=opt):
            fn = apply_safety if opt.get("autotune") is False else apply_safety_autotune
            r, ids = fn(copy.deepcopy(conf), opt.get("hardware"), opt.get("confidence"), baseline=opt.get("baseline"))
            return {"config": r, "limits": ids}
        rows.append({"case_id": c, "config": conf, "options": {k: v for k, v in opt.items()}, **guarded(run)})
    out["apply_safety_autotune"] = rows

    out["record_numeric_clamps"] = [{"before": cfg(), "after": cfg(**{"roll.p": 49, "gyro_lpf1_static_hz": 120, "dterm_lpf2_static_hz": 80}),
        "expected_sorted": sorted([c.rule_id for c in record_numeric_clamps(cfg(), cfg(**{"roll.p": 49, "gyro_lpf1_static_hz": 120, "dterm_lpf2_static_hz": 80}), rule_prefix="x")]),
        "note": "filter check order iterates a Python set; compare as sorted"}]

    vwf = [("nominal", cfg()), ("pid_over", cfg(**{"roll.p": 251, "roll.ff": 1001})), ("negative", cfg(**{"roll.i": -1}, gyro_lpf2_static_hz=-1)),
           ("nan", cfg(**{"roll.d": float("nan")})), ("non_numeric", cfg(**{"roll.p": "x"}, gyro_lpf1_static_hz="y")),
           ("hz_over", cfg(gyro_lpf1_static_hz=1001, dterm_lpf1_dyn_max_hz=1000)), ("missing", None)]
    out["values_within_firmware"] = [{"case_id": c, "config": x, **guarded(lambda x=x: list(_values_within_firmware(x)))} for c, x in vwf]

    th = [("stable_baseline", cfg(**{"roll.d": 40, "roll.d_max": 50}, gyro_lpf1_static_hz=300, dterm_lpf2_static_hz=200), cfg(), True),
          ("gyro_baseline_zero_non_binding", cfg(gyro_lpf1_static_hz=300), cfg(gyro_lpf1_static_hz=0), True),
          ("no_risk_passthrough", cfg(**{"roll.d": 40}), cfg(), False),
          ("within_1e-6", cfg(**{"roll.d": 30.0000005}), cfg(), True)]
    rows = []
    for c, t, b, risk in th:
        def run(t=t, b=b, risk=risk):
            locks = []
            r = clamp_targets_to_baseline_thermal(t, b, thermal_risk=risk, locks=locks)
            return {"config": r, "locks": locks}
        rows.append({"case_id": c, "targets": t, "baseline": b, "thermal_risk": risk, **guarded(run)})
    out["clamp_targets_to_baseline_thermal"] = rows
    return out

# ---------------------------------------------------------------- product path (no fabricated evidence)
def product_section():
    rows = []
    for cid, axes_in, kw in [
        ("wu3_positive_firmware_defaults_analysis_none", three(WU3_POSITIVE), {"cli": NOMINAL_CLI}),
        ("wu3_positive_gyroflight_headers_analysis_none", three(WU3_POSITIVE), {"headers": GYROFLIGHT_FULL_TUNE_HEADERS}),
        ("wu3_positive_bf45_cli_analysis_none", three(WU3_POSITIVE), {"cli": BF45_CLI}),
        ("noop_firmware_defaults_analysis_none", three(sliders(100)), {"cli": NOMINAL_CLI}),
        ("analysis_not_ok", three(sliders(100)), {"cli": NOMINAL_CLI, "_analysis": {"ok": False, "message": "no_usable_samples"}}),
        ("hdr_bf_wu3_positive_analysis_none", three(WU3_POSITIVE), {"headers": BF_HEADERS}),
        ("hdr_bf_noop_analysis_none", three(sliders(100)), {"headers": BF_HEADERS}),
        ("hdr_bf_rp_mode_analysis_none", [(0, sliders(105), False), (1, sliders(105), False)], {"headers": bf_headers(simplified_pids_mode="1")}),
        ("hdr_bf_missing_ff_weight_analysis_none", three(WU3_POSITIVE), {"headers": bf_headers(ff_weight=None)}),
    ]:
        analysis = kw.pop("_analysis", None)
        rows.append({"case_id": cid, "input": {**kw, "axes": [{"axis": a, "blocked": b, "proposed": p} for a, p, b in axes_in],
                     "analysis": analysis, "require_analysis": True},
                     **guarded(lambda axes_in=axes_in, kw=dict(kw), analysis=analysis:
                               proj_final(run_safety_pipeline(build_proposal(axes_in, **kw), analysis=analysis, require_analysis=True)))})
    return rows

# ---------------------------------------------------------------- harness (NOT product evidence)
def harness_section():
    A = HARNESS_CLEAN_ANALYSIS
    def with_(**o):
        a = copy.deepcopy(A); a.update(o); return a
    pipe = [
        ("clean_noop", three(sliders(100)), {"cli": NOMINAL_CLI}, A, None),
        ("clean_pi_110_at_cap", three(sliders(100, slider_pi_gain=110)), {"cli": NOMINAL_CLI}, A, None),
        ("clean_wu3_positive_firmware_defaults", three(WU3_POSITIVE), {"cli": NOMINAL_CLI}, A, None),
        ("clean_wu3_positive_gyroflight_headers", three(WU3_POSITIVE), {"headers": GYROFLIGHT_FULL_TUNE_HEADERS}, A, None),
        ("conf_039", three(sliders(100, slider_pi_gain=110)), {"cli": NOMINAL_CLI}, with_(confidence={"score": 0.39}), None),
        ("conf_040", three(sliders(100, slider_pi_gain=110)), {"cli": NOMINAL_CLI}, with_(confidence={"score": 0.40}), None),
        ("conf_0_quirk", three(sliders(100, slider_pi_gain=110)), {"cli": NOMINAL_CLI}, with_(confidence={"score": 0.0}), None),
        ("conf_nan", three(sliders(100, slider_pi_gain=110)), {"cli": NOMINAL_CLI}, with_(confidence={"score": float("nan")}), None),
        ("conf_plain_number", three(sliders(100)), {"cli": NOMINAL_CLI}, with_(confidence=0.3), None),
        ("quality_low", three(sliders(100)), {"cli": NOMINAL_CLI}, with_(quality={"status": "low_quality"}), None),
        ("noise_high", three(sliders(100)), {"cli": NOMINAL_CLI}, with_(metrics={"noise": {"value": 40.0, "hf_ratio": 0.4, "level": "HIGH"}}), None),
        ("motor_issue_medium_thermal", three(sliders(100, slider_d_gain=110)), {"cli": NOMINAL_CLI},
            with_(problems={"problems": [{"type": "motor_issue", "severity": "medium", "confidence": 0.3, "description": "hot"}]}), None),
        ("desync_flag_envelope", three(sliders(100, slider_d_gain=110)), {"cli": NOMINAL_CLI}, with_(has_desync_risk=True), None),
        ("rpm_health_unhealthy_envelope", three(sliders(100, slider_d_gain=110)), {"cli": NOMINAL_CLI}, with_(rpm_dshot_health={"status": "unhealthy"}), None),
        ("danger_problem_block", three(sliders(100)), {"cli": NOMINAL_CLI},
            with_(problems={"problems": [{"type": "motor_issue", "severity": "high", "confidence": 0.8, "description": "confirmed motor desync"}]}), None),
        ("motor_warning_caution", three(sliders(100)), {"cli": NOMINAL_CLI},
            with_(motors={"diagnostics": {"motors": [{"motor": 2, "status": "warning", "confidence": 0.55, "health": 78}], "health": 100}}), None),
        ("two_warning_motors_clean_caution", three(sliders(100, slider_pi_gain=110)), {"cli": NOMINAL_CLI},
            with_(motors={"diagnostics": {"motors": [{"motor": 1, "status": "warning", "confidence": 0.55}, {"motor": 2, "status": "warning", "confidence": 0.55}], "health": 100}}), None),
        ("weight_801", three(sliders(100)), {"cli": NOMINAL_CLI}, A, {"weight": 801}),
    ]
    prow = []
    for cid, axes_in, kw, analysis, hw in pipe:
        prow.append({"case_id": cid, "input": {**kw, "axes": [{"axis": a, "blocked": b, "proposed": p} for a, p, b in axes_in],
                     "analysis": analysis, "hardware": hw, "require_analysis": True},
                     **guarded(lambda axes_in=axes_in, kw=kw, analysis=analysis, hw=hw:
                               proj_final(run_safety_pipeline(build_proposal(axes_in, **kw), analysis=analysis, hardware=hw, require_analysis=True)))})

    M = lambda motors: {"motors": motors}
    clean_metrics = {"noise": {"value": 90.0, "hf_ratio": 0.05}, "resonance": {"severity": "low"}}
    gate = [
        ("empty", {}),
        ("danger_motor_issue", {"pipeline_problems": {"problems": [{"type": "motor_issue", "severity": "high", "confidence": 0.8, "description": "desync"}]}}),
        ("danger_conf_054", {"pipeline_problems": {"problems": [{"type": "x", "severity": "high", "confidence": 0.54, "description": "crash"}]}}),
        ("danger_conf_055", {"pipeline_problems": {"problems": [{"type": "x", "severity": "medium", "confidence": 0.55, "description": "crash"}]}}),
        ("danger_negated", {"pipeline_problems": {"problems": [{"type": "x", "severity": "high", "confidence": 0.9, "description": "no desync observed, crash-free"}]}}),
        ("danger_inferred_phrase", {"pipeline_problems": {"problems": [{"type": "x", "severity": "high", "confidence": 0.9, "description": "desync risk indicators"}]}}),
        ("motor_issue_high_no_danger", {"pipeline_problems": {"problems": [{"type": "motor_issue", "severity": "high", "confidence": 0.9, "description": "hot"}]}}),
        ("motor_issue_medium", {"pipeline_problems": {"problems": [{"type": "motor_issue", "severity": "medium", "confidence": 0.9}]}}),
        ("mechanical_text_conf_025", {"pipeline_problems": {"problems": [{"type": "x", "severity": "medium", "confidence": 0.25, "description": "bent shaft"}]}}),
        ("mechanical_text_conf_024", {"pipeline_problems": {"problems": [{"type": "x", "severity": "medium", "confidence": 0.24, "description": "bent shaft"}]}}),
        ("bad_motor_health_51_conf_035", {"motor_diagnostics": M([{"status": "bad", "confidence": 0.35, "health": 51.9, "health_basis": "absolute"}]), "engine_metrics": {"noise": {"value": 40.0}}}),
        ("bad_motor_health_52", {"motor_diagnostics": M([{"status": "bad", "confidence": 0.35, "health": 52.0, "issues": ["noise"]}]), "engine_metrics": {"noise": {"value": 40.0}}}),
        ("bad_motor_conf_034", {"motor_diagnostics": M([{"status": "bad", "confidence": 0.34, "health": 10}])}),
        ("correction_demand_only", {"motor_diagnostics": M([{"status": "bad", "confidence": 0.6, "health": 40, "issues": ["vibration"]}]), "engine_metrics": clean_metrics, "noise_level": "LOW"}),
        ("confirmed_spectral_bad_motor", {"motor_diagnostics": M([{"status": "bad", "confidence": 0.6, "issues": ["broadband_noise"]}]), "engine_metrics": clean_metrics}),
        ("warning_only_clean", {"motor_diagnostics": M([{"status": "warning", "confidence": 0.55}]), "engine_metrics": clean_metrics, "noise_level": "LOW"}),
        ("warning_one_hf_035", {"motor_diagnostics": M([{"status": "warning", "confidence": 0.55}]), "engine_metrics": {"noise": {"value": 90.0, "hf_ratio": 0.35}}}),
        ("warning_two", {"motor_diagnostics": M([{"status": "warning", "confidence": 0.55}, {"status": "warning", "confidence": 0.55}]), "engine_metrics": clean_metrics}),
        ("relative_bad", {"motor_diagnostics": M([{"status": "bad", "confidence": 0.5, "health": 80, "issues": ["noise"]}]), "engine_metrics": {"noise": {"value": 40.0}}}),
        ("noise_45_broad_bw60", {"engine_metrics": {"noise": {"value": 45.0}, "resonance": {"severity": "low"}}, "resonance_module": {"primary": {"bandwidth": 60}}}),
        ("noise_4501_bw_5999", {"engine_metrics": {"noise": {"value": 45.01}, "resonance": {"severity": "low"}}, "resonance_module": {"primary": {"bandwidth": 59.99}}}),
        ("persistent_spread_90_high_noise", {"engine_metrics": {"noise": {"value": 30.0}}, "resonance_module": {"spread": 90}}),
        ("medium_broad_spread_75", {"engine_metrics": {"noise": {"value": 90.0}, "resonance": {"severity": "medium"}}, "resonance_module": {"spread": 75}}),
        ("low_conf_044_high_noise_caution", {"engine_metrics": {"noise": {"value": 30.0}}, "confidence_eval": {"score": 0.44}}),
        ("low_conf_045_high_noise", {"engine_metrics": {"noise": {"value": 30.0}}, "confidence_eval": {"score": 0.45}}),
        ("low_quality_warning_motor", {"motor_diagnostics": M([{"status": "warning", "confidence": 0.55}]), "quality_status": "low_quality", "engine_metrics": clean_metrics}),
        ("nan_inputs", {"engine_metrics": {"noise": {"value": float("nan"), "hf_ratio": float("inf")}}, "confidence_eval": {"score": float("nan")}}),
        ("aggressive_context_only_recorded", {"flight_context": {"style": "racing"}}),
    ]
    grow = [{"case_id": c, "kwargs": k, **guarded(lambda k=k: build_mechanical_safety_gate(**k))} for c, k in gate]

    th_cases = [("none", None), ("health_051", {"motor_diagnostics": {"health": 0.51}}), ("health_052", {"motor_diagnostics": {"health": 0.52}}),
                ("sev_medium", {"problems": [{"type": "motor_issue", "severity": "medium"}]}), ("sev_005", {"problems": [{"type": "motor_issue", "severity": 0.05}]}),
                ("sev_006", {"problems": [{"type": "motor_issue", "severity": 0.06}]}), ("sev_023", {"problems": [{"type": "motor_issue", "severity": 0.23}]}),
                ("sev_039", {"problems": [{"type": "motor_issue", "severity": 0.39}]}), ("health_61_issue", {"motor_diagnostics": {"health": 61}, "problems": [{"type": "motor_issue", "severity": 0.06}]}),
                ("stress_082", {"motor_diagnostics": {"health": 0.18}}), ("stress_065", {"motor_diagnostics": {"health": 0.35}}), ("stress_042", {"motor_diagnostics": {"health": 0.58}}),
                ("desync_problem_type", {"problems": {"problems": [{"type": "esc_desync"}]}}),
                ("rpm_healthy_all", {"rpm_dshot_health": {"status": "healthy", "rpm_filter_enabled": True, "dshot_bidir": True, "rpm_telemetry_present": True, "motor_poles_known": True}}),
                ("rpm_partial", {"rpm_dshot_health": {"status": "ok", "rpm_filter_enabled": True}}),
                ("filter_intelligence", {"filter_intelligence": {"confidence": {"rpm_filter": "medium"}, "filter_state": {"rpm_filter": True, "dshot_bidir": True, "motor_poles": 14, "rpm_telemetry_present": True}, "spectral_evidence": {"quality": "low"}}})]
    trow = [{"case_id": c, "analysis": a, **guarded(lambda a=a: {"classify": classify_thermal_motor_risk(a), "rpm_gate": rpm_dshot_health_gate(a),
             "enforce": should_enforce_baseline_envelope(a)})} for c, a in th_cases]
    return {"label": "TEST_HARNESS_ONLY_NOT_PRODUCT_EVIDENCE", "analysis_source": "tests/core/safety/test_pipeline.py::_clean_analysis == tests/core/cli/helpers.py::clean_analysis",
            "clean_analysis": A, "pipeline": prow, "mechanical_gate": grow, "thermal_envelope": trow}

# ---------------------------------------------------------------- main
rev = subprocess.run(["git", "-C", str(Path.home() / "GyroCore"), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
doc = {
    "generator": "test/gyrocore/tools/gc_safety_reference.py",
    "gyrocore_commit": rev,
    "pythonhashseed": os.environ.get("PYTHONHASHSEED"),
    "constants": {"DEFAULT_MAX_DELTA": DEFAULT_MAX_DELTA, "PID_GAIN_MAX": st.PID_GAIN_MAX, "F_GAIN_MAX": st.F_GAIN_MAX,
                  "LPF_MAX_HZ": st.LPF_MAX_HZ, "DYN_LPF_MAX_HZ": st.DYN_LPF_MAX_HZ, "firmware": st.FIRMWARE_PROVENANCE},
    "conventions": {"non_finite": "encoded as strings NaN/Infinity/-Infinity",
                    "order_insensitive": ["candidate.clamp_ids", "tuning_output_safety.warning_reasons", "final.warnings",
                                          "candidate.checks (filter entries)"],
                    "float_tolerance": 1e-9, "rounding": "clamped_tune uses Python round(): half to even"},
    "foundation": {"absolute": absolute_section(), "simplified_tuning": simplified_section(), "mapping_sweep": mapping_sweep(),
                   "safe_tune_output": clamp_section(),
                   "construct_only": construct_only_section(), "stages": stages_section()},
    "product_path": product_section(),
    "harness": harness_section(),
}
sys.stdout.write(json.dumps(clean(doc), indent=1, allow_nan=False, default=str))
sys.stdout.write("\n")

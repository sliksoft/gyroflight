# This file is part of Gyroflight, a derivative of the Betaflight App (GPL-3.0-or-later).
#
# Writes test/gyrocore/fixtures/merge/merge_reference.json: GyroCore's global-slider merge
# (core/gyrocore/autotune/merge.py, merge_autotune_sliders) evaluated on fixed inputs, for
# test/gyrocore/global_merge_parity.test.ts. It only imports GyroCore; it writes nothing into
# the GyroCore repository. Run from a scratch directory with
#   TMPDIR=$PWD PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/GyroCore:~/GyroCore/core \
#     python3 -B gc_merge_reference.py > merge_reference.json
import json, subprocess, sys
from pathlib import Path
from gyrocore.autotune.engine import AxisRecommendation, RecommendationStatus
from gyrocore.autotune.merge import merge_autotune_sliders, POLICY_ID
from gyrocore.betaflight.simplified_tuning import SimplifiedSliders

KEYS = ["slider_master_multiplier", "slider_pi_gain", "slider_i_gain", "slider_d_gain",
        "slider_feedforward_gain", "slider_dterm_filter_multiplier"]

def sliders(value=100, **o):
    s = {k: value for k in KEYS}
    s.update(o)
    return s

class Stub:
    def __init__(self, proposed):
        self.proposed = proposed

def axis(a, proposed, blocked=False):
    return AxisRecommendation(
        axis=a,
        status=RecommendationStatus.BLOCKED if blocked else RecommendationStatus.PROPOSED,
        blocked_reasons=("blocked",) if blocked else (),
        warnings=(), system_id=None,
        recommendation=None if blocked else Stub(proposed),
        current_sliders=None, sample_rate_hz=None, upstream_sample_rate_hz=None,
    )

NAN = float("nan")
CASES = [
    ("single_axis_matches_upstream_apply", [(0, sliders(110, slider_d_gain=90), False)], {}),
    ("roll_pitch_agreement", [(0, sliders(120), False), (1, sliders(120), False)], {}),
    ("roll_pitch_disagreement_d_gain", [(0, sliders(110), False), (1, sliders(110, slider_d_gain=90), False)], {}),
    ("three_axis_agreement", [(0, sliders(105), False), (1, sliders(105), False), (2, sliders(105), False)], {}),
    ("three_axis_conflict_yaw", [(0, sliders(105), False), (1, sliders(105), False), (2, sliders(80), False)], {}),
    ("no_participating_axes", [(0, None, True)], {}),
    ("all_axes_blocked", [(0, None, True), (1, None, True), (2, None, True)], {}),
    ("blocked_axis_ignored", [(0, sliders(130), False), (2, None, True)], {}),
    ("demo_merge_review", [(0, sliders(110), False), (1, sliders(150), False), (2, sliders(100), False)], {}),
    ("demo_pass", [(0, sliders(100, slider_pi_gain=108), False), (1, sliders(100, slider_pi_gain=108), False), (2, sliders(100, slider_pi_gain=108), False)], {}),
    ("slider_limit_boundaries", [(0, sliders(25, slider_pi_gain=250), False), (1, sliders(25, slider_pi_gain=250), False)], {}),
    ("one_point_disagreement", [(0, sliders(100, slider_feedforward_gain=25), False), (1, sliders(100, slider_feedforward_gain=26), False)], {}),
    ("yaw_only", [(2, sliders(90), False)], {}),
    ("rp_mode_yaw_blocked", [(0, sliders(95), False), (1, sliders(95), False), (2, None, True)], {"pids_mode": 1}),
    ("input_order_yaw_first", [(2, sliders(140), False), (0, sliders(140), False)], {}),
    ("current_non_default", [(0, sliders(100, slider_i_gain=80), False)],
        {"pids_mode": 1, "master_multiplier": 125, "d_max_gain": 70, "pitch_d_gain": 110, "pitch_pi_gain": 90,
         "dterm_filter": 0, "dterm_filter_multiplier": 120, "gyro_filter": 0, "gyro_filter_multiplier": 80}),
    ("current_missing_values", [(0, sliders(100), False)],
        {"pids_mode": None, "d_max_gain": None, "pitch_d_gain": None, "gyro_filter": None}),
    ("non_integer_proposal_truncated", [(0, sliders(100, slider_pi_gain=108.6), False), (1, sliders(100, slider_pi_gain=108.2), False)], {}),
    ("invalid_missing_key", [(0, {k: 100 for k in KEYS[:-1]}, False)], {}),
    ("invalid_nan", [(0, sliders(100, slider_pi_gain=NAN), False)], {}),
]

def enc(v):
    if isinstance(v, float) and v != v:
        return "NaN"
    if isinstance(v, dict):
        return {k: enc(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [enc(x) for x in v]
    return v

out = []
for case_id, axes_in, cur in CASES:
    current = SimplifiedSliders(**cur)
    axes = {a: axis(a, p, b) for a, p, b in axes_in}
    entry = {
        "case_id": case_id,
        "input": {
            "axes": [{"axis": a, "blocked": b, "proposed": enc(p)} for a, p, b in axes_in],
            "current": current.__dict__ if hasattr(current, "__dict__") else None,
        },
    }
    from dataclasses import asdict
    entry["input"]["current"] = asdict(current)
    try:
        entry["expected"] = merge_autotune_sliders(axes, current).to_dict()
        entry["error"] = None
    except Exception as e:  # invalid inputs: record the exception type
        entry["expected"] = None
        entry["error"] = type(e).__name__
    out.append(entry)

rev = subprocess.run(["git", "-C", str(Path.home() / "GyroCore"), "rev-parse", "--short", "HEAD"],
                     capture_output=True, text=True).stdout.strip()
json.dump({"generator": "test/gyrocore/tools/gc_merge_reference.py", "gyrocore_commit": rev,
           "policy_id": POLICY_ID, "cases": out}, sys.stdout, indent=1)
sys.stdout.write("\n")

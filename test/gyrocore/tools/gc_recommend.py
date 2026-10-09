# This file is part of Gyroflight, a derivative of the Betaflight App (GPL-3.0-or-later).
#
# Writes gc_recommend.json for test/gyrocore/air65_autotune.local.test.ts: GyroCore's
# recommendation per AIR65 log, plus recommend_gains() on the same transfer function with
# GyroCore's gates bypassed (parity only, never a tune). Run from the reference directory with
#   TMPDIR=$REF PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/GyroCore:~/GyroCore/core \
#     python3 -B gc_recommend.py > gc_recommend.json
# It only imports GyroCore; it writes nothing into the GyroCore repository.
import json, math, sys
from pathlib import Path
from gyrocore.autotune.engine import recommend_autotune_from_bbl
from gyrocore.autotune.recommend import recommend_gains

def clean(o):
    if isinstance(o, float) and not math.isfinite(o):
        return str(o)
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o

out = []
for i in range(3):
    r = recommend_autotune_from_bbl("air65.bbl", log_index=i)
    entry = {"log_index": i, "status": str(r.status.value if hasattr(r.status, "value") else r.status),
             "blocked": list(r.blocked_reasons), "warnings": list(r.warnings), "axes": {}}
    for axis, a in r.axes.items():
        ungated = None
        sid = a.system_id
        if sid.transfer_function is not None and a.current_sliders is not None:
            rec = recommend_gains(sid.transfer_function, a.current_sliders, 60.0, open_loop=sid.open_loop)
            import dataclasses
            def scal(obj):
                return {f.name: getattr(obj, f.name) for f in dataclasses.fields(obj)
                        if isinstance(getattr(obj, f.name), (int, float, bool, type(None)))}
            ungated = {"proposed": {k: v.rounded for k, v in rec.sliders.items()},
                       "metrics": scal(rec.metrics), "scales": scal(rec.scales)}
        entry["axes"][str(axis)] = {
            "status": str(a.status.value if hasattr(a.status, "value") else a.status),
            "blocked": list(a.blocked_reasons), "warnings": list(a.warnings),
            "proposed_gated": a.proposed_sliders_unvalidated,
            "ungated_recommendation_for_parity_only": ungated,
        }
    out.append(entry)
json.dump(clean(out), sys.stdout, indent=1, default=str)

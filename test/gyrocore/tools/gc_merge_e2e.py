# This file is part of Gyroflight, a derivative of the Betaflight App (GPL-3.0-or-later).
#
# Writes test/gyrocore/fixtures/merge/merge_e2e_reference.json: GyroCore's Python engine
# (recommend_autotune_from_bbl) and global-slider merge (propose_absolute_tune -> merge) on the
# generated logs of harness/mergeE2eCases.ts (written by write_merge_e2e_logs.local.test.ts).
# Only imports GyroCore; writes nothing into the GyroCore repository. Run in the log directory:
#   TMPDIR=$PWD PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/GyroCore:~/GyroCore/core \
#     python3 -B gc_merge_e2e.py *.bbl > merge_e2e_reference.json
import hashlib, json, math, subprocess, sys
from pathlib import Path
from gyrocore.autotune.engine import recommend_autotune_from_bbl
from gyrocore.autotune.absolute import propose_absolute_tune

def clean(o):
    if isinstance(o, float) and not math.isfinite(o):
        return str(o)
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o

cases = []
for path in sorted(sys.argv[1:]):
    data = Path(path).read_bytes()
    rec = recommend_autotune_from_bbl(path, log_index=0)
    proposal = propose_absolute_tune(rec, headers=data)
    cases.append(clean({
        "case_id": Path(path).stem,
        "bbl_sha256": hashlib.sha256(data).hexdigest(),
        "recommendation_status": rec.status.value,
        "recommendation_blocked": list(rec.blocked_reasons),
        "axes": {a.axis_name: {"status": a.status.value, "blocked": list(a.blocked_reasons),
                               "proposed": a.proposed_sliders_unvalidated} for a in rec.axes.values()},
        "merge": proposal.merge.to_dict(),
        "proposal_status": proposal.status,
        "proposal_blocked": list(proposal.blocked_reasons),
        "proposal_review": list(proposal.review_reasons),
    }))

rev = subprocess.run(["git", "-C", str(Path.home() / "GyroCore"), "rev-parse", "--short", "HEAD"],
                     capture_output=True, text=True).stdout.strip()
json.dump({"generator": "test/gyrocore/tools/gc_merge_e2e.py", "gyrocore_commit": rev, "cases": cases},
          sys.stdout, indent=1)
sys.stdout.write("\n")

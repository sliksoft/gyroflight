# This file is part of Gyroflight, a derivative of the Betaflight App (GPL-3.0-or-later).
#
# Splits gc_safety_reference.py output into the three committed fixtures:
#   safety_foundation_reference.json   parity input only (its full-stage cases run the mechanical stage as
#                                      evaluate_mechanical_safety(None, require_analysis=False): not product evidence)
#   safety_product_path_reference.json run_safety_pipeline(analysis=None or ok=False, require_analysis=True)
#   safety_harness_reference.json      TEST_HARNESS_ONLY_NOT_PRODUCT_EVIDENCE
# Usage: python3 split_safety_reference.py safety_reference.json OUT_DIR
import json, sys
from pathlib import Path

doc = json.load(open(sys.argv[1]))
out = Path(sys.argv[2])
meta = {k: doc[k] for k in ("generator", "gyrocore_commit", "pythonhashseed", "constants", "conventions")}
labels = {
    "foundation": "PARITY_INPUT_ONLY: full-stage cases use evaluate_mechanical_safety(None, require_analysis=False) "
                  "(donor default PASS, scale 1.0); not product evidence",
    "product_path": "run_safety_pipeline(analysis=None or {ok: false}, require_analysis=True)",
    "harness": "TEST_HARNESS_ONLY_NOT_PRODUCT_EVIDENCE",
}
for name in ("foundation", "product_path", "harness"):
    body = dict(meta, label=labels[name])
    body[name] = doc[name]
    (out / f"safety_{name}_reference.json").write_text(json.dumps(body, indent=1) + "\n")

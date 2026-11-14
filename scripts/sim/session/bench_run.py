"""Run one sitl_bench.py action from the command line (pilot and tests): bench_run.py <action> <outDir> <flashDir> [json].

The JSON argument carries the action's own keys (tune for provision, measure for measure); the fixed paths come from
bench_config.json. Prints result.json's status and the decoded active tune when there is one.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(action: str, out_dir: str, flash_dir: str, extra: dict) -> dict:
    cfg = json.loads((HERE / "bench_config.json").read_text().replace('"~/', '"' + str(Path.home()) + '/'))
    req = {k: cfg[k] for k in ("vliegaiRoot", "elf", "elfSha256", "betaflightCommit", "betaflightSource", "baseOverlay", "runtimeRoot", "fixedSettings")}
    req.update({"action": action, "outDir": out_dir, "flashDir": flash_dir, "highResolution": True})
    req.update(extra)
    Path(out_dir).parent.mkdir(parents=True, exist_ok=True)
    rq = Path(out_dir + ".request.json")
    rq.write_text(json.dumps(req, indent=1))
    Path(cfg["runtimeRoot"]).mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", CUDA_VISIBLE_DEVICES="")
    with open(out_dir + ".log", "w") as log:
        subprocess.run([cfg["python"], str(HERE / "sitl_bench.py"), str(rq)], cwd=cfg["vliegaiRoot"], env=env, stdout=log, stderr=subprocess.STDOUT, check=False)
    return json.loads((Path(out_dir) / "result.json").read_text())


if __name__ == "__main__":
    r = run(sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4]) if len(sys.argv) > 4 else {})
    print(r["status"], r.get("reason"), json.dumps((r.get("active") or {}).get("decoded")), r.get("error", ""))

"""Record one roll CHIRP of the AIR65 configuration in the VliegAI Betaflight lockstep SITL (reference test harness).

Measurement only. The run uses the VliegAI runner tools/run_air65_ctbr_oracle.py unmodified, with these in-process
replacements, each recorded in result.json:
  - the SITL ELF is a separate local build of the same oracle commit with -DUSE_CHIRP (the pinned oracle ELF has no
    CHIRP mode); the runner's pinned-ELF guards are replaced by a check against the sha256 given in the request;
  - the recipe is the oracle recipe v1 plus one `aux` line that puts CHIRP (box 55) on AUX4;
  - `_schedule` commands zero body rates at hover; `REGRANT_HOLD_OUTER_TICKS` is switched off;
  - `stock_rc` raises AUX3 (ANGLE) when the request asks for it and AUX4 (CHIRP) from `chirpStartTick` on.
These runs are therefore NOT oracle acceptance runs.

Usage (VliegAI environment python): air65_chirp_sitl.py request.json
Output: result.json with status, the Blackbox header, the log path and the decoded trace path.
Request key `highResolution` (default true): Blackbox high resolution on or off (arm C of the protocol, post-hoc).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import traceback
from pathlib import Path

INNER_PER_OUTER = 10
BOXCHIRP_PERMANENT_ID = 55


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def header_lines(log: Path) -> dict:
    head = log.read_bytes()[: 64 * 1024]
    out: dict = {}
    duplicates = []
    for raw in head.split(b"\n"):
        if not raw.startswith(b"H "):
            continue
        key, _, value = raw[2:].decode("ascii", errors="replace").partition(":")
        if key in out:
            duplicates.append(key)
        out[key] = value.strip()
    return {"values": out, "duplicates": duplicates}


def main() -> int:
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(request["outDir"]).resolve()
    out_dir.mkdir(parents=True, exist_ok=False)
    result: dict = {
        "label": request.get("label"),
        "overrides": [
            "elf:separate_local_build_with_USE_CHIRP",
            "guards:require_pinned_elf_file,require_runtime_provenance,require_launch_elf->sha256_of_request_elf",
            "recipe:+aux_chirp_box55_aux4",
            "_schedule:zero_body_rates",
            "REGRANT_HOLD_OUTER_TICKS=-1",
            "stock_rc:aux3_angle,aux4_chirp",
        ],
    }

    def finish(status: str, reason: str | None = None) -> int:
        result["status"] = status
        result["reason"] = reason
        (out_dir / "result.json").write_text(json.dumps(result) + "\n", encoding="utf-8")
        return 0

    root = Path(request["vliegaiRoot"]).resolve()
    sys.path.insert(0, str(root / "tools"))
    sys.path.insert(0, str(root / "src"))
    sys.path.insert(0, str(root))
    import run_air65_ctbr_oracle as oracle  # noqa: E402  (the VliegAI runner, unmodified)
    from vliegai.sitl_bridge import closed_loop, io_session, fc_backend
    from vliegai.sitl_bridge.io_session import SitlIoError

    # --- the separate CHIRP build replaces the pinned oracle ELF, checked against the request's hash
    elf = Path(request["elf"]).resolve()
    elf_sha = sha256(elf)
    if elf_sha != request["elfSha256"]:
        result["error"] = f"elf sha256 {elf_sha} != {request['elfSha256']}"
        return finish("harness_error", "elf_hash_mismatch")
    result["elf_sha256"] = elf_sha
    results_dir = out_dir / "sitl"
    mode_dir = results_dir / "bf_lockstep"
    mode_dir.mkdir(parents=True)
    provenance = {
        "schema_version": 1,
        "mode": "bf_lockstep",
        "betaflight_commit": request["betaflightCommit"],
        "elf_path": str(elf),
        "elf_sha256": elf_sha,
        "source_dir": request["betaflightSource"],
        "note": "separate local build with -DUSE_CHIRP for the GyroFlight loop-reference test; not the pinned oracle",
    }
    provenance_path = mode_dir / "sitl_build_provenance.json"
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    def accept_elf(command, mode=None, *, expected_sha256=None):
        argv = list(command)
        path = Path(argv[0])
        if sha256(path) != elf_sha:
            raise io_session.SitlIoError(f"unexpected SITL ELF {path}")
        return path

    oracle.require_pinned_elf_file = lambda *_a, **_k: elf_sha
    closed_loop.require_runtime_provenance = lambda *_a, **_k: dict(provenance)
    io_session.require_launch_elf = accept_elf

    # --- recipe: oracle v1 + CHIRP on AUX4
    recipe = out_dir / "recipe_with_chirp_aux.cfg"
    base_recipe = oracle.RECIPE_PATH.read_text(encoding="utf-8")
    recipe.write_text(base_recipe.rstrip("\n") + f"\naux 3 {BOXCHIRP_PERMANENT_ID} 3 1700 2100 0\n", encoding="utf-8")
    result["recipe_v1_sha256"] = sha256(oracle.RECIPE_PATH)
    result["recipe_sha256"] = sha256(recipe)
    oracle.RECIPE_PATH = recipe

    result["vliegai"] = {
        "root": str(root),
        "runner_sha256": sha256(Path(oracle.__file__)),
        "vehicle_sha256": sha256(oracle.VEHICLE_PATH),
    }

    # --- schedule: hover, zero body rates; CHIRP mode from chirpStartTick; ANGLE if requested
    total_ticks = int(request["totalTicks"])
    high_resolution = bool(request.get("highResolution", True))
    result["highResolution"] = high_resolution
    chirp_start = int(request["chirpStartTick"])
    angle = bool(request.get("angleMode", True))
    hover = oracle.HOVER_COLLECTIVE
    state = {"chirp": False}

    def schedule(_name: str, outer_tick: int):
        state["chirp"] = outer_tick >= chirp_start
        return (0.0, 0.0, 0.0, hover)

    oracle._schedule = schedule
    oracle.REGRANT_HOLD_OUTER_TICKS = -1

    original_stock_rc = fc_backend.VliegaiBodyRateCollectiveBackend.stock_rc

    def stock_rc(self, *, throttle=None, aux=closed_loop.ARM_AUX, pilot_grant=False):
        channels = list(original_stock_rc(self, throttle=throttle, aux=aux, pilot_grant=pilot_grant))
        channels[6] = 1800 if angle else 1000  # AUX3: ANGLE (recipe aux 2 1 2)
        channels[7] = 1800 if state["chirp"] else 1000  # AUX4: CHIRP (added aux 3 55 3)
        return tuple(channels)

    fc_backend.VliegaiBodyRateCollectiveBackend.stock_rc = stock_rc

    # --- overlay: base AIR65 tune + roll PID + CHIRP settings + debug_mode CHIRP
    pid = request["rollPid"]
    overlay = out_dir / "overlay.cfg"
    base = Path(request["baseOverlay"]).resolve()
    lines = [line for line in base.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
    lines += [
        f"set p_roll = {int(pid['p'])}",
        f"set i_roll = {int(pid['i'])}",
        f"set d_roll = {int(pid['d'])}",
        f"set d_max_roll = {int(pid['dMax'])}",
        "set debug_mode = CHIRP",
    ]
    for key, value in request["chirpSettings"].items():
        lines.append(f"set {key} = {value}")
    overlay.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result["overlay_sha256"] = sha256(overlay)
    result["base_overlay_sha256"] = sha256(base)

    try:
        eeprom = oracle.prepare_air65_runtime_eeprom(results_dir, root / "eeprom.bin", provenance_path, high_resolution, recipe_overlay=overlay)
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["traceback"] = traceback.format_exc()
        return finish("harness_error", "provisioning_failed")

    case_dir = out_dir / "case"
    case_dir.mkdir()
    runtime_root = Path(request["runtimeRoot"]) if request.get("runtimeRoot") else None
    inner_ticks = total_ticks * INNER_PER_OUTER
    try:
        case = oracle._run_case("chirp_roll", case_dir, results_dir, eeprom, inner_ticks, False, runtime_root, blackbox_high_resolution=high_resolution)
    except SitlIoError as exc:
        result["error"] = f"SitlIoError: {exc}"
        return finish("harness_error", "sitl_io")
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["traceback"] = traceback.format_exc()
        return finish("harness_error", "case_failed")

    result["abort"] = case.get("abort")
    result["ticks"] = case.get("ticks")
    if case.get("abort") is not None or case.get("ticks") != inner_ticks:
        return finish("harness_error", "run_short_or_aborted")
    logs = case["blackbox_logs"]
    if len(logs) != 1:
        return finish("harness_error", f"blackbox_logs:{len(logs)}")
    log = Path(logs[0])
    kept = out_dir / "chirp.BFL"
    shutil.copy2(log, kept)
    result["blackbox_log"] = str(kept)
    result["blackbox_log_sha256"] = sha256(kept)
    result["header"] = header_lines(kept)
    result["controller_trace_npz"] = str(case_dir / "controller_trace.npz")
    result["state_trace_npz"] = str(case_dir / "state_trace.npz")
    import numpy as np

    state_npz = np.load(case_dir / "state_trace.npz")
    result["plant"] = {
        "maxAbsRollDeg": float(np.max(np.abs(state_npz["attitude_euler_deg"][:, 0]))),
        "minZ": float(np.min(state_npz["position"][:, 2])),
        "maxZ": float(np.max(state_npz["position"][:, 2])),
        "finite": bool(np.all(np.isfinite(state_npz["omega_body"]))),
    }
    return finish("ok")


if __name__ == "__main__":
    raise SystemExit(main())

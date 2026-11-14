"""Measure one AIR65 roll manoeuvre sequence in the VliegAI Betaflight lockstep SITL for the GyroFlight roll autotune demo.

Measurement only: GyroFlight (src/gyrocore/tuning/simRollAutotune.ts) chooses the candidates and scores the traces.
This adapter imports the existing runner tools/run_air65_ctbr_oracle.py from a VliegAI checkout and changes nothing
there. In this process only, it replaces two module values of that runner:
  - `_schedule`: the roll rate command per 10 ms outer tick comes from the request (pitch/yaw 0, hover collective);
  - `REGRANT_HOLD_OUTER_TICKS`: the oracle's built-in pilot-grant revoke at outer tick 40 is switched off, so the
    logged setpoint follows the commanded schedule over the whole window.
These runs are therefore NOT oracle acceptance runs; result.json records both overrides.

Usage (with the VliegAI environment's python): air65_roll_sitl.py request.json
The request names the VliegAI root, the base overlay (the AIR65 tune), the roll P/I/D/d_max, the schedule, the output
directory and the runtime root. result.json in the output directory holds:
  - status "ok" or "harness_error" (provisioning, startup, I/O, short run: no information about the candidate);
    flight-envelope failures caused by the candidate are judged by GyroFlight from the plant summary;
  - every Blackbox header line, and the scored window from the first PID tick of the first command:
    roll setpoint/gyro in deg/s (high-resolution logs only), the four motor outputs, plant roll angle and height.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import traceback
from pathlib import Path

INNER_PER_OUTER = 10


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
    result: dict = {"label": request.get("label"), "overrides": ["_schedule", "REGRANT_HOLD_OUTER_TICKS=-1"]}

    def finish(status: str, reason: str | None = None) -> int:
        result["status"] = status
        result["reason"] = reason
        (out_dir / "result.json").write_text(json.dumps(result) + "\n", encoding="utf-8")
        return 0

    root = Path(request["vliegaiRoot"]).resolve()
    sys.path.insert(0, str(root / "tools"))
    sys.path.insert(0, str(root / "src"))
    sys.path.insert(0, str(root))
    import numpy as np
    import run_air65_ctbr_oracle as oracle  # noqa: E402  (the VliegAI runner, unmodified)
    from vliegai.sitl_bridge.io_session import SitlIoError

    result["vliegai"] = {
        "head": subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip(),
        "runner_sha256": sha256(Path(oracle.__file__)),
        "recipe_sha256": sha256(oracle.RECIPE_PATH),
        "vehicle_sha256": sha256(oracle.VEHICLE_PATH),
    }
    roll = [float(v) for v in request["rollScheduleDps"]]
    inner_ticks = len(roll) * INNER_PER_OUTER
    hover = oracle.HOVER_COLLECTIVE

    def schedule(_name: str, outer_tick: int):
        value = roll[outer_tick] if 0 <= outer_tick < len(roll) else 0.0
        return (value, 0.0, 0.0, hover)

    oracle._schedule = schedule
    oracle.REGRANT_HOLD_OUTER_TICKS = -1

    pid = request["rollPid"]
    overlay = out_dir / "overlay.cfg"
    base = Path(request["baseOverlay"]).resolve()
    lines = [line for line in base.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
    lines += [
        f"set p_roll = {int(pid['p'])}",
        f"set i_roll = {int(pid['i'])}",
        f"set d_roll = {int(pid['d'])}",
        f"set d_max_roll = {int(pid['dMax'])}",
    ]
    overlay.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result["overlay_sha256"] = sha256(overlay)
    result["base_overlay_sha256"] = sha256(base)

    results_dir = out_dir / "sitl"
    try:
        provenance = oracle.prepare_bf_lockstep_provenance(results_dir)
        result["elf_sha256"] = json.loads(provenance.read_text(encoding="utf-8"))["elf_sha256"]
        eeprom = oracle.prepare_air65_runtime_eeprom(
            results_dir, root / "eeprom.bin", provenance, True, recipe_overlay=overlay
        )
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        return finish("harness_error", "provisioning_failed")

    case_dir = out_dir / "case"
    case_dir.mkdir()
    runtime_root = Path(request["runtimeRoot"]) if request.get("runtimeRoot") else None
    try:
        case = oracle._run_case(
            "roll_schedule", case_dir, results_dir, eeprom, inner_ticks, False, runtime_root,
            blackbox_high_resolution=True,
        )
    except SitlIoError as exc:
        result["error"] = f"SitlIoError: {exc}"
        return finish("harness_error", "sitl_io")
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["traceback"] = traceback.format_exc()
        failure = case_dir / "case_failure.json"
        if failure.is_file():
            data = json.loads(failure.read_text(encoding="utf-8"))
            result["failure_phase"] = data.get("failure_phase")
            result["sitl_exit"] = data.get("sitl_exit")
        return finish("harness_error", "case_failed")

    result["abort"] = case.get("abort")
    result["ticks"] = case.get("ticks")
    result["inner_ticks"] = inner_ticks
    if case.get("abort") is not None or case.get("ticks") != inner_ticks:
        return finish("harness_error", "run_short_or_aborted")

    log = Path(case["blackbox_logs"][0]) if len(case["blackbox_logs"]) == 1 else None
    if log is None:
        return finish("harness_error", f"blackbox_logs:{len(case['blackbox_logs'])}")
    result["blackbox_log_sha256"] = sha256(log)
    result["header"] = header_lines(log)

    trace = np.load(case_dir / "controller_trace.npz")
    commands = case["commands"]
    first_sequence = str(commands[0]["sequence"])
    activation = case["blackbox"]["active_sequence_first_pid_ticks"].get(first_sequence)
    if activation is None:
        return finish("harness_error", "first_command_never_active")
    loops = trace["loop_iteration"].astype(np.int64)
    start = int(np.searchsorted(loops, activation))
    stop = start + inner_ticks
    if stop > loops.size or loops[start] != activation or not np.all(np.diff(loops[start:stop]) == 1):
        return finish("harness_error", "scored_window_incomplete")
    if result["header"]["values"].get("blackbox_high_resolution") != "1":
        return finish("harness_error", "blackbox_not_high_resolution")
    # Command delivery phase: each command should become active 10 PID ticks after the previous one (the first gap,
    # from the pre-accepted command 0, is longer). A different later gap is a lockstep phase slip of the harness.
    sequences = [str(c["sequence"]) for c in commands]
    ticks = [case["blackbox"]["active_sequence_first_pid_ticks"].get(q) for q in sequences]
    result["commandPhaseSlips"] = [
        [i, ticks[i + 1] - ticks[i]]
        for i in range(1, len(ticks) - 1)
        if ticks[i] is not None and ticks[i + 1] is not None and ticks[i + 1] - ticks[i] != INNER_PER_OUTER
    ]
    window = slice(start, stop)
    result["trace"] = {
        "dtS": 0.001,
        "setpointDps": (trace["setpoint"][window, 0] / 10.0).tolist(),
        "gyroDps": (trace["gyro"][window, 0] / 10.0).tolist(),
        "motors": trace["motor"][window, :].tolist(),
    }
    state = np.load(case_dir / "state_trace.npz")
    result["plant"] = {
        "maxAbsRollDeg": float(np.max(np.abs(state["attitude_euler_deg"][:, 0]))),
        "maxAbsPitchDeg": float(np.max(np.abs(state["attitude_euler_deg"][:, 1]))),
        "minZ": float(np.min(state["position"][:, 2])),
        "maxZ": float(np.max(state["position"][:, 2])),
        "finite": bool(np.all(np.isfinite(state["omega_body"]))),
    }
    return finish("ok")


if __name__ == "__main__":
    raise SystemExit(main())

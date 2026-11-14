"""SITL bench helper for the GyroFlight AutoTune session (block 14): one action per process.

The bench is the SITL craft's "hardware": it holds one persistent EEPROM (the craft's flash) per session, writes a tune
into it with Betaflight's own CLI parser (`elf --config`, set lines + save), reads the active tune back over MSP from a
booted SITL (MSP_PID 112, MSP_PID_ADVANCED 94, MSP_FILTER_CONFIG 92, MSP_STATUS_EX 150, MSP_API_VERSION 1), and flies
measurement runs from that EEPROM. It decides nothing: GyroFlight (the app) chooses, judges and restores.

Actions (request JSON, argv[1]; result.json in request["outDir"]):
  provision  write request["tune"] (roll/pitch/yaw p, i, d, dMax; whitelisted keys only) plus the fixed scenario settings
             into a fresh EEPROM built from the VliegAI canonical image + recipe, and install it atomically as the flash.
  read       boot the SITL from the flash (no arming, no flight), read the active tune over MSP, stop the SITL.
  measure    boot from a copy of the flash, read the active tune over MSP before arming, fly the schedule (hover, CHIRP
             windows, step block), keep the Blackbox log. The flash itself is never modified by a measurement.

The VliegAI runner tools/run_air65_ctbr_oracle.py is imported unmodified; the same in-process replacements as
scripts/sim/reference/air65_chirp_sitl.py apply (separate CHIRP ELF checked by sha256, recipe + CHIRP aux, schedule,
regrant hold off, stock_rc AUX3/AUX4, optional gyro noise), each recorded in result.json.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import struct
import sys
import time
import traceback
from pathlib import Path

INNER_PER_OUTER = 10
BOXCHIRP_PERMANENT_ID = 55
MSP_API_VERSION = 1
MSP_FILTER_CONFIG = 92
MSP_PID_ADVANCED = 94
MSP_PID = 112
MSP_STATUS_EX = 150
AXES = ("roll", "pitch", "yaw")
# The only keys a tune may set (the bench refuses anything else: filters stay fixed in block 14).
TUNE_RANGES = {"p": (0, 250), "i": (0, 250), "d": (0, 250), "dMax": (0, 250)}
CLI_NAME = {"p": "p_{axis}", "i": "i_{axis}", "d": "d_{axis}", "dMax": "d_max_{axis}"}
# MSP_PID_ADVANCED byte offset of d_max roll/pitch/yaw (API ≥ 1.45; layout as src/js/msp/MSPHelper.ts decodes it).
D_MAX_OFFSET = 39


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def header_lines(log: Path) -> dict:
    head = log.read_bytes()[: 64 * 1024]
    out: dict = {}
    for raw in head.split(b"\n"):
        if raw.startswith(b"H "):
            key, _, value = raw[2:].decode("ascii", errors="replace").partition(":")
            out[key] = value.strip()
    return out


def tune_issues(tune: dict) -> list[str]:
    issues = []
    if set(tune) != set(AXES):
        issues.append(f"tune_axes:{sorted(tune)}")
    for axis in AXES:
        t = tune.get(axis) or {}
        if set(t) != set(TUNE_RANGES):
            issues.append(f"tune_keys:{axis}:{sorted(t)}")
            continue
        for key, (lo, hi) in TUNE_RANGES.items():
            v = t[key]
            if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
                issues.append(f"tune_value:{axis}.{key}={v!r}")
    return issues


def decode_active(raw: dict) -> dict:
    """The active tune from the raw MSP payloads (P/I/D per axis from MSP_PID, d_max from MSP_PID_ADVANCED)."""
    pid = bytes.fromhex(raw["pid"])
    adv = bytes.fromhex(raw["pidAdvanced"])
    out = {}
    for k, axis in enumerate(AXES):
        out[axis] = {"p": pid[3 * k], "i": pid[3 * k + 1], "d": pid[3 * k + 2], "dMax": adv[D_MAX_OFFSET + k]}
    status = bytes.fromhex(raw["statusEx"])
    # MSP_STATUS_EX: cycleTime U16, i2cErrors U16, sensors U16, flight mode flags U32, current PID profile U8
    out["_pidProfile"] = status[10]
    out["_armed"] = bool(struct.unpack_from("<I", status, 6)[0] & 1)
    api = bytes.fromhex(raw["apiVersion"])
    out["_apiVersion"] = f"{api[1]}.{api[2]}.0"
    return out


def main() -> int:
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    action = request["action"]
    out_dir = Path(request["outDir"]).resolve()
    out_dir.mkdir(parents=True, exist_ok=False)
    flash_dir = Path(request["flashDir"]).resolve()
    result: dict = {"action": action, "label": request.get("label"), "pid": os.getpid(), "startedAt": time.time()}

    def finish(status: str, reason: str | None = None) -> int:
        result["status"] = status
        result["reason"] = reason
        result["finishedAt"] = time.time()
        (out_dir / "result.json").write_text(json.dumps(result) + "\n", encoding="utf-8")
        return 0

    root = Path(request["vliegaiRoot"]).resolve()
    sys.path.insert(0, str(root / "tools"))
    sys.path.insert(0, str(root / "src"))
    sys.path.insert(0, str(root))
    import run_air65_ctbr_oracle as oracle  # noqa: E402  (unmodified VliegAI runner)
    from vliegai.sitl_bridge import closed_loop, fc_backend, io_session  # noqa: E402
    from vliegai.sitl_bridge.io_session import SitlIoError  # noqa: E402
    from vliegai.sitl_bridge import msp as vmsp  # noqa: E402

    # The bridge's MSP client only sends commands on its read-only allowlist (empty payload enforced). The tune reads are
    # Betaflight read commands with an empty request payload; they are added to that allowlist in this process only.
    tune_reads = {MSP_API_VERSION, MSP_STATUS_EX, MSP_PID, MSP_PID_ADVANCED, MSP_FILTER_CONFIG}
    vmsp.READONLY_MSP = frozenset(vmsp.READONLY_MSP) | tune_reads
    result["overrides"] = [f"msp:READONLY_MSP+{sorted(tune_reads)}"]

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
        "note": "separate local build with -DUSE_CHIRP (GyroFlight SITL bench); not the pinned oracle",
    }
    provenance_path = mode_dir / "sitl_build_provenance.json"
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    def accept_elf(command, mode=None, *, expected_sha256=None):
        path = Path(list(command)[0])
        if sha256(path) != elf_sha:
            raise io_session.SitlIoError(f"unexpected SITL ELF {path}")
        return path

    oracle.require_pinned_elf_file = lambda *_a, **_k: elf_sha
    closed_loop.require_runtime_provenance = lambda *_a, **_k: dict(provenance)
    io_session.require_launch_elf = accept_elf

    recipe = out_dir / "recipe_with_chirp_aux.cfg"
    recipe.write_text(oracle.RECIPE_PATH.read_text(encoding="utf-8").rstrip("\n") + f"\naux 3 {BOXCHIRP_PERMANENT_ID} 3 1700 2100 0\n", encoding="utf-8")
    oracle.RECIPE_PATH = recipe
    result["vliegai"] = {"root": str(root), "runner_sha256": sha256(Path(oracle.__file__)), "vehicle_sha256": sha256(oracle.VEHICLE_PATH)}
    runtime_root = Path(request["runtimeRoot"]) if request.get("runtimeRoot") else None

    def read_msp(client) -> dict:
        raw = {
            "apiVersion": client.request(MSP_API_VERSION).hex(),
            "statusEx": client.request(MSP_STATUS_EX).hex(),
            "pid": client.request(MSP_PID).hex(),
            "pidAdvanced": client.request(MSP_PID_ADVANCED).hex(),
            "filterConfig": client.request(MSP_FILTER_CONFIG).hex(),
        }
        return {"raw": raw, "decoded": decode_active(raw), "readAt": time.time()}

    # ------------------------------------------------------------------ provision
    if action == "provision":
        tune = request["tune"]
        issues = tune_issues(tune)
        if issues:
            result["issues"] = issues
            return finish("refused", "tune_not_allowed")
        lines = [line for line in Path(request["baseOverlay"]).read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
        for key, value in (request.get("fixedSettings") or {}).items():
            if key.split("_")[0] in ("p", "i", "d") and key.endswith(AXES):
                return finish("refused", f"fixed_setting_is_a_tune_key:{key}")
            lines.append(f"set {key} = {value}")
        for axis in AXES:
            for key, fmt in CLI_NAME.items():
                lines.append(f"set {fmt.format(axis=axis)} = {int(tune[axis][key])}")
        overlay = out_dir / "overlay.cfg"
        overlay.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result["overlay_sha256"] = sha256(overlay)
        result["tune"] = tune
        try:
            eeprom = oracle.prepare_air65_runtime_eeprom(results_dir, root / "eeprom.bin", provenance_path, bool(request.get("highResolution", True)), recipe_overlay=overlay)
        except Exception as exc:  # noqa: BLE001
            result["error"] = f"{type(exc).__name__}: {exc}"
            result["traceback"] = traceback.format_exc()
            return finish("harness_error", "provisioning_failed")
        flash_dir.mkdir(parents=True, exist_ok=True)
        tmp = flash_dir / "eeprom.bin.new"
        shutil.copy2(eeprom, tmp)
        os.replace(tmp, flash_dir / "eeprom.bin")
        (flash_dir / "flash.json").write_text(json.dumps({"tune": tune, "eeprom_sha256": sha256(flash_dir / "eeprom.bin"), "overlay_sha256": result["overlay_sha256"], "at": time.time()}) + "\n", encoding="utf-8")
        result["flash_sha256"] = sha256(flash_dir / "eeprom.bin")
        return finish("ok")

    flash = flash_dir / "eeprom.bin"
    if not flash.is_file():
        return finish("harness_error", "flash_missing")
    result["flash_sha256"] = sha256(flash)

    # ------------------------------------------------------------------ read (boot, MSP, stop; no flight)
    if action == "read":
        eeprom = out_dir / "boot_eeprom.bin"
        shutil.copy2(flash, eeprom)
        runtime = oracle.SitlClosedLoopRuntime(
            confirm=oracle.CLOSED_LOOP_CONFIRM, results_dir=results_dir, eeprom=eeprom, duration_s=3.0, start_pos=(0.0, 0.0, 1.0),
            vehicle_cfg=oracle.VEHICLE_PATH, mode=oracle.RuntimeMode.BF_LOCKSTEP, plant_dt=oracle.PLANT_DT, plant_ctrl_dt=oracle.PLANT_DT,
            timing_variant=oracle.TIMING_VARIANT,
        )
        runtime_dir = oracle.CaseRuntimeDir(out_dir / "case", runtime_root)
        attempts: list = []
        try:
            oracle._start_with_retries(runtime, runtime_dir.work, attempts)
            if runtime.session is not None and runtime.session.process is not None:
                runtime_dir.add_child(int(runtime.session.process.pid))
            if runtime.session is None or runtime.session.msp is None:
                return finish("harness_error", "no_msp_session")
            result["active"] = read_msp(runtime.session.msp)
        except SitlIoError as exc:
            result["error"] = f"SitlIoError: {exc}"
            result["startup_attempts"] = attempts
            return finish("harness_error", "sitl_io")
        except Exception as exc:  # noqa: BLE001
            result["error"] = f"{type(exc).__name__}: {exc}"
            result["traceback"] = traceback.format_exc()
            return finish("harness_error", "msp_read_failed")
        finally:
            try:
                result["runtime"] = runtime.close()
            except Exception as exc:  # noqa: BLE001
                result["close_error"] = f"{type(exc).__name__}: {exc}"
            runtime_dir.release()
        return finish("ok")

    # ------------------------------------------------------------------ measure
    if action != "measure":
        return finish("refused", f"unknown_action:{action}")
    spec = request["measure"]
    total_ticks = int(spec["totalTicks"])
    chirp_windows = [tuple(int(x) for x in w) for w in spec["chirpWindows"]]
    # Step block: per outer tick (10 ms) a roll/pitch rate command in deg/s; outside it zero body rates (hover).
    steps = {int(k): (float(v[0]), float(v[1])) for k, v in (spec.get("stepCommands") or {}).items()}
    angle = bool(spec.get("angleMode", True))
    angle_off = {int(t) for t in spec.get("angleOffTicks", [])}
    result["schedule"] = {"totalTicks": total_ticks, "chirpWindows": chirp_windows, "stepTicks": len(steps), "angleMode": angle, "angleOffTicks": len(angle_off)}
    hover = oracle.HOVER_COLLECTIVE
    state = {"chirp": False, "angle": angle}
    pilot_cfg = spec.get("pilot") or None
    pilot = {"last": None, "log": [], "dz": 0.0, "vel": [0.0, 0.0, 0.0]}

    def schedule(_name: str, outer_tick: int):
        state["chirp"] = any(a <= outer_tick < b for a, b in chirp_windows)
        state["angle"] = angle and outer_tick not in angle_off
        roll, pitch = steps.get(outer_tick, (0.0, 0.0))
        # The pilot's height correction goes into the collective: the RC throttle (ANGLE, stock path) and the body-rate
        # command's collective (acro step block) both come from it, so they stay equal (the firmware's handover check).
        return (roll, pitch, 0.0, hover + pilot["dz"] / 1000.0)

    oracle._schedule = schedule
    # ANGLE and CHIRP take priority over the body-rate command path and revoke the pilot grant (firmware
    # io/vliegai.c vliegaiGateOwnsControl / vliegaiUpdateControlEpoch); the step block therefore flies with ANGLE off and
    # needs one grant OFF tick (re-grant edge) after the last CHIRP: the runner's single REGRANT_HOLD tick is placed there.
    oracle.REGRANT_HOLD_OUTER_TICKS = int(spec.get("regrantTick", -1))
    result["schedule"]["regrantTick"] = oracle.REGRANT_HOLD_OUTER_TICKS
    original_stock_rc = fc_backend.VliegaiBodyRateCollectiveBackend.stock_rc

    def stock_rc(self, *, throttle=None, aux=closed_loop.ARM_AUX, pilot_grant=False):
        channels = list(original_stock_rc(self, throttle=throttle, aux=aux, pilot_grant=pilot_grant))
        channels[6] = 1800 if state["angle"] else 1000
        channels[7] = 1800 if state["chirp"] else 1000
        return tuple(channels)

    fc_backend.VliegaiBodyRateCollectiveBackend.stock_rc = stock_rc

    noise_cfg = spec.get("gyroNoise") or None
    noise_stat = {"samples": 0, "sumSq": 0.0}
    if noise_cfg:
        import numpy as np
        from vliegai.sitl_bridge import sensors

        std_rad = float(noise_cfg["stdDps"]) * math.pi / 180.0
        rng = np.random.default_rng(int(noise_cfg["seed"]))
        hp_hz = float(noise_cfg.get("highpassHz", 0) or 0)
        hp_order = int(noise_cfg.get("highpassOrder", 0) or 0) if hp_hz > 0 else 0
        hp_alpha = 1.0 / (1.0 + 2.0 * math.pi * hp_hz * 0.001) if hp_order else 1.0
        hp_x = np.zeros((hp_order, 3))
        hp_y = np.zeros((hp_order, 3))
        original_fdm_fields = sensors.PlantSensorAdapter.fdm_fields

        def fdm_fields(self, *, timestamp, quat_wxyz, omega_body, acc_world):
            n = rng.normal(0.0, std_rad, 3)
            for stage in range(hp_order):
                y = hp_alpha * (hp_y[stage] + n - hp_x[stage])
                hp_x[stage] = n
                hp_y[stage] = y
                n = y
            noise_stat["samples"] += 1
            noise_stat["sumSq"] += float(np.sum(n * n)) / 3.0
            noisy = (float(omega_body[0]) + n[0], float(omega_body[1]) + n[1], float(omega_body[2]) + n[2])
            return original_fdm_fields(self, timestamp=timestamp, quat_wxyz=quat_wxyz, omega_body=noisy, acc_world=acc_world)

        sensors.PlantSensorAdapter.fdm_fields = fdm_fields
        result["gyroNoise"] = {"stdDps": float(noise_cfg["stdDps"]), "seed": int(noise_cfg["seed"]), "highpassHz": hp_hz, "highpassOrder": hp_order}

    # Harness "pilot" (block 14): the fixed hover collective lets the craft climb, then sink to the ground, and drift into
    # the plant's ±100 m position clamp within ~40 s (seen in the two-sweep runs of block 13). A slow pilot holds
    # height with the throttle stick and position with the roll/pitch sticks (ANGLE only; sticks centred in acro), from
    # the plant state the loop already hands rc_fn. Bandwidth well below the CHIRP band; every correction is recorded.
    stick_test = spec.get("stickTest") or {}
    if pilot_cfg or stick_test:
        original_run_loop = closed_loop.SitlClosedLoopRuntime.run_loop

        def run_loop(self, *, rc_fn, **kw):
            def rc_wrapped(tick, obs):
                ch = list(rc_fn(tick, obs))
                pos = [float(x) for x in obs["position"]]
                t = float(obs["t"])
                last = pilot["last"]
                vel = [0.0, 0.0, 0.0] if last is None or t <= last[0] else [(pos[i] - last[1][i]) / (t - last[0]) for i in range(3)]
                if last is not None and t > last[0]:
                    a = 0.2  # light smoothing of the finite-difference velocity
                    vel = [a * vel[i] + (1 - a) * pilot["vel"][i] for i in range(3)]
                pilot["last"] = (t, pos)
                pilot["vel"] = vel
                outer = tick  # run_loop hands rc_fn the outer (10 ms) tick
                if pilot_cfg:
                    c = pilot_cfg
                    dz = c["kz"] * (c["z0"] - pos[2]) - c["dz"] * vel[2]
                    pilot["dz"] = max(-c["thrMax"], min(c["thrMax"], dz))
                    if state["angle"]:
                        for stick, ax, sign in ((0, c["rollAxis"], c["rollSign"]), (1, c["pitchAxis"], c["pitchSign"])):
                            u = sign * (c["kxy"] * (0.0 - pos[ax]) - c["dxy"] * vel[ax])
                            u = max(-c["stickMax"], min(c["stickMax"], u))
                            ch[stick] = int(round(1500 + u))
                if stick_test:
                    for stick, (a, b, us) in ((0, stick_test.get("roll", (0, 0, 0))), (1, stick_test.get("pitch", (0, 0, 0)))):
                        if a <= outer < b:
                            ch[stick] = 1500 + int(us)
                if tick % 100 == 0:
                    pilot["log"].append([tick, round(pos[0], 3), round(pos[1], 3), round(pos[2], 3), ch[0], ch[1], ch[2]])
                return tuple(ch)

            return original_run_loop(self, rc_fn=rc_wrapped, **kw)

        closed_loop.SitlClosedLoopRuntime.run_loop = run_loop
        result["pilot"] = {"config": pilot_cfg, "stickTest": stick_test}

    # Active tune over MSP just before arming (the SITL is booted from the flash copy, disarmed).
    original_arm = closed_loop.SitlClosedLoopRuntime.arm

    def arm(self, *args, **kwargs):
        try:
            result["active"] = read_msp(self.session.msp)
        except Exception as exc:  # noqa: BLE001
            result["active_error"] = f"{type(exc).__name__}: {exc}"
            raise
        return original_arm(self, *args, **kwargs)

    closed_loop.SitlClosedLoopRuntime.arm = arm

    eeprom = out_dir / "boot_eeprom.bin"
    shutil.copy2(flash, eeprom)
    case_dir = out_dir / "case"
    case_dir.mkdir()
    inner_ticks = total_ticks * INNER_PER_OUTER
    try:
        case = oracle._run_case("session_measure", case_dir, results_dir, eeprom, inner_ticks, False, runtime_root, blackbox_high_resolution=bool(request.get("highResolution", True)))
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
    kept = out_dir / "run.BFL"
    shutil.copy2(Path(logs[0]), kept)
    result["blackbox_log"] = str(kept)
    result["blackbox_log_sha256"] = sha256(kept)
    result["header"] = header_lines(kept)
    if noise_cfg:
        result["gyroNoise"]["samples"] = noise_stat["samples"]
        result["gyroNoise"]["rmsDpsApplied"] = math.sqrt(noise_stat["sumSq"] / max(1, noise_stat["samples"])) * 180.0 / math.pi
    result["controller_trace_npz"] = str(case_dir / "controller_trace.npz")
    if pilot["log"]:
        (out_dir / "pilot_log.json").write_text(json.dumps(pilot["log"]) + "\n", encoding="utf-8")
    import numpy as np

    st = np.load(case_dir / "state_trace.npz")
    # Flight envelope from the first CHIRP window on (before it: take-off from the ground, z = 0).
    k0 = min(len(st["position"]) - 1, int(spec.get("envelopeFromTick", chirp_windows[0][0] if chirp_windows else 0)) * INNER_PER_OUTER)
    att = st["attitude_euler_deg"][k0:]
    result["plant"] = {
        "fromInner": int(k0),
        "maxAbsRollDeg": float(np.max(np.abs(att[:, 0]))),
        "maxAbsPitchDeg": float(np.max(np.abs(att[:, 1]))),
        "minZ": float(np.min(st["position"][k0:, 2])),
        "maxZ": float(np.max(st["position"][k0:, 2])),
        "finite": bool(np.all(np.isfinite(st["omega_body"]))),
    }
    return finish("ok")


if __name__ == "__main__":
    raise SystemExit(main())

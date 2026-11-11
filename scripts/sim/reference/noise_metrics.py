"""Independent noise and motor-load reference for one SITL CHIRP run (no GyroFlight code).

Input: the controller_trace.npz the VliegAI runner decodes with its own Blackbox decoder (loop_iteration, time_s, setpoint,
gyro, p/i/d/ff terms, motor), all at the 1 kHz PID rate. Output: band powers above the excitation band, where the gyro and
D-term lowpass filters act and where the controller output loads the motors:

  gyroBand      Welch band power (100–500 Hz, nperseg 1024 Hann, 50 % overlap) of the logged roll gyro (filtered gyroADC),
  dtermBand     the same of the logged roll D term,
  ptermBand     the same of the logged roll P term,
  pidSumBand    the same of the logged roll pidSum = P + I + D + FF (the controller output before mixer and limits),
  ctrlBand      the same of −Kp·gyro + D with Kp the median of axisP / (setpoint − gyro) over |error| ≥ 20 deg/s (the
                reference method's Kp): the part of the controller output the gyro noise causes, without the setpoint
                (the quantity the engine's noise model predicts, so its ratio is comparable),
  motorBand     the same of the four motor outputs, summed (the mixer's output: the motor load the noise causes).

All over the samples from `--from` seconds (default 2.0, after the filters and the hover settle) to the end of the trace.
Ratios between two runs with the same noise seed and tick count are paired comparisons. Units are the log's own
(0.1 deg/s with high resolution; PID units; motor output units); only ratios are compared.

Usage: noise_metrics.py controller_trace.npz out.json [--from 2.0] [--band 100,500] [--scale 0.1]

Per-motor reference (block 13, protocol v3; the fields above stay for comparison with protocol v2):
  hover         the samples of steady hover outside the CHIRP: every motor above its disarmed value (> 1001) for at least
                1 s before (spin-up and take-off excluded), and outside every active CHIRP of any axis ± 0.5 s (debug[1] >= 0
                and debug[2] > 0). Welch per contiguous run (nperseg 1024, Hann, 50 %), weighted by
                its segment count; a run shorter than one segment does not count.
  motorBandHover[m]   band power 100–500 Hz of motor[m] (m = 0..3) on those samples, the paired per-motor measure;
  axisCtrlHover[a]    band power of the logged axisP_a + axisD_a per axis on the same samples (in hover the setpoint has no
                      content in the band, so axisP is the firmware's own Kp·gyro with TPA and the yaw lowpass);
  motorClip           the fraction of hover samples with any motor at or above motorClipAt (2000) or at or below 1000.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy.signal import welch

FS = 1000.0
NPERSEG = 1024
AXIS = 0  # roll


def band_power(x: np.ndarray, lo: float, hi: float) -> float:
    f, p = welch(x, fs=FS, nperseg=NPERSEG, noverlap=NPERSEG // 2, window="hann", detrend="constant")
    sel = (f >= lo) & (f <= hi)
    return float(np.sum(p[sel]) * (f[1] - f[0]))


def main() -> int:
    args = sys.argv[1:]
    src, out = Path(args[0]), Path(args[1])
    start_s = 2.0
    band = (100.0, 500.0)
    scale = 0.1  # log units per deg/s (high-resolution logs)
    for k, a in enumerate(args):
        if a == "--from":
            start_s = float(args[k + 1])
        if a == "--band":
            band = tuple(float(x) for x in args[k + 1].split(","))  # type: ignore[assignment]
        if a == "--scale":
            scale = float(args[k + 1])
    z = np.load(src)
    t = z["time_s"]
    sel = t >= t[0] + start_s
    if int(np.sum(sel)) < 4 * NPERSEG:
        out.write_text(json.dumps({"status": "insufficient", "samples": int(np.sum(sel))}) + "\n")
        print(json.dumps({"status": "insufficient"}))
        return 0
    gyro = z["gyro"][sel, AXIS].astype(float)
    p = z["p"][sel, AXIS].astype(float)
    i = z["i"][sel, AXIS].astype(float)
    d = z["d"][sel, AXIS].astype(float)
    ff = z["ff"][sel, AXIS].astype(float)
    motors = z["motor"][sel].astype(float)
    pid_sum = p + i + d + ff
    # Kp as the loop reference reads it: axisP over the error in deg/s where the error is large enough.
    err_dps = (z["setpoint"][sel, AXIS].astype(float) - gyro) * scale
    big = np.abs(err_dps) >= 20.0
    kp = float(np.median(p[big] / err_dps[big])) if int(np.sum(big)) >= 100 else None
    # P acts on the error (setpoint − gyro); the setpoint has no content in the band, so the P part there is −Kp·gyro. Until
    # 2026-11-11 (block 13) this read +Kp·gyro, which flipped the P·D cross term (the v2 proof's ctrlBand 0.92 is ×1.63 corrected).
    ctrl = -kp * gyro * scale + d if kp is not None else None
    result = {
        "status": "ok",
        "bandHz": list(band),
        "fromS": start_s,
        "samples": int(np.sum(sel)),
        "nperseg": NPERSEG,
        "gyroBand": band_power(gyro, *band),
        "ptermBand": band_power(p, *band),
        "dtermBand": band_power(d, *band),
        "pidSumBand": band_power(pid_sum, *band),
        "kp": kp,
        "kpSamples": int(np.sum(big)),
        "ctrlBand": band_power(ctrl, *band) if ctrl is not None else None,
        "motorBand": float(sum(band_power(motors[:, m], *band) for m in range(motors.shape[1]))),
        "motorMean": float(np.mean(motors)),
        "motorMax": float(np.max(motors)),
    }
    # --- hover outside the CHIRP (protocol v3 per-motor measure) ---
    tt = z["time_s"] - z["time_s"][0]
    mot_all = z["motor"].astype(float)
    dbg = z["debug"]
    armed = np.all(mot_all > 1001, axis=1)
    ok = np.zeros(len(tt), dtype=bool)
    run_start = None
    for k in range(len(tt)):
        if armed[k]:
            if run_start is None:
                run_start = tt[k]
            ok[k] = tt[k] - run_start >= 1.0
        else:
            run_start = None
    # Every active CHIRP (any axis: debug[1] >= 0 and debug[2] > 0), each with ±0.5 s, is cut out.
    act = (dbg[:, 1] >= 0) & (dbg[:, 2] > 0)
    idx = np.flatnonzero(act)
    if idx.size:
        cuts = np.flatnonzero(np.diff(idx) > 1)
        for a, b in zip(np.r_[idx[0], idx[cuts + 1]], np.r_[idx[cuts], idx[-1]]):
            ok &= ~((tt >= tt[a] - 0.5) & (tt <= tt[b] + 0.5))
    def runs(mask):
        idx = np.flatnonzero(mask)
        if not idx.size:
            return []
        cuts = np.flatnonzero(np.diff(idx) > 1)
        starts = np.r_[idx[0], idx[cuts + 1]]
        ends = np.r_[idx[cuts], idx[-1]] + 1
        return [(a, b) for a, b in zip(starts, ends) if b - a >= NPERSEG]
    def hover_power(x):
        tot, w = 0.0, 0
        for a, b in runs(ok):
            n_seg = (b - a - NPERSEG) // (NPERSEG // 2) + 1
            tot += band_power(x[a:b], *band) * n_seg
            w += n_seg
        return tot / w if w else None
    hover_runs = runs(ok)
    result["hover"] = {"samples": int(sum(b - a for a, b in hover_runs)), "runs": [[round(float(tt[a]), 3), round(float(tt[b - 1]), 3)] for a, b in hover_runs]}
    result["motorBandHover"] = [hover_power(mot_all[:, m]) for m in range(mot_all.shape[1])]
    # Per axis the logged controller part the gyro noise drives: axisP + axisD (in hover the setpoint carries
    # nothing above 100 Hz, so axisP there is Kp·(−gyro) with the firmware's own Kp, TPA and yaw lowpass).
    axis_ctrl = []
    for ax in range(3):
        p_ax = z["p"][:, ax].astype(float)
        d_ax = z["d"][:, ax].astype(float) if z["d"].shape[1] > ax else np.zeros_like(p_ax)
        axis_ctrl.append(hover_power(p_ax + d_ax))
    result["axisCtrlHover"] = axis_ctrl
    sel_h = ok
    result["motorClip"] = float(np.mean(np.any((mot_all[sel_h] >= 2000) | (mot_all[sel_h] <= 1000), axis=1))) if sel_h.any() else None
    out.write_text(json.dumps(result) + "\n")
    print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in result.items() if k != "bandHz"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

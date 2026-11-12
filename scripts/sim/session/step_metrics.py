"""Independent step-response metrics of the session's step block (block 14), from a decoded trace (controller_trace.npz).

Written separately from GyroFlight's TypeScript (src/gyrocore/sitlSession/metrics.ts); used for the independent final
measurement. Definitions (protocol session_v1):
  window      each doublet of the step block: from its first setpoint edge for (2H + G) ticks of 10 samples (1 kHz log);
              the block is located as the first sample after the last CHIRP activation at which |setpoint| of the
              block's first axis exceeds half the amplitude
  tracking    RMS(gyro − setpoint) / RMS(setpoint) over the doublet windows of one axis
  overshoot   per edge: max over the edge's segment of (gyro − new value) in the step's direction, as a share of the step
              size; the axis value is the maximum over its edges
  rise r90    per edge: ms until gyro − previous value first reaches 90 % of the step (segment length if never); mean
  oscillation per edge: peak-to-peak error from 60 ms after the edge to the next edge, as a share of the step; maximum
Usage: step_metrics.py controller_trace.npz schedule.json out.json   (schedule.json = the measure spec of schedule.py)
"""

import json
import sys

import numpy as np

SETTLE_MS = 60


def edge_metrics(sp, gy, dt_s):
    edges = [k for k in range(1, len(sp)) if abs(sp[k] - sp[k - 1]) > 0.05]
    over, osc, rises = 0.0, 0.0, []
    settle = int(round(SETTLE_MS / 1000 / dt_s))
    err = gy - sp
    for e, k0 in enumerate(edges):
        k1 = edges[e + 1] if e + 1 < len(edges) else len(sp)
        target, prev = sp[k0], sp[k0 - 1]
        step = target - prev
        size = abs(step)
        if size < 1e-6:
            continue
        d = np.sign(step)
        seg = gy[k0:k1]
        over = max(over, float(np.max(d * (seg - target))) / size)
        hit = np.flatnonzero(d * (seg - prev) >= 0.9 * size)
        rises.append((hit[0] if len(hit) else k1 - k0) * dt_s * 1000)
        if k0 + settle < k1:
            w = err[k0 + settle:k1]
            osc = max(osc, float(w.max() - w.min()) / size)
    return over, float(np.mean(rises)) if rises else float("nan"), osc


def measure(npz_path, spec):
    z = np.load(npz_path)
    t = z["time_s"].astype(float)
    dt = float(np.median(np.diff(t)))
    scale = 0.1  # high-resolution Blackbox: deg/s × 10
    sp_all = z["setpoint"][:, :2].astype(float) * scale
    gy_all = z["gyro"][:, :2].astype(float) * scale
    chirp = z["debug"][:, 2] > 0
    last_chirp = int(np.flatnonzero(chirp)[-1]) if chirp.any() else 0
    amp = float(spec["stepAmplitudeDps"])
    blocks = spec["stepBlocks"]
    first_axis = 0 if blocks[0]["axis"] == "roll" else 1
    cand = np.flatnonzero(np.abs(sp_all[last_chirp:, first_axis]) > 0.5 * amp)
    if not len(cand):
        return {"status": "no_step_block"}
    k_first = last_chirp + int(cand[0])
    # the first command sample is one sample after the edge detector's crossing at most; back off to the edge
    while k_first > 0 and abs(sp_all[k_first - 1, first_axis]) > 0.05 * amp:
        k_first -= 1
    t0 = blocks[0]["startTick"]
    per_axis = {}
    for name, ax in (("roll", 0), ("pitch", 1)):
        sps, gys, overs, risesl, oscs = [], [], [], [], []
        for b in blocks:
            if b["axis"] != name:
                continue
            k0 = k_first + (b["startTick"] - t0) * 10
            k1 = k_first + (b["endTick"] - t0) * 10
            sp = sp_all[k0 - 1:k1, ax]
            gy = gy_all[k0 - 1:k1, ax]
            o, r, osc = edge_metrics(sp, gy, dt)
            sps.append(sp[1:]); gys.append(gy[1:]); overs.append(o); risesl.append(r); oscs.append(osc)
        sp = np.concatenate(sps); gy = np.concatenate(gys)
        per_axis[name] = {
            "trackingRel": float(np.sqrt(np.mean((gy - sp) ** 2)) / max(np.sqrt(np.mean(sp ** 2)), 1e-9)),
            "overshoot": float(max(overs)),
            "riseMs": float(np.mean(risesl)),
            "oscillation": float(max(oscs)),
        }
    return {"status": "ok", "blockStartSample": k_first, "blockStartTimeS": float(t[k_first]), "axes": per_axis}


if __name__ == "__main__":
    spec = json.load(open(sys.argv[2]))
    spec = spec.get("measure", spec)
    out = measure(sys.argv[1], spec)
    json.dump(out, open(sys.argv[3], "w"), indent=1)
    print(json.dumps(out))

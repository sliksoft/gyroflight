"""Independent reference for the roll loop of one SITL CHIRP log (no GyroFlight code).

Inputs: the controller_trace.npz the VliegAI runner decodes with its own Blackbox decoder (loop_iteration, time_s,
setpoint, gyro, p/i/d/ff terms, debug), all at the 1 kHz PID rate, high resolution (0.1 deg/s units for setpoint/gyro).

Reference method (recorded in the protocol):
  - Controller response from the running firmware's own logged terms, roll axis:
      Kp      = median of axisP / (setpoint - gyro) over samples with |error| >= 20 deg/s  (P acts on the error);
      C_D(f)  = -H1(gyro -> axisD)           (D acts on the filtered gyro only; includes the D lowpass chain);
      C_I(f)  = H1(error -> axisI)           (I acts on the error with I-term relax; time-varying, so it is reported
                                              with its coherence and the P-term scaling is checked with it).
    C_fb(f) = Kp + C_I(f) + C_D(f) is the controller on the feedback path, in Betaflight's internal units per deg/s.
  - Plant from the logged signals: G(f) = H1(pidSum -> gyro), pidSum = axisP + axisI + axisD + axisF (the firmware's
    PID output before limits). The SITL has no process noise (0.1 deg/s quantisation only), so the closed-loop direct
    H1 estimate of G is unbiased; its coherence is reported and must be >= 0.99 on every assessed bin.
  - Loop L = C_fb * G; margins read on the Welch grid (1 kHz, nperseg 2048 Hann, 50 % overlap => 0.488 Hz bins):
      crossover fc: first |L| = 1 crossing from below in frequency (linear interpolation on 20 log10|L|);
      PM = 180 + arg L(fc) (unwrapped phase, degrees);
      GM = -20 log10|L| at the first phase crossing of -180 deg inside 5-50 Hz, else null;
      |S| peak = max 1/|1+L| over 5-50 Hz (dB).
  Signs/scales: setpoint and gyro from the log in deg/s (x0.1 applied), terms in Betaflight PID units; the loop is
  dimensionless. Timing: all signals are sampled at the same PID iteration; the plant delay is inside G.

Usage: reference_loop.py controller_trace.npz out.json [--window a,b] [--scale 0.1|1]
  (window in seconds of the chirp axis active; scale = log units per deg/s: 0.1 for high-resolution logs, 1 otherwise)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy.signal import csd, welch

FS = 1000.0
NPERSEG = 2048
BAND = (5.0, 50.0)
GM_BAND = (5.0, 85.0)  # the phase crossing may lie above the assessment band (PROTOCOL.md, limit 4)
AXIS = 0  # roll


def h1(x: np.ndarray, y: np.ndarray):
    f, pxy = csd(x, y, fs=FS, nperseg=NPERSEG, noverlap=NPERSEG // 2, window="hann", detrend="constant")
    _, pxx = welch(x, fs=FS, nperseg=NPERSEG, noverlap=NPERSEG // 2, window="hann", detrend="constant")
    _, pyy = welch(y, fs=FS, nperseg=NPERSEG, noverlap=NPERSEG // 2, window="hann", detrend="constant")
    frf = pxy / pxx
    coh = np.abs(pxy) ** 2 / (pxx * pyy)
    return f, frf, coh


def crossing(f: np.ndarray, v: np.ndarray, level: float, rising: bool):
    """First f where v crosses `level` (rising or falling), linear interpolation; None if never."""
    for k in range(1, len(f)):
        a, b = v[k - 1], v[k]
        if rising and a < level <= b or (not rising) and a > level >= b:
            t = (level - a) / (b - a) if b != a else 0.0
            return float(f[k - 1] + t * (f[k] - f[k - 1])), k
    return None, None


def interp_complex(f: np.ndarray, z: np.ndarray, f0: float) -> complex:
    mag = np.interp(f0, f, np.abs(z))
    ph = np.interp(f0, f, np.unwrap(np.angle(z)))
    return mag * np.exp(1j * ph)


def margins(f: np.ndarray, L: np.ndarray, coh_g: np.ndarray, coh_d: np.ndarray) -> dict:
    band = (f >= BAND[0]) & (f <= BAND[1])
    fb, Lb = f[band], L[band]
    gain_db = 20 * np.log10(np.abs(Lb))
    phase = np.degrees(np.unwrap(np.angle(Lb)))
    fc, kc = crossing(fb, gain_db, 0.0, rising=False)
    out: dict = {"bandHz": list(BAND), "resolutionHz": float(f[1] - f[0])}
    if fc is None:
        out.update({"crossoverHz": None, "phaseMarginDeg": None, "reason": "no_gain_crossover_in_band"})
    else:
        Lc = interp_complex(fb, Lb, fc)
        pm = 180.0 + np.degrees(np.angle(Lc))
        pm = (pm + 180) % 360 - 180
        out.update({"crossoverHz": fc, "phaseMarginDeg": float(pm)})
    gband = (f >= GM_BAND[0]) & (f <= GM_BAND[1])
    fg, Lg = f[gband], L[gband]
    gain_g = 20 * np.log10(np.abs(Lg))
    phase_g = np.degrees(np.unwrap(np.angle(Lg)))
    f180, k180 = crossing(fg, phase_g, -180.0, rising=False)
    if f180 is None:
        out.update({"gainMarginDb": None, "phaseCrossingHz": None, "gmReason": f"no_phase_crossing_in_{GM_BAND[0]:g}-{GM_BAND[1]:g}Hz"})
    else:
        out.update({
            "gainMarginDb": float(-np.interp(f180, fg, gain_g)),
            "phaseCrossingHz": f180,
            "coherenceAtPhaseCrossing": float(min(np.interp(f180, f, coh_g), np.interp(f180, f, coh_d))),
        })
    S = 1.0 / np.abs(1.0 + Lb)
    k = int(np.argmax(S))
    out.update({"sensitivityPeakDb": float(20 * np.log10(S[k])), "sensitivityPeakHz": float(fb[k])})
    out["minCoherencePlantInBand"] = float(np.min(coh_g[band]))
    out["minCoherenceDtermInBand"] = float(np.min(coh_d[band]))
    return out


def main() -> int:
    npz = np.load(sys.argv[1])
    out_path = Path(sys.argv[2])
    window = None
    if "--window" in sys.argv:
        a, b = sys.argv[sys.argv.index("--window") + 1].split(",")
        window = (float(a), float(b))
    t = npz["time_s"]
    scale = float(sys.argv[sys.argv.index("--scale") + 1]) if "--scale" in sys.argv else 0.1
    sp = npz["setpoint"][:, AXIS] * scale
    gy = npz["gyro"][:, AXIS] * scale
    p = npz["p"][:, AXIS]
    i = npz["i"][:, AXIS]
    d = npz["d"][:, AXIS]
    ff = npz["ff"][:, AXIS] if npz["ff"].shape[1] > AXIS else np.zeros_like(p)
    debug = npz["debug"]
    # chirp window: debug[1] == axis (active chirp axis) and generator frequency > 0
    active = (debug[:, 1] == AXIS) & (debug[:, 2] > 0)
    if window is None:
        idx = np.flatnonzero(active)
        if idx.size == 0:
            out_path.write_text(json.dumps({"status": "INSUFFICIENT", "reason": "no_chirp_window"}) + "\n")
            return 0
        a, b = int(idx[0]), int(idx[-1]) + 1
    else:
        a, b = int(np.searchsorted(t, window[0])), int(np.searchsorted(t, window[1]))
    sl = slice(a, b)
    dt = np.diff(t[sl])
    err = sp[sl] - gy[sl]
    u = p[sl] + i[sl] + d[sl] + ff[sl]
    f, G, coh_g = h1(u, gy[sl])
    _, CD, coh_d = h1(gy[sl], d[sl])
    _, CI, coh_i = h1(err, i[sl])
    _, T, coh_t = h1(sp[sl], gy[sl])  # closed-loop setpoint -> gyro, for the GyroFlight-style plant split only
    big = np.abs(err) >= 20.0
    kp_samples = p[sl][big] / err[big]
    kp = float(np.median(kp_samples))
    kp_spread = float(np.percentile(np.abs(kp_samples - kp), 95))
    C_fb = kp + CI - CD
    L = C_fb * G
    res = {
        "status": "ok",
        "unitsScale": scale,
        "windowS": [float(t[a]), float(t[b - 1])],
        "samples": int(b - a),
        "samplePeriodMedianS": float(np.median(dt)),
        "samplePeriodMaxS": float(np.max(dt)),
        "generatorHz": [float(debug[a, 2] / 10.0), float(debug[b - 1, 2] / 10.0)],
        "kp": kp,
        "kpSpread95": kp_spread,
        "kpSamples": int(big.sum()),
        "itermLoggedRmsRatio": float(np.sqrt(np.mean(i[sl] ** 2)) / max(np.sqrt(np.mean(p[sl] ** 2)), 1e-9)),
        "margins": margins(f, L, coh_g, coh_d),
        "bins": [
            {
                "f": float(f[k]),
                "G": [float(G[k].real), float(G[k].imag)],
                "cohG": float(coh_g[k]),
                "CD": [float(-CD[k].real), float(-CD[k].imag)],
                "cohD": float(coh_d[k]),
                "CI": [float(CI[k].real), float(CI[k].imag)],
                "cohI": float(coh_i[k]),
                "Cfb": [float(C_fb[k].real), float(C_fb[k].imag)],
                "L": [float(L[k].real), float(L[k].imag)],
                "T": [float(T[k].real), float(T[k].imag)],
                "cohT": float(coh_t[k]),
            }
            for k in range(len(f))
            if 1.0 <= f[k] <= 120.0
        ],
    }
    # a sensitivity check on the I term: margins with the I term at zero
    res["marginsIZero"] = margins(f, (kp - CD) * G, coh_g, coh_d)
    out_path.write_text(json.dumps(res) + "\n", encoding="utf-8")
    m = res["margins"]
    print(json.dumps({"fc": m["crossoverHz"], "pm": m["phaseMarginDeg"], "gm": m["gainMarginDb"], "S": m["sensitivityPeakDb"], "kp": kp, "cohG": m["minCoherencePlantInBand"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

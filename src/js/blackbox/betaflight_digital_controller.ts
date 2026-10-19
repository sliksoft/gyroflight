/*
 * This file is part of Gyroflight, a derivative of the Betaflight App.
 *
 * Gyroflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Gyroflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * GF-1 M1: discrete Betaflight rate-PID controller model (offline).
 *
 * Derived from sliksoft/VliegAI-Betaflight @ 43875a55 (pid.c / filter.c /
 * pid_init.c). Not wired into recommendGains / phase-margin product path.
 *
 * Signal definitions (rate loop, sticks centred, CHIRP on):
 *   r_chirp  — amplitude * phaseComp(exc); exc is DEBUG_CHIRP debug[3]/1000
 *   y        — gyroADCf (after gyro filters)
 *   e        — r_chirp - y
 *   u        — P + I + D + F   (motor command contribution before mixer)
 *
 *   C_reference(z) = u / r |_{y=0}   for the CHIRP injection path
 *                    = Ce(z) * H_phase(z)   (P+I on chirp; FF excluded)
 *   C_feedback(z)  = -u / y |_{r=0}
 *                    = Ce(z) + Cd(z)        (P+I on -y; D on filtered gyro)
 *   T_chirp(z)     = y / r_chirp           (measured)
 *   L_stability(z) = C_feedback * G
 *                  = C_feedback * T / (C_reference - T * C_feedback)
 *     (M2; not evaluated here)
 *
 * Feedforward Kf uses getFeedforward() from the RC route in rc.c — it does
 * not see the CHIRP-added setpoint. C_reference for chirp therefore excludes F.
 */

export const FIRMWARE_REVISION_PINNED = "43875a55a513fa640f0417561a0ff8847c9889e7";

/** Exact scales from flight/pid.h @ pinned firmware. */
export const PTERM_SCALE = 0.032029;
export const ITERM_SCALE = 0.244381;
export const DTERM_SCALE = 0.000529;
export const FEEDFORWARD_SCALE = 0.013754;

/** PT2 cutoff correction from common/filter.c */
export const CUTOFF_CORRECTION_PT2 = 1.553773974;
export const CUTOFF_CORRECTION_PT3 = 1.961459177;

export type Complex = { re: number; im: number };

export const cadd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const csub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
export const cmul = (a: Complex, b: Complex): Complex => ({
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
});
export const cdiv = (a: Complex, b: Complex): Complex => {
    const d = b.re * b.re + b.im * b.im;
    return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
export const cscale = (a: Complex, s: number): Complex => ({ re: a.re * s, im: a.im * s });
export const cmag = (a: Complex) => Math.hypot(a.re, a.im);
export const cphaseDeg = (a: Complex) => (Math.atan2(a.im, a.re) * 180) / Math.PI;

export interface AxisPidRaw {
    p: number;
    i: number;
    d: number;
    /** Feedforward weight (ff_weight / F); 0…1000 style. */
    f: number;
}

export interface DigitalControllerConfig {
    /** Gyro sample period (s). AIR65: looptime 125 µs → 8 kHz. */
    gyroDt: number;
    /** PID sample period (s). AIR65: looptime * pid_process_denom = 250 µs → 4 kHz. */
    pidDt: number;
    axis: AxisPidRaw;
    /** Apply the firmware yaw Ki * 2.5 scale (pid_init.c). */
    yawKiBoost?: boolean;
    yawLowpassHz?: number;
    /** Gyro LPF chain before gyroADCf (modelled at gyroDt). */
    gyroLpf1Hz?: number;
    gyroLpf2Hz?: number;
    /** D-term filters on gyroADCf (modelled at pidDt). */
    dtermLpf1Hz?: number;
    dtermLpf2Hz?: number;
    /** Chirp lead/lag phase compensator (pidDt). 0 disables. */
    chirpLagHz?: number;
    chirpLeadHz?: number;
    /** Include Kf·H_ff in a dedicated RC feedforward path (not in C_reference). */
    includeRcFeedforward?: boolean;
}

export interface ModelValidity {
    linearTimeInvariant: string[];
    conditionalLinear: string[];
    insufficientOrNonlinear: string[];
}

/** Classification for AIR65 @ 43875a55 (see docs). */
export function classifyModelParts(cfg: DigitalControllerConfig): ModelValidity {
    const linearTimeInvariant = [
        "P on error (Kp = PTERM_SCALE * P)",
        "I on error (forward Euler, Ki = ITERM_SCALE * I [* 2.5 on yaw])",
        "D on filtered gyro discrete derivative (when D > 0)",
        "PT1 gyro / D-term / yaw-P lowpass at fixed cutoff",
        "CHIRP phaseComp lead-lag (excitation shaping only)",
    ];
    const conditionalLinear = [
        "TPA: constant if throttle fixed during sweep (scales Kp/Kd)",
        "iterm_relax: ≈1 when |setpoint HPF| ≪ 40 °/s; otherwise nonlinear (RP only when iterm_relax=RP)",
        "D_max: off when d_max==D or gain path inactive; otherwise state-dependent Kd",
    ];
    const insufficientOrNonlinear = [
        "dyn_notch (time-varying centres)",
        "rpm_filter (RPM-scheduled notches)",
        "anti_gravity (throttle derivative)",
        "RC feedforward jitter/boost/averaging (packet-timed, not on CHIRP path)",
        "simplified_pids_mode mapping (AIR65 log has mode 0 — absolute PIDs used)",
    ];
    if ((cfg.axis.d ?? 0) <= 0) {
        linearTimeInvariant.push("D-term absent on this axis (Cd = 0)");
    }
    return { linearTimeInvariant, conditionalLinear, insufficientOrNonlinear };
}

export function pidCoefficients(cfg: DigitalControllerConfig) {
    const Kp = PTERM_SCALE * cfg.axis.p;
    let Ki = ITERM_SCALE * cfg.axis.i;
    if (cfg.yawKiBoost) Ki *= 2.5;
    const Kd = DTERM_SCALE * cfg.axis.d;
    const Kf = FEEDFORWARD_SCALE * (cfg.axis.f * 0.01);
    return { Kp, Ki, Kd, Kf };
}

/** Firmware pt1FilterGain(f_cut, dT). */
export function pt1Gain(fCutHz: number, dT: number): number {
    if (!(fCutHz > 0) || !(dT > 0)) return 1;
    const omega = 2 * Math.PI * fCutHz * dT;
    return omega / (omega + 1);
}

export function pt2Gain(fCutHz: number, dT: number): number {
    return pt1Gain(fCutHz * CUTOFF_CORRECTION_PT2, dT);
}

/** H_pt1(z) = k / (1 - (1-k) z^{-1}) */
export function pt1Hz(k: number, zInv: Complex): Complex {
    // y = y + k(x-y) => Y = k X + (1-k) z^{-1} Y => H = k / (1 - (1-k) z^{-1})
    return cdiv({ re: k, im: 0 }, csub({ re: 1, im: 0 }, cscale(zInv, 1 - k)));
}

export interface PhaseCompCoeffs {
    b0: number;
    b1: number;
    a1: number;
}

/** Firmware phaseCompUpdate (filter.c) with Math.sin (not sin_approx). */
export function phaseCompCoeffs(lagHz: number, leadHz: number, looptimeUs: number): PhaseCompCoeffs | null {
    if (!(lagHz > 0) || !(leadHz > 0) || !(looptimeUs > 0)) return null;
    const alphaRatio = leadHz / lagHz;
    const centerFreqHz = lagHz * Math.sqrt(alphaRatio);
    const centerPhaseDeg = (Math.asin((1 - alphaRatio) / (1 + alphaRatio)) * 180) / Math.PI;
    const omega = 2 * Math.PI * centerFreqHz * looptimeUs * 1e-6;
    const sn = Math.sin((centerPhaseDeg * Math.PI) / 180);
    const gain = (1 + sn) / (1 - sn);
    const alpha = (12 - omega * omega) / (6 * omega * Math.sqrt(gain));
    let b0 = 1 + alpha * gain;
    let b1 = 2 - b0;
    let a1 = 1 - alpha;
    const a0 = 1 / (1 + alpha);
    b0 *= a0;
    b1 *= a0;
    a1 *= a0;
    return { b0, b1, a1 };
}

/** H_phase(z) = (b0 + b1 z^{-1}) / (1 + a1 z^{-1})  (firmware sign: y = b0 x + b1 x1 - a1 y1) */
export function phaseCompHz(c: PhaseCompCoeffs, zInv: Complex): Complex {
    const num = cadd({ re: c.b0, im: 0 }, cscale(zInv, c.b1));
    const den = cadd({ re: 1, im: 0 }, cscale(zInv, c.a1));
    return cdiv(num, den);
}

function zInvAt(freqHz: number, dT: number): Complex {
    const w = 2 * Math.PI * freqHz * dT;
    return { re: Math.cos(-w), im: Math.sin(-w) };
}

export interface ControllerFrf {
    frequencyHz: number;
    /** Ce(z): P+I on the (already shaped) chirp setpoint — not including phaseComp. */
    cReference: Complex;
    /** Ce(z)+Cd(z): feedback path on gyroADCf. */
    cFeedback: Complex;
    /** phaseComp(z): exc → shaped chirp before amplitude (DEBUG_CHIRP debug[3] → setpoint addend). */
    cExcitationShaping: Complex;
    /** RC-route feedforward only; zero on the CHIRP injection path. */
    cFeedforwardRc: Complex;
}

/**
 * Analytic z-domain controller FRF at one frequency.
 *
 * y is defined as gyroADCf (after gyro LPFs). Ce acts on (r − y). Cd is the
 * D-term path on y (D-term LPFs + discrete derivative). Chirp phaseComp shapes
 * exc→r and is folded into cReference when lag/lead are set.
 */
export function evaluateControllerFrf(cfg: DigitalControllerConfig, freqHz: number): ControllerFrf {
    const { Kp, Ki, Kd, Kf } = pidCoefficients(cfg);
    const zPid = zInvAt(freqHz, cfg.pidDt);

    // Ce: P + I with I[n]=I[n-1]+Ki*dT*e[n] → H_i = Ki*dT/(1−z^{-1})
    const integrator = cdiv({ re: Ki * cfg.pidDt, im: 0 }, csub({ re: 1, im: 0 }, zPid));
    let Ce: Complex;
    if (cfg.yawLowpassHz && cfg.yawLowpassHz > 0) {
        const Hp = pt1Hz(pt1Gain(cfg.yawLowpassHz, cfg.pidDt), zPid);
        Ce = cadd(cmul({ re: Kp, im: 0 }, Hp), integrator);
    } else {
        Ce = cadd({ re: Kp, im: 0 }, integrator);
    }

    // Cd on y=gyroADCf for the stability form u = Ce·r − (Ce+Cd)·y.
    // Firmware: delta = −(g[n]−g[n−1])*pidFrequency; D = Kd*delta.
    // So D/y = −Kd·fs·(1−z^{-1})·Hd, and the positive Cd in (Ce+Cd) is
    // Kd·fs·(1−z^{-1})·Hd.
    let Cd: Complex = { re: 0, im: 0 };
    if (Kd > 0) {
        let Hd: Complex = { re: 1, im: 0 };
        if (cfg.dtermLpf1Hz && cfg.dtermLpf1Hz > 0) {
            Hd = cmul(Hd, pt1Hz(pt1Gain(cfg.dtermLpf1Hz, cfg.pidDt), zPid));
        }
        if (cfg.dtermLpf2Hz && cfg.dtermLpf2Hz > 0) {
            Hd = cmul(Hd, pt1Hz(pt1Gain(cfg.dtermLpf2Hz, cfg.pidDt), zPid));
        }
        const HdiffPos = cscale(csub({ re: 1, im: 0 }, zPid), 1 / cfg.pidDt);
        Cd = cscale(cmul(Hd, HdiffPos), Kd);
    }

    let cExcitationShaping: Complex = { re: 1, im: 0 };
    if (cfg.chirpLagHz && cfg.chirpLeadHz) {
        const pc = phaseCompCoeffs(cfg.chirpLagHz, cfg.chirpLeadHz, Math.round(cfg.pidDt * 1e6));
        if (pc) cExcitationShaping = phaseCompHz(pc, zPid);
    }

    const cFeedforwardRc = cfg.includeRcFeedforward ? { re: Kf, im: 0 } : { re: 0, im: 0 };

    return {
        frequencyHz: freqHz,
        cReference: Ce,
        cFeedback: cadd(Ce, Cd),
        cExcitationShaping,
        cFeedforwardRc,
    };
}

/** Gyro LPF chain H_gyro(z) at gyro sample rate (raw gyro → gyroADCf). */
export function evaluateGyroLpfFrf(cfg: DigitalControllerConfig, freqHz: number): Complex {
    const zGyro = zInvAt(freqHz, cfg.gyroDt);
    let H: Complex = { re: 1, im: 0 };
    if (cfg.gyroLpf1Hz && cfg.gyroLpf1Hz > 0) {
        H = cmul(H, pt1Hz(pt1Gain(cfg.gyroLpf1Hz, cfg.gyroDt), zGyro));
    }
    if (cfg.gyroLpf2Hz && cfg.gyroLpf2Hz > 0) {
        H = cmul(H, pt1Hz(pt1Gain(cfg.gyroLpf2Hz, cfg.gyroDt), zGyro));
    }
    return H;
}

// --- Time-domain firmware recurrence (independent of analytic H(z)) ---

class Pt1 {
    state = 0;
    k: number;
    constructor(k: number) {
        this.k = k;
    }
    apply(x: number): number {
        this.state = this.state + this.k * (x - this.state);
        return this.state;
    }
}

class PhaseComp {
    x1 = 0;
    y1 = 0;
    c: PhaseCompCoeffs;
    constructor(c: PhaseCompCoeffs) {
        this.c = c;
    }
    apply(x: number): number {
        const y = this.c.b0 * x + this.c.b1 * this.x1 - this.c.a1 * this.y1;
        this.x1 = x;
        this.y1 = y;
        return y;
    }
}

/**
 * One-axis PID step matching pid.c structure for the linear core.
 * `rChirp` is the raw excitation (exc); phaseComp+amplitude applied inside when configured.
 */
export class FirmwarePidAxisSimulator {
    private iTerm = 0;
    private prevGyroD = 0;
    private readonly gyro1?: Pt1;
    private readonly gyro2?: Pt1;
    private readonly d1?: Pt1;
    private readonly d2?: Pt1;
    private readonly yawP?: Pt1;
    private readonly phase?: PhaseComp;
    private readonly Kp: number;
    private readonly Ki: number;
    private readonly Kd: number;
    private readonly Kf: number;
    private readonly pidFrequency: number;
    private readonly amplitude: number;

    constructor(
        private readonly cfg: DigitalControllerConfig,
        opts: { chirpAmplitude?: number } = {},
    ) {
        const c = pidCoefficients(cfg);
        this.Kp = c.Kp;
        this.Ki = c.Ki;
        this.Kd = c.Kd;
        this.Kf = c.Kf;
        this.pidFrequency = 1 / cfg.pidDt;
        this.amplitude = opts.chirpAmplitude ?? 1;
        if (cfg.gyroLpf1Hz) this.gyro1 = new Pt1(pt1Gain(cfg.gyroLpf1Hz, cfg.gyroDt));
        if (cfg.gyroLpf2Hz) this.gyro2 = new Pt1(pt1Gain(cfg.gyroLpf2Hz, cfg.gyroDt));
        if (cfg.dtermLpf1Hz) this.d1 = new Pt1(pt1Gain(cfg.dtermLpf1Hz, cfg.pidDt));
        if (cfg.dtermLpf2Hz) this.d2 = new Pt1(pt1Gain(cfg.dtermLpf2Hz, cfg.pidDt));
        if (cfg.yawLowpassHz) this.yawP = new Pt1(pt1Gain(cfg.yawLowpassHz, cfg.pidDt));
        if (cfg.chirpLagHz && cfg.chirpLeadHz) {
            const pc = phaseCompCoeffs(cfg.chirpLagHz, cfg.chirpLeadHz, Math.round(cfg.pidDt * 1e6));
            if (pc) this.phase = new PhaseComp(pc);
        }
    }

    /** Advance one PID sample. gyroRaw is pre-gyro-LPF rate (°/s). */
    step(opts: {
        gyroRaw: number;
        /** Raw chirp exc (debug[3]/1000), before phaseComp. */
        chirpExc?: number;
        /** RC feedforward delta (°/s² style), only if includeRcFeedforward. */
        rcFeedforward?: number;
    }): { u: number; y: number; r: number; p: number; i: number; d: number; f: number } {
        let y = opts.gyroRaw;
        if (this.gyro1) y = this.gyro1.apply(y);
        if (this.gyro2) y = this.gyro2.apply(y);

        let r = 0;
        if (opts.chirpExc !== undefined) {
            const shaped = this.phase ? this.phase.apply(opts.chirpExc) : opts.chirpExc;
            r = this.amplitude * shaped;
        }

        const error = r - y;
        let p = this.Kp * error;
        if (this.yawP) p = this.yawP.apply(p);

        this.iTerm += this.Ki * this.cfg.pidDt * error;
        const i = this.iTerm;

        let d = 0;
        if (this.Kd > 0) {
            let gd = y;
            if (this.d1) gd = this.d1.apply(gd);
            if (this.d2) gd = this.d2.apply(gd);
            const delta = -(gd - this.prevGyroD) * this.pidFrequency;
            this.prevGyroD = gd;
            d = this.Kd * delta;
        }

        // CHIRP path: F = 0. RC path optional.
        const f = this.cfg.includeRcFeedforward && opts.rcFeedforward !== undefined ? this.Kf * opts.rcFeedforward : 0;

        return { u: p + i + d + f, y, r, p, i, d, f };
    }
}

/**
 * Measure complex gain of a discrete SISO by driving a long cosine and fitting
 * (independent of the analytic H(z) formulae).
 */
export function measureFrfFromSimulator(
    makeSim: () => FirmwarePidAxisSimulator,
    opts: {
        freqHz: number;
        pidDt: number;
        mode: "reference" | "feedback" | "rc_feedforward";
        settleCycles?: number;
        measureCycles?: number;
    },
): Complex {
    const { freqHz, pidDt, mode } = opts;
    const settle = opts.settleCycles ?? 8;
    const measure = opts.measureCycles ?? 16;
    const samplesPerCycle = Math.max(8, Math.round(1 / (freqHz * pidDt)));
    const nSettle = settle * samplesPerCycle;
    const nMeas = measure * samplesPerCycle;
    const sim = makeSim();
    const w = 2 * Math.PI * freqHz;

    let sumInRe = 0;
    let sumInIm = 0;
    let sumOutRe = 0;
    let sumOutIm = 0;

    for (let n = 0; n < nSettle + nMeas; n++) {
        const t = n * pidDt;
        const cos = Math.cos(w * t);
        const sin = Math.sin(w * t);
        let input = 0;
        let out = 0;
        if (mode === "reference") {
            const s = sim.step({ gyroRaw: 0, chirpExc: cos });
            input = s.r; // after phaseComp+amp — matches C_reference definition u/r
            // For C_reference we want u / r_chirp_effective. Using r from sim.
            out = s.u;
            // Re-drive definition: also compare u/exc path separately in tests.
        } else if (mode === "feedback") {
            const s = sim.step({ gyroRaw: cos, chirpExc: 0 });
            input = s.y;
            out = -s.u; // C_feedback := -u/y
        } else {
            const s = sim.step({ gyroRaw: 0, chirpExc: 0, rcFeedforward: cos });
            input = cos;
            out = s.f;
        }
        if (n >= nSettle) {
            sumInRe += input * cos;
            sumInIm += input * -sin;
            sumOutRe += out * cos;
            sumOutIm += out * -sin;
        }
    }
    const scale = 2 / nMeas;
    const U = { re: sumInRe * scale, im: sumInIm * scale };
    const Y = { re: sumOutRe * scale, im: sumOutIm * scale };
    return cdiv(Y, U);
}

/** AIR65 parameters reconstructed from the Oct-18 BBL header (BETAFPVG473). */
export const AIR65_BBL_CONTROLLER = {
    firmwareRevision: "Betaflight 2026.6.2 (43875a55a) STM32G474",
    board: "BEFH BETAFPVG473",
    looptimeUs: 125,
    pidProcessDenom: 2,
    pidDt: 250e-6,
    gyroDt: 125e-6,
    debugMode: 96, // DEBUG_CHIRP
    simplifiedPidsMode: 0,
    roll: { p: 56, i: 79, d: 30, f: 22 } satisfies AxisPidRaw,
    pitch: { p: 82, i: 117, d: 61, f: 32 } satisfies AxisPidRaw,
    yaw: { p: 56, i: 79, d: 0, f: 22 } satisfies AxisPidRaw,
    gyroLpf1Hz: 150,
    gyroLpf2Hz: 300,
    dtermLpf1Hz: 75,
    dtermLpf2Hz: 150,
    yawLowpassHz: 100,
    chirpLagHz: 3,
    chirpLeadHz: 30,
    chirpAmplitude: { roll: 230, pitch: 230, yaw: 180 },
    dMax: [40, 0, 0] as const,
    itermRelax: 1, // RP
    tpaRate: 60,
    dynNotchCount: 2,
    rpmFilterHarmonics: 2,
    available: [
        "looptime",
        "pid_process_denom",
        "rollPID/pitchPID/yawPID",
        "ff_weight",
        "gyro_lpf1/2_static_hz + types",
        "dterm_lpf1/2_static_hz + types",
        "yaw_lowpass_hz",
        "chirp_lag/lead/amplitudes/time/freq",
        "DEBUG_CHIRP channels",
        "d_max",
        "iterm_relax*",
        "tpa_*",
        "simplified_* (mode 0)",
    ],
    missingOrIncomplete: [
        "Exact dyn_notch instantaneous centres during the sweep (time-varying)",
        "Exact rpm_filter notch schedule vs eRPM (time-varying)",
        "Per-sample TPA factor (needs continuous throttle reconstruction; constant if throttle held)",
        "D_max multiplier trajectory (roll only; state-dependent)",
        "Mixer / motor plant / ESC delay (plant — out of M1 controller scope)",
        "Gyro hardware LPF / sensor delay beyond logged software filters",
    ],
} as const;

export function air65YawConfig(): DigitalControllerConfig {
    return {
        gyroDt: AIR65_BBL_CONTROLLER.gyroDt,
        pidDt: AIR65_BBL_CONTROLLER.pidDt,
        axis: AIR65_BBL_CONTROLLER.yaw,
        yawKiBoost: true,
        yawLowpassHz: AIR65_BBL_CONTROLLER.yawLowpassHz,
        gyroLpf1Hz: AIR65_BBL_CONTROLLER.gyroLpf1Hz,
        gyroLpf2Hz: AIR65_BBL_CONTROLLER.gyroLpf2Hz,
        // yaw D = 0 → no dterm filters in Cd
        chirpLagHz: AIR65_BBL_CONTROLLER.chirpLagHz,
        chirpLeadHz: AIR65_BBL_CONTROLLER.chirpLeadHz,
    };
}

export function air65RollConfig(): DigitalControllerConfig {
    return {
        gyroDt: AIR65_BBL_CONTROLLER.gyroDt,
        pidDt: AIR65_BBL_CONTROLLER.pidDt,
        axis: AIR65_BBL_CONTROLLER.roll,
        yawKiBoost: false,
        gyroLpf1Hz: AIR65_BBL_CONTROLLER.gyroLpf1Hz,
        gyroLpf2Hz: AIR65_BBL_CONTROLLER.gyroLpf2Hz,
        dtermLpf1Hz: AIR65_BBL_CONTROLLER.dtermLpf1Hz,
        dtermLpf2Hz: AIR65_BBL_CONTROLLER.dtermLpf2Hz,
        chirpLagHz: AIR65_BBL_CONTROLLER.chirpLagHz,
        chirpLeadHz: AIR65_BBL_CONTROLLER.chirpLeadHz,
    };
}

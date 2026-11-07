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
 * Notch-aware Betaflight gyro filter chain (plan V2-C), firmware order of
 * Betaflight 2026.6.2 sensors/gyro_filter_impl.c:
 *
 *   gyroUnfilt → lpf2 (downsampling filter) → RPM notches (rpm_filter.c: per motor and
 *   harmonic, SVF in TPT form, weight / fade, round-robin updates) → static notches →
 *   lpf1 (throttle-scheduled, mixer.c updateDynLpfCutoffs) → dynamic notch
 *   (dyn_notch_filter.c: SDFT peak tracking, a replica of the firmware's state machine)
 *   → gyroADCf.
 *
 * simulateGyroChain runs it sample by sample over logged gyroUnfilt / eRPM / throttle,
 * so the prediction can be compared with the logged gyroADC (the firmware's own output);
 * chainFrf gives the LTI response for one filter state, and effectiveChainFrf the mean
 * complex response over a window (e.g. a CHIRP sweep) with its spread.
 *
 * Approximations, all reported: the blackbox logs gyroUnfilt at the PID rate, so lpf2
 * runs at the PID rate here instead of the gyro rate (its FRF in chainFrf uses the gyro
 * rate); static gyro notches and non-PT1 lowpass types are refused (`unsupported`).
 * Offline only: no MSP, no Apply path.
 */

import {
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    cscale,
    csub,
    pt1Gain,
    type Complex,
} from "@/js/blackbox/betaflight_digital_controller";
import { dynLpfCutoffHz, mixerThrottle } from "@/js/blackbox/betaflight_dterm_dynamic";

const DYN_LPF_THROTTLE_STEPS = 100; // mixer.c
const DYN_LPF_THROTTLE_UPDATE_DELAY_US = 5000; // mixer.c
const RPM_FILTER_DURATION_S = 0.001; // rpm_filter.c
const SDFT_SAMPLE_SIZE = 72; // sdft.h
const SDFT_BIN_COUNT = SDFT_SAMPLE_SIZE / 2;
const SDFT_R = 0.9999; // sdft.c
const DYN_NOTCH_SMOOTH_HZ = 4; // dyn_notch_filter.c
const STEP_COUNT = 4;
const DYN_NOTCH_CALC_TICKS = 3 * STEP_COUNT;
const DYN_NOTCH_UPDATE_MIN_HZ = 2000;
const FILTER_PT1 = 0;
/** A spacing above this multiple of the nominal PID period restarts the chain (dropped frame). */
const GAP_FACTOR = 1.5;
/** Filter warm-up discarded after the start and after every gap (dyn notch needs ~0.3 s). */
export const CHAIN_WARMUP_S = 0.5;

export interface GyroChainConfig {
    gyroDt: number;
    pidDt: number;
    lpf1Type: number;
    lpf1StaticHz: number;
    /** gyro_lpf1_dyn_hz; min 0 = static lpf1. */
    lpf1DynMinHz: number;
    lpf1DynMaxHz: number;
    lpf1DynExpo: number;
    lpf2Type: number;
    lpf2StaticHz: number;
    notch1Hz: number;
    notch2Hz: number;
    rpmHarmonics: number;
    rpmMinHz: number;
    rpmFadeRangeHz: number;
    /** rpm_filter_q (×100). */
    rpmQ: number;
    /** rpm_filter_weights (0–100) per harmonic. */
    rpmWeights: number[];
    rpmLpfHz: number;
    motorPoles: number;
    dynNotchCount: number;
    /** dyn_notch_q (×100). */
    dynNotchQ: number;
    dynNotchMinHz: number;
    dynNotchMaxHz: number;
}

export function chainSupportIssues(cfg: GyroChainConfig): string[] {
    const out: string[] = [];
    if (cfg.lpf1StaticHz > 0 && cfg.lpf1Type !== FILTER_PT1) out.push("gyro_lpf1_type_not_pt1");
    if (cfg.lpf2StaticHz > 0 && cfg.lpf2Type !== FILTER_PT1) out.push("gyro_lpf2_type_not_pt1");
    if (cfg.notch1Hz > 0 || cfg.notch2Hz > 0) out.push("gyro_static_notch_not_modelled");
    if (cfg.rpmHarmonics > 0 && !(cfg.motorPoles > 0)) out.push("motor_poles_unknown");
    if (!(cfg.pidDt > 0) || !(cfg.gyroDt > 0)) out.push("loop_time_unknown");
    return out;
}

// --- SVF notch in TPT form (filter.c rpmNotch / svfNotch), and its exact FRF -------------

interface SvfCoeffs {
    a1: number;
    a2: number;
    f: number;
    /** Output = input − wq · v1. */
    wq: number;
}

/** filter.c rpmNotchUpdate (sincosf_approx → Math). */
export function rpmNotchCoeffs(freqHz: number, dt: number, q: number, weight: number): SvfCoeffs {
    const f = Math.tan(Math.PI * freqHz * dt);
    const qi = 1 / q;
    const a1 = 1 / (1 + f * (f + qi));
    return { a1, a2: f * a1, f, wq: qi * weight };
}

/** filter.c svfNotchUpdate, rewritten to the rpmNotch form (identical filter, weight 1). */
export function svfNotchCoeffs(freqHz: number, dt: number, q: number): SvfCoeffs {
    return rpmNotchCoeffs(freqHz, dt, q, 1);
}

class Svf {
    s1 = 0;
    s2 = 0;
    constructor(public c: SvfCoeffs) {}
    apply(x: number): number {
        const { a1, a2, f, wq } = this.c;
        const v3 = x - this.s2;
        const v1 = a1 * this.s1 + a2 * v3;
        const v2 = this.s2 + f * v1;
        this.s1 = 2 * v1 - this.s1;
        this.s2 = 2 * v2 - this.s2;
        return x - wq * v1;
    }
}

/** Steady-state response of the SVF recurrence to z^n (solves its 2×2 state equations). */
export function svfFrf(c: SvfCoeffs, z: Complex): Complex {
    const one = { re: 1, im: 0 };
    // (z+1−2a1)·S1 + 2a2·S2 = 2a2 ; −2f·a1·S1 + (z−1+2f·a2)·S2 = 2f·a2   (per unit input)
    const m11 = csub(cadd(z, one), { re: 2 * c.a1, im: 0 });
    const m12 = { re: 2 * c.a2, im: 0 };
    const m21 = { re: -2 * c.f * c.a1, im: 0 };
    const m22 = cadd(csub(z, one), { re: 2 * c.f * c.a2, im: 0 });
    const b1 = { re: 2 * c.a2, im: 0 };
    const b2 = { re: 2 * c.f * c.a2, im: 0 };
    const det = csub(cmul(m11, m22), cmul(m12, m21));
    const s1 = cdiv(csub(cmul(b1, m22), cmul(m12, b2)), det);
    const s2 = cdiv(csub(cmul(m11, b2), cmul(m21, b1)), det);
    const v1 = cadd(cscale(s1, c.a1), cscale(csub(one, s2), c.a2));
    return csub(one, cscale(v1, c.wq));
}

function zAt(freqHz: number, dt: number): Complex {
    const w = 2 * Math.PI * freqHz * dt;
    return { re: Math.cos(w), im: Math.sin(w) };
}

function pt1Frf(k: number, freqHz: number, dt: number): Complex {
    const zinv = zAt(-freqHz, dt);
    return cdiv({ re: k, im: 0 }, csub({ re: 1, im: 0 }, cscale(zinv, 1 - k)));
}

// --- one filter state and its LTI response -------------------------------------------

/** What the chain holds at one instant (per axis for the dynamic notch). */
export interface ChainState {
    lpf1Hz: number;
    /** Active RPM notches: centre and effective weight. */
    rpmNotches: { hz: number; weight: number }[];
    dynNotchHz: number[];
}

/** LTI response of the chain for one state: lpf2 at the gyro rate, the rest at the PID rate. */
export function chainFrf(cfg: GyroChainConfig, state: ChainState, freqHz: number): Complex {
    let H: Complex = { re: 1, im: 0 };
    if (cfg.lpf2StaticHz > 0) H = cmul(H, pt1Frf(pt1Gain(cfg.lpf2StaticHz, cfg.gyroDt), freqHz, cfg.gyroDt));
    const z = zAt(freqHz, cfg.pidDt);
    const q = cfg.rpmQ / 100;
    for (const n of state.rpmNotches) {
        if (n.weight > 0) H = cmul(H, svfFrf(rpmNotchCoeffs(n.hz, cfg.pidDt, q, n.weight), z));
    }
    if (state.lpf1Hz > 0) H = cmul(H, pt1Frf(pt1Gain(state.lpf1Hz, cfg.pidDt), freqHz, cfg.pidDt));
    for (const hz of state.dynNotchHz) H = cmul(H, svfFrf(svfNotchCoeffs(hz, cfg.pidDt, cfg.dynNotchQ / 100), z));
    return H;
}

// --- dynamic notch: replica of dyn_notch_filter.c + sdft.c ------------------------------

class DynNotch {
    readonly count: number;
    readonly q: number;
    readonly minHz: number;
    readonly maxHz: number;
    private readonly sampleCount: number;
    private readonly resolutionHz: number;
    private readonly startBin: number;
    private readonly endBin: number;
    private readonly batchSize: number;
    private readonly pt1LooptimeS: number;
    private readonly rPowerN = Math.pow(SDFT_R, SDFT_SAMPLE_SIZE);
    private readonly twRe: Float64Array;
    private readonly twIm: Float64Array;
    readonly centre: number[][];
    readonly notch: Svf[][];
    private sdft: { idx: number; samples: Float64Array; re: Float64Array; im: Float64Array }[];
    private acc = [0, 0, 0];
    private avg = [0, 0, 0];
    private sampleIndex = 0;
    private tick = 0;
    private step = 0;
    private axis = 0;
    private data = new Float64Array(SDFT_BIN_COUNT);
    private noise = 0;
    private peaks: { bin: number; value: number }[] = [];

    constructor(cfg: GyroChainConfig) {
        const dt = cfg.pidDt;
        const looprateHz = 1 / dt;
        const nyquist = looprateHz / 2;
        this.count = looprateHz < DYN_NOTCH_UPDATE_MIN_HZ ? 0 : cfg.dynNotchCount;
        this.q = cfg.dynNotchQ / 100;
        this.minHz = cfg.dynNotchMinHz;
        this.maxHz = Math.min(Math.max(this.minHz, cfg.dynNotchMaxHz), nyquist);
        this.sampleCount = Math.max(1, Math.trunc(nyquist / this.maxHz));
        const sdftRate = looprateHz / this.sampleCount;
        this.resolutionHz = sdftRate / SDFT_SAMPLE_SIZE;
        this.startBin = Math.max(1, Math.round(this.minHz / this.resolutionHz));
        this.endBin = Math.min(SDFT_BIN_COUNT - 1, Math.round(this.maxHz / this.resolutionHz));
        this.batchSize = Math.trunc((this.endBin - this.startBin + 1) / this.sampleCount);
        this.pt1LooptimeS = DYN_NOTCH_CALC_TICKS / looprateHz;
        this.twRe = new Float64Array(SDFT_BIN_COUNT);
        this.twIm = new Float64Array(SDFT_BIN_COUNT);
        for (let i = 0; i < SDFT_BIN_COUNT; i++) {
            const phi = ((2 * Math.PI) / SDFT_SAMPLE_SIZE) * i;
            this.twRe[i] = SDFT_R * Math.cos(phi);
            this.twIm[i] = SDFT_R * Math.sin(phi);
        }
        this.sdft = [0, 1, 2].map(() => ({
            idx: 0,
            samples: new Float64Array(SDFT_SAMPLE_SIZE),
            re: new Float64Array(SDFT_BIN_COUNT),
            im: new Float64Array(SDFT_BIN_COUNT),
        }));
        this.centre = [0, 1, 2].map(() =>
            Array.from(
                { length: this.count },
                (_, p) => ((p + 0.5) * (this.maxHz - this.minHz)) / this.count + this.minHz,
            ),
        );
        this.notch = this.centre.map((row) => row.map((hz) => new Svf(svfNotchCoeffs(hz, dt, this.q))));
        this.peaks = Array.from({ length: this.count }, () => ({ bin: 0, value: 0 }));
        this.dt = dt;
    }
    private readonly dt: number;

    filter(axis: number, x: number): number {
        this.acc[axis] += x;
        let y = x;
        for (const n of this.notch[axis]) y = n.apply(y);
        return y;
    }

    private bin(s: (typeof this.sdft)[number], i: number, delta: number) {
        const re = s.re[i] + delta;
        const im = s.im[i];
        s.re[i] = this.twRe[i] * re - this.twIm[i] * im;
        s.im[i] = this.twRe[i] * im + this.twIm[i] * re;
    }

    private pushBatch(s: (typeof this.sdft)[number], sample: number, batchIdx: number) {
        const batchStart = this.batchSize * batchIdx + this.startBin;
        let batchEnd = batchStart;
        const delta = sample - this.rPowerN * s.samples[s.idx];
        if (batchIdx === this.sampleCount - 1) {
            s.samples[s.idx] = sample;
            s.idx = (s.idx + 1) % SDFT_SAMPLE_SIZE;
            batchEnd += this.endBin - batchStart + 1;
        } else {
            batchEnd += this.batchSize;
        }
        for (let i = batchStart; i < batchEnd; i++) this.bin(s, i, delta);
        if (this.startBin > 0 && batchIdx === 0) this.bin(s, this.startBin - 1, delta);
        if (this.endBin < SDFT_BIN_COUNT - 1 && batchIdx === this.sampleCount - 1) this.bin(s, this.endBin + 1, delta);
    }

    private winSq(s: (typeof this.sdft)[number]) {
        const at = (i: number, lo: number, hi: number) => {
            const re = s.re[i] - 0.5 * (s.re[lo] + s.re[hi]);
            const im = s.im[i] - 0.5 * (s.im[lo] + s.im[hi]);
            return re * re + im * im;
        };
        const sb = this.startBin;
        const eb = this.endBin;
        if (sb === 0) {
            const re = s.re[sb] - s.re[sb + 1];
            const im = s.im[sb] - s.im[sb + 1];
            this.data[sb] = re * re + im * im;
        } else {
            this.data[sb] = at(sb, sb - 1, sb + 1);
        }
        for (let i = sb + 1; i < eb; i++) this.data[i] = at(i, i - 1, i + 1);
        if (eb === SDFT_BIN_COUNT - 1) {
            const re = s.re[eb] - s.re[eb - 1];
            const im = s.im[eb] - s.im[eb - 1];
            this.data[eb] = re * re + im * im;
        } else {
            this.data[eb] = at(eb, eb - 1, eb + 1);
        }
    }

    /** dynNotchUpdate(): called once per PID loop after the three axes were filtered. */
    update() {
        if (!this.count) return;
        if (this.sampleIndex === this.sampleCount) {
            this.sampleIndex = 0;
            for (let a = 0; a < 3; a++) {
                this.avg[a] = this.acc[a] / this.sampleCount;
                this.acc[a] = 0;
            }
            this.tick = DYN_NOTCH_CALC_TICKS;
        }
        for (let a = 0; a < 3; a++) this.pushBatch(this.sdft[a], this.avg[a], this.sampleIndex);
        this.sampleIndex++;
        if (this.tick > 0) {
            this.process();
            this.tick--;
        }
    }

    private process() {
        const d = this.data;
        switch (this.step) {
            case 0: {
                this.winSq(this.sdft[this.axis]);
                this.noise = 0;
                for (let b = this.startBin; b <= this.endBin; b++) this.noise += d[b];
                break;
            }
            case 1: {
                for (const p of this.peaks) {
                    p.bin = 0;
                    p.value = 0;
                }
                for (let b = this.startBin + 1; b < this.endBin; b++) {
                    if (d[b] > d[b - 1] && d[b] > d[b + 1]) {
                        for (let p = 0; p < this.count; p++) {
                            if (d[b] > this.peaks[p].value) {
                                for (let k = this.count - 1; k > p; k--) this.peaks[k] = { ...this.peaks[k - 1] };
                                this.peaks[p] = { bin: b, value: d[b] };
                                break;
                            }
                        }
                        b++;
                    }
                }
                for (let p = this.count - 1; p > 0; p--) {
                    for (let k = 0; k < p; k++) {
                        if (this.peaks[k].bin > this.peaks[k + 1].bin && this.peaks[k + 1].bin !== 0) {
                            const t = this.peaks[k];
                            this.peaks[k] = this.peaks[k + 1];
                            this.peaks[k + 1] = t;
                        }
                    }
                }
                break;
            }
            case 2: {
                let peakCount = 0;
                for (const p of this.peaks) {
                    if (p.bin !== 0) {
                        this.noise -= 0.75 * d[p.bin - 1] + d[p.bin] + 0.75 * d[p.bin + 1];
                        peakCount++;
                    }
                }
                this.noise /= this.endBin - this.startBin - peakCount + 1;
                this.noise *= 2;
                for (let p = 0; p < this.count; p++) {
                    const pk = this.peaks[p];
                    if (pk.bin !== 0 && pk.value > this.noise) {
                        let meanBin = pk.bin;
                        const y0 = d[pk.bin - 1];
                        const y1 = d[pk.bin];
                        const y2 = d[pk.bin + 1];
                        const denom = 2 * (y0 - 2 * y1 + y2);
                        if (denom !== 0) meanBin += (y0 - y2) / denom;
                        const hz = Math.min(Math.max(meanBin * this.resolutionHz, this.minHz), this.maxHz);
                        const mult = Math.min(Math.max(pk.value / this.noise, 1), 10);
                        const gain = pt1Gain(DYN_NOTCH_SMOOTH_HZ * mult, this.pt1LooptimeS);
                        this.centre[this.axis][p] += gain * (hz - this.centre[this.axis][p]);
                    }
                }
                break;
            }
            case 3: {
                for (let p = 0; p < this.count; p++) {
                    const pk = this.peaks[p];
                    if (pk.bin !== 0 && pk.value > this.noise) {
                        this.notch[this.axis][p].c = svfNotchCoeffs(this.centre[this.axis][p], this.dt, this.q);
                    }
                }
                this.axis = (this.axis + 1) % 3;
                break;
            }
        }
        this.step = (this.step + 1) % STEP_COUNT;
    }
}

// --- RPM filter: replica of rpm_filter.c + the dshot.c motor-frequency PT1 ---------------

class RpmFilter {
    readonly harmonics: number;
    private readonly minHz: number;
    private readonly maxHz: number;
    private readonly fade: number;
    private readonly q: number;
    private readonly weights: number[];
    private readonly perIteration: number;
    private readonly notch: Svf[][][]; // [axis][motor][harmonic]
    private readonly motorHz: number[];
    private readonly freqK: number;
    private readonly erpmToHz: number;
    private motorIndex = 0;
    private harmonicIndex = 0;
    readonly state: { hz: number; weight: number }[][]; // [motor][harmonic]

    constructor(
        cfg: GyroChainConfig,
        private readonly motors: number,
    ) {
        this.harmonics = cfg.rpmHarmonics;
        this.minHz = cfg.rpmMinHz;
        this.maxHz = (0.48 * 1e6) / (cfg.pidDt * 1e6);
        this.fade = cfg.rpmFadeRangeHz;
        this.q = cfg.rpmQ / 100;
        this.weights = [0, 1, 2].map((i) => Math.min(Math.max((cfg.rpmWeights[i] ?? 100) / 100, 0), 1));
        const perUpdate = RPM_FILTER_DURATION_S / cfg.pidDt;
        this.perIteration = Math.ceil((motors * this.harmonics) / perUpdate);
        this.state = Array.from({ length: motors }, () =>
            Array.from({ length: this.harmonics }, (_, i) => ({ hz: this.minHz * (i + 1), weight: 0 })),
        );
        this.notch = [0, 1, 2].map(() =>
            this.state.map((row) => row.map((n) => new Svf(rpmNotchCoeffs(n.hz, cfg.pidDt, this.q, 0)))),
        );
        this.motorHz = Array.from({ length: motors }, () => 0);
        this.freqK = pt1Gain(cfg.rpmLpfHz, cfg.pidDt);
        // ERPM_PER_LSB / SECONDS_PER_MINUTE / (poles / 2): the logged eRPM is eRPM / 100.
        this.erpmToHz = 100 / 60 / (cfg.motorPoles / 2);
        this.pidDt = cfg.pidDt;
    }
    private readonly pidDt: number;

    resetMotors(erpm: number[]) {
        for (let m = 0; m < this.motors; m++) this.motorHz[m] = this.erpmToHz * erpm[m];
    }

    /** dshotUpdateTelemetry (motor frequency PT1) then rpmFilterUpdate (round-robin). */
    update(erpm: number[]) {
        for (let m = 0; m < this.motors; m++)
            this.motorHz[m] += this.freqK * (this.erpmToHz * erpm[m] - this.motorHz[m]);
        if (!this.harmonics) return;
        for (let i = 0; i < this.perIteration; i++) {
            const h = this.harmonicIndex;
            const m = this.motorIndex;
            if (this.weights[h] > 0) {
                const hz = Math.min(Math.max((h + 1) * this.motorHz[m], this.minHz), this.maxHz);
                const margin = hz - this.minHz;
                let weight = margin < this.fade ? margin / this.fade : 1;
                weight *= this.weights[h];
                this.state[m][h] = { hz, weight };
                const c = rpmNotchCoeffs(hz, this.pidDt, this.q, weight);
                for (let a = 0; a < 3; a++) this.notch[a][m][h].c = c;
            }
            this.harmonicIndex = (this.harmonicIndex + 1) % this.harmonics;
            if (this.harmonicIndex === 0) this.motorIndex = (this.motorIndex + 1) % this.motors;
        }
    }

    apply(axis: number, x: number): number {
        let y = x;
        for (let h = 0; h < this.harmonics; h++) {
            if (this.weights[h] <= 0) continue;
            for (let m = 0; m < this.motors; m++) y = this.notch[axis][m][h].apply(y);
        }
        return y;
    }
}

// --- the time-domain chain ------------------------------------------------------------

export interface ChainInput {
    timeUs: ArrayLike<number>;
    /** Logged gyroUnfilt per axis (same scale as gyroADC). */
    gyroUnfilt: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
    /** Logged eRPM[0..n] (eRPM / 100); empty when not logged. */
    erpm: ArrayLike<number>[];
    /** Logged rcCommand[3]. */
    rcThrottle: ArrayLike<number>;
}

export interface ChainSimulation {
    /** Predicted gyroADCf per axis; NaN where not simulated. */
    out: [Float64Array, Float64Array, Float64Array];
    /** After lpf2 + RPM (before lpf1 / dyn notch), for the RPM residual. */
    postRpm: [Float64Array, Float64Array, Float64Array];
    lpf1Hz: Float64Array;
    /** Dynamic notch centres per axis and notch, per sample (NaN where not simulated). */
    dynNotchHz: Float64Array[][];
    /** RPM notch centre / weight per motor and harmonic, per sample. */
    rpmHz: Float64Array[][];
    rpmWeight: Float64Array[][];
    valid: Uint8Array;
    runs: number;
    notes: string[];
}

export function simulateGyroChain(input: ChainInput, cfg: GyroChainConfig): ChainSimulation {
    const n = input.timeUs.length;
    const mk = () => new Float64Array(n).fill(Number.NaN);
    const motors = input.erpm.length;
    const rpmOn = cfg.rpmHarmonics > 0 && motors > 0;
    const sim: ChainSimulation = {
        out: [mk(), mk(), mk()],
        postRpm: [mk(), mk(), mk()],
        lpf1Hz: mk(),
        dynNotchHz: [0, 1, 2].map(() => Array.from({ length: cfg.dynNotchCount }, mk)),
        rpmHz: Array.from({ length: rpmOn ? motors : 0 }, () => Array.from({ length: cfg.rpmHarmonics }, mk)),
        rpmWeight: Array.from({ length: rpmOn ? motors : 0 }, () => Array.from({ length: cfg.rpmHarmonics }, mk)),
        valid: new Uint8Array(n),
        runs: 0,
        notes: [],
    };
    const issues = chainSupportIssues(cfg);
    if (issues.length) {
        sim.notes.push(...issues);
        return sim;
    }
    if (cfg.rpmHarmonics > 0 && motors === 0) sim.notes.push("erpm_not_logged_rpm_filter_not_simulated");
    const nominalUs = cfg.pidDt * 1e6;
    const warmup = Math.ceil(CHAIN_WARMUP_S / cfg.pidDt);
    const erpmAt = (k: number) => input.erpm.map((c) => Number(c[k]) || 0);
    let i = 0;
    while (i < n) {
        let end = i + 1;
        while (end < n && input.timeUs[end] - input.timeUs[end - 1] <= nominalUs * GAP_FACTOR) end++;
        if (end - i > warmup + 1) {
            sim.runs++;
            const lpf2k = cfg.lpf2StaticHz > 0 ? pt1Gain(cfg.lpf2StaticHz, cfg.pidDt) : 1;
            const lpf2 = [0, 1, 2].map((a) => Number(input.gyroUnfilt[a][i]));
            const throttle0 = mixerThrottle(input.rcThrottle[i]);
            const cutoffFor = (t: number) =>
                cfg.lpf1DynMinHz > 0
                    ? dynLpfCutoffHz(
                          Math.round(t * DYN_LPF_THROTTLE_STEPS) / DYN_LPF_THROTTLE_STEPS,
                          cfg.lpf1DynMinHz,
                          cfg.lpf1DynMaxHz,
                          cfg.lpf1DynExpo,
                      )
                    : cfg.lpf1StaticHz;
            let cutoff = cutoffFor(throttle0);
            let lpf1k = cutoff > 0 ? pt1Gain(cutoff, cfg.pidDt) : 1;
            const lpf1 = [...lpf2];
            let lastQ = Math.round(throttle0 * DYN_LPF_THROTTLE_STEPS);
            let lastUpdateUs = input.timeUs[i];
            const rpm = rpmOn ? new RpmFilter(cfg, motors) : null;
            rpm?.resetMotors(erpmAt(i));
            const dyn = new DynNotch(cfg);
            for (let k = i; k < end; k++) {
                rpm?.update(erpmAt(k));
                for (let a = 0; a < 3; a++) {
                    lpf2[a] += lpf2k * (Number(input.gyroUnfilt[a][k]) - lpf2[a]);
                    let y = rpm ? rpm.apply(a, lpf2[a]) : lpf2[a];
                    sim.postRpm[a][k] = y;
                    lpf1[a] += lpf1k * (y - lpf1[a]);
                    y = dyn.count ? dyn.filter(a, cutoff > 0 ? lpf1[a] : y) : cutoff > 0 ? lpf1[a] : y;
                    sim.out[a][k] = y;
                }
                dyn.update();
                sim.lpf1Hz[k] = cutoff;
                for (let a = 0; a < 3; a++) dyn.centre[a].forEach((hz, p) => (sim.dynNotchHz[a][p][k] = hz));
                rpm?.state.forEach((row, m) =>
                    row.forEach((s, h) => {
                        sim.rpmHz[m][h][k] = s.hz;
                        sim.rpmWeight[m][h][k] = s.weight;
                    }),
                );
                if (k - i >= warmup) sim.valid[k] = 1;
                // Mixer of the same loop: lpf1 cutoff quantized and rate-limited (mixer.c).
                if (cfg.lpf1DynMinHz > 0) {
                    const t = input.timeUs[k];
                    if (t - lastUpdateUs >= DYN_LPF_THROTTLE_UPDATE_DELAY_US) {
                        const q = Math.round(mixerThrottle(input.rcThrottle[k]) * DYN_LPF_THROTTLE_STEPS);
                        if (q !== lastQ) {
                            cutoff = dynLpfCutoffHz(
                                q / DYN_LPF_THROTTLE_STEPS,
                                cfg.lpf1DynMinHz,
                                cfg.lpf1DynMaxHz,
                                cfg.lpf1DynExpo,
                            );
                            lpf1k = pt1Gain(cutoff, cfg.pidDt);
                            lastQ = q;
                            lastUpdateUs = t;
                        }
                    }
                }
            }
        }
        i = end;
    }
    return sim;
}

/** The chain state in force at sample k for one axis. */
export function stateAt(sim: ChainSimulation, axis: number, k: number): ChainState {
    const rpmNotches: { hz: number; weight: number }[] = [];
    sim.rpmHz.forEach((row, m) =>
        row.forEach((hz, h) => rpmNotches.push({ hz: hz[k], weight: sim.rpmWeight[m][h][k] })),
    );
    return { lpf1Hz: sim.lpf1Hz[k], rpmNotches, dynNotchHz: sim.dynNotchHz[axis].map((c) => c[k]) };
}

export interface EffectiveChain {
    samples: number;
    /** Mean complex response over the window per frequency. */
    frf: (freqHz: number) => Complex;
    /** Spread of the instantaneous response at `freqHz`: phase and gain standard deviation. */
    spread: (freqHz: number) => { phaseDeg: number; gainDb: number };
    medianLpf1Hz: number;
    dynNotchHz: { p5: number; median: number; p95: number }[];
}

/**
 * LTI stand-in for the time-varying chain over [start, end): the mean complex response of
 * up to `maxStates` evenly spaced instantaneous states (each an exact LTI FRF).
 */
export function effectiveChainFrf(
    sim: ChainSimulation,
    cfg: GyroChainConfig,
    axis: number,
    start: number,
    end: number,
    maxStates = 60,
): EffectiveChain | null {
    const idx: number[] = [];
    for (let k = Math.max(0, start); k < Math.min(end, sim.valid.length); k++) if (sim.valid[k]) idx.push(k);
    if (!idx.length) return null;
    const stride = Math.max(1, Math.floor(idx.length / maxStates));
    const states = idx.filter((_, j) => j % stride === 0).map((k) => stateAt(sim, axis, k));
    const cache = new Map<number, Complex[]>();
    const all = (f: number) => {
        let v = cache.get(f);
        if (!v) {
            v = states.map((s) => chainFrf(cfg, s, f));
            cache.set(f, v);
        }
        return v;
    };
    const quant = (vals: number[]) => {
        const s = [...vals].sort((a, b) => a - b);
        const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
        return { p5: at(0.05), median: at(0.5), p95: at(0.95) };
    };
    return {
        samples: idx.length,
        frf: (f) => {
            const v = all(f);
            return cscale(
                v.reduce((a, b) => cadd(a, b), { re: 0, im: 0 }),
                1 / v.length,
            );
        },
        spread: (f) => {
            const v = all(f);
            const mean = cscale(
                v.reduce((a, b) => cadd(a, b), { re: 0, im: 0 }),
                1 / v.length,
            );
            const ph = v.map((c) => {
                let d = cphaseDeg(c) - cphaseDeg(mean);
                while (d > 180) d -= 360;
                while (d < -180) d += 360;
                return d;
            });
            const g = v.map((c) => 20 * Math.log10(Math.max(cmag(c), 1e-12)));
            const gm = g.reduce((a, b) => a + b, 0) / g.length;
            return {
                phaseDeg: Math.sqrt(ph.reduce((a, b) => a + b * b, 0) / ph.length),
                gainDb: Math.sqrt(g.reduce((a, b) => a + (b - gm) ** 2, 0) / g.length),
            };
        },
        medianLpf1Hz: quant(states.map((s) => s.lpf1Hz)).median,
        dynNotchHz: Array.from({ length: cfg.dynNotchCount }, (_, p) => quant(states.map((s) => s.dynNotchHz[p]))),
    };
}

/** Header keys (BBL "H name:value") → chain config; null when a required key is missing. */
export function chainConfigFromHeaders(headers: Record<string, string | undefined>): GyroChainConfig | null {
    const nums = (key: string) => {
        const raw = headers[key];
        if (raw === undefined) return null;
        const v = raw.split(",").map(Number);
        return v.every(Number.isFinite) ? v : null;
    };
    const one = (key: string, fallback?: number) => nums(key)?.[0] ?? fallback ?? null;
    const looptime = one("looptime");
    const denom = one("pid_process_denom");
    const dyn = nums("gyro_lpf1_dyn_hz") ?? [0, 0];
    const notchHz = nums("gyro_notch_hz") ?? [0, 0];
    const required = {
        lpf1Type: one("gyro_lpf1_type"),
        lpf1StaticHz: one("gyro_lpf1_static_hz"),
        lpf1DynExpo: one("gyro_lpf1_dyn_expo", 0),
        lpf2Type: one("gyro_lpf2_type"),
        lpf2StaticHz: one("gyro_lpf2_static_hz"),
        rpmHarmonics: one("rpm_filter_harmonics", 0),
        rpmMinHz: one("rpm_filter_min_hz", 100),
        rpmFadeRangeHz: one("rpm_filter_fade_range_hz", 50),
        rpmQ: one("rpm_filter_q", 500),
        rpmLpfHz: one("rpm_filter_lpf_hz", 150),
        motorPoles: one("motor_poles", 14),
        dynNotchCount: one("dyn_notch_count", 0),
        dynNotchQ: one("dyn_notch_q", 300),
        dynNotchMinHz: one("dyn_notch_min_hz", 100),
        dynNotchMaxHz: one("dyn_notch_max_hz", 600),
    };
    if (looptime === null || denom === null || Object.values(required).some((v) => v === null)) return null;
    const r = required as Record<keyof typeof required, number>;
    return {
        gyroDt: looptime * 1e-6,
        pidDt: looptime * denom * 1e-6,
        lpf1DynMinHz: dyn[0] ?? 0,
        lpf1DynMaxHz: dyn[1] ?? 0,
        notch1Hz: notchHz[0] ?? 0,
        notch2Hz: notchHz[1] ?? 0,
        rpmWeights: nums("rpm_filter_weights") ?? [100, 100, 100],
        ...r,
    };
}

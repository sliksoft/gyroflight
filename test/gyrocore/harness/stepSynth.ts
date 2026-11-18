/*
 * Synthetic closed-loop rate responses for the step-response tests: a known second-order system
 * with transport delay and gain, driven by stick-like setpoint moves.
 */

export interface SecondOrder {
    /** natural frequency (Hz) */
    fnHz: number;
    zeta: number;
    delayMs: number;
    gain: number;
}

/** Deterministic xorshift in [0, 1). */
export function rng(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 4294967296;
    };
}

/** Standard normal from a uniform source (Box–Muller). */
export function gauss(u: () => number): number {
    const a = Math.max(u(), 1e-12);
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
}

/** y = G(x): second-order low-pass with delay and gain, integrated with 8 sub-steps per sample. */
export function simulate(x: ArrayLike<number>, fs: number, p: SecondOrder): Float64Array {
    const n = x.length;
    const y = new Float64Array(n);
    const w = 2 * Math.PI * p.fnHz;
    const d = Math.round((p.delayMs / 1000) * fs);
    const sub = 8;
    const h = 1 / fs / sub;
    let pos = 0;
    let vel = 0;
    for (let i = 0; i < n; i++) {
        const u = i - d >= 0 ? x[i - d] : 0;
        for (let s = 0; s < sub; s++) {
            // semi-implicit Euler on pos'' = w²(K·u − pos) − 2ζw·pos'
            vel += h * (w * w * (p.gain * u - pos) - 2 * p.zeta * w * vel);
            pos += h * vel;
        }
        y[i] = pos;
    }
    return y;
}

/** The true unit step response of `p` over 0…500 ms at `fs`, lag 0 first. */
export function trueStep(fs: number, p: SecondOrder): Float64Array {
    const L = Math.floor(0.5 * fs) + 1;
    const pre = Math.round(0.1 * fs);
    const x = new Float64Array(L + pre);
    for (let i = pre; i < x.length; i++) x[i] = 1;
    // the step is applied from sample `pre` on; the response there is lag 0
    return simulate(x, fs, p).slice(pre, pre + L);
}

export interface StickOptions {
    seconds: number;
    fs: number;
    seed: number;
    /** largest |setpoint| of a move (deg/s) */
    maxDegS?: number;
    /** smallest |setpoint| of a move (deg/s) */
    minDegS?: number;
    /** PT1 smoothing of the stick moves (ms), as rc smoothing */
    smoothMs?: number;
    /** constant offset added to the setpoint (deg/s) */
    offsetDegS?: number;
}

/**
 * Stick-like setpoint: a flick to a random rate held for 0.15–0.4 s, then back to centre for
 * 0.6–1.2 s, repeated; PT1-smoothed. Each flick is one manoeuvre.
 */
export function stickSetpoint(o: StickOptions): Float64Array {
    const u = rng(o.seed);
    const n = Math.round(o.seconds * o.fs);
    const raw = new Float64Array(n);
    const max = o.maxDegS ?? 300;
    const min = o.minDegS ?? 120;
    let i = Math.round(0.3 * o.fs);
    while (i < n) {
        const amp = (min + (max - min) * u()) * (u() < 0.5 ? -1 : 1);
        const hold = Math.round((0.15 + 0.25 * u()) * o.fs);
        for (let k = i; k < Math.min(n, i + hold); k++) raw[k] = amp;
        i += hold + Math.round((0.6 + 0.6 * u()) * o.fs);
    }
    const out = new Float64Array(n);
    const a = 1 - Math.exp(-1 / (((o.smoothMs ?? 8) / 1000) * o.fs));
    let s = 0;
    for (let k = 0; k < n; k++) {
        s += a * (raw[k] - s);
        out[k] = s + (o.offsetDegS ?? 0);
    }
    return out;
}

/** Adds white noise with the given standard deviation (deg/s). */
export function withNoise(x: Float64Array, sd: number, seed: number): Float64Array {
    const u = rng(seed);
    return x.map((v) => v + sd * gauss(u));
}

export function rms(x: ArrayLike<number>): number {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / x.length);
}

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
 * NumPy-compatible reductions, ported unchanged from GyroCore
 * (apps/desktop/gyrocore-app/src/chirp/numeric.ts at d2e60f7) so the gate values
 * computed here are bit-identical to GyroCore's Python reference.
 * `np.add.reduce` on contiguous float64 runs pairwise summation inside
 * 8192-element blocks and adds the block results sequentially.
 */

const PW_BLOCKSIZE = 128;
const REDUCE_BUFSIZE = 8192;

function pairwise(a: ArrayLike<number>, lo: number, n: number): number {
    if (n < 8) {
        let res = -0;
        for (let i = 0; i < n; i++) {
            res += a[lo + i];
        }
        return res;
    }
    if (n <= PW_BLOCKSIZE) {
        const r = [a[lo], a[lo + 1], a[lo + 2], a[lo + 3], a[lo + 4], a[lo + 5], a[lo + 6], a[lo + 7]];
        let i = 8;
        const stop = n - (n % 8);
        for (; i < stop; i += 8) {
            for (let j = 0; j < 8; j++) {
                r[j] = r[j] + a[lo + i + j];
            }
        }
        let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
        for (; i < n; i++) {
            res += a[lo + i];
        }
        return res;
    }
    let n2 = Math.floor(n / 2);
    n2 -= n2 % 8;
    return pairwise(a, lo, n2) + pairwise(a, lo + n2, n - n2);
}

/** `float(np.add.reduce(a))` for float64 input. */
export function npSum(a: ArrayLike<number>): number {
    const n = a.length;
    if (n === 0) {
        return 0;
    }
    let res = pairwise(a, 0, Math.min(REDUCE_BUFSIZE, n));
    for (let s = REDUCE_BUFSIZE; s < n; s += REDUCE_BUFSIZE) {
        res += pairwise(a, s, Math.min(REDUCE_BUFSIZE, n - s));
    }
    return res;
}

/** `float(np.mean(a))` (NaN for empty input, as NumPy). */
export function npMean(a: ArrayLike<number>): number {
    return a.length ? npSum(a) / a.length : Number.NaN;
}

/** `float(np.median(a))` for finite float64 input. */
export function npMedian(a: ArrayLike<number>): number {
    const n = a.length;
    if (!n) {
        return Number.NaN;
    }
    const s = Float64Array.from(a).sort();
    const h = n >> 1;
    return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** `np.rint`: round half to even. */
export function npRint(x: number): number {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) {
        return f + 1;
    }
    if (d < 0.5) {
        return f;
    }
    return f % 2 === 0 ? f : f + 1;
}

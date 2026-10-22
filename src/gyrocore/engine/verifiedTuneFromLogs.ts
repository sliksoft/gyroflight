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
 * Verified Tune from imported CHIRP logs (plan V2-E protocol). The logs are grouped by their
 * logged tune; the most recently imported tune is the candidate (what was applied), the tune
 * imported before it the baseline, a second baseline log the repeat that sets the tolerance.
 * For each axis whose PIDs differ and that has a qualified sweep in both, the baseline plant
 * predicts the candidate's closed loop, which buildVerifiedTune compares with the candidate's
 * measured one. Only real log analyses go in; the verdict is the producer's.
 */

import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import {
    buildVerifiedTune,
    type AxisInput,
    type LoggedPids,
    type VerifiedTune,
} from "@/gyrocore/releaseGate/verifiedTune";
import { analyzeAxisController, flightMask, type AutotuneLogInput } from "./autotuneV2";
import { buildAxisLoop } from "./loopModel";
import { bestLog, groupByTune } from "./logInput";

const AXES = ["roll", "pitch", "yaw"] as const;

function pids(log: AutotuneLogInput): Record<(typeof AXES)[number], LoggedPids> {
    const h = new Map(log.headerPairs.map(([k, v]) => [k, v]));
    const nums = (k: string) => (h.get(k) ?? "").split(",").map((v) => Number(v.trim()));
    const ff = nums("ff_weight");
    return Object.fromEntries(
        AXES.map((a, i) => {
            const [p, ii, d] = nums(`${a}PID`);
            return [a, { p, i: ii, d, f: ff[i] ?? 0 }];
        }),
    ) as Record<(typeof AXES)[number], LoggedPids>;
}

export interface VerifiedTuneAttempt {
    record: VerifiedTune | null;
    reasons: string[];
}

export function verifiedTuneFromLogs(logs: AutotuneLogInput[], createdAt?: string): VerifiedTuneAttempt {
    const groups = groupByTune(logs);
    if (groups.length < 2) {
        return {
            record: null,
            reasons: [
                "verified_tune:needs_two_tunes",
                "required_measurement:gain_change_chirp_flight_plus_baseline_repeat",
            ],
        };
    }
    const candidate = bestLog(groups[0]);
    const baseGroup = groups[1];
    const baseline = bestLog(baseGroup);
    const repeat = baseGroup.find((l) => l !== baseline) ?? null;
    const idB = logIdentity(baseline.headerPairs);
    const idC = logIdentity(candidate.headerPairs);
    const reasons: string[] = [];
    if (!idB.uid || !idC.uid || idB.uid.some((w, i) => w !== idC.uid![i]))
        reasons.push("verified_tune:logs_of_different_crafts");
    if (idB.board !== idC.board) reasons.push("verified_tune:logs_of_different_boards");
    if (idB.firmwareRevision !== idC.firmwareRevision) reasons.push("verified_tune:logs_of_different_firmware");
    if (reasons.length) return { record: null, reasons };

    const pb = pids(baseline);
    const pc = pids(candidate);
    const axes: Partial<Record<(typeof AXES)[number], AxisInput>> = {};
    const hb = Object.fromEntries(baseline.headerPairs);
    const hc = Object.fromEntries(candidate.headerPairs);
    AXES.forEach((name, i) => {
        const axis = i as 0 | 1 | 2;
        const cb = baseline.chirp[name];
        const cc = candidate.chirp[name];
        if (!cb || !cc || cb.state === "rejected" || cc.state === "rejected") return;
        const b = analyzeAxisController(baseline, hb, axis, cb, flightMask(baseline.channels.rcThrottle));
        const c = analyzeAxisController(candidate, hc, axis, cc, flightMask(candidate.channels.rcThrottle));
        if (!b || !c) return;
        const rep = repeat?.chirp[name];
        axes[name] = {
            plant: buildAxisLoop(axis, cb.tf, b.cfg, null, false, false).plant,
            baselineCfg: b.cfg,
            candidateCfg: c.cfg,
            candidateT: cc.tf,
            ...(rep && rep.state !== "rejected" ? { baselineRepeatT: rep.tf } : {}),
        };
    });
    const record = buildVerifiedTune({
        craft: { uid: idB.uid!, board: idB.board ?? "", firmware: idB.firmwareRevision?.split(/\s+/)[1] ?? "" },
        baseline: {
            sha256: baseline.sha256,
            logIndex: baseline.logIndex,
            pids: pb,
            values: loggedAbsoluteValues(baseline.headerPairs),
        },
        candidate: {
            sha256: candidate.sha256,
            logIndex: candidate.logIndex,
            pids: pc,
            values: loggedAbsoluteValues(candidate.headerPairs),
        },
        ...(repeat ? { baselineRepeat: { sha256: repeat.sha256, logIndex: repeat.logIndex } } : {}),
        axes,
        createdAt,
    });
    // Informational: without a repeat the tolerance falls back to the M5-A floors.
    if (!repeat) reasons.push("verified_tune:no_baseline_repeat_m5a_floors_used");
    return { record, reasons: [...record.reasons, ...reasons] };
}

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
 * One plain sentence per session decision (block 14). The rule names are decision.ts', stepPolicy.ts' and session.ts';
 * the numbers come from the decision's own checks. Locale keys gyroflightSitlWhy_<rule> with $1 = axis or motor,
 * $2 = the check's detail; an unknown rule falls back to its name.
 */

import type { Decision } from "./decision";
import type { StepRecord, StopReason } from "./session";

export interface WhyLine {
    key: string;
    params: string[];
    rule: string;
}

/** "G1_motor_vs_accepted:m2" → key gyroflightSitlWhy_G1_motor_vs_accepted, $1 "m2". */
export function whyOf(rule: string, decision: Decision | null): WhyLine {
    const [name, where = ""] = rule.split(":");
    const check = decision?.checks.find((c) => c.rule === rule);
    const vsStart = name.endsWith("_vs_start");
    const detail = check?.detail ?? rule.split(":").slice(2).join(":");
    return {
        key: `gyroflightSitlWhy_${vsStart ? name.slice(0, -"_vs_start".length) : name}`,
        params: [where, vsStart ? `against the start tune: ${detail}` : detail],
        rule,
    };
}

/** The lines explaining a step's verdict: the failing rules, or the improvement that held. */
export function stepWhy(s: StepRecord): WhyLine[] {
    if (s.verdict === "ABORTED") return [{ key: "gyroflightSitlWhy_aborted", params: ["", ""], rule: "aborted" }];
    if (s.verdict === "INVALID")
        return s.reasons
            .slice(0, 4)
            .map((r) =>
                r === "readback_mismatch"
                    ? { key: "gyroflightSitlWhy_readback_mismatch", params: ["", ""], rule: r }
                    : { key: "gyroflightSitlWhy_invalid", params: ["", r.replace(/^invalid:/, "")], rule: r },
            );
    return s.reasons.map((r) => whyOf(r, s.decision));
}

export function stopKey(r: StopReason): string {
    return `gyroflightSitlStop_${r}`;
}

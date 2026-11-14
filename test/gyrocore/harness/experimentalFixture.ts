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
 * A hand-built EXPERIMENTAL proposal (engine/experimentalProposal.ts shape) whose log headers name
 * the simulated AIR65 firmware of harness/mspFirmware.ts: an unqualified but computable change
 * (margins MEASURED, no Verified Tune, nothing VALIDATED) for the write-route and panel tests.
 * SIMULATION ONLY.
 */

import type { AbsoluteProposal } from "../../../src/gyrocore/releaseGate/releaseContract";
import type { AbsoluteValues } from "../../../src/gyrocore/tuning/absoluteTune";
import type { ExperimentalProposal } from "../../../src/gyrocore/engine/experimentalProposal";
import { air65FirmwareState, type FirmwareState } from "./mspFirmware";

export function headersFor(s: FirmwareState): [string, string][] {
    const p = s.p;
    return [
        ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
        ["Board information", "BEFH BETAFPVG473"],
        ["DeviceUID", "0a1b2c3d4e5f607112233445"],
        ["rollPID", s.pids[0].join(",")],
        ["pitchPID", s.pids[1].join(",")],
        ["yawPID", s.pids[2].join(",")],
        ["ff_weight", `${p.f_roll},${p.f_pitch},${p.f_yaw}`],
        ["d_max", `${p.d_max_roll},${p.d_max_pitch},${p.d_max_yaw}`],
        ["d_max_gain", String(p.d_max_gain)],
        ["gyro_lpf1_static_hz", String(p.gyro_lpf1_static_hz)],
        ["gyro_lpf1_dyn_hz", `${p.gyro_lpf1_dyn_min_hz},${p.gyro_lpf1_dyn_max_hz}`],
        ["dterm_lpf1_static_hz", String(p.dterm_lpf1_static_hz)],
        ["dterm_lpf1_dyn_hz", `${p.dterm_lpf1_dyn_min_hz},${p.dterm_lpf1_dyn_max_hz}`],
        ["dyn_notch_count", String(p.dyn_notch_count)],
        ["dyn_notch_q", String(p.dyn_notch_q)],
        ["rpm_filter_harmonics", String(p.rpm_filter_harmonics)],
        ["rpm_filter_q", String(p.rpm_filter_q)],
        ["rpm_filter_weights", s.rpmWeights.join(",")],
    ];
}

/** An unqualified but computable change: margins MEASURED, no Verified Tune, nothing VALIDATED. */
export const EXPERIMENTAL_CHANGE: AbsoluteValues = { p_roll: 60, d_roll: 32, dterm_lpf1_static_hz: 80 };

export function experimentalFixture(
    change: AbsoluteValues = EXPERIMENTAL_CHANGE,
    opts: { withheld?: string[]; state?: FirmwareState; measurementValid?: boolean } = {},
): ExperimentalProposal {
    const state = opts.state ?? air65FirmwareState();
    const logged = Object.fromEntries(
        Object.keys(change).map((k) => [k, k === "p_roll" ? 56 : k === "d_roll" ? 30 : 75]),
    );
    const items = Object.entries(change).map(([key, to]) => ({
        key,
        part: key.startsWith("dterm") ? ("dterm_filter" as const) : ("pid" as const),
        from: logged[key],
        to,
        status: "BLOCKED" as const,
        reasons: ["margins:evidence_measured", "required_measurement:chirp_finer_resolution_model_class_qualification"],
    }));
    const proposal: AbsoluteProposal = {
        id: `v2x-${Object.entries(change).join("|")}`,
        createdAt: "2026-11-03T00:00:00Z",
        log: { sha256: "b".repeat(64), logIndex: 0, headerPairs: headersFor(state) },
        change: { ...change },
        items,
        release: {
            measurement: { valid: opts.measurementValid ?? true, reasons: [] },
            model: { status: "PARTIAL", reasons: ["cross_log_plant_untested:roll"] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "not_available",
            safetyReasons: ["dynamic_margins:margins_not_validated:roll"],
        },
    };
    return {
        status: "EXPERIMENTAL",
        proposal,
        items: items.map((i) => ({
            ...i,
            source: "primary_route" as const,
            evidence: "MEASURED",
            qualificationGaps: i.reasons,
        })),
        withheld: (opts.withheld ?? []).map((key) => ({
            key,
            part: "pid" as const,
            source: "primary_route" as const,
            reasons: ["no_candidate_meets_all_targets"],
        })),
        qualificationGaps: ["margins:evidence_measured"],
        limitations: ["experimental:not_releasable", "experimental:not_hardware_validated"],
        hardwareValidated: false,
    };
}

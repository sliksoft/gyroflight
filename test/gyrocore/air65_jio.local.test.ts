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
 * The experimental CHIRP + JIO route on the AIR65 CHIRP logs (local only; needs
 * GYROFLIGHT_AIR65_BBL18/19, hashes checked). Asserted are the facts the data support and the
 * invariants the route must keep: it never releases, and the primary route is unchanged by it.
 * The full JIO block goes to GYROFLIGHT_QUAL_OUT for the report.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { runAutotuneV2, type AutotuneLogInput, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";

const FILES = {
    bbl18: {
        path: process.env.GYROFLIGHT_AIR65_BBL18,
        sha256: "dfe82bca2aaabbc2f53a20a93756137546cc648196226af622d43874eed7efcb",
    },
    bbl19: {
        path: process.env.GYROFLIGHT_AIR65_BBL19,
        sha256: "4dd55164ddadb529816d52c3709376defe265cf2efdd6b8c31738bd3b26361c7",
    },
};
const present = Object.values(FILES).every((f) => !!f.path && existsSync(f.path));

function load(key: keyof typeof FILES): AutotuneLogInput[] {
    const f = FILES[key];
    const bytes = new Uint8Array(readFileSync(f.path!));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe(f.sha256);
    return buildLogInputs(bytes, sha, qualifyChirpFile(bytes, key, 45, AUTOTUNE_MATH), analyzeM4BblFile(bytes, key));
}

function strip(r: AutotuneV2Result) {
    return {
        pid: r.pid,
        margins: r.margins,
        proposal: r.proposal,
        releasable: r.releasableProposal,
        parts: r.parts,
        safety: r.safety,
    };
}

function jioSummary(r: AutotuneV2Result) {
    const j = r.jio;
    return {
        status: j.status,
        firmware: j.analysis.firmwareRevision,
        blockers: j.analysis.blockers,
        sweep: j.analysis.sweep,
        amplitudes: j.analysis.amplitudesDegS,
        requiredMeasurements: j.requiredMeasurements,
        mimo: j.analysis.mimo,
        axes: Object.values(j.analysis.axes).map((a) => ({
            axis: a.axis,
            records: a.records.map((x) => ({
                id: x.id,
                occurrence: x.occurrence,
                used: x.used,
                flags: x.flags,
                notes: x.notes,
                excitedS: x.excitedS,
                reachedHz: x.reachedHz,
                incomplete: x.incomplete,
                frequencyCheck: x.frequencyCheck,
                recordS: x.recordS,
                rPeakDegS: x.rPeakDegS,
                uRms: x.uRms,
            })),
            sweeps: a.sweeps,
            repeats: a.repeats,
            grid: a.grid,
            band: a.band,
            reasons: a.reasons,
            blockers: a.blockers,
            controllerModelAgreement: a.controllerModelAgreement,
            sweepAdvice: a.sweepAdvice,
            coherenceProfile: a.points
                ? Array.from({ length: 17 }, (_, k) => {
                      const lo = 10 * k;
                      const ru: number[] = [];
                      const ry: number[] = [];
                      for (let i = 0; i < a.points!.frequencyHz.length; i++) {
                          const f = a.points!.frequencyHz[i];
                          if (f >= lo && f < lo + 10) {
                              ru.push(a.points!.coherenceRu[i]);
                              ry.push(a.points!.coherenceRy[i]);
                          }
                      }
                      const med = (v: number[]) => (v.length ? [...v].sort((x, y) => x - y)[v.length >> 1] : null);
                      return [lo, med(ru), med(ry)];
                  })
                : null,
        })),
        crossFlight: j.crossFlight,
        progress: j.progress,
        chain: Object.values(j.chain).map((c) => ({
            axis: c.axis,
            tuningComputable: c.tuningComputable,
            reasons: c.reasons,
            crossoverHz: c.margins?.crossoverHz ?? null,
            phaseMarginDeg: c.margins?.phaseMarginDeg ?? null,
            measured: c.margins?.measured ?? null,
            evidence: c.margins?.evidence.level ?? null,
            marginStatus: c.margins?.status ?? null,
            candidate: c.candidate
                ? {
                      status: c.candidate.status,
                      outcome: c.candidate.outcome,
                      proposed: c.candidate.proposed,
                      reasons: c.candidate.reasons.slice(0, 8),
                  }
                : null,
            planBand: c.plan?.bandHz ?? null,
            planRequired: c.plan?.requiredMeasurements ?? null,
        })),
    };
}

describe.skipIf(!present)("AIR65 CHIRP + JIO route (local)", () => {
    const logs18 = present ? load("bbl18") : [];
    const logs19 = present ? load("bbl19") : [];

    it.each([
        ["bbl18", logs18],
        ["bbl19", logs19],
    ])(
        "%s: the route runs on the real log, releases nothing and leaves the primary route unchanged",
        (name, logs) => {
            const log = logs[0];
            expect(log.channels.jio?.axisP).not.toBeNull();
            expect(log.channels.jio?.debugAxis).not.toBeNull();
            expect(log.sweeps?.length).toBeGreaterThanOrEqual(3);
            const r = runAutotuneV2({ primary: log, others: [], verifiedTune: null });
            const j = r.jio;
            const out = process.env.GYROFLIGHT_QUAL_OUT;
            if (out) {
                mkdirSync(out, { recursive: true });
                writeFileSync(path.join(out, `air65_jio_${name}.json`), JSON.stringify(jioSummary(r), null, 1));
            }
            expect(j.diagnosticOnly).toBe(true);
            expect(j.analysis.blockers).toEqual([]);
            expect(j.analysis.firmwareRevision).toContain("Betaflight 2026.6.2");
            expect(j.analysis.amplitudesDegS).toEqual([230, 230, 180]);
            for (const axis of ["roll", "pitch", "yaw"] as const) {
                const a = j.analysis.axes[axis]!;
                expect(a.records.length).toBeGreaterThanOrEqual(1);
                // One sweep per axis on these flights: repeatability unknown, never claimed.
                expect(a.repeats.consistency).toBe("unknown");
                expect(a.band).not.toBeNull();
                // The high band is mostly unsupported on these flights (gyro response small against the noise):
                // fewer than a quarter of the points above 160 Hz pass.
                const hi = Array.from(a.points!.frequencyHz)
                    .map((f, i) => [f, a.points!.supported[i]] as const)
                    .filter(([f]) => f > 160);
                expect(hi.filter(([, s]) => s).length).toBeLessThan(hi.length / 4);
                const c = j.chain[axis]!;
                expect(c.margins?.status ?? "UNAVAILABLE").not.toBe("VALIDATED");
                expect(c.candidate?.status ?? "BLOCKED").not.toBe("VALIDATED");
                expect(c.reasons).toContain("stationarity_unknown:single_sweep");
            }
            expect(j.requiredMeasurements.some((m) => m.includes("repeated_sweep_for_stationarity"))).toBe(true);
            // Block 4: debug[2] of this firmware follows the law within tolerance on every axis (a fact of
            // the data; the max error is a quantisation plus pow_approx effect, far under 1 %).
            for (const axis of ["roll", "pitch", "yaw"] as const) {
                const fc = j.analysis.axes[axis]!.records[0].frequencyCheck;
                expect(fc.status).toBe("ok");
                expect(fc.samples).toBeGreaterThan(60_000);
                expect(fc.outOfTolerance).toBe(0);
                expect(fc.maxAbsErrorHz!).toBeLessThan(0.5);
            }
            expect(j.analysis.limitations.some((l) => l.startsWith("frequency_verification_missing"))).toBe(false);
            // Block 4: each axis on its own record (bbl19: pitch 17.2 s and yaw 17.9 s no longer clip roll's 19.8 s).
            if (name === "bbl19") {
                expect(j.analysis.axes.roll!.records[0].recordS).toBeGreaterThan(19);
                expect(j.analysis.axes.roll!.band!.analysedHz[1]).toBeGreaterThan(500);
                expect(j.analysis.axes.pitch!.grid!.stepHz).toBeGreaterThan(j.analysis.axes.roll!.grid!.stepHz);
                expect(j.analysis.mimo?.notes.some((x) => x.startsWith("grids_matched_nearest:"))).toBe(true);
            }
            // Completeness as the logs have it (block 3): bbl18's sweeps ran to the header's 20 s; on bbl19
            // the pilot ended CHIRP mode on pitch (17.2 s) and yaw (17.8 s) before the generator finished,
            // so those registrations ended early and are analysed only to the frequency they reached.
            for (const axis of ["roll", "pitch", "yaw"] as const) {
                const a = j.analysis.axes[axis]!;
                const rec = a.records[0];
                expect(a.sweeps.present).toBe(a.records.length);
                expect(a.sweeps.usable).toBe(a.records.filter((x) => x.used).length);
                if (name === "bbl18" || axis === "roll") {
                    expect(rec.incomplete).toBeNull();
                    expect(rec.excitedS).toBeGreaterThan(0.98 * 20);
                    expect(a.sweeps.complete).toBe(1);
                    expect(j.requiredMeasurements).not.toContain(`required_measurement:chirp_${axis}_complete_sweep`);
                } else {
                    expect(rec.incomplete).toBe("registration_ended_early");
                    expect(rec.excitedS).toBeLessThan(0.98 * 20);
                    expect(rec.reachedHz!).toBeGreaterThan(150);
                    expect(rec.reachedHz!).toBeLessThan(300);
                    // The window (common record length 16.9 s) reaches less than the sweep did.
                    expect(a.band!.analysedHz[1]).toBeLessThanOrEqual(rec.reachedHz!);
                    expect(a.band!.analysedHz[1]).toBeGreaterThan(150);
                    expect(a.sweeps.complete).toBe(0);
                    expect(j.requiredMeasurements).toContain(`required_measurement:chirp_${axis}_complete_sweep`);
                }
                // Progress mirrors the analysis and carries only this axis's own needs.
                const p = j.progress[axis]!;
                expect(p.sweeps).toMatchObject({ present: a.sweeps.present, complete: a.sweeps.complete });
                expect(p.withinFlight.repeats).toBe(a.repeats.count);
                expect(p.nextSteps.every((n) => n.includes(`chirp_${axis}_`))).toBe(true);
                expect(p.bandHz.tuningGoal).toEqual(j.chain[axis]!.plan?.bandHz.primary ?? null);
                expect(a.sweepAdvice!.tuningBandHz).toEqual(p.bandHz.tuningGoal);
            }
            // The primary route with and without the JIO channels is identical, and still releases nothing.
            const without = runAutotuneV2({
                primary: { ...log, channels: { ...log.channels, jio: null }, sweeps: [] },
                others: [],
                verifiedTune: null,
            });
            expect(strip(r)).toEqual(strip(without));
            expect(r.releasableProposal).toBeNull();
        },
        300_000,
    );

    it("bbl18 with bbl19 as the other flight: the cross-flight verdict is explicit, nothing is averaged", () => {
        const a = logs18[0];
        const b = logs19[0];
        const r = runAutotuneV2({ primary: a, others: [b], verifiedTune: null });
        const alone = runAutotuneV2({ primary: a, others: [], verifiedTune: null });
        const out = process.env.GYROFLIGHT_QUAL_OUT;
        if (out) {
            mkdirSync(out, { recursive: true });
            writeFileSync(path.join(out, "air65_jio_bbl18_with_bbl19.json"), JSON.stringify(jioSummary(r), null, 1));
        }
        expect(r.jio.crossFlight.candidates).toHaveLength(1);
        const c = r.jio.crossFlight.candidates[0];
        expect(c.sha256).toBe(FILES.bbl19.sha256);
        // Facts of this pair (18 and 19 October 2026): the same craft, firmware, configuration and sweep
        // settings on two independent flights — a comparable repeat; bbl19's clipped record gives a
        // coarser grid (step ratio 1.17), matched point by point. The closed-loop z stays below the
        // experimental threshold on every axis (recorded here as a fact of the data, not a validation).
        expect(c.issues).toEqual([]);
        expect(c.usable).toBe(true);
        // Compatibility keys these logs do not carry are named as not compared, never as a difference:
        // anti_gravity_mode/threshold (not in firmware 43875a55a) and, on this G473 build, the tpa_curve_*
        // and tpa_speed_* lines (blackbox.c writes them only when the build has them); tpa_mode/rate/
        // breakpoint and tpa_low_* are logged and equal.
        // Block 4: the log names firmware 43875a55a, where these two settings provably do not exist.
        expect(c.notes).toContain("setting_not_in_firmware:anti_gravity_mode:43875a55a");
        expect(c.notes).toContain("setting_not_in_firmware:anti_gravity_threshold:43875a55a");
        expect(c.notes.some((n) => n.startsWith("setting_not_logged_in_either:anti_gravity_"))).toBe(false);
        expect(c.notes).toContain("setting_not_logged_in_either:tpa_curve_type");
        // The notch headers are logged (0) on both flights: compared equal, not noted.
        expect(c.notes.some((n) => /notch/.test(n))).toBe(false);
        expect(c.issues.some((i) => /notch/.test(i))).toBe(false);
        expect(c.notes.some((n) => /:(tpa_mode|tpa_rate|tpa_breakpoint|tpa_low_rate|anti_gravity_gain)$/.test(n))).toBe(
            false,
        );
        expect(c.issues.some((i) => i.startsWith("jio_cross_flight_setting_differs"))).toBe(false);
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            const ax = c.axes[axis]!;
            expect(ax.matchedPoints).toBeGreaterThanOrEqual(30);
            // Block 4: each axis on its own record; bbl19's roll (19.8 s) now matches bbl18's grid
            // closely, pitch (17.2 s) and yaw (17.9 s) are coarser and matched point by point.
            if (axis === "roll") expect(ax.reasons.some((x) => x.startsWith("grids_incomparable"))).toBe(false);
            else expect(ax.reasons.some((x) => x.startsWith("grid_matched_nearest:step_ratio:1.1"))).toBe(true);
            expect(ax.reasons.some((x) => x.startsWith("plant_z:"))).toBe(true);
            expect(ax.z).not.toBeNull();
            expect(ax.z!).toBeLessThan(2);
            // bbl19's pitch and yaw sweeps are incomplete (block 3): their agreement with bbl18 is shown
            // (z) but is no reproducibility evidence; roll (complete on both) is.
            const expected = axis === "roll" ? "consistent" : "unknown";
            expect(ax.consistency).toBe(expected);
            if (axis !== "roll") expect(ax.reasons).toContain("incomplete_sweep_on:other:no_reproducibility_evidence");
            expect(
                r.jio.chain[axis]!.reasons.some((x) => x.startsWith(`cross_flight_repeat:${expected}:flights:1:z:`)),
            ).toBe(true);
            // Still one sweep in this log: the within-flight stationarity stays unknown and is said so.
            expect(r.jio.chain[axis]!.reasons).toContain("stationarity_unknown:single_sweep");
        }
        // Reproducibility is answered for roll only; stationarity within a sweep stays asked; band advice remains.
        expect(r.jio.requiredMeasurements.some((m) => m.includes("repeated_sweep_for_stationarity"))).toBe(true);
        expect(r.jio.requiredMeasurements).not.toContain(
            "required_measurement:chirp_roll_repeat_flight_for_reproducibility",
        );
        expect(r.jio.requiredMeasurements).toContain(
            "required_measurement:chirp_pitch_repeat_flight_for_reproducibility",
        );
        expect(r.jio.requiredMeasurements).toContain(
            "required_measurement:chirp_yaw_repeat_flight_for_reproducibility",
        );
        expect(r.jio.requiredMeasurements.some((m) => m.includes("repeat_flight_consistent"))).toBe(false);
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_band_matched_sweep");
        // The primary's own JIO estimate and the primary route are unchanged by the other log's presence.
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            expect(r.jio.analysis.axes[axis]!.points!.gRe).toEqual(alone.jio.analysis.axes[axis]!.points!.gRe);
            expect(r.jio.analysis.axes[axis]!.grid).toEqual(alone.jio.analysis.axes[axis]!.grid);
            expect(r.jio.chain[axis]!.candidate?.status ?? "BLOCKED").not.toBe("VALIDATED");
            expect(r.jio.analysis.axes[axis]!.sweepAdvice).not.toBeNull();
        }
        expect(r.releasableProposal).toBeNull();
    }, 600_000);
});

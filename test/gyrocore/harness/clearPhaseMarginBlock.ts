/*
 * This file is part of Gyroflight, a derivative of the Betaflight App.
 *
 * Test harness only: strip the GF-1 phase_margin_not_validated Apply block so
 * downstream gates (live recheck, coverage, tamper) can be exercised in isolation.
 * Production authorization always keeps that block while openLoopModel is unvalidated.
 */

import type { CompositeRecommendation } from "../../../src/gyrocore/tuning/composite";
import type { ChirpQualificationReport } from "../../../src/gyrocore/chirp/qualification";

const REASON = "phase_margin_not_validated";

/** Mutate report measurement apply blocks in place (log.measurements share these refs). */
export function clearPhaseMarginFromReport(report: ChirpQualificationReport): void {
    for (const m of report.measurements) {
        m.apply.blocked = m.apply.blocked.filter((r) => r !== REASON);
        m.apply.allowed = m.apply.blocked.length === 0;
    }
}

/** Mutate a standalone composite so phase_margin alone no longer denies authorization. */
export function clearPhaseMarginFromComposite(composite: CompositeRecommendation): void {
    composite.blocked = composite.blocked.filter((r) => r !== REASON);
    composite.authorized =
        composite.merge.status === "merged" && composite.final !== null && composite.blocked.length === 0;
}

/**
 * Clear the PM block on the live gate report and bump revision so the store's
 * computed composite matches what authorizeCompositeApply rebuilds (id hash
 * includes blocked[]).
 */
export function clearPhaseMarginForGate(gate: { report: ChirpQualificationReport | null; touch: () => void }): void {
    if (gate.report) {
        clearPhaseMarginFromReport(gate.report);
    }
    gate.touch();
}

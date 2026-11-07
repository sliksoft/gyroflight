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
 * SIMULATION ONLY. A VALIDATED AutotuneV2Result for software-contract write / release / Safety
 * suites that must not rely on a fictitious day-long qualification flight in a short window
 * (Codex review 2026-10-28, P2; planner safety repair open item 1).
 *
 * Production-pipeline qualification PASS at a resolution fine enough for a useful primary band
 * needs a sweep whose analysed window holds whole-segment dwell in every decision bin — hours for
 * AIR65-useful grids, beyond the Blackbox harness. This helper therefore attaches
 * `simulatedQualifiedEvidence` (marginEvidenceFixture) to an engine result computed without a
 * model-class qualification log. It is not flight evidence and never authorizes hardware use.
 */

import { runAutotuneV2, type AutotuneV2Input, type AutotuneV2Result } from "../../../src/gyrocore/engine/autotuneV2";
import { RELEASE_TARGETS, type AbsoluteProposal } from "../../../src/gyrocore/releaseGate/releaseContract";
import type { LoopMargins, MarginEvidence } from "../../../src/gyrocore/engine/loopModel";
import { simulatedQualifiedEvidence, SIMULATED_QUALIFICATION_SHA } from "./marginEvidenceFixture";

/** Software-contract margins that clear the release targets (write/Safety suites, not flight truth). */
const SOFT_PM = RELEASE_TARGETS.minPhaseMarginDeg + 10;
const SOFT_GM = RELEASE_TARGETS.minGainMarginDb + 3;
const SOFT_S = RELEASE_TARGETS.maxSensitivityPeakDb - 2;

function promoteEvidence(m: LoopMargins, sourceSha = SIMULATED_QUALIFICATION_SHA): LoopMargins {
    // Keep resolution / band from the engine; replace bound values with software-contract figures that
    // meet RELEASE_TARGETS. A short synthetic primary can leave yaw below target — that is not what
    // these write-authority suites are testing.
    const pm = SOFT_PM;
    const gm = SOFT_GM;
    const s = SOFT_S;
    const resolutionHz = m.evidence.resolutionHz ?? 0.5;
    const base = simulatedQualifiedEvidence(pm, gm, s, resolutionHz);
    const evidence: MarginEvidence = {
        ...base,
        bandHz: m.evidence.bandHz ?? base.bandHz,
        minFeatureWidthHz: m.evidence.minFeatureWidthHz ?? base.minFeatureWidthHz,
        assumptions: [...new Set([...(m.evidence.assumptions ?? []), ...base.assumptions])],
        qualification: base.qualification
            ? {
                  ...base.qualification,
                  source: { sha256: sourceSha, logIndex: 0 },
                  phaseMarginDeg: pm,
                  gainMarginDb: gm,
                  sensitivityPeakDb: s,
              }
            : base.qualification,
    };
    return {
        ...m,
        status: "VALIDATED",
        phaseMarginDeg: pm,
        gainMarginDb: gm,
        sensitivityPeakDb: s,
        evidence,
        reasons: [],
    };
}

function promoteProposal(p: AbsoluteProposal, sourceSha: string): AbsoluteProposal {
    const margins = p.release.margins.map((m) => {
        // AxisMargins carries the subset promoteEvidence needs (measured + evidence + bound fields).
        const asLoop = {
            ...m,
            crossoverHz: null,
            delayMarginMs: null,
            chainSpreadDeg: null,
            okBins: 0,
            measured: m.measured,
            evidence: m.evidence,
            reasons: m.reasons,
            status: m.status,
            phaseMarginDeg: m.phaseMarginDeg,
            gainMarginDb: m.gainMarginDb,
            sensitivityPeakDb: m.sensitivityPeakDb,
        } as LoopMargins;
        const promoted = promoteEvidence(asLoop, sourceSha);
        return {
            axis: m.axis,
            status: "VALIDATED" as const,
            phaseMarginDeg: promoted.phaseMarginDeg,
            gainMarginDb: promoted.gainMarginDb,
            sensitivityPeakDb: promoted.sensitivityPeakDb,
            measured: promoted.measured,
            evidence: promoted.evidence,
            reasons: [] as string[],
        };
    });
    return {
        ...p,
        items: p.items.map((it) => ({ ...it, status: "VALIDATED" as const, reasons: [] })),
        release: {
            ...p.release,
            margins,
            model: { status: "VALIDATED", reasons: [] },
            measurement: { valid: true, reasons: [] },
        },
    };
}

/**
 * Engine analysis without a model-class qualification log, then software-only VALIDATED evidence
 * for write-authority / Safety / release-contract suites.
 */
export function runSoftwareQualifiedAutotuneV2(input: AutotuneV2Input): AutotuneV2Result {
    const base = runAutotuneV2({ ...input, modelClassQualification: null });
    if (!base.proposal) {
        throw new Error("runSoftwareQualifiedAutotuneV2: engine produced no proposal to promote");
    }
    const sourceSha = SIMULATED_QUALIFICATION_SHA;
    const proposal = promoteProposal(base.proposal, sourceSha);
    const margins = { ...base.margins };
    for (const axis of Object.keys(margins) as (keyof typeof margins)[]) {
        const slot = margins[axis];
        if (!slot) continue;
        margins[axis] = {
            current: promoteEvidence(slot.current, sourceSha),
            proposed: promoteEvidence(slot.proposed, sourceSha),
        };
    }
    const pid = base.pid.map((p) => ({
        ...p,
        status: (p.changed ? "VALIDATED" : p.status) as typeof p.status,
        proposedMargins: promoteEvidence(p.proposedMargins, sourceSha),
        currentMargins: promoteEvidence(p.currentMargins, sourceSha),
        reasons: p.changed ? [] : p.reasons,
    }));
    const filters = base.filters.map((f) => ({
        ...f,
        status: (f.changed ? "VALIDATED" : f.status) as typeof f.status,
        reasons: f.changed ? [] : f.reasons,
    }));
    return {
        ...base,
        margins,
        pid,
        filters,
        proposal,
        releasableProposal: proposal,
    };
}

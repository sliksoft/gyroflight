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

// The composite lists a failed measurement as `system_id_unusable:<id>` followed by that
// measurement's own gate codes, after a bare `system_id_unusable` (GyroCore parity). Rendering
// those codes without the measurement printed "Low coherence: is --, below --." and "An axis has
// no usable measurement ;". These cases pin the sentences with the real English strings.

import { describe, expect, it, vi } from "vitest";
import en from "../../src/gyroflight/locales/en.json";

vi.mock("../../src/js/localization", () => ({
    i18n: {
        getMessage: (key: string, args: (string | number)[] = []) => {
            const msg = (en as Record<string, { message: string }>)[key]?.message;
            return msg ? msg.replace(/\$(\d)/g, (_m, n) => String(args[Number(n) - 1] ?? "")) : key;
        },
    },
}));

const { describeCompositeReason, describeCompositeReasons } = await import("../../src/gyrocore/tuning/reasons");

const measurement = {
    id: "log1-seg2",
    quality: {
        gates: [
            {
                code: "low_coherence",
                passed: false,
                severity: "error",
                value: 0.4,
                threshold: 0.6,
                detail: "mean coherence over 5-100 Hz",
            },
        ],
    },
    spacing: { gapCount: 40 },
    sampleRate: { status: "ok", effectiveRateHz: 4000 },
} as never;

describe("composite reasons render without placeholders", () => {
    it("gives the bare system_id_unusable its own sentence", () => {
        const text = describeCompositeReason("system_id_unusable");
        expect(text).toBe(en.gyrocoreGlobal_system_id_unusable_any.message);
        expect(text).not.toMatch(/ ;|--/);
        expect(describeCompositeReason("system_id_unusable:log1-seg2")).toContain("log1-seg2");
    });

    it("fills a measurement's gate codes with its values", () => {
        const codes = [
            "system_id_unusable",
            "system_id_unusable:log1-seg2",
            "measurement:low_coherence",
            "phase_margin_not_validated",
        ];
        const texts = describeCompositeReasons(codes, (id) => (id === "log1-seg2" ? measurement : null));
        expect(texts[2]).toContain("0.40");
        expect(texts[2]).toContain("0.60");
        expect(texts[2]).not.toContain("--");
        // A code after a non-measurement code no longer borrows the measurement.
        expect(
            describeCompositeReasons(["phase_margin_not_validated", "measurement:low_coherence"], () => measurement)[1],
        ).toContain("--");
    });

    it("without a measurement the old fallback stays visible as such", () => {
        expect(describeCompositeReason("measurement:low_coherence")).toContain("--");
    });
});

/*
 * Gyroflight branding/fork-surface regression tests.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GYROFLIGHT_COLOR_THEME } from "../../src/gyroflight/policy";

const repoRoot = path.resolve(__dirname, "../..");

describe("Gyroflight product surface", () => {
    it("uses the GyroCore cyan accent as the product theme", () => {
        const css = fs.readFileSync(path.join(repoRoot, "src/gyroflight/theme.css"), "utf8");
        expect(GYROFLIGHT_COLOR_THEME).toBe("gyroflight");
        expect(css).toContain("#22d3ee");
        expect(css).toContain('body[data-theme="gyroflight"]');
    });

    it("supplies a product-owned landing without sponsor content", () => {
        const productLanding = fs.readFileSync(
            path.join(repoRoot, "src/gyroflight/tabs/GyroflightLandingTab.vue"),
            "utf8",
        );
        expect(productLanding).toContain("GYRO");
        expect(productLanding).toContain("gyroflightHomeAutotuneText");
        expect(productLanding).not.toContain("SponsorTile");
    });

    it("keeps the upstream landing component in the repository", () => {
        expect(fs.existsSync(path.join(repoRoot, "src/components/tabs/LandingTab.vue"))).toBe(true);
    });
});

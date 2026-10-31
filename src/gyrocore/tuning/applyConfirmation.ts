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
 * The user's confirmation of one exact write, as a single-use token.
 *
 * The interface issues a token only after the user has seen the full change and
 * confirmed it; useTuneApply.ts consumes it before any flight-controller access.
 * A token is bound to what was shown (the composite and its sliders, or the backup
 * to restore), is used once and expires, so no code path writes without a fresh,
 * matching confirmation.
 */

import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";

export const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

export type ConfirmationSubject =
    | {
          kind: "apply";
          compositeId: string;
          sliders: Record<string, number>;
          /** snapshotHash of the read-only preview the user saw (useTuneApply.previewTune). */
          preview: string;
      }
    | {
          kind: "absolute";
          proposalId: string;
          /** The absolute values the user confirmed, by CLI name. */
          change: Record<string, number>;
          /** absoluteHash of the read-only preview the user saw (useTuneApply.previewAbsoluteTune). */
          preview: string;
      }
    | {
          kind: "restore";
          backupId: string;
          /** restoreHash of the read-only preview the user saw: the craft's tune then and the backup's target. */
          preview: string;
      };

/** What the route itself knows before it has read the craft: the subject without the preview hash. */
export type ConfirmationRequest =
    | Omit<Extract<ConfirmationSubject, { kind: "apply" }>, "preview">
    | Omit<Extract<ConfirmationSubject, { kind: "absolute" }>, "preview">
    | Omit<Extract<ConfirmationSubject, { kind: "restore" }>, "preview">;

interface Issued {
    subject: ConfirmationSubject;
    issuedAt: number;
}

const issued = new Map<string, Issued>();

function sameSubject(a: ConfirmationSubject, b: ConfirmationRequest): boolean {
    if (a.kind === "apply" && b.kind === "apply") {
        const keys = new Set([...Object.keys(a.sliders), ...Object.keys(b.sliders)]);
        return a.compositeId === b.compositeId && [...keys].every((k) => a.sliders[k] === b.sliders[k]);
    }
    if (a.kind === "absolute" && b.kind === "absolute") {
        const keys = new Set([...Object.keys(a.change), ...Object.keys(b.change)]);
        return a.proposalId === b.proposalId && [...keys].every((k) => a.change[k] === b.change[k]);
    }
    if (a.kind === "restore" && b.kind === "restore") {
        return a.backupId === b.backupId;
    }
    return false;
}

function newToken(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Call only after the user confirmed exactly this subject in the interface. */
export function issueConfirmation(subject: ConfirmationSubject, now = Date.now()): string {
    const token = newToken();
    issued.set(token, { subject: structuredClone(subject), issuedAt: now });
    return token;
}

/**
 * Throws unless `token` confirms exactly `subject` and carries the hash of the preview the user saw
 * (the hash itself is compared by the caller once it has recomputed the preview: every route
 * refuses when it differs). Returns what was confirmed. A token is spent even when it does not match.
 */
export function consumeConfirmation(
    token: string | null | undefined,
    subject: ConfirmationRequest,
    now = Date.now(),
): ConfirmationSubject {
    if (!token) {
        throw new ApplyBlockedError(["apply:confirmation_missing"]);
    }
    const entry = issued.get(token);
    issued.delete(token);
    if (!entry) {
        throw new ApplyBlockedError(["apply:confirmation_unknown_or_used"]);
    }
    if (now - entry.issuedAt > CONFIRMATION_TTL_MS) {
        throw new ApplyBlockedError(["apply:confirmation_expired"]);
    }
    if (!sameSubject(entry.subject, subject)) {
        throw new ApplyBlockedError(["apply:confirmation_mismatch"]);
    }
    // A confirmation of no particular preview binds nothing the craft holds: never a write.
    if (typeof entry.subject.preview !== "string" || !entry.subject.preview) {
        throw new ApplyBlockedError(["apply:confirmation_without_preview"]);
    }
    return entry.subject;
}

/** Test helper: forget every issued token. */
export function resetConfirmations(): void {
    issued.clear();
}

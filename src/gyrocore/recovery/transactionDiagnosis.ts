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
 * Read-only diagnosis of the uncertain write entries of a craft (audit WP8-F07). For each entry it
 * says what is unknown, which in-app recovery could prove the craft's state again (a verified
 * Restore that covers it, the read-only check) or that none can, and what to do next. It reads
 * this browser's storage and the Web Locks state only: it changes no entry, sends nothing to the
 * flight controller, and is never itself evidence of recovery. A reboot, a reconnect, time, or one
 * matching read-back of one profile clear nothing (fcTransactionState.ts).
 *
 * "No owner" means no page of this origin holds the transaction lock now, so the writer of an
 * "in_progress" entry is gone (its page closed or crashed). That makes it an orphan, not a known
 * state: the write may have stopped anywhere, a profile switch it ran into was never recorded, so
 * no Restore covers it.
 */

import { FC_WRITE_LOCK } from "@/composables/fcWriteGuard";
import type { UncertainTransaction } from "@/gyrocore/stores/transactionRecords";
import { restoreTargetIssue, type TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { absoluteSnapshotIssues } from "@/gyrocore/tuning/absoluteTune";

export type DiagnosisFinding =
    | "orphaned_in_progress"
    | "in_progress_owner_active"
    | "in_progress_owner_unknown"
    | "backup_missing"
    | "eeprom_state_unknown"
    | "eeprom_saved_adjusted"
    | "profile_scope_unknown"
    | "profiles_several"
    | "profile_switch_seen"
    | "interrupted_restore"
    | "blocked_by_other_entry";

/**
 * Which in-app step can prove this entry's craft state again: a verified Restore by the same route
 * of its one profile ("verified_restore", only when such a trusted backup is stored), the read-only
 * check ("read_only_check"), or none ("none": the block stays; see the next steps).
 */
export type RecoveryAvailability = "verified_restore" | "read_only_check" | "none";

export interface EntryDiagnosis {
    entry: UncertainTransaction;
    findings: DiagnosisFinding[];
    recovery: RecoveryAvailability[];
    /** i18n keys, in order. */
    nextSteps: string[];
}

export interface DiagnosisContext {
    /** The stored backups of this craft. */
    backups: readonly TuneBackup[];
    /** Whether a page of this origin holds the transaction lock now; null when that cannot be read. */
    ownerActive: boolean | null;
}

const isAbsolute = (a: UncertainTransaction["action"]) => a === "absolute_apply" || a === "absolute_restore";

/** A single PID profile switch the entry's detail records (the routes' `fc:pid_profile_changed:a->b`). */
const profileSwitchSeen = (detail: string | undefined) => /fc:pid_profile_changed:/.test(detail ?? "");

/** What is unknown about `e`, which recovery can prove it, and what to do. Pure. */
export function diagnoseEntry(e: UncertainTransaction, ctx: DiagnosisContext): EntryDiagnosis {
    const findings: DiagnosisFinding[] = [];
    const inProgress = e.stage === "in_progress";
    if (inProgress) {
        if (ctx.ownerActive === false) findings.push("orphaned_in_progress");
        else if (ctx.ownerActive === true) findings.push("in_progress_owner_active");
        else findings.push("in_progress_owner_unknown");
    }
    const backup = ctx.backups.find((b) => b.id === e.backupId);
    if (!backup) findings.push("backup_missing");
    if (e.saved === "unknown") findings.push("eeprom_state_unknown");
    if (e.saved === "yes_adjusted") findings.push("eeprom_saved_adjusted");
    const oneProfile = Array.isArray(e.profiles) && e.profiles.length === 1;
    if (!Array.isArray(e.profiles)) findings.push("profile_scope_unknown");
    else if (e.profiles.length !== 1) findings.push("profiles_several");
    if (profileSwitchSeen(e.detail)) findings.push("profile_switch_seen");
    if (e.action === "restore" || e.action === "absolute_restore") findings.push("interrupted_restore");

    const recovery: RecoveryAvailability[] = [];
    // fcTransactionState.coveredBy (ended, one known profile, same route) and what the absolute
    // Restore accepts as its target (readAbsoluteRestoreTarget: trusted, valid, that profile's). A
    // slider-route entry names no profile it could be restored into: never offered.
    const profile = oneProfile ? e.profiles![0] : null;
    const trustedTarget =
        isAbsolute(e.action) &&
        ctx.backups.some(
            (b) =>
                restoreTargetIssue(b) === null &&
                !!b.absolute &&
                b.absolute.pidProfile === profile &&
                absoluteSnapshotIssues(b.absolute).length === 0,
        );
    if (!inProgress && oneProfile && trustedTarget) recovery.push("verified_restore");
    // checkTransactionState: EEPROM not written, one profile, no switch seen, its backup stored.
    if (!inProgress && e.saved === "no" && oneProfile && !profileSwitchSeen(e.detail) && backup) {
        recovery.push("read_only_check");
    }
    if (!recovery.length) recovery.push("none");
    return diagnoseEntryFrom({ entry: e, findings, recovery, nextSteps: [] }, recovery);
}

/**
 * Every open entry of one craft. A Restore runs only while every entry of the craft is one it covers
 * (same route, the one profile it restores), and the read-only check resolves only when every entry
 * passes: an in-app recovery that does not cover them all is not available for any of them.
 */
export function diagnoseCraft(entries: readonly UncertainTransaction[], ctx: DiagnosisContext): EntryDiagnosis[] {
    const each = entries.map((e) => diagnoseEntry(e, ctx));
    const profileOf = (d: EntryDiagnosis) => (Array.isArray(d.entry.profiles) ? d.entry.profiles[0] : null);
    const restoreForAll =
        each.every((d) => d.recovery.includes("verified_restore")) &&
        new Set(each.map(profileOf)).size === 1 &&
        new Set(each.map((d) => isAbsolute(d.entry.action))).size === 1;
    // The check reads the one active profile: every entry must name that same one.
    const checkForAll =
        each.every((d) => d.recovery.includes("read_only_check")) && new Set(each.map(profileOf)).size === 1;
    return each.map((d) => {
        const recovery = d.recovery.filter(
            (r) => (r !== "verified_restore" || restoreForAll) && (r !== "read_only_check" || checkForAll),
        );
        if (recovery.length === d.recovery.length) return d;
        const narrowed = diagnoseEntryFrom(d, recovery.length ? recovery : ["none"]);
        return { ...narrowed, findings: [...narrowed.findings, "blocked_by_other_entry"] };
    });
}

function diagnoseEntryFrom(d: EntryDiagnosis, recovery: RecoveryAvailability[]): EntryDiagnosis {
    const nextSteps = ["gyroflightRecoveryStepDoNotFly"];
    if (d.findings.includes("in_progress_owner_active")) nextSteps.push("gyroflightRecoveryStepWaitForOwner");
    if (recovery.includes("read_only_check")) nextSteps.push("gyroflightRecoveryStepCheck");
    if (recovery.includes("verified_restore")) nextSteps.push("gyroflightRecoveryStepRestore");
    if (recovery.includes("none")) nextSteps.push("gyroflightRecoveryStepInspect", "gyroflightRecoveryStepOutside");
    return { ...d, recovery, nextSteps };
}

interface LockQuery {
    query?: () => Promise<{ held?: { name?: string }[] }>;
}

/** Whether any page of this origin holds the transaction lock now; null when it cannot be read. */
export async function transactionOwnerActive(): Promise<boolean | null> {
    const locks = (globalThis.navigator as { locks?: LockQuery } | undefined)?.locks;
    if (typeof locks?.query !== "function") return null;
    try {
        const state = await locks.query();
        return (state.held ?? []).some((l) => l.name === FC_WRITE_LOCK);
    } catch {
        return null;
    }
}

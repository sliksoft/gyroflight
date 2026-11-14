"""Per restore path (run_restore_paths.sh): the tunes the bench read over MSP, what the app showed, what the journal says,
and for H1 / H1b / H2 the pre-set criteria of HERSTELPLAN_SITL.md (checks; a path passes only when all hold).

restore_paths_report.py <out dir>  →  <out dir>/paths.json and PATHS.md
"""

import json
import sys
from pathlib import Path

AX = ("roll", "pitch", "yaw")


def t(tune):
    if not tune:
        return "–"
    return " ".join(f"{a} {tune[a]['p']}/{tune[a]['i']}/{tune[a]['d']}/{tune[a]['dMax']}" for a in AX)


def checks(name, j, row, acc, ind):
    """The criteria of HERSTELPLAN_SITL.md for H1 / H1b / H2 (and the P0 control), from the journal and the app's own record."""
    out = []

    def c(rule, ok, detail=""):
        out.append({"rule": rule, "ok": bool(ok), "detail": detail})

    ops = [e["op"] for e in j]
    first_drop = ops.index("disconnected") if "disconnected" in ops else len(j)
    att = lambda why: [e for e in j if e["op"] == "restore_attempt" and e["why"] == why]
    tune_of = lambda e: (e.get("readback") or {}).get("tune")
    app = row["appRecordInJournal"]
    left = row["sitlLeft"] == "sitl_left=0"
    if name.startswith("P0"):
        c("app_finish_budget", app["via"] == "finish" and app["stopReason"] == "budget", str(app))
        c("no_restore_attempt", not any(e["op"] == "restore_attempt" for e in j))
        c("independent_read_equals_accepted", row["independentEqualsAccepted"])
        c("no_sitl_left", left, row["sitlLeft"])
        return out
    why = {"H1": "stop", "H1b": "app", "H2": "stop"}.get(name.split("_")[0])
    if not why:
        return out
    # the first restore of this path: its attempts up to and including the first exact one
    idx = []
    for k, e in enumerate(j):
        if e["op"] == "restore_attempt" and e["why"] == why:
            idx.append(k)
            if e["exact"]:
                break
    a = [j[k] for k in idx]
    # the candidate active before that restore (the last tune set before it)
    cand = next((e["tune"] for e in reversed(j[: idx[0]] if idx else j) if e["op"] == "setTune"), None)
    # the tune the bench held as accepted at that restore (a later ACCEPT may change accepted.json afterwards)
    acc_then = next((e["tune"] for e in reversed(j[: idx[0]] if idx else j) if e["op"] == "commitAccepted"), None)
    c("one_connection", ops.count("connected") == 1, f"connected={ops.count('connected')}")
    c("attempts_before_any_disconnect", bool(idx) and max(idx) < first_drop, f"attempt idx={idx} first disconnect={first_drop}")
    if name.startswith("H1"):
        c("attempt1_injected_fails_reads_candidate", len(a) >= 1 and a[0]["injected"] and not a[0]["exact"] and cand is not None and tune_of(a[0]) == cand,
          f"attempt1 read {tune_of(a[0]) if a else None} candidate {cand}")
        c("attempt2_exact_accepted", len(a) == 2 and a[1]["exact"] and not a[1]["injected"] and acc_then is not None and tune_of(a[1]) == acc_then,
          f"attempts={len(a)} read {tune_of(a[1]) if len(a) > 1 else None} accepted then {acc_then}")
        c("app_record_via_finish", app["via"] == "finish", str(app))
        c("disconnect_with_session_closed", any(e["op"] == "disconnected" and e.get("sessionOpen") is False for e in j))
        c("no_restore_on_lost_connection", not att("connection_lost"))
        if name.startswith("H1b"):
            st = (row["app"]["steps"] or [[None, None, None]])[0]
            c("step1_scripted_restore", st[1] == "RESTORE", str(st))
            c("app_shows_exact_attempt_2", "read back exact (attempt 2)" in (st[2] or ""), str(st[2]))
            k = max(idx) if idx else len(j)
            after = [e["op"] for e in j[k + 1:] if e["op"] not in ("restore",)]
            c("nothing_between_request_and_exact_read", all(e["op"] in ("restore_attempt", "injected") for e in j[min(idx):k + 1]) if idx else False)
            c("session_goes_on_after_exact_restore", bool(after) and after[0] in ("readActive", "setTune", "measure"), str(after[:3]))
        else:
            c("abort_stop_restored_exact", any(e["op"] == "abort" and e["why"] == "stop" and e.get("restoredExact") for e in j))
            c("app_panel_aborted", row["app"]["panelState"] == "aborted", str(row["app"]["panelState"]))
        c("independent_read_equals_accepted", row["independentEqualsAccepted"], f"independent {row['independentRead']}")
    else:
        c("three_attempts_fail_read_candidate", len(a) == 3 and all(not e["exact"] and e["injected"] and tune_of(e) == cand for e in a),
          f"attempts={len(a)} candidate {cand}")
        c("restore_unconfirmed_journalled", any(e["op"] == "restore" and e["why"] == "stop" and e.get("error") == "restore_unconfirmed" for e in j))
        c("app_reports_restore_unconfirmed", (row["app"]["stop"] or {}).get("reason") == "restore_unconfirmed" and app["stopReason"] == "restore_unconfirmed",
          f"panel {row['app']['stop']} record {app}")
        c("app_shows_unconfirmed_notice", bool(row["unconfirmedNotice"]), str(row["unconfirmedNotice"]))
        c("start_disabled", row["startDisabled"] is True)
        c("no_finish", "finish" not in ops and app["via"] == "app_result", str(app))
        rep = {(r["method"]): (r["reply"] if isinstance(r["reply"], dict) else {}) for r in (row["probe"] or {}).get("replies", [])}
        for m in ("setTune", "measure", "commitAccepted"):
            c(f"bench_refuses_{m}", rep.get(m, {}).get("ok") is False and rep.get(m, {}).get("error") == "restore_unconfirmed_locked", str(rep.get(m)))
        c("refusals_journalled", sorted(e["method"] for e in j if e["op"] == "refused") == ["commitAccepted", "measure", "setTune"])
        c("probe_on_same_connection", (row["probe"] or {}).get("connectionsAtEnd") == 1 and ops.count("connected") == 1)
        lost = att("connection_lost")
        c("lost_connection_tries_again_and_fails", len(lost) == 3 and all(not e["exact"] for e in lost)
          and any(e["op"] == "abort" and e["why"] == "connection_lost" and e.get("restoredExact") is False and e.get("error") == "restore_unconfirmed" for e in j))
        c("independent_read_is_candidate_not_accepted", ind is not None and ind == cand and not row["independentEqualsAccepted"], f"independent {ind}")
    c("no_sitl_left", left, row["sitlLeft"])
    return out


def main():
    out = Path(sys.argv[1])
    rows = []
    for d in sorted(p for p in out.iterdir() if p.is_dir() and p.name[:1] in "PH"):
        j = [json.loads(x) for x in (d / "journal.jsonl").read_text().splitlines() if x.strip()] if (d / "journal.jsonl").is_file() else []
        acc = json.loads((d / "accepted.json").read_text()) if (d / "accepted.json").is_file() else None
        ui = json.loads((d / "ui" / "session_ui.json").read_text()) if (d / "ui" / "session_ui.json").is_file() else {}
        read = ui.get("read") or {}
        ind = None
        p = d / "independent_read" / "result.json"
        if p.is_file():
            r = json.loads(p.read_text())
            if r.get("status") == "ok":
                dec = r["active"]["decoded"]
                ind = {a: {k: dec[a][k] for k in ("p", "i", "d", "dMax")} for a in AX}
        msp = []
        for e in j:
            if e["op"] in ("readActive", "setTune"):
                tune = (e.get("active") or e.get("readback") or {}).get("tune")
                msp.append({"at": e["at"], "op": e["op"], "tune": tune})
            elif e["op"] == "restore_attempt":
                msp.append({"at": e["at"], "op": f"restore_attempt[{e['why']} {e['n']}/{e['of']}{' injected' if e.get('injected') else ''}]",
                            "tune": (e.get("readback") or {}).get("tune"), "exact": e.get("exact"), "error": e.get("error")})
            elif e["op"] == "restore":
                msp.append({"at": e["at"], "op": f"restore[{e['why']}]", "tune": (e.get("readback") or {}).get("tune"), "exact": e.get("exact"),
                            "error": e.get("error"), "attempts": e.get("attempts")})
            elif e["op"] == "injected":
                msp.append({"at": e["at"], "op": f"injected[{e['fault']}]",
                            "tune": e.get("flashTune") or (e.get("activeAfterFailedRestore") or {}).get("tune")})
        ops = [{k: v for k, v in e.items() if k in ("at", "op", "why", "helperStopped", "restoredExact", "error", "sessionOpen", "fault", "measurementId",
                                                     "attempt", "n", "exact", "attempts", "method", "reason", "faults")}
               for e in j if e["op"] in ("inject_armed", "injected", "commitAccepted", "restore_attempt", "restore", "abort", "abort_joined", "finish",
                                         "finish_refused", "refused", "app_result", "connected", "disconnected")]
        app_rec = next((e["result"] for e in reversed(j) if e["op"] in ("finish", "app_result")), None)
        rows.append({
            "path": d.name,
            "acceptedOnBench": acc["tune"] if acc else None,
            "independentRead": ind,
            "independentEqualsAccepted": bool(acc and ind and acc["tune"] == ind),
            "mspReads": msp,
            "app": {"panelState": read.get("state"), "stop": read.get("stop"), "steps": [(s["index"], s["verdict"], s["cells"].get("restore")) for s in read.get("steps", [])],
                    "finalActive": read.get("finalActive"), "error": read.get("error"), "action": ui.get("action")},
            "appRecordInJournal": {"via": next((e["op"] for e in reversed(j) if e["op"] in ("finish", "app_result")), None),
                                   "status": app_rec and app_rec.get("status"), "stopReason": app_rec and app_rec.get("stopReason"),
                                   "stopDetail": app_rec and app_rec.get("stopDetail")},
            "journal": ops,
            "sitlLeft": (d / "after.txt").read_text().splitlines()[0] if (d / "after.txt").is_file() else None,
            "probe": ui.get("probe"),
            "unconfirmedNotice": ui.get("unconfirmedNotice"),
            "startDisabled": ui.get("startDisabled"),
        })
        rows[-1]["checks"] = checks(d.name, j, rows[-1], acc, ind)
        rows[-1]["pass"] = all(c["ok"] for c in rows[-1]["checks"]) if rows[-1]["checks"] else None
    (out / "paths.json").write_text(json.dumps(rows, indent=1))
    md = [f"# Restore paths on {(out / 'head.txt').read_text().strip()[:9] if (out / 'head.txt').is_file() else '?'}", ""]
    for r in rows:
        md.append(f"## {r['path']}")
        md.append(f"- app: panel `{r['app']['panelState']}`, {r['app']['stop'] and r['app']['stop'].get('text')}; error: {r['app']['error']}; action: {r['app']['action']}")
        md.append(f"- app record in journal via `{r['appRecordInJournal']['via']}`: {r['appRecordInJournal']['status']} / {r['appRecordInJournal']['stopReason']} {r['appRecordInJournal']['stopDetail']}")
        for m in r["mspReads"]:
            extra = "" if "exact" not in m else f" exact={m['exact']} error={m.get('error')}"
            md.append(f"- MSP {m['at'][11:19]} {m['op']}: {t(m['tune'])}{extra}")
        md.append(f"- journal: " + "; ".join(f"{o['at'][11:19]} {o['op']}" + "".join(f" {k}={o[k]}" for k in o if k not in ("at", "op")) for o in r["journal"]))
        md.append(f"- accepted on bench: {t(r['acceptedOnBench'])}; independent MSP read after: {t(r['independentRead'])} (equal: {r['independentEqualsAccepted']}); {r['sitlLeft']}")
        if r.get("probe"):
            md.append(f"- probe over the same connection: " + "; ".join(f"{x['method']} → {x['reply']}" for x in r["probe"].get("replies", [])))
        if r["checks"]:
            md.append(f"- checks ({'PASS' if r['pass'] else 'FAIL'}): " + "; ".join(f"{x['rule']} {'ok' if x['ok'] else 'FAIL'}" + (f" ({x['detail']})" if not x["ok"] and x["detail"] else "") for x in r["checks"]))
        md.append("")
    (out / "PATHS.md").write_text("\n".join(md))
    print("\n".join(md))


if __name__ == "__main__":
    main()

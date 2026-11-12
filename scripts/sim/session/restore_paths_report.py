"""Per restore path (run_restore_paths.sh): the tunes the bench read over MSP, what the app showed, what the journal says.

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


def main():
    out = Path(sys.argv[1])
    rows = []
    for d in sorted(p for p in out.iterdir() if p.is_dir() and p.name[:1] == "P"):
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
            elif e["op"] == "restore":
                msp.append({"at": e["at"], "op": f"restore[{e['why']}]", "tune": (e.get("readback") or {}).get("tune"), "exact": e.get("exact"),
                            "error": e.get("error")})
            elif e["op"] == "injected":
                msp.append({"at": e["at"], "op": f"injected[{e['fault']}]",
                            "tune": e.get("flashTune") or (e.get("activeAfterFailedRestore") or {}).get("tune")})
        ops = [{k: v for k, v in e.items() if k in ("at", "op", "why", "helperStopped", "restoredExact", "error", "sessionOpen", "fault", "measurementId")}
               for e in j if e["op"] in ("inject_armed", "injected", "commitAccepted", "restore", "abort", "abort_joined", "finish", "app_result", "disconnected")]
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
        })
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
        md.append("")
    (out / "PATHS.md").write_text("\n".join(md))
    print("\n".join(md))


if __name__ == "__main__":
    main()

"""The measurement-run schedule of the AutoTune session (block 14), in outer ticks (10 ms), from one start tick s.

  [0, s)                 hover, ANGLE (settle)
  [s, s+2100)            CHIRP window 1 (firmware sweeps roll, 20 s)
  [s+2200, s+4300)       CHIRP window 2 (pitch)
  [a-60, a+B+20)         ANGLE off (acro) around the step block, a = s+4400; one pilot-grant OFF tick at a-30 (re-grant
                         edge: ANGLE and CHIRP revoke the body-rate command path's grant in the firmware)
  [a, a+B)               step block: per axis (roll, pitch) and sign (+, -) one doublet: +A for H ticks, -A for H ticks,
                         then 0 for G ticks
  [a+B, total)           hover, ANGLE
"""

import json
import sys

PILOT = {"z0": 2.0, "kz": 15.0, "dz": 30.0, "thrMax": 80.0, "kxy": 32.0, "dxy": 144.0, "stickMax": 60.0,
         "rollAxis": 1, "rollSign": -1, "pitchAxis": 0, "pitchSign": 1}


def build(start: int, amp: float = 100.0, half: int = 10, gap: int = 60, total: int = 6000) -> dict:
    s = int(start)
    a = s + 4400
    steps = {}
    blocks = []
    t = a
    for axis in (0, 1):
        for sign in (1, -1):
            for k in range(half):
                steps[t + k] = [sign * amp if axis == 0 else 0.0, sign * amp if axis == 1 else 0.0]
            for k in range(half, 2 * half):
                steps[t + k] = [-sign * amp if axis == 0 else 0.0, -sign * amp if axis == 1 else 0.0]
            blocks.append({"axis": ("roll", "pitch")[axis], "sign": sign, "startTick": t, "endTick": t + 2 * half + gap})
            t += 2 * half + gap
    end = t
    return {
        "totalTicks": total,
        "chirpWindows": [[s, s + 2100], [s + 2200, s + 4300]],
        "stepCommands": {str(k): v for k, v in steps.items()},
        "stepBlocks": blocks,
        "angleMode": True,
        "angleOffTicks": list(range(a - 60, end + 20)),
        "regrantTick": a - 30,
        "stepAmplitudeDps": amp,
        # Harness pilot (sitl_bench.py): slow PD hold of height (throttle) and position (roll/pitch sticks, ANGLE only).
        # Signs from the stick test of 11 Nov 2026: roll stick + moves the craft to −y, pitch stick + to +x.
        "pilot": dict(PILOT),
        "envelopeFromTick": s,
    }


if __name__ == "__main__":
    spec = build(int(sys.argv[1]))
    if len(sys.argv) > 2:
        spec["gyroNoise"] = json.loads(sys.argv[2])
    print(json.dumps({"measure": spec}))

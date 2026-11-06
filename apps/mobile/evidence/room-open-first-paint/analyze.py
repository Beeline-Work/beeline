"""Recompute Room-open evidence from sanitized trace lines and HWUI frames.

Run from any directory. No device, credentials, network, or package install is
needed to reproduce measurements.json from raw-records.json.gz.
"""
import argparse
import gzip
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def percentile(values, fraction):
    values = sorted(value for value in values if value is not None)
    if not values:
        return None
    return round(values[max(0, math.ceil(len(values) * fraction) - 1)], 3)


def distribution(values):
    values = [value for value in values if value is not None]
    return {"n": len(values), "p50": percentile(values, .5), "p95": percentile(values, .95)}


def trace_records(log):
    records = []
    invalid = 0
    for line in log.splitlines():
        for tag in ("ROOM_PROFILE", "ROOM_OPEN", "LATENCY_FRAME"):
            marker = f"[{tag}] "
            if marker not in line:
                continue
            try:
                decoded = json.loads(line.split(marker, 1)[1])
                records.extend(dict(row, tag=tag) for row in
                               (decoded if isinstance(decoded, list) else [decoded]))
            except (ValueError, TypeError):
                invalid += 1
    return records, invalid


def native_frames(gfx):
    header = None
    frames = []
    rejected = 0
    for line in gfx.splitlines():
        if line.startswith("Flags,"):
            header = line.rstrip(",").split(",")
        elif header and re.match(r"^\d+,", line):
            frame = dict(zip(header, map(int, line.rstrip(",").split(","))))
            if frame["Flags"] == 0 and 0 < frame.get("DrawStart", 0) <= frame.get("FrameCompleted", 0) < 10**18:
                frames.append(frame)
            else:
                rejected += 1
    return frames, rejected


def analyze_sample(raw):
    marks, invalid = trace_records(raw["log"])
    frames, rejected = native_frames(raw["gfx"])
    shell_start = raw["shellStartMs"]
    tap = next((mark["t"] for mark in marks
                if mark.get("kind") == "tap" and mark.get("phase") == "start"), shell_start)
    roots = [mark for mark in marks if mark.get("phase") == "render" and
             mark.get("id") == "Root" and mark["commitTime"] >= tap]
    commits = [mark for mark in marks if mark.get("phase") == "transcript-commit" and
               mark.get("count", 0) > 0 and mark["t"] >= tap]
    ready = next((mark["t"] for mark in marks if mark.get("phase") == "meaningful-frame" and mark["t"] >= tap), None)
    if raw["kind"] in ("cold", "warm"):
        content = commits[0]["t"] if commits else None
    else:
        # The route's ready rAF can follow its static draw. Associate it with
        # the preceding committed React tree, without inventing a later draw.
        prior = [mark["commitTime"] for mark in roots if ready is not None and mark["commitTime"] <= ready]
        content = max(prior, default=ready)
    matching = [frame for frame in frames if content is not None and frame["DrawStart"] / 1e6 >= content]
    first = min(matching, key=lambda frame: frame["FrameCompleted"], default=None)
    painted = first["FrameCompleted"] / 1e6 if first else None
    layout = next((mark["t"] for mark in marks if mark.get("phase") == "content-layout" and mark["t"] >= tap), None)
    cache = next((mark["t"] for mark in marks if mark.get("phase") == "prefetch-cache" and mark["t"] >= tap), None)
    dispatch = next((mark["t"] for mark in marks if mark.get("phase") == "wire-dispatch" and mark["t"] >= tap), None)
    headers = next((mark["t"] for mark in marks if mark.get("phase") == "wire-headers" and dispatch is not None and mark["t"] >= dispatch), None)
    first_renders = [mark["actualDuration"] for mark in roots if content is not None and mark["commitTime"] <= content]
    until_paint = [mark["actualDuration"] for mark in roots if painted is not None and mark["commitTime"] <= painted]

    def elapsed(value):
        return None if value is None else round(value - tap, 3)

    return {
        "arm": raw["arm"], "kind": raw["kind"], "sample": raw["sample"],
        "hostLoad": raw["hostLoad"], "tapMs": tap,
        "shellToJsTouchMs": round(tap - shell_start, 3),
        "cacheAvailableMs": elapsed(cache), "contentCommitMs": elapsed(content),
        "contentLayoutCallbackMs": elapsed(layout),
        "nativeFrameMs": elapsed(painted),
        "rootRenderThroughContentMs": None if content is None else round(sum(first_renders), 3),
        "rootRenderThroughPaintMs": None if painted is None else round(sum(until_paint), 3),
        "rootPeakRenderMs": None if painted is None else round(max(until_paint, default=0), 3),
        "readRequestToHeadersMs": None if headers is None else round(headers - dispatch, 3),
        "commitToNativeDrawMs": None if first is None else round(first["DrawStart"] / 1e6 - content, 3),
        "nativeDrawToCompletedMs": None if first is None else round((first["FrameCompleted"] - first["DrawStart"]) / 1e6, 3),
        "projectedMessageCount": commits[0]["count"] if commits else None,
        "invalidLogRecords": invalid, "rejectedNativeFrames": rejected,
        "selectedNativeFrame": first,
    }


def analyze(raw_records):
    samples = [analyze_sample(record) for record in raw_records]
    summary = {}
    keys = ("shellToJsTouchMs", "cacheAvailableMs", "contentCommitMs", "contentLayoutCallbackMs",
            "nativeFrameMs", "rootRenderThroughContentMs", "rootRenderThroughPaintMs",
            "rootPeakRenderMs", "readRequestToHeadersMs", "commitToNativeDrawMs", "nativeDrawToCompletedMs")
    for arm in dict.fromkeys(sample["arm"] for sample in samples):
        summary[arm] = {}
        for kind in dict.fromkeys(sample["kind"] for sample in samples if sample["arm"] == arm):
            chosen = [sample for sample in samples if sample["arm"] == arm and sample["kind"] == kind]
            summary[arm][kind] = {"samples": len(chosen), **{
                key: distribution(sample[key] for sample in chosen) for key in keys}}
    return {"summary": summary, "samples": samples}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=ROOT / "raw-records.json.gz")
    parser.add_argument("--output", type=Path, default=ROOT / "measurements.json")
    args = parser.parse_args()
    with gzip.open(args.raw, "rt") as source:
        result = analyze(json.load(source))
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    for arm, cases in result["summary"].items():
        for case, metrics in cases.items():
            print(arm, case, metrics["nativeFrameMs"])

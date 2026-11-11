#!/usr/bin/env python3
"""Aggregate completed-turn latency and all available usage, including cancelled requests."""

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


def percentile(values, quantile):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(quantile * len(ordered)) - 1)] if ordered else None


def report(paths):
    metrics = defaultdict(list)
    statuses = Counter()
    usage = {}
    for path in paths:
        if not path.is_file():
            continue  # A fresh installation has no logs directory yet.
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # includes a partially-written last line in a live log
            if row.get("event") == "turn_summary":
                data = row["data"]
                statuses[data["status"]] += 1
                if data["status"] == "completed":
                    for name, value in data["metrics"].items():
                        if isinstance(value, (int, float)) and math.isfinite(value):
                            metrics[name].append(value)
            if row.get("event") == "usage" and row.get("session_id"):
                usage[(row["session_id"], row["turn_id"])] = row["data"]
    return {
        "statuses": dict(statuses),
        "latency_ms": {
            k: {"n": len(v), "p50": percentile(v, 0.50), "p95": percentile(v, 0.95)}
            for k, v in sorted(metrics.items())
        },
        "usage": {
            "reported_turns": len(usage),
            "input_tokens": sum(v.get("input", 0) for v in usage.values()),
            "output_tokens": sum(v.get("output", 0) for v in usage.values()),
            "cache_read_tokens": sum(v.get("cache_read", 0) for v in usage.values()),
            "cache_write_tokens": sum(v.get("cache_write", 0) for v in usage.values()),
            "usd": sum(v.get("usd", 0) for v in usage.values()),
            "estimated_turns": sum(v.get("cost_source") != "provider" for v in usage.values()),
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    paths = sorted({f for p in args.paths for f in (p.glob("*.jsonl") if p.is_dir() else [p])})
    data = report(paths)
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print("Turns:", data["statuses"] or "No turns recorded")
        print(f"{'Metric':30} {'N':>5} {'P50':>9} {'P95':>9}")
        for name, values in data["latency_ms"].items():
            print(f"{name:30} {values['n']:5} {values['p50']:8.0f}ms {values['p95']:8.0f}ms")
        print("Usage:", json.dumps(data["usage"]))

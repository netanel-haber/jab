# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest", "numpy", "scipy", "lightgbm", "numba"]
# ///
"""Run with: uv run tests.py (requires Node)."""

import gzip
import json
import subprocess
import sys
from pathlib import Path

import pytest


def test_parallel_unicode_input(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parent
    source = (root / "train.py").read_text(encoding="utf-8").split("# The columns after the features:")[0]
    source += '''
print(json.dumps({
    "dense": dense, "words": word_ids, "counts": word_count,
    "kinds": KINDS, "vocabulary": ALL_WORDS, "steps": steps,
}, default=lambda value: value.tolist()))
'''
    numeric = "x y w h n fill sat round bold hit lcover lz head font chrome like at prose icon filled submit".split()
    strings = "label href name ph action before parent around".split()
    control = dict.fromkeys(numeric, 0) | dict.fromkeys(strings, "") | {"form": -1, "region": -1, "layer": -1}
    steps = []
    for index in range(257):
        kinds = ("button", "input text") if index < 256 else ("input text", "button")
        steps.append({
            "split": "train", "type": "real", "focus": index % 3 - 1, "target": 1, "picks": [1, 0], "ok": [],
            "page": {
                "path": "/", "title": "Hello\u2028world\u2029שלום🚀", "desc": "é" * 65535 if index == 0 else "",
                "base": 16, "scroll": 0, "prose": 0,
            },
            "controls": [control | {"i": i, "kind": kind, "label": f"Control {index} {kind}"} for i, kind in enumerate(kinds)],
        })
    results = []
    data = tmp_path / "steps.jsonl.gz"
    for threads, escaped in ((1, True), (2, False)):
        with gzip.open(data, "wt", encoding="utf-8") as stream:
            stream.write("\r\n".join(json.dumps(step, ensure_ascii=escaped) for step in steps))
        result = subprocess.run(
            [sys.executable, "-c", source, str(data), str(root / "jab.js"), "--threads", str(threads)],
            check=True, capture_output=True, text=True,
        )
        results.append(json.loads(result.stdout.splitlines()[-1]))
    assert len(results[0]["steps"]) == len(steps)
    assert results[0] == results[1]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, *sys.argv[1:]]))

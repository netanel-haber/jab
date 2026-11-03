import ast
import gzip
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class TrainingInputTest(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("numba"), "training dependencies required")
    def test_judgment_loss_gradient(self) -> None:
        import numba
        import numpy as np

        source = (Path(__file__).resolve().parents[1] / "train.py").read_text(encoding="utf-8")
        node = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == "judgment_loss")
        namespace = {"numba": numba, "np": np}
        exec(ast.get_source_segment(source, node), namespace)
        gradient = numba.njit(parallel=True)(namespace["judgment_loss"])
        scores = np.array([-2.0, 0.4, 2.0, 1.0])
        labels = np.array([0, 1, 3, 0])
        boundaries = np.array([0, 4])
        weights = np.full(4, 1.5)

        def loss(values):
            return 1.5 * (np.logaddexp.reduce(values) - np.logaddexp.reduce(values[labels > 0]))

        expected = np.array([(loss(scores + delta) - loss(scores - delta)) / 2e-6 for delta in np.eye(4) * 1e-6])
        actual, curvature = gradient(scores, labels, boundaries, weights, None)
        np.testing.assert_allclose(actual, expected, atol=1e-8)
        np.testing.assert_allclose(gradient(scores + 1000, labels, boundaries, weights, None)[0], actual, atol=1e-12)
        self.assertAlmostEqual(float(actual.sum()), 0)
        self.assertTrue(np.all(curvature > 0))
        for uniform in (np.zeros(4, dtype=int), np.ones(4, dtype=int)):
            grad, hess = gradient(scores, uniform, boundaries, weights, None)
            np.testing.assert_array_equal(grad, np.zeros(4))
            np.testing.assert_array_equal(hess, np.zeros(4))

    @unittest.skipUnless(importlib.util.find_spec("lightgbm") and importlib.util.find_spec("numba"), "training dependencies required")
    def test_parallel_features_match_serial(self) -> None:
        import numpy as np

        root = Path(__file__).resolve().parents[1]
        source = (root / "train.py").read_text(encoding="utf-8").split("# The columns after the features:")[0]
        source += '''
output = pathlib.Path(args.steps).parent / str(args.threads)
np.savez(output, dense=dense, words=word_ids, counts=word_count)
output.with_suffix(".json").write_text(json.dumps({
    "kinds": KINDS, "words": ALL_WORDS,
    "steps": [{k: v.tolist() if isinstance(v, np.ndarray) else v for k, v in s.items()} for s in steps],
}), encoding="utf-8")
'''
        numeric = "x y w h n fill sat round bold hit lcover lz head font chrome like at prose icon filled submit".split()
        strings = "label href name ph action before parent around".split()
        control = dict.fromkeys(numeric, 0) | dict.fromkeys(strings, "") | {"form": -1, "region": -1, "layer": -1}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            data = output / "steps.jsonl.gz"
            with gzip.open(data, "wt", encoding="utf-8") as stream:
                for index in range(257):
                    kinds = ("button", "input text") if index < 256 else ("input text", "button")
                    step = {
                        "split": "train", "type": "real", "focus": index % 3 - 1,
                        "target": 1, "picks": [1, 0], "ok": [],
                        "page": {"path": "/", "title": "Example", "desc": "", "base": 16, "scroll": 0, "prose": 0},
                        "controls": [control | {"i": i, "kind": kind, "label": f"Control {index} {kind}"} for i, kind in enumerate(kinds)],
                    }
                    stream.write(json.dumps(step) + "\n")
            for threads in (1, 2):
                subprocess.run(
                    [sys.executable, "-c", source, str(data), str(root / "jab.js"), "--threads", str(threads)],
                    check=True, capture_output=True, text=True,
                )
            self.assertEqual((output / "1.json").read_bytes(), (output / "2.json").read_bytes())
            with np.load(output / "1.npz") as serial, np.load(output / "2.npz") as parallel:
                for name in serial.files:
                    np.testing.assert_array_equal(serial[name], parallel[name])

    def test_unicode_jsonl(self) -> None:
        root = Path(__file__).resolve().parents[1]
        source = ast.parse((root / "train.py").read_text(encoding="utf-8"))
        script = next(
            ast.literal_eval(node.value)
            for node in source.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "DESCRIBE_ALL" for target in node.targets)
        )
        step = {
            "controls": [],
            "focus": -1,
            "page": {"path": "/", "title": "Hello\u2028world\u2029שלום🚀", "desc": "é" * 65535},
        }
        results = []
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for escaped in (True, False):
                data = output / "steps.jsonl.gz"
                line = json.dumps(step, ensure_ascii=escaped)
                with gzip.open(data, "wt", encoding="utf-8") as stream:
                    stream.write(line + "\r\n" + line)
                subprocess.run(
                    ["node", "-e", script, str(root / "jab.js"), str(data), directory, "{}"], check=True
                )
                results.append(json.loads((output / "meta.json").read_text(encoding="utf-8")))
        self.assertEqual(len(results[0]["steps"]), 2)
        self.assertEqual(results[0], results[1])


if __name__ == "__main__":
    unittest.main()

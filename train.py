# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "scipy", "lightgbm", "numba"]
# ///
"""jab, a smart tab: which controls does a person want next?   uv run train.py steps.jsonl.gz jab.js [--all]   (needs Node)

Trains a LightGBM LambdaRank ranker over every control of a page, refits all its leaves together once the trees are grown (fully
corrective, as in Regularized Greedy Forest), and writes its trees into jab.js (as JSON, in its MODEL string), which puts the
controls in the order of their scores, with the score a 3rd or 4th pick needs to be shown at all ("sure"), found on the held-out
steps. The shipped trees: --all. The features are jab.js's own: its describe() works them out under Node, so training sees exactly what
the browser computes.
steps.jsonl.gz (not included): 6,004 steps on about 1,180 real sites; 2,279 on about 1,030 of the most visited sites (810 as the
home page opens, 1,469 with something already focused) and 1,126 on pages a visitor reaches from those home pages on about 660 of
them (a search or a link, then a link on the page that opened); and 9,598 on 877 of the most visited sites in the three most common
desktop windows, each page seen at 1920x945, 1536x730 and 1366x640 with one label carried across by element (1,332 home pages;
1,689 pages a link opens, such as a model, a repository, a product or an article; 191 search results); each page allowed by its
robots.txt to anyone, ClaudeBot, anthropic-ai and Claude-User, no adult sites; labelled by Claude from screenshots. And 8,674 steps
on 5,000 generated pages (news, results, articles, feeds, listings, docs; landing pages, forms, search pages, apps, products,
cookie pop-ups; six languages), labelled by rule and counted at half weight; all collected by jab.js's own collector. Where links
lead to the same place, the label wants one of them: text over a picture of the same thing (on a page that is mostly pictures, the
picture), else the one it ranked first.
One step per line:
{"split": "train"|"eval", "type": the kind of page ("real" or "live" for a real site), "page": {"path", "title", "desc", "scroll",
"h1", "query", "prose", "base", "vw", "vh"}, "controls": [jab.js collect()], "focus": the focused control or -1, "target": the
control wanted next, "picks": the ordered 4 a person would want, "ok": others that are also fine, "unjudged": controls the label
says nothing about, left out of training (optional)}.
Prints, for the "eval" steps, overall and per kind of page, with the trees as written into jab.js and every control ranked as jab.js
ranks them: whether the first stop is wanted (as training counts it: a pick already visited is not), how often it is a control the
label says nothing about, how many of the 4 stops are wanted, whether the target is first and whether it is within the 4. --all also
trains on them, for the file you ship (the cut still comes from trees grown without them)."""

import argparse
import collections
import gzip
import json
import math
import pathlib
import re
import subprocess
import tempfile

import lightgbm as lgb
import numba
import numpy as np
import scipy.sparse as sp

ap = argparse.ArgumentParser()
ap.add_argument("steps")
ap.add_argument("jab")
ap.add_argument("--all", action="store_true")
args = ap.parse_args()

# The labels, and each step's kinds of control and the controls rank() scores (all but the focused one); the controls themselves
# only jab.js reads, below.
steps = []
with gzip.open(args.steps, "rt", encoding="utf-8") as lines:
    for line in lines:
        s = json.loads(line)
        controls = s.pop("controls")
        s["kinds"] = [c["kind"] for c in controls]
        s["ids"] = [c["i"] for c in controls if c["i"] != s["focus"]]
        steps.append(s)
train = [s for s in steps if args.all or s["split"] == "train"]
held = [s for s in steps if s["split"] == "eval"]


def vocabulary(counts, n):
    """the n commonest, ties alphabetically, so the same data always gives the same columns"""
    return {k: i for i, k in enumerate(sorted(counts, key=lambda k: (-counts[k], k))[:n])}


KINDS = vocabulary(collections.Counter(k for s in train for k in s["kinds"]), 30)

# The features are jab.js's own: Node loads jab.js, with stand-ins for the page it sets itself up on as it loads, and its describe()
# gives every step's words and each control's features and words, as rank() sees them. Out come the features (x.f64), the words as
# numbers (w.i32, and how many each control has: n.i32), and meta.json: the feature names, the words, and per step how many
# controls, the page's words and the focused control's words.
DESCRIBE_ALL = r"""
const fs = require("fs"),
  path = require("path"),
  zlib = require("zlib"),
  readline = require("readline");
const [jab, steps, out, kinds] = process.argv.slice(1);
const stub = new Proxy(function () {}, { get: () => stub, set: () => true, apply: () => stub, construct: () => stub });
Object.assign(globalThis, { document: stub, CSSStyleSheet: stub, addEventListener: stub, setInterval: stub });
const { describe } = require(path.resolve(jab));
const kindOf = JSON.parse(kinds);
const ids = new Map(),
  id = (w) => ids.get(w) ?? ids.set(w, ids.size).get(w);
const [fx, fw, fn] = ["x.f64", "w.i32", "n.i32"].map((f) => fs.openSync(`${out}/${f}`, "w")),
  meta = [];
let names;
(async () => {
  const lines = readline.createInterface({
    input: fs.createReadStream(steps).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const s = JSON.parse(line);
    const { page, controls } = describe(kindOf, s.controls, s.focus, s.page);
    names ??= controls.length ? Object.keys(controls[0].features) : undefined;
    const x = new Float64Array(controls.length * (names?.length ?? 0)),
      w = [],
      n = [];
    controls.forEach(({ features, words }, r) => {
      let j = 0;
      for (const k in features) x[r * names.length + j++] = Number(features[k]);
      w.push(...words.map(id)), n.push(words.length);
    });
    const step = [controls.length, page.map(id)];
    // the focused control's words count for the vocabulary too
    const focused = s.controls.find((c) => c.i == s.focus);
    step.push(focused ? describe(kindOf, [focused], -1, s.page).controls[0].words.map(id) : []);
    fs.writeSync(fx, new Uint8Array(x.buffer));
    fs.writeSync(fw, new Uint8Array(Int32Array.from(w).buffer));
    fs.writeSync(fn, new Uint8Array(Int32Array.from(n).buffer));
    meta.push(step);
  }
  fs.writeFileSync(`${out}/meta.json`, JSON.stringify({ names, words: [...ids.keys()], steps: meta }));
})();
"""
with tempfile.TemporaryDirectory() as out:
    subprocess.run(["node", "-e", DESCRIBE_ALL, args.jab, args.steps, out, json.dumps(KINDS)], check=True)
    meta = json.loads(pathlib.Path(out, "meta.json").read_text(encoding="utf-8"))
    FEATURES, ALL_WORDS = meta["names"], {w: k for k, w in enumerate(meta["words"])}
    dense = np.fromfile(f"{out}/x.f64").reshape(-1, len(FEATURES))  # every row: each step's controls, one after another
    word_ids = np.fromfile(f"{out}/w.i32", dtype=np.int32)
    word_count = np.fromfile(f"{out}/n.i32", dtype=np.int32)
first = 0
for s, (n, page_words, focused_words) in zip(steps, meta["steps"], strict=True):
    assert n == len(s["ids"]), "jab.js's describe() left out a control"
    s["first"], s["page_words"], s["focused_words"] = first, np.array(page_words, dtype=np.int64), focused_words
    first += n

# The columns after the features: a word of the control ("w:"), of the text around it ("c:"), of the page ("p:"), each counted
# over the training steps, a control's words for every control (the focused one too) and the page's once per step.
row_of = np.repeat(np.arange(len(word_count)), word_count)
trained = np.zeros(len(word_count), bool)
for s in train:
    trained[s["first"] : s["first"] + len(s["ids"])] = True
mentions = np.concatenate([word_ids[trained[row_of]], *(np.array(s["focused_words"], dtype=np.int64) for s in train)])
own = np.bincount(mentions, minlength=len(ALL_WORDS))
pages = np.bincount(np.concatenate([s["page_words"] for s in train]), minlength=len(ALL_WORDS))
count = lambda prefix, c: collections.Counter({w: c[k] for w, k in ALL_WORDS.items() if w.startswith(prefix) and c[k]})
WORDS = [*vocabulary(count("w:", own), 1500), *vocabulary(count("c:", own), 400), *vocabulary(count("p:", pages), 300)]
column = np.full(len(ALL_WORDS), -1)
column[[ALL_WORDS[w] for w in WORDS]] = np.arange(len(WORDS))
# every row's words as 0/1 columns: its own, and its page's
r = np.concatenate([row_of, *(np.repeat(np.arange(s["first"], s["first"] + len(s["ids"])), len(s["page_words"])) for s in steps)])
c = np.concatenate([column[word_ids], *(np.tile(column[s["page_words"]], len(s["ids"])) for s in steps)])
bags = sp.csr_matrix((np.ones(np.sum(c >= 0)), (r[c >= 0], c[c >= 0])), shape=(len(word_count), len(WORDS)))


def rows(steps_, every=False):
    """The rows the model sees, every step's controls one after another: jab.js's features, then a 0/1 per word of the control, of
    the text around it and of the page, as one sparse matrix; and each step's control ids. Training leaves out the controls the
    label says nothing about; every=True keeps them, as jab.js ranks them all."""
    pick, ids = [], []
    for s in steps_:
        unjudged = set(s.get("unjudged", ()))
        mine = [(s["first"] + k, i) for k, i in enumerate(s["ids"]) if every or i not in unjudged]
        pick += [k for k, _ in mine]
        ids.append([i for _, i in mine])
    return sp.hstack([sp.csr_matrix(dense[pick]), bags[pick]], format="csr"), ids


def relevance(s, ids):
    """3 the control wanted next, 2 the picks still ahead of it, 1 the also-fine ones, 0 the rest (and the picks already visited)."""
    p = s["picks"]
    ahead = set(p[p.index(s["target"]) + 1 :]) if s["target"] in p else set()
    return [3 if i == s["target"] else 2 if i in ahead else 1 if i in s["ok"] else 0 for i in ids]


params = {
    "objective": "lambdarank",
    "learning_rate": 0.2,
    "num_leaves": 10,
    "min_data_in_leaf": 10,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "feature_fraction": 0.8,
    "seed": 1,
    "deterministic": True,  # with row-wise histograms, the same data gives the same trees on every run
    "force_row_wise": True,
    "verbose": -1,
}


@numba.njit
def lambdarank(score, label, start, weight, gain):
    """LambdaRank's gradients and hessians of every row as LightGBM works them out for these params (lambdarank_objective.hpp: the
    pairs with at least one control among the 30 ranked first, normalized), each step's controls being start[q]:start[q + 1]."""
    grad, hess = np.zeros(len(score)), np.zeros(len(score))
    for q in range(len(start) - 1):
        a, n = start[q], start[q + 1] - start[q]
        s, lab = score[a : a + n], label[a : a + n]
        order = np.argsort(-s, kind="mergesort")
        best = np.sort(lab)[::-1]
        max_dcg = 0.0
        for k in range(min(n, 30)):
            max_dcg += gain[best[k]] / np.log2(2.0 + k)
        if n < 2 or max_dcg == 0:
            continue
        g, h, total = np.zeros(n), np.zeros(n), 0.0
        for i in range(min(n - 1, 30)):
            for j in range(i + 1, n):
                hi, lo = order[i], order[j]
                if lab[hi] == lab[lo]:
                    continue
                if lab[hi] < lab[lo]:
                    hi, lo = lo, hi
                delta = (gain[lab[hi]] - gain[lab[lo]]) * abs(1 / np.log2(2.0 + i) - 1 / np.log2(2.0 + j)) / max_dcg
                ds = s[hi] - s[lo]
                if s[order[0]] != s[order[n - 1]]:
                    delta /= 0.01 + abs(ds)
                p = 1 / (1 + np.exp(ds))
                g[lo] += p * delta
                g[hi] -= p * delta
                h[lo] += p * (1 - p) * delta
                h[hi] += p * (1 - p) * delta
                total += 2 * p * delta
        norm = np.log2(1 + total) / total if total > 0 else 1.0
        grad[a : a + n], hess[a : a + n] = g * norm * weight[a : a + n], h * norm * weight[a : a + n]
    return grad, hess


def refit(model, X, y, groups, weight):
    """Every leaf again, the splits as they are (fully corrective, as in Regularized Greedy Forest): boosting set each tree's leaves
    once, before the trees after it were grown. Three passes go through the trees in turn and move each tree's leaves halfway to
    where LambdaRank wants them, every other tree in place (a damped Newton step). The same splits, ranking better; the leaves take
    a few more digits."""
    # every row's leaf, in every tree (in blocks of rows: LightGBM hands them back as 8-byte floats)
    leaf_of = np.vstack([model.predict(X[a : a + 100000], pred_leaf=True).astype(np.int16) for a in range(0, X.shape[0], 100000)])
    info = model.dump_model()["tree_info"]
    values = [np.array([model.get_leaf_output(k, j) for j in range(t["num_leaves"])]) for k, t in enumerate(info)]
    start = np.concatenate([[0], np.cumsum(groups)])
    label, label_gain = y.astype(np.int64), np.array([2.0**l - 1 for l in range(4)])  # LightGBM's default label_gain
    score = sum(v[leaf_of[:, k]] for k, v in enumerate(values))
    for _ in range(3):
        for k, v in enumerate(values):
            g, h = lambdarank(score, label, start, weight, label_gain)
            step = -0.5 * np.bincount(leaf_of[:, k], g, minlength=len(v)) / (np.bincount(leaf_of[:, k], h, minlength=len(v)) + 1)
            v += step
            score += step[leaf_of[:, k]]
    for k, v in enumerate(values):
        for j, value in enumerate(v):
            model.set_leaf_output(k, j, value)


def grow(steps_):
    """LightGBM's trees for these steps, their leaves refit together; and the rows they were grown on"""
    X, ids = rows(steps_)
    y = np.concatenate([relevance(s, i) for s, i in zip(steps_, ids)])
    # The generated pages count half: they teach what few real sites show (forms, pop-ups, where the content is), and a model this
    # small has to spend most of itself on the real sites, which are what jab is for.
    weight = np.concatenate([np.full(len(i), 1 if s["type"] in ("real", "live") else 0.5) for s, i in zip(steps_, ids)])
    groups = [len(i) for i in ids]
    model = lgb.train(params, lgb.Dataset(X, y, group=groups, weight=weight), num_boost_round=140)
    refit(model, X, y, groups, weight)
    return model, X


def scored(model, steps_):
    """every control of these steps, as jab.js ranks them all, with the model's score for it (in jab.js's units); and their ids"""
    X, ids = rows(steps_, every=True)
    return model.predict(X, raw_score=True) * 100, ids


# The cut ("sure", below) is found on the held-out steps, as trees that did not learn from them rank them: trees are surer of the
# steps they learned than of a page they have not seen. Those are the trees grown on the training steps; with --all, the shipped
# trees are grown on every step after them.
assert held, 'the cut is found on the held-out steps ("split": "eval")'
model, X = grow([s for s in steps if s["split"] == "train"])
held_scores, held_ids = scored(model, held)
if args.all:
    del model, X  # their memory, before the shipped trees take theirs
    model, X = grow(train)


# The thresholds in the model as short as they can be: on a column of whole numbers, the whole number below (20, not 20.5); on any
# other, the shortest decimal that still splits the training values the same way and stays near the middle of the gap between them,
# where LightGBM put it (0.35, not 0.35000000000000003).
by_column = X.tocsc()
seen = {}


def threshold(j, t):
    if j not in seen:
        v = by_column.data[by_column.indptr[j] : by_column.indptr[j + 1]]
        seen[j] = np.unique(np.append(v, 0.0) if len(v) < X.shape[0] else v)
    v = seen[j]
    if np.all(v == np.floor(v)):
        return math.floor(t)
    k = np.searchsorted(v, t, side="right")  # v[k - 1] <= t < v[k]
    low, high = v[k - 1] if k else -math.inf, v[k] if k < len(v) else math.inf
    for digits in range(18):
        scale = 10**digits
        near = sorted({math.floor(t * scale) / scale, math.ceil(t * scale) / scale}, key=lambda q: abs(q - t))
        for q in near:
            if low <= q < high and abs(q - t) <= (high - low) / 4:
                return int(q) if q.is_integer() else q
    return t


def tree(node):
    """the model: a tree as nested [column, threshold, left, right]; a leaf as a whole number, its value times 100 (jab.js only
    orders the controls by the sum, and two decimals leave that order as it was). A split whose sides round the same is left out."""
    if "leaf_index" in node:
        return round(node["leaf_value"] * 100)
    left, right = tree(node["left_child"]), tree(node["right_child"])
    f = node["split_feature"]
    return left if left == right else [f, threshold(f, node["threshold"]), left, right]


def columns(t):
    """the columns a tree splits on"""
    if isinstance(t, list):
        yield t[0]
        yield from columns(t[2])
        yield from columns(t[3])


trees = [tree(info["tree_structure"]) for info in model.dump_model()["tree_info"]]
# only the columns some tree asks about go in the model, numbered in order: those features, then those words
used = sorted({j for t in trees for j in columns(t)})
column = {j: k for k, j in enumerate(used)}
renumber = lambda t: [column[t[0]], t[1], renumber(t[2]), renumber(t[3])] if isinstance(t, list) else t
ranker = {
    "features": [FEATURES[j] for j in used if j < len(FEATURES)],
    "kinds": KINDS,
    "words": [WORDS[j - len(FEATURES)] for j in used if j >= len(FEATURES)],
    "trees": [renumber(t) for t in trees],
}


def predict(M):
    """jab.js's score for every row of M: the sum of the trees as written into it, a value at or below a threshold going left. In
    blocks of rows, to keep the dense copy small."""
    out = np.zeros(M.shape[0])
    for start in range(0, M.shape[0], 50000):
        D, part = M[start : start + 50000, used].toarray(), out[start : start + 50000]

        def walk(node, at):
            if not isinstance(node, list):
                part[at] += node
                return
            left = D[at, node[0]] <= node[1]
            walk(node[2], at[left])
            walk(node[3], at[~left])

        for t in ranker["trees"]:
            walk(t, np.arange(len(D)))
    return out


def cut(steps_, ids, scores, stops):
    """The score below which a stop at these places (0 the first) is more often unwanted than wanted (counting as training does),
    over these steps, every control with its score. None when no score is that low."""
    found, start = [], 0
    for s, i in zip(steps_, ids):
        part, wanted = scores[start : start + len(i)], relevance(s, i)
        start += len(i)
        found += [(part[j], 1 - 2 * (wanted[j] > 0), 1 if s["type"] in ("real", "live") else 0.5)
                  for j in np.argsort(-part, kind="stable")[stops]]
    found.sort(key=lambda t: t[0])
    gain = np.cumsum([sign * w for _, sign, w in found])  # hiding every stop up to this one: the unwanted hidden less the wanted
    k = int(gain.argmax()) if found else 0
    return math.floor(found[k][0]) + 1 if found and gain[k] > 0 else None


# a 3rd or 4th stop shows only from "sure"
ranker["sure"] = cut(held, held_ids, held_scores, slice(2, 4))


def report(name, steps_):
    """Over all steps and per kind of page, for the trees as written into jab.js, ranking every control as jab.js does: is the first
    stop wanted (what training rewards: the target, a pick still ahead of it, an also-fine one; not a pick already visited), is it
    a control the label says nothing about, how many of the 4 stops are wanted, is the target first, is it within the 4."""
    X, ids = rows(steps_, every=True)
    scores = predict(X)
    tally = collections.defaultdict(lambda: np.zeros(6))
    start = 0
    for s, i in zip(steps_, ids):
        stops = [i[j] for j in np.argsort(-scores[start : start + len(i)], kind="stable")[:4]]
        wanted = {c for c, r in zip(i, relevance(s, i)) if r}
        start += len(i)
        if stops:
            unknown = stops[0] in s.get("unjudged", ())
            row = [stops[0] in wanted, unknown, len(wanted & set(stops)) / 4, stops[0] == s["target"], s["target"] in stops, 1]
            for kind in {"all", s["type"]}:
                tally[kind] += row
    print(f"{name}:")
    for kind, (first, unknown, wanted, top1, top4, n) in sorted(tally.items(), key=lambda kv: (kv[0] != "all", kv[0])):
        print(f"  {kind:>9}: first stop wanted {first / n:.3f}", end=f" (unjudged {unknown / n:.3f})" if unknown else "")
        print(f"  stops wanted {wanted / n:.3f}  top-1 {top1 / n:.3f}  top-4 {top4 / n:.3f}  ({n:.0f} steps)")


report(f"{len(held)} held-out steps{' (also trained on)' if args.all else ''}", held)

# The model goes into jab.js, as the JSON inside its MODEL string. That string is in single quotes and taken as is, so the JSON
# must hold no single quote and no backslash.
model_json = json.dumps(ranker, separators=(",", ":"), ensure_ascii=False)
assert "'" not in model_json and "\\" not in model_json
jab = pathlib.Path(args.jab)
source, found = re.subn(r"(const MODEL =\s*')[^']*'", lambda m: m[1] + model_json + "'", jab.read_text(encoding="utf-8"))
assert found == 1, f"{jab} has no MODEL string"
jab.write_text(source, encoding="utf-8")
print(f"{len(trees)} trees, {len(ranker['features'])} features and {len(ranker['words'])} words written into {jab};", end=" ")
print(f"a 3rd or 4th stop shows from a score of {ranker['sure']}")

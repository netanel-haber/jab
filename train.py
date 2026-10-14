# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "scipy", "lightgbm", "regex"]
# ///
"""jab: which controls does a person want next?   uv run train.py steps.jsonl.gz jab.js [--all]

Trains a LightGBM LambdaRank ranker over every control of a page and writes its trees into jab.js (as JSON, in its MODEL string),
which puts the controls in the order of their scores. The shipped trees: --all.
steps.jsonl.gz (not included): 6,333 steps on 1,244 real sites, and 2,563 on 1,105 of the most visited sites whose robots.txt
allows it (904 as the page opens, 1,659 with something already focused), labelled by Claude from screenshots; and 8,674 steps on
5,000 generated pages (news, results, articles, feeds, listings, docs; landing pages, forms, search pages, apps, products, cookie
pop-ups; six languages), labelled by rule and counted at half weight; all collected by jab.js's own collector. One step per line:
{"split": "train"|"eval", "type": the kind of page ("real" or "live" for a real site), "page": {"path", "title", "desc", "scroll",
"h1", "query", "prose", "base"}, "controls": [jab.js collect()], "focus": the focused control or -1, "target": the control wanted
next, "picks": the ordered 4 a person would want, "ok": others that are also fine, "unjudged": controls the label says nothing
about, left out of training (optional)}.
Prints, for the "eval" steps, overall and per kind of page, with the trees as written into jab.js and every control ranked as jab.js
ranks them: whether the first stop is wanted (as training counts it: a pick already visited is not), how often it is a control the
label says nothing about, how many of the 4 stops are wanted, whether the target is first and whether it is within the 4. --all also
trains on them, for the file you ship."""

import argparse
import bisect
import collections
import gzip
import json
import math
import pathlib

import lightgbm as lgb
import numpy as np
import regex
import scipy.sparse as sp

ap = argparse.ArgumentParser()
ap.add_argument("steps")
ap.add_argument("jab")
ap.add_argument("--all", action="store_true")
args = ap.parse_args()

with gzip.open(args.steps, "rt", encoding="utf-8") as lines:
    steps = [json.loads(line) for line in lines]
train = [s for s in steps if args.all or s["split"] == "train"]
held = [s for s in steps if s["split"] == "eval"]

# Words in any script (two letters or more, vowel marks kept), without the commonest little words.
STOP = set(
    """the and for with from that this your you our are was were has have had not but all any can will into about its his her
    their they them there here than then also just been being more most very what when who how which where why per via off
    el la los las de del en un una uno unos que por con para es se al lo su sus le les des du et au aux est dans qui sur pas
    der die das und den dem des ein eine einer mit von zu im ist auf für nicht sie es wir ihr
    של את על עם זה זו כל או גם לא הוא היא אם כי
    и в во на с со по к ко из от для не что это как""".split()
)
words = lambda text: [w for w in regex.findall(r"\p{L}[\p{L}\p{M}]+", text.lower()) if w not in STOP]
control_words = lambda c: set(words(f"{c['label']} {c['href']} {c['name']} {c['ph']} {c['action']}"))
context_words = lambda c: set(words(f"{c['before']} {c['parent']} {c['around']}"))
page_words = lambda p: set(words(f"{p['path']} {p['title']} {p['desc']} {p['h1']} {p['query']}"))
href_path = lambda c: c["href"].split("#")[0].split("?")[0]  # where a link leads, without its query and fragment

matches = lambda pattern, text: regex.search(pattern, text) is not None
on_screen = lambda c: c["w"] >= 4 and c["h"] >= 4 and c["y"] + c["h"] >= 0 and c["y"] <= 900 and c["x"] <= 1280
# controls you type into
is_field = lambda c: matches(
    r"^(textarea|input (text|search|email|password|tel|url|number)|textbox|searchbox|combobox)$", c["kind"]
)
# reads like the action that finishes what you typed: one of these words, whole (no letter, mark, digit or _ beside it)
submit_like = lambda c: matches(
    r"(?<![\p{L}\p{M}\p{N}_])(send|submit|go|search|post|reply|comment|save|continue|next|sign in|log in|login|apply|ask)"
    r"(?![\p{L}\p{M}\p{N}_])",
    c["label"].lower(),
)


def vocabulary(items, n):
    """the n commonest, ties alphabetically, so the same data always gives the same columns"""
    counts = collections.Counter(items)
    return {k: i for i, k in enumerate(sorted(counts, key=lambda k: (-counts[k], k))[:n])}


KINDS = vocabulary((c["kind"] for s in train for c in s["controls"]), 30)
# the columns after the features: a word of the control ("w:"), of the text around it ("c:"), of the page ("p:")
WORDS = [
    *(f"w:{w}" for w in vocabulary((w for s in train for c in s["controls"] for w in control_words(c)), 1500)),
    *(f"c:{w}" for w in vocabulary((w for s in train for c in s["controls"] for w in context_words(c)), 400)),
    *(f"p:{w}" for w in vocabulary((w for s in train for w in page_words(s["page"])), 300)),
]
COLUMN = {w: j for j, w in enumerate(WORDS)}


def describe(step):
    """One dict of features per control except the focused one (it is already there), always in the same order: the columns'.
    Every count is computed once per page, so a page of thousands of controls stays cheap."""
    page, focus = step["page"], step["focus"]
    focused = next((c for c in step["controls"] if c["i"] == focus), None)
    controls = [c for c in step["controls"] if c["i"] != focus]
    shown = [c for c in controls if on_screen(c)]
    shown_y = sorted(c["y"] for c in shown)
    rank_of = lambda ordered: {c["i"]: r for r, c in enumerate(ordered)}
    shown_rank = rank_of(shown)
    inputs_shown = sum(c["kind"].startswith("input") for c in shown)
    # how much a control stands out by being a coloured, filled shape; 0 = the most colourful control on screen
    sat_rank = rank_of(sorted(shown, key=lambda c: -(c["sat"] if c["fill"] >= 0.5 else 0)))
    font_rank = rank_of(sorted(shown, key=lambda c: -c["font"]))  # 0 = the largest type on screen
    kind_count = collections.Counter(c["kind"] for c in controls)
    kind_seen = collections.Counter()
    label_count = collections.Counter(c["label"].strip().lower() for c in controls)
    href_count = collections.Counter(href_path(c) for c in controls)
    fields = [c for c in step["controls"] if is_field(c) and c["form"] >= 0]  # the typing fields that sit in a form
    form_fields = collections.Counter(c["form"] for c in fields)
    first_field = {}
    for c in fields:
        first_field.setdefault(c["form"], c["i"])
    in_form = lambda c, form: form >= 0 and c["form"] == form
    focus_form = focused["form"] if focused else -1
    empty_left = sum(not c["filled"] and in_form(c, focus_form) for c in fields if c["i"] != focus)
    # how much of what is on screen is covered by something on top
    known = [c for c in controls if c["hit"] >= 0]
    occluded_share = sum(c["hit"] == 0 for c in known) / len(known) if known else 0
    region_size = collections.Counter(c["region"] for c in controls if c["region"] >= 0)
    for c in controls:
        segments = [p for p in href_path(c).split("/") if p]
        in_focus_form = in_form(c, focus_form)
        yield (
            c,
            {
                # where it is on the page and on screen
                "x": c["x"] / 1280,
                "y": c["y"] / 900,
                "w": c["w"] / 1280,
                "h": c["h"] / 900,
                "index": c["i"],
                "index_frac": c["i"] / max(1, c["n"]),
                "count": c["n"],
                "screen_rank": shown_rank.get(c["i"], -1),
                "on_screen_count": len(shown),
                "controls_above": bisect.bisect_left(shown_y, c["y"]),
                "page_scroll": page["scroll"],
                # what it is
                "kind": KINDS.get(c["kind"], -1),
                "same_kind_rank": kind_seen[c["kind"]],
                "same_kind_count": kind_count[c["kind"]],
                "inputs_on_screen": inputs_shown,
                "label_len": len(c["label"]),
                "label_words": len(words(c["label"])),
                "no_parent_text": c["parent"] == "",
                "before_len": len(c["before"]),
                # where it sits relative to the control you are in
                "nothing_focused": focus < 0,
                "index_delta": c["i"] - focus if focused else 0,
                "focus_dy": (c["y"] - focused["y"]) / 900 if focused else 0,
                "focus_dist": math.hypot(c["x"] - focused["x"], c["y"] - focused["y"]) / 1000 if focused else 0,
                "focus_filled": bool(focused and focused["filled"]),
                "same_region": bool(focused) and c["region"] >= 0 and c["region"] == focused["region"],
                # its form: the submit button, the first field, how much is still empty
                "is_submit": c["submit"],
                "submit_like": submit_like(c),
                "first_field": is_field(c) and c["form"] >= 0 and first_field[c["form"]] == c["i"],
                "form_fields": form_fields[c["form"]] if c["form"] >= 0 else 0,
                "in_focus_form": in_focus_form,
                "after_focus": in_focus_form and c["i"] > focus,
                "empty_fields_left": empty_left,
                "empty_field": is_field(c) and not c["filled"],
                # how it looks
                "fill": c["fill"],
                "sat": c["sat"],
                "round": c["round"],
                "bold": c["bold"],
                "icon": c["icon"],
                "sat_rank": sat_rank.get(c["i"], -1),
                # the stack of layers above the page: on top or covered, how much of the view its layer covers and how high it is
                # stacked, and the size of its region
                "hit": c["hit"],
                "occluded_share": occluded_share,
                "lcover": c["lcover"],
                "lz": c["lz"],
                "foreground": occluded_share if c["layer"] >= 0 and c["hit"] == 1 else 0,
                "region_size": region_size[c["region"]] if c["region"] >= 0 else 0,
                # content or frame: a headline (heading level, type size next to the running text, which is largest), in the frame
                "heading": c["head"],
                "font": c["font"] / page["base"],
                "font_rank": font_rank.get(c["i"], -1),
                "in_frame": c["chrome"],
                # one of many alike (cards, results, rows; which one), in running text, said or linked again
                "alike": c["like"],
                "alike_index": c["at"],
                "prose": c["prose"],
                "label_repeats": label_count[c["label"].strip().lower()] - 1 if c["label"].strip() else 0,
                "href_repeats": href_count[href_path(c)] - 1 if href_path(c) else 0,
                # where it leads: how deep, a slug of words or a number (an article, a product)
                "href_depth": len(segments),
                "slug_words": len([w for w in regex.split(r"[-_]+", segments[-1]) if w]) if segments else 0,
                "href_number": matches(r"[0-9]{3,}", href_path(c)),
                # how much the page reads
                "page_prose": page["prose"],
            },
        )
        kind_seen[c["kind"]] += 1


FEATURES = list(
    next(f for s in train for _, f in describe(s))
)  # the columns: these, then a 0/1 column per word


def rows(steps_, every=False):
    """The rows the model sees, every step's controls one after another: the features, then a 0/1 per word of the control, of the
    text around it and of the page, as one sparse matrix; and each step's control ids. Training leaves out the controls the label
    says nothing about; every=True keeps them, as jab.js ranks them all."""
    dense, cols, ids = [], [], []
    for s in steps_:
        page = [f"p:{w}" for w in page_words(s["page"])]
        ids.append([])
        unjudged = set(s.get("unjudged", ()))
        for c, f in describe(s):
            if c["i"] in unjudged and not every:
                continue
            ids[-1].append(c["i"])
            dense.append(list(f.values()))
            mine = page + [f"w:{w}" for w in control_words(c)] + [f"c:{w}" for w in context_words(c)]
            cols.append(sorted({COLUMN[w] for w in mine if w in COLUMN}))
    indptr = np.cumsum([0] + [len(c) for c in cols])
    bags = sp.csr_matrix(
        (np.ones(indptr[-1]), np.array([j for c in cols for j in c], dtype=np.int64), indptr),
        shape=(len(cols), len(WORDS)),
    )
    return sp.hstack([sp.csr_matrix(np.array(dense, dtype=float).reshape(-1, len(FEATURES))), bags], format="csr"), ids


def relevance(s, ids):
    """3 the control wanted next, 2 the picks still ahead of it, 1 the also-fine ones, 0 the rest (and the picks already visited)."""
    p = s["picks"]
    ahead = set(p[p.index(s["target"]) + 1 :]) if s["target"] in p else set()
    return [3 if i == s["target"] else 2 if i in ahead else 1 if i in s["ok"] else 0 for i in ids]


X, ids = rows(train)
y = np.concatenate([relevance(s, i) for s, i in zip(train, ids)])
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
# The generated pages count half: they teach what few real sites show (forms, pop-ups, where the content is), and a model this
# small has to spend most of itself on the real sites, which are what jab is for.
weight = np.concatenate([np.full(len(i), 1 if s["type"] in ("real", "live") else 0.5) for s, i in zip(train, ids)])
model = lgb.train(params, lgb.Dataset(X, y, group=[len(i) for i in ids], weight=weight), num_boost_round=70)


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


if held:
    report(f"{len(held)} held-out steps{' (also trained on)' if args.all else ''}", held)

# The model goes into jab.js, as the JSON inside its MODEL string. That string is in single quotes and taken as is, so the JSON
# must hold no single quote and no backslash.
model_json = json.dumps(ranker, separators=(",", ":"), ensure_ascii=False)
assert "'" not in model_json and "\\" not in model_json
jab = pathlib.Path(args.jab)
source, found = regex.subn(r"(const MODEL =\s*')[^']*'", lambda m: m[1] + model_json + "'", jab.read_text(encoding="utf-8"))
assert found == 1, f"{jab} has no MODEL string"
jab.write_text(source, encoding="utf-8")
print(f"{len(trees)} trees, {len(ranker['features'])} features and {len(ranker['words'])} words written into {jab}")

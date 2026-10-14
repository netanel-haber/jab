// jab, in every page (a content script): finds the focusable controls, ranks them with the LightGBM trees at the end of this file
// (written there by train.py), handles Ctrl+Q and draws the badges. Nothing is cached per page: every press scores the page as it is
// right now.
{
  const SEL =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[role=button],[role=link],[role=textbox],[role=combobox],[role=searchbox],[role=checkbox],[role=tab],[role=menuitem]';
  const BOX =
    "form,dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[role=search],nav,header,footer,aside,main,section,fieldset,[role=banner],[role=navigation],[role=contentinfo],[role=menubar],[role=toolbar],[role=menu],[role=tablist]";
  const SUBMIT = "button:not([type=button],[type=reset]),input[type=submit],input[type=image]";
  // controls you type into; chat boxes and rich editors are not inputs
  const TYPED =
    "textarea,input:not([type=checkbox],[type=radio],[type=submit],[type=button],[type=reset],[type=image],[type=hidden],[type=file],[type=range],[type=color])";
  const EDITABLE = '[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]';
  const DIALOG = "dialog,[role=dialog],[role=alertdialog],[aria-modal=true]";
  const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const CHROME =
    "header,footer,nav,aside,[role=banner],[role=navigation],[role=contentinfo],[role=complementary],[role=menubar]";

  // by code point: slicing a string can split an emoji into a lone surrogate
  const cut = (s, n) => Array.from(s).slice(0, n).join("");
  const text = (e, n = 60) => cut((e?.innerText ?? e?.textContent ?? "").replace(/\s+/g, " ").trim(), n);
  const path = (url) => url.replace(/^https?:\/\/[^/]+/, "");
  const alive = (e) =>
    !e.disabled &&
    !e.inert &&
    e.getAttribute("aria-hidden") !== "true" &&
    e.checkVisibility({ visibilityProperty: true }) &&
    e.getClientRects().length > 0;
  const label = (e) =>
    e.getAttribute("aria-label") ||
    text(e.labels?.[0]) ||
    (e.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .join(" ")
      .trim() ||
    e.placeholder ||
    e.title ||
    (e.matches("input[type=submit],input[type=button]") ? e.value : text(e)) ||
    e.getAttribute("alt") ||
    e.querySelector("img")?.alt ||
    e.name ||
    "";
  const inView = (r) => r.bottom >= 0 && r.top <= innerHeight && r.right >= 0 && r.left <= innerWidth;
  const q = (v) => Math.floor(Math.round(v) / 10 + 0.5) * 10; // viewport pixels, to the nearest 10
  // every control, including those inside open shadow roots, in page order
  const deep = (root, out = []) => {
    for (const e of root.querySelectorAll("*")) {
      if (e.matches(SEL)) out.push(e);
      if (e.shadowRoot) deep(e.shadowRoot, out);
    }
    return out;
  };
  // the focused element, even inside a web component
  const active = () => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  // Every focusable, visible control, and the facts about each that train.py's features use. Nothing outlives the call.
  const collect = () => {
    const sticks = new Map(),
      regions = new Map(),
      layers = new Map(),
      groups = new Map();
    // the repeated item a control sits in (a card, a result, a row, a menu entry): how many siblings look alike (same tag and
    // first class), and which of them this one is
    const sig = (el) => `${el.tagName} ${(el.getAttribute("class") ?? "").trim().split(/\s+/)[0]}`;
    const itemOf = (e) => {
      for (let p = e, k = 0; k < 5 && p.parentElement; p = p.parentElement, k++) {
        if (!groups.has(p.parentElement)) {
          const g = new Map();
          for (const s of p.parentElement.children) g.get(sig(s))?.push(s) ?? g.set(sig(s), [s]);
          groups.set(p.parentElement, g);
        }
        const like = groups.get(p.parentElement).get(sig(p));
        if (like.length >= 3) return { el: p, n: like.length, at: like.indexOf(p) };
      }
      return null;
    };
    const isFixed = (el) => {
      if (!el || el == document.documentElement) return false;
      if (!sticks.has(el))
        sticks.set(el, /fixed|sticky/.test(getComputedStyle(el).position) || isFixed(el.parentElement));
      return sticks.get(el);
    };
    // the nearest ancestor that sits in its own layer above the page: fixed, or positioned with a z-index
    const layerOf = (el) => {
      for (let p = el.parentElement; p && p != document.documentElement; p = p.parentElement) {
        if (!layers.has(p)) {
          const st = getComputedStyle(p),
            z = parseInt(st.zIndex);
          const own = st.position == "fixed" || (/absolute|sticky/.test(st.position) && z > 0);
          const r = own && p.getBoundingClientRect();
          layers.set(
            p,
            own
              ? {
                  id: layers.size,
                  z: z > 0 ? z : 0,
                  rect: [r.left, r.top, r.width, r.height],
                }
              : null,
          );
        }
        if (layers.get(p)) return layers.get(p);
      }
      return null;
    };
    // is the control what you would hit at its centre (1), covered by something on top (0), or not on screen (-1)?
    const topmost = (e, r) => {
      if (r.width < 4 || r.height < 4 || !inView(r)) return -1;
      const t = document.elementFromPoint(
        Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1),
        Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1),
      );
      return t && (t == e || e.contains(t) || t.contains(e) || t.shadowRoot?.contains(e)) ? 1 : 0;
    };
    let els = deep(document).filter(alive);
    if (els.length > 5000) {
      // a safety valve for endless pages: the control you are in and its form, then what is on screen, then the rest in page order
      const form = active().closest("form");
      const keep = new Set(
        [
          ...els.filter((e) => e == active() || form?.contains(e)),
          ...els.filter((e) => inView(e.getBoundingClientRect())),
          ...els,
        ].slice(0, 5000),
      );
      els = els.filter((e) => keep.has(e));
    }
    const controls = els.map((e, i) => {
      const r = e.getBoundingClientRect(),
        b = e.parentElement?.closest(BOX),
        f = e.form ?? e.closest("form");
      const st = getComputedStyle(e),
        lay = layerOf(e);
      // how it looks: filled or not, how colourful, how round, how bold
      const [red = 0, green = 0, blue = 0, alpha = 1] = st.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [
        0, 0, 0, 0,
      ];
      const [lx, ly, lw, lh] = lay?.rect ?? [0, 0, 0, 0];
      let before = "";
      for (let p = e; p && !before; p = p.parentElement) before = text(p.previousElementSibling, 20);
      if (b && !regions.has(b)) regions.set(b, regions.size);
      // what it is about: a heading in or around it, the size of its type, the card or paragraph it sits in, where it leads
      const hd = e.closest(HEADING) ?? e.querySelector(HEADING),
        it = itemOf(e),
        block = e.parentElement?.closest("p,li,td,dd,blockquote,figcaption"),
        frame = e.closest(CHROME);
      const site = URL.parse(e.getAttribute("href") ?? "", location.href)?.host;
      const pics = [...e.querySelectorAll("img,video")].slice(0, 4).map((m) => {
        const p = m.getBoundingClientRect();
        return p.width * p.height;
      });
      if (st.backgroundImage.startsWith("url")) pics.push(r.width * r.height);
      return {
        i,
        n: els.length,
        form: f ? [...document.forms].indexOf(f) : -1,
        action: cut(path(f?.getAttribute("action") ?? ""), 30),
        submit: !!f && e.matches(SUBMIT),
        filled: e.matches(TYPED) ? !!e.value : e.matches(EDITABLE) && !!e.innerText.trim(),
        required: e.required === true,
        hit: topmost(e, r),
        region: b ? regions.get(b) : -1,
        dialog: !!e.closest(DIALOG),
        bar: !!e.closest("[role=menubar],[role=toolbar]"),
        fixed: isFixed(e),
        // the layer it sits in: how much of the view it covers, how high it is stacked, how many screen edges it touches
        layer: lay ? lay.id : -1,
        lcover: lay ? Math.min(1, (lw * lh) / (innerWidth * innerHeight)) : 0,
        lw: lay ? Math.min(1, lw / innerWidth) : 0,
        lh: lay ? Math.min(1, lh / innerHeight) : 0,
        lz: lay ? Math.log10(1 + lay.z) / 6 : 0,
        ledge: lay
          ? [lx <= 2, ly <= 2, lx + lw >= innerWidth - 2, ly + lh >= innerHeight - 2].filter(Boolean).length
          : 0,
        fill: alpha,
        sat: alpha ? (Math.max(red, green, blue) - Math.min(red, green, blue)) / (Math.max(red, green, blue) || 1) : 0,
        lum: alpha ? (0.299 * red + 0.587 * green + 0.114 * blue) / 255 : 0,
        round: Math.min(1, parseFloat(st.borderTopLeftRadius) / Math.max(1, Math.min(r.width, r.height) / 2) || 0),
        bold: (parseInt(st.fontWeight) || 400) / 1000,
        pointer: st.cursor == "pointer",
        icon: !!e.querySelector("svg,img"),
        kind: e.tagName == "INPUT" ? `input ${e.type}` : e.getAttribute("role") || e.tagName.toLowerCase(),
        label: cut(label(e), 50),
        box: b ? b.getAttribute("role") || b.tagName.toLowerCase() : "",
        name: e.name || e.id || "",
        ph: e.placeholder || "",
        href: cut(path(e.getAttribute("href") ?? ""), 40),
        before,
        parent: text(e.parentElement, 20),
        x: q(r.x),
        y: q(r.y),
        w: q(r.width),
        h: q(r.height),
        head: hd ? (/^H\d$/.test(hd.tagName) ? Number(hd.tagName[1]) : Number(hd.getAttribute("aria-level")) || 2) : 0,
        font: Math.round(parseFloat((hd && e.contains(hd) ? getComputedStyle(hd) : st).fontSize) || 0),
        art: !!e.closest("article,[role=article],[role=feed]"),
        main: !!e.closest("main,[role=main]"),
        // in the site's frame (header, nav, footer, sidebar), unless that frame belongs to an article
        chrome: !!frame && !frame.closest("article,[role=article],main,[role=main]"),
        ext: !!site && site != location.host,
        img: Math.round((Math.min(1, Math.max(0, ...pics) / (innerWidth * innerHeight)) || 0) * 1000) / 1000,
        like: it ? it.n : 0,
        at: it ? it.at : -1,
        prose: block ? text(block, 400).length : 0,
        around: text(it?.el ?? block, 80),
      };
    });
    return { els, controls };
  };

  // The overlay: numbered badges beside the four picks, and short notes so a failure is never silent.
  // It lives in a closed shadow root, so the page's own CSS and scripts cannot reach it; a constructed stylesheet is not blocked by a page's CSP.
  const host = Object.assign(document.createElement("div"), {
    id: "jab-overlay",
  });
  const root = host.attachShadow({ mode: "closed" }),
    sheet = new CSSStyleSheet();
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  sheet.replaceSync(`
    .badge { position: fixed; min-width: 18px; height: 18px; padding: 0 3px; box-sizing: border-box; border-radius: 9px; background: #2b6f4b; color: #fff; opacity: .85; font: 700 11px/18px system-ui, sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); }
    .badge.now { background: #00e676; color: #00210e; outline: 2px solid #00210e; box-shadow: 0 0 0 4px rgba(0, 230, 118, .55), 0 2px 6px rgba(0, 0, 0, .4); transform: scale(1.15); z-index: 1; }
    .badge.off { opacity: .65; }
    .note { position: fixed; right: 16px; bottom: 16px; max-width: 280px; padding: 6px 10px; border-radius: 6px; background: #1f4f35; color: #fff; font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 2px 6px rgba(0, 0, 0, .3); }`);
  root.adoptedStyleSheets = [sheet];
  const draw = (className, textContent) => {
    document.documentElement.append(host);
    return root.appendChild(Object.assign(document.createElement("div"), { className, textContent }));
  };
  const note = (message) => setTimeout((n) => n.remove(), 4000, draw("note", message));

  // A session: our top 4 picks and their badges. Ctrl+Q walks them; anything else you do ends it, and so do 10 s without a press.
  let ses = null,
    timer;
  // each badge sits on the top-left corner of its control, or at the screen edge with an arrow when the control is off screen; the focused one is drawn stronger
  const show = () =>
    ses?.badges.forEach((badge, i) => {
      const r = ses.els[i].getBoundingClientRect();
      const arrow =
        r.top >= innerHeight ? "↓" : r.bottom <= 0 ? "↑" : r.left >= innerWidth ? "→" : r.right <= 0 ? "←" : "";
      badge.textContent = `${i + 1}${arrow}`;
      badge.hidden = !r.width && !r.height; // the page has hidden it
      badge.classList.toggle("off", !!arrow);
      badge.classList.toggle("now", ses.els[i] == active());
      badge.style.cssText = `left: ${Math.min(Math.max(2, r.left - 8), innerWidth - 30)}px; top: ${Math.min(Math.max(2, r.top - 8), innerHeight - 22)}px`;
    });
  const end = () => {
    clearTimeout(timer);
    ses?.badges.forEach((badge) => badge.remove());
    ses = null;
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(end, 10000);
  };
  for (const type of ["scroll", "resize", "focusin"]) addEventListener(type, show, { capture: true, passive: true });
  setInterval(show, 300); // catches layout shifts that fire no event
  // focus left our picks (checked once it has moved, so a web component's retargeted events cannot fool it)
  addEventListener("focusout", () => setTimeout(() => ses && !ses.els.includes(active()) && end()), true);
  // typing, clicking, submitting, navigating: the next press re-ranks from there
  for (const type of ["input", "submit", "pointerdown", "popstate", "hashchange", "pagehide"])
    addEventListener(type, end, true);
  // a text field fires "change" when focus leaves it, which is jab moving on: only a select, checkbox or radio changing counts
  addEventListener("change", (e) => !e.target.matches?.(TYPED) && end(), true);
  // Ctrl+Q types nothing and Chrome does not use it; any other key (Enter, Escape, arrows, Tab, ...) ends the session
  // While Ctrl+Q is held down, a digit 1-4 goes straight to that stop; any other time Ctrl+digit is left to Chrome.
  // Inside a session, Ctrl+Q moves to the next stop only on a tap (let go within 0.4 s, no digit): holding it is for choosing.
  let held = false,
    tapped = 0;
  const ctrl = (e) => e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  const isPress = (e) => e.code == "KeyQ" && ctrl(e);
  const digit = (e) => (held && ctrl(e) && /^Digit[1-4]$/.test(e.code) ? Number(e.code[5]) : 0);
  // Focus pick i. A pick that does not take the focus (the page has since hidden it, or a pop-up keeps the focus to itself)
  // is replaced by the next control in the ranking, or dropped when the ranking runs out; with no pick left the session ends.
  const land = (i) => {
    while (ses?.els.length) {
      i %= ses.els.length;
      const el = ses.els[i];
      el.focus();
      if (active() == el) return touch(), show();
      if (ses.rest.length) ses.els[i] = ses.rest.shift();
      else {
        ses.els.splice(i, 1);
        ses.badges.splice(i, 1)[0].remove();
      }
    }
    end();
    note("jab could not move the focus here: the page keeps it where it is.");
  };
  const step = () => {
    // walk the stored picks, no recompute; going round to 1 again flashes its badge
    const next = (ses.els.indexOf(active()) + 1) % ses.els.length;
    if (next == 0) ses.badges[0].animate([{ transform: "scale(1.7)" }, { transform: "none" }], 450);
    land(next);
  };
  addEventListener(
    "keyup",
    (e) => {
      if (e.key != "Control" && e.code != "KeyQ") return;
      if (tapped && performance.now() - tapped < 400 && ses) step();
      held = false;
      tapped = 0;
    },
    true,
  );
  addEventListener("blur", () => (held = tapped = 0));
  addEventListener(
    "keydown",
    (e) => !isPress(e) && !digit(e) && !["Control", "Shift", "Alt", "Meta"].includes(e.key) && end(),
    true,
  );

  addEventListener(
    "keydown",
    (e) => {
      const n = digit(e);
      if (!isPress(e) && !n) return;
      if (!chrome.runtime?.id) return note("jab was reloaded: refresh this page to use it."); // a stale copy of this script leaves Ctrl+Q alone
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return; // holding the keys down is one press
      held = true;
      if (n) {
        // Ctrl+Q, then a digit: that stop
        tapped = 0; // a digit, not a tap
        if (ses && n <= ses.els.length) land(n - 1);
        return;
      }
      if (ses?.els.every((el) => el.isConnected)) {
        tapped = performance.now(); // inside a session: the move waits for the keys to be let go (see keyup)
        return touch();
      }
      end(); // no session, or a pick left the page (re-rendered): start over
      const from = active();
      try {
        const { els, controls } = collect();
        const paras = [...document.querySelectorAll("p")].slice(0, 400);
        let query = location.search.slice(1).replace(/\+/g, " ");
        try {
          query = decodeURIComponent(query); // a search page's query, mostly
        } catch {}
        const page = {
          path: location.pathname,
          title: document.title,
          desc: document.querySelector("meta[name=description]")?.content ?? "",
          // what the page says it is about, how much it reads, and the size of its running text
          h1: text(document.querySelector("h1"), 80),
          query: cut(query, 80),
          prose: Math.round(Math.min(50, paras.reduce((n, p) => n + p.textContent.length, 0) / 1000) * 10) / 10,
          base:
            parseFloat(
              getComputedStyle(paras.find((p) => text(p).length >= 60) ?? document.body ?? document.documentElement)
                .fontSize,
            ) || 16,
          scroll: Math.min(20, document.documentElement.scrollHeight / innerHeight),
        };
        const scores = rank(JSON.parse(MODEL), controls, els.indexOf(from), page);
        // the best four; the focused control has no score (null)
        const ranked = scores
          .map((v, i) => [v, els[i]])
          .filter(([v]) => v !== null)
          .sort((a, b) => b[0] - a[0])
          .slice(0, 24)
          .map(([, el]) => el);
        const best = ranked.slice(0, 4); // the next 20 stand in for a pick that turns out not to take the focus
        if (!best.length) return note("jab found nothing to jump to here.");
        ses = { els: best, rest: ranked.slice(4), badges: best.map((_, i) => draw("badge", i + 1)) };
        show();
        touch();
        land(0); // the first press lands on the best pick
      } catch (error) {
        note(`jab could not answer: ${error.message}`);
      }
    },
    true,
  );

  // The ranker: the LightGBM trees in MODEL (below, made by train.py) score every control of the page from cheap features (where it is,
  // what it is, how it looks, what is on top, what reads as content, its words), no neural network.
  // rank(model, controls, focus, page): controls as collect() returns them, focus the index of the focused control or -1.
  // Returns one score per control (the higher, the sooner); null for the focused one.
  // Every count is computed once per page, so thousands of controls stay cheap. The features are train.py's, by name.
  const STOP = new Set(
    `the and for with from that this your you our are was were has have had not but all any can will into about its his her
    their they them there here than then also just been being more most very what when who how which where why per via off
    el la los las de del en un una uno unos que por con para es se al lo su sus le les des du et au aux est dans qui sur pas
    der die das und den dem des ein eine einer mit von zu im ist auf für nicht sie es wir ihr
    של את על עם זה זו כל או גם לא הוא היא אם כי
    и в во на с со по к ко из от для не что это как`.split(/\s+/),
  );
  // words in any script (two letters or more, vowel marks kept), without the commonest little words
  const words = (s) => (s.toLowerCase().match(/\p{L}[\p{L}\p{M}]+/gu) ?? []).filter((w) => !STOP.has(w));
  const hrefPath = (c) => c.href.split("#")[0].split("?")[0]; // where a link leads, without its query and fragment
  const length = (s) => [...s].length;
  const onScreen = (c) => c.w >= 4 && c.h >= 4 && c.y + c.h >= 0 && c.y <= 900 && c.x <= 1280;
  const isField = (c) =>
    /^(textarea|input (text|search|email|password|tel|url|number)|textbox|searchbox|combobox)$/.test(c.kind); // controls you type into
  const count = (items) => items.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
  const rankOf = (ordered) => new Map(ordered.map((c, r) => [c.i, r]));
  // a tree: a node [feature, threshold, left, right] goes left when the feature is <= the threshold; a leaf is a number
  const walk = (node, x) => {
    while (Array.isArray(node)) node = x[node[0]] <= node[1] ? node[2] : node[3];
    return node;
  };

  const rank = (model, all, focus, page) => {
    const controls = all.filter((c) => c.i != focus),
      focused = all.find((c) => c.i == focus);
    const shown = controls.filter(onScreen),
      shownY = shown.map((c) => c.y).sort((a, b) => a - b),
      shownRank = rankOf(shown),
      inputsShown = shown.filter((c) => c.kind.startsWith("input")).length;
    // how much a control stands out by being a coloured, filled shape; 0 = the most colourful control on screen
    const colour = (c) => (c.fill >= 0.5 ? c.sat : 0);
    const satRank = rankOf([...shown].sort((a, b) => colour(b) - colour(a))),
      fontRank = rankOf([...shown].sort((a, b) => b.font - a.font)), // 0 = the largest type on screen
      headingRank = rankOf(controls.filter((c) => c.head)),
      contentRank = rankOf(controls.filter((c) => (c.art || c.main) && !c.chrome));
    const kindCount = count(controls.map((c) => c.kind)),
      kindSeen = new Map(),
      labelCount = count(controls.map((c) => c.label.trim().toLowerCase())),
      hrefCount = count(controls.map(hrefPath));
    const fields = all.filter((c) => isField(c) && c.form >= 0), // the typing fields that sit in a form
      formFields = count(fields.map((c) => c.form)),
      firstField = new Map();
    for (const c of fields) if (!firstField.has(c.form)) firstField.set(c.form, c.i);
    const inForm = (c, form) => form >= 0 && c.form == form;
    const focusForm = focused ? focused.form : -1,
      emptyLeft = fields.filter((c) => !c.filled && inForm(c, focusForm) && c.i != focus).length;
    // how much of what is on screen is covered by something on top, and by which layer
    const known = controls.filter((c) => c.hit >= 0),
      occludedShare = known.length ? known.filter((c) => c.hit == 0).length / known.length : 0;
    const layerSize = count(controls.filter((c) => c.layer >= 0).map((c) => c.layer)),
      layerKnown = count(known.filter((c) => c.layer >= 0).map((c) => c.layer)),
      layerHits = count(known.filter((c) => c.layer >= 0 && c.hit == 1).map((c) => c.layer)),
      regionSize = count(controls.filter((c) => c.region >= 0).map((c) => c.region));
    const same = (c, key) => !!focused && c[key] >= 0 && c[key] == focused[key]; // in the focused control's layer or region
    const titleWords = new Set(words(`${page.title} ${page.h1}`)),
      queryWords = new Set(words(page.query));
    // how many on-screen controls are above y
    const above = (y) => {
      let lo = 0,
        hi = shownY.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (shownY[mid] < y) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    // one row, reused for every control: the features, then a 0/1 per word of the control ("w:"), of the text around it ("c:")
    // and of the page ("p:", those stay set)
    const nf = model.features.length,
      x = new Float64Array(nf + model.words.length),
      column = new Map(model.words.map((w, j) => [w, nf + j]));
    const columns = (prefix, text) =>
      [...new Set(words(text))].map((w) => column.get(prefix + w)).filter((j) => j !== undefined);
    for (const j of columns("p:", `${page.path} ${page.title} ${page.desc} ${page.h1} ${page.query}`)) x[j] = 1;
    const scores = [];
    for (const c of controls) {
      const label = new Set(words(c.label)),
        segments = hrefPath(c).split("/").filter(Boolean),
        inFocusForm = inForm(c, focusForm);
      const overlap = (set) => (label.size ? [...label].filter((w) => set.has(w)).length / label.size : 0);
      const f = {
        // where it is on the page and on screen
        x: c.x / 1280,
        y: c.y / 900,
        w: c.w / 1280,
        h: c.h / 900,
        index: c.i,
        index_frac: c.i / Math.max(1, c.n),
        count: c.n,
        screen_rank: shownRank.get(c.i) ?? -1,
        on_screen_count: shown.length,
        controls_above: above(c.y),
        page_scroll: page.scroll,
        // what it is
        kind: model.kinds[c.kind] ?? -1,
        box: model.boxes[c.box] ?? -1,
        same_kind_rank: kindSeen.get(c.kind) ?? 0,
        same_kind_count: kindCount.get(c.kind),
        inputs_on_screen: inputsShown,
        label_len: length(c.label),
        label_words: words(c.label).length,
        no_parent_text: c.parent == "",
        before_len: length(c.before),
        // where it sits relative to the control you are in
        nothing_focused: focus < 0,
        index_delta: focused ? c.i - focus : 0,
        focus_dx: focused ? (c.x - focused.x) / 1280 : 0,
        focus_dy: focused ? (c.y - focused.y) / 900 : 0,
        focus_dist: focused ? Math.hypot(c.x - focused.x, c.y - focused.y) / 1000 : 0,
        focus_filled: !!focused?.filled,
        focus_in_layer: !!focused && focused.layer >= 0,
        same_layer: same(c, "layer"),
        same_region: same(c, "region"),
        // its form: the submit button, the first field, how much is still empty
        required: c.required,
        is_submit: c.submit,
        submit_like:
          /\b(send|submit|go|search|post|reply|comment|save|continue|next|sign in|log in|login|apply|ask)\b/.test(
            c.label.toLowerCase(),
          ),
        dismissive: /^(clear|reset|cancel|close|dismiss|decline|no thanks|skip|back)\b/.test(c.label.toLowerCase()),
        first_field: isField(c) && c.form >= 0 && firstField.get(c.form) == c.i,
        form_fields: c.form >= 0 ? (formFields.get(c.form) ?? 0) : 0,
        in_focus_form: inFocusForm,
        after_focus: inFocusForm && c.i > focus,
        empty_fields_left: emptyLeft,
        empty_field: isField(c) && !c.filled,
        // how it looks
        fill: c.fill,
        sat: c.sat,
        lum: c.lum,
        round: c.round,
        bold: c.bold,
        pointer: c.pointer,
        icon: c.icon,
        sat_rank: satRank.get(c.i) ?? -1,
        // the stack of layers above the page: on top or covered, its own layer's size and place, what the site is presenting
        hit: c.hit,
        occluded_share: occludedShare,
        in_layer: c.layer >= 0,
        lcover: c.lcover,
        lw: c.lw,
        lh: c.lh,
        lz: c.lz,
        ledge: c.ledge,
        layer_size: c.layer >= 0 ? layerSize.get(c.layer) : 0,
        layer_hit_share: layerKnown.get(c.layer) ? (layerHits.get(c.layer) ?? 0) / layerKnown.get(c.layer) : 1,
        foreground: c.layer >= 0 && c.hit == 1 ? occludedShare : 0,
        region_size: c.region >= 0 ? regionSize.get(c.region) : 0,
        in_dialog: c.dialog,
        bar: c.bar,
        fixed: c.fixed,
        // content or frame: a headline (heading level, which heading, type size next to the running text), in an article or main,
        // in the site's frame, which of the content's controls it is
        heading: c.head,
        heading_rank: headingRank.get(c.i) ?? -1,
        font: c.font / page.base,
        font_rank: fontRank.get(c.i) ?? -1,
        in_article: c.art,
        in_main: c.main,
        in_frame: c.chrome,
        content_rank: contentRank.get(c.i) ?? -1,
        // one of many alike (cards, results, rows; which one), with a picture, in running text, said or linked again
        alike: c.like,
        alike_index: c.at,
        image: c.img,
        prose: c.prose,
        label_repeats: c.label.trim() ? labelCount.get(c.label.trim().toLowerCase()) - 1 : 0,
        href_repeats: hrefPath(c) ? hrefCount.get(hrefPath(c)) - 1 : 0,
        // where it leads: another site, a spot on this page, how deep, a slug of words or a number (an article, a product)
        external: c.ext,
        fragment: c.href.startsWith("#"),
        href_depth: segments.length,
        slug_words: segments.length ? segments.at(-1).split(/[-_]+/).filter(Boolean).length : 0,
        href_number: /[0-9]{3,}/.test(hrefPath(c)),
        // what it says next to what the page is about
        title_overlap: overlap(titleWords),
        query_overlap: overlap(queryWords),
        page_prose: page.prose,
      };
      kindSeen.set(c.kind, (kindSeen.get(c.kind) ?? 0) + 1);
      model.features.forEach((name, j) => (x[j] = Number(f[name])));
      const set = [
        ...columns("w:", `${c.label} ${c.href} ${c.name} ${c.ph} ${c.action}`),
        ...columns("c:", `${c.before} ${c.parent} ${c.around}`),
      ];
      for (const j of set) x[j] = 1;
      scores.push(model.trees.reduce((sum, tree) => sum + walk(tree, x), 0));
      for (const j of set) x[j] = 0;
    }
    let k = 0;
    return all.map((c) => (c.i == focus ? null : scores[k++]));
  };
  // The trees, as JSON (written here by train.py, see there). Only a press parses them, so a page that never asks never holds them.
  const MODEL =
    '{"features":["x","y","w","h","index","index_frac","count","screen_rank","on_screen_count","controls_above","page_scroll","kind","same_kind_rank","same_kind_count","inputs_on_screen","label_len","label_words","no_parent_text","before_len","nothing_focused","index_delta","focus_dx","focus_dy","focus_dist","focus_filled","same_region","is_submit","submit_like","first_field","form_fields","in_focus_form","after_focus","empty_fields_left","empty_field","fill","sat","round","bold","icon","sat_rank","hit","occluded_share","lcover","lz","ledge","layer_size","layer_hit_share","foreground","region_size","fixed","heading","font","font_rank","in_frame","content_rank","alike","alike_index","prose","label_repeats","href_repeats","href_depth","slug_words","href_number","title_overlap","page_prose"],"kinds":{"a":0,"button":1,"input text":2,"tab":3,"input checkbox":4,"link":5,"menuitem":6,"input email":7,"div":8,"select":9,"input search":10,"summary":11,"input submit":12,"input radio":13,"textarea":14,"input password":15,"input number":16,"span":17,"tabpanel":18,"li":19,"input tel":20,"region":21,"combobox":22,"iframe":23,"group":24,"listitem":25,"textbox":26,"img":27,"checkbox":28,"dialog":29},"boxes":{"":0,"section":1,"main":2,"footer":3,"nav":4,"header":5,"form":6,"navigation":7,"contentinfo":8,"aside":9,"tablist":10,"dialog":11,"fieldset":12,"menu":13,"search":14},"words":["w:item","w:search","w:docs","w:privacy","w:products","w:blog","w:home","w:login","w:company","w:get","w:resources","w:features","w:support","w:up","w:free","w:slide","w:careers","w:cookie","w:sign","w:ago","w:reviews","w:signup","w:opens","w:skip","w:pricing","w:logo","w:started","w:community","w:download","w:image","w:dp","w:partners","w:subscribe","w:demo","w:author","w:language","w:close","w:hl","w:register","w:accept","w:documentation","w:message","w:agree","w:max","w:sdk","w:sort","w:academics","w:xs","w:admissions","w:forgot","w:min","c:by","c:comments","c:free","c:start","c:log","c:started","c:docs","c:download","c:box","c:español","c:source","c:guides","c:request","c:outdoor","p:news","p:docs"],"trees":[[7,0,[31,0,[7,-1,[57,24,-37,-10],[36,0.0835,-19,20]],35],[3,0.04,[53,0,[48,0,3,21],[64,1.45,-22,18]],29]],[31,0,[2,0.06,[5,0.08121,-6,-20],[24,0,[39,-1,-21,[38,0,[34,0.035,[57,44,4,25],17],-7]],-25]],[20,1,36,5]],[40,0,[29,0,-22,13],[56,2,[28,0,[37,0.495,[31,0,[55,8,[10,3.04,-7,5],21],20],[1,0.03,2,15]],28],-15]],[40,-1,[31,0,-22,14],[34,0.68,[52,6,[20,0,3,16],[25,0,[2,0.074,-15,-3],7]],[2,0.02,-32,[15,42,14,-9]]]],[40,0,[25,0,[4,26,-10,-23],[20,2,20,-10]],[29,0,[2,0.066,[10,2.8,-14,1],[35,0.407,[52,3,9,1],13]],15]],[40,-1,[30,0,-20,14],[33,0,[37,0.495,[26,0,[24,0,[52,13,2,[47,0.144,-10,11]],-16],18],[25,0,5,14]],19]],[1,0.94,[31,0,[2,0.05,-8,[24,0,[40,0,[64,0,0,-28],[28,0,5,19]],[64,0,-22,2]]],17],[30,0,-18,12]],[40,-1,[25,0,-18,7],[36,0.03233,[20,0,[56,0,[55,12,[33,0,-3,16],24],-12],[20,2,18,-4]],[22,0.17,9,-1]]],[23,1.32546,[34,0.77,[2,0.098,[1,0.583,[25,0,-4,7],[27,0,-16,17]],[40,0,-7,[20,-1,-5,7]]],[22,0.217,9,-2]],-20],[40,0,[12,18,-3,-18],[56,3,[22,-0.03,-2,[22,0.17,[104,0,[25,0,[1,0.06,-4,[52,4,13,2]],12],29],-3]],-11]],[22,0.75,[20,0,[40,0,-11,[36,0.0745,[2,0.137,[0,0.074,-14,-3],[19,0,-10,7]],5]],[20,1,19,[20,7,5,-6]]],-17],[23,1.32546,[33,0,[35,0.1534,[40,0,[25,0,-11,4],[3,0.017,-17,[61,2,[38,0,[57,45,0,12],-6],8]]],8],14],-18],[1,1.794,[27,0,[2,0.05,-9,[20,-1,-4,[53,0,[20,12,[1,0.07,-3,[52,3,13,5]],-6],-8]]],11],[30,0,-19,10]],[22,0.46,[20,0,[38,0,[18,19,[3,0.03,[89,0,-9,30],0],[76,0,4,-27]],-8],[20,3,12,-1]],[1,1.74,-7,-20]],[40,0,[12,29,[64,1.95,[25,0,-5,8],-24],-17],[3,0.04,[27,0,[51,1.016,-4,[60,0,-18,11]],10],[16,0,-11,5]]],[20,18,[20,0,[56,0,[1,2.13,[38,0,2,-6],-19],[57,75,[89,0,-11,27],9]],[20,1,14,[51,0.93,-1,8]]],-11],[23,1.39596,[33,0,[37,0.495,[57,93,[3,0.03,[2,0.2,-9,7],-1],[51,0.99996,-12,15]],3],[20,-1,[25,0,4,-39],14]],-16],[23,1.8012,[53,0,[26,0,[51,0.9335,[7,0,-14,[39,3,5,[56,0,-1,-13]]],[52,1,11,2]],13],[1,0.23,-4,-18]],-17],[12,46,[2,0.027,-10,[20,-1,-3,[25,0,[104,0,[1,0.65,[1,0.05,[27,0,-8,10],5],[57,40,-6,11]],19],8]]],-10],[40,0,[64,1.85,[57,22,[12,9,[51,0.814,2,-22],-11],20],-22],[2,0.176,[47,0.693,[66,0,-1,8],10],[20,-1,-8,7]]],[1,2.217,[53,0,[3,0.017,-13,[38,0,[52,2,[20,-1,-1,[2,0.24,6,17]],1],-3]],[10,3.204,-11,-1]],[30,0,-18,5]],[20,27,[20,0,[2,0.027,-11,[104,0,[74,0,[28,0,-2,9],12],[19,0,-17,25]]],[20,4,[26,0,6,19],-2]],-10],[12,50,[53,0,[26,0,[15,1,-16,[61,0,[33,0,[11,2,[42,0.2446,-4,10],-16],8],[24,0,4,-11]]],11],-5],-9],[23,2.6311,[2,0.027,-8,[98,0,[2,0.215,[89,0,[27,0,[57,83,[56,1,-1,-9],[55,4,-7,16]],6],15],4],17]],-17],[33,0,[1,2.806,[11,2,[17,0,[2,0.02,-17,[68,0,1,-19]],-8],[2,0.105,[11,8,-11,12],-19]],-15],[14,11,9,-41]],[22,0.33,[20,0,[35,0.1037,[52,9,[57,28,-1,9],-5],[97,0,6,-25]],[20,1,[43,0.52,12,-9],1]],[2,0.098,-12,-2]],[104,0,[1,0.77,[56,3,[1,0.04,-2,2],-9],[51,0.925,-8,[53,0,[40,-1,[41,0,[64,1.95,24,-22],-19],-3],-21]]],13],[40,0,[64,1.95,[57,21,-4,[41,0,21,-26]],-22],[3,0.04,-1,[61,0,[3,0.25,[20,-1,-5,3],-25],[0,0.45,8,1]]]],[50,2,[36,0.05483,[27,0,[57,92,[15,25,[0,0.035,-11,[1,0.54,[89,0,-2,19],-8]],1],[6,87,13,-5]],6],2],9],[3,0.017,-11,[38,0,[2,0.215,[124,0,[47,0,[57,75,[59,0,-3,2],9],4],21],[20,-1,[30,0,-4,-35],7]],-3]],[23,2.6752,[90,0,[79,0,[27,0,[33,0,[17,0,[11,2,0,[2,0.176,-4,-24]],-8],[14,9,9,-32]],5],11],-29],-16],[20,27,[20,0,[47,0.596,[9,24,[61,0,-3,[59,0,-2,4]],-6],8],[20,4,[26,0,4,[32,0,21,-8]],-1]],-7],[53,0,[67,0,[51,1.043,[22,0.13,[31,0,[15,4,-6,1],10],-5],[64,0.35,11,1]],[0,0.082,-18,18]],[40,0,-21,-3]],[2,0.215,[79,0,[12,51,[5,0.97041,-1,8],-8],10],[20,-1,[30,0,-4,-33],[41,0,[52,1,[51,0.8122,-10,19],3],0]]],[50,2,[34,0.77,[27,0,[89,0,[2,0.066,[101,0,[112,0,-6,37],19],[55,7,-2,4]],10],6],[110,0,2,-41]],8],[0,0.95,[113,0,[31,0,[23,3.91476,[76,0,[102,0,[53,0,1,-4],-26],[60,1,10,-29]],-18],[15,11,12,-2]],26],-10],[86,0,[88,0,[58,11,[75,0,[1,2.94,[85,0,[53,0,[67,0,1,12],-3],-20],[30,0,-17,4]],-15],-16],-30],11],[87,0,[47,0.068,[2,0.105,[15,8,1,[57,74,-5,7]],[20,-1,[22,-0.17,1,-10],[49,0,[0,0.63,4,-2],-5]]],4],-19],[22,0.283,[31,0,[93,0,[79,0,[104,0,[56,3,[55,9,0,6],[52,4,4,-10]],12],10],17],[15,18,10,-7]],-4],[3,0.017,-9,[113,0,[68,0,[128,0,[90,0,[86,0,[53,0,0,[9,13,[124,0,-3,19],-16]],9],-26],16],-16],22]],[83,0,[50,2,[66,0,[40,0,[64,1.95,[54,2,[48,14,-2,-12],[41,0.0147,13,-23]],-21],0],5],[41,0.092,8,-17]],8],[38,0,[2,0.246,0,[20,-1,[20,-7,5,-17],[52,1,[10,5.003,16,-5],3]]],[117,0,[17,0,[52,0,-11,1],-9],-35]],[9,28,[62,0,[0,0.035,[124,0,[1,0.06,-24,-3],22],[7,0,[13,72,-2,-17],1]],[20,-2,-11,[52,4,10,1]]],-3],[82,0,[2,0.01,-17,[67,0,[0,0.94,[120,0,[2,0.105,[56,0,0,-6],[11,7,2,-7]],7],-9],[0,0.082,-19,14]]],-18],[20,-9,[64,0,[0,0.348,3,-5],[124,0,-11,24]],[20,6,[21,0.05,[76,0,0,-19],[23,0.229,9,2]],[0,0.24,2,-5]]],[98,0,[58,11,[33,0,[1,3.47,[61,0,[42,0.992,[69,0,-3,21],8],[51,1.043,0,5]],-13],[23,0.162,9,-2]],-15],12],[96,0,[85,0,[92,0,[12,147,[94,0,[87,0,[119,0,[47,0.693,[68,0,0,-17],6],8],-16],-22],-12],-22],-18],-23],[22,0.15,[31,0,[1,0.03,[51,0.634,1,[63,0.77,[0,0.87,-2,-14],-24]],[39,5,3,0]],[114,0,9,-27]],[62,0,-4,4]],[123,0,[66,0,[37,0.43,[12,0,3,-2],[0,0.31,[1,0.03,[0,0.09,-26,1],5],-1]],[32,0,6,[13,1,-42,2]]],12],[31,0,[1,3.85,[11,2,0,[1,0.43,-1,-14]],-17],[26,0,[33,0,-10,[20,1,24,[32,1,28,-14]]],[32,0,20,-7]]],[72,0,[31,0,[1,3.47,[91,0,[78,0,[104,0,[52,2,2,-1],[51,0,[19,0,-37,23],24]],10],8],-15],6],6],[127,0,[71,0,[9,26,[112,0,1,32],[46,0.254,-19,[106,0,[37,0.495,[67,0,-6,9],2],24]]],[7,5,-21,1]],-27],[80,0,[99,0,[84,0,[65,0,[22,0.283,[86,0,[20,0,-1,[20,1,7,0]],10],[8,10,-13,-2]],8],-28],-22],-21],[15,0,-8,[58,10,[1,0.03,[15,8,1,[43,0.285,[124,0,[8,12,0,-12],17],-1]],[76,0,[102,0,1,-27],-18]],-13]],[61,3,[112,0,[118,0,[58,1,0,[4,7,4,[55,3,-3,[50,2,[64,0.45,-23,-5],7]]]],7],34],[0,0.324,8,-2]],[2,0.535,[2,0.246,[9,19,[112,0,0,28],[5,0.948964,[10,1.484,-13,[45,9,-2,-15]],[64,0,[23,0,12,-15],12]]],3],-7],[97,0,[121,0,[66,0,[101,0,[2,0.043,[67,0,[89,0,[112,0,[55,3,-3,-13],34],19],22],0],13],4],8],-15],[113,0,[105,0,[51,2.003,[5,0.97703,[88,0,0,-27],[64,0,[23,0,13,[104,0,-4,-39]],13]],[23,0.162,19,-15]],17],18],[104,0,[107,0,[59,0,[12,0,2,-2],[60,0,-6,[85,0,[12,52,3,-6],-35]]],20],[51,0,[19,0,-33,21],22]],[93,0,[81,0,[20,-8,[33,0,[91,0,-4,18],10],[11,2,1,[12,0,[2,0.06,12,[115,0,-2,-48]],-12]]],-21],11],[108,0,[82,0,[70,0,[16,0,[29,0,-7,10],[100,0,[129,0,[0,1.44,[126,0,0,-17],-20],-28],-17]],-12],-14],-33],[104,0,[2,0.707,[77,0,[1,0.694,0,[51,0.93,[34,0.92,-8,1],[7,3,7,-3]]],-11],-9],[51,0,[19,0,-25,19],21]],[20,-10,[56,0,-1,-11],[3,0.017,[1,0.117,7,-11],[109,0,[57,228,[57,84,0,[20,-1,-28,[10,3.904,9,-13]]],-14],-31]]],[44,3,[72,0,[62,0,[78,0,-1,8],[52,4,[20,-1,-16,[99,0,[10,5.3633,9,-5],-30]],[56,4,2,-12]]],5],6],[2,0.01,-14,[94,0,[90,0,[0,0.95,[18,19,[48,23,[67,0,0,10],-6],1],[131,0,-9,[12,21,-19,27]]],-22],-20]],[40,0,[64,1.95,[41,0,[51,0.715,-12,[36,0.03233,11,-19]],[51,0,[7,-1,[30,0,-22,3],0],-26]],-23],[56,4,1,-7]],[111,0,[113,0,[31,0,[118,0,[104,0,[62,0,[0,0.035,[131,0,-4,-24],-1],2],8],6],[3,0.03,-7,8]],16],20],[122,0,[121,0,[33,0,[73,0,0,-17],[20,-1,[20,-5,7,[51,0.885,-32,18]],7]],6],[6,51,16,[131,0,6,-31]]],[11,-1,-16,[95,0,[125,0,[37,0.495,[116,0,[57,98,[56,0,0,[89,0,-5,18]],6],[55,6,-14,9]],1],-24],13]],[68,0,[111,0,[103,0,[1,0.05,[51,0.94,[15,17,[89,0,0,12],-8],[48,5,[130,0,-9,-35],1]],0],10],18],-12]]}';
}

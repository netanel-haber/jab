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
  const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const CHROME =
    "header,footer,nav,aside,[role=banner],[role=navigation],[role=contentinfo],[role=complementary],[role=menubar]";

  // by code point: slicing a string can split an emoji into a lone surrogate
  const cut = (s, n) => Array.from(s).slice(0, n).join("");
  const text = (e, n = 60) => cut((e?.innerText ?? e?.textContent ?? "").replace(/\s+/g, " ").trim(), n);
  const path = (url) => url.replace(/^https?:\/\/[^/]+/, "");
  // the element around e, out of a shadow root to its host: what is inside a web component sits where the component sits
  const up = (e) => e.parentElement ?? e.parentNode?.host ?? null;
  // closest() and contains() through shadow roots: inside the web component, then from the component on out
  const near = (e, sel) => {
    for (; e; e = e.getRootNode().host) {
      const c = e.closest(sel);
      if (c) return c;
    }
    return null;
  };
  const holds = (a, e) => {
    for (; e; e = e.getRootNode().host) if (a.contains(e)) return true;
    return false;
  };
  // usable: not disabled (by itself or by its fieldset), not inert (by itself or by what it is in), and drawn
  const alive = (e) =>
    !e.matches(":disabled") &&
    !near(e, "[inert]") &&
    e.getAttribute("aria-hidden") !== "true" &&
    e.checkVisibility({ visibilityProperty: true }) &&
    e.getClientRects().length > 0;
  const label = (e) =>
    e.getAttribute("aria-label") ||
    text(e.labels?.[0]) ||
    (e.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => text(e.getRootNode().getElementById(id)))
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
    const regions = new Map(),
      forms = new Map(),
      layers = new Map(),
      groups = new Map();
    // the repeated item a control sits in (a card, a result, a row, a menu entry): how many siblings look alike (same tag and
    // first class), and which of them this one is
    const sig = (el) => `${el.tagName} ${(el.getAttribute("class") ?? "").trim().split(/\s+/)[0]}`;
    const itemOf = (e) => {
      for (let p = e, k = 0; k < 5 && up(p); p = up(p), k++) {
        // p's siblings: those in its parent, or at the top of the same shadow root
        if (!groups.has(p.parentNode)) {
          const g = new Map();
          for (const s of p.parentNode.children) g.get(sig(s))?.push(s) ?? g.set(sig(s), [s]);
          groups.set(p.parentNode, g);
        }
        const like = groups.get(p.parentNode).get(sig(p));
        if (like.length >= 3) return { el: p, n: like.length, at: like.indexOf(p) };
      }
      return null;
    };
    // the nearest ancestor that sits in its own layer above the page: fixed, or positioned with a z-index
    const layerOf = (el) => {
      for (let p = up(el); p && p != document.documentElement; p = up(p)) {
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
                  area: r.width * r.height,
                }
              : null,
          );
        }
        if (layers.get(p)) return layers.get(p);
      }
      return null;
    };
    // is the control what you would hit at its centre (1), covered by something on top (0), or not on screen (-1)? The page names
    // the outermost web component there; that component's shadow root names what is inside it, and so on down
    const topmost = (e, r) => {
      if (r.width < 4 || r.height < 4 || !inView(r)) return -1;
      const x = Math.min(Math.max(r.x + r.width / 2, 0), innerWidth - 1),
        y = Math.min(Math.max(r.y + r.height / 2, 0), innerHeight - 1);
      let t = document.elementFromPoint(x, y);
      for (let s; (s = t?.shadowRoot?.elementFromPoint(x, y)) && s != t; ) t = s;
      return t && (holds(e, t) || holds(t, e)) ? 1 : 0;
    };
    // an open modal dialog leaves the rest of the page inert
    const modal = document.querySelector(":modal");
    let els = deep(document).filter((e) => alive(e) && (!modal || holds(modal, e)));
    if (els.length > 5000) {
      // a safety valve for endless pages: the control you are in and its form, then what is on screen, then the rest in page order
      const form = near(active(), "form");
      const keep = new Set(
        [
          ...els.filter((e) => e == active() || (form && holds(form, e))),
          ...els.filter((e) => inView(e.getBoundingClientRect())),
          ...els,
        ].slice(0, 5000),
      );
      els = els.filter((e) => keep.has(e));
    }
    const controls = els.map((e, i) => {
      const r = e.getBoundingClientRect(),
        b = near(up(e), BOX),
        f = e.form ?? near(e, "form");
      const st = getComputedStyle(e),
        lay = layerOf(e);
      // how it looks: filled or not, how colourful, how round, how bold
      const [red = 0, green = 0, blue = 0, alpha = 1] = st.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [
        0, 0, 0, 0,
      ];
      let before = "";
      for (let p = e; p && !before; p = up(p)) before = text(p.previousElementSibling, 20);
      if (b && !regions.has(b)) regions.set(b, regions.size);
      if (f && !forms.has(f)) forms.set(f, forms.size);
      // what it is about: a heading in or around it, the size of its type, the card or paragraph it sits in
      const hd = near(e, HEADING) ?? e.querySelector(HEADING),
        it = itemOf(e),
        block = near(up(e), "p,li,td,dd,blockquote,figcaption"),
        frame = near(e, CHROME);
      return {
        i,
        n: els.length,
        form: f ? forms.get(f) : -1,
        action: cut(path(f?.getAttribute("action") ?? ""), 30),
        submit: !!f && e.matches(SUBMIT),
        filled: e.matches(TYPED) ? !!e.value : e.matches(EDITABLE) && !!e.innerText.trim(),
        hit: topmost(e, r),
        region: b ? regions.get(b) : -1,
        // the layer it sits in: how much of the view it covers, how high it is stacked
        layer: lay ? lay.id : -1,
        lcover: lay ? Math.min(1, lay.area / (innerWidth * innerHeight)) : 0,
        lz: lay ? Math.log10(1 + lay.z) / 6 : 0,
        fill: alpha,
        sat: alpha ? (Math.max(red, green, blue) - Math.min(red, green, blue)) / (Math.max(red, green, blue) || 1) : 0,
        round: Math.min(1, parseFloat(st.borderTopLeftRadius) / Math.max(1, Math.min(r.width, r.height) / 2) || 0),
        bold: (parseInt(st.fontWeight) || 400) / 1000,
        icon: !!e.querySelector("svg,img"),
        kind: e.tagName == "INPUT" ? `input ${e.type}` : e.getAttribute("role") || e.tagName.toLowerCase(),
        label: cut(label(e), 50),
        name: e.name || e.id || "",
        ph: e.placeholder || "",
        href: cut(path(e.getAttribute("href") ?? ""), 40),
        before,
        parent: text(up(e), 20),
        x: q(r.x),
        y: q(r.y),
        w: q(r.width),
        h: q(r.height),
        head: hd ? (/^H\d$/.test(hd.tagName) ? Number(hd.tagName[1]) : Number(hd.getAttribute("aria-level")) || 2) : 0,
        font: Math.round(parseFloat((hd && e.contains(hd) ? getComputedStyle(hd) : st).fontSize) || 0),
        // in the site's frame (header, nav, footer, sidebar), unless that frame belongs to an article
        chrome: !!frame && !near(frame, "article,[role=article],main,[role=main]"),
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

  // A session: our top 4 picks and their badges. The first Ctrl+Q only lights pick 1 (lit): nothing is focused, so nothing opens,
  // and Enter uses it. A tap of Ctrl+Q, or Ctrl+Q and a digit, is you choosing: the focus goes to that pick, and from there on your
  // keys are the page's again. Anything else you do ends the session, and so do 10 s without a press.
  let ses = null,
    timer;
  // each badge sits on the top-left corner of its control, or at the screen edge with an arrow when the control is off screen; the
  // lit or focused one is drawn stronger, and the lit one has ↵ for Enter
  const show = () =>
    ses?.badges.forEach((badge, i) => {
      const r = ses.els[i].getBoundingClientRect();
      const arrow =
        r.top >= innerHeight ? "↓" : r.bottom <= 0 ? "↑" : r.left >= innerWidth ? "→" : r.right <= 0 ? "←" : "";
      const lit = ses.lit && i == 0;
      badge.textContent = `${i + 1}${arrow}${lit ? " ↵" : ""}`;
      badge.hidden = !r.width && !r.height; // the page has hidden it
      badge.classList.toggle("off", !!arrow);
      badge.classList.toggle("now", lit || ses.els[i] == active());
      badge.style.cssText = `left: ${Math.min(Math.max(2, r.left - 8), innerWidth - 44)}px; top: ${Math.min(Math.max(2, r.top - 8), innerHeight - 22)}px`;
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
  // focus left our picks after jab moved it there (checked once it has moved, so a web component's retargeted events cannot fool it)
  addEventListener("focusout", () => setTimeout(() => ses && !ses.lit && !ses.els.includes(active()) && end()), true);
  // typing, clicking, submitting, navigating: the next press re-ranks from there
  for (const type of ["input", "submit", "pointerdown", "popstate", "hashchange", "pagehide"])
    addEventListener(type, end, true);
  // a text field fires "change" when focus leaves it, which is jab moving on: only a select, checkbox or radio changing counts
  addEventListener("change", (e) => !e.target.matches?.(TYPED) && end(), true);
  // a field you type into: while it is lit, the keys you press go into it, and Enter only puts the focus there
  const typable = (el) => (el.matches(TYPED) && !el.readOnly) || el.isContentEditable;
  // Enter or typing on the lit pick: end the session and put the focus there. Enter (press) also clicks it, unless it is a field you
  // type into: a button is pressed, a link followed, a box ticked, a read-only field (a date picker, mostly) opened.
  const use = (el, press) => {
    end();
    if (!el.isConnected) return note("That control has left the page: press Ctrl+Q again.");
    el.focus();
    if (press && !typable(el)) el.click();
    else if (active() != el) note("jab could not move the focus here: the page keeps it where it is.");
  };
  // Ctrl+Q types nothing and Chrome does not use it. While Ctrl+Q is held down, a digit 1-4 puts the focus on that pick; any other
  // time Ctrl+digit is left to Chrome. Inside a session, Ctrl+Q moves the focus to the next pick only on a tap (let go within 0.4 s,
  // no digit): holding it is for choosing.
  let held = false,
    tapped = 0;
  const ctrl = (e) => e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  const isPress = (e) => e.code == "KeyQ" && ctrl(e);
  const digit = (e) => (held && ctrl(e) && /^Digit[1-4]$/.test(e.code) ? Number(e.code[5]) : 0);
  // Focus pick i. A pick that does not take the focus (the page has since hidden it, or a pop-up keeps the focus to itself)
  // is replaced by the next control in the ranking, or dropped when the ranking runs out; with no pick left the session ends.
  const land = (i) => {
    ses.lit = false;
    while (ses.els.length) {
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
    // walk the stored picks, no recompute, from the lit or focused one; going round to 1 again flashes its badge
    const next = ((ses.lit ? 0 : ses.els.indexOf(active())) + 1) % ses.els.length;
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
  // A key while pick 1 is lit: Enter uses it, a key that types a character goes into it when it is a field (the focus moves there
  // first; the page's own shortcuts never see that key), Escape only ends the session. Any other key, and any key once the focus is
  // on a pick, ends the session and does what it always does, where the focus is.
  addEventListener(
    "keydown",
    (e) => {
      if (!ses || isPress(e) || digit(e) || ["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return;
      if (!ses.lit) return end();
      const el = ses.els[0],
        plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key == "Enter" && plain && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        use(el, true);
      } else if (e.key.length == 1 && (plain || e.getModifierState("AltGraph")) && typable(el)) {
        e.stopImmediatePropagation(); // not cancelled: the character lands in the field
        use(el, false);
      } else {
        if (e.key == "Escape") e.preventDefault(), e.stopImmediatePropagation();
        end();
      }
    },
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
        // Ctrl+Q, then a digit: the focus goes to that pick
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
        // a link to this very page would only load it again (one with a #fragment moves within it, and a role=button one is the
        // page's script), so it is never a pick
        const reloads = (e) => {
          const href = e.getAttribute("href")?.trim();
          return (
            e instanceof HTMLAnchorElement &&
            !!href &&
            !href.includes("#") &&
            e.getAttribute("role") != "button" &&
            e.href == location.href.split("#")[0]
          );
        };
        // the best four; the focused control has no score (null)
        const ranked = scores
          .map((v, i) => [v, els[i]])
          .filter(([v, el]) => v !== null && !reloads(el))
          .sort((a, b) => b[0] - a[0])
          .slice(0, 24)
          .map(([, el]) => el);
        const best = ranked.slice(0, 4); // the next 20 stand in for a pick that turns out not to take the focus
        if (!best.length) return note("jab found nothing to jump to here.");
        ses = { els: best, rest: ranked.slice(4), badges: best.map((_, i) => draw("badge", i + 1)), lit: true };
        best[0].scrollIntoView({ block: "nearest", inline: "nearest" }); // the first press only lights the best pick, in view
        show();
        touch();
      } catch (error) {
        note(`jab could not answer: ${error.message}`);
      }
    },
    true,
  );

  // The ranker: the LightGBM trees in MODEL (below, made by train.py) score every control of the page from cheap features (where it is,
  // what it is, how it looks, what is on top, what reads as content, its words), no neural network.
  // describe(kinds, controls, focus, page): controls as collect() returns them, focus the index of the focused control or -1.
  // What the trees see: the page's words, and for every control but the focused one, in page order, its features and its words.
  // train.py learns from the same describe(), loading this file under Node. rank(model, controls, focus, page) scores them: one
  // score per control (the higher, the sooner), null for the focused one.
  // Every count is computed once per page, so thousands of controls stay cheap.
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
  // on screen as the trees learned it: within the 1280x900 every training page was captured at. Measuring a window against its own
  // size instead picked worse on the hand-labelled test pages; that needs training pages captured at other sizes first.
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

  const describe = (kinds, all, focus, page) => {
    const controls = all.filter((c) => c.i != focus),
      focused = all.find((c) => c.i == focus);
    const shown = controls.filter(onScreen),
      shownY = shown.map((c) => c.y).sort((a, b) => a - b),
      shownRank = rankOf(shown),
      inputsShown = shown.filter((c) => c.kind.startsWith("input")).length;
    // how much a control stands out by being a coloured, filled shape; 0 = the most colourful control on screen
    const colour = (c) => (c.fill >= 0.5 ? c.sat : 0);
    const satRank = rankOf([...shown].sort((a, b) => colour(b) - colour(a))),
      fontRank = rankOf([...shown].sort((a, b) => b.font - a.font)); // 0 = the largest type on screen
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
    // how much of what is on screen is covered by something on top
    const known = controls.filter((c) => c.hit >= 0),
      occludedShare = known.length ? known.filter((c) => c.hit == 0).length / known.length : 0;
    const regionSize = count(controls.filter((c) => c.region >= 0).map((c) => c.region));
    const pageSegments = page.path.split("/").filter(Boolean);
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
    // a text's words, each with what it is the word of: the control ("w:"), the text around it ("c:"), the page ("p:")
    const tagged = (prefix, text) => [...new Set(words(text))].map((w) => prefix + w);
    const each = controls.map((c) => {
      const segments = hrefPath(c).split("/").filter(Boolean),
        inFocusForm = inForm(c, focusForm);
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
        kind: kinds[c.kind] ?? -1,
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
        focus_dy: focused ? (c.y - focused.y) / 900 : 0,
        focus_dist: focused ? Math.hypot(c.x - focused.x, c.y - focused.y) / 1000 : 0,
        focus_filled: !!focused?.filled,
        same_region: !!focused && c.region >= 0 && c.region == focused.region,
        // its form: the submit button, the first field, how much is still empty
        is_submit: c.submit,
        submit_like:
          /(?<![\p{L}\p{M}\p{N}_])(send|submit|go|search|post|reply|comment|save|continue|next|sign in|log in|login|apply|ask)(?![\p{L}\p{M}\p{N}_])/u.test(
            c.label.toLowerCase(),
          ),
        first_field: isField(c) && c.form >= 0 && firstField.get(c.form) == c.i,
        form_fields: c.form >= 0 ? (formFields.get(c.form) ?? 0) : 0,
        in_focus_form: inFocusForm,
        after_focus: inFocusForm && c.i > focus,
        empty_fields_left: emptyLeft,
        empty_field: isField(c) && !c.filled,
        // how it looks
        fill: c.fill,
        sat: c.sat,
        round: c.round,
        bold: c.bold,
        icon: c.icon,
        sat_rank: satRank.get(c.i) ?? -1,
        // the stack of layers above the page: on top or covered, how much of the view its layer covers and how high it is stacked,
        // and the size of its region
        hit: c.hit,
        occluded_share: occludedShare,
        lcover: c.lcover,
        lz: c.lz,
        foreground: c.layer >= 0 && c.hit == 1 ? occludedShare : 0,
        region_size: c.region >= 0 ? regionSize.get(c.region) : 0,
        // content or frame: a headline (heading level, type size next to the running text, which is largest), in the frame
        heading: c.head,
        font: c.font / page.base,
        font_rank: fontRank.get(c.i) ?? -1,
        in_frame: c.chrome,
        // one of many alike (cards, results, rows; which one), in running text, said or linked again
        alike: c.like,
        alike_index: c.at,
        prose: c.prose,
        label_repeats: c.label.trim() ? labelCount.get(c.label.trim().toLowerCase()) - 1 : 0,
        href_repeats: hrefPath(c) ? hrefCount.get(hrefPath(c)) - 1 : 0,
        // where it leads: how deep, a slug of words or a number (an article, a product)
        href_depth: segments.length,
        slug_words: segments.length ? segments.at(-1).split(/[-_]+/).filter(Boolean).length : 0,
        href_number: /[0-9]{3,}/.test(hrefPath(c)),
        // how much the page reads
        page_prose: page.prose,
        // the page's own address: how deep, a slug of words or a number at its end (an article, a product, a model)
        page_depth: pageSegments.length,
        page_slug_words: pageSegments.length ? pageSegments.at(-1).split(/[-_]+/).filter(Boolean).length : 0,
        page_number: /[0-9]{3,}/.test(page.path),
      };
      kindSeen.set(c.kind, (kindSeen.get(c.kind) ?? 0) + 1);
      const own = [
        ...tagged("w:", `${c.label} ${c.href} ${c.name} ${c.ph} ${c.action}`),
        ...tagged("c:", `${c.before} ${c.parent} ${c.around}`),
      ];
      return { features: f, words: own };
    });
    return { page: tagged("p:", `${page.path} ${page.title} ${page.desc} ${page.h1} ${page.query}`), controls: each };
  };
  const rank = (model, all, focus, page) => {
    const seen = describe(model.kinds, all, focus, page);
    // one row, reused for every control: the features, then a 0/1 per word (the page's stay set)
    const nf = model.features.length,
      x = new Float64Array(nf + model.words.length),
      column = new Map(model.words.map((w, j) => [w, nf + j]));
    const columns = (tags) => tags.map((w) => column.get(w)).filter((j) => j !== undefined);
    for (const j of columns(seen.page)) x[j] = 1;
    const scores = seen.controls.map((d) => {
      model.features.forEach((name, j) => (x[j] = Number(d.features[name])));
      const set = columns(d.words);
      for (const j of set) x[j] = 1;
      const score = model.trees.reduce((sum, tree) => sum + walk(tree, x), 0);
      for (const j of set) x[j] = 0;
      return score;
    });
    let k = 0;
    return all.map((c) => (c.i == focus ? null : scores[k++]));
  };
  // The trees, as JSON (written here by train.py, see there). Only a press parses them, so a page that never asks never holds them.
  const MODEL =
    '{"features":["x","y","w","h","index","index_frac","screen_rank","on_screen_count","controls_above","page_scroll","kind","same_kind_rank","same_kind_count","inputs_on_screen","label_len","label_words","no_parent_text","before_len","nothing_focused","index_delta","focus_dy","focus_dist","focus_filled","same_region","is_submit","submit_like","first_field","form_fields","in_focus_form","after_focus","empty_fields_left","empty_field","fill","sat","round","bold","icon","sat_rank","hit","occluded_share","lcover","lz","foreground","region_size","heading","font","font_rank","in_frame","alike","alike_index","prose","label_repeats","href_repeats","href_depth","slug_words","href_number","page_prose","page_depth","page_slug_words","page_number"],"kinds":{"a":0,"button":1,"input text":2,"tab":3,"input checkbox":4,"link":5,"menuitem":6,"input email":7,"div":8,"select":9,"summary":10,"input search":11,"input radio":12,"input submit":13,"textarea":14,"input password":15,"input number":16,"span":17,"li":18,"tabpanel":19,"region":20,"input tel":21,"combobox":22,"iframe":23,"radio":24,"group":25,"listitem":26,"img":27,"textbox":28,"checkbox":29},"words":["w:item","w:search","w:docs","w:privacy","w:products","w:home","w:login","w:company","w:get","w:support","w:resources","w:features","w:free","w:careers","w:cookie","w:slide","w:sign","w:opens","w:reviews","w:ago","w:hours","w:pricing","w:signup","w:skip","w:fk","w:start","w:download","w:logo","w:name","w:started","w:community","w:image","w:dp","w:partners","w:author","w:demo","w:subscribe","w:close","w:hl","w:request","w:register","w:accept","w:documentation","w:message","w:max","w:sort","w:sdk","w:only","w:academics","w:admissions","w:xs","w:advertisement","w:min","c:in","c:by","c:comments","c:free","c:pricing","c:start","c:log","c:started","c:docs","c:download","c:box","c:chat","c:español","c:request","p:docs"],"trees":[[6,0,[28,0,[6,-1,[50,28,-37,-12],[34,0.0801,-19,19]],34],[9,3.254,[2,0.082,[48,0,11,-19],24],[20,-0.983,-36,27]]],[29,0,[31,0,[47,0,[22,0,[6,1,-11,[37,1,22,[46,1,21,[42,0.609,0,26]]]],-27],-17],23],[19,2,34,-2]],[38,0,[23,0,-22,[20,0.106,18,-10]],[49,3,[3,0.04,[48,7,[25,0,-4,16],18],[26,0,[35,0.495,6,16],29]],-18]],[1,0.95,[34,0.070595,[23,0,[46,9,[1,0.07,[0,0.082,-24,-1],7],-8],[24,0,7,28]],11],[29,0,-22,[19,1,25,-14]]],[6,-1,[28,0,-21,15],[2,0.066,[24,0,[1,0.43,-3,-17],22],[32,0.996,[19,-1,-3,[45,1.022,3,14]],[20,0.13,15,2]]]],[46,-1,[29,0,-20,15],[32,0.996,[46,3,9,[25,0,[2,0.06,[81,0,-13,22],-2],10]],[19,-1,0,[3,0.017,-31,13]]]],[38,0,[29,0,[4,28,[56,1.95,-6,-28],-21],14],[2,0.098,[23,0,[49,0,-1,-11],[24,0,6,23]],[21,0.2513,10,4]]],[38,0,[27,0,-16,8],[31,0,[47,0,[19,6,[19,0,[22,0,3,-19],[19,1,22,7]],-5],[9,3.485,-15,3]],16]],[38,0,[11,17,[29,0,-8,13],-19],[2,0.05,[29,0,-7,18],[19,-1,-2,[26,0,[23,0,[101,0,2,24],14],23]]]],[38,-1,[23,0,[50,38,-19,2],5],[49,1,[36,0,[3,0.03,[48,8,-2,14],7],-3],[50,83,[35,0.41,-12,1],9]]],[1,1.74,[47,0,[20,0.217,[19,0,[33,0.10296,[22,0,0,-17],10],[19,1,21,4]],-5],[9,3.327,-14,-2]],[28,0,-20,8]],[38,0,[29,0,[1,2.25,-8,-20],[19,4,16,-27]],[2,0.12,[3,0.03,-6,[36,0,4,-5]],[19,-1,-4,[46,3,14,5]]]],[38,0,[11,19,-3,-17],[31,0,[35,0.423,[24,0,[2,0.027,-13,[50,94,-2,12]],15],[1,0.04,[0,0.066,-30,0],7]],13]],[19,12,[19,0,[49,0,[38,0,-8,[2,0.043,-6,[19,-1,-1,[1,0.06,-5,8]]]],[50,74,-10,6]],[19,2,14,1]],-11],[1,1.906,[2,0.05,[25,0,[117,0,-9,19],7],[36,0,[2,0.246,[37,3,6,[46,13,2,-4]],9],-4]],[28,0,-19,6]],[20,0.46,[19,0,[32,0.035,[50,28,[38,0,-11,-3],[57,1,-1,16]],[101,0,3,22]],[19,4,[19,1,15,6],-2]],-11],[21,1.3026,[47,0,[27,0,[35,0.495,[62,0,[14,4,-12,[11,34,[53,0,-5,2],-11]],17],5],8],[38,0,-23,-4]],-17],[20,0.75,[31,0,[33,0.1534,[54,0,[24,0,[123,0,-7,26],12],[45,1.016,[11,52,[22,0,1,-13],-13],8]],7],11],-13],[1,2.17,[31,0,[35,0.423,[46,6,[50,43,[27,2,[38,0,-8,2],-28],15],[3,0.04,-7,-1]],3],9],[29,0,-18,6]],[19,27,[47,0,[19,-1,-3,[101,0,[26,0,[23,0,[1,0.74,2,[58,5,-6,18]],8],18],25]],[1,0.23,-3,-17]],-11],[38,0,[56,1.95,[50,40,[21,1.3244,-3,-17],[39,0,29,-25]],-22],[34,0.1228,[2,0.152,-2,[19,-1,-10,[10,7,6,-8]]],4]],[21,1.84323,[2,0.027,-9,[47,0,[36,0,[46,2,[9,4.024,10,[6,0,-8,6]],1],-3],[38,0,-22,[57,0,1,-10]]]],-16],[20,0.33,[19,0,[49,3,[48,12,[33,0.464,-2,[96,0,6,-23]],10],-9],[19,3,[24,0,7,18],-1]],[2,0.098,-13,-2]],[3,0.017,-13,[36,0,[50,44,[3,0.03,[44,2,-4,14],[105,0,2,-42]],[45,0.927,-11,12]],[16,0,-2,[25,0,-15,5]]]],[19,8,[19,0,[47,0,[26,0,[72,0,-1,14],[28,0,17,-42]],-6],[19,1,[31,0,8,25],[45,0.866668,-1,8]]],-6],[1,2.57,[25,0,[2,0.066,[14,8,[81,0,-2,18],-9],[10,2,[1,0.03,[123,0,-6,22],3],[31,0,-13,4]]],6],-13],[29,0,[1,2.84,[14,0,-14,[2,0.027,-8,[87,0,[63,0,[52,0,0,[54,0,-8,4]],-17],-30]]],-18],[14,18,12,-10]],[29,0,[1,2.84,[101,0,[54,2,[1,0.67,[49,3,[58,6,1,-17],-11],-5],4],[45,0,[18,0,-35,25],24]],-17],8],[47,0,[3,0.017,-11,[77,0,[31,0,1,[13,9,[19,-1,[23,0,8,-38],12],-27]],-21]],[38,0,-22,[57,1,0,-12]]],[38,0,[56,1.85,[50,22,[24,0,-5,14],[39,0,23,-26]],-22],[49,2,[48,9,[114,0,1,-16],[19,-1,-16,10]],-5]],[68,0,[2,0.215,[50,89,[49,0,[95,0,-1,16],[81,0,-7,20]],[57,1,-5,19]],[19,-1,-7,[36,0,7,-2]]],10],[11,52,[1,0.04,[57,1,[0,0.09,-13,1],[123,0,[45,0.575,-3,-24],24]],[71,0,[2,0.01,-19,[78,0,2,-22]],-23]],-7],[76,0,[29,0,[1,3.37,[15,0,-10,[10,2,[2,0.19,[116,0,[42,0.693,-1,7],11],[19,-1,-6,5]],-6]],-17],7],10],[0,0.02,[123,0,[1,0.06,-23,-4],21],[3,0.017,-9,[0,0.348,[3,0.05,1,6],[19,4,[19,0,[82,0,-1,14],5],-6]]]],[101,0,[63,0,[29,0,[53,0,[40,0.992,[110,0,-3,44],10],[17,19,[81,0,[113,0,-3,8],13],3]],6],-16],12],[19,31,[47,0,[62,0,[61,0,[2,0.043,-5,[10,-1,-24,1]],7],[0,0.035,-24,14]],[57,0,[1,0.23,2,-12],-9]],-8],[21,3.0214,[36,0,[46,2,[55,0,2,[19,-1,-25,[39,0.048,[46,0,25,8],-13]]],[119,0,0,9]],[16,0,-1,-8]],-16],[109,0,[31,0,[35,0.423,[50,99,[25,0,[38,0,[9,3.765,-1,-12],-2],4],[57,1,-5,14]],2],[112,0,6,-50]],24],[20,0.17,[19,0,[42,0.693,[86,0,-1,17],8],[24,0,[31,0,2,14],16]],[45,0.93,[37,0,-15,-4],[37,0,12,-1]]],[72,0,[44,2,[1,0.77,[49,1,1,[38,0,-23,-3]],[45,0.883,[32,0.815,-11,0],[9,1.4547,[103,0,-17,23],4]]],7],9],[98,0,[87,0,[74,0,[70,0,[51,11,[47,0,[0,0.934,1,-8],[57,0,[8,13,2,-14],-8]],-13],-14],-16],-27],-25],[109,0,[55,0,[34,0.09023,[54,4,[0,0.035,-7,[62,0,[11,21,-1,-7],11]],6],[48,7,[14,34,2,-7],-10]],4],21],[82,0,[1,0.03,[57,1,[14,8,2,-5],-14],[46,4,[39,0.0184,[48,7,3,[19,-1,-26,13]],[38,-1,-16,1]],-1]],10],[86,0,[61,0,[91,0,[2,0.02,-10,[10,-1,-20,[78,0,[1,0.03,[57,0,-1,-8],0],-19]]],-27],[59,0,6,-30]],13],[95,0,[11,66,[106,0,[5,0.970363,[52,0,[51,0,0,-6],[16,0,2,-12]],[56,0,[18,0,-13,13],14]],-34],-7],11],[94,0,[98,0,[29,0,[10,2,0,[13,9,-4,-24]],[19,1,[31,0,[24,0,-14,21],24],[30,1,6,-14]]],-24],-24],[65,0,[46,4,[48,8,[11,65,[62,0,1,15],-16],[56,0,16,3]],[49,0,0,[38,0,-17,[41,0.50032,-4,9]]]],-9],[126,0,[8,26,[110,0,[102,0,[60,0,[64,0,0,9],9],19],33],[103,0,[45,1.0425,-4,[49,9,0,23]],23]],14],[68,0,[19,-9,[31,0,-4,10],[84,0,[79,0,[10,2,0,[12,1,[2,0.06,15,-2],[8,12,-3,-16]]],-27],12]],7],[85,0,[1,0.583,1,[9,1.4547,[103,0,-10,21],[45,0.9234,[38,-1,-12,-1],[38,-1,[56,1.95,13,-20],[38,0,-30,1]]]]],10],[109,0,[29,0,[15,0,-7,[17,19,-1,[48,7,0,5]]],[24,0,[31,0,[46,2,-27,-1],12],[30,0,21,-7]]],18],[51,11,[0,0.473,[47,0,2,-4],[127,0,[41,0.581,-2,[45,0.504,[18,0,[1,0.206,7,-19],11],12]],[11,14,-12,22]]],-13],[93,0,[83,0,[74,0,[123,0,[120,0,[42,0.0372,[2,0.12,-2,[41,0,2,-6]],2],7],[10,0,-24,23]],-14],-27],-21],[66,0,[97,0,[8,27,[1,0.04,[57,0,[81,0,[62,0,-1,21],15],-8],[71,0,[19,-1,-2,2],-19]],-3],14],6],[61,0,[55,0,[38,0,[56,1.95,[37,14,-1,-9],-22],0],[46,1,9,[49,4,2,-12]]],[30,0,5,[43,1,-37,1]]],[100,0,[111,0,[3,0.017,-7,[29,0,[1,4.117,[55,0,0,[46,0,[39,0.117,13,-19],[49,3,3,-8]]],-16],6]],-38],12],[106,0,[118,0,[44,2,[20,0.13,[19,0,[42,0.699,-1,6],[19,1,[41,0.515,9,-14],0]],-3],[57,1,1,16]],7],-32],[2,0.582,[2,0.246,[82,0,[40,0.35663,[8,24,[110,0,0,28],-4],6],9],[41,0,4,-6]],[115,0,[21,0.0704,3,-14],-39]],[108,0,[63,0,[75,0,[90,0,[69,0,[87,0,[126,0,[0,1.44,[45,2.003,0,11],-22],11],-23],-11],-19],-20],-11],18],[104,0,[31,0,[19,-9,-3,[61,0,[16,0,0,[27,0,-8,9]],6]],[43,2,[23,0,1,[22,0,-37,26]],9]],-28],[78,0,[122,0,[76,0,[1,0.04,[58,0,0,[45,0.546,-1,-13]],[19,-1,[1,0.23,0,-5],[51,1,1,-4]]],6],9],-18],[5,0.02944,[65,0,3,-18],[0,0.254,[35,0.423,[15,2,[45,0.666,3,-8],4],4],[62,0,[38,0,[12,86,-3,-13],-1],11]]],[101,0,[89,0,[61,0,[37,2,[3,0.094,2,-8],-1],[59,0,4,-27]],[20,0.394,10,-15]],[18,0,[45,0,-31,22],19]],[2,0.535,[101,0,[116,0,[2,0.215,[50,79,[50,39,-1,-11],[52,4,[9,5.392,10,-7],-13]],2],6],9],[115,0,-5,-36]],[73,0,[91,0,[88,0,[10,-1,-14,[5,0.9737,[1,0.74,[38,0,[56,0,0,-23],[1,0.206,0,2]],-2],6]],10],-19],-22],[125,0,[77,0,[80,0,[60,0,[100,0,[25,0,[1,0.017,[124,0,-4,22],[94,0,0,-22]],3],10],7],-27],-14],-25],[2,0.01,-13,[109,0,[63,0,[92,0,[33,0.8838,[0,0.324,1,-1],[41,0.285,1,[107,0,10,-30]]],13],[45,0.438,-24,-2]],15]],[43,1,[29,0,[1,0.04,[57,0,-2,[7,10,-1,-19]],[19,-1,[23,0,-4,-28],0]],14],[72,0,0,[20,0.15,11,-14]]],[99,0,[23,0,[26,0,-1,[43,2,[58,2,2,-24],16]],[20,-0.05,[17,2,20,-9],[26,0,[24,0,3,14],-31]]],13],[86,0,[67,0,[121,0,[0,0.94,[66,0,[10,-1,-16,0],5],[127,0,-9,17]],[57,1,[2,0.035,27,6],-27]],-12],9]]}';
  // for train.py, which loads this file under Node and learns from describe()
  if (typeof module == "object") module.exports = { describe };
}

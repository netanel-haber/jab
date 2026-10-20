// jab, a smart tab, in every page (a content script): finds the focusable controls, ranks them with the LightGBM trees at the end
// of this file (written there by train.py), handles Ctrl+Q and draws the badges. Nothing is cached per page: every press scores the
// page as it is right now.
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
  // a field for searching: by what it is (type=search, a searchbox, in a search landmark), its name, or what it says it is for
  const SEARCH =
    /search|suche|busca|búsqueda|recherch|cerca|pesquis|zoek|szukaj|hledat|keres|arama|поиск|найти|пошук|חיפוש|חפש|بحث|جستجو|検索|搜索|搜尋|검색|tìm|cari|ค้นหา|खोज/i;
  // a link or button that opens the site's search counts too, if it says no more than that (a few words) or goes to a search page
  const isSearch = (e) =>
    (e.matches(`${TYPED},[role=searchbox],[role=combobox]`) &&
      (e.matches("input[type=search],[role=searchbox]") ||
        !!near(e, "[role=search],search") ||
        /^(q|query|s|k|keyword|keywords)$/.test(e.name ?? "") ||
        SEARCH.test(`${label(e)} ${e.name ?? ""} ${e.id} ${e.form?.getAttribute("action") ?? ""}`))) ||
    (e.matches("a[href],button,[role=button]") &&
      label(e).trim().split(/\s+/).length <= 3 &&
      SEARCH.test(`${label(e)} ${e instanceof HTMLAnchorElement ? new URL(e.href).pathname : ""}`));
  // an ad, never a pick: what sits in an ad slot (by the ids and classes the ad systems give them) and frames or links that go to an
  // ad network
  const AD_SLOT =
    '[id^="google_ads_"],[id^="div-gpt-ad"],[id^="aswift_"],ins.adsbygoogle,[data-google-query-id],[data-ad-slot],[id^="taboola"],.OUTBRAIN';
  const AD_HOST =
    /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|amazon-adsystem\.com|taboola\.com|outbrain\.com|criteo\.(com|net)|pubmatic\.com|rubiconproject\.com|adform\.net|smartadserver\.com|teads\.tv|moatads\.com|media\.net|adsrvr\.org|openx\.net)$/;
  const isAd = (e) => {
    if (near(e, AD_SLOT)) return true;
    try {
      const to = e instanceof HTMLIFrameElement ? e.src : e instanceof HTMLAnchorElement ? e.href : "";
      return !!to && AD_HOST.test(new URL(to).hostname);
    } catch {
      return false;
    }
  };
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

  // A session: our 2 to 4 picks and their badges. The first Ctrl+Q only lights pick 1 (lit): nothing is focused, so nothing opens,
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
          // the window it is seen in
          vw: innerWidth,
          vh: innerHeight,
        };
        const model = JSON.parse(MODEL),
          scores = rank(model, controls, els.indexOf(from), page);
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
        // every control by its score (the focused one has none: null), and of two that lead to the same place only the better one
        const place = places(controls),
          taken = new Set();
        const order = scores
          .map((v, i) => [v, els[i], controls[i]])
          .filter(([v, el]) => v !== null && !reloads(el) && !isAd(el))
          .sort((a, b) => b[0] - a[0])
          .filter(([, , c]) => !taken.has(place.get(c.i)) && taken.add(place.get(c.i)));
        // the best two, and the 3rd and 4th when they are more likely wanted than not (the score train.py found for that)
        const best = order
          .slice(0, 4)
          .filter(([v], k) => k < 2 || v >= (model.sure ?? -Infinity))
          .map(([, el]) => el);
        // and the page's search, unless you are typing into something: a field before a button or link that opens one, the one in
        // the page's content (a filter, a section's own search) before the site's. It is the last pick, or the first when the best
        // guess is more likely unwanted than wanted (below the score train.py found for that)
        const searches = from?.matches(`${TYPED},${EDITABLE}`) ? [] : order.filter(([, el]) => isSearch(el));
        const field = ([, , c]) => isField(c),
          search = (searches.find((s) => field(s) && !s[2].chrome) ??
            searches.find(field) ??
            searches.find(([, , c]) => !c.chrome) ??
            searches[0])?.[1];
        if (search && order[0][0] < (model.lead ?? -Infinity)) {
          if (best.includes(search)) best.splice(best.indexOf(search), 1);
          best.unshift(search);
          best.splice(4);
        } else if (search && !best.includes(search)) best.splice(Math.min(best.length, 3), 1, search);
        if (!best.length) return note("jab found nothing to jump to here.");
        // the next 20 stand in for a pick that turns out not to take the focus
        const rest = order
          .map(([, el]) => el)
          .filter((el) => !best.includes(el))
          .slice(0, 20);
        ses = { els: best, rest, badges: best.map((_, i) => draw("badge", i + 1)), lit: true };
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
  const length = (s) => [...s].length;
  const hrefPath = (c) => c.href.split("#")[0].split("?")[0]; // where a link leads, without its query and fragment
  // which links lead to the same place: a place per control (a link that leads nowhere it can be told by has its own). The address
  // (kept without its host and cut at 40) is enough when it is whole and specific (2+ levels deep, or with a query); otherwise two
  // links to it must also show they are one: they sit in the same item, or one's item reads the other's headline (a label of two
  // words or more that nothing else on the page has)
  const places = (controls) => {
    const labels = count(controls.map((c) => c.label.trim().toLowerCase())),
      headline = (c) => labels.get(c.label.trim().toLowerCase()) == 1 && words(c.label).length >= 2;
    const one = (a, b) =>
      (!!a.around?.trim() && a.around == b.around) ||
      (headline(b) && !!a.around?.includes(b.label.trim())) ||
      (headline(a) && !!b.around?.includes(a.label.trim()));
    const byHref = new Map(),
      place = new Map(controls.map((c) => [c.i, c.i]));
    for (const c of controls)
      if (c.href && !c.href.startsWith("#") && !/^javascript:/i.test(c.href))
        byHref.get(c.href)?.push(c) ?? byHref.set(c.href, [c]);
    for (const [href, cs] of byHref) {
      const specific =
        length(href) < 40 && (hrefPath(cs[0]).split("/").filter(Boolean).length >= 2 || href.includes("?"));
      cs.forEach((c, k) => {
        const same = specific ? cs[0] : cs.slice(0, k).find((d) => one(c, d));
        if (same) place.set(c.i, place.get(same.i));
      });
    }
    return place;
  };
  const isPicture = (c) => c.icon && c.w >= 100 && c.h >= 60; // a link that is a picture (an icon is smaller)
  // on screen: within the window the page is seen in (a page captured before windows were recorded was seen at 1280x900)
  const windowOf = (page) => [page.vw ?? 1280, page.vh ?? 900];
  const onScreen = (c, [vw, vh]) => c.w >= 4 && c.h >= 4 && c.y + c.h >= 0 && c.y <= vh && c.x <= vw;
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
    const [vw, vh] = windowOf(page),
      shown = controls.filter((c) => onScreen(c, [vw, vh])),
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
    // the links that lead to the same place as another: is one of the others text, is one a picture; how much of what is linked on
    // screen is pictures (a page of pictures, where the pictures are what you came for)
    const placeOf = places(controls),
      textTo = new Map(),
      pictureTo = new Map();
    for (const c of controls) {
      const by = isPicture(c) ? pictureTo : c.label.trim() ? textTo : null;
      by?.set(placeOf.get(c.i), (by.get(placeOf.get(c.i)) ?? 0) + 1);
    }
    // how many of the others that lead where c leads are in by (c itself counted there when self)
    const others = (by, c, self) => (by.get(placeOf.get(c.i)) ?? 0) - self;
    const shownLinks = shown.filter((c) => c.href),
      pictureShare = shownLinks.length ? shownLinks.filter(isPicture).length / shownLinks.length : 0;
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
        // where it is in the window (a share of its width and height) and how big (in pixels, which a window's size does not change)
        x: c.x / vw,
        y: c.y / vh,
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
        // a picture, and the others that lead to the same place: text (a headline, a name) or pictures
        picture: isPicture(c),
        same_place_text: others(textTo, c, !isPicture(c) && !!c.label.trim()),
        same_place_picture: others(pictureTo, c, isPicture(c)),
        page_pictures: pictureShare,
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
    '{"features":["x","y","w","h","index","index_frac","count","screen_rank","on_screen_count","controls_above","page_scroll","kind","same_kind_rank","same_kind_count","inputs_on_screen","label_len","label_words","no_parent_text","before_len","nothing_focused","index_delta","focus_dy","focus_dist","focus_filled","same_region","is_submit","submit_like","first_field","form_fields","in_focus_form","after_focus","empty_fields_left","empty_field","fill","sat","round","bold","icon","sat_rank","hit","occluded_share","lcover","lz","foreground","region_size","heading","font","font_rank","in_frame","alike","alike_index","prose","label_repeats","href_repeats","href_depth","slug_words","href_number","picture","same_place_text","same_place_picture","page_pictures","page_prose","page_depth","page_slug_words","page_number"],"kinds":{"a":0,"button":1,"link":2,"input text":3,"tab":4,"menuitem":5,"input checkbox":6,"div":7,"input radio":8,"summary":9,"input email":10,"select":11,"input search":12,"span":13,"input submit":14,"radio":15,"textarea":16,"input password":17,"note":18,"iframe":19,"input number":20,"li":21,"region":22,"tabpanel":23,"combobox":24,"listitem":25,"option":26,"checkbox":27,"group":28,"input tel":29},"words":["w:html","w:of","w:search","w:products","w:privacy","w:new","w:item","w:learn","w:contact","w:docs","w:policy","w:home","w:site","w:company","w:terms","w:resources","w:support","w:up","w:tab","w:get","w:login","w:free","w:opens","w:user","w:utm","w:features","w:add","w:slide","w:shop","w:sign","w:cookie","w:careers","w:pricing","w:email","w:download","w:facebook","w:button","w:do","w:cookies","w:reviews","w:logo","w:skip","w:signup","w:community","w:details","w:start","w:topic","w:information","w:find","w:name","w:started","w:partners","w:ago","w:live","w:image","w:english","w:upvote","w:buy","w:we","w:author","w:demo","w:fk","w:profile","w:pc","w:close","w:ads","w:register","w:subscribe","w:request","w:work","w:quả","w:dp","w:try","w:works","w:documentation","w:form","w:theme","w:accept","w:hl","w:brand","w:ja","w:previous","w:na","w:university","w:response","w:archive","w:trial","w:sdk","w:safety","w:message","w:ip","w:protection","w:feedback","w:size","w:projects","w:color","w:talk","w:edit","w:only","w:advertisement","w:admissions","w:agree","w:academics","w:signin","w:xs","w:environment","w:term","w:install","w:console","w:pause","w:description","w:martin","w:workers","w:omar","w:want","w:drive","w:grace","w:uses","w:original","w:becker","w:gdpr","w:load","w:street","c:in","c:privacy","c:terms","c:points","c:comments","c:free","c:careers","c:top","c:search","c:business","c:ago","c:see","c:hours","c:do","c:accessibility","c:start","c:app","c:download","c:community","c:media","c:started","c:newsletters","c:name","c:docs","c:buy","c:api","c:next","c:facebook","c:page","c:full","c:try","c:source","c:request","c:linkedin","c:box","c:español","c:stay","c:experience","c:make","c:choices","p:news","p:docs"],"trees":[[39,-1,[30,0,-34,35],[4,0,-8,[3,0.04,[10,2.824,[48,0,10,-20],[39,0,-6,24]],[39,0,[48,0,13,-35],29]]]],[33,0.035,[7,5,[12,22,[24,0,[37,0,-6,-21],12],-30],[47,4,[54,0,-6,24],-2]],[20,-1,[23,0,8,-29],17]],[1,1.458,[2,0.09,[30,0,[2,0.043,-13,-1],24],[27,0,[34,0.411,[48,0,[11,3,9,-6],-5],16],28]],[30,0,-28,14]],[38,-1,[29,0,-22,[20,1,28,-20]],[50,1,[28,0,[2,0.06,-4,[35,0.06823,[49,8,3,18],13]],18],[50,3,-4,-16]]],[39,0,[29,0,[1,1.756,-12,-24],19],[32,0,[36,0.423,[24,0,[48,0,[61,0.85,-2,7],-8],8],[1,0.06,0,13]],20]],[39,0,[30,0,[1,1.523,-11,-23],16],[2,0.074,[25,0,[10,3.216,-11,0],20],[37,0,[20,-1,1,[21,0.24,12,1]],0]]],[39,0,[28,0,[1,2.135,-11,-22],9],[2,0.098,[29,0,[50,0,1,-8],17],[32,0,[142,0,[54,0,0,8],22],16]]],[39,0,[29,0,[1,1.49,[48,0,-6,-22],-21],12],[34,0.0985,[32,0,[48,0,[22,0.3603,[3,0.017,-10,5],-3],-5],15],11]],[39,0,[12,17,[24,0,-8,11],-19],[50,2,[33,0.71,[24,0,[54,1,-2,5],[20,0,-3,[20,1,24,4]]],9],-8]],[39,0,[12,14,[30,0,-7,12],-17],[2,0.098,[30,0,[2,0.027,-13,-1],15],[20,-1,-3,[48,0,[20,6,10,-1],-2]]]],[1,1.368,[24,0,[50,0,[49,8,[37,0,[35,0.0802,0,7],-6],17],-5],[20,0,-4,[20,1,22,3]]],[30,0,-19,13]],[1,1.49,[48,0,[32,0,[36,0.423,[25,0,[2,0.027,-13,[15,1,-20,[46,0.9335,-3,4]]],17],6],15],-6],[30,0,-19,11]],[1,1.43,[24,0,[2,0.05,-7,[50,4,[1,0.06,-4,[22,0.1807,[47,3,11,4],-1]],-12]],[21,0.15,11,-2]],[29,0,-18,10]],[39,0,[28,0,[4,30,-6,-16],[21,0.306,11,-22]],[2,0.2,[34,0.299,[26,0,[47,12,0,-5],8],7],[21,-0.001,-4,8]]],[39,0,[24,0,[1,2.2114,-7,-19],6],[48,0,[20,12,[20,-1,-2,[47,3,11,[34,0.411,2,10]]],-8],[62,0,1,-8]]],[21,0.44,[20,0,[37,0,[48,0,[23,0,[27,0,[34,0.299,1,9],14],-15],[39,0,-20,-3]],-7],[20,2,15,0]],-11],[1,1.724,[32,0,[17,0,[142,0,[59,0,[20,16,[50,3,[1,0.0325,-4,2],-8],-10],14],15],-8],10],[30,0,-18,9]],[20,8,[20,0,[1,2.293,[48,0,[0,0.018,-9,[2,0.066,-3,[0,0.4686,[19,0,-1,7],-1]]],-5],-19],[20,1,14,4]],-8],[7,0,[222,0,[22,0.9655,[1,0.103,-17,-2],-18],26],[47,6,[49,9,[48,0,4,-3],14],[3,0.04,-4,[16,0,-14,2]]]],[35,0.0647,[26,0,[59,0,[20,32,[48,0,[51,75,-2,[49,4,-3,14]],-7],-16],12],8],[86,0,[15,19,4,-3],16]],[1,2.135,[142,0,[30,0,[54,0,[32,0,[43,0.4833,[35,0.0535,-9,-2],6],6],[47,11,4,-3]],10],14],[29,0,-18,8]],[21,0.74,[48,0,[3,0.017,-12,[32,0,[34,0.7468,[11,3,[17,0,2,-6],[2,0.19,-3,-22]],7],10]],[62,0,1,-7]],-12],[39,0,[48,0,-3,-18],[30,0,[16,0,-10,[1,0.927,[50,2,[49,9,[191,0,1,-30],[20,-1,-15,11]],-4],-7]],11]],[12,56,[37,0,[2,0.215,[21,0.283,[20,0,[50,1,1,-5],[20,4,9,-2]],-7],[20,-1,-5,7]],[58,0,-3,-15]],-8],[48,0,[21,0.17,[30,0,[115,0,[0,0.018,-8,1],17],[3,0.03,-6,16]],[46,0.929,-8,1]],[39,0,-18,[63,0,2,-6]]],[22,2.47717,[30,0,[1,2.645,[1,0.0325,[63,0,1,-10],[47,14,[51,44,1,9],[43,0.2675,-3,7]]],-18],[21,0.106,14,-4]],-16],[36,0.423,[12,47,[0,0.032,[222,0,-9,30],[26,0,[1,0.046,[97,0,-6,24],[2,0.043,-6,1]],5]],-9],[69,0,3,-20]],[0,0.94,[59,0,[3,0.04,[51,40,-3,[62,1,-1,[10,2.9185,22,1]]],[50,0,[11,-1,-28,[164,0,3,-41]],-2]],10],-11],[142,0,[84,0,[94,0,[48,0,[32,0,[1,2.957,[56,0,[67,0,[11,3,-1,-9],9],5],-15],7],-4],10],10],12],[20,22,[20,0,[50,0,[1,0.196,[63,0,[26,0,1,11],-6],[19,0,-4,[1,0.734,7,-1]]],-4],[20,4,7,-1]],-8],[37,0,[59,0,[3,0.04,[2,0.246,[12,49,-1,-10],6],2],12],[17,0,[58,0,0,[57,0,3,[60,0.4895,-39,9]]],-10]],[2,0.02,-10,[30,0,[1,3.092,[11,3,[2,0.105,[97,0,-1,15],[1,0.196,-2,[0,0.6085,[42,0,6,-2],-2]]],-6],-17],9]],[43,0.785,[95,0,[86,0,[2,0.254,[25,0,[2,0.035,-6,[125,0,-1,14]],[29,0,-5,[31,0,24,-9]]],3],10],-20],10],[20,-8,[50,1,-3,-13],[20,13,[20,0,[1,2.558,[38,2,3,[97,0,-1,14]],-16],[20,3,7,[46,0.6115,-5,3]]],-5]],[39,0,[40,0.053,[51,20,[59,0,-4,26],[61,1.75,31,-4]],[46,0,-1,[1,0.67,-22,-5]]],[1,0.824,[1,0.196,-1,3],-3]],[0,0.023,[70,0,[1,0.06,-22,-5],21],[74,0,[0,0.947,[34,0.6782,[2,0.246,[165,0,-1,25],[58,0,4,-9]],4],-10],12]],[193,0,[26,0,[1,0.037,[63,0,0,-10],[90,0,[0,1.204,[20,-1,-3,[142,0,[5,0.748917,1,-5],11]],-23],-22]],4],9],[105,0,[69,0,[50,1,[21,0.15,[107,0,1,12],[61,0,-7,1]],[51,83,[42,0.99996,[59,0,-5,7],12],6]],-12],-25],[3,0.017,-8,[37,0,[59,0,[85,0,0,8],[47,0,24,4]],[54,0,[25,0,-7,10],[16,0,-19,[39,0,-7,3]]]]],[52,17,[43,0.785,[2,0.01,-14,[30,0,[1,3.49,[55,0,[3,0.07,[48,0,0,-6],-9],[47,13,2,-2]],-16],7]],9],-15],[99,0,[45,2,[0,0.032,[222,0,[1,0.068,-18,[229,0,-3,-25]],22],[74,0,[0,0.9297,[143,0,0,-23],-8],11]],6],12],[114,0,[15,1,[58,0,-6,-34],[129,0,[85,0,[0,0.478,[55,2,[0,0.032,-5,1],5],[43,0.6783,-2,8]],7],14]],12],[22,3.950006,[165,0,[125,0,[20,-8,[32,0,-4,9],[75,0,[164,0,[56,0,0,[47,0,13,2]],-37],-12]],11],19],-17],[12,66,[20,-8,-3,[43,0.7876,[69,0,[56,0,[30,0,0,[25,0,1,[31,0,21,-5]]],[63,0,-1,7]],-12],9]],-6],[21,0.46,[20,0,[50,3,[49,16,[35,0.11562,-1,2],8],-5],[20,1,[42,0.5053,[32,0,[28,1,10,-13],25],-10],1]],-4],[115,0,[94,0,[59,0,[1,1.279,0,[10,3.2888,[51,24,-6,28],-12]],[40,0.6942,[14,8,5,[1,1.756,22,182]],-19]],7],9],[110,0,[106,0,[165,0,[48,0,[21,0.217,[20,0,0,3],-3],[63,0,[9,13,3,-10],[10,3.9863,-10,-3]]],16],-26],10],[0,1.4576,[95,0,[92,0,[107,0,[48,0,[58,0,[2,0.13,0,2],[3,0.117,-2,-21]],[63,0,1,-5]],8],-20],-13],-21],[87,0,[36,0.495,[90,0,[47,7,[74,0,[32,0,[54,1,-2,3],[64,0,8,-19]],15],-2],-19],[0,0.232,4,0]],-13],[97,0,[131,0,[129,0,[2,0.05,[74,0,[49,3,-1,[61,1.55,-12,-1]],17],[20,-1,-2,1]],12],12],[2,0.043,25,4]],[30,0,[11,3,[43,0.422,[0,0.4686,[42,0,[2,0.06,-3,3],[15,11,1,-8]],-1],4],[98,0,-6,11]],[25,0,1,14]],[205,0,[142,0,[1,0.694,[39,0,[46,0,2,-20],1],[10,1.517,[154,0,-12,24],[62,1,-3,[5,0.793107,6,-8]]]],7],9],[220,0,[97,0,[107,0,[2,0.254,[26,0,-1,3],[20,-1,[29,0,-4,-42],[11,-1,-20,3]]],8],[199,0,10,-21]],13],[105,0,[22,3.950006,[165,0,[50,0,[49,19,0,13],[20,0,[74,0,-3,[51,111,-4,22]],[20,4,8,-2]]],15],-16],-22],[15,0,[58,0,-5,-35],[52,11,[1,0.018,[62,1,[16,3,[85,0,-1,13],-17],[222,0,-11,24]],[205,0,0,9]],-10]],[143,0,[1,3.385,[94,0,[0,0.891,[3,0.05,[47,3,2,[41,0.501,-2,7]],[152,0,2,-33]],-4],6],[24,0,-15,7]],-19],[0,1.3908,[117,0,[71,0,[130,0,[99,0,[124,0,[48,0,0,[63,0,1,-4]],-18],8],-20],[47,58,11,-27]],-28],-19],[220,0,[58,4,[110,0,[45,2,[21,0.306,[142,0,0,[16,3,11,-22]],-3],[40,0.7355,[62,1,2,14],-25]],8],-12],11],[107,0,[137,0,[12,141,[106,0,[114,0,[81,0,[139,0,[48,0,0,-2],14],-9],[12,0,17,-5]],-25],-9],11],7],[131,0,[126,0,[54,4,[74,0,[67,0,-1,[62,1,6,-8]],[0,0.076,[10,3.0547,-26,8],[10,3.153,15,1]]],5],11],10],[174,0,[84,0,[125,0,[20,-10,[222,0,[46,0,[0,0.415,4,-5],-6],22],[79,0,[1,8.914,0,-16],-15]],10],5],-32],[87,0,[43,0.724,[85,0,[55,2,[169,0,[0,0.023,-5,0],40],[0,0.298,[58,0,7,-6],-1]],[63,3,6,-24]],5],-11],[80,0,[211,0,[30,0,[11,3,0,[12,1,[2,0.06,9,[5,0.4918176,[15,4,-18,0],-17]],-13]],[15,11,10,-1]],10],-9],[15,0,[58,0,-4,-34],[208,0,[129,0,[2,0.01,-11,[28,1,0,[27,0,0,[29,0,20,-30]]]],[46,0.534,-15,13]],6]],[166,0,[44,0,[1,0.046,[62,1,-2,-20],[5,0.75554,[62,1,-1,[1,0.258,-5,[42,0.338,6,-19]]],-7]],[86,0,0,8]],17],[1,1.279,[1,1.024,[50,6,[39,0,-3,0],-7],[46,0.5023,-22,10]],[10,4.1973,[46,0.9335,-13,[40,0,[12,10,-8,26],-18]],-10]],[140,0,[119,0,[75,0,[30,0,[55,0,[3,0.25,[53,0,[52,0,0,-5],-7],-18],1],5],[1,0.67,4,-18]],-17],14],[20,-12,[46,0,[38,-1,-23,[142,0,2,-41]],[222,0,-6,21]],[188,0,[97,0,[49,17,0,3],[199,0,9,-26]],3]],[134,0,[0,0.327,[15,25,[46,0.6665,[7,0,-9,4],[59,0,-2,11]],[42,0.3337,[11,-1,-31,5],-11]],[74,0,-1,11]],14],[0,-0.001,-11,[38,2,[0,0.9297,[1,1.279,[1,0.2114,0,[61,0,[21,0.106,4,-11],7]],[61,1.85,2,-13]],[10,1.4273,9,-14]],0]],[0,-0.001,[50,-1,1,-22],[166,0,[59,0,[3,0.05,-1,[0,0.9146,1,-10]],[62,0,-3,[49,6,1,[40,0.6815,15,-29]]]],16]],[92,0,[90,0,[132,0,[193,0,[12,74,[169,0,[120,0,0,-14],29],-4],5],[46,0.8108,6,-21]],[5,0.232583,4,-26]],-17],[105,0,[58,0,[59,0,[68,0,0,7],[47,1,[40,0.09,19,-14],[62,0,-8,8]]],[57,0,-1,[60,0.4895,-37,11]]],-18],[167,0,[124,0,[121,0,[205,0,[32,0,0,[44,2,[24,0,-1,[20,0,-62,21]],7]],[16,3,9,-9]],-28],-17],16],[182,0,[21,0.306,[20,0,0,[20,1,[42,0.5053,[32,0,8,23],-10],1]],[46,0.87495,[38,0,-16,-2],[42,0.50004,-1,13]]],-27],[117,0,[104,0,[71,0,[58,4,[99,0,[50,2,[49,23,0,[52,0,12,-3]],-2],[15,30,9,-13]],-10],7],-12],-26],[140,0,[97,0,[107,0,[20,-1,-2,[1,0.078,[62,1,[26,0,-2,7],-8],1]],6],[51,8,[10,1.659,23,5],-16]],13],[15,10,[12,2,[63,0,[76,0,7,-23],[10,1.3292,7,[46,0.572,6,[1,0.258,-8,1]]]],[42,0.86,-1,8]],[2,0.066,-5,0]],[207,0,[99,0,[131,0,[43,0.879,[30,0,0,[25,0,[32,0,[47,4,-19,0],[20,1,23,2]],13]],9],8],7],-15],[187,0,[115,0,[125,0,[218,0,[108,0,[119,0,[100,0,[12,175,0,-9],-22],[6,60,-28,2]],-14],8],8],6],23],[164,0,[3,0.017,[47,63,[127,0,-4,41],-25],[223,0,[47,2,[40,0.0269,[9,15,1,7],[1,1.279,0,-11]],0],-19]],-31],[142,0,[190,0,[55,0,[3,0.25,-1,-16],1],-10],[20,19,[20,-1,[46,0.7435,-40,18],[62,0,22,5]],[46,0,-42,8]]],[49,6,0,[20,-1,[10,3.4195,-17,-2],[47,10,[40,0.0458,[18,18,2,[48,0,10,-6]],[39,0,-9,3]],[50,4,2,-7]]]],[43,0.199,[42,0,[90,0,[54,1,-1,1],-15],[41,0.0119,[12,6,-3,-19],[15,14,0,-5]]],[15,12,[11,0,1,8],-1]],[3,0.05,[1,0,-9,0],[1,1.279,[0,0.2895,[54,0,-1,[58,0,[50,0,[3,0.117,5,13],0],[46,0.884,6,-8]]],0],-7]],[96,0,[0,1.4576,[172,0,[151,0,[30,0,[1,4.399,0,-14],[3,0.03,-5,7]],[193,0,20,[10,3.7734,-21,7]]],15],-19],-16],[179,0,[226,0,[161,0,[52,10,[49,18,[15,10,[14,12,1,-18],[158,0,-1,-39]],[47,10,7,-1]],-7],13],12],15],[53,9,[191,0,[174,0,[44,0,[11,-1,-29,-1],[5,0.987892,0,[61,0.95,-4,15]]],-28],16],[47,56,-2,[195,0,-21,23]]],[165,0,[135,0,[30,0,[1,4.399,[29,0,[27,0,0,[44,2,-1,14]],[27,0,10,[61,0.15,-46,34]]],-13],4],-22],11],[167,0,[137,0,[171,0,[125,0,[43,0.693,0,[46,0.681823,[5,0.90412,3,-10],[129,0,6,29]]],6],-18],[38,0,-4,15]],14],[165,0,[102,0,[20,-12,[12,17,[61,0,1,[1,0.258,[222,0,-9,23],1]],-10],[21,-0.35,3,[21,-0.03,-4,0]]],9],11],[224,0,[139,0,[101,0,[126,0,[193,0,0,[10,6.042,-1,8]],11],[52,3,7,-28]],[4,24,17,-11]],[42,0.219,-25,14]],[5,0.02471,[2,0.09,[103,0,[76,0,6,-16],-23],[13,33,3,[49,0,-11,2]]],[15,3,[14,9,-3,-35],[9,4,-1,0]]],[73,0,[116,0,[194,0,[3,0,-20,[150,0,[201,0,[170,0,[167,0,[47,2,1,0],12],-24],7],-28]],-12],-13],5],[92,0,[197,0,[1,0.694,[50,5,1,-6],[10,1.481,[154,0,[40,0.00985,[61,0.35,-19,-5],2],22],[46,0.582,-5,1]]],-6],-15],[122,0,[124,0,[20,-12,[46,0,[9,28,[23,0,2,-20],-11],-4],[157,0,[97,0,0,[22,0.0604,0,11]],-30]],-14],9],[77,0,[67,0,[27,0,0,[29,0,8,-31]],[64,0,[33,0.29,7,[31,0,[62,0,[22,0.2305,12,-3],-5],-23]],-16]],-9],[139,0,[107,0,[49,6,0,[35,0.4287,[50,0,[15,10,0,[20,-1,-7,9]],[20,0,-1,[20,6,10,0]]],-9]],5],11],[43,0.199,[47,18,[38,53,[5,0.75554,[1,0.0325,-2,1],[180,0,-4,1411]],11],-2],[41,0.5506,1,[0,0.5707,[13,3,-18,6],17]]],[223,0,[148,0,[162,0,[207,0,[104,0,[136,0,[1,10.043,0,[180,0,-14,-640]],14],[60,0.1286,-3,-31]],-13],-18],-19],-17],[21,0.06,0,[46,0.866668,[38,0,[23,0,[46,0,[7,11,-23,-2],-4],1],-3],[3,0.083,[23,0,[11,1,4,-8],-3],-6]]],[133,0,[67,0,0,[61,0,[31,0,8,[24,0,11,-32]],[23,0,[25,0,[6,159,[28,0,1,-9],7],-16],15]]],8],[105,0,[12,368,[2,0.59,[2,0.27,0,[58,0,3,-7]],[192,0,[14,1,[15,21,[5,0.3750521,-18,2],-1],8],-45]],-14],-17],[22,5.85234,[186,0,[146,0,[218,0,[38,2,[189,0,1,-16],[25,0,0,8]],[12,3,[33,0.077,9,-23],10]],-22],-46],-18],[106,0,[113,0,[112,0,[149,0,[82,0,[18,18,[12,1,2,[61,0,-3,0]],1],[21,-0.206,16,2]],-21],-11],9],-24],[176,0,[89,0,[121,0,[78,0,[80,0,[0,1.548,[184,0,[227,0,0,17],-37],-19],-7],[10,4.916,1,-17]],-26],-8],-37],[83,0,[141,0,[174,0,[140,0,[20,-11,[46,0,[84,0,0,19],-4],[21,-0.43,3,[21,-0.03,-3,0]]],10],-24],-20],-8],[127,0,[130,0,[41,0.5506,[210,0,0,8],[39,0,[46,0.465,3,-24],[46,0.66667,-2,[15,17,12,1]]]],-15],[47,10,-3,24]],[159,0,[49,6,[198,0,0,-23],[0,-0.001,-21,[18,19,[50,8,0,-10],[62,0,-1,[11,0,[20,-1,-11,7],-3]]]]],15],[168,0,[56,0,[1,1.279,0,[59,0,-7,[160,0,11,620]]],[47,0,[46,0.7062,-20,9],[62,0,-3,3]]],[42,0.3822,16,-10]],[208,0,[0,0.3363,[229,0,1,[51,122,-12,14]],[229,0,[15,21,[20,-5,-3,[20,4,1,-4]],-3],[3,0.04,15,-14]]],5],[225,0,[118,0,[16,0,[13,18,2,[217,0,[3,0.65,-7,26],25]],[15,8,[2,0.098,2,-2],[158,0,0,-33]]],9],-13],[203,0,[99,0,[209,0,[36,0.495,-1,1],-17],[15,30,[12,5,[0,0.68,5,-17],[5,0.44446,16,-7]],-13]],[5,0.62738,6,-15]],[76,0,[69,0,[48,0,0,[62,0,1,[14,0,[0,0.518,-4,2],-7]]],[46,0.44,-24,-2]],[7,5,[156,0,-14,32],-1]],[203,0,[214,0,[1,8.914,[165,0,[185,0,[135,0,[0,0.986,[97,0,0,4],[10,1.883,5,-18]],-19],21],9],-16],8],5],[204,0,[152,0,[147,0,[221,0,[206,0,[126,0,[36,0.495,[169,0,0,[13,58,35,-24]],1],10],-8],-26],-21],-27],-10],[183,0,[224,0,[111,0,[21,-3.01,-22,[155,0,[67,0,0,[6,86,[13,10,-5,6],6]],14]],-15],[2,0.113,-1,-32]],23],[212,0,[169,0,[119,0,[173,0,[53,10,[200,0,[53,1,0,1],16],[88,0,-3,-29]],20],-13],[65,0,30,-27]],8],[169,0,[144,0,[68,0,[1,0.018,[15,8,0,-5],0],[12,4,[61,0,19,5],[177,0,-2,51]]],-22],[46,0.929,31,-24]],[41,0.4225,[3,0.05,[59,0,[14,14,-1,-18],[60,0.4895,7,-41]],1],[39,0,[46,0,[18,11,-17,8],-22],[53,0,7,-6]]],[21,0.13,[20,0,0,[42,0.12,4,-2]],[46,0,[142,0,[8,10,-17,-2],-33],[42,0.50004,[62,0,-4,2],[11,0,-10,10]]]],[54,6,[153,0,[219,0,[211,0,[18,4,[12,34,3,-6],[58,0,0,-2]],[15,4,17,[5,0.192862,-7,10]]],-12],-23],20],[93,0,[70,0,[128,0,[173,0,[131,0,[1,0.0325,-2,0],6],22],-9],[12,0,[61,3.75,20,-26],[4,8,-11,6]]],7],[139,0,[202,0,[73,0,[227,0,[145,0,[85,0,[215,0,0,-17],[64,0,4,[9,11,-27,13]]],14],16],5],-18],10],[187,0,[67,0,[32,0,0,[14,11,[20,2,[20,-1,[20,-3,4,-21],9],-8],-26]],[62,1,4,[6,55,-17,-2]]],17],[20,30,[142,0,0,[20,-1,[61,0,-34,11],[62,0,20,[0,0.603,14,-3]]]],[13,194,[50,9,[61,0,-8,1],14],-12]],[180,0,[123,0,[175,0,[188,0,0,[46,0.627,6,[20,-5,-10,1]]],-22],9],[40,0.808,-29,[38,16,[10,8.2782,-2915,-659],-24]]],[0,0.327,[55,0,[11,0,[1,0.13,[16,1,-6,-19],-1],1],1],[39,0,[229,0,-4,15],[40,0.376,[3,0.383,0,-13],3]]],[66,0,[205,0,[72,0,[96,0,0,-15],[1,0.734,[0,0.314,7,-8],-13]],[2,0.285,6,-17]],[49,3,[42,0.264,-6,-21],2]],[53,11,[53,0,0,[5,0.90412,[54,0,[35,0.2665,-7,5],[15,1,-14,[58,0,[104,0,3,-25],[57,0,1,-21]]]],-16]],-3],[21,-3.01,-22,[41,0.5506,[28,1,0,[27,0,1,[24,0,[1,1.116,16,-31],-21]]],[43,0.032,-4,[46,0.465,-1,[37,0,7,22]]]]],[3,0.05,[1,0,-8,[18,19,[50,5,-1,-8],[49,4,0,[37,0,4,-9]]]],[0,0.767,[1,1.279,2,[14,8,-8,33]],-3]],[58,4,[185,0,[28,1,[53,0,[41,0.2916,-1,3],[5,0.911637,[55,0,-3,[15,1,-11,1]],-12]],[12,1,5,-2]],20],-8],[169,0,[130,0,[179,0,[142,0,0,[21,-0.017,-22,[163,0,7,-24]]],[4,14,23,-5]],[18,16,2,-27]],[13,25,32,-12]],[223,0,[140,0,[109,0,[138,0,[178,0,[20,-6,-1,0],-32],[46,0.9335,3,-22]],-10],[0,0.31,[47,17,20,-25],-2]],-15],[124,0,[85,0,[11,-1,[15,14,2,[35,0.2499,-28,8]],[47,1,[40,0.0372,[15,23,1,7],-3],0]],3],[51,6,3,-28]],[52,24,[211,0,[91,0,[196,0,0,[61,3.05,5,-5]],[60,0.116,13,-18]],[10,1.481,16,[229,0,5,-18]]],[4,6,21,-15]],[3,0,-17,[213,0,[211,0,[44,0,[9,4,[62,1,[228,0,-1,-30],[1,0.258,-18,4]],0],0],[2,0.145,9,-18]],-11]],[5,0.028786,[62,0,4,[15,36,-1,-22]],[0,0.178,[1,0.98,[46,0.70003,3,-1],5],[39,0,[44,9,-1,[49,8,-9,1]],0]]],[146,0,[50,34,[181,0,[48,0,0,[62,0,[22,0.1437,[5,0.355286,6,-12],-1],[10,4.916,[216,0,-6,41],-1]]],-35],-17],-23]],"sure":-195,"lead":-145}';
  // for train.py, which loads this file under Node and learns from describe()
  if (typeof module == "object") module.exports = { describe };
}

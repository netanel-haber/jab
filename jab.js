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
    '{"features":["x","y","w","h","index","index_frac","count","screen_rank","on_screen_count","controls_above","page_scroll","kind","same_kind_rank","same_kind_count","inputs_on_screen","label_len","label_words","no_parent_text","before_len","nothing_focused","index_delta","focus_dy","focus_dist","focus_filled","same_region","is_submit","submit_like","first_field","form_fields","in_focus_form","after_focus","empty_field","fill","sat","round","bold","icon","sat_rank","hit","occluded_share","lcover","lz","foreground","region_size","heading","font","font_rank","in_frame","alike","alike_index","prose","label_repeats","href_repeats","href_depth","slug_words","href_number","picture","same_place_text","same_place_picture","page_pictures","page_prose","page_depth","page_slug_words","page_number"],"kinds":{"a":0,"button":1,"link":2,"input text":3,"tab":4,"menuitem":5,"input checkbox":6,"div":7,"input radio":8,"summary":9,"input email":10,"select":11,"input search":12,"span":13,"input submit":14,"radio":15,"textarea":16,"input password":17,"note":18,"iframe":19,"input number":20,"li":21,"region":22,"tabpanel":23,"combobox":24,"listitem":25,"option":26,"checkbox":27,"group":28,"input tel":29},"words":["w:html","w:id","w:of","w:search","w:products","w:privacy","w:new","w:item","w:contact","w:docs","w:policy","w:home","w:site","w:company","w:terms","w:resources","w:support","w:up","w:tab","w:get","w:login","w:go","w:source","w:free","w:opens","w:user","w:use","w:features","w:slide","w:shop","w:sign","w:cookie","w:careers","w:pricing","w:press","w:download","w:facebook","w:button","w:do","w:reviews","w:logo","w:skip","w:signup","w:community","w:start","w:topic","w:account","w:information","w:find","w:name","w:started","w:partners","w:ago","w:submit","w:image","w:english","w:upvote","w:buy","w:we","w:author","w:demo","w:fk","w:profile","w:pc","w:close","w:ads","w:register","w:subscribe","w:request","w:work","w:kết","w:quả","w:dp","w:try","w:works","w:documentation","w:first","w:form","w:theme","w:manage","w:accept","w:コメント","w:hl","w:ja","w:previous","w:na","w:university","w:response","w:archive","w:trial","w:premium","w:sdk","w:github","w:safety","w:message","w:ip","w:feedback","w:max","w:windows","w:color","w:talk","w:element","w:edit","w:only","w:advertisement","w:admissions","w:comment","w:agree","w:academics","w:signin","w:xs","w:environment","w:install","w:console","w:pause","w:payments","w:description","w:martin","w:membership","w:min","w:want","w:drive","w:database","w:uses","w:becker","w:gdpr","w:load","w:growth","w:street","c:in","c:by","c:contact","c:com","c:points","c:comments","c:free","c:careers","c:top","c:products","c:resources","c:business","c:ago","c:solutions","c:see","c:hours","c:start","c:app","c:website","c:download","c:add","c:media","c:started","c:newsletters","c:name","c:docs","c:facebook","c:copyright","c:details","c:try","c:demo","c:source","c:request","c:linkedin","c:box","c:uses","c:español","c:stay","c:choices","p:is","p:news","p:search","p:new","p:docs","p:do","p:revenue","p:api"],"trees":[[38,-1,[30,0,-35,24],[4,0,-11,[3,0.04,[10,2.824,[47,0,12,-16],[38,0,-5,22]],[38,0,[47,0,0,-67],31]]]],[32,0.035,[7,5,[12,22,[24,0,[36,0,-11,-17],14],-26],[46,4,[53,0,-17,27],0]],[20,-1,[23,0,6,-9],14]],[1,1.458,[2,0.09,[30,0,[2,0.043,-16,4],10],[27,0,[47,0,[11,3,[36,0,11,2],-13],-1],38]],[30,0,-43,20]],[37,-1,[29,0,-30,[20,1,62,-26]],[49,1,[33,0.26,[28,0,[48,9,[2,0.066,-2,5],17],26],17],[49,3,-5,-16]]],[38,0,[29,0,[1,1.792,-14,-28],24],[34,0.0389,[47,0,[3,0.017,-5,[20,-1,-9,[20,8,[24,0,6,29],-2]]],-6],11]],[38,0,[30,0,[1,1.56,-11,-26],9],[2,0.098,[25,0,[10,3.216,-4,0],11],[31,0,[35,0.43,[13,1,-30,4],10],24]]],[38,0,[28,0,[1,2.135,-11,-14],2],[2,0.074,[29,0,[2,0.027,-11,-3],16],[1,0.068,-6,[21,0.217,[49,2,11,5],1]]]],[38,0,[29,0,[1,1.49,[47,0,-5,-25],-27],17],[31,0,[33,0.411,[47,0,[35,0.495,1,5],[29,0,-7,80]],9],17]],[38,0,[12,17,[24,0,-10,18],-17],[49,0,[20,-1,-2,[20,3,[1,0.068,[19,0,10,-9],11],3]],[24,0,-6,14]]],[38,0,[12,14,[30,0,-9,[20,1,-2,5]],-16],[2,0.06,[30,0,-6,9],[47,0,[31,0,[33,0.305,3,14],11],-3]]],[1,1.368,[144,0,[31,0,[46,12,[53,0,[25,0,-6,[29,0,-24,65]],6],[49,2,-3,-15]],17],27],[30,0,-22,18]],[1,1.49,[47,0,[22,0.3201,[2,0.05,[25,0,-3,53],[31,0,[35,0.423,2,9],18]],-1],[38,0,-23,-5]],[30,0,-20,17]],[1,1.49,[24,0,[2,0.05,-8,[32,0.71,[2,0.254,[49,4,-2,-19],5],8]],[21,-0.04,-27,[21,0.15,15,-6]]],[29,0,-21,33]],[38,0,[28,0,[4,29,-5,-16],-1],[30,0,[2,0.098,[49,1,0,-7],[15,0,-5,[23,0,4,-19]]],[21,0.106,28,14]]],[38,0,[24,0,[1,2.293,-10,-18],23],[36,0,[46,3,[20,-1,2,9],[34,0.02614,[1,0.76,2,-12],4]],[17,0,-1,-20]]],[21,0.483,[20,0,[47,0,[36,0,[23,0,[27,0,2,12],-16],-3],[38,0,-29,-8]],[20,1,25,[20,7,7,-9]]],-11],[1,1.656,[1,0.0325,[62,0,[26,0,-2,11],-14],[20,13,[20,0,[49,2,3,-12],[20,1,11,6]],-10]],[30,0,-13,4]],[1,2.012,[47,0,[3,0.017,-12,[20,-1,-1,[20,6,[144,0,[46,4,9,1],16],-6]]],[62,0,3,-12]],[29,0,-18,33]],[36,0,[2,0.184,[3,0.03,[50,83,[5,0.3750521,-4,-6],[48,4,-3,47]],[49,2,2,0]],[20,-1,-22,10]],[25,0,-9,28]],[38,0,[22,1.21056,[47,0,-3,-27],2],[33,0.7056,[2,0.2,[26,0,[114,0,[39,0.765,-2,20],34],6],[20,-1,-18,6]],8]],[20,18,[20,0,[1,2.558,[47,0,[0,0.018,-5,[46,14,[1,0.178,-1,[0,0.484,8,3]],-3]],-6],-37],[20,2,13,-2]],-7],[58,0,[21,0.76,[30,0,[15,0,-29,[144,0,[83,0,[2,0.027,-9,[5,0.651155,[47,0,1,-3],-6]],16],18]],17],-15],18],[38,0,[47,0,-4,-26],[36,0,[2,0.215,[87,0,[26,0,[97,0,-1,25],6],21],5],[53,0,-13,[57,0,9,1]]]],[12,47,[47,0,[21,0.283,[20,0,[33,0.411,[27,0,-1,[29,0,22,-149]],16],[20,1,14,2]],-7],[62,0,4,-10]],-9],[35,0.495,[31,0,[17,0,[11,3,[38,0,-12,[49,5,[227,0,[48,7,-2,[15,12,-17,17]],27],-18]],-6],-7],10],4],[22,1.95001,[34,0.0647,[53,1,[26,0,[31,0,[17,0,-8,-29],8],17],[45,0.9335,-1,[46,1,23,[61,0,-12,15]]]],2],-1],[58,0,[1,1.43,[0,0.023,[227,0,[1,0.06,-34,-10],92],[30,0,[35,0.423,[46,6,0,-4],5],[3,0.03,-26,22]]],-23],13],[49,1,[48,14,[3,0.04,0,[0,0.9297,[168,0,[11,-1,-72,3],-121],-28]],10],[50,83,[144,0,[58,0,-6,5],33],-9]],[47,0,[21,0.283,[25,0,[15,0,-14,[33,0.7056,[46,11,[73,0,2,20],-4],15]],21],[45,0.929,-15,5]],[62,0,2,-9]],[12,56,[1,0.037,[62,0,[97,0,[26,0,-4,2],52],-12],[20,-1,-5,[20,4,[22,0,[49,4,3,-12],9],-1]]],-6],[1,2.645,[20,-8,-5,[144,0,[54,0,[30,0,[3,0.07,1,-20],13],[5,0.781928,[16,0,-37,2],-14]],10]],[29,0,-16,36]],[0,1.204,[49,0,[48,8,[1,0.846,[34,0.0802,[7,0,-28,2],3],[60,0,-31,4]],[20,-1,-60,24]],[20,-8,-24,-1]],-32],[87,0,[2,0.246,[42,0.7876,[124,0,[58,0,[94,0,[2,0.01,-30,[29,0,-3,18]],9],11],26],11],[57,0,7,-20]],17],[20,30,[20,0,[1,3.092,[106,0,[1,0.0325,[61,1,0,[227,0,-19,119]],0],26],-28],[20,1,[69,0,12,-63],1]],-13],[0,0.018,[227,0,-3,35],[22,2.6501,[0,0.4686,[2,0.027,-14,[47,0,[41,0,6,-4],-3]],[42,0.636,[26,0,-3,6],0]],-23]],[95,0,[104,0,[44,2,[38,0,[43,16,[50,30,2,[60,1.95,67,-40]],-26],[39,0.594,[3,0.04,-4,2],18]],7],-56],-21],[199,0,[55,0,[0,0.018,[227,0,-12,21],[73,0,[31,0,[42,0.7876,-2,3],[43,2,-10,22]],11]],[46,6,17,-1]],12],[169,0,[69,0,[58,0,[113,0,[1,2.2114,[35,0.423,[3,0.017,-23,-1],2],-18],28],[36,0,[46,0,36,10],-27]],-18],52],[0,0.94,[54,2,[0,0.032,-11,[21,0.57,[37,2,3,[97,0,[73,0,[26,0,-1,9],16],9]],-16]],[0,0.31,9,-3]],-8],[11,3,[88,0,[16,0,[57,0,-6,-48],[2,0.254,[42,0.7246,[99,0,0,27],11],4]],-20],[11,9,-25,[168,0,6,-106]]],[30,0,[1,3.385,[11,3,[105,0,[36,0,[58,0,1,9],[57,0,-2,[56,0,19,[59,0.4895,-243,54]]]],-87],-8],-12],7],[0,1.204,[24,0,[131,0,[114,0,[91,0,[1,3.0472,[124,0,0,25],-12],-12],18],-67],[27,0,[25,0,0,61],-120]],-30],[47,0,[43,0,[55,0,-5,[62,0,-12,20]],[51,15,[91,0,[87,0,2,23],-2],-43]],[61,0,4,[14,0,-2,-17]]],[20,-9,-4,[144,0,[128,0,[5,0.75554,[54,0,[30,0,[10,1.3292,19,-6],13],1],[40,0.2813,-4,18]],21],[167,0,19,-71]]],[31,0,[20,-8,-5,[55,0,[42,0.785,-1,9],[57,0,[46,0,[45,0.929,-32,31],5],-22]]],[63,0,[14,9,12,-49],-27]],[84,0,[1,0.018,-4,[21,0.306,[20,0,[49,0,[48,14,[81,0,0,34],21],-5],[20,4,11,-3]],[45,0.87495,-11,0]]],15],[169,0,[108,0,[104,0,[146,0,[46,6,[50,29,0,[10,3.9863,16,-8]],[3,0.05,[42,0.223,-6,7],7]],-31],-42],26],33],[0,1.4576,[31,0,[17,0,[2,0.02,-18,[67,0,[58,0,[1,3.279,0,-64],[39,0.785,11,-78]],16]],[128,0,-7,21]],7],-27],[12,65,[47,0,[46,2,[48,8,2,23],[91,0,[9,4,[45,0.549,0,-30],[129,0,1,-155]],-48]],[62,0,4,-5]],-4],[130,0,[169,0,[97,0,[1,0.196,[61,1,2,-18],[62,0,[32,0.71,-10,5],[41,0,11,-26]]],[15,7,19,2]],30],24],[116,0,[123,0,[69,0,[49,3,[48,13,[92,0,[78,0,1,-61],-66],[51,0,18,[36,0,4,-54]]],-7],-16],-55],-104],[212,0,[67,0,[193,0,[42,0.785,[12,97,[69,0,[1,0.037,[15,17,-3,-31],0],-21],-21],9],6],[61,1,11,0]],19],[225,0,[20,-12,-9,[97,0,[125,0,[155,0,[55,0,[0,0.032,-10,[73,0,0,17]],3],-21],42],[207,0,24,-52]]],28],[106,0,[229,0,[84,0,[20,0,[42,0.595,[46,14,-1,-4],17],[20,2,9,[45,0.66667,-11,[22,0.2001,35,0]]]],12],-59],11],[99,0,[106,0,[67,0,[54,2,[174,0,[144,0,[31,0,[17,0,-2,-12],6],22],218],3],[61,1,9,-3]],12],14],[94,0,[0,0.891,[124,0,[114,0,[20,-1,-3,[24,0,[1,3.49,[1,0.103,-6,2],-23],6]],12],17],[73,0,-10,31]],7],[146,0,[0,1.4576,[105,0,[46,14,[48,9,-1,[39,0.5784,[20,-1,-15,[60,0,42,3]],-116]],[42,0,-3,10]],-63],-31],-33],[21,0.217,[127,0,[79,0,[169,0,[1,-0.001,-6,[37,2,[43,2,-4,7],0]],28],-26],-41],[15,17,[60,0.35,-22,1],5]],[0,0.3363,[54,0,-2,3],[15,30,[12,0,[47,0,17,-5],[26,0,[50,131,[42,0.0674,[12,40,-2,-23],0],18],6]],-12]],[2,0.01,[41,0.8333326,-18,163],[30,0,[131,0,[108,0,[22,3.950006,[11,15,0,[2,0.13,3,-47]],-50],15],-29],[15,11,16,-9]]],[51,10,[95,0,[68,0,[71,0,[227,0,0,-1],[116,0,[1,1.43,23,[65,0,-125,145]],-87]],[202,0,-7,44]],-8],-8],[128,0,[3,0.05,[58,0,[1,0,-31,-2],[59,0.4895,[1,1.458,13,72],-227]],[57,0,4,[56,0,0,[59,0.4895,-217,36]]]],20],[31,0,[11,3,0,[11,10,-15,[3,0.094,[63,0,12,76],-96]]],[43,2,[24,0,-2,[20,0,-93,123]],[12,0,24,-15]]],[123,0,[47,0,[0,0.611,[1,0.196,-4,4],[73,0,[25,0,-6,14],12]],[62,0,[9,13,[53,0,-11,17],-30],-4]],-27],[171,0,[178,0,[1,0.76,[38,0,[45,0,17,-100],3],[45,0.582,-18,[38,-1,[1,1.279,28,[60,1.75,8,-72]],-8]]],-92],45],[57,4,[199,0,[74,0,[50,72,[49,0,0,[41,0.666685,[97,0,-4,28],32]],[73,0,[63,0,-5,39],46]],-16],9],-37],[58,0,[1,1.279,[141,0,[3,0.04,-1,1],57],[10,3.2888,[50,21,-6,[1,1.49,-12,111]],[25,0,-50,73]]],[62,0,-14,18]],[99,0,[125,0,[130,0,[20,-10,[45,0,[0,0.415,22,-4],[227,0,-20,107]],[144,0,0,10]],18],30],[16,4,18,-59]],[16,0,[57,0,-5,-19],[104,0,[218,0,[3,0.05,[58,0,-2,[39,0.084,21,-26]],[11,-1,-29,[0,0.907,4,-19]]],28],-34]],[172,0,[0,-0.001,-21,[150,0,[118,0,[130,0,[52,12,[197,0,[47,0,1,-3],41],[12,35,-1,-32]],9],-36],-53]],53],[21,0.13,[20,0,[49,0,[48,4,[34,0.11562,-3,5],9],-4],[25,0,[44,2,4,76],11]],[45,0.681823,[37,0,-77,-3],1]],[169,0,[12,177,[217,0,[225,0,[44,2,[199,0,[2,0.246,-1,4],6],[39,0.7394,[61,1,-6,30],-155]],22],20],-8],18],[114,0,[141,0,[184,0,[0,1.548,[92,0,[47,0,[57,0,1,-6],[62,0,0,[14,0,-1,-11]]],-26],-29],53],36],5],[94,0,[212,0,[71,0,[67,0,[0,0.899,0,-13],[61,1,9,[6,55,-65,11]]],[46,58,15,-119]],[53,3,3,87]],3],[11,3,[171,0,[11,2,0,[20,-1,[20,-5,8,-34],23]],20],[12,1,[3,0.17,[14,14,[60,0.55,16,-16],-122],-49],-32]],[216,0,[139,0,[53,4,[129,0,[187,0,[157,0,[51,11,[0,0.032,[236,0,1,-66],0],-17],-127],-107],-49],2],51],-85],[35,0.495,[46,55,[174,0,[50,40,-1,[61,1,-16,25]],63],[7,24,10,-24]],[0,0.232,[1,0.037,[0,0.059,-106,2],8],-1]],[84,0,[11,-1,[15,20,13,-81],[1,0.018,[15,21,[227,0,[54,0,-12,[9,4,-1,51]],53],-23],0]],[62,3,9,-44]],[210,0,[99,0,[169,0,[144,0,[128,0,0,16],[19,0,[45,0,-175,45],[45,0.38,170,-12]]],12],[15,42,19,-85]],-38],[222,0,[192,0,[100,0,[172,0,[2,0.27,-1,[20,-1,[21,-0.27,14,-25],[39,0.0305,12,-8]]],32],-89],84],[12,3,-30,35]],[15,10,[5,0.028786,[75,0,12,-29],[41,0.99996,[73,0,[21,0.394,0,-11],32],21]],[40,0,[2,0.12,-5,[20,-1,-8,5]],-9]],[133,0,[106,0,[77,0,[40,0.5506,[217,0,[54,0,-1,0],20],[42,0.032,-19,[45,0.465,-8,47]]],-30],[21,0.217,22,-118]],37],[2,0.746,[166,0,[75,0,[0,0.3363,1,[73,0,[38,0,-6,[37,3,6,-1]],-5]],[4,13,-33,2]],-72],[14,1,-26,27]],[124,0,[140,0,[125,0,[22,6.61124,[42,0.199,[50,44,-1,[61,1,[15,22,-31,8],13]],[15,12,9,-7]],-64],22],3],10],[49,3,[48,23,[1,1.279,1,[5,0.39536,-54,[50,25,-3,[3,0.03,64,-78]]]],[61,0,-20,37]],[5,0.47623,-11,[58,0,11,20]]],[86,0,[30,0,[1,4.399,[46,3,[48,9,-2,[20,-1,-35,11]],0],-8],[43,1,34,[31,0,-17,[20,1,140,11]]]],-25],[72,0,[200,0,[105,0,[230,0,[67,0,[27,0,-1,[4,73,24,-117]],[60,0,24,[23,0,-25,95]]],-42],-45],-56],21],[118,0,[3,0.05,[58,0,-1,[59,0.4895,12,-187]],[11,-1,-21,[1,0.867,[1,0.301,[53,0,-8,4],12],-13]]],[13,20,-80,13]],[26,0,[35,0.495,[46,34,-1,[89,0,[9,11,27,[41,0.99996,-19,8]],-108]],[1,0.0325,[61,1,-3,-31],3]],[32,0.109,10,-7]],[137,0,[131,0,[57,4,[116,0,[1,7.534,[172,0,[178,0,[144,0,0,[19,0,-13,22]],-83],23],-27],-77],-28],-28],25],[103,0,[169,0,[97,0,[178,0,[193,0,[20,-1,[68,0,-5,28],1],5],-44],[2,0.043,37,[10,1.7783,-99,0]]],16],-34],[154,0,[139,0,[134,0,[211,0,[160,0,[102,0,[141,0,[162,0,[218,0,0,23],26],18],42],-151],-19],-58],38],-69],[15,3,[14,10,[12,1,13,-13],-125],[15,8,1,[2,0.066,-10,[45,0.8750003,[7,0,-24,-1],[1,0.196,-3,[37,2,10,4]]]]]],[3,0,-82,[76,0,[80,0,[120,0,[115,0,[175,0,[215,0,[30,0,0,[25,0,-14,55]],11],-52],-39],-126],-20],-23]],[84,0,[147,0,[109,0,[135,0,[54,5,[174,0,[164,0,-1,41],[64,0,155,-188]],[12,1,-108,14]],-43],-57],83],4],[101,0,[0,0.3363,[236,0,1,-26],[15,29,[119,0,[236,0,[4,3,13,[20,-6,-15,-1]],[12,18,-36,68]],-100],-8]],17],[90,0,[12,173,[125,0,[221,0,[212,0,0,[16,3,[12,2,-20,29],-28]],-34],20],[185,0,-12,[45,0.6115,3467,584]]],-10],[21,0.44,[49,6,[48,23,[81,0,0,13],[34,0.444446,15,-69]],[14,4,-14,27]],[45,0.824,[46,7,-48,7],[41,0.50004,-8,61]]],[42,0.858,[16,0,[13,25,5,[15,2,[57,0,[2,0.395,-46,32],-116],5]],[136,0,[112,0,0,38],41]],[2,0.027,127,-7]],[107,0,[214,0,[18,19,[5,0.008463,40,[49,8,-2,-23]],[91,0,[48,10,1,[14,4,[3,0.03,21,-13],57]],-41]],-37],-47],[146,0,[104,0,[209,0,[42,0.693,[69,0,0,[49,0,-36,44]],[45,0.681823,[43,7,-61,[12,0,102,19]],23]],8],-22],-12],[229,0,[137,0,[132,0,[20,-12,[45,0,[9,18,12,-25],-22],[21,-0.394,16,[21,-0.03,-16,1]]],15],[37,0,-15,24]],-32],[0,0.986,[57,0,[3,0.106,-1,[53,0,-17,20]],[56,0,[5,0.762828,2,-59],[12,4,53,-50]]],[10,1.736,36,[163,0,-78,580]]],[139,0,[190,0,[137,0,[40,0.5506,0,[38,0,[45,0.465,25,-136],20]],[37,0,[5,0.12073,78,-53],20]],-168],[4,24,46,-89]],[70,0,[0,0.032,[1,0.068,-29,[236,0,[60,2.15,[7,6,23,[10,1.287,-40,3]],-29],-44]],0],[46,0,38,[9,4,-42,19]]],[182,0,[21,-3.01,-112,[148,0,[181,0,[149,0,[216,0,[121,0,[215,0,0,9],[98,0,32,-173]],-58],-79],-150],-83]],-72],[30,0,[1,4.6558,[97,0,0,[2,0.043,25,-4]],-15],[31,0,[43,1,-25,[20,1,[46,2,-136,-12],6]],[20,1,131,43]]],[230,0,[47,0,1,[62,0,[22,0.2305,[5,0.35137,22,-25],-14],[53,1,[12,14,-18,22],[61,1,41,-1]]]],[40,0.04605,-96,128]],[0,0.947,[66,0,0,[40,0.00018,[201,0,[62,12,[48,3,-25,2],220],61],-63]],[10,1.8506,[60,0.15,-60,44],[37,1,-46,-2]]],[43,0,[0,0.83,[126,0,-1,111],-17],[43,8,[9,32,[63,0,3,[28,0,[38,-1,29,-14],-79]],30],[4,3,12,-4]]],[184,0,[153,0,[159,0,[123,0,[118,0,[209,0,[52,11,0,-2],10],[62,2,23,-128]],[50,6,44,-82]],61],34],52],[229,0,[225,0,[12,368,[21,0.194,[20,0,0,[22,0.33294,[41,0.66667,[20,1,26,[45,0.895,-10,14]],-48],-3]],-3],-47],11],-28],[43,0,[1,0.06,[61,1,[233,0,[2,0.043,29,[8,49,-12,45]],-114],-60],[5,0.871,[61,1,-1,5],[15,17,-7,-59]]],1],[75,0,[52,0,-2,[17,0,[57,0,[0,0.288,14,6],[56,0,-3,[59,0.4895,-192,23]]],-18]],[54,0,[4,20,-77,11],8]],[189,0,[0,-0.001,[49,-1,[40,0.13699,50,-88],-76],[147,0,[96,0,[152,0,[213,0,0,[238,0,25,-336]],-117],-61],70]],76],[50,231,[50,137,[133,0,[138,0,[142,0,0,-101],-69],[15,34,43,-93]],[21,-0.04,-123,[13,211,[61,1,4,39],-60]]],-27],[92,0,[180,0,[67,0,0,[28,0,[49,-1,[40,0.07559,38,4],-1],[6,161,[61,1,-14,[1,0.28,-52,42]],27]]],-86],-17],[20,-15,[60,0,[23,0,[12,8,14,-9],-118],-19],[1,0.694,[38,0,-12,3],[10,1.481,[158,0,[39,0.00985,-72,0],156],-1]]],[154,0,[127,0,[51,17,[48,18,0,[34,0.444446,[49,0,20,[45,1.049,[42,0.1013,-7,163],23]],-114]],[12,5,58,-42]],-8],-51],[2,0.582,[18,18,[49,5,[205,0,-1,-115],-10],[48,15,1,12]],[198,0,[48,8,[60,0.55,[22,0.105,30,-34],-42],25],-240]],[31,0,0,[5,0.4648,[20,-1,[20,-3,20,[45,0.77,[39,0.8465,-202,58],88]],[194,0,[161,0,18,-144],-69]],[30,0,-63,34]]],[189,0,[3,0.05,[1,0,-20,[40,0.5506,[44,2,-1,10],[0,0.4535,8,35]]],[1,1.22,[0,0.678,[53,1,2,7],-9],-26]],48],[93,0,[74,0,[159,0,[143,0,[174,0,0,12],[0,0.509,[206,0,5,-186],-89]],47],[1,0.645,[12,6,-34,40],-45]],35],[176,0,[204,0,[131,0,[222,0,0,7],[9,10,[23,0,-80,62],20]],[2,0.137,-46,16]],[5,0.088024,[4,5,70,-89],92]],[210,0,[106,0,[99,0,[186,0,[226,0,0,-125],108],[239,0,19,-117]],[237,0,[99,0,12,-203],-119]],[156,0,-26,101]],[195,0,[81,0,[0,0.471,1,[40,0.2813,[236,0,-3,[3,0.04,65,-66]],[53,0,32,-41]]],5],[7,6,-20,[5,0.81557,34,-78]]],[122,0,[111,0,[159,0,[110,0,[3,0,[145,0,-75,204],0],[63,0,[37,12,34,-45],-78]],36],-37],[18,15,61,20]],[165,0,[144,0,0,[21,-0.017,[60,1.15,-129,-43],[16,3,[22,0.082,[60,0,140,-6],[60,0,[179,0,-140,165],41]],-22]]],182],[82,0,[66,0,[215,0,[218,0,0,[15,4,[10,3.88358,85,-2],[5,0.205011,-53,8]]],8],[4,2,-106,[232,0,6,-47]]],-18],[1,8.078,[52,12,[208,0,[170,0,[1,0.258,[62,0,4,-9],2],[26,0,201,-119]],43],[51,1,-4,[60,0.25,-37,16]]],-51],[212,0,[224,0,[40,0.5506,0,[42,0.09,-6,[45,0.681823,-12,[36,0,27,105]]]],-58],[53,3,[2,0.09,32,[26,0,-18,-120]],48]],[223,0,[49,34,[71,0,[31,0,0,[183,0,[2,0.16,-19,13],-42]],[1,1.368,-2,24]],-71],[10,6.042,-48,[235,0,34,-192]]],[0,-0.001,[49,-1,16,[13,92,25,-179]],[26,0,0,[3,0.14,[45,0.549,13,[117,0,[7,6,[60,2.95,29,2],-14],-57]],-93]]],[97,0,[231,0,[129,0,[188,0,[158,0,0,36],-103],-9],79],[61,0,[207,0,[3,0.04,[13,11,-88,57],9],-12],-26]],[18,4,[12,102,11,-81],[47,0,[18,19,[197,0,[14,14,-3,-88],-133],3],[45,0.922,7,[10,4.318,[61,0,-15,-33],-6]]]],[151,0,[84,0,[219,0,[203,0,[2,0.746,0,[59,0.0314,[18,8,17,-47],12]],-12],-82],[63,0,[234,0,10,-33],-39]],-55],[173,0,[85,0,[123,0,[134,0,[105,0,[0,0.252,2,-1],-36],-29],[10,5.8344,-50,11]],[196,0,-31,79]],[41,0.3822,66,-61]],[228,0,[213,0,[155,0,[49,0,[0,0.327,4,-2],[20,-7,-13,-1]],-101],[62,2,[13,20,-79,16],48]],[53,0,12,-71]],[5,0.02471,[62,0,[75,0,13,-52],[43,6,[13,26,3,[9,19,-19,-143]],11]],[46,36,0,[13,580,[60,0.15,-10,3],-104]]],[148,0,[127,0,[177,0,[191,0,[220,0,[1,0.178,[61,0,2,[14,0,1,-21]],[61,0,-2,3]],-157],106],118],-3],-70]],"sure":-143,"lead":null}';
  // for train.py, which loads this file under Node and learns from describe()
  if (typeof module == "object") module.exports = { describe };
}

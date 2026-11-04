// jab, a smart tab, in the page you press its shortcut (Ctrl+.) on, put there by background.js on the first press: finds the
// focusable controls, ranks them with the LightGBM trees at the end of this file (written there by train.py), and draws the badges.
// Nothing is cached per page: every press scores the page as it is right now.
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
  host.style.cssText = "all: initial; direction: ltr; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  sheet.replaceSync(`
    .badge { position: fixed; display: flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 3px; box-sizing: border-box; border-radius: 9px; background: #2b6f4b; color: #fff; opacity: .85; font: 700 11px/18px system-ui, sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); }
    .badge.now { background: #00e676; color: #00210e; outline: 1px solid #00210e; box-shadow: 0 0 0 4px rgba(0, 230, 118, .55), 0 2px 6px rgba(0, 0, 0, .4); transform: scale(1.15); z-index: 1; height: 22px; padding: 0 5px 0 4px; border-radius: 11px; }
    .badge.off { opacity: .65; }
    .badge[hidden] { display: none; }
    .arrow { display: inline-block; margin-left: 2px; }
    .into { transform: rotate(15deg); }
    .key { display: inline-block; margin-right: 6px; padding: 0 5px; height: 14px; border: 1px solid #a7b0ac; border-bottom: 2px solid #7d8783; border-radius: 3px; background: linear-gradient(#fff, #dfe4e2); color: #1d2b24; font: 700 9px/14px system-ui, sans-serif; box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(0, 0, 0, .4); }
    .note { position: fixed; right: 16px; bottom: 16px; max-width: 280px; padding: 6px 10px; border-radius: 6px; background: #1f4f35; color: #fff; font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 2px 6px rgba(0, 0, 0, .3); }`);
  root.adoptedStyleSheets = [sheet];
  const draw = (className, textContent) => {
    document.documentElement.append(host);
    return root.appendChild(Object.assign(document.createElement("div"), { className, textContent }));
  };
  const note = (message) => setTimeout((n) => n.remove(), 4000, draw("note", message));

  // A session: our 2 to 4 picks and their badges. The first press of the shortcut only lights pick 1 (lit): nothing is focused, so
  // nothing opens, and Enter uses it. Another press is you choosing: the focus goes to the next pick, and from there on your keys are
  // the page's again. Anything else you do ends the session, and so do 10 s without a press.
  let ses = null,
    timer;
  // each badge sits on the top-left corner of its control with an arrow into it, or at the screen edge with an arrow the way to it
  // when the control is off screen; the lit or focused one is drawn stronger, and the lit one has an Enter key before its number
  const show = () =>
    ses?.badges.forEach((badge, i) => {
      const r = ses.els[i].getBoundingClientRect();
      const arrow =
        r.top >= innerHeight ? "↓" : r.bottom <= 0 ? "↑" : r.left >= innerWidth ? "→" : r.right <= 0 ? "←" : "";
      const lit = ses.lit && i == 0;
      const key = Object.assign(document.createElement("span"), { className: "key", textContent: "Enter" });
      const to = Object.assign(document.createElement("span"), { className: arrow ? "arrow" : "arrow into", textContent: arrow || "↘" });
      badge.replaceChildren(...(lit ? [key] : []), `${i + 1}`, to);
      badge.hidden = !r.width && !r.height; // the page has hidden it
      badge.classList.toggle("off", !!arrow);
      badge.classList.toggle("now", lit || ses.els[i] == active());
      badge.style.cssText = `left: ${Math.min(Math.max(2, r.left - 8), innerWidth - badge.offsetWidth - 2)}px; top: ${Math.min(Math.max(2, r.top - 8), innerHeight - 22)}px`;
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
    if (!el.isConnected) return note("That control has left the page: press jab's shortcut again.");
    el.focus();
    if (press && !typable(el)) el.click();
    else if (active() != el) note("jab could not move the focus here: the page keeps it where it is.");
  };
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
  // A key while pick 1 is lit: Enter uses it, a key that types a character goes into it when it is a field (the focus moves there
  // first; the page's own shortcuts never see that key), Escape only ends the session. Any other key, and any key once the focus is
  // on a pick, ends the session and does what it always does, where the focus is.
  addEventListener(
    "keydown",
    (e) => {
      if (!ses || ["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return;
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

  // A press of the shortcut, from background.js. The browser keeps the shortcut's keys from the page, and sends a press as they go
  // down and, while they are held, some 25 a second after the keyboard's repeat delay: held, they move on once a second. A key
  // coming up on the page is the keys let go. The press that put jab on the page may have been let go before jab could see it, so
  // the press after it waits: for the keys to come up (it was a press of its own) or for another press (the keys are held). Every
  // press, counted or not, gives the session another 10 s.
  let counted = 0,
    released = true,
    unsure = false,
    waiting = false;
  addEventListener(
    "keyup",
    () => {
      released = true;
      unsure = false;
      if (waiting) (waiting = false), go();
    },
    true,
  );
  chrome.runtime.onMessage.addListener(() => {
    if (ses) touch();
    if (waiting) return void (waiting = unsure = false); // held: from here on, once a second
    if (unsure) return void (waiting = true);
    if (!released && performance.now() - counted < 1000) return;
    unsure = !counted; // the press that put jab here
    go();
  });
  const go = () => {
    released = false;
    counted = performance.now();
    if (ses?.els.every((el) => el.isConnected)) return step();
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
      const picked = order.slice(0, 4).filter(([v], k) => k < 2 || v >= (model.sure ?? -Infinity)),
        best = picked.map(([, el]) => el);
      // and the page's search, unless you are typing into something: a field before a button or link that opens one, the one in
      // the page's content (a filter, a section's own search) before the site's. It takes the last pick's place (or the free one
      // after it) when every pick is that specific, an item of a list (a headline, a result, a product) or a link 2+ levels deep,
      // however sure jab is of them: then the search is the way on to anything else
      const specific = ([, , c]) =>
        (c.like > 0 && !c.chrome) || (c.kind == "a" && hrefPath(c).split("/").filter(Boolean).length >= 2);
      const searches = from?.matches(`${TYPED},${EDITABLE}`) ? [] : order.filter(([, el]) => isSearch(el));
      const field = ([, , c]) => isField(c),
        search = (searches.find((s) => field(s) && !s[2].chrome) ??
          searches.find(field) ??
          searches.find(([, , c]) => !c.chrome) ??
          searches[0])?.[1];
      if (search && !best.includes(search) && picked.every(specific)) best.splice(Math.min(best.length, 3), 1, search);
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
  };

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
    '{"features":["x","y","w","h","index","index_frac","count","screen_rank","on_screen_count","controls_above","page_scroll","kind","same_kind_rank","same_kind_count","inputs_on_screen","label_len","label_words","no_parent_text","before_len","nothing_focused","index_delta","focus_dy","focus_dist","focus_filled","same_region","is_submit","submit_like","first_field","form_fields","in_focus_form","after_focus","empty_fields_left","empty_field","fill","sat","round","bold","icon","sat_rank","hit","occluded_share","lcover","lz","foreground","region_size","heading","font","font_rank","in_frame","alike","alike_index","prose","label_repeats","href_repeats","href_depth","slug_words","href_number","picture","same_place_text","same_place_picture","page_pictures","page_prose","page_depth","page_slug_words","page_number"],"kinds":{"a":0,"button":1,"link":2,"menuitem":3,"tab":4,"input checkbox":5,"input text":6,"div":7,"summary":8,"input radio":9,"input email":10,"select":11,"input search":12,"input submit":13,"radio":14,"span":15,"iframe":16,"note":17,"textarea":18,"li":19,"region":20,"tabpanel":21,"input number":22,"input password":23,"td":24,"combobox":25,"group":26,"option":27,"checkbox":28,"input tel":29},"words":["w:html","w:search","w:com","w:privacy","w:new","w:products","w:item","w:policy","w:learn","w:contact","w:home","w:link","w:docs","w:company","w:content","w:support","w:view","w:www","w:source","w:terms","w:resources","w:go","w:get","w:tab","w:opens","w:utm","w:login","w:user","w:slide","w:free","w:button","w:do","w:https","w:cookie","w:sign","w:features","w:facebook","w:careers","w:download","w:email","w:pricing","w:logo","w:skip","w:community","w:live","w:customers","w:start","w:reviews","w:name","w:cloud","w:find","w:share","w:signup","w:partners","w:settings","w:started","w:demo","w:author","w:image","w:language","w:english","w:medium","w:pc","w:ago","w:questions","w:close","w:hide","w:university","w:subscribe","w:register","w:request","w:form","w:chat","w:ads","w:upvote","w:work","w:accept","w:documentation","w:control","w:newsletters","w:first","w:try","w:fk","w:manage","w:works","w:premium","w:apply","w:hl","w:preferences","w:newsletter","w:trial","w:sdk","w:advertisement","w:feedback","w:file","w:message","w:admissions","w:max","w:talk","w:ac","w:academics","w:reject","w:files","w:application","w:donate","w:only","w:ip","w:technologies","w:give","w:install","w:agree","w:interest","w:console","w:pause","w:все","w:extra","w:xs","w:admission","w:ok","w:clipboard","c:in","c:on","c:use","c:resources","c:points","c:search","c:products","c:business","c:comments","c:see","c:accessibility","c:community","c:add","c:start","c:download","c:sales","c:next","c:copyright","c:docs","c:name","c:linkedin","c:try","c:overview","c:request","c:make","c:subscribe","c:twitter","c:newsletter","c:set","c:uses","c:español","c:trusted","c:stay","c:choices","c:box","p:on","p:com","p:data","p:app","p:docs","p:opinion"],"trees":[[39,0,[5,0.28705,[4,0,-57,[48,0,[22,1.21596,-10,-71],2]],[30,0,-30,15]],[4,0,-11,[10,3.26,[48,0,23,-9],28]]],[33,0.98,[7,5,[24,0,[32,0,-18,29],8],[47,4,15,[10,1.5128,-18,[9,5,-12,10]]]],[3,0.017,-96,[7,5,16,21]]],[1,1.468,[2,0.066,[30,0,-7,-4],[48,0,[20,-1,[23,0,3,-43],[20,6,[27,0,15,26],0]],0]],[30,0,-42,5]],[38,-1,[29,0,-25,[20,1,82,-32]],[50,2,[34,0.427,[28,0,[55,0,[37,0,3,-9],[47,1,19,4]],20],17],-10]],[39,0,[29,0,[1,1.804,[48,0,-8,-20],-34],24],[3,0.04,-1,[1,0.2114,4,[21,0.14,[32,0,[11,2,15,17],21],5]]]],[39,0,[1,1.501,[48,0,-5,-19],[30,0,-28,-2]],[2,0.09,[25,0,[2,0.043,-11,2],14],[50,1,[37,0,10,8],0]]],[39,0,[28,0,[1,1.534,-9,-23],-4],[2,0.098,[24,0,[40,0.7006,-4,35],7],[141,0,[32,0,[11,2,6,-20],26],25]]],[1,1.3438,[48,0,[36,0.46,[32,0,[3,0.017,-12,[15,1,-20,2]],8],12],[29,0,[39,0,-11,-5],48]],[29,0,-27,26]],[39,0,[12,19,[24,0,-12,24],-15],[50,3,[35,0.029905,[54,1,[30,0,[32,0,[17,0,-6,-21],25],19],11],9],-13]],[39,0,[12,14,[30,0,-7,12],-17],[2,0.098,[30,0,[141,0,-3,40],15],[48,0,[47,3,15,[34,0.1558,1,13]],-1]]],[1,1.501,[50,1,[24,0,[2,0.043,-7,[1,0.065,-2,[27,0,5,25]]],[20,0,-11,[20,1,17,11]]],-7],[29,0,-22,19]],[1,1.501,[24,0,[50,0,[49,7,[35,0.08171,-2,[2,0.05,-12,10]],20],[50,4,-3,-19]],[25,0,4,84]],[30,0,-19,-8]],[1,1.501,[48,0,[21,0.283,[21,-0.03,-3,[24,0,[2,0.05,2,[0,0.491,9,-3]],16]],-8],[62,0,2,-13]],[29,0,-20,18]],[39,0,[12,25,-7,-12],[2,0.19,[34,0.178,[26,0,[47,12,[54,0,-2,3],[43,0.636,-5,8]],4],3],[2,0.957,8,-17]]],[1,2.124,[37,0,[3,0.04,[2,0.215,[20,8,-1,-12],14],[1,0.246,[62,0,12,-10],[20,12,8,-13]]],-6],[30,0,-12,19]],[39,0,[48,0,[21,0.87,-3,-23],-23],[48,0,[20,14,[20,-1,-4,[141,0,[27,0,4,23],36]],-7],[63,0,1,-8]]],[1,1.601,[37,0,[50,3,[49,9,[35,0.0545,[5,0.66673,0,-12],5],15],-3],[25,0,[17,0,-2,-16],29]],[29,0,-24,20]],[1,1.435,[48,0,[0,0.017,-10,[20,4,[20,0,[0,0.9333,[47,10,5,-1],-15],[20,1,26,6]],-5]],-4],[29,0,-18,14]],[50,2,[21,0.57,[20,0,[1,0.0325,[15,17,-4,-27],[1,2.166,[20,-1,-3,3],-38]],[20,2,14,[141,0,-1,-5]]],-9],-6],[39,0,[48,0,[22,1.0921,[1,0.6775,-20,4],-2],-20],[16,0,-18,[2,0.12,-1,[20,-1,-14,[24,0,[11,14,6,-46],28]]]]],[32,0,[36,0.485,[1,2.005,[25,0,[54,1,-6,[63,0,-16,12]],8],13],[34,0.7068,[59,0,1,6],11]],10],[2,0.027,-3,[48,0,[20,18,[44,0,-4,[32,0,[34,0.1534,[1,2.373,[46,0.929,1,4],-33],16],2]],-7],[62,0,3,-8]]],[37,0,[59,0,[141,0,[32,0,[1,1.804,[94,0,[47,11,[55,0,-6,4],-3],25],[25,0,-36,69]],10],16],24],-5],[24,0,[39,0,[1,0.6775,[46,0,11,-62],[1,1.3438,[63,0,-18,15],-22]],[48,0,[1,0.824,5,-9],-3]],[25,0,0,56]],[16,0,-13,[3,0.04,[59,0,[72,0,[51,40,-5,[46,0.929,-21,12]],-27],33],[0,0.9333,[30,0,[0,0,-26,3],26],-28]]],[50,1,[68,0,[21,0.23,[20,0,[1,0.2114,[63,0,7,-12],4],[20,1,20,1]],-5],-34],[20,0,-6,[20,4,16,-8]]],[2,0.027,-4,[0,0.023,[219,0,-5,98],[1,2.208,[0,0.471,[1,0.12,-3,[42,0,[47,10,8,2],-7]],[43,0.687,-2,8]],-11]]],[37,0,[59,0,[35,0.0545,[5,0.7624315,[47,23,[51,46,0,9],-12],-6],4],17],[58,0,[54,0,-11,5],[57,0,22,-123]]],[24,0,[1,2.6877,[50,0,[50,-1,[35,0.07097,[157,0,[48,0,0,-17],-100],1],10],-3],-18],[25,0,1,[31,0,77,-69]]],[20,-8,-9,[20,9,[20,0,[50,6,[43,0.8107,[5,0.675942,[54,0,[27,0,1,14],1],-13],27],-20],[20,3,11,0]],-7]],[141,0,[26,0,[1,0.0315,[219,0,[0,0.0787,-35,-8],20],[2,0.074,[21,0.383,-3,-24],[0,0.923,[55,3,1,10],-28]]],7],12],[120,0,[45,1,[30,0,[1,1.279,[0,0.032,-12,[103,0,[43,0.7653,[121,0,-1,24],6],19]],-12],11],[55,0,-32,13]],20],[16,0,-11,[3,0.017,-7,[48,0,[20,-1,1,[32,0,[11,1,[46,0.9335,-2,[100,0,5,-78]],-13],11]],[63,0,3,-5]]]],[113,0,[36,0.485,[20,13,[20,0,[50,5,[49,9,[105,0,[219,0,-1,6],12],-1],-19],[20,1,16,0]],-13],2],20],[37,0,[59,0,[39,0,[1,0.806,[46,0.44,8,-36],[1,1.279,[46,0.403,-80,14],-17]],[1,0.846,2,-3]],11],[58,0,-2,-16]],[34,0.69784,[45,1,[32,0,[26,0,[17,0,[105,0,[1,0.0315,-8,0],14],[130,0,-13,11]],7],4],[54,0,-20,9]],5],[0,1.14,[87,0,[20,-10,-9,[141,0,[56,0,[30,0,[1,2.558,[111,0,[0,0.032,-10,0],21],-2],7],7],11]],10],-42],[98,0,[43,0.7892,[47,14,[77,0,[0,0.9434,[1,0.055,[62,0,-1,-9],[1,1.279,3,[59,0,-17,21]]],-10],20],-2],5],-16],[68,0,[48,0,[44,0,-4,[21,0.16,[30,0,4,10],-3]],[62,1,[39,0,1,[161,0,[105,0,0,20],75]],-10]],-7],[106,0,[2,0.27,[94,0,[50,8,[43,0.771,[161,0,[120,0,[30,0,-1,4],19],20],8],-14],10],[11,-1,-41,5]],-43],[2,0.027,[130,0,-6,38],[157,0,[89,0,[0,0.405,[0,0.04,[69,0,-2,47],3],[77,0,[43,0.267,-3,7],5]],-20],-111]],[22,3.37335,[47,6,[55,3,[32,0,[17,0,[11,1,2,-5],[11,0,-38,16]],6],4],[3,0.04,[130,0,-5,24],2]],-24],[99,0,[48,0,[44,0,-3,[21,0.206,[152,0,2,-97],-1]],[63,0,[1,0.336,[21,-0.017,-15,14],-24],[14,0,2,-19]]],16],[20,-3,-5,[3,0.017,-5,[121,0,[0,1.431,[55,3,[30,0,[1,3.135,[133,0,1,-55],12],8],[0,0.3222,13,-5]],-67],7]]],[117,0,[59,0,[39,0,[42,0,[0,0.1634,25,-15],[46,0,-6,-49]],[40,0.5267,[1,0.89,0,-9],17]],[63,0,-12,16]],19],[15,0,[58,0,-3,-102],[103,0,[161,0,[145,0,[20,-9,-5,[12,67,[56,0,0,[47,0,24,1]],-7]],30],20],18]],[141,0,[117,0,[66,0,[199,0,[130,0,[5,0.844836,[2,0.027,-8,[20,-12,-6,0]],-11],22],19],[63,0,13,1]],14],12],[94,0,[20,-1,-3,[2,0.176,[43,0.8142,[20,6,[22,0,-2,5],-8],13],[58,0,[49,7,2,17],[3,0.106,-2,-30]]]],5],[105,0,[1,0.0315,[62,1,[26,0,-2,8],[219,0,-15,121]],[21,0.45,[38,2,[0,0.9333,6,-22],[47,0,16,-1]],-6]],14],[121,0,[175,0,[91,0,[0,0.647,[20,-1,-3,[1,0.0945,[62,0,3,-15],[1,0.747,6,-5]]],[77,0,-3,25]],17],34],19],[2,0.902,[50,0,[49,4,[68,0,[7,0,[46,0.584,-65,4],1],-28],5],[20,0,[105,0,-3,25],[20,2,34,-5]]],-25],[157,0,[37,0,[59,0,[128,0,[113,0,0,17],-122],[40,0.785,[47,0,34,[49,6,-27,23]],-103]],[50,1,0,-11]],-92],[103,0,[36,0.423,[130,0,[32,0,[59,0,[1,2.992,-2,-39],13],[44,3,[2,0.293,-21,28],17]],12],[3,0.05,-2,7]],10],[134,0,[1,-0.001,10,[198,0,[43,0.223,[47,6,[49,9,[75,0,0,-20],[40,0.584,13,-92]],[3,0.05,-5,5]],5],9]],28],[66,0,[212,0,[199,0,[22,0.3772,[20,0,[1,2.6877,-1,-46],[20,1,[42,0.55023,26,-42],5]],-2],16],-77],[62,1,12,-10]],[117,0,[161,0,[34,0.6588,[25,0,[55,2,[70,0,[103,0,-2,16],18],[42,0,[0,0.338,7,1],-4]],9],4],22],15],[106,0,[16,0,[25,0,-8,53],[93,0,[98,0,[0,1.52998,[152,0,[198,0,[43,0.6737,0,2],13],-38],-25],-8],-42]],-27],[134,0,[100,0,[208,0,[22,3.37335,[141,0,[47,36,[54,0,-1,1],[53,14,-7,-39]],9],-21],20],[49,0,57,-43]],17],[30,0,[1,3.501,[0,0.017,[219,0,-3,17],[77,0,[0,0.334,1,-1],[51,116,[63,0,40,-26],55]]],-26],[15,11,22,-2]],[43,0.232,[99,0,[42,0,[20,-1,-8,2],[63,0,[7,0,-23,[12,3,12,-3]],-10]],10],[15,19,[11,0,-1,16],-16]],[32,0,[11,1,[17,0,[11,-1,-34,[2,0.02,-38,1]],[43,0.377,-12,31]],[3,0.13,[52,0,10,-51],-68]],[64,0,9,-56]],[20,-12,-5,[72,0,[105,0,[84,0,[91,0,[1,0.262,[62,0,3,-5],[62,0,-3,3]],13],-31],[194,0,17,-58]],-16]],[21,0.34,[20,0,[50,0,[49,3,[132,0,[43,0.687,[5,0.68752,0,-13],21],-93],6],-2],[20,4,[49,5,2,25],-5]],-4],[48,0,[44,0,[46,0.9679,-8,[1,0.178,-12,5]],[1,1.279,3,[225,0,-21,83]]],[63,0,[20,-12,-28,5],[14,0,1,-14]]],[66,0,[27,0,[175,0,[87,0,[45,2,-1,5],7],27],[4,73,[29,0,40,-160],-142]],[61,0,20,[62,1,5,-19]]],[59,0,[1,1.279,[133,0,0,-44],[61,1.75,[51,21,-1,[10,3.778,[1,1.5664,59,[61,0.45,253,151]],24]],-46]],[58,0,8,-17]],[0,-0.001,-26,[88,0,[206,0,[153,0,[48,0,[44,0,-1,[34,0.7068,0,14]],[39,0,-12,[63,0,0,-3]]],-33],20],-28]],[26,0,[130,0,[0,0.9333,[47,5,[49,9,-1,[61,0,44,-2]],[35,0.02501,-2,[41,0.19779,0,28]]],-2],9],[61,1.75,8,-3]],[136,0,[147,0,[21,-2.094,-73,[3,0,-82,[215,0,[135,0,[161,0,[146,0,[178,0,0,-106],22],17],19],-49]]],52],25],[142,0,[2,0.87,[1,-0.001,-1,[162,0,[15,0,[58,0,-7,-97],[2,0.215,0,[20,-1,-8,[61,1.25,9,-6]]]],-101]],-12],44],[0,1.52998,[138,0,[214,0,[141,0,[51,84,0,[49,4,-13,[224,0,14,46]]],[62,0,29,[41,0.21855,-20,14]]],-20],-56],-37],[120,0,[12,95,[181,0,[86,0,[0,0.023,[224,0,[219,0,2,31],-121],[77,0,0,[0,0.07037,-47,19]]],-25],107],-14],5],[119,0,[43,0.783,[107,0,[47,34,[38,35,[165,0,0,40],14],[12,1,45,[189,0,-8,-47]]],-122],[46,0.626,-71,18]],-26],[93,0,[83,0,[20,-12,[50,1,-2,-10],[43,0.8263,[68,0,[84,0,[54,0,0,1],-37],-5],4]],[153,0,-7,-166]],-26],[175,0,[199,0,[30,0,[1,3.56,0,-12],[25,0,[32,0,-14,[20,1,122,[31,1,106,-26]]],[31,0,11,-39]]],8],12],[85,0,[139,0,[0,0.491,0,[41,0.27524,[91,0,[224,0,[137,0,-2,-51],[12,17,-47,90]],12],[42,0.24,-38,30]]],-138],-15],[161,0,[48,0,[58,0,1,-5],[62,1,[5,0.453505,[54,0,[11,0,-19,[5,0.04446,15,-11]],8],[5,0.966838,-37,28]],-7]],13],[111,0,[36,0.505,[21,0.23,[20,0,0,[20,3,[6,201,-1,44],-6]],[46,0.823,[1,0.905,-12,-45],[23,0,10,-26]]],2],11],[121,0,[59,0,[39,0,[40,0.053,[9,10,-28,[51,14,9,27]],-16],[40,0.446,0,13]],[14,7,-5,[7,1,91,81]]],9],[113,0,[101,0,[70,0,[124,0,[146,0,[12,67,[55,4,[3,0.46,0,-29],7],-4],17],-46],[54,1,20,-2]],-58],4],[150,0,[105,0,[1,0.262,[62,1,1,-11],[62,0,[42,0.5034,-5,[55,0,30,-6]],[41,0.000568,8,-18]]],[2,0.043,30,-5]],-63],[3,0,-44,[158,0,[154,0,[99,0,[165,0,[28,1,0,[27,0,9,[11,24,21,-139]]],27],[14,1,12,-41]],-23],-88]],[117,0,[50,34,[30,0,[1,3.812,[49,6,-1,2],[59,0,-59,[176,0,43,1528]]],[25,0,[32,0,-14,41],23]],-46],10],[144,0,[172,0,[0,1.431,[157,0,[87,0,[2,0.27,0,[11,-1,[32,0,-79,134],[58,0,3,-2]]],5],-64],-39],-69],-115],[75,0,[73,0,[1,-0.001,-3,[196,0,[203,0,[59,0,0,[40,0.6887,[58,0,[60,0.496,18,-91],-15],-36]],21],-25]],-19],-10],[22,0.7222,[20,0,[1,3.29,[50,4,[49,23,0,17],-7],-40],[20,1,[42,0.51907,16,-17],[46,0.8653854,-10,[22,0.183,34,1]]]],-4],[66,0,[2,0.707,[199,0,0,8],-13],[23,0,[61,0,[29,0,18,[32,0,-6,-304]],[44,3,[6,177,-21,23],0]],82]],[161,0,[106,0,[210,0,[130,0,[54,4,[125,0,0,[47,0,81,-84]],8],[46,0.403,-95,[42,0.66667,-12,33]]],-57],-22],11],[167,0,[136,0,[118,0,[90,0,[41,0.2647,[98,0,[46,4.31,0,-177],-20],[11,0,-6,[11,1,28,-25]]],-25],-58],22],38],[122,0,[173,0,[215,0,[36,0.505,[213,0,[51,73,0,[62,1,-8,[6,114,34,-8]]],-34],1],-33],-90],[10,3.9376,-130,-22]],[3,0.05,[1,0,-23,[47,4,[49,4,[61,0.45,[1,0.565,14,-7],-10],[40,0.0265,10,-15]],-1]],[1,1.248,[0,0.899,3,-17],-31]],[74,0,[114,0,[88,0,[174,0,[93,0,[26,0,0,[35,0.048109,11,[28,0,0,[23,0,-31,62]]]],-21],69],-25],-49],16],[131,0,[142,0,[1,0.298,[63,0,1,[8,13,12,-11]],[63,0,[3,0.04,[100,0,-8,-116],3],[41,0.000568,7,-12]]],27],-76],[141,0,[128,0,[178,0,0,-72],-80],[166,0,[41,0.06668,-33,[46,0,[19,0,-303,230],[62,0,37,[41,0.191,-6,25]]]],-115]],[66,0,[27,0,-1,[44,3,2,36]],[28,0,[5,0.060676,57,11],[61,0.75,[31,0,6,[44,1,-142,30]],[63,0,-14,-32]]]],[117,0,[0,-0.001,-18,[59,0,[1,1.279,0,[5,0.35462,-31,[15,38,0,[3,0.03,87,7]]]],[39,-1,[5,0.33341,-7,49],-1]]],10],[102,0,[134,0,[139,0,[3,0,-50,[43,0.2211,[47,5,[49,9,0,5],0],[41,0.26314,-4,[46,0,-42,32]]]],-118],14],-63],[20,30,[20,0,[50,0,[49,23,1,19],[20,-8,-12,-2]],[49,6,-2,19]],[46,0,[141,0,-10,-148],[41,0.06668,-19,14]]],[218,0,[105,0,[208,0,[1,0.055,[62,2,[15,22,-1,-26],-25],[20,-1,-3,1]],12],[51,7,[62,0,25,-16],-45]],41],[190,0,[212,0,[183,0,[43,0.8797,[171,0,[146,0,-1,[38,5,-21,42]],53],16],[35,0.4167,143,-36]],-54],[61,1.75,19,4]],[133,0,[121,0,[167,0,[53,9,[189,0,[53,1,[79,0,-1,-43],[54,0,-15,10]],49],[92,0,2,-195]],22],9],-15],[103,0,[185,0,[0,0.782,[5,0.974,0,[11,0,-24,32]],[224,0,[41,0.05242,[26,0,-18,4],-2],73]],5],[16,4,8,-68]],[111,0,[115,0,[47,54,[7,48,[148,0,[170,0,[207,0,0,24],-41],-46],20],[40,0,-40,[50,6,-6,-100]]],34],12],[46,3.74,[156,0,[138,0,[161,0,[177,0,[181,0,[201,0,0,20],[13,25,168,-92]],88],[38,1,-88,26]],-36],-39],-60],[15,0,[53,0,[11,22,8,-165],-26],[52,9,[181,0,[21,-2.094,-63,[32,0,[11,1,0,-4],9]],[65,0,110,-73]],-19]],[181,0,[50,3,0,[47,16,[5,0.428684,-4,[40,0.0265,[18,19,-19,[1,1.3438,-4,[61,1.95,88,-89]]],-20]],-12]],[46,0.929,85,-82]],[205,0,[135,0,[74,0,[37,0,0,[193,0,[39,0,-15,[60,0.3204,-4,[1,0.786,28,-19]]],[61,0.55,-268,85]]],13],13],-68],[1,9.954,[202,0,[180,0,[58,0,[53,0,-2,[55,0,-10,[5,0.85985,10,-35]]],[57,0,1,[179,0,-93,769]]],-100],-134],-56],[119,0,[181,0,[153,0,[165,0,[95,0,[204,0,[0,0.491,0,[224,0,-1,25]],19],17],19],-14],[13,58,108,-84]],-16],[82,0,[0,1.431,[169,0,[70,0,[216,0,0,-30],[191,0,-10,[61,0.35,82,0]]],-60],-20],[2,0.09,[4,12,75,-61],-67]],[128,0,[71,0,[43,0.1883,-1,[54,0,[3,0.13,[46,0.337,-12,[41,0.21093,5,34]],-95],-6]],[40,0.0272,[1,1.403,31,135],-46]],-65],[75,0,[44,15,[77,0,1,[16,1,26,-17]],[39,0,[40,0.1398,-13,[0,-0.001,73,-47]],[47,0,22,1]]],[15,4,-45,9]],[182,0,[43,0.365,[2,0.035,[76,0,[77,0,[33,0.104,[105,0,[50,-1,5,[181,0,-14,84]],25],-25],41],-142],0],0],62],[0,-0.001,[40,0.665,[61,0,33,-88],69],[1,0.018,[61,0,9,[55,0,[69,0,-28,72],[2,0.215,[3,0.05,-13,17],-77]]],0]],[21,-2.094,-57,[127,0,[150,0,[2,0.27,0,[55,2,[32,0,[12,2,[15,41,-9,-71],[62,1,-10,17]],8],13]],-51],-16]],[217,0,[215,0,[151,0,[120,0,[20,-13,[46,0.6814,16,-18],0],[21,0.317,16,[20,2,-237,-18]]],[41,0.073894,-1,109]],-15],-52],[116,0,[175,0,[96,0,[184,0,[110,0,[114,0,[206,0,[171,0,0,43],21],-27],-39],153],35],44],[41,0.04512,-29,-132]],[67,0,[197,0,[99,0,[141,0,0,[62,0,10,[41,0.13907,-13,7]]],[14,1,6,-19]],39],[61,2.55,[1,0.699,6,-45],-43]],[123,0,[0,0.407,[56,0,0,[23,0,[20,-1,-14,[122,0,13,-95]],-61]],[41,0.3127,-2,[54,0,31,-16]]],[81,0,11,-220]],[1,0.786,[39,0,[46,0,12,[1,0.589,-52,2]],1],[46,0.5005,-17,[10,1.5128,[160,0,[61,0.45,-94,-25],173],[63,4,1,34]]]],[30,0,[1,4.146,0,-15],[25,0,[32,0,[47,2,[61,1.95,-125,21],6],[20,1,91,[31,1,69,-9]]],[31,0,25,6]]],[134,0,[103,0,[186,0,[45,2,-1,5],11],[15,9,[220,0,35,-87],[12,26,[0,0.496,26,[18,4,146,-47]],-105]]],11],[142,0,[155,0,[133,0,[103,0,[159,0,0,61],[15,30,11,-23]],-10],[13,8,-80,41]],[38,24,[2,0.137,48,-33],-79]],[214,0,[167,0,[209,0,[190,0,0,[60,0.0761,[6,199,-6,31],[222,0,39,-103]]],33],[5,0.648958,31,-91]],[15,11,8,-14]],[80,0,[192,0,[108,0,[139,0,[200,0,[158,0,[178,0,0,-47],-61],[5,0.453505,33,-89]],-100],[62,0,-88,18]],-26],-21],[135,0,[28,1,[11,1,0,[14,0,-26,[31,0,[61,1.45,[14,9,[12,0,27,-4],-69],3],[44,1,-146,-20]]]],11],5],[115,0,[30,0,[175,0,[84,0,[55,2,0,[3,0.117,-6,[58,0,29,20]]],-11],-3],[25,0,[32,0,-4,25],15]],20],[129,0,[50,34,[131,0,[130,0,0,[43,0,[3,0.03,16,[0,0.437,16,-91]],[42,0,-142,[61,0,-51,23]]]],-50],-31],43],[70,0,[105,0,[188,0,[20,-1,[2,0.16,[4,3,18,-4],-13],0],-19],[51,7,[61,0.45,43,-11],-34]],[12,3,20,-4]],[1,0.055,[62,1,[15,8,[2,0.09,5,-21],[32,0,-10,30]],[40,0.3258,[48,0,[46,0.65003,14,[187,0,-78,222]],-1],30]],1],[50,1,[49,19,[189,0,[1,0.786,1,[46,0.72225,-9,1]],-6],7],[5,0.5001,[50,10,-2,[13,4,109,-56]],[10,1.4634,-11,8]]],[117,0,[112,0,[21,-0.03,[46,0.626,[21,-0.206,[21,-1.03,-147,17],-19],-12],1],[61,0.25,-73,24]],[21,0.36,[10,4.614,-20,25],-66]],[106,0,[205,0,[1,8.976,[101,0,[93,0,0,[11,0,92,[5,0.04019,186,-73]]],-36],[176,0,-52,[36,0.5995,-21,-9728]]],-51],-18],[140,0,[163,0,[167,0,[164,0,[211,0,[195,0,[165,0,0,18],-46],-43],-47],[46,0.8825,-30,44]],30],[104,0,11,79]],[218,0,[203,0,[143,0,[3,0,-23,[111,0,[83,0,0,[153,0,-7,-111]],6]],[221,0,26,81]],[2,0.145,18,-66]],26],[168,0,[101,0,[109,0,[28,1,[78,0,[104,0,0,[9,18,-17,[28,0,-53,-235]]],-28],[1,0.546,31,-15]],24],-28],46],[133,0,[136,0,[11,-1,[15,22,[42,0.17,[3,0.24,54,-153],-80],-123],[22,0.3326,1,-2]],[223,0,[25,0,25,-85],-218]],-17],[120,0,[149,0,[51,84,0,[63,5,[224,0,-7,[5,0.17547,-133,60]],60]],-50],[62,2,[50,-1,0,40],[60,0.072,-142,72]]],[58,4,[103,0,[75,0,[126,0,[207,0,0,[18,9,64,[54,0,51,-60]]],-31],[15,4,-31,4]],[97,0,9,-171]],-27],[50,1,[49,78,[0,0.491,3,[2,0.082,[7,2,16,-4],-6]],56],[2,0.09,[105,0,-6,26],[42,0.666685,[40,0.0305,3,-9],28]]]],"sure":-356}';
  // for train.py, which loads this file under Node and learns from describe()
  if (typeof module == "object") module.exports = { describe };
}

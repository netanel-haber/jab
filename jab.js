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
    .badge { position: fixed; display: flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 3px; box-sizing: border-box; border-radius: 9px; background: #2b6f4b; color: #fff; opacity: .85; font: 700 11px/18px system-ui, sans-serif; text-align: center; box-shadow: 0 1px 3px rgba(0, 0, 0, .35); }
    .badge.now { background: #00e676; color: #00210e; outline: 2px solid #00210e; box-shadow: 0 0 0 4px rgba(0, 230, 118, .55), 0 2px 6px rgba(0, 0, 0, .4); transform: scale(1.15); z-index: 1; }
    .badge.off { opacity: .65; }
    .badge[hidden] { display: none; }
    .into { display: inline-block; transform: rotate(22.5deg); }
    .key { display: inline-block; margin-right: 4px; padding: 0 4px; height: 11px; border: 1px solid #a7b0ac; border-bottom: 2px solid #7d8783; border-radius: 3px; background: linear-gradient(#fff, #dfe4e2); color: #1d2b24; font: 700 9px/11px system-ui, sans-serif; box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(0, 0, 0, .4); }
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
  // each badge sits on the top-left corner of its control with an arrow into it, or at the screen edge with an arrow the way to it
  // when the control is off screen; the lit or focused one is drawn stronger, and the lit one has an Enter key before its number
  const show = () =>
    ses?.badges.forEach((badge, i) => {
      const r = ses.els[i].getBoundingClientRect();
      const arrow =
        r.top >= innerHeight ? "↓" : r.bottom <= 0 ? "↑" : r.left >= innerWidth ? "→" : r.right <= 0 ? "←" : "";
      const lit = ses.lit && i == 0;
      const key = Object.assign(document.createElement("span"), { className: "key", textContent: "Enter" });
      const into = Object.assign(document.createElement("span"), { className: "into", textContent: "↘" });
      badge.replaceChildren(...(lit ? [key] : []), `${i + 1}`, arrow || into);
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
    '{"features":["x","y","w","h","index","index_frac","count","screen_rank","on_screen_count","controls_above","page_scroll","kind","same_kind_rank","same_kind_count","inputs_on_screen","label_len","label_words","no_parent_text","before_len","nothing_focused","index_delta","focus_dy","focus_dist","focus_filled","same_region","is_submit","submit_like","first_field","form_fields","in_focus_form","after_focus","empty_fields_left","empty_field","fill","sat","round","bold","icon","sat_rank","hit","occluded_share","lcover","lz","foreground","region_size","heading","font","font_rank","in_frame","alike","alike_index","prose","label_repeats","href_repeats","href_depth","slug_words","href_number","picture","same_place_text","same_place_picture","page_pictures","page_prose","page_depth","page_slug_words","page_number"],"kinds":{"a":0,"button":1,"link":2,"tab":3,"input text":4,"menuitem":5,"input checkbox":6,"div":7,"input radio":8,"summary":9,"input email":10,"select":11,"input search":12,"span":13,"input submit":14,"radio":15,"textarea":16,"input password":17,"note":18,"iframe":19,"input number":20,"li":21,"region":22,"tabpanel":23,"combobox":24,"listitem":25,"option":26,"checkbox":27,"group":28,"input tel":29},"words":["w:html","w:id","w:of","w:search","w:products","w:privacy","w:item","w:new","w:docs","w:contact","w:policy","w:home","w:product","w:site","w:company","w:terms","w:resources","w:support","w:tab","w:get","w:up","w:login","w:source","w:opens","w:free","w:use","w:features","w:slide","w:shop","w:sign","w:cookie","w:careers","w:pricing","w:email","w:facebook","w:button","w:download","w:do","w:reviews","w:logo","w:skip","w:customer","w:community","w:signup","w:details","w:start","w:settings","w:topic","w:account","w:name","w:started","w:partners","w:ago","w:image","w:guide","w:upvote","w:english","w:buy","w:author","w:language","w:demo","w:fk","w:close","w:pc","w:ads","w:subscribe","w:register","w:request","w:work","w:kết","w:dp","w:try","w:documentation","w:first","w:form","w:accept","w:コメント","w:hl","w:movie","w:personal","w:theme","w:ja","w:na","w:previous","w:chat","w:university","w:response","w:query","w:archive","w:trial","w:premium","w:sdk","w:safety","w:message","w:sort","w:ip","w:choices","w:feedback","w:max","w:projects","w:windows","w:newsletter","w:talk","w:edit","w:only","w:advertisement","w:admissions","w:academics","w:agree","w:sam","w:xs","w:environment","w:term","w:install","w:pause","w:mat","w:description","w:martin","w:membership","w:arts","w:database","w:drive","w:want","w:uses","w:becker","w:original","w:spain","w:load","w:buscar","w:street","c:in","c:new","c:points","c:comments","c:free","c:search","c:business","c:see","c:hours","c:company","c:do","c:hide","c:start","c:app","c:website","c:download","c:log","c:add","c:media","c:started","c:newsletters","c:name","c:docs","c:latest","c:next","c:try","c:guide","c:overview","c:demo","c:travel","c:teams","c:request","c:linkedin","c:works","c:box","c:español","c:stay","c:experience","c:make","c:choices","p:docs","p:learn","p:video","p:analysis","p:headlines"],"trees":[[39,-1,[30,0,-35,22],[4,0,-2,[3,0.04,[10,2.7917,[48,0,13,-21],[39,0,-5,21]],[39,0,[48,0,1,-47],31]]]],[33,0.035,[7,5,[12,22,[24,0,[37,0,-9,-14],10],-22],[47,4,[54,0,-21,28],-1]],[20,-1,[23,0,1,-6],15]],[1,1.49,[2,0.09,[30,0,[2,0.043,-16,2],14],[27,0,[48,0,[11,4,[37,0,12,3],-16],-4],33]],[30,0,-30,26]],[38,-1,[29,0,-32,[20,1,82,-28]],[50,1,[34,0.2981,[28,0,[2,0.066,-4,[49,9,5,15]],27],19],[50,3,-3,-15]]],[39,0,[29,0,[1,1.792,-15,-23],37],[35,0.03135,[32,0,[24,0,[15,19,[13,43,-12,2],[46,0.9335,-3,8]],15],29],11]],[39,0,[30,0,[1,1.56,-12,-22],13],[2,0.098,[25,0,[2,0.027,-12,[50,1,0,-4]],3],[32,0,[36,0.43,3,12],24]]],[39,0,[28,0,[1,2.135,-11,-20],-1],[48,0,[21,0.24,[21,-0.03,[23,0,0,-45],[2,0.06,[24,0,4,18],10]],2],-7]],[39,0,[30,0,[1,1.49,-10,-20],12],[32,0,[140,0,[48,0,[3,0.017,-8,[5,0.464315,[34,0.4627,5,17],-4]],-8],40],14]],[39,0,[12,17,[24,0,-10,9],-19],[50,2,[30,0,[1,0.068,-4,[23,0,[38,2,12,5],-6]],[20,1,16,19]],-8]],[39,0,[28,0,[4,29,-7,-19],0],[2,0.098,[30,0,[37,0,0,-12],24],[37,0,[20,-1,-8,[47,1,29,7]],-2]]],[1,1.368,[33,0.996,[47,11,[1,0.068,[0,0.0924,-36,1],[20,-1,-4,7]],[50,0,-4,-7]],[3,0.017,-105,7]],[29,0,-24,35]],[39,0,[24,0,[1,1.935,[48,0,-6,-18],-27],15],[32,0,[36,0.423,[25,0,[17,0,-2,-13],11],[1,0.0315,-6,9]],13]],[1,1.435,[48,0,[32,0,[21,0.306,[21,-0.03,-4,[24,0,[140,0,2,18],12]],-6],12],[24,0,-8,18]],[29,0,-19,35]],[39,0,[12,18,-4,-15],[2,0.074,[26,0,[47,6,3,-11],13],[50,3,[15,0,-15,[49,8,[35,0.0549,0,8],14]],-6]]],[39,0,[24,0,[1,2.293,-8,-21],[20,1,38,-13]],[30,0,[2,0.05,-4,[48,0,[23,0,[0,0.478,6,0],-28],-3]],25]],[20,13,[20,0,[37,0,[39,0,[48,0,-3,-26],[2,0.184,[34,0.2981,-1,6],[20,-1,-22,9]]],-7],[20,1,24,2]],-10],[1,1.7254,[50,0,[49,8,[35,0.08246,[26,0,[0,0.032,-7,-2],16],4],26],[24,0,[51,86,-8,3],9]],[29,0,-16,32]],[21,0.57,[48,0,[32,0,[36,0.495,[3,0.017,-10,[50,5,[20,-1,-3,[20,6,1,-5]],-14]],5],14],[63,0,4,-13]],-8],[20,8,[20,0,[1,2.252,[48,0,[27,0,[84,0,[54,0,1,-1],41],[29,0,25,-133]],-7],-36],[20,2,13,4]],-9],[39,0,[48,0,[22,1.2512,-3,0],-24],[2,0.207,[140,0,[89,0,[1,0.846,[50,1,1,-5],-10],20],22],[20,-1,-14,9]]],[59,0,[1,1.49,[34,0.6744,[47,13,[48,0,[32,0,[54,0,[25,0,-7,27],4],8],-4],-5],11],[29,0,-27,27]],19],[37,0,[59,0,[3,0.04,[51,44,[12,47,-2,-20],[46,0.999926,-34,29]],[30,0,[1,1.466,2,-104],31]],24],[17,0,-3,-20]],[20,16,[20,0,[50,2,[1,0.0315,[149,0,[64,0,[26,0,-7,10],-44],98],[19,0,-3,2]],-8],[20,3,12,-2]],-10],[16,0,-19,[48,0,[21,0.44,[20,-1,-1,[24,0,[1,0.037,-21,[47,6,9,-1]],11]],-5],[39,0,-30,[63,0,8,-8]]]],[2,0.043,[97,0,-10,73],[0,0.018,[229,0,-11,88],[140,0,[48,0,[46,0.929,[21,0.13,[30,0,0,2],-14],6],-2],13]]],[1,2.2114,[26,0,[1,0.0315,[63,0,0,-16],[47,3,[56,0,[32,0,[17,0,1,-30],26],12],[38,3,3,0]]],4],2],[36,0.495,[32,0,[39,0,[51,25,-18,[61,1.75,44,-29]],[11,2,-1,[3,0.083,0,-88]]],8],[70,0,[2,0.27,3,12],-46]],[22,2.49113,[24,0,[115,0,[50,4,[49,14,[43,0.7876,[89,0,-1,15],18],14],-17],25],[25,0,[27,0,-2,-119],73]],3],[37,0,[59,0,[12,56,[3,0.04,[91,0,0,1],2],-5],18],[55,0,[25,0,-15,18],[16,0,-19,[39,0,-18,9]]]],[0,0.94,[3,0.017,-12,[48,0,[21,0.15,[20,0,[50,0,5,[63,0,-24,-4]],[20,1,28,4]],-6],[63,0,4,-11]]],-15],[1,2.645,[0,0.023,[229,0,-9,31],[73,0,[94,0,[2,0.098,[97,0,-4,24],[1,0.196,-5,[0,0.6085,7,-4]]],16],16]],-5],[140,0,[95,0,[30,0,[55,0,[43,0.6133,-5,9],[5,0.754916,[16,0,-34,[47,14,[1,2.74,5,-16],-1]],-22]],10],-28],18],[199,0,[2,0.254,[43,0.785,[21,0.44,[20,0,[101,0,[97,0,-3,8],25],[20,4,10,-6]],-8],11],[58,0,5,-13]],14],[20,-8,-7,[20,22,[104,0,[20,0,[1,3.0472,[94,0,[1,1.003,0,7],13],-25],[20,1,8,[46,0.68182,-9,9]]],-41],-4]],[0,1.424,[59,0,[2,0.027,-5,[125,0,[108,0,[26,0,[1,0.037,[63,0,-2,-12],[88,0,0,-22]],4],22],28]],6],-50],[0,0.018,[149,0,-4,23],[73,0,[0,0.986,[36,0.423,[32,0,[59,0,-3,17],[44,2,-6,26]],3],-18],[44,17,22,-43]]],[125,0,[45,2,[140,0,[115,0,[26,0,[27,0,[110,0,[171,0,-2,40],15],[28,1,0,40]],3],14],14],5],21],[56,0,[35,0.0656,[0,0.032,-17,[171,0,-1,45]],1],[58,0,[20,-1,-19,[47,0,[46,0.929,-35,36],8]],[57,0,-3,-59]]],[170,0,[48,0,[20,30,[56,0,[43,0.808,[44,0,-6,2],20],8],-9],[39,0,-14,[63,0,4,[14,0,2,-20]]]],-108],[3,0.017,-6,[30,0,[1,3.35,[55,0,[3,0.25,[41,0.2893,-3,30],-46],[0,0.471,[42,0,6,-7],-4]],-15],[15,13,8,4]]],[105,0,[75,0,[16,0,[58,0,-3,-28],[2,0.254,[21,0.283,[50,5,[229,0,[104,0,1,-49],4],-13],-3],2]],-15],-98],[127,0,[0,0.94,[95,0,[36,0.423,[47,6,2,[3,0.04,[53,14,[51,70,-10,25],-35],[15,3,-15,2]]],2],-24],-9],17],[142,0,[20,-10,-6,[43,0.801,[70,0,[55,2,[0,0.032,-9,[73,0,[1,1.279,2,-29],18]],[0,0.288,10,-2]],-23],9]],-55],[48,0,[68,0,[12,54,0,-6],12],[63,0,[9,14,[54,0,[11,0,-35,2],18],-27],[10,4.004,-18,[54,0,-10,3]]]],[108,0,[86,0,[1,0.018,[15,17,-5,-15],[20,-1,[49,7,-1,-27],[24,0,[91,0,[1,2.957,0,-12],-41],9]]],18],12],[101,0,[52,15,[30,0,[1,3.6716,[47,3,[49,7,1,[20,-1,-16,[40,0.035,22,-21]]],-1],-11],[21,0.15,13,0]],-21],14],[130,0,[34,0.6782,[170,0,[117,0,[127,0,[2,0.01,-26,[131,0,[55,2,-1,[58,0,6,-5]],26]],21],-103],-88],6],-49],[0,1.424,[59,0,[50,0,[1,0.824,2,[61,0,-26,3]],[51,86,-1,[62,1,-16,22]]],[39,-1,29,[62,0,-30,16]]],-46],[199,0,[140,0,[223,0,[2,0.184,-1,[58,0,4,[57,0,-13,-59]]],27],[169,0,[22,0.0803,51,[46,0,-180,36]],-106]],7],[97,0,[171,0,[48,0,[46,0.929,[25,0,-3,36],[1,0.178,-18,6]],[39,0,-11,[62,1,1,-8]]],21],[202,0,21,-85]],[114,0,[59,0,[21,0.217,[20,0,[50,0,[49,4,-1,9],-3],[20,2,12,-3]],-5],[40,0.6806,[62,1,1,28],-62]],20],[108,0,[37,0,[49,15,0,[18,18,-9,23]],[58,0,[60,0.0092,[198,0,-9,-243],6],[57,0,9,[60,0.495,-250,65]]]],15],[11,-1,[15,18,19,-96],[43,0.693,[2,0.027,-5,[70,0,[0,0.471,[42,0.183,2,[63,0,13,-24]],[73,0,-1,22]],-16]],6]],[20,-9,[46,0.366,[9,18,10,-16],-16],[20,7,[20,0,[94,0,[43,0.785,0,19],7],[22,0.2904,15,[4,31,-9,17]]],-4]],[210,0,[32,0,[11,2,[17,0,[3,0.05,[45,2,-3,15],[11,-1,-82,6]],[127,0,-14,34]],-10],[64,0,17,-56]],15],[1,0.76,[39,0,[46,0,9,-87],3],[10,1.4706,-39,[46,0.581,-9,[39,-1,[1,1.279,33,[10,4.21,[40,0,49,-71],-40]],-9]]]],[214,0,[128,0,[142,0,[123,0,[92,0,[1,0.018,[62,1,[16,3,0,-17],-12],[91,0,0,-6]],-42],-54],-32],-32],16],[104,0,[54,4,[129,0,[52,10,[81,0,[140,0,[86,0,[131,0,[49,6,-2,5],25],9],12],-26],-19],-48],6],-38],[68,0,[97,0,[2,0.05,[73,0,[66,0,[43,0.7876,-4,15],-81],[0,0.076,-11,51]],0],10],[62,1,11,[1,0.28,-11,3]]],[12,66,[175,0,[47,2,[40,0.0253,[9,14,3,[54,0,-7,[10,1.2915,-55,18]]],[21,0.37,-6,-48]],[50,8,0,-24]],127],-2],[226,0,[0,1.16,[126,0,[110,0,[59,0,[22,3.8763,[68,0,-1,6],-73],[47,1,[40,0.0915,22,-30],-1]],14],46],-13],18],[156,0,[105,0,[179,0,[3,0.05,[1,0,-41,[59,0,[15,8,1,-2],[60,0.495,26,-328]]],[0,0.907,4,-30]],-102],-65],10],[12,139,[171,0,[48,0,[58,0,[49,8,1,[20,-1,-44,8]],[57,0,-4,[60,0.495,-227,34]]],[63,0,0,-5]],19],-8],[82,0,[172,0,[117,0,[20,-8,[50,1,[0,0.42,[46,0.70003,[7,0,-41,18],-8],-12],-20],[1,0.694,2,-3]],-87],47],-19],[195,0,[137,0,[188,0,[97,0,[20,-1,-5,[2,0.16,-1,[61,1.55,8,[1,0.258,-40,-4]]]],[51,10,15,-49]],-113],57],6],[115,0,[76,0,[58,4,[15,10,2,[41,0,[0,0.2495,[2,0.066,-14,8],[63,0,-10,3]],-9]],-35],[55,0,-56,5]],3],[130,0,[136,0,[191,0,[30,0,0,[25,0,[32,0,[7,2,-110,2],[20,2,74,-46]],[31,0,49,-65]]],-111],20],-30],[210,0,[50,2,[49,8,[197,0,[1,0.76,1,[61,0.35,-8,[149,0,3,-87]]],-126],[35,0.4287,9,-68]],[51,38,-6,-11]],13],[30,0,[11,4,0,[3,0.13,-3,-37]],[25,0,[32,0,[43,0.0258,-33,33],[20,1,116,[31,1,76,-61]]],[31,0,36,-24]]],[172,0,[69,0,[71,0,[30,0,[1,3.35,-1,-18],[25,0,[32,0,-14,32],24]],[47,58,22,-92]],[12,3,55,-10]],31],[139,0,[15,0,[58,0,-11,-120],[136,0,[173,0,[70,0,[132,0,[171,0,0,18],10],[12,2,-104,6]],46],19]],42],[43,0.196,[47,14,[54,1,-2,[62,0,[91,0,-2,-80],[42,0.219,[123,0,10,-30],-20]]],-2],[15,12,[41,0.548,0,57],-1]],[12,175,[218,0,[230,0,[86,0,[131,0,[229,0,0,7],14],[62,0,16,-7]],-59],18],[186,0,-15,[13,222,2987,629]]],[101,0,[107,0,[83,0,[122,0,[118,0,[1,9.9892,[0,1.4935,0,-49],-78],[63,2,20,-177]],35],-24],-42],[16,4,18,-84]],[108,0,[171,0,[133,0,[20,-8,[46,0,[140,0,[12,8,11,-16],-55],-11],[140,0,0,[20,12,15,-19]]],41],9],15],[138,0,[168,0,[50,0,[49,19,1,26],[73,0,[0,-0.001,-68,-3],[0,0.219,-36,[10,3.887,52,-37]]]],-69],[42,0.3337,12,-169]],[30,0,[1,4.423,[130,0,[231,0,[29,0,[215,0,[104,0,0,-22],-83],[27,0,55,-81]],[41,0.00112,-107,79]],-36],-17],9],[68,0,[27,0,[17,0,-1,-4],[4,71,[29,0,[44,2,9,68],-96],-125]],[28,0,24,[64,0,[6,150,-14,19],-51]]],[108,0,[226,0,[9,4,[63,0,[68,0,[73,0,-4,32],29],[8,15,2,[44,5,-31,-5]]],1],19],[21,0.35,18,-106]],[116,0,[220,0,[88,0,[90,0,[120,0,[103,0,[30,0,[1,4.423,0,-10],8],-37],-129],-29],-9],[12,3,-35,37]],-63],[194,0,[207,0,[140,0,[127,0,[2,0.01,-20,[42,1.5553216438,[97,0,0,8],[11,0,-62,-1]]],[40,0.693,-6,52]],11],11],78],[48,0,0,[63,0,[20,-16,-43,[5,0.33036,[54,0,-1,17],[41,0.06665,-69,20]]],[54,1,[222,0,-11,111],[10,3.1702,-16,16]]]],[43,0.196,[47,3,[40,0.0253,[49,8,2,[20,-1,-65,6]],[1,1.306,-3,-40]],[3,0.05,-2,[0,0.243,[54,0,-1,14],-2]]],5],[155,0,[58,4,[96,0,[80,0,[92,0,[132,0,[101,0,[105,0,[156,0,0,-7],-58],15],9],-29],-45],-52],-27],-50],[87,0,[52,17,[20,-1,[2,0.168,[46,0.824,[9,15,13,-22],-15],[20,-7,-1,[61,0,-69,-5]]],1],[12,3,69,-35]],-31],[139,0,[0,0.9297,[38,2,[143,0,[21,0.283,[1,0.2114,-3,10],[46,0,-81,2]],-113],0],[10,1.885,33,[38,1,-69,-9]]],29],[178,0,[44,0,[68,0,[0,0.9146,[9,4,[63,3,-5,-102],0],-34],27],[89,0,[121,0,0,[9,20,-117,32]],15]],70],[208,0,[74,0,[183,0,[170,0,[114,0,[210,0,0,[15,41,19,-115]],[52,0,26,-80]],-71],-87],[7,5,-18,40]],-40],[139,0,[86,0,[85,0,[0,0.611,[50,1,2,-8],[235,0,[43,0.151,-4,9],[3,0.04,[13,9,-79,114],-80]]],13],4],18],[30,0,[43,0.73,[54,1,[62,0,2,[1,0.2114,-11,1]],[62,0,[1,0.623,0,[19,0,1,-43]],5]],[46,0.627,-37,21]],8],[134,0,[21,-3.01,-97,[76,0,[12,369,[71,0,[53,10,0,-4],[1,1.435,[47,58,10,-80],55]],-50],[7,5,-44,15]]],-75],[102,0,[213,0,[177,0,[100,0,[0,0.257,[235,0,3,-20],[39,0,[235,0,-19,14],0]],19],-40],-28],[144,0,32,-53]],[0,0.032,[229,0,[1,0.06,-26,[235,0,[61,2.15,[7,5,21,[10,1.2312,-47,6]],[0,0.009,-76,-11]],-54]],59],[0,0.3363,1,0]],[56,0,[1,1.279,[44,0,[11,-1,-66,-3],[38,3,6,-1]],[5,0.395378,-38,[61,1.95,13,-31]]],[47,0,[40,0.668,5,-170],2]],[135,0,[160,0,[162,0,[99,0,[145,0,[211,0,0,[46,0.734,33,[8,17,[58,0,30,-81],-26]]],-96],-93],-102],60],39],[68,0,[20,-12,-3,[21,-0.394,[85,0,15,72],-1]],[6,161,[28,0,10,[62,1,-6,[1,0.28,-54,46]]],[9,21,32,-21]]],[18,19,[5,0.00849,27,[2,0.26,[50,6,[5,0.98486,-5,42],-20],14]],[91,0,[129,0,[58,0,4,-11],-112],[54,1,33,-143]]],[123,0,[142,0,[208,0,[84,0,[172,0,[32,0,0,7],25],[21,-0.083,37,[61,0.95,[8,12,-99,-25],14]]],-25],-22],-35],[232,0,[181,0,[54,1,[35,0.09017,[76,0,-3,-46],3],[40,0.564,[62,0,[1,0.623,3,-7],7],-19]],-90],[4,67,-87,62]],[182,0,[142,0,[217,0,[204,0,[160,0,[179,0,0,-70],44],[6,41,13,-47]],[62,1,[3,0.03,54,-12],-32]],-21],-148],[92,0,[118,0,[209,0,[15,3,[14,9,-3,-175],[53,12,1,-9]],[35,0.174,[6,180,-45,55],28]],[6,60,-91,8]],-30],[226,0,[0,1.424,[71,0,[137,0,0,[4,24,63,-75]],[117,0,[40,0.0253,[1,1.49,19,63],-38],-63]],[180,0,-33,1362]],10],[0,1.424,[30,0,0,[25,0,[32,0,[39,0,-87,5],31],13]],[180,0,-9,[23,0,[237,0,[21,10.57,-2507,-1144],-676],-189]]],[22,6.57388,[167,0,[192,0,[78,0,[201,0,[230,0,[50,34,[141,0,0,123],-74],-37],[12,9,-39,9]],-19],-169],38],-60],[30,0,[55,6,[173,0,[150,0,[103,0,[190,0,[2,0.582,0,-11],50],[49,10,7,-185]],-54],21],16],[44,1,84,1]],[157,0,[111,0,[171,0,[18,19,[97,0,[2,0.215,[20,4,[20,0,-3,3],-14],5],17],[163,0,2,-94]],19],-32],-55],[3,0,-75,[112,0,[9,7,[62,1,[7,0,-20,[7,2,14,[8,40,-6,20]]],[5,0.30648,[8,13,5,-25],26]],1],-57]],[220,0,[12,74,[175,0,[65,0,-1,[7,17,19,[9,6,83,-15]]],[13,25,213,-62]],[0,0.2646,[42,0.31,26,-29],-15]],18],[175,0,[72,0,[0,0.018,[1,0.06,-29,[11,4,[50,3,11,-4],-91]],0],[55,0,62,[9,4,-60,19]]],[13,25,183,-92]],[56,0,[1,1.279,0,[59,0,[51,32,-30,[61,1.75,41,-40]],[58,0,34,-51]]],[47,40,[20,-1,-2,[58,0,5,-4]],-35]],[175,0,[233,0,[195,0,[83,0,[69,0,-1,11],-26],[46,0.74,[10,6.71225,-6,25],[20,-12,-47,6]]],33],[65,0,90,-88]],[140,0,[127,0,0,2],[19,0,[46,0,[236,0,-193,93],29],[46,0.366,173,[13,35,[10,4.953,[0,0.624,39,-135],-9],-173]]]],[67,0,[134,0,[154,0,[0,-0.001,[50,-1,10,-98],[177,0,0,-19]],[8,27,33,-20]],-53],[41,0.0002429,-7,[0,0.4926,-106,-18]]],[234,0,[86,0,[131,0,[1,0.018,[229,0,[0,0.0787,-22,[53,1,[61,2.65,-2,-27],21]],34],[168,0,0,-69]],5],6],80],[147,0,[4,523,[123,0,[212,0,[156,0,[133,0,[93,0,0,33],[15,33,44,-74]],-128],26],[51,6,41,-97]],-27],-76],[109,0,[207,0,[43,0.693,[75,0,[55,2,[175,0,-1,102],[0,0.3363,7,-4]],[1,0.645,40,-64]],[127,0,2,46]],9],-42],[224,0,[231,0,[20,-8,[46,0.5845,[0,0.232,[15,13,24,-8],-3],[3,0.03,[161,0,-28,294],-4]],0],[2,0.12,20,-101]],-22],[136,0,[217,0,[12,0,[3,0.25,[13,35,[61,2.95,17,-12],-18],-31],[11,4,-1,-31]],8],[38,0,[6,123,-79,61],27]],[227,0,[48,0,1,[39,0,0,[46,1.63,[152,0,[238,0,[54,0,[12,9,-7,36],[1,0.49,2,-21]],-163],63],-104]]],-131],[83,0,[179,0,[1,0.76,[39,0,[46,0,3,-68],2],[10,1.611,[158,0,-27,178],[3,0.07,[46,0.535,1,4],-23]]],-58],-11],[230,0,[146,0,[187,0,[231,0,[148,0,[4,523,[216,0,0,[42,0.333,24,-52]],-26],-116],[42,0.06,-64,49]],73],80],-29],[3,0.05,[219,0,-2,30],[11,-1,-19,[1,1.279,[0,0.735,[58,0,[54,1,2,12],[57,0,7,[60,0.495,-197,43]]],-9],-10]]],[190,0,[215,0,[104,0,[52,11,[206,0,[3,0.13,-1,16],[4,34,80,[203,0,-80,68]]],[4,8,34,-12]],-35],-49],27],[166,0,[71,0,[124,0,[164,0,[21,0.13,0,-3],61],[15,7,124,-49]],[117,0,[40,0.03,[1,1.368,11,28],-25],-54]],-96],[125,0,[56,0,0,[63,0,[47,5,[40,0.564,11,-74],[15,37,[52,0,-11,-76],6]],[46,0.929,-17,9]]],[10,5.9094,-37,29]],[214,0,[124,0,[81,0,[79,0,[216,0,[189,0,[71,0,0,5],-105],10],[98,0,-30,112]],[12,11,-22,32]],-15],10],[21,-3.01,-77,[165,0,[174,0,[221,0,[119,0,[16,0,[46,1.1542,-15,42],0],[13,48,-221,28]],17],-92],[9,28,51,-136]]],[155,0,[82,0,[18,4,[4,108,[12,1,[196,0,[159,0,38,-178],-129],6],-29],-1],[44,14,-28,54]],[54,2,-90,106]],[51,230,[51,82,[200,0,-1,[63,0,18,-3]],[64,0,[73,0,-10,[5,0.278496,-89,53]],[20,-1,-156,[10,3.73225,80,-13]]]],-15],[113,0,[1,0.178,[62,1,[15,8,3,-1],[14,0,-3,-26]],[20,-1,[20,-36,17,[61,1.35,-35,14]],2]],[33,0.996,-6,56]],[193,0,[110,0,[154,0,[122,0,[228,0,[22,5.84046,[135,0,0,17],-54],-54],15],[222,0,52,-172]],[5,0.694484,9,-28]],96],[3,0,-49,[205,0,[126,0,[5,0.00849,[18,13,28,[2,0.152,18,-45]],-1],[27,0,[31,0,-31,55],122]],[209,0,27,-127]]],[184,0,[101,0,[55,5,[5,0.029176,[8,56,5,33],-1],[4,1,-116,[15,29,-12,19]]],[195,0,[66,0,14,-165],-181]],-49],[77,0,[15,17,[21,0.283,2,-9],[2,0.137,-14,[42,0,[47,0,[46,0.7062,-66,[61,0.45,38,10]],1],-21]]],[42,0.49996,27,-48]],[185,0,[96,0,[50,3,[49,23,[21,0.93,0,-29],[35,0.624,16,-104]],[21,1.16,[210,0,-9,106],[61,0.55,69,-48]]],-36],91],[107,0,[3,0.05,[41,0.548,[47,6,[49,4,-5,[51,26,0,13]],[239,0,0,-124]],19],[1,1.188,[11,-1,-28,3],-25]],-27],[85,0,[51,230,[51,134,0,[235,0,[63,3,[106,0,-9,220],42],44]],[39,0,-74,-3]],[10,5.577,-21,[1,0.046,40,4]]],[176,0,[118,0,[126,0,[181,0,[153,0,[83,0,[213,0,0,[2,0.113,27,-104]],-6],-109],-62],41],[46,0.929,-55,17]],-39],[151,0,[225,0,[21,-3.01,-66,[86,0,0,[64,0,7,[6,125,-123,51]]]],[33,0.996,[44,2,46,-38],[25,0,103,-24]]],-89],[185,0,[30,0,[1,8.03,[130,0,[139,0,0,18],[0,0.686,[13,3,-158,56],[10,1.8512,1,-165]]],-49],[44,1,61,1]],51]],"sure":-174}';
  // for train.py, which loads this file under Node and learns from describe()
  if (typeof module == "object") module.exports = { describe };
}

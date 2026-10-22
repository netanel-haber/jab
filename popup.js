// jab's toolbar popup: shows the shortcut and takes the next one you press, kept in the browser's synced storage, where every
// page's jab (jab.js) reads it. Nothing set is Ctrl+.
const mac = /Mac/.test(navigator.platform);
const NAMES = { Period: ".", Comma: ",", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`" };
// what the browser keeps for itself (new tab or window, close, quit, switching tabs), and editing (select all, copy, cut, paste, undo, redo)
const TAKEN = ["KeyN", "KeyT", "KeyW", "KeyQ", "Tab", "PageUp", "PageDown", "KeyA", "KeyC", "KeyX", "KeyV", "KeyZ", "KeyY"];
const [now, why, reset] = ["now", "why", "reset"].map((id) => document.getElementById(id));
const show = (press) => {
  now.textContent = press?.label ?? "Ctrl+.";
  reset.hidden = !press;
};
chrome.storage.sync.get("press", ({ press }) => show(press));
reset.onclick = () => chrome.storage.sync.remove("press", () => show());
addEventListener("keydown", (e) => {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "Escape", "Enter", " "].includes(e.key)) return;
  e.preventDefault();
  const ctrlKey = e.ctrlKey,
    metaKey = mac && e.metaKey; // ⌘ on a Mac; elsewhere that key is the system's
  const label = [ctrlKey && "Ctrl", metaKey && "⌘", e.shiftKey && "Shift", NAMES[e.code] ?? e.code.replace(/^Key|^Digit/, "")].filter(Boolean).join("+");
  why.textContent = e.altKey
    ? "Alt and Option are the page's own shortcuts (access keys): pick one without them."
    : !ctrlKey && !metaKey
      ? `Hold Ctrl${mac ? " or ⌘" : ""} with it: a key on its own types.`
      : TAKEN.includes(e.code)
        ? `${label} is the browser's or your typing's: pick another.`
        : "";
  if (why.textContent) return;
  const press = { code: e.code, ctrlKey, metaKey, shiftKey: e.shiftKey, label };
  chrome.storage.sync.set({ press }, () => show(press));
});

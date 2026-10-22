// jab's toolbar popup: its shortcut as the browser has it, and the way to the browser's own page for changing it (Edge opens chrome://
// addresses as its own edge:// ones). No shortcut, when another extension had Ctrl+. first: it says so, and clears the "!"
// background.js put on jab's button once there is one again.
const [has, now, none, change] = ["has", "now", "none", "change"].map((id) => document.getElementById(id));
const NAMES = { Period: ".", Comma: ",", MacCtrl: "Control", Command: "⌘" }; // as Chrome names the keys
chrome.commands.getAll((commands) => {
  const { shortcut } = commands.find((c) => c.name == "jab");
  now.textContent = shortcut
    .split("+")
    .map((k) => NAMES[k] ?? k)
    .join("+");
  has.hidden = !shortcut;
  none.hidden = !!shortcut;
  chrome.action.setBadgeText({ text: shortcut ? "" : "!" });
});
change.onclick = () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  close();
};

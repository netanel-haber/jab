// jab's background script. The browser tells it when you press jab's shortcut (the "jab" command in manifest.json: Ctrl+. unless you
// changed it), and lets it into that tab for that press (activeTab). It hands the press to jab.js in the tab's page, putting jab.js
// there first when the page has none yet: jab touches a page only when you press its shortcut there.
// The tabs jab.js is going into. A press there meanwhile is dropped: a busy page can take a while to let jab.js in, and a second
// copy put in beside the first would step through the picks twice on every press.
const loading = new Set();
chrome.commands.onCommand.addListener(async (command, tab) => {
  check(); // a press means there is a shortcut: no "!"
  if (loading.has(tab.id)) return;
  const press = () => chrome.tabs.sendMessage(tab.id, "press", { frameId: 0 });
  try {
    await press();
  } catch {
    // no jab in the page yet (or only one from before jab was updated, which no longer hears it); a page no extension may run in
    // (the browser's own pages, the add-on stores) stays as it is
    if (loading.has(tab.id)) return; // another press got here first
    loading.add(tab.id);
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["jab.js"] })
      .then(press)
      .catch(() => {})
      .finally(() => loading.delete(tab.id));
  }
});
// jab's button opens the browser's page for changing its shortcut (Edge opens chrome:// addresses as its own edge:// ones).
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
// The button says what the shortcut is; with none (another extension had Ctrl+. first) it shows "!" and says so. Chrome does not
// tell when the shortcut changes, so this runs again on every press and on the browser starting.
const NAMES = { Period: ".", Comma: ",", MacCtrl: "Control", Command: "⌘" }; // as Chrome names the keys
const check = async () => {
  const { shortcut } = (await chrome.commands.getAll()).find((c) => c.name == "jab");
  const keys = shortcut
    .split("+")
    .map((k) => NAMES[k] ?? k)
    .join("+");
  chrome.action.setBadgeText({ text: shortcut ? "" : "!" });
  chrome.action.setTitle({ title: shortcut ? `jab: ${keys} (click to change it)` : "jab has no shortcut: click to set one" });
};
chrome.runtime.onInstalled.addListener(check);
chrome.runtime.onStartup.addListener(check);

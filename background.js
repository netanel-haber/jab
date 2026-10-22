// jab's background script. The browser tells it when you press jab's shortcut (the "jab" command in manifest.json: Ctrl+. unless you
// changed it), and lets it into that tab for that press (activeTab). It hands the press to jab.js in the tab's page, putting jab.js
// there first when the page has none yet: jab touches a page only when you press its shortcut there.
chrome.commands.onCommand.addListener(async (command, tab) => {
  const press = () => chrome.tabs.sendMessage(tab.id, "press", { frameId: 0 });
  try {
    await press();
  } catch {
    // no jab in the page yet (or only one from before jab was updated, which no longer hears it); a page no extension may run in
    // (the browser's own pages, the add-on stores) stays as it is
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["jab.js"] }).then(press, () => {});
  }
});
// No shortcut: another extension had Ctrl+. first. jab's button shows "!" until it has one, and its popup says how to set one.
// (Chrome does not say when the shortcut changes: the popup checks again.)
const check = async () => {
  const { shortcut } = (await chrome.commands.getAll()).find((c) => c.name == "jab");
  chrome.action.setBadgeText({ text: shortcut ? "" : "!" });
};
chrome.runtime.onInstalled.addListener(check);
chrome.runtime.onStartup.addListener(check);

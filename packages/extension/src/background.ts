// MV3 service worker: panel behavior + context menu only.
// No Firebase, no AI, no App Check, no placeholder map here (ARCHITECTURE 3.2).

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.create({
    id: "rtr-analyze",
    title: "Analyze with Redact-then-Reason",
    contexts: ["selection", "page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "rtr-analyze") return;
  if (!tab?.id || !tab.windowId) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
  // Day 4: inject content.ts via chrome.scripting.executeScript and forward text.
});

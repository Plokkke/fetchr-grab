chrome.action.disable();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "URLS_FOUND") {
    chrome.action.enable(sender.tab.id);
  }
});
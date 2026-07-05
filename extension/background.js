const {
  sanitizeText,
  sanitizeNumber,
  sanitizeRenderPayload
} = globalThis.SYCSanitize;

// Toolbar icon opens the settings page (no popup defined).
chrome.action?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

function isAllowedSender(sender) {
  if (!sender.tab?.id) return false;
  try {
    return new URL(sender.url ?? "").hostname === "www.youtube.com";
  } catch {
    return false;
  }
}

if (globalThis.__SYC_TEST__) {
  globalThis.__SYCBackgroundTest = {
    sanitizeText,
    sanitizeNumber,
    sanitizeRenderPayload,
    isAllowedSender
  };
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "smart-comment:chat-message") return false;
  if (!isAllowedSender(sender)) return false;

  const payload = sanitizeRenderPayload(message.payload);
  if (!payload) return false;

  chrome.tabs.sendMessage(
    sender.tab.id,
    {
      type: "smart-comment:render-message",
      payload
    },
    { frameId: 0 },
    () => {
      void chrome.runtime.lastError;
    }
  );

  return false;
});

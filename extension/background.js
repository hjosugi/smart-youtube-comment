const {
  sanitizeText,
  sanitizeNumber,
  sanitizeRenderPayload
} = globalThis.SYCSanitize;

// Kept for old development builds without a popup; current releases use popup.html.
chrome.action?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

async function toggleOverlaySetting() {
  const Settings = globalThis.SYCSettings;
  if (!Settings) return;
  const current = await Settings.load();
  await Settings.save({ ...current, enabled: !current.enabled });
}

chrome.commands?.onCommand.addListener((command) => {
  if (command !== "toggle-overlay") return;
  toggleOverlaySetting().catch(() => {});
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
    isAllowedSender,
    toggleOverlaySetting
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

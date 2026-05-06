const autoMode = document.getElementById("auto-mode");
const debugLog = document.getElementById("debug-log");
const runCurrentPage = document.getElementById("run-current-page");
const popupStatus = document.getElementById("popup-status");

document.getElementById("open-workbench").addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("upscale.html")
  });
});

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.local.get({
  autoModeEnabled: false,
  debugLogEnabled: false
}, (state) => {
  autoMode.checked = Boolean(state.autoModeEnabled);
  debugLog.checked = Boolean(state.debugLogEnabled);
});

autoMode.addEventListener("change", async () => {
  const enabled = autoMode.checked;
  await chrome.storage.local.set({
    autoModeEnabled: enabled
  });
  setStatus(enabled ? "全自动模式已开启" : "全自动模式已关闭");
  sendToActiveTab({
    type: "WAIFU2X_SET_AUTO_MODE",
    enabled
  }).catch(() => {});
});

debugLog.addEventListener("change", async () => {
  const enabled = debugLog.checked;
  await chrome.storage.local.set({
    debugLogEnabled: enabled
  });
  setStatus(enabled ? "调试日志已开启" : "调试日志已关闭");
  sendToActiveTab({
    type: "WAIFU2X_SET_DEBUG_LOG",
    enabled
  }).catch(() => {});
});

runCurrentPage.addEventListener("click", async () => {
  setStatus("正在发送到当前页...");
  try {
    await sendToActiveTab({
      type: "WAIFU2X_RUN_AUTO_PAGE"
    });
    setStatus("当前页已开始排队处理");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("没有找到当前标签页");
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },
      files: ["content.js"]
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function setStatus(text, isError = false) {
  popupStatus.textContent = text;
  popupStatus.style.color = isError ? "#b3261e" : "#24786d";
}

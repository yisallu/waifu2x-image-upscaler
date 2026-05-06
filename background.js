const MENU_ID = "waifu2x-upscale-image";
const HOST_NAME = "com.yisal.waifu2x";

async function createMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "用 Waifu2x 放大并替换图片",
    contexts: ["image", "link", "page"]
  });
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);
createMenu();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  if (!tab?.id) {
    return;
  }

  const srcUrl = info.srcUrl || (looksLikeImageUrl(info.linkUrl || "") ? info.linkUrl : "") || (looksLikeImageUrl(tab.url || "") ? tab.url : "");
  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;

  try {
    await sendReplaceMessage(tab.id, frameId, srcUrl, "direct");
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          frameIds: [frameId]
        },
        files: ["content.js"]
      });
      await sendReplaceMessage(tab.id, frameId, srcUrl, `after inject: ${error.message || String(error)}`);
    } catch (injectError) {
      if (srcUrl) {
        const params = new URLSearchParams({
          src: srcUrl,
          page: tab?.url || ""
        });

        chrome.tabs.create({
          url: chrome.runtime.getURL(`upscale.html?${params.toString()}`)
        });
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WAIFU2X_FETCH_IMAGE") {
    fetchAsDataUrl(message.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "WAIFU2X_NATIVE_UPSCALE") {
    upscaleWithNative(message.payload)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

function looksLikeImageUrl(url) {
  return /^https?:\/\//i.test(url) && /\.(avif|bmp|gif|jpe?g|png|webp)([?#].*)?$/i.test(url);
}

function sendReplaceMessage(tabId, frameId, srcUrl, route) {
  return chrome.tabs.sendMessage(tabId, {
    type: "WAIFU2X_REPLACE_IMAGE",
    srcUrl,
    route
  }, {
    frameId
  });
}

function upscaleWithNative(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, payload, async (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      if (!response?.ok) {
        resolve(response || {
          ok: false,
          error: "waifu2x 没有返回结果。"
        });
        return;
      }

      if (response.url) {
        try {
          response.dataUrl = await fetchAsDataUrl(response.url);
          response.backgroundFetchedUrl = response.url;
          response.dataUrlBytes = estimateDataUrlBytes(response.dataUrl);
          delete response.url;
        } catch (error) {
          resolve({
            ok: false,
            engine: response.engine,
            error: `后台读取 waifu2x 结果失败：${error.message || String(error)}`
          });
          return;
        }
      }

      resolve(response);
    });
  });
}

async function fetchAsDataUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`不支持的图片地址：${url}`);
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(`不是图片响应：${blob.type || "unknown"}`);
  }

  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

function estimateDataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const payloadLength = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
  return Math.round(payloadLength * 0.75);
}

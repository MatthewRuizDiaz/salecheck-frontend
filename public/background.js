// background.js

let isRefreshing = false;
const SALE_THRESHOLD = 0.02; // 2% minimum drop to trigger a notification

// 1. Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getRefreshStatus") {
    sendResponse({ isRefreshing });
    return;
  }

  if (request.action === "trackCurrentTab") {
    handleManualTrack()
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ success: false, message: error.message })
      );

    return true; // ✅ We are responding asynchronously
  }
});

// ✅ Fully structured manual track handler
async function handleManualTrack() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab || !tab.url) {
    return { success: false, message: "No active tab found" };
  }

  const { products = [] } = await chrome.storage.local.get("products");

  if (products.length >= 10) {
    return {
      success: false,
      message: "Maximum capacity reached (10 items).",
    };
  }

  const encoded = encodeURIComponent(tab.url);
  const response = await fetch(
    `https://salecheck-backend-production.up.railway.app/products/by_url?url=${encoded}`
  );

  if (!response.ok) {
    let errorMsg = "Service Unreachable";
    try {
      const errorData = await response.json();
      if (errorData.error) errorMsg = errorData.error;
    } catch (e) {}
    return { success: false, message: errorMsg };
  }

  const product = await response.json();

  if (!product || !product.asin) {
    return { success: false, message: "Product not found" };
  }

  if (product.current_price === "0.00") {
    return { success: false, message: "Product has no active price" };
  }

  if (products.some((p) => p.asin === product.asin)) {
    return {
      success: false,
      message: "Product already being tracked",
    };
  }

  product.original_title = product.title;
  product.custom_title = null;
  product.isNewSale = false;

  const updatedProducts = [...products, product];
  await chrome.storage.local.set({ products: updatedProducts });

  return { success: true };
}

// 2. SETUP ALARM ON INSTALL
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("dailyPriceCheck", {
    periodInMinutes: 1440, // 24 hours
  });
});

// 3. LISTENERS
chrome.runtime.onStartup.addListener(() => {
  refreshAllPrices();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dailyPriceCheck") {
    refreshAllPrices();
  }
});

// 4. CORE REFRESH LOGIC
async function refreshAllPrices() {
  const { products, lastUpdate } = await chrome.storage.local.get([
    "products",
    "lastUpdate",
  ]);

  if (!products || products.length === 0) return;

  const now = Date.now();
  const oneDayInMs = 23 * 60 * 60 * 1000;

  if (lastUpdate && now - lastUpdate < oneDayInMs) return;

  isRefreshing = true;
  chrome.runtime.sendMessage({ action: "refreshStarted" }).catch(() => {});

  try {
    const asins = products.map((p) => p.asin || p.product_asin);

    const response = await fetch(
      "https://salecheck-backend-production.up.railway.app/products/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins }),
      }
    );

    if (!response.ok) throw new Error("Backend unreachable");

    const freshData = await response.json();
    let priceDropCount = 0;

    const updatedProducts = products.map((oldProduct) => {
      const fresh = freshData.find(
        (f) => f.asin === (oldProduct.asin || oldProduct.product_asin)
      );

      if (!fresh) return oldProduct;

      const oldCurNum = parseFloat(
        (oldProduct.current_price || "0").replace(/[^0-9.]/g, "")
      );
      const newCurNum = parseFloat(
        (fresh.current_price || "0").replace(/[^0-9.]/g, "")
      );
      const oldStdNum = parseFloat(
        (oldProduct.standard_price || "0").replace(/[^0-9.]/g, "")
      );
      const newStdNum = parseFloat(
        (fresh.standard_price || "0").replace(/[^0-9.]/g, "")
      );

      const currentChanged = newCurNum !== oldCurNum;
      const standardChanged = newStdNum !== oldStdNum;

      if (currentChanged && standardChanged) return oldProduct;

      let updatedStandardPrice = oldProduct.standard_price;
      let msrpChangeCount = oldProduct.msrpChangeCount || 0;

      if (standardChanged) {
        msrpChangeCount++;
        if (msrpChangeCount >= 2) {
          updatedStandardPrice = fresh.standard_price;
          msrpChangeCount = 0;
        }
      } else {
        msrpChangeCount = 0;
      }

      let isNewSale = oldProduct.isNewSale || false;

      if (newCurNum > 0 && oldCurNum > 0 && newCurNum < oldCurNum) {
        const dropPercent = (oldCurNum - newCurNum) / oldCurNum;
        if (dropPercent >= SALE_THRESHOLD) {
          priceDropCount++;
          isNewSale = true;
        }
      }

      return {
        ...oldProduct,
        asin: fresh.asin,
        title: fresh.title,
        current_price: fresh.current_price,
        standard_price: updatedStandardPrice,
        isNewSale: isNewSale,
        msrpChangeCount: msrpChangeCount,
      };
    });

    await chrome.storage.local.set({
      products: updatedProducts,
      lastUpdate: now,
    });

    if (priceDropCount > 0) {
      chrome.action.setBadgeText({ text: priceDropCount.toString() });
      chrome.action.setBadgeBackgroundColor({ color: "#FF3B30" });
    }
  } catch (error) {
    // Silence error for production
  } finally {
    isRefreshing = false;
    chrome.runtime.sendMessage({ action: "refreshFinished" }).catch(() => {});
  }
}
// background.js

let isRefreshing = false;

// 1. Listen for status pings from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getRefreshStatus") {
    sendResponse({ isRefreshing });
  }
});

// 2. SETUP ALARM ON INSTALL
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("dailyPriceCheck", {
    periodInMinutes: 1440, // 24 hours
  });
  console.log("SaleCheck: Daily alarm scheduled.");
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
  // Notify any open popup that we started
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

      const oldCurNum = parseFloat((oldProduct.current_price || "0").replace(/[^0-9.]/g, ""));
      const newCurNum = parseFloat((fresh.current_price || "0").replace(/[^0-9.]/g, ""));
      const oldStdNum = parseFloat((oldProduct.standard_price || "0").replace(/[^0-9.]/g, ""));
      const newStdNum = parseFloat((fresh.standard_price || "0").replace(/[^0-9.]/g, ""));

      const currentChanged = newCurNum !== oldCurNum;
      const standardChanged = newStdNum !== oldStdNum;

      if (currentChanged && standardChanged) return oldProduct;

      let updatedStandardPrice = oldProduct.standard_price || oldProduct.product_original_price;
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
        priceDropCount++;
        isNewSale = true;
      }

      return {
        ...oldProduct,
        asin: fresh.asin,
        title: fresh.title,
        current_price: fresh.current_price,
        standard_price: updatedStandardPrice,
        affiliate_link: fresh.affiliate_link,
        isNewSale: isNewSale,
        msrpChangeCount: msrpChangeCount
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
    console.error("SaleCheck: Update error:", error);
  } finally {
    isRefreshing = false;
    // Notify popup we are done
    chrome.runtime.sendMessage({ action: "refreshFinished" }).catch(() => {});
  }
}
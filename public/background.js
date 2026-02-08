// background.js

// 1. SETUP ALARM ON INSTALL
// Ensures the extension has a way to wake up even if Chrome is never closed.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("dailyPriceCheck", {
    periodInMinutes: 1440, // 24 hours
  });
  console.log("SaleCheck: Daily alarm scheduled.");
});

// 2. LISTENERS
// Trigger on Startup
chrome.runtime.onStartup.addListener(() => {
  console.log("SaleCheck: Chrome started. Checking for daily update...");
  refreshAllPrices();
});

// Trigger on Alarm (Fallback if Chrome stays open multi-day)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dailyPriceCheck") {
    console.log("SaleCheck: 24h alarm fired. Checking for daily update...");
    refreshAllPrices();
  }
});

// 3. CORE REFRESH LOGIC
async function refreshAllPrices() {
  const { products, lastUpdate } = await chrome.storage.local.get([
    "products",
    "lastUpdate",
  ]);

  if (!products || products.length === 0) {
    console.log("SaleCheck: No products to track.");
    return;
  }

  // --- THE GUARD ---
  // If we updated within the last 23 hours, stop here.
  const now = Date.now();
  const oneDayInMs = 23 * 60 * 60 * 1000;

  if (lastUpdate && now - lastUpdate < oneDayInMs) {
    console.log("SaleCheck: Throttled. Already updated recently.");
    return;
  }

  try {
    const asins = products.map((p) => p.product_asin);

    // Call the Backend
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
    let priceDropCount = 0; // iOS-style notification counter

    const updatedProducts = products.map((oldProduct) => {
      const fresh = freshData.find(
        (f) => f.product_asin === oldProduct.product_asin
      );

      if (!fresh) return oldProduct;

      // Convert strings (e.g., "$19.99") to numbers for comparison
      // Safety: fallback to empty string to avoid null replace error
      const oldPriceStr = oldProduct.product_price || "";
      const newPriceStr = fresh.product_price || "";
      
      const oldPriceNum = parseFloat(oldPriceStr.replace(/[^0-9.]/g, ""));
      const newPriceNum = parseFloat(newPriceStr.replace(/[^0-9.]/g, ""));

      // Check if price is lower than what we had in storage
      let isNewSale = oldProduct.isNewSale || false;
      if (newPriceNum > 0 && oldPriceNum > 0 && newPriceNum < oldPriceNum) {
        priceDropCount++;
        isNewSale = true; // Mark as unread for the frontend
      }

      return {
        ...oldProduct,
        product_price: fresh.product_price,
        product_original_price:
          fresh.product_original_price || oldProduct.product_original_price,
        isNewSale: isNewSale
      };
    });

    // Save results and the new timestamp
    // This triggers the 'onChanged' listener in main.js
    await chrome.storage.local.set({
      products: updatedProducts,
      lastUpdate: now,
    });

    // iOS STYLE BADGE (Red circle with number)
    if (priceDropCount > 0) {
      chrome.action.setBadgeText({ text: priceDropCount.toString() });
      chrome.action.setBadgeBackgroundColor({ color: "#FF3B30" }); // Red
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ color: "#FFFFFF" }); // White text
      }
    } else {
      chrome.action.setBadgeText({ text: "" }); // No drops = no badge
    }

    console.log(`SaleCheck: Update complete. Drops found: ${priceDropCount}`);
  } catch (error) {
    console.error("SaleCheck: Update error:", error);
  }
}
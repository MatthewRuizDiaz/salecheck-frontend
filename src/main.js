import './style.css';
import Alpine from '@alpinejs/csp';

const API_BASE = 'https://salecheck-backend-production.up.railway.app';

// 1. Clear the "SALE" notification badge as soon as the user opens the extension
if (chrome.action) {
  chrome.action.setBadgeText({ text: "" });
}

chrome.storage.local.get('products', (result) => {
  const initialProducts = Array.isArray(result.products) ? result.products : [];
  initializeApp(initialProducts);
});

function initializeApp(initialProducts) {
  window.Alpine = Alpine;

  Alpine.data('product_list', () => ({
    products: [...initialProducts],
    loading: false,
    errorMessage: '',
    editingASIN: null,
    editingName: '',
    draggedIndex: null,
    originalOrder: JSON.parse(JSON.stringify(initialProducts)),
    sortColumn: null,
    sortState: -1,

    async trackCurrentProduct() {
      this.loading = true;
      this.errorMessage = '';
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab || !tab.url) throw new Error('Could not access current tab');

        const url = tab.url;
        if (!url.includes('amazon.com')) {
          throw new Error('Please navigate to an Amazon product page');
        }
        if (!url.includes('/dp/') && !url.includes('/gp/product/')) {
          throw new Error("This doesn't appear to be a product page");
        }

        const encoded = encodeURIComponent(url);
        const response = await fetch(
          `${API_BASE}/products/by_url?url=${encoded}`
        );

        if (!response.ok) throw new Error('Could not fetch product data');

        const product = await response.json();
        product.original_title = product.product_title;
        product.custom_title = null;

        this.add_product(product);
        this.loading = false;
      } catch (err) {
        this.errorMessage = err.message;
        this.loading = false;
      }
    },

    add_product(product) {
      if (this.products.length >= 5) {
        this.errorMessage = 'Maximum capacity reached (5 items).';
        return;
      }
      if (!product.product_original_price) {
        this.errorMessage = 'Price comparison data unavailable.';
        return;
      }
      if (this.products.some((p) => p.product_asin === product.product_asin)) {
        this.errorMessage = 'This product is already in the list.';
        return;
      }
      this.products.push(product);
      this.saveProducts();
      this.errorMessage = '';
    },

    remove_product(product) {
      this.products = this.products.filter(
        (p) => p.product_asin !== product.product_asin
      );
      this.saveProducts();
    },

    saveProducts() {
      const toSave = Array.isArray(this.products)
        ? JSON.parse(JSON.stringify(this.products))
        : [];
      this.originalOrder = JSON.parse(JSON.stringify(toSave));
      chrome.storage.local.set({ products: toSave });
    },

    calculateDiscount(product) {
      if (!product.product_original_price || !product.product_price) return 0;
      const current = parseFloat(product.product_price.replace(/[$,]/g, ''));
      const original = parseFloat(
        product.product_original_price.replace(/[$,]/g, '')
      );
      if (isNaN(current) || iNaN(original) || original <= current) return 0;
      return Math.round(((original - current) / original) * 100);
    },

    getRowGradient(product) {
      const discount = this.calculateDiscount(product);
      if (!discount) return 'border-l-4 border-transparent';
      
      if (discount >= 55) return 'border-l-4 border-[#E5C05B] bg-gradient-to-r from-[#E5C05B]/10 to-transparent';
      if (discount >= 40) return 'border-l-4 border-[#B4B8BC] bg-gradient-to-r from-[#B4B8BC]/10 to-transparent';
      if (discount >= 20) return 'border-l-4 border-[#EEA064] bg-gradient-to-r from-[#EEA064]/10 to-transparent';
      
      return 'border-l-4 border-transparent';
    },

    startEdit(product) {
      this.editingASIN = product.product_asin;
      this.editingName = product.custom_title || product.product_title;
    },

    saveEdit(product) {
      if (this.editingName.trim()) {
        product.custom_title = this.editingName.trim();
        this.saveProducts();
      }
      this.editingASIN = null;
    },

    resetToOriginal(product) {
      product.custom_title = null;
      this.saveProducts();
      this.editingASIN = null;
    },

    getDisplayName(product) {
      return product.custom_title || product.product_title;
    },

    onDragStart(index) {
      this.draggedIndex = index;
    },

    onDragOver(event, index) {
      event.preventDefault();
      if (this.draggedIndex === null || this.draggedIndex === index) return;
      const draggedItem = this.products[this.draggedIndex];
      this.products.splice(this.draggedIndex, 1);
      this.products.splice(index, 0, draggedItem);
      this.draggedIndex = index;
    },

    onDragEnd() {
      this.draggedIndex = null;
      this.saveProducts();
    },

    formatPrice(priceString) {
      const price = parseFloat(priceString.replace(/[$,]/g, ''));
      if (isNaN(price)) return priceString;
      if (price >= 1000) return '$' + Math.round(price);
      const rounded = price.toFixed(1);
      return rounded.endsWith('.0') ? '$' + rounded.slice(0, -2) : '$' + rounded;
    },

    sortBy(column) {
      const cycleLimit = column === 'was' || column === 'now' ? 3 : 2;

      if (this.sortColumn !== column) {
        this.sortColumn = column;
        this.sortState = 0;
      } else {
        this.sortState = (this.sortState + 1) % cycleLimit;
      }

      if (
        (cycleLimit === 2 && this.sortState === 1) ||
        (cycleLimit === 3 && this.sortState === 2)
      ) {
        this.products = JSON.parse(JSON.stringify(this.originalOrder));
        this.sortColumn = null;
        this.sortState = -1;
        return;
      }

      this.products.sort((a, b) => {
        if (column === 'name') {
          return this.getDisplayName(a).localeCompare(this.getDisplayName(b));
        }
        if (column === 'percent') {
          return this.calculateDiscount(b) - this.calculateDiscount(a);
        }
        const priceA = parseFloat((column === 'was' ? a.product_original_price : a.product_price).replace(/[$,]/g, '')) || 0;
        const priceB = parseFloat((column === 'was' ? b.product_original_price : b.product_price).replace(/[$,]/g, '')) || 0;
        return this.sortState === 0 ? priceA - priceB : priceB - priceA;
      });
    },

    init() {
      // Listen for background updates while the popup is open
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.products) {
          const newProducts = changes.products.newValue || [];
          
          // Logic check: only update Alpine if the data is different from current state
          if (JSON.stringify(newProducts) !== JSON.stringify(this.products)) {
            this.products = [...newProducts];
            this.originalOrder = JSON.parse(JSON.stringify(newProducts));
            // Reset sorting to avoid confusing the user with re-ordering items suddenly
            this.sortColumn = null;
            this.sortState = -1;
          }
        }
      });
    }
  }));

  Alpine.start();
}
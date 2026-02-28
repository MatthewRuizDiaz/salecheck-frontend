import './style.css';
import Alpine from '@alpinejs/csp';

const AFFILIATE_TAG = 'salecheck-20';

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
    products: initialProducts.map(p => ({
      ...p,
      affiliate_link: `https://www.amazon.com/dp/${p.asin}?tag=${AFFILIATE_TAG}`
    })),
    loading: false,
    isRefreshing: false,
    errorMessage: '',
    editingASIN: null,
    editingName: '',
    draggedIndex: null,
    originalOrder: JSON.parse(JSON.stringify(initialProducts)),
    sortColumn: null,
    sortState: -1,
    hoverTimeout: null,

    async trackCurrentProduct() {
      if (this.products.length >= 10) {
        this.errorMessage = 'Maximum capacity reached (10 items).';
        return;
      }

      this.loading = true;
      this.errorMessage = '';
      
      chrome.runtime.sendMessage({ action: "trackCurrentTab" });
    },

    exportLinks() {
      if (this.products.length === 0) return;

      // 1. Extract only the pre-constructed affiliate links
      const content = this.products.map((p) => p.affiliate_link).join('\n');

      // 2. Create the file blob
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);

      // 3. Trigger silent download
      const link = document.createElement('a');
      link.href = url;
      link.download = 'salecheck-backup.txt';
      link.click();

      // 4. Cleanup memory
      URL.revokeObjectURL(url);
    },

    remove_product(product) {
      this.products = this.products.filter((p) => p.asin !== product.asin);
      this.saveProducts();
    },

    saveProducts() {
      // Construction Logic: Ensure every product has the correct link before saving
      const toSave = this.products.map(p => ({
        ...p,
        affiliate_link: `https://www.amazon.com/dp/${p.asin}?tag=${AFFILIATE_TAG}`
      }));

      this.originalOrder = JSON.parse(JSON.stringify(toSave));
      chrome.storage.local.set({ products: toSave });
    },

    lockSort() {
      if (this.sortColumn === null) return;
      this.saveProducts();
      this.sortColumn = null;
      this.sortState = -1;
    },

    openLink(event, url) {
      if (this.editingASIN !== null) return;
      if (event.button === 0) {
        chrome.tabs.create({ url, active: true });
      } else if (event.button === 1) {
        chrome.tabs.create({ url, active: false });
      }
    },

    handleHover(product) {
      if (!product.isNewSale) return;
      this.hoverTimeout = setTimeout(() => {
        product.isNewSale = false;
        this.saveProducts();
      }, 700);
    },

    clearHover() {
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
    },

    calculateDiscount(product) {
      if (!product.standard_price || !product.current_price) return 0;
      const current = parseFloat(product.current_price.replace(/[^0-9.]/g, ''));
      const original = parseFloat(product.standard_price.replace(/[^0-9.]/g, ''));
      if (isNaN(current) || isNaN(original) || original <= current) return 0;
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
      this.editingASIN = product.asin;
      this.editingName = product.custom_title || product.title;
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

    getDisplayName(product) { return product.custom_title || product.title; },
    onDragStart(index) { this.draggedIndex = index; },
    onDragOver(event, index) {
      event.preventDefault();
      if (this.draggedIndex === null || this.draggedIndex === index) return;
      const draggedItem = this.products[this.draggedIndex];
      this.products.splice(this.draggedIndex, 1);
      this.products.splice(index, 0, draggedItem);
      this.draggedIndex = index;
    },
    onDragEnd() { this.draggedIndex = null; this.saveProducts(); },

    sortBy(column) {
      const cycleLimit = column === 'was' || column === 'now' ? 3 : 2;
      if (this.sortColumn !== column) {
        this.sortColumn = column;
        this.sortState = 0;
      } else {
        this.sortState = (this.sortState + 1) % cycleLimit;
      }
      if ((cycleLimit === 2 && this.sortState === 1) || (cycleLimit === 3 && this.sortState === 2)) {
        this.products = JSON.parse(JSON.stringify(this.originalOrder));
        this.sortColumn = null;
        this.sortState = -1;
        return;
      }
      this.products.sort((a, b) => {
        if (column === 'name') return this.getDisplayName(a).localeCompare(this.getDisplayName(b));
        if (column === 'percent') return this.calculateDiscount(b) - this.calculateDiscount(a);
        const priceA = parseFloat((column === 'was' ? a.standard_price : a.current_price).replace(/[^0-9.]/g, '')) || 0;
        const priceB = parseFloat((column === 'was' ? b.standard_price : b.current_price).replace(/[^0-9.]/g, '')) || 0;
        return this.sortState === 0 ? priceA - priceB : priceB - priceA;
      });
    },

    init() {
      chrome.runtime.sendMessage({ action: "getRefreshStatus" }, (response) => {
        if (response && response.isRefreshing) this.isRefreshing = true;
      });

      chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "refreshStarted") this.isRefreshing = true;
        if (message.action === "refreshFinished") {
          this.isRefreshing = false;
          chrome.action.setBadgeText({ text: "" });
        }
        if (message.action === "trackError") {
          this.errorMessage = message.message;
          this.loading = false;
        }
      });

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.products) {
          const newProducts = changes.products.newValue || [];
          if (JSON.stringify(newProducts) !== JSON.stringify(this.products)) {
            this.products = newProducts.map(p => ({
              ...p,
              affiliate_link: `https://www.amazon.com/dp/${p.asin}?tag=${AFFILIATE_TAG}`
            }));
            this.originalOrder = JSON.parse(JSON.stringify(newProducts));
            this.sortColumn = null;
            this.sortState = -1;
            this.loading = false; 
            this.errorMessage = '';
          }
        }
      });
    },
  }));

  Alpine.start();
}

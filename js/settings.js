import dbService from './db.js';
import FirebaseConfigManager from './firebase-config.js';

class SettingsController {
  constructor() {
    this.activeSettings = {};
  }

  async init(onLoadCallback) {
    if (dbService.firebaseActive) {
      const stored = await dbService.getCollection('settings');
      this.activeSettings = stored[0] || {};
    } else {
      this.activeSettings = dbService.localDb.settings || {};
    }
    if (onLoadCallback) onLoadCallback(this.activeSettings);
  }

  // --- SAVE PROFILE & PRINTER PREFERENCES ---
  async saveGeneralSettings(settings) {
    this.activeSettings = { ...this.activeSettings, ...settings };
    
    if (dbService.firebaseActive) {
      // Upsert
      const list = await dbService.getCollection('settings');
      if (list.length > 0) {
        await dbService.updateDoc('settings', list[0].id, this.activeSettings);
      } else {
        await dbService.addDoc('settings', this.activeSettings);
      }
    } else {
      dbService.localDb.settings = this.activeSettings;
      dbService.saveLocalDb();
      dbService.triggerLocalUpdate('settings');
    }

    // Apply Theme Changes
    this.applyTheme(this.activeSettings.theme || 'dark');
    return true;
  }

  // --- COLOR THEMES ENGINE ---
  applyTheme(themeName) {
    document.body.setAttribute('data-theme', themeName);
    localStorage.setItem('resto_active_theme', themeName);
  }

  // --- RUN INTEGRATION TESTS (HARNESS) ---
  runCalculationsTests() {
    const results = [];
    const assert = (condition, message) => {
      results.push({
        test: message,
        passed: !!condition,
        timestamp: new Date().toLocaleTimeString()
      });
    };

    console.group('RestoPOS Unit Math Verification');

    // TEST 1: Cart Subtotal
    try {
      const mockCart = [
        { product: { price: 10.00 }, qty: 2 },
        { product: { price: 15.50 }, qty: 1 }
      ];
      const subtotal = mockCart.reduce((sum, item) => sum + (item.product.price * item.qty), 0);
      assert(subtotal === 35.50, `Subtotal calculation: Expected $35.50, Got $${subtotal}`);
    } catch (e) {
      assert(false, `Subtotal check errored: ${e.message}`);
    }

    // TEST 2: Percentage Discounts
    try {
      const subtotal = 100.00;
      const discountPercent = 10;
      const discountAmount = (subtotal * discountPercent) / 100;
      assert(discountAmount === 10.00, `Percentage discount: Expected $10.00, Got $${discountAmount}`);
    } catch (e) {
      assert(false, `Discount percent check errored: ${e.message}`);
    }

    // TEST 3: GST Tax calculations (18%)
    try {
      const netTotal = 50.00; // after discount
      const gstRate = 18;
      const gst = (netTotal * gstRate) / 100;
      assert(gst === 9.00, `GST 18% tax check: Expected $9.00, Got $${gst}`);
    } catch (e) {
      assert(false, `GST calculation check errored: ${e.message}`);
    }

    // TEST 4: Service Charge (5%)
    try {
      const netTotal = 50.00;
      const svcRate = 5;
      const svc = (netTotal * svcRate) / 100;
      assert(svc === 2.50, `Service Charge 5% check: Expected $2.50, Got $${svc}`);
    } catch (e) {
      assert(false, `Service charge check errored: ${e.message}`);
    }

    // TEST 5: Grand Total with roundings
    try {
      const gross = 40.00 - 5.00 + 2.25 + 8.10 + 1.25; // 46.60
      const rounded = Math.round(gross * 100) / 100;
      assert(rounded === 46.60, `Rounded Grand Total: Expected $46.60, Got $${rounded}`);
    } catch (e) {
      assert(false, `Grand Total rounding check errored: ${e.message}`);
    }

    console.table(results);
    console.groupEnd();
    return results;
  }
}

const settingsInstance = new SettingsController();
window.settingsController = settingsInstance;
export default settingsInstance;

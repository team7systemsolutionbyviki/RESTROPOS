import dbService from './db.js';

class InventoryController {
  constructor() {
    this.rawMaterials = [];
    this.suppliers = [];
    this.lowStockAlerts = [];
  }

  async init(onUpdateCallback) {
    // Listen to changes in inventory and suppliers
    dbService.subscribe('inventory', (items) => {
      this.rawMaterials = items;
      this.checkStockAlerts();
      if (onUpdateCallback) onUpdateCallback();
    });

    dbService.subscribe('suppliers', (sups) => {
      this.suppliers = sups;
    });
  }

  // --- RAW MATERIALS AND STOCK ---
  async addStockItem(item) {
    const newItem = {
      id: item.id || 'raw_' + Date.now(),
      name: item.name,
      stock: parseFloat(item.stock) || 0,
      unit: item.unit || 'pcs',
      supplier: item.supplier || '',
      alertThreshold: parseFloat(item.alertThreshold) || 5,
      expiryDate: item.expiryDate || ''
    };
    await dbService.addDoc('inventory', newItem);
  }

  async adjustStock(itemId, quantityDelta, reason = 'Adjustment') {
    const item = this.rawMaterials.find(i => i.id === itemId);
    if (item) {
      const updatedStock = Math.max(0, item.stock + quantityDelta);
      await dbService.updateDoc('inventory', itemId, { stock: updatedStock });
      
      // Log purchase / adjustment transaction
      const adjustmentLog = {
        id: 'adjust_' + Date.now(),
        itemId,
        itemName: item.name,
        qty: quantityDelta,
        date: new Date().toISOString().slice(0, 10),
        reason
      };
      await dbService.addDoc('purchases', adjustmentLog);
    }
  }

  // --- ALERTS ENGINE ---
  checkStockAlerts() {
    this.lowStockAlerts = [];
    
    // Check raw materials
    for (const item of this.rawMaterials) {
      if (item.stock <= item.alertThreshold) {
        this.lowStockAlerts.push({
          id: item.id,
          name: item.name,
          type: 'Raw Material',
          stock: item.stock,
          unit: item.unit,
          threshold: item.alertThreshold
        });
        
        // Push notification alert (only if not already notified recently)
        this.addLowStockNotification(item.name, item.stock, item.unit);
      }
    }
  }

  async addLowStockNotification(name, stock, unit) {
    const alerts = await dbService.getCollection('notifications');
    const existing = alerts.find(a => a.title === 'Low Stock Warning' && a.message.includes(name));
    
    if (!existing) {
      const notification = {
        id: 'warn_' + Date.now(),
        title: 'Low Stock Warning',
        message: `${name} is running low! Current stock: ${stock} ${unit}`,
        time: new Date().toLocaleTimeString(),
        type: 'warning',
        read: false
      };
      await dbService.addDoc('notifications', notification);
    }
  }

  // Get list of expired or expiring items (within 5 days)
  getExpiryAlerts() {
    const today = new Date();
    const alertDays = 5;
    const list = [];

    for (const item of this.rawMaterials) {
      if (item.expiryDate) {
        const exp = new Date(item.expiryDate);
        const diffMs = exp.getTime() - today.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
          list.push({ id: item.id, name: item.name, status: 'Expired', date: item.expiryDate });
        } else if (diffDays <= alertDays) {
          list.push({ id: item.id, name: item.name, status: 'Expiring Soon', date: item.expiryDate, daysLeft: diffDays });
        }
      }
    }
    return list;
  }
}

const inventoryInstance = new InventoryController();
window.inventoryController = inventoryInstance;
export default inventoryInstance;

import dbService from './db.js';

class TableController {
  constructor() {
    this.tables = [];
    this.currentFloor = '1st Floor';
    this.mergingActive = false;
    this.mergeSourceTable = null;
  }

  async init(onUpdateCallback) {
    // Register real-time Firestore/Local listener for tables collection
    dbService.subscribe('tables', (data) => {
      this.tables = data;
      onUpdateCallback(this.getTablesForCurrentFloor());
    });
  }

  setFloor(floorName) {
    this.currentFloor = floorName;
  }

  getTablesForCurrentFloor() {
    return this.tables.filter(t => t.floor === this.currentFloor);
  }

  getUniqueFloors() {
    const floors = new Set(this.tables.map(t => t.floor));
    return Array.from(floors);
  }

  // --- TABLE OPERATIONS ---
  async reserveTable(tableId) {
    await dbService.updateDoc('tables', tableId, {
      status: 'reserved'
    });
  }

  async releaseTable(tableId) {
    await dbService.updateDoc('tables', tableId, {
      status: 'available',
      amount: 0,
      waiterName: '',
      orderId: ''
    });
  }

  async assignWaiter(tableId, waiterName) {
    await dbService.updateDoc('tables', tableId, {
      waiterName
    });
  }

  // Transfer Table A -> Table B
  async transferTable(sourceId, targetId) {
    const sourceTable = this.tables.find(t => t.id === sourceId);
    const targetTable = this.tables.find(t => t.id === targetId);

    if (sourceTable && targetTable && sourceTable.status === 'occupied') {
      // Transfer details
      await dbService.updateDoc('tables', targetId, {
        status: 'occupied',
        amount: sourceTable.amount,
        waiterName: sourceTable.waiterName,
        orderId: sourceTable.orderId
      });

      // Clear source
      await dbService.updateDoc('tables', sourceId, {
        status: 'available',
        amount: 0,
        waiterName: '',
        orderId: ''
      });
      return true;
    }
    return false;
  }

  // Combine / Merge Table Source into Table Target
  async mergeTables(sourceId, targetId) {
    const sourceTable = this.tables.find(t => t.id === sourceId);
    const targetTable = this.tables.find(t => t.id === targetId);

    if (sourceTable && targetTable) {
      const combinedAmount = (sourceTable.amount || 0) + (targetTable.amount || 0);
      
      // Update target table
      await dbService.updateDoc('tables', targetId, {
        status: 'occupied',
        amount: combinedAmount,
        waiterName: targetTable.waiterName || sourceTable.waiterName,
        orderId: targetTable.orderId || sourceTable.orderId // points to combined order
      });

      // Release source table
      await dbService.updateDoc('tables', sourceId, {
        status: 'available',
        amount: 0,
        waiterName: '',
        orderId: ''
      });
      return true;
    }
    return false;
  }

  // Split table transaction in two
  async splitTable(tableId, splitAmount) {
    const table = this.tables.find(t => t.id === tableId);
    if (table && table.status === 'occupied') {
      const remainingAmount = Math.max(0, table.amount - splitAmount);
      
      // Update table to show remaining amount
      await dbService.updateDoc('tables', tableId, {
        amount: remainingAmount
      });

      // Create a direct payment/sale record for the split parts
      const invoiceNum = 'SPLIT-' + Math.floor(1000 + Math.random() * 9000);
      const splitInvoice = {
        id: 'split_' + Date.now(),
        orderNum: invoiceNum,
        date: new Date().toISOString().slice(0, 10),
        time: new Date().toLocaleTimeString(),
        timestamp: Date.now(),
        items: [{ id: 'split_item', name: `Split Payment from ${table.name}`, price: splitAmount, qty: 1, total: splitAmount }],
        subtotal: splitAmount,
        discount: 0,
        serviceCharge: 0,
        gst: 0,
        grandTotal: splitAmount,
        paymentMethod: 'Cash',
        tableName: table.name,
        customerName: 'Split Billing Participant',
        waiterName: table.waiterName || 'Cashier'
      };

      await dbService.addDoc('orders', splitInvoice);
      return splitInvoice;
    }
    return null;
  }
}

const tableInstance = new TableController();
window.tableController = tableInstance;
export default tableInstance;

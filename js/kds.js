import dbService from './db.js';

class KdsController {
  constructor() {
    this.tickets = [];
  }

  init(onUpdateCallback) {
    // Subscribe to real-time events in the 'kitchen' collection
    dbService.subscribe('kitchen', (data) => {
      // Filter out tickets that are already delivered/archived
      this.tickets = data.filter(ticket => ticket.status !== 'delivered');
      onUpdateCallback(this.tickets);
    });
  }

  // Set ticket status: pending -> cooking
  async startCooking(ticketId) {
    await dbService.updateDoc('kitchen', ticketId, {
      status: 'cooking'
    });

    // Send visual notification toast to waiter / POS screen
    this.notifyStatusUpdate(ticketId, 'Cooking started');
  }

  // Set ticket status: cooking -> ready
  async markReady(ticketId) {
    const ticket = this.tickets.find(t => t.id === ticketId);
    if (!ticket) return;

    await dbService.updateDoc('kitchen', ticketId, {
      status: 'ready'
    });

    // Alert waitstaff table status is ready
    if (ticket.tableId && ticket.tableId !== 'N/A') {
      await dbService.updateDoc('tables', ticket.tableId, {
        status: 'billing' // set to billing state or keep occupied
      });
    }

    this.notifyStatusUpdate(ticketId, 'Order is READY!');
  }

  // Set ticket status: ready -> delivered (archives card)
  async markDelivered(ticketId) {
    await dbService.updateDoc('kitchen', ticketId, {
      status: 'delivered'
    });
  }

  // Cancel kitchen ticket and adjust table balances
  async cancelKOT(ticketId) {
    if (!confirm('Are you sure you want to cancel this kitchen order?')) return;

    const ticket = this.tickets.find(t => t.id === ticketId);
    
    // Archive from KDS view
    await dbService.updateDoc('kitchen', ticketId, {
      status: 'delivered'
    });

    // Recalculate or release the table if associated
    if (ticket && ticket.tableId && ticket.tableId !== 'N/A') {
      const tables = dbService.firebaseActive 
        ? await dbService.getCollection('tables') 
        : dbService.localDb.tables;
      const table = tables.find(t => t.id === ticket.tableId);

      if (table) {
        const tickets = dbService.firebaseActive 
          ? await dbService.getCollection('kitchen') 
          : dbService.localDb.kitchen;
        // Remaining active tickets for this table (excluding current one)
        const activeKOTs = tickets.filter(t => t.tableId === table.id && t.status !== 'delivered' && t.id !== ticketId);

        if (activeKOTs.length === 0) {
          // No running orders left on this table, mark it available
          await dbService.updateDoc('tables', table.id, {
            status: 'available',
            amount: 0,
            waiterName: '',
            orderId: ''
          });
        } else {
          // Fetch product definitions to recalculate exact running cost
          const products = dbService.firebaseActive 
            ? await dbService.getCollection('products') 
            : dbService.localDb.products;
          
          let remainingAmount = 0;
          activeKOTs.forEach(kot => {
            kot.items.forEach(item => {
              const p = products.find(prod => prod.id === item.productId);
              remainingAmount += item.qty * (p ? p.price : 0);
            });
          });

          await dbService.updateDoc('tables', table.id, {
            amount: remainingAmount
          });
        }
      }
    }
  }

  // Toggle item-level checklist crossouts
  async toggleItemCompletion(ticketId, itemIndex) {
    const ticket = this.tickets.find(t => t.id === ticketId);
    if (ticket && ticket.items[itemIndex]) {
      const currentStatus = ticket.items[itemIndex].status;
      ticket.items[itemIndex].status = currentStatus === 'completed' ? 'pending' : 'completed';
      
      await dbService.updateDoc('kitchen', ticketId, {
        items: ticket.items
      });
    }
  }

  // Create notifications
  async notifyStatusUpdate(ticketId, messageTitle) {
    const ticket = this.tickets.find(t => t.id === ticketId);
    if (!ticket) return;

    const notification = {
      id: 'notify_' + Date.now(),
      title: messageTitle,
      message: `${ticket.orderNum} for Table ${ticket.tableName || 'Takeaway'}`,
      time: new Date().toLocaleTimeString(),
      type: 'success',
      read: false
    };

    await dbService.addDoc('notifications', notification);
  }

  // Calculate elapsed prep minutes
  getElapsedMinutes(timestamp) {
    const diffMs = Date.now() - timestamp;
    return Math.floor(diffMs / 60000);
  }
}

const kdsInstance = new KdsController();
window.kdsController = kdsInstance;
export default kdsInstance;

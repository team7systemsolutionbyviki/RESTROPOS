import dbService from './db.js';
import authService from './auth.js';

class PosController {
  constructor() {
    this.cart = [];
    this.currentOrderType = 'Dine In'; // Dine In, Take Away, Delivery
    this.selectedTable = null; // Associated table object if Dine In
    this.selectedCustomer = null; // Associated customer object
    this.discountPercent = 0;
    this.discountAmount = 0;
    this.appliedCoupon = null;
    this.serviceChargePercent = 5.0; // default
    this.gstPercent = 18.0; // default
    this.heldBills = [];
    this.tipAmount = 0;
    this.splitPayments = []; // array of { method, amount }
    this.editingOrderId = null; // Track editing order
    this.products = [];
  }

  init() {
    this.loadHeldBills();
    this.resetCart();
  }

  resetCart() {
    this.cart = [];
    this.discountPercent = 0;
    this.discountAmount = 0;
    this.appliedCoupon = null;
    this.tipAmount = 0;
    this.splitPayments = [];
    this.selectedCustomer = null;
    this.editingOrderId = null; // Clear editing state
    
    // Load default charges from settings
    const settings = dbService.firebaseActive ? null : dbService.localDb.settings;
    if (settings) {
      this.serviceChargePercent = parseFloat(settings.serviceChargePercent) || 0;
      this.gstPercent = parseFloat(settings.gstPercent) || 0;
    }
    
    this.triggerCartUpdate();
  }

  // --- CART MANAGEMENT ---
  addToCart(product, qty = 1, notes = '') {
    const existing = this.cart.find(item => item.product.id === product.id && item.notes === notes);
    if (existing) {
      existing.qty += qty;
    } else {
      this.cart.push({ product, qty, notes, priority: 'normal' });
    }
    this.triggerCartUpdate();
  }

  updateQty(productId, notes, delta) {
    const item = this.cart.find(i => i.product.id === productId && i.notes === notes);
    if (item) {
      item.qty += delta;
      if (item.qty <= 0) {
        this.cart = this.cart.filter(i => !(i.product.id === productId && i.notes === notes));
      }
      this.triggerCartUpdate();
    }
  }

  removeFromCart(productId, notes) {
    this.cart = this.cart.filter(i => !(i.product.id === productId && i.notes === notes));
    this.triggerCartUpdate();
  }

  // --- CALCULATION SUITE ---
  getSubtotal() {
    return this.cart.reduce((sum, item) => sum + (item.product.price * item.qty), 0);
  }

  getDiscount() {
    const subtotal = this.getSubtotal();
    let totalDiscount = 0;
    
    if (this.discountPercent > 0) {
      totalDiscount += (subtotal * this.discountPercent) / 100;
    }
    totalDiscount += this.discountAmount;
    
    if (this.appliedCoupon) {
      if (this.appliedCoupon.type === 'percent') {
        totalDiscount += (subtotal * this.appliedCoupon.value) / 100;
      } else {
        totalDiscount += this.appliedCoupon.value;
      }
    }
    
    return Math.min(totalDiscount, subtotal);
  }

  getServiceCharge() {
    const settings = (window.settingsController && window.settingsController.activeSettings) || {};
    const percent = parseFloat(settings.serviceChargePercent !== undefined ? settings.serviceChargePercent : this.serviceChargePercent) || 0;
    const subtotal = this.getSubtotal();
    const discount = this.getDiscount();
    return ((subtotal - discount) * percent) / 100;
  }

  getGST() {
    const settings = (window.settingsController && window.settingsController.activeSettings) || {};
    const enabled = settings.gstEnabled !== false;
    if (!enabled) return 0;

    const percent = parseFloat(settings.gstPercent !== undefined ? settings.gstPercent : this.gstPercent) || 0;
    const subtotal = this.getSubtotal();
    const discount = this.getDiscount();
    // GST calculated after discount
    return ((subtotal - discount) * percent) / 100;
  }

  getGrandTotal() {
    const subtotal = this.getSubtotal();
    const discount = this.getDiscount();
    const service = this.getServiceCharge();
    const gst = this.getGST();
    
    const grossTotal = (subtotal - discount) + service + gst + parseFloat(this.tipAmount || 0);
    // Round Off
    return Math.round(grossTotal * 100) / 100;
  }

  // Barcode scanner trigger
  barcodeScan(code) {
    const products = this.products || dbService.localDb.products || [];
    const match = products.find(p => p.barcode === code);
    if (match) {
      this.addToCart(match, 1);
      return { success: true, product: match };
    }
    return { success: false, error: 'Product not found for barcode: ' + code };
  }

  // --- HOLD / RESUME BILLS ---
  holdBill() {
    if (this.cart.length === 0) return false;
    
    const held = {
      id: 'held_' + Date.now(),
      time: new Date().toLocaleTimeString(),
      cart: [...this.cart],
      table: this.selectedTable,
      customer: this.selectedCustomer,
      orderType: this.currentOrderType,
      discountPercent: this.discountPercent,
      discountAmount: this.discountAmount,
      appliedCoupon: this.appliedCoupon,
      tipAmount: this.tipAmount
    };

    this.heldBills.push(held);
    this.saveHeldBills();
    this.resetCart();
    return true;
  }

  resumeBill(heldId) {
    const bill = this.heldBills.find(b => b.id === heldId);
    if (bill) {
      this.cart = bill.cart;
      this.selectedTable = bill.table;
      this.selectedCustomer = bill.customer;
      this.currentOrderType = bill.orderType;
      this.discountPercent = bill.discountPercent;
      this.discountAmount = bill.discountAmount;
      this.appliedCoupon = bill.appliedCoupon;
      this.tipAmount = bill.tipAmount;

      this.heldBills = this.heldBills.filter(b => b.id !== heldId);
      this.saveHeldBills();
      this.triggerCartUpdate();
      return true;
    }
    return false;
  }

  loadHeldBills() {
    const stored = localStorage.getItem('resto_held_bills');
    if (stored) {
      this.heldBills = JSON.parse(stored);
    }
  }

  saveHeldBills() {
    localStorage.setItem('resto_held_bills', JSON.stringify(this.heldBills));
  }

  // --- SUBMIT KOT TO KITCHEN DISPLAY ---
  async sendKOT() {
    if (this.cart.length === 0) return false;

    const kotItems = this.cart.map(item => ({
      productId: item.product.id,
      name: item.product.name,
      qty: item.qty,
      notes: item.notes,
      priority: item.priority || 'normal',
      status: 'pending' // pending, cooking, completed
    }));

    const kot = {
      id: 'kot_' + Date.now(),
      orderNum: 'KOT-' + Math.floor(1000 + Math.random() * 9000),
      tableId: this.selectedTable ? this.selectedTable.id : 'N/A',
      tableName: this.selectedTable ? this.selectedTable.name : 'Takeaway/Delivery',
      orderType: this.currentOrderType,
      waiterName: authService.getCurrentUser() ? authService.getCurrentUser().name : 'POS Terminal',
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now(),
      items: kotItems,
      status: 'pending' // pending, ready, delivered
    };

    // Save KOT
    await dbService.addDoc('kitchen', kot);

    // If table selected, update table state to 'occupied'
    if (this.selectedTable) {
      await dbService.updateDoc('tables', this.selectedTable.id, {
        status: 'occupied',
        amount: this.getGrandTotal(),
        waiterName: kot.waiterName,
        orderId: kot.id
      });
    }

    return kot;
  }

  // --- PAY & COMPLETE TRANSACTION ---
  async completePayment(paymentMethod) {
    if (this.cart.length === 0) return false;

    const orderNum = 'INV-' + Math.floor(100000 + Math.random() * 900000);
    const subtotal = this.getSubtotal();
    const discount = this.getDiscount();
    const serviceCharge = this.getServiceCharge();
    const gst = this.getGST();
    const total = this.getGrandTotal();

    const order = {
      id: 'ord_' + Date.now(),
      orderNum,
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now(),
      items: this.cart.map(item => ({
        id: item.product.id,
        name: item.product.name,
        price: item.product.price,
        qty: item.qty,
        total: item.product.price * item.qty
      })),
      subtotal,
      discount,
      serviceCharge,
      gst,
      tip: parseFloat(this.tipAmount || 0),
      grandTotal: total,
      paymentMethod, // Cash, Card, UPI, Split, Wallet, Credit
      splitPayments: paymentMethod === 'Split' ? this.splitPayments : [],
      orderType: this.currentOrderType,
      tableName: this.selectedTable ? this.selectedTable.name : 'Takeaway/Delivery',
      customerName: this.selectedCustomer ? this.selectedCustomer.name : 'Walk-In Customer',
      waiterName: authService.getCurrentUser() ? authService.getCurrentUser().name : 'Cashier'
    };

    // If we are editing an existing completed order, delete the original first to prevent duplicates
    if (this.editingOrderId) {
      await dbService.deleteDoc('orders', this.editingOrderId);
      this.editingOrderId = null;
    }

    // Save sale record
    await dbService.addDoc('orders', order);

    // Update product stock counts
    for (const item of this.cart) {
      const currentProduct = await dbService.getDoc('products', item.product.id);
      if (currentProduct) {
        const newStock = Math.max(0, (currentProduct.stock || 0) - item.qty);
        await dbService.updateDoc('products', item.product.id, { stock: newStock });
      }
    }

    // Award loyalty points to customer (e.g. 1 point per $10 spent)
    if (this.selectedCustomer) {
      const earnedPoints = Math.floor(total / 10);
      const updatedPoints = (this.selectedCustomer.points || 0) + earnedPoints;
      
      // If payment was Wallet, deduct wallet balance
      let newWalletBalance = this.selectedCustomer.wallet || 0;
      if (paymentMethod === 'Wallet') {
        newWalletBalance = Math.max(0, newWalletBalance - total);
      }
      
      await dbService.updateDoc('customers', this.selectedCustomer.id, {
        points: updatedPoints,
        wallet: newWalletBalance
      });
    }

    // Clear Table state if occupied and mark its KOTs as delivered
    if (this.selectedTable) {
      await dbService.updateDoc('tables', this.selectedTable.id, {
        status: 'available',
        amount: 0,
        waiterName: '',
        orderId: ''
      });

      // Archive/Deliver all active KOT tickets for this table
      const tickets = dbService.firebaseActive 
        ? await dbService.getCollection('kitchen') 
        : dbService.localDb.kitchen;
      const tableKOTs = tickets.filter(t => t.tableId === this.selectedTable.id && t.status !== 'delivered');
      for (const kot of tableKOTs) {
        await dbService.updateDoc('kitchen', kot.id, { status: 'delivered' });
      }
    }

    // Prepare receipt HTML node for window printing
    this.preparePrintReceipt(order);

    // Reset state
    this.resetCart();
    return order;
  }

  // Setup printed templates
  preparePrintReceipt(order) {
    const container = document.getElementById('receipt-print-area') || (() => {
      const el = document.createElement('div');
      el.id = 'receipt-print-area';
      document.body.appendChild(el);
      return el;
    })();

    const activeSet = (window.settingsController && window.settingsController.activeSettings) 
      ? window.settingsController.activeSettings 
      : (dbService.localDb.settings || {});
    const currency = activeSet.currencySymbol || '₹';
    const settings = activeSet;

    const itemsRows = order.items.map(item => `
      <tr>
        <td>${item.name} x ${item.qty}</td>
        <td style="text-align: right;">${currency}${item.price.toFixed(2)}</td>
        <td style="text-align: right;">${currency}${item.total.toFixed(2)}</td>
      </tr>
    `).join('');

    // ─── UPI QR Code Block (only when enabled in settings) ───
    const upiId = settings.upiId || '';
    const shouldPrintQr = !!settings.printUpiQr && upiId.length > 3;

    let upiQrBlock = '';
    if (shouldPrintQr) {
      try {
        // Standard UPI deep link — includes exact grand total amount
        const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(settings.restaurantName || 'Restaurant')}&am=${order.grandTotal.toFixed(2)}&cu=INR`;

        // Generate QR code on a hidden canvas using qrcodejs (no network request!)
        const tempDiv = document.createElement('div');
        tempDiv.style.cssText = 'position:fixed; left:-9999px; top:-9999px; width:160px; height:160px;';
        document.body.appendChild(tempDiv);

        new QRCode(tempDiv, {
          text: upiLink,
          width: 160,
          height: 160,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });

        // Get the generated canvas element and convert to data URL
        const canvas = tempDiv.querySelector('canvas');
        const qrDataUrl = canvas ? canvas.toDataURL('image/png') : '';
        document.body.removeChild(tempDiv);

        if (qrDataUrl) {
          upiQrBlock = `
            <div class="receipt-qrcode-container" style="border-top:1px dashed #000; padding-top:10px; margin-top:10px; text-align:center;">
              <img src="${qrDataUrl}" alt="UPI QR Code" style="width:120px; height:120px; display:block; margin:0 auto; border:1px solid #eee; border-radius:4px;">
              <div style="font-size:9px; margin-top:6px; font-weight:bold;">📱 Scan &amp; Pay via UPI</div>
              <div style="font-size:9px; color:#444; margin-top:2px; font-family:monospace;">${upiId}</div>
            </div>
          `;
        }
      } catch (e) {
        console.warn('QR generation failed:', e);
      }
    }

    const gstEnabled = settings.gstEnabled !== false;
    const gstPercent = parseFloat(settings.gstPercent !== undefined ? settings.gstPercent : 18);
    const servicePercent = parseFloat(settings.serviceChargePercent !== undefined ? settings.serviceChargePercent : 5);

    const gstHeaderLine = (gstEnabled && settings.gstNumber) 
      ? `<p style="font-size: 10px; margin: 2px 0;">GSTIN: ${settings.gstNumber}</p>` 
      : '';

    const serviceRow = order.serviceCharge > 0 
      ? `<div style="display: flex; justify-content: space-between;"><span>Service (${servicePercent}%):</span><span>${currency}${order.serviceCharge.toFixed(2)}</span></div>` 
      : '';

    const gstRow = (gstEnabled && order.gst > 0) 
      ? `<div style="display: flex; justify-content: space-between;"><span>GST (${gstPercent}%):</span><span>${currency}${order.gst.toFixed(2)}</span></div>` 
      : '';

    container.innerHTML = `
      <div class="receipt-receipt-box">
        <div class="receipt-header">
          <img src="https://cdn-icons-png.flaticon.com/512/3408/3408473.png" class="receipt-logo" alt="Logo">
          <h2 style="font-size: 16px; margin: 4px 0;">${settings.restaurantName || 'RestoPOS'}</h2>
          <p style="font-size: 10px; margin: 2px 0;">${settings.address || ''}</p>
          <p style="font-size: 10px; margin: 2px 0;">Ph: ${settings.phone || ''}</p>
          ${gstHeaderLine}
        </div>
        <div class="receipt-details">
          <div><b>Invoice:</b> ${order.orderNum}</div>
          <div><b>Date:</b> ${order.date} ${order.time}</div>
          <div><b>Table:</b> ${order.tableName}</div>
          <div><b>Staff:</b> ${order.waiterName}</div>
          <div><b>Cust:</b> ${order.customerName}</div>
        </div>
        <table class="receipt-table">
          <thead>
            <tr>
              <th style="width: 55%;">Item</th>
              <th style="text-align: right; width: 20%;">Rate</th>
              <th style="text-align: right; width: 25%;">Amt</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows}
          </tbody>
        </table>
        <div class="receipt-totals">
          <div style="display: flex; justify-content: space-between;"><span>Subtotal:</span><span>${currency}${order.subtotal.toFixed(2)}</span></div>
          ${order.discount > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Discount:</span><span>-${currency}${order.discount.toFixed(2)}</span></div>` : ''}
          ${serviceRow}
          ${gstRow}
          ${order.tip > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Tip:</span><span>${currency}${order.tip.toFixed(2)}</span></div>` : ''}
          <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; border-top: 1px dashed #000; padding-top: 4px; margin-top: 4px;">
            <span>Grand Total:</span><span>${currency}${order.grandTotal.toFixed(2)}</span>
          </div>
        </div>
        ${upiQrBlock}
        <div style="text-align: center; margin-top: 12px; font-size: 10px; font-weight: bold;">
          Thank You! Visit Again.
        </div>
      </div>
    `;
  }


  triggerCartUpdate() {
    window.dispatchEvent(new CustomEvent('pos-cart-updated'));
  }
}

const posInstance = new PosController();
window.posController = posInstance;
export default posInstance;

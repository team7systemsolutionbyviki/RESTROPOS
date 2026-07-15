import dbService from './db.js';

class CustomersController {
  constructor() {
    this.customers = [];
  }

  async init(onUpdateCallback) {
    dbService.subscribe('customers', (data) => {
      this.customers = data;
      if (onUpdateCallback) onUpdateCallback(this.customers);
    });
  }

  // --- CUSTOMER PROFILE CRUD ---
  async addCustomer(customer) {
    const newCust = {
      id: customer.id || 'cust_' + Date.now(),
      name: customer.name,
      phone: customer.phone,
      email: customer.email || '',
      birthday: customer.birthday || '',
      points: parseInt(customer.points) || 0,
      wallet: parseFloat(customer.wallet) || 0,
      creditLimit: parseFloat(customer.creditLimit) || 100.00,
      creditBalance: parseFloat(customer.creditBalance) || 0,
      history: []
    };
    await dbService.addDoc('customers', newCust);
    return newCust;
  }

  // --- WALLET & LOYALTY MATH ---
  async rechargeWallet(customerId, amount) {
    const cust = this.customers.find(c => c.id === customerId);
    if (cust) {
      const updatedWallet = (cust.wallet || 0) + parseFloat(amount);
      await dbService.updateDoc('customers', customerId, {
        wallet: updatedWallet
      });
      return true;
    }
    return false;
  }

  async redeemLoyaltyPoints(customerId, pointsToRedeem) {
    const cust = this.customers.find(c => c.id === customerId);
    if (cust && cust.points >= pointsToRedeem) {
      const remainingPoints = cust.points - pointsToRedeem;
      // Conversion rule: 10 points = $1 wallet credit
      const walletCredit = pointsToRedeem / 10;
      const updatedWallet = (cust.wallet || 0) + walletCredit;

      await dbService.updateDoc('customers', customerId, {
        points: remainingPoints,
        wallet: updatedWallet
      });
      return { success: true, walletAdded: walletCredit };
    }
    return { success: false, error: 'Insufficient loyalty points.' };
  }

  // --- VIP CREDIT LIMIT CHECKER ---
  async chargeCredit(customerId, amount) {
    const cust = this.customers.find(c => c.id === customerId);
    if (cust) {
      const currentCredit = cust.creditBalance || 0;
      const limit = cust.creditLimit || 0;
      
      if (currentCredit + amount <= limit) {
        await dbService.updateDoc('customers', customerId, {
          creditBalance: currentCredit + amount
        });
        return { success: true };
      }
      return { success: false, error: 'Credit limit reached! Max credit allowance exceeded.' };
    }
    return { success: false, error: 'Customer not found.' };
  }
}

const customersInstance = new CustomersController();
window.customersController = customersInstance;
export default customersInstance;

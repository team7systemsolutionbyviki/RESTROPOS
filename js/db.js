import FirebaseConfigManager from './firebase-config.js';

// Central Database Service
class DatabaseService {
  constructor() {
    this.firebaseActive = false;
    this.db = null;
    this.listeners = {};
    this.localDb = {};
  }

  async init() {
    this.connectionError = null;
    const fb = await FirebaseConfigManager.initializeFirebase();
    this.firebaseActive = fb.active;
    this.db = fb.db;
    
    if (!this.firebaseActive) {
      this.initLocalMockDb();
    } else {
      try {
        // Verify read permissions and active database status
        await this.db.collection('users').limit(1).get();
        await this.seedFirebaseIfEmpty();
      } catch (e) {
        console.error('Firestore connection/permission check failed. Falling back to Offline Demo Mode.', e);
        this.connectionError = e.message || String(e);
        this.firebaseActive = false;
        this.initLocalMockDb();
      }
    }
  }

  // --- LOCAL MOCK DATABASE SYSTEM ---
  initLocalMockDb() {
    const stored = localStorage.getItem('resto_pos_local_db');
    if (stored) {
      this.localDb = JSON.parse(stored);
      // Ensure Viki exists in local database users
      if (this.localDb.users && !this.localDb.users.some(u => u.username === 'viki')) {
        this.localDb.users.push({ id: 'u_viki', username: 'viki', role: 'Super Master Admin', branchId: 'b1', name: 'Viki', pin: '1101' });
        this.saveLocalDb();
      }
      // Ensure user u1 is configured as Branch Admin
      const u1 = this.localDb.users.find(u => u.id === 'u1');
      if (u1 && u1.role !== 'Branch Admin') {
        u1.username = 'admin';
        u1.name = 'Branch Admin';
        u1.role = 'Branch Admin';
        u1.pin = '1111';
        this.saveLocalDb();
      }
      // Ensure roles have viewDashboard permissions
      if (this.localDb.roles) {
        const superMaster = this.localDb.roles.find(r => r.role === 'Super Master Admin');
        if (superMaster && !superMaster.permissions.viewDashboard) {
          superMaster.permissions.viewDashboard = true;
        }
        const branchAdmin = this.localDb.roles.find(r => r.role === 'Branch Admin');
        if (branchAdmin && !branchAdmin.permissions.viewDashboard) {
          branchAdmin.permissions.viewDashboard = true;
        }
      }
      // Ensure tables exist in local database
      if (!this.localDb.tables || this.localDb.tables.length === 0) {
        this.localDb.tables = [
          { id: 't1', floor: '1st Floor', name: 'Table 1', capacity: 2, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
          { id: 't2', floor: '1st Floor', name: 'Table 2', capacity: 4, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' },
          { id: 't3', floor: '1st Floor', name: 'Table 3', capacity: 6, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' },
          { id: 't4', floor: '1st Floor', name: 'Table 4', capacity: 2, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
          { id: 't5', floor: '2nd Floor', name: 'Table 5', capacity: 4, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
          { id: 't6', floor: '2nd Floor', name: 'Table 6', capacity: 8, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' }
        ];
        this.saveLocalDb();
      }
      return;
    }

    // Default Seed Data
    this.localDb = {
      branches: [
        { id: 'b1', name: 'Downtown Main Branch', code: 'DT-01', location: 'New York', status: 'Active' },
        { id: 'b2', name: 'Uptown Express', code: 'UT-02', location: 'Boston', status: 'Active' }
      ],
      shops: [
        { id: 's1', branchId: 'b1', name: 'Dine-In Salon', type: 'Dine-In', status: 'Active' },
        { id: 's2', branchId: 'b1', name: 'Bakery & Takeaway Section', type: 'Take-Away', status: 'Active' }
      ],
      users: [
        { id: 'u_viki', username: 'viki', role: 'Super Master Admin', branchId: 'b1', name: 'Viki', pin: '1101' },
        { id: 'u1', username: 'admin', role: 'Branch Admin', branchId: 'b1', name: 'Branch Admin', pin: '1111' },
        { id: 'u2', username: 'manager', role: 'Shop Manager', branchId: 'b1', name: 'Minerva McGonagall', pin: '2222' },
        { id: 'u3', username: 'waiter', role: 'Waiter', branchId: 'b1', name: 'Ron Weasley', pin: '3333' },
        { id: 'u4', username: 'cashier', role: 'Cashier', branchId: 'b1', name: 'Harry Potter', pin: '4444' },
        { id: 'u5', username: 'chef', role: 'Kitchen Staff', branchId: 'b1', name: 'Rubeus Hagrid', pin: '5555' }
      ],
      categories: [
        { id: 'cat1', name: 'Appetizers', icon: 'lunch_dining' },
        { id: 'cat2', name: 'Mains', icon: 'restaurant' },
        { id: 'cat3', name: 'Drinks', icon: 'local_bar' },
        { id: 'cat4', name: 'Desserts', icon: 'cake' }
      ],
      products: [
        { id: 'p1', categoryId: 'cat1', name: 'Truffle Fries', price: 12.00, barcode: '10001', stock: 120, minStock: 20, description: 'Crispy fries with truffle oil and parmesan.' },
        { id: 'p2', categoryId: 'cat1', name: 'Garlic Bread', price: 8.00, barcode: '10002', stock: 85, minStock: 15, description: 'Toasted baguette with herb garlic butter.' },
        { id: 'p3', categoryId: 'cat2', name: 'Wagyu Smash Burger', price: 22.00, barcode: '20001', stock: 50, minStock: 10, description: 'Double Wagyu beef patty, cheddar, house sauce.' },
        { id: 'p4', categoryId: 'cat2', name: 'Wood-fired Pepperoni Pizza', price: 19.50, barcode: '20002', stock: 40, minStock: 8, description: 'Fresh mozzarella, spicy pepperoni, fresh basil.' },
        { id: 'p5', categoryId: 'cat3', name: 'Craft IPA Beer', price: 8.50, barcode: '30001', stock: 200, minStock: 30, description: 'Locally brewed India Pale Ale.' },
        { id: 'p6', categoryId: 'cat3', name: 'Classic Mojito', price: 11.00, barcode: '30002', stock: 150, minStock: 25, description: 'White rum, fresh mint, lime, cane sugar, soda.' },
        { id: 'p7', categoryId: 'cat4', name: 'Lava Chocolate Cake', price: 10.00, barcode: '40001', stock: 35, minStock: 10, description: 'Warm cake with a molten chocolate center.' },
        { id: 'p8', categoryId: 'cat4', name: 'Pistachio Gelato', price: 7.50, barcode: '40002', stock: 60, minStock: 15, description: 'Italian artisan pistachio ice cream.' }
      ],
      customers: [
        { id: 'c1', name: 'Hermione Granger', phone: '9876543210', points: 350, wallet: 50.00, creditLimit: 200.00, history: [], email: 'hermione@hogwarts.edu' },
        { id: 'c2', name: 'Luna Lovegood', phone: '9123456780', points: 120, wallet: 10.00, creditLimit: 50.00, history: [], email: 'luna@quibbler.net' }
      ],
      tables: [
        // Floor 1 tables
        { id: 't1', floor: '1st Floor', name: 'Table 1', capacity: 2, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
        { id: 't2', floor: '1st Floor', name: 'Table 2', capacity: 4, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' },
        { id: 't3', floor: '1st Floor', name: 'Table 3', capacity: 6, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' },
        { id: 't4', floor: '1st Floor', name: 'Table 4', capacity: 2, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
        // Floor 2 tables
        { id: 't5', floor: '2nd Floor', name: 'Table 5', capacity: 4, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
        { id: 't6', floor: '2nd Floor', name: 'Table 6', capacity: 8, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' }
      ],
      orders: [],
      kitchen: [],
      inventory: [
        { id: 'i1', name: 'Wagyu Beef Patties', stock: 100, unit: 'pcs', supplier: 'Premium Meats Inc.', alertThreshold: 15, expiryDate: '2026-07-25' },
        { id: 'i2', name: 'Fresh Mozzarella', stock: 12, unit: 'kg', supplier: 'Dairy Farms Co.', alertThreshold: 3, expiryDate: '2026-07-20' },
        { id: 'i3', name: 'Truffle Oil', stock: 5, unit: 'liters', supplier: 'Gourmet Imports', alertThreshold: 2, expiryDate: '2027-01-15' }
      ],
      suppliers: [
        { id: 'sup1', name: 'Premium Meats Inc.', contact: 'Severus Snape', phone: '555-0192', email: 'snape@meats.com' },
        { id: 'sup2', name: 'Dairy Farms Co.', contact: 'Neville Longbottom', phone: '555-0143', email: 'neville@dairy.com' },
        { id: 'sup3', name: 'Gourmet Imports', contact: 'Lucius Malfoy', phone: '555-0188', email: 'lucius@gourmet.com' }
      ],
      expenses: [
        { id: 'exp1', date: '2026-07-14', category: 'Utilities', amount: 150.00, notes: 'Water bill' },
        { id: 'exp2', date: '2026-07-13', category: 'Ingredients', amount: 320.00, notes: 'Fresh bread shipment' }
      ],
      payments: [],
      notifications: [
        { id: 'n1', title: 'Welcome to RestoPOS', message: 'Offline Demo DB initialized successfully.', time: new Date().toLocaleTimeString(), type: 'info', read: false }
      ],
      pending_orders: [],
      settings: {
        restaurantName: 'The Leaky Cauldron',
        address: '1 Diagon Alley, London',
        phone: '+44 20 7946 0958',
        gstNumber: '29AAAAA1111A1Z1',
        serviceChargePercent: 5.0,
        gstPercent: 18.0,
        printerSize: '3-inch',
        theme: 'dark'
      },
      roles: [
        { role: 'Super Master Admin', permissions: { viewDashboard: true, viewReports: true, manageBranches: true, editSettings: true, cancelBills: true } },
        { role: 'Branch Admin', permissions: { viewDashboard: true, viewReports: true, manageBranches: false, editSettings: true, cancelBills: true } },
        { role: 'Shop Manager', permissions: { viewDashboard: false, viewReports: true, manageBranches: false, editSettings: false, cancelBills: true } },
        { role: 'Cashier', permissions: { viewDashboard: false, viewReports: false, manageBranches: false, editSettings: false, cancelBills: false } },
        { role: 'Waiter', permissions: { viewDashboard: false, viewReports: false, manageBranches: false, editSettings: false, cancelBills: false } },
        { role: 'Kitchen Staff', permissions: { viewDashboard: false, viewReports: false, manageBranches: false, editSettings: false, cancelBills: false } }
      ]
    };

    this.saveLocalDb();
  }

  saveLocalDb() {
    localStorage.setItem('resto_pos_local_db', JSON.stringify(this.localDb));
  }

  async seedFirebaseIfEmpty() {
    try {
      // Check if already seeded by fetching users collection
      const users = await this.getCollection('users');
      if (users.length === 0) {
        console.log('Firebase Firestore is empty. Seeding default config & initial accounts...');
        
        const seedData = {
          branches: [
            { id: 'b1', name: 'Downtown Main Branch', code: 'DT-01', location: 'New York', status: 'Active' },
            { id: 'b2', name: 'Uptown Express', code: 'UT-02', location: 'Boston', status: 'Active' }
          ],
          shops: [
            { id: 's1', branchId: 'b1', name: 'Dine-In Salon', type: 'Dine-In', status: 'Active' },
            { id: 's2', branchId: 'b1', name: 'Bakery & Takeaway Section', type: 'Take-Away', status: 'Active' }
          ],
          users: [
            { id: 'u_viki', username: 'viki', role: 'Super Master Admin', branchId: 'b1', name: 'Viki', pin: '1101' },
            { id: 'u1', username: 'admin', role: 'Branch Admin', branchId: 'b1', name: 'Branch Admin', pin: '1111' },
            { id: 'u2', username: 'manager', role: 'Shop Manager', branchId: 'b1', name: 'Minerva McGonagall', pin: '2222' },
            { id: 'u3', username: 'waiter', role: 'Waiter', branchId: 'b1', name: 'Ron Weasley', pin: '3333' },
            { id: 'u4', username: 'cashier', role: 'Cashier', branchId: 'b1', name: 'Harry Potter', pin: '4444' },
            { id: 'u5', username: 'chef', role: 'Kitchen Staff', branchId: 'b1', name: 'Rubeus Hagrid', pin: '5555' }
          ],
          categories: [
            { id: 'cat1', name: 'Appetizers', icon: 'lunch_dining' },
            { id: 'cat2', name: 'Mains', icon: 'restaurant' },
            { id: 'cat3', name: 'Drinks', icon: 'local_bar' },
            { id: 'cat4', name: 'Desserts', icon: 'cake' }
          ],
          products: [
            { id: 'p1', categoryId: 'cat1', name: 'Truffle Fries', price: 12.00, barcode: '10001', stock: 120, minStock: 20, description: 'Crispy fries with truffle oil and parmesan.' },
            { id: 'p2', categoryId: 'cat1', name: 'Garlic Bread', price: 8.00, barcode: '10002', stock: 85, minStock: 15, description: 'Toasted baguette with herb garlic butter.' },
            { id: 'p3', categoryId: 'cat2', name: 'Wagyu Smash Burger', price: 22.00, barcode: '20001', stock: 50, minStock: 10, description: 'Double Wagyu beef patty, cheddar, house sauce.' },
            { id: 'p4', categoryId: 'cat2', name: 'Wood-fired Pepperoni Pizza', price: 19.50, barcode: '20002', stock: 40, minStock: 8, description: 'Fresh mozzarella, spicy pepperoni, fresh basil.' },
            { id: 'p5', categoryId: 'cat3', name: 'Craft IPA Beer', price: 8.50, barcode: '30001', stock: 200, minStock: 30, description: 'Locally brewed India Pale Ale.' },
            { id: 'p6', categoryId: 'cat3', name: 'Classic Mojito', price: 11.00, barcode: '30002', stock: 150, minStock: 25, description: 'White rum, fresh mint, lime, cane sugar, soda.' },
            { id: 'p7', categoryId: 'cat4', name: 'Lava Chocolate Cake', price: 10.00, barcode: '40001', stock: 35, minStock: 10, description: 'Warm cake with a molten chocolate center.' },
            { id: 'p8', categoryId: 'cat4', name: 'Pistachio Gelato', price: 7.50, barcode: '40002', stock: 60, minStock: 15, description: 'Italian artisan pistachio ice cream.' }
          ],
          tables: [
            { id: 't1', floor: '1st Floor', name: 'Table 1', capacity: 2, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
            { id: 't2', floor: '1st Floor', name: 'Table 2', capacity: 4, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' },
            { id: 't3', floor: '1st Floor', name: 'Table 3', capacity: 6, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' },
            { id: 't4', floor: '1st Floor', name: 'Table 4', capacity: 2, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
            { id: 't5', floor: '2nd Floor', name: 'Table 5', capacity: 4, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'circle' },
            { id: 't6', floor: '2nd Floor', name: 'Table 6', capacity: 8, status: 'available', waiterId: '', waiterName: '', amount: 0, orderId: '', shape: 'square' }
          ],
          roles: [
            { id: 'r1', role: 'Super Master Admin', permissions: { viewDashboard: true, viewReports: true, manageBranches: true, editSettings: true, cancelBills: true } },
            { id: 'r2', role: 'Branch Admin', permissions: { viewDashboard: true, viewReports: true, manageBranches: false, editSettings: true, cancelBills: true } },
            { id: 'r3', role: 'Shop Manager', permissions: { viewDashboard: false, viewReports: true, manageBranches: false, editSettings: false, cancelBills: true } },
            { id: 'r4', role: 'Cashier', permissions: { viewDashboard: false, viewReports: false, manageBranches: false, editSettings: false, cancelBills: false } },
            { id: 'r5', role: 'Waiter', permissions: { viewDashboard: false, viewReports: false, manageBranches: false, editSettings: false, cancelBills: false } },
            { id: 'r6', role: 'Kitchen Staff', permissions: { viewDashboard: false, viewReports: false, manageBranches: false, editSettings: false, cancelBills: false } }
          ],
          settings: [
            {
              id: 'general',
              restaurantName: 'The Leaky Cauldron',
              address: '1 Diagon Alley, London',
              phone: '+44 20 7946 0958',
              gstNumber: '29AAAAA1111A1Z1',
              serviceChargePercent: 5.0,
              gstPercent: 18.0,
              printerSize: '3-inch',
              theme: 'dark'
            }
          ]
        };

        for (const collName of Object.keys(seedData)) {
          for (const doc of seedData[collName]) {
            await this.addDoc(collName, doc);
          }
        }
        console.log('Firebase Firestore seeding complete!');
      }
    } catch (err) {
      console.error('Failed to auto-seed Firebase:', err);
    }
  }

  // --- CRUD API INTERFACE ---
  async getCollection(collectionName) {
    if (this.firebaseActive) {
      try {
        const snapshot = await this.db.collection(collectionName).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } catch (e) {
        console.error(`Firebase error getting ${collectionName}`, e);
        return [];
      }
    } else {
      return this.localDb[collectionName] || [];
    }
  }

  async getDoc(collectionName, id) {
    if (this.firebaseActive) {
      const doc = await this.db.collection(collectionName).doc(id).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    } else {
      const collection = this.localDb[collectionName] || [];
      return collection.find(item => item.id === id) || null;
    }
  }

  async addDoc(collectionName, data) {
    const id = data.id || 'id_' + Math.random().toString(36).substr(2, 9);
    const newDoc = { ...data, id };

    if (this.firebaseActive) {
      try {
        await this.db.collection(collectionName).doc(id).set(newDoc);
      } catch (err) {
        console.error(`Firebase error adding doc in ${collectionName}:`, err);
        if (window.appController && window.appController.showToast) {
          window.appController.showToast('Firebase Write Error ❌', `Failed to add document to '${collectionName}': ${err.message}`, 'danger');
        } else {
          alert(`Firebase Write Error: ${err.message}`);
        }
        throw err;
      }
    } else {
      if (!this.localDb[collectionName]) {
        this.localDb[collectionName] = [];
      }
      this.localDb[collectionName].push(newDoc);
      this.saveLocalDb();
      this.triggerLocalUpdate(collectionName);
    }
    return newDoc;
  }

  async updateDoc(collectionName, id, updateData) {
    if (this.firebaseActive) {
      try {
        await this.db.collection(collectionName).doc(id).update(updateData);
      } catch (err) {
        console.error(`Firebase error updating doc in ${collectionName}:`, err);
        if (window.appController && window.appController.showToast) {
          window.appController.showToast('Firebase Update Error ❌', `Failed to update document in '${collectionName}': ${err.message}`, 'danger');
        } else {
          alert(`Firebase Update Error: ${err.message}`);
        }
        throw err;
      }
    } else {
      const idx = this.localDb[collectionName].findIndex(item => item.id === id);
      if (idx !== -1) {
        this.localDb[collectionName][idx] = { ...this.localDb[collectionName][idx], ...updateData };
        this.saveLocalDb();
        this.triggerLocalUpdate(collectionName);
      }
    }
  }

  async deleteDoc(collectionName, id) {
    if (this.firebaseActive) {
      try {
        await this.db.collection(collectionName).doc(id).delete();
      } catch (err) {
        console.error(`Firebase error deleting doc in ${collectionName}:`, err);
        if (window.appController && window.appController.showToast) {
          window.appController.showToast('Firebase Delete Error ❌', `Failed to delete document from '${collectionName}': ${err.message}`, 'danger');
        } else {
          alert(`Firebase Delete Error: ${err.message}`);
        }
        throw err;
      }
    } else {
      this.localDb[collectionName] = this.localDb[collectionName].filter(item => item.id !== id);
      this.saveLocalDb();
      this.triggerLocalUpdate(collectionName);
    }
  }

  // Real-time listener registration
  subscribe(collectionName, callback) {
    if (this.firebaseActive) {
      return this.db.collection(collectionName).onSnapshot((snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        callback(data);
      }, (error) => {
        console.error(`Firebase subscription error for ${collectionName}:`, error);
      });
    } else {
      // Mock Listener subscription
      const eventName = `db-update-${collectionName}`;
      const handler = () => {
        callback(this.localDb[collectionName] || []);
      };

      window.addEventListener(eventName, handler);
      
      // Fire callback immediately with current local data to emulate Firebase onSnapshot
      setTimeout(() => {
        callback(this.localDb[collectionName] || []);
      }, 0);
      
      // Return unsubscriber function
      return () => {
        window.removeEventListener(eventName, handler);
      };
    }
  }

  triggerLocalUpdate(collectionName) {
    const eventName = `db-update-${collectionName}`;
    window.dispatchEvent(new CustomEvent(eventName));
  }
}

const dbInstance = new DatabaseService();
window.dbService = dbInstance;
export default dbInstance;

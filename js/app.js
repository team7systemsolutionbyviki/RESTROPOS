import dbService from './db.js';
import authService from './auth.js';
import posController from './pos.js';
import tableController from './tables.js';
import kdsController from './kds.js';
import inventoryController from './inventory.js';
import customersController from './customers.js';
import reportsController from './reports.js';
import settingsController from './settings.js';
import driveBackupService from './drive-backup.js';

class AppController {
  constructor() {
    this.activeView = 'dashboard';
    this.notificationsCount = 0;
    this.customerCart = [];
    this.customerTableId = null;
    this.customerTableName = '';
    this.lastNotificationId = null;
    this.initializedNotifications = false;
    this.pendingOrders = [];
  }

  getCurrencySymbol() {
    const config = settingsController.activeSettings || {};
    return config.currencySymbol || '$';
  }

  async start() {
    // 1. Initialize DB and Auth systems
    await dbService.init();
    await authService.init();

    // 2. Register global UI listeners
    this.bindGlobalEvents();

    // 3. Check login status
    if (!authService.getCurrentUser()) {
      this.showLoginPanel();
    } else {
      this.hideLoginPanel();
      this.initModulesAndListen();
    }

    // Register Service Worker for PWA
    this.registerServiceWorker();

    // Show warning if Firebase connection failed and fell back to local DB
    if (dbService.connectionError) {
      setTimeout(() => {
        this.showToast(
          'Firebase Connection Issue ⚠️',
          `Failed to load Firebase: "${dbService.connectionError}". Operating in Offline Demo Mode instead. Check your Firebase security rules.`,
          'danger'
        );
      }, 1000);
    }
  }

  // --- SERVICE WORKER FOR PWA ---
  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then((reg) => {
          console.log('ServiceWorker registered with scope: ', reg.scope);
        }).catch((err) => {
          console.warn('ServiceWorker registration failed: ', err);
        });
      });
    }
  }

  // --- LOGIN PANEL SYSTEM ---
  showLoginPanel() {
    const overlay = document.getElementById('login-panel-overlay');
    if (overlay) overlay.style.display = 'flex';
  }

  hideLoginPanel() {
    const overlay = document.getElementById('login-panel-overlay');
    if (overlay) overlay.style.display = 'none';

    // Show details of logged in user in header / sidebar
    const user = authService.getCurrentUser();
    if (user) {
      document.getElementById('logged-user-name').textContent = user.name;
      document.getElementById('logged-user-role').textContent = user.role;
      document.getElementById('logged-user-avatar').src = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user.name)}`;
      
      // Limit sidebar modules depending on roles permissions
      this.filterSidebarItems();
    }
  }

  filterSidebarItems() {
    const items = document.querySelectorAll('.nav-item');
    items.forEach(item => {
      const perm = item.getAttribute('data-permission');
      if (perm && !authService.hasPermission(perm)) {
        item.style.display = 'none';
      } else {
        item.style.display = 'flex';
      }
    });
  }

  // --- INITIALIZE REAL-TIME DB UPDATES ---
  async initModulesAndListen() {
    // Load Settings & Apply active theme
    await settingsController.init((cfg) => {
      if (cfg && cfg.theme) {
        settingsController.applyTheme(cfg.theme);
      }
    });

    // Populate profile details / update branch selector dropdown
    if (window.appController.updateHeaderBranchSelector) {
      await window.appController.updateHeaderBranchSelector();
    }

    // Initialize Inventory & Supplier data
    await inventoryController.init(() => {
      this.renderInventoryTable();
    });

    // Initialize Customers list
    await customersController.init((list) => {
      this.renderCustomersTable();
      this.populateCustomersDropdown();
    });

    // Setup Table Status updates
    await tableController.init((floorTables) => {
      this.renderTablesGrid(floorTables);
    });

    // Listen to pending customer self-orders in real-time
    dbService.subscribe('pending_orders', (orders) => {
      this.pendingOrders = orders;
      if (this.activeView === 'tables') {
        this.renderTablesView();
      }
    });

    // Setup Kitchen KOT screen updates
    kdsController.init((tickets) => {
      this.renderKitchenScreen(tickets);
    });

    // Fetch initial kitchen ticket IDs to prevent auto-printing already loaded tickets on start
    const initialKots = dbService.firebaseActive 
      ? await dbService.getCollection('kitchen') 
      : dbService.localDb.kitchen || [];
    this.seenKotIds = new Set(initialKots.map(k => k.id));

    // Listen to kitchen tickets for auto-printing self-order KOTs
    dbService.subscribe('kitchen', (tickets) => {
      const config = settingsController.activeSettings || {};
      const shouldAutoPrint = !!config.autoPrintSelfOrderKot;

      tickets.forEach(ticket => {
        if (this.seenKotIds && !this.seenKotIds.has(ticket.id)) {
          this.seenKotIds.add(ticket.id);

          const isSelfOrder = ticket.waiterName === 'Self-Order';
          if (isSelfOrder && shouldAutoPrint) {
            this.showToast('Self-Order Received', `Auto-printing KOT for ${ticket.tableName}...`, 'info');
            this.printKOTSlip(ticket);
          }
        }
      });
    });

    // Subscribe to products list
    dbService.subscribe('products', (products) => {
      this.products = products;
      posController.products = products;
      if (this.activeView === 'pos') {
        const activeCat = document.querySelector('.category-chip.active');
        const catId = activeCat ? activeCat.getAttribute('data-category-id') : 'all';
        this.renderProductsGrid(catId);
      }
    });

    // Setup POS parameters
    posController.init();

    // Listen to notification logs
    dbService.subscribe('notifications', (logs) => {
      this.renderNotificationsList(logs);
    });

    // Load initial sales records for analytical graphs
    await reportsController.loadData();
    
    // Switch to first permitted view
    let defaultView = 'dashboard';
    if (!authService.hasPermission('viewDashboard')) {
      const visibleItem = document.querySelector('.nav-item:not([style*="display: none"])');
      if (visibleItem) {
        defaultView = visibleItem.getAttribute('data-view');
      }
    }
    
    // Set active link style on the matching nav element
    document.querySelectorAll('.nav-item').forEach(item => {
      if (item.getAttribute('data-view') === defaultView) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    if (defaultView === 'dashboard') {
      this.renderDashboardAnalytics();
    }
    this.switchView(defaultView);
  }

  // --- GLOBAL NAV & INTERACTIVE ROUTING ---
  bindGlobalEvents() {
    // Collapsible Sidebar button toggle
    const toggleBtn = document.getElementById('sidebar-collapse-toggle');
    const sidebar = document.getElementById('app-sidebar');
    if (toggleBtn && sidebar) {
      toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
      });
    }

    // Sidebar navigation click routing
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const viewName = item.getAttribute('data-view');
        if (viewName) {
          this.switchView(viewName);
          navItems.forEach(i => i.classList.remove('active'));
          item.classList.add('active');
        }
      });
    });

    // Sign out trigger
    const logoutBtn = document.getElementById('sidebar-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        authService.logout();
      });
    }

    // Quick role login click bindings
    const roleLoginBtns = document.querySelectorAll('.quick-login-btn');
    roleLoginBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const pin = btn.getAttribute('data-pin');
        const res = await authService.login(pin);
        if (res.success) {
          this.showToast('Login Success', `Logged in as ${res.user.name} (${res.user.role})`, 'success');
          this.hideLoginPanel();
          this.initModulesAndListen();
        } else {
          this.showToast('Login Failed', res.error, 'danger');
        }
      });
    });

    // Custom PIN entry login
    const pinForm = document.getElementById('custom-pin-form');
    if (pinForm) {
      pinForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pinInput = document.getElementById('custom-pin-input');
        const res = await authService.login(pinInput.value);
        if (res.success) {
          this.showToast('Login Success', `Logged in as ${res.user.name}`, 'success');
          pinInput.value = '';
          this.hideLoginPanel();
          this.initModulesAndListen();
        } else {
          this.showToast('Login Failed', res.error, 'danger');
        }
      });
    }

    // POS table selector change event
    const posTableSelector = document.getElementById('pos-table-selector');
    if (posTableSelector) {
      posTableSelector.addEventListener('change', async (e) => {
        const tableId = e.target.value;
        const tables = dbService.firebaseActive 
          ? await dbService.getCollection('tables') 
          : dbService.localDb.tables;
        const table = tables.find(t => t.id === tableId);
        posController.selectedTable = table || null;

        if (table) {
          // 1. Check for pending guest self-orders
          const pendingOrders = dbService.firebaseActive 
            ? await dbService.getCollection('pending_orders') 
            : dbService.localDb.pending_orders;
          const tableOrder = pendingOrders.find(o => o.tableId === table.id && o.status === 'pending');
          
          if (tableOrder) {
            const confirmLoad = confirm(`Table ${table.name} has a pending guest order of ${tableOrder.cart.length} items (${this.getCurrencySymbol()}${tableOrder.total.toFixed(2)}).\n\nDo you want to load this order into the cart?`);
            if (confirmLoad) {
              posController.cart = tableOrder.cart.map(item => ({
                product: item.product,
                qty: item.qty,
                notes: ''
              }));
              
              if (dbService.firebaseActive) {
                await dbService.updateDoc('pending_orders', tableOrder.id, { status: 'approved' });
              } else {
                tableOrder.status = 'approved';
                dbService.saveLocalDb();
              }
              this.showToast('Order Loaded', `Guest order for ${table.name} loaded into the cart.`, 'success');
              posController.triggerCartUpdate();
              return;
            }
          }

          // 2. Load active running KOT bill items
          const items = await this.loadActiveTableOrder(table.id);
          posController.cart = items;
        } else {
          posController.cart = [];
        }
        posController.triggerCartUpdate();
      });
    }

    // POS Cart Events
    window.addEventListener('pos-cart-updated', () => {
      this.renderCartView();
    });

    // Auto lookup guest name based on typed mobile number
    document.addEventListener('input', async (e) => {
      if (e.target.id === 'pos-customer-mobile') {
        const mobile = e.target.value.trim();
        const nameInput = document.getElementById('pos-customer-name');
        
        // Find matching customer in database
        const customers = dbService.firebaseActive 
          ? await dbService.getCollection('customers') 
          : dbService.localDb.customers;
          
        const cust = customers.find(c => c.phone === mobile);
        if (cust) {
          if (nameInput) nameInput.value = cust.name;
          posController.selectedCustomer = cust;
        } else {
          // Temporarily hold typed customer info
          posController.selectedCustomer = {
            id: 'temp_cust_' + Date.now(),
            name: nameInput ? nameInput.value.trim() : '',
            phone: mobile
          };
        }
      } else if (e.target.id === 'pos-customer-name') {
        const name = e.target.value.trim();
        const mobileInput = document.getElementById('pos-customer-mobile');
        const mobile = mobileInput ? mobileInput.value.trim() : '';
        
        if (posController.selectedCustomer) {
          posController.selectedCustomer.name = name;
        } else {
          posController.selectedCustomer = {
            id: 'temp_cust_' + Date.now(),
            name: name,
            phone: mobile
          };
        }
      }
    });

    // Categories filter clicks
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('category-chip')) {
        document.querySelectorAll('.category-chip').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        const catId = e.target.getAttribute('data-category-id');
        this.renderProductsGrid(catId);
      }
    });

    // Product cards click bindings
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.product-card');
      if (card) {
        const productId = card.getAttribute('data-product-id');
        const products = this.products || dbService.localDb.products || [];
        const prod = products.find(p => p.id === productId);
        if (prod) {
          posController.addToCart(prod, 1);
          this.showToast('Item Added', `${prod.name} added to cart`, 'info');
        }
      }
    });
  }

  // --- SWAP SCREEN PANELS ---
  switchView(viewName) {
    this.activeView = viewName;
    document.querySelectorAll('.app-view').forEach(view => {
      view.classList.remove('active');
    });

    const targetView = document.getElementById(`view-${viewName}`);
    if (targetView) {
      targetView.classList.add('active');
      
      // Perform module-specific re-renders when swapping panels
      if (viewName === 'pos') {
        this.initPOSPanel();
      } else if (viewName === 'tables') {
        this.renderTablesView();
      } else if (viewName === 'kds') {
        // Re-render KDS with latest tickets when switching to kitchen view
        this.renderKitchenScreen(kdsController.tickets);
      } else if (viewName === 'dashboard') {
        reportsController.loadData().then(() => this.renderDashboardAnalytics());
      } else if (viewName === 'reports') {
        reportsController.loadData().then(() => this.renderReportsPreview());
      } else if (viewName === 'settings') {
        this.loadSettingsView();
      } else if (viewName === 'menu-mgmt') {
        this.renderSettingsProductsTable();
        this.renderSettingsCategoriesTable();
      } else if (viewName === 'customer-menu') {
        this.initCustomerView();
      }
    }
  }

  loadSettingsView() {
    const user = authService.getCurrentUser();
    const config = settingsController.activeSettings || {};
    
    // Populate form fields
    const restoNameInput = document.getElementById('settings-resto-name');
    if (restoNameInput) restoNameInput.value = config.restaurantName || '';
    
    const restoAddressInput = document.getElementById('settings-resto-address');
    if (restoAddressInput) restoAddressInput.value = config.address || '';
    
    const restoPhoneInput = document.getElementById('settings-resto-phone');
    if (restoPhoneInput) restoPhoneInput.value = config.phone || '';
    
    const restoGstInput = document.getElementById('settings-resto-gst');
    if (restoGstInput) restoGstInput.value = config.gstNumber || '';
    
    const restoPrinterSelect = document.getElementById('settings-resto-printer');
    if (restoPrinterSelect) restoPrinterSelect.value = config.printerSize || '3-inch';

    const restoKotPrinterInput = document.getElementById('settings-resto-kot-printer');
    if (restoKotPrinterInput) restoKotPrinterInput.value = config.kotPrinterPath || '';

    const restoReceiptPrinterInput = document.getElementById('settings-resto-receipt-printer');
    if (restoReceiptPrinterInput) restoReceiptPrinterInput.value = config.receiptPrinterPath || '';
    
    const restoThemeSelect = document.getElementById('settings-resto-theme');
    if (restoThemeSelect) restoThemeSelect.value = config.theme || 'dark';

    const restoCurrencySelect = document.getElementById('settings-resto-currency');
    if (restoCurrencySelect) restoCurrencySelect.value = config.currencySymbol || '$';

    const restoTamilToggle = document.getElementById('settings-resto-tamil-keyboard');
    if (restoTamilToggle) restoTamilToggle.checked = config.tamilKeyboardEnabled !== false;

    const restoAutoPrintKotToggle = document.getElementById('settings-resto-auto-print-kot');
    if (restoAutoPrintKotToggle) restoAutoPrintKotToggle.checked = !!config.autoPrintSelfOrderKot;

    const restoGstEnabledToggle = document.getElementById('settings-resto-gst-enabled');
    if (restoGstEnabledToggle) restoGstEnabledToggle.checked = config.gstEnabled !== false;

    const restoGstPercentInput = document.getElementById('settings-resto-gst-percent');
    if (restoGstPercentInput) restoGstPercentInput.value = config.gstPercent !== undefined ? config.gstPercent : 18;

    const restoServicePercentInput = document.getElementById('settings-resto-service-percent');
    if (restoServicePercentInput) restoServicePercentInput.value = config.serviceChargePercent !== undefined ? config.serviceChargePercent : 5;

    // Load UPI settings
    const upiInput = document.getElementById('settings-upi-id');
    if (upiInput) upiInput.value = config.upiId || '';

    const printUpiToggle = document.getElementById('settings-print-upi-qr');
    if (printUpiToggle) {
      printUpiToggle.checked = !!config.printUpiQr;
      // Update QR preview state
      if (config.printUpiQr && config.upiId) {
        this.toggleUpiPreview();
      }
    }


    // Show/Hide multi-branch controls depending on role
    const container = document.getElementById('settings-multi-branch-container');
    const toggle = document.getElementById('settings-multi-branch-toggle');
    
    if (container && toggle) {
      toggle.checked = !!config.multiBranchEnabled;
      if (user && user.role === 'Super Master Admin') {
        container.style.display = 'block';
      } else {
        container.style.display = 'none';
      }
    }

    // Show/Hide settings cards depending on user role permissions
    const branchesShopsPanel = document.getElementById('settings-branches-shops-panel');
    const staffPanel = document.getElementById('settings-staff-registry-panel');
    const tablesPanel = document.getElementById('settings-tables-registry-panel');
    const integrationsPanel = document.getElementById('settings-integrations-panel');

    const isSuper = user && user.role === 'Super Master Admin';
    const isAdmin = user && user.role === 'Branch Admin';

    // Show/Hide Branch & Shop Registry
    if (branchesShopsPanel) {
      if (isSuper) {
        branchesShopsPanel.style.display = 'block';
        this.renderSettingsRegistryTables();
      } else {
        branchesShopsPanel.style.display = 'none';
      }
    }

    // Show/Hide Staff Accounts Registry
    if (staffPanel) {
      if (isSuper) {
        staffPanel.style.display = 'block';
        this.renderSettingsUsersTable();
      } else {
        staffPanel.style.display = 'none';
      }
    }

    // Show/Hide Tables Registry (visible to Super Admin and normal Branch Admin)
    if (tablesPanel) {
      if (isSuper || isAdmin) {
        tablesPanel.style.display = 'block';
        this.renderSettingsTablesTable();
      } else {
        tablesPanel.style.display = 'none';
      }
    }

    // Show/Hide Integration Panels (Google Drive, Firebase connection, Test Harness)
    if (integrationsPanel) {
      if (isSuper) {
        integrationsPanel.style.display = 'flex';
      } else {
        integrationsPanel.style.display = 'none';
      }
    }

    // Load active Firebase config into textarea and render connection status badge
    const fbTextarea = document.getElementById('settings-firebase-config');
    const fbStatusContainer = document.getElementById('settings-firebase-status');
    
    if (fbTextarea) {
      const activeConfig = FirebaseConfigManager.getConfig();
      if (activeConfig) {
        fbTextarea.value = JSON.stringify(activeConfig, null, 2);
      } else {
        fbTextarea.value = '';
      }
    }

    if (fbStatusContainer) {
      if (dbService.firebaseActive) {
        const config = FirebaseConfigManager.getConfig() || {};
        fbStatusContainer.innerHTML = `
          <div class="status-pill success" style="display:inline-block; padding:6px 12px; font-weight:600; font-size:0.85rem; border-radius:6px; background:#10b981; color:#fff; margin-bottom:10px;">
            🟢 Linked to Firestore (Project: ${config.projectId})
          </div>
        `;
      } else if (dbService.connectionError) {
        fbStatusContainer.innerHTML = `
          <div class="status-pill danger" style="display:inline-block; padding:6px 12px; font-weight:600; font-size:0.85rem; border-radius:6px; background:#ef4444; color:#fff; margin-bottom:10px; line-height:1.3;">
            🔴 Firebase Link Error: ${dbService.connectionError}
          </div>
          <div style="font-size:0.75rem; color:var(--text-muted); line-height:1.4;">
            ⚠️ <b>Why this happens:</b> Check your Firebase console. Your Security Rules may be blocking anonymous reads/writes, or your API keys have expired. Ensure Firestore is set to "Test Mode" or allows public access.
          </div>
        `;
      } else {
        fbStatusContainer.innerHTML = `
          <div class="status-pill warning" style="display:inline-block; padding:6px 12px; font-weight:600; font-size:0.85rem; border-radius:6px; background:#f59e0b; color:#fff; margin-bottom:10px;">
            ⚪ Offline local Database (Fallback Demo Mode)
          </div>
        `;
      }
    }
  }

  async renderSettingsUsersTable() {
    const tBody = document.getElementById('settings-users-table-body');
    if (!tBody) return;

    const users = dbService.firebaseActive 
      ? await dbService.getCollection('users') 
      : dbService.localDb.users;

    const branches = dbService.firebaseActive 
      ? await dbService.getCollection('branches') 
      : dbService.localDb.branches;

    // Populate Branch dropdown in add-user form
    const branchSelect = document.getElementById('new-user-branch-select');
    if (branchSelect) {
      branchSelect.innerHTML = branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    }

    // Filter out Viki from the displayed staff table
    const filteredUsers = users.filter(u => u.id !== 'u_viki' && u.username.toLowerCase() !== 'viki');

    tBody.innerHTML = filteredUsers.map(u => {
      const branch = branches.find(b => b.id === u.branchId);
      const branchName = branch ? branch.name : (u.branchId || '—');
      return `
      <tr>
        <td><b>${u.name}</b></td>
        <td>${u.username}</td>
        <td><span class="role-tag ${u.role === 'Super Master Admin' ? 'super-admin' : (u.role === 'Branch Admin' ? 'admin' : (u.role === 'Waiter' ? 'waiter' : (u.role === 'Kitchen Staff' ? 'kitchen' : 'cashier')))}">${u.role}</span></td>
        <td><span style="font-size:0.78rem; color:var(--text-muted);">${branchName}</span></td>
        <td><code>${u.pin}</code></td>
        <td style="text-align:right;">
          <button class="clickable" style="background:transparent; color:var(--primary); margin-right:10px;" onclick="window.appController.editUser('${u.id}')">
            <i class="material-icons" style="font-size:16px;">edit</i>
          </button>
          <button class="cart-item-delete clickable" onclick="window.appController.deleteUser('${u.id}')">
            <i class="material-icons" style="font-size:16px;">delete</i>
          </button>
        </td>
      </tr>
    `}).join('');
  }


  async renderSettingsTablesTable() {
    const tBody = document.getElementById('settings-tables-table-body');
    if (!tBody) return;

    const tables = dbService.firebaseActive 
      ? await dbService.getCollection('tables') 
      : dbService.localDb.tables;

    tBody.innerHTML = tables.map(t => `
      <tr>
        <td><b>${t.name}</b></td>
        <td>${t.floor}</td>
        <td>${t.capacity} Pax</td>
        <td><span class="status-pill info" style="font-size:0.65rem; padding:2px 6px;">${t.shape}</span></td>
        <td style="text-align:right;">
          <button class="clickable" style="background:transparent; color:var(--primary); margin-right:12px; border:none; vertical-align:middle;" onclick="window.appController.showTableQRCode('${t.id}', '${t.name}')" title="Table QR Code">
            <i class="material-icons" style="font-size:18px;">qr_code_2</i>
          </button>
          <button class="cart-item-delete clickable" onclick="window.appController.deleteTable('${t.id}')" style="vertical-align:middle;">
            <i class="material-icons" style="font-size:16px;">delete</i>
          </button>
        </td>
      </tr>
    `).join('');
  }

  async renderSettingsProductsTable() {
    const tBody = document.getElementById('settings-products-table-body');
    const categorySelector = document.getElementById('new-product-category-select');
    if (!tBody || !categorySelector) return;

    const products = dbService.firebaseActive 
      ? await dbService.getCollection('products') 
      : dbService.localDb.products;

    const categories = dbService.firebaseActive 
      ? await dbService.getCollection('categories') 
      : dbService.localDb.categories;

    // Populate category dropdown selector options
    categorySelector.innerHTML = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

    tBody.innerHTML = products.map(p => {
      const cat = categories.find(c => c.id === p.categoryId);
      return `
        <tr>
          <td><b>${p.name}</b></td>
          <td><span class="role-tag" style="background:var(--border-color); color:var(--text-color);">${cat ? cat.name : 'Unknown'}</span></td>
          <td><b>${this.getCurrencySymbol()}${parseFloat(p.price).toFixed(2)}</b></td>
          <td><code>${p.barcode || 'N/A'}</code></td>
          <td>
            <span class="status-pill ${p.stock <= p.minStock ? 'danger' : 'success'}" style="font-size:0.75rem; padding:2px 6px;">
              ${p.stock} units
            </span>
          </td>
          <td style="text-align:right;">
            <button class="clickable" style="background:transparent; color:var(--primary); margin-right:10px;" onclick="window.appController.editProduct('${p.id}')">
              <i class="material-icons" style="font-size:16px;">edit</i>
            </button>
            <button class="cart-item-delete clickable" onclick="window.appController.deleteProduct('${p.id}')">
              <i class="material-icons" style="font-size:16px;">delete</i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  async renderSettingsCategoriesTable() {
    const tBody = document.getElementById('settings-categories-table-body');
    if (!tBody) return;

    const categories = dbService.firebaseActive 
      ? await dbService.getCollection('categories') 
      : dbService.localDb.categories;

    tBody.innerHTML = categories.map(c => `
      <tr>
        <td style="padding:10px 14px;">
          <i class="material-icons" style="font-size:16px; vertical-align:middle; margin-right:6px; color:var(--primary);">${c.icon || 'category'}</i>
          <b>${c.name}</b>
        </td>
        <td style="padding:10px 14px;"><code>${c.icon || 'category'}</code></td>
        <td style="text-align:right; padding:10px 14px;">
          <button class="clickable" style="background:transparent; color:var(--primary); margin-right:10px;" onclick="window.appController.editCategory('${c.id}')">
            <i class="material-icons" style="font-size:16px;">edit</i>
          </button>
          <button class="cart-item-delete clickable" onclick="window.appController.deleteCategory('${c.id}')">
            <i class="material-icons" style="font-size:16px;">delete</i>
          </button>
        </td>
      </tr>
    `).join('');
  }

  async renderReportsPreview() {
    const output = document.getElementById('reports-output-view');
    if (!output) return;

    const reportType = document.getElementById('report-filter-type').value;
    const tableFilter = document.getElementById('report-table-selector')?.value || 'all';

    const sales = reportsController.sales || [];
    const expenses = reportsController.expenses || [];
    const currency = this.getCurrencySymbol();

    // Populate and toggle report table selector dropdown
    const filterContainer = document.getElementById('report-table-filter-container');
    if (filterContainer) {
      filterContainer.style.display = reportType === 'table_wise' ? 'block' : 'none';
      
      const selector = document.getElementById('report-table-selector');
      if (selector && (selector.innerHTML.trim() === '' || selector.children.length <= 1)) {
        const tables = dbService.firebaseActive 
          ? await dbService.getCollection('tables') 
          : dbService.localDb.tables;
        selector.innerHTML = `<option value="all">All Tables</option>` + 
          tables.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
      }
    }

    let filteredSales = [...sales];
    if (reportType === 'table_wise') {
      if (tableFilter !== 'all') {
        filteredSales = sales.filter(s => s.tableId === tableFilter);
      }
    } else if (reportType === 'walk_in') {
      filteredSales = sales.filter(s => s.orderType === 'Takeaway' || !s.tableId);
    }

    if (reportType === 'sales' || reportType === 'table_wise' || reportType === 'walk_in') {
      // Render Sales Table with Action Buttons
      output.innerHTML = `
        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Invoice No</th>
                <th>Date / Time</th>
                <th>Type</th>
                <th>Table</th>
                <th>Payment Mode</th>
                <th>Total Amount</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${filteredSales.length === 0 ? `
                <tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:30px;">No matching sales invoices found.</td></tr>
              ` : filteredSales.map(s => `
                <tr>
                  <td><b>${s.orderNum}</b></td>
                  <td>${s.date} ${s.time || ''}</td>
                  <td><span class="role-tag">${s.orderType}</span></td>
                  <td><b>${s.tableName || 'Walk-in'}</b></td>
                  <td><span class="status-pill info" style="font-size:0.75rem; padding:2px 6px;">${s.paymentMethod}</span></td>
                  <td><b>${currency}${parseFloat(s.grandTotal).toFixed(2)}</b></td>
                  <td style="text-align:right;">
                    <button class="clickable" style="background:transparent; color:var(--primary); margin-right:12px; border:none;" onclick="window.appController.editReportOrder('${s.id}')" title="Reopen & Edit Order">
                      <i class="material-icons" style="font-size:18px; vertical-align:middle;">edit</i>
                    </button>
                    <button class="clickable" style="background:transparent; color:#10b981; border:none;" onclick="window.appController.reprintReportOrder('${s.id}')" title="Reprint Thermal Invoice">
                      <i class="material-icons" style="font-size:18px; vertical-align:middle;">print</i>
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (reportType === 'gst') {
      // Render GST Tax audit table
      output.innerHTML = `
        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Invoice No</th>
                <th>Date</th>
                <th>Subtotal</th>
                <th>GST Rate</th>
                <th>GST Collected</th>
                <th>Grand Total</th>
              </tr>
            </thead>
            <tbody>
              ${sales.length === 0 ? `
                <tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:30px;">No sales transactions found.</td></tr>
              ` : sales.map(s => {
                const sub = parseFloat(s.subtotal || 0);
                const gst = parseFloat(s.gstTax || 0);
                const rate = s.gstRate !== undefined ? s.gstRate : 18;
                return `
                  <tr>
                    <td><b>${s.orderNum}</b></td>
                    <td>${s.date}</td>
                    <td>${currency}${sub.toFixed(2)}</td>
                    <td>${rate}%</td>
                    <td style="color:#10b981; font-weight:700;">${currency}${gst.toFixed(2)}</td>
                    <td><b>${currency}${parseFloat(s.grandTotal).toFixed(2)}</b></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (reportType === 'expenses') {
      // Render Expense list
      output.innerHTML = `
        <div class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Description</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              ${expenses.length === 0 ? `
                <tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:30px;">No expense statements found.</td></tr>
              ` : expenses.map(e => `
                <tr>
                  <td><b>${e.category}</b></td>
                  <td>${e.description || 'N/A'}</td>
                  <td>${e.date}</td>
                  <td style="color:var(--state-occupied); font-weight:700;">${currency}${parseFloat(e.amount).toFixed(2)}</td>
                  <td><code>${e.reference || 'N/A'}</code></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  async renderSettingsRegistryTables() {
    const branchBody = document.getElementById('settings-branches-table-body');
    const shopBody = document.getElementById('settings-shops-table-body');
    const branchSelector = document.getElementById('new-shop-branch-select');

    if (!branchBody || !shopBody || !branchSelector) return;

    const branches = dbService.firebaseActive 
      ? await dbService.getCollection('branches') 
      : dbService.localDb.branches;

    const shops = dbService.firebaseActive 
      ? await dbService.getCollection('shops') 
      : dbService.localDb.shops;

    // Render Branches
    branchBody.innerHTML = branches.map(b => `
      <tr>
        <td><b>${b.name}</b></td>
        <td>${b.location || 'N/A'}</td>
        <td style="text-align:right;">
          <button class="cart-item-delete clickable" onclick="window.appController.deleteBranch('${b.id}')">
            <i class="material-icons" style="font-size:16px;">delete</i>
          </button>
        </td>
      </tr>
    `).join('');

    // Populate Shop Add selector
    branchSelector.innerHTML = branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('');

    // Render Shops
    shopBody.innerHTML = shops.map(s => {
      const branch = branches.find(b => b.id === s.branchId);
      return `
        <tr>
          <td><b>${s.name}</b></td>
          <td>${branch ? branch.name : 'Unknown'}</td>
          <td><span class="status-pill info" style="font-size:0.65rem; padding:2px 6px;">${s.type}</span></td>
          <td style="text-align:right;">
            <button class="cart-item-delete clickable" onclick="window.appController.deleteShop('${s.id}')">
              <i class="material-icons" style="font-size:16px;">delete</i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // --- POS CART RENDERS ---
  async initPOSPanel() {
    // Populate menus categories
    const categories = dbService.firebaseActive 
      ? await dbService.getCollection('categories') 
      : dbService.localDb.categories;
    const catContainer = document.getElementById('pos-categories-list');
    if (catContainer) {
      catContainer.innerHTML = `<button class="category-chip active clickable" data-category-id="all">All Items</button>` + 
        categories.map(c => `<button class="category-chip clickable" data-category-id="${c.id}">${c.name}</button>`).join('');
    }

    // Populate POS tables selector dropdown
    const tableSelector = document.getElementById('pos-table-selector');
    if (tableSelector) {
      const tables = dbService.firebaseActive 
        ? await dbService.getCollection('tables') 
        : dbService.localDb.tables;
      const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      tableSelector.innerHTML = `<option value="">Select Table</option>` + 
        sorted.map(t => `<option value="${t.id}">${t.name} (${t.floor})</option>`).join('');
      

    }

    this.renderProductsGrid('all');
    this.renderCartView();
  }

  renderProductsGrid(categoryId) {
    const products = this.products || dbService.localDb.products || [];
    const grid = document.getElementById('pos-products-grid');
    if (!grid) return;

    let filtered = products;
    if (categoryId !== 'all') {
      filtered = products.filter(p => p.categoryId === categoryId);
    }

    const searchInput = document.getElementById('pos-search-input');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (query) {
      filtered = filtered.filter(p => 
        p.name.toLowerCase().includes(query) || 
        (p.barcode && p.barcode.toLowerCase().includes(query))
      );
    }

    grid.innerHTML = filtered.map(p => {
      const isLow = p.stock <= p.minStock;
      return `
        <div class="product-card glass-panel clickable" data-product-id="${p.id}">
          <div class="product-card-info">
            <span class="product-name">${p.name}</span>
            <span class="product-price">${this.getCurrencySymbol()}${p.price.toFixed(2)}</span>
          </div>
          <span class="product-stock-tag ${isLow ? 'low' : ''}">Stock: ${p.stock}</span>
        </div>
      `;
    }).join('');
  }

  handlePOSSearch(e) {
    const activeCat = document.querySelector('.category-chip.active');
    const catId = activeCat ? activeCat.getAttribute('data-category-id') : 'all';
    
    const searchInput = document.getElementById('pos-search-input');
    const query = searchInput ? searchInput.value.trim() : '';

    if (query) {
      const products = this.products || dbService.localDb.products || [];
      const match = products.find(p => p.barcode === query);
      if (match) {
        posController.addToCart(match, 1);
        this.showToast('Barcode Scanned', `${match.name} added to cart`, 'success');
        if (searchInput) searchInput.value = '';
        this.renderProductsGrid(catId);
        return;
      }
    }

    this.renderProductsGrid(catId);
  }

  renderCartView() {
    const cartList = document.getElementById('pos-cart-items');
    if (!cartList) return;

    // Show/Hide active dining table selector dropdown in Fast POS
    const orderTypeSelect = document.getElementById('pos-order-type');
    const tableSelector = document.getElementById('pos-table-selector');
    
    if (orderTypeSelect && tableSelector) {
      const isDineIn = orderTypeSelect.value === 'Dine In';
      tableSelector.style.display = isDineIn ? 'block' : 'none';
      tableSelector.value = posController.selectedTable ? posController.selectedTable.id : '';
    }

    // Synchronize customer mobile and name inputs
    const mobileInput = document.getElementById('pos-customer-mobile');
    const nameInput = document.getElementById('pos-customer-name');
    if (mobileInput && nameInput) {
      mobileInput.value = posController.selectedCustomer ? posController.selectedCustomer.phone : '';
      nameInput.value = posController.selectedCustomer ? posController.selectedCustomer.name : '';
    }

    if (posController.cart.length === 0) {
      cartList.innerHTML = `<div style="text-align:center; padding: 40px 0; color:var(--text-muted);">Cart is empty</div>`;
    } else {
      cartList.innerHTML = posController.cart.map(item => `
        <div class="cart-item">
          <div class="cart-item-details">
            <span class="cart-item-title">${item.product.name}</span>
            <span class="cart-item-price">${this.getCurrencySymbol()}${item.product.price.toFixed(2)}</span>
          </div>
          <div class="cart-item-controls">
            <button class="qty-btn clickable" onclick="window.posController.updateQty('${item.product.id}', '${item.notes}', -1)">-</button>
            <span class="cart-item-qty">${item.qty}</span>
            <button class="qty-btn clickable" onclick="window.posController.updateQty('${item.product.id}', '${item.notes}', 1)">+</button>
          </div>
          <div class="cart-item-total">${this.getCurrencySymbol()}${(item.product.price * item.qty).toFixed(2)}</div>
          <button class="cart-item-delete clickable" onclick="window.posController.removeFromCart('${item.product.id}', '${item.notes}')">
            <i class="material-icons">delete</i>
          </button>
        </div>
      `).join('');
    }

    // Calculations labels update
    const settings = settingsController.activeSettings || {};
    const gstEnabled = settings.gstEnabled !== false;
    const gstPercent = parseFloat(settings.gstPercent !== undefined ? settings.gstPercent : 18);
    const servicePercent = parseFloat(settings.serviceChargePercent !== undefined ? settings.serviceChargePercent : 5);

    // Show/Hide GST Row and set rate labels
    const gstRow = document.getElementById('pos-gst-row');
    const gstLabel = document.getElementById('pos-gst-rate-label');
    if (gstRow) gstRow.style.display = gstEnabled ? 'flex' : 'none';
    if (gstLabel) gstLabel.textContent = gstPercent;

    const serviceLabel = document.getElementById('pos-service-rate-label');
    if (serviceLabel) serviceLabel.textContent = servicePercent;

    document.getElementById('pos-subtotal').textContent = `${this.getCurrencySymbol()}${posController.getSubtotal().toFixed(2)}`;
    document.getElementById('pos-gst').textContent = `${this.getCurrencySymbol()}${posController.getGST().toFixed(2)}`;
    document.getElementById('pos-service').textContent = `${this.getCurrencySymbol()}${posController.getServiceCharge().toFixed(2)}`;
    document.getElementById('pos-grandtotal').textContent = `${this.getCurrencySymbol()}${posController.getGrandTotal().toFixed(2)}`;
  }

  // --- TABLES RENDERING ---
  renderTablesView() {
    const floorsContainer = document.getElementById('tables-floor-tabs');
    if (!floorsContainer) return;

    const floors = tableController.getUniqueFloors();
    floorsContainer.innerHTML = floors.map(floor => `
      <button class="floor-tab clickable ${tableController.currentFloor === floor ? 'active' : ''}" onclick="window.appController.changeFloor('${floor}')">
        ${floor}
      </button>
    `).join('');

    this.renderTablesGrid(tableController.getTablesForCurrentFloor());
  }

  changeFloor(floorName) {
    tableController.setFloor(floorName);
    this.renderTablesView();
  }

  renderTablesGrid(tablesList) {
    const grid = document.getElementById('tables-grid-container');
    if (!grid) return;

    grid.innerHTML = tablesList.map(t => {
      const showAmt = t.amount > 0 ? `<span class="table-amount">${this.getCurrencySymbol()}${t.amount.toFixed(2)}</span>` : '';
      const waiter = t.waiterName ? `<span class="table-waiter">${t.waiterName}</span>` : '';
      return `
        <div class="table-card clickable ${t.shape} ${t.status}" onclick="window.appController.handleTableClick('${t.id}')">
          <span class="table-number">${t.name}</span>
          <span class="table-capacity">Pax: ${t.capacity}</span>
          ${showAmt}
          ${waiter}
        </div>
      `;
    }).join('');
  }

  handleTableClick(tableId) {
    const table = tableController.tables.find(t => t.id === tableId);
    if (!table) return;

    if (table.status === 'available') {
      // Prompt user to open table or set reservation
      posController.selectedTable = table;
      posController.currentOrderType = 'Dine In';
      this.switchView('pos');
      this.showToast('Table Assigned', `${table.name} selected for POS billing.`, 'info');
    } else {
      // Table occupied/billing options modal
      this.showTableActionsModal(table);
    }
  }

  async showTableActionsModal(table) {
    const modal = document.getElementById('table-actions-modal') || (() => {
      const m = document.createElement('div');
      m.id = 'table-actions-modal';
      m.className = 'modal-overlay';
      document.body.appendChild(m);
      return m;
    })();

    // Check if table has a pending guest order
    const pendingOrders = dbService.firebaseActive 
      ? await dbService.getCollection('pending_orders') 
      : dbService.localDb.pending_orders;
    
    const tableOrder = pendingOrders.find(o => o.tableId === table.id && o.status === 'pending');
    
    let guestOrderHtml = '';
    if (tableOrder) {
      guestOrderHtml = `
        <div style="border: 2px dashed var(--primary); padding: 12px; border-radius: 8px; margin-bottom: 12px; background: rgba(var(--primary-rgb), 0.1);">
          <span style="font-weight: 700; color: var(--primary); display:block; margin-bottom:6px;">⚠️ Guest Self-Order Pending Approval</span>
          <div style="font-size:0.75rem; max-height:100px; overflow-y:auto; margin-bottom:10px; line-height:1.4;">
            ${tableOrder.cart.map(item => `• ${item.product.name} x${item.qty} (${this.getCurrencySymbol()}${(item.product.price * item.qty).toFixed(2)})`).join('<br>')}
          </div>
          <div style="display:flex; gap:10px;">
            <button class="btn-primary clickable" style="padding:6px 12px; font-size:0.75rem;" onclick="window.appController.approveGuestOrder('${tableOrder.id}')">Approve & Print KOT</button>
            <button class="btn-danger clickable" style="padding:6px 12px; font-size:0.75rem;" onclick="window.appController.rejectGuestOrder('${tableOrder.id}')">Reject</button>
          </div>
        </div>
      `;
    }

    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>${table.name} Operations</h3>
          <button class="modal-close-btn clickable" onclick="document.getElementById('table-actions-modal').classList.remove('active')">&times;</button>
        </div>
        <div class="modal-body" style="display:flex; flex-direction:column; gap:12px;">
          ${guestOrderHtml}
          <p>Status: <span class="status-pill info">${table.status}</span></p>
          <p>Order Net: <b>${this.getCurrencySymbol()}${table.amount.toFixed(2)}</b></p>
          
          <button class="btn-primary clickable" onclick="window.appController.loadTableToPOS('${table.id}')">Add Items / POS Billing</button>
          <button class="btn-secondary clickable" onclick="window.appController.triggerTableTransfer('${table.id}')">Transfer to another Table</button>
          <button class="btn-secondary clickable" onclick="window.appController.triggerTableMerge('${table.id}')">Merge / Combine Tables</button>
          <button class="btn-secondary clickable" onclick="window.appController.triggerTableSplit('${table.id}')">Split Bill</button>
          <button class="btn-danger clickable" onclick="window.appController.releaseTableStatus('${table.id}')">Clear Table (Reset)</button>
        </div>
      </div>
    `;

    modal.classList.add('active');
  }

  async loadTableToPOS(tableId) {
    const table = tableController.tables.find(t => t.id === tableId);
    if (table) {
      posController.selectedTable = table;
      posController.currentOrderType = 'Dine In';

      // Load active running KOT bill items
      const items = await this.loadActiveTableOrder(tableId);
      posController.cart = items;
      posController.triggerCartUpdate();

      document.getElementById('table-actions-modal').classList.remove('active');
      this.switchView('pos');
    }
  }

  async handleSendKOT() {
    if (posController.cart.length === 0) {
      this.showToast('Empty Cart', 'Add items to the cart before sending to kitchen.', 'warning');
      return;
    }

    const tableName = posController.selectedTable ? posController.selectedTable.name : null;
    const orderType = posController.currentOrderType;

    // Warn if Dine-In but no table selected
    if (orderType === 'Dine In' && !posController.selectedTable) {
      this.showToast('No Table Selected', 'Please select a table before sending KOT.', 'warning');
      return;
    }

    // Send KOT to kitchen
    const kot = await posController.sendKOT();
    if (!kot) {
      this.showToast('KOT Failed', 'Could not send order to kitchen.', 'danger');
      return;
    }

    // Print KOT slip to browser print queue
    this.printKOTSlip(kot);

    // Success toast with table info
    const label = tableName ? `Table: ${tableName}` : `${orderType}`;
    this.showToast('KOT Sent ✅', `Order ${kot.orderNum} sent to kitchen — ${label}`, 'success');

    // Keep cart loaded so cashier can add more / checkout later
    // Cart is NOT cleared on KOT send — only on checkout
  }

  async sendToLocalPrinter(printerPath, htmlContent) {
    if (!printerPath) {
      console.log('No local printer path configured. Using browser print fallback.');
      return false;
    }
    try {
      const response = await fetch('http://localhost:9100/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printer: printerPath,
          content: htmlContent
        })
      });
      if (response.ok) {
        this.showToast('Printed Successfully 🖨️', `Document sent to print queue: "${printerPath}"`, 'success');
        return true;
      }
      return false;
    } catch (e) {
      console.warn(`Local print daemon at "${printerPath}" not responding. Falling back to browser print dialog.`, e);
      return false;
    }
  }

  async printKOTSlip(kot) {
    const printArea = document.getElementById('receipt-print-area') || (() => {
      const el = document.createElement('div');
      el.id = 'receipt-print-area';
      document.body.appendChild(el);
      return el;
    })();

    const rows = kot.items.map(i => `
      <tr>
        <td style="padding:3px 0; font-size:13px;"><b>${i.qty}x</b> ${i.name}</td>
        <td style="text-align:right; font-size:11px; color:#555;">${i.notes || ''}</td>
      </tr>
    `).join('');

    const htmlContent = `
      <div style="font-family:monospace; width:280px; padding:12px; border:2px dashed #000; margin:0 auto;">
        <div style="text-align:center; font-size:18px; font-weight:bold; letter-spacing:2px; margin-bottom:6px;">🍽 KOT</div>
        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:4px;">
          <span><b>Order:</b> ${kot.orderNum}</span>
          <span>${kot.time}</span>
        </div>
        <div style="font-size:13px; margin-bottom:6px;">
          <b>Table:</b> <span style="font-size:16px; font-weight:900;">${kot.tableName}</span>
        </div>
        <div style="font-size:11px; margin-bottom:8px;"><b>Waiter:</b> ${kot.waiterName}</div>
        <hr style="border-top:1px dashed #000;">
        <table style="width:100%; border-collapse:collapse;">
          ${rows}
        </table>
        <hr style="border-top:1px dashed #000; margin-top:8px;">
        <div style="text-align:center; font-size:10px; margin-top:6px;">-- Kitchen Copy --</div>
      </div>
    `;

    printArea.innerHTML = htmlContent;

    const config = settingsController.activeSettings || {};
    const path = config.kotPrinterPath;
    let routed = false;

    if (path) {
      routed = await this.sendToLocalPrinter(path, htmlContent);
    }

    if (!routed) {
      window.print();
    }
  }

  async releaseTableStatus(tableId) {
    await tableController.releaseTable(tableId);
    document.getElementById('table-actions-modal').classList.remove('active');
    this.showToast('Table Cleared', 'Table status reset to available.', 'success');
  }


  async triggerTableTransfer(sourceId) {
    const tables = tableController.tables.filter(t => t.id !== sourceId && t.status === 'available');
    const options = tables.map(t => `<option value="${t.id}">${t.name} (${t.floor})</option>`).join('');
    
    const targetId = prompt(`Select target table:\n${tables.map(t => `${t.name} - ${t.id}`).join('\n')}`);
    if (targetId) {
      const res = await tableController.transferTable(sourceId, targetId);
      if (res) {
        this.showToast('Transferred', 'Table order transferred successfully.', 'success');
      } else {
        this.showToast('Failed', 'Table transfer failed.', 'danger');
      }
    }
    document.getElementById('table-actions-modal').classList.remove('active');
  }

  async triggerTableMerge(sourceId) {
    const targetId = prompt('Enter target Table ID to merge with:');
    if (targetId) {
      const res = await tableController.mergeTables(sourceId, targetId);
      if (res) {
        this.showToast('Merged', 'Table orders merged successfully.', 'success');
      } else {
        this.showToast('Failed', 'Merge failed.', 'danger');
      }
    }
    document.getElementById('table-actions-modal').classList.remove('active');
  }

  async triggerTableSplit(tableId) {
    const amt = parseFloat(prompt('Enter amount to split off for payment:'));
    if (amt > 0) {
      const invoice = await tableController.splitTable(tableId, amt);
      if (invoice) {
        this.showToast('Split Successful', `Split invoice ${invoice.orderNum} generated.`, 'success');
      } else {
        this.showToast('Split Failed', 'Invalid split amount.', 'danger');
      }
    }
    document.getElementById('table-actions-modal').classList.remove('active');
  }

  // --- KITCHEN DISPLAY SCREEN (KDS) ---
  renderKitchenScreen(tickets) {
    const container = document.getElementById('kds-tickets-container');
    if (!container) return;

    if (tickets.length === 0) {
      container.innerHTML = `<div style="grid-column: span 3; text-align:center; padding:50px; color:var(--text-muted);">No active orders preparing.</div>`;
      return;
    }

    container.innerHTML = tickets.map(t => {
      const itemsList = t.items.map((item, idx) => `
        <div class="kds-item ${item.status === 'completed' ? 'completed' : ''}" onclick="window.kdsController.toggleItemCompletion('${t.id}', ${idx})">
          <div class="kds-item-qty-name">
            <span class="kds-item-qty">${item.qty}</span>
            <span class="kds-item-name">${item.name}</span>
          </div>
          ${item.priority === 'high' ? `<span class="kds-item-priority high">High</span>` : ''}
        </div>
      `).join('');

      let actionBtn = '';
      if (t.status === 'pending') {
        actionBtn = `
          <button class="btn-primary clickable" onclick="window.kdsController.startCooking('${t.id}')">Start Cooking</button>
          <button class="btn-danger clickable" style="flex: 0 0 40px; padding: 0; display: flex; align-items: center; justify-content: center; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #ef4444;" title="Cancel Order" onclick="window.kdsController.cancelKOT('${t.id}')">
            <i class="material-icons" style="font-size:18px;">close</i>
          </button>
        `;
      } else if (t.status === 'cooking') {
        actionBtn = `
          <button class="btn-primary clickable" style="background:var(--state-ready)" onclick="window.kdsController.markReady('${t.id}')">Mark Ready</button>
          <button class="btn-danger clickable" style="flex: 0 0 40px; padding: 0; display: flex; align-items: center; justify-content: center; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #ef4444;" title="Cancel Order" onclick="window.kdsController.cancelKOT('${t.id}')">
            <i class="material-icons" style="font-size:18px;">close</i>
          </button>
        `;
      } else if (t.status === 'ready') {
        actionBtn = `
          <button class="btn-secondary clickable" onclick="window.kdsController.markDelivered('${t.id}')">Served</button>
          <button class="btn-danger clickable" style="flex: 0 0 40px; padding: 0; display: flex; align-items: center; justify-content: center; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #ef4444;" title="Cancel Order" onclick="window.kdsController.cancelKOT('${t.id}')">
            <i class="material-icons" style="font-size:18px;">close</i>
          </button>
        `;
      }

      const elapsed = kdsController.getElapsedMinutes(t.timestamp);
      const timerClass = elapsed > 20 ? 'critical' : (elapsed > 10 ? 'warning' : '');

      return `
        <div class="kds-card glass-panel ${t.status}">
          <div class="kds-card-header">
            <div class="kds-card-title-row">
              <span class="kds-order-num">${t.orderNum}</span>
              <span class="kds-timer ${timerClass}">${elapsed}m ago</span>
            </div>
            <div class="kds-order-meta">
              <span>Table: <b>${t.tableName}</b></span>
              <span>Type: <b>${t.orderType}</b></span>
            </div>
          </div>
          <div class="kds-items-list">
            ${itemsList}
          </div>
          <div class="kds-card-footer">
            ${actionBtn}
          </div>
        </div>
      `;
    }).join('');
  }

  // --- ANALYTICS DASHBOARD RENDERING ---
  renderDashboardAnalytics() {
    const stats = reportsController.getDashboardStats();
    
    // Fill KPI numbers
    const revTodayEl = document.getElementById('dash-revenue-today');
    if (revTodayEl) revTodayEl.textContent = `${this.getCurrencySymbol()}${stats.todayRevenue.toFixed(2)}`;
    
    const ordTodayEl = document.getElementById('dash-orders-today');
    if (ordTodayEl) ordTodayEl.textContent = stats.todayOrders;
    
    const expEl = document.getElementById('dash-expenses');
    if (expEl) expEl.textContent = `${this.getCurrencySymbol()}${stats.totalExpenses.toFixed(2)}`;
    
    const profitEl = document.getElementById('dash-profit');
    if (profitEl) profitEl.textContent = `${this.getCurrencySymbol()}${stats.netProfit.toFixed(2)}`;

    // Build pure CSS SVG dynamic bar charts
    this.renderTopSellingCharts();
  }

  renderTopSellingCharts() {
    const topItems = reportsController.getTopSellingItems(5);
    const container = document.getElementById('dashboard-top-items-chart');
    if (!container) return;

    if (topItems.length === 0) {
      container.innerHTML = `<div style="text-align:center; width:100%; color:var(--text-muted);">No sales log data available yet.</div>`;
      return;
    }

    const maxQty = Math.max(...topItems.map(i => i.qty));
    container.innerHTML = topItems.map(item => {
      const heightPercent = maxQty > 0 ? (item.qty / maxQty) * 100 : 0;
      return `
        <div class="chart-bar-wrapper">
          <span style="font-size:0.8rem; font-weight:700;">${item.qty}</span>
          <div class="chart-bar" style="height: ${heightPercent}%;"></div>
          <span class="chart-label">${item.name}</span>
        </div>
      `;
    }).join('');
  }

  // --- TABULAR LOGS RENDERING (Inventory, Customers, Notifications) ---
  renderInventoryTable() {
    const tBody = document.getElementById('inventory-table-body');
    if (!tBody) return;

    tBody.innerHTML = inventoryController.rawMaterials.map(item => `
      <tr>
        <td><b>${item.name}</b></td>
        <td>${item.stock} ${item.unit}</td>
        <td>${item.supplier}</td>
        <td>${item.expiryDate || 'N/A'}</td>
        <td>
          <button class="qty-btn clickable" style="display:inline-flex;" onclick="window.inventoryController.adjustStock('${item.id}', 5, 'Restock')">+</button>
          <button class="qty-btn clickable" style="display:inline-flex;" onclick="window.inventoryController.adjustStock('${item.id}', -5, 'Cooking Use')">-</button>
        </td>
      </tr>
    `).join('');
  }

  renderCustomersTable() {
    const tBody = document.getElementById('customers-table-body');
    if (!tBody) return;

    tBody.innerHTML = customersController.customers.map(c => `
      <tr>
        <td><b>${c.name}</b></td>
        <td>${c.phone}</td>
        <td>${c.points}</td>
        <td>${this.getCurrencySymbol()}${c.wallet.toFixed(2)}</td>
        <td>${this.getCurrencySymbol()}${c.creditLimit.toFixed(2)}</td>
        <td>
          <button class="btn-secondary clickable" style="padding:4px 8px; font-size:0.75rem;" onclick="window.customersController.rechargeWallet('${c.id}', 50)">+50 Wallet</button>
        </td>
      </tr>
    `).join('');
  }

  populateCustomersDropdown() {
    const selects = [document.getElementById('pos-customer-selector')];
    selects.forEach(select => {
      if (select) {
        select.innerHTML = `<option value="">Walk-In Guest</option>` + 
          `<option value="ADD_NEW">➕ Add New Customer</option>` +
          customersController.customers.map(c => `<option value="${c.id}">${c.name} (${c.phone})</option>`).join('');
        
        select.onchange = (e) => {
          if (e.target.value === 'ADD_NEW') {
            select.value = posController.selectedCustomer ? posController.selectedCustomer.id : '';
            window.appController.showAddCustomerModal();
          } else {
            const cust = customersController.customers.find(c => c.id === e.target.value);
            posController.selectedCustomer = cust || null;
          }
        };
      }
    });
  }

  renderNotificationsList(logs) {
    const list = document.getElementById('header-notifications-list');
    const badge = document.getElementById('notifications-count-badge');
    if (!list) return;

    const unread = logs.filter(l => !l.read);
    this.notificationsCount = unread.length;

    if (badge) {
      badge.textContent = this.notificationsCount;
      badge.style.display = this.notificationsCount > 0 ? 'block' : 'none';
    }

    if (logs.length === 0) {
      list.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:0.8rem;">No alerts.</div>`;
      return;
    }

    list.innerHTML = logs.slice(0, 5).map(l => `
      <div style="padding: 10px; border-bottom:1px solid var(--border-color); font-size:0.8rem;">
        <div style="font-weight:600; display:flex; justify-content:space-between;">
          <span>${l.title}</span>
          <span style="color:var(--text-muted); font-size:0.7rem;">${l.time}</span>
        </div>
        <p style="color:var(--text-muted); font-size:0.75rem; margin-top:2px;">${l.message}</p>
      </div>
    `).join('');

    // Check for new notification to show a toast alert in real-time!
    if (logs.length > 0) {
      const latest = logs[logs.length - 1];
      if (latest.id !== this.lastNotificationId) {
        this.lastNotificationId = latest.id;
        if (this.initializedNotifications) {
          this.showToast(latest.title, latest.message, latest.type || 'info');
        }
      }
    }
    this.initializedNotifications = true;
  }

  // --- POPUP TOAST SYSTEM ---
  showToast(title, message, type = 'info') {
    const container = document.getElementById('app-toast-container') || (() => {
      const c = document.createElement('div');
      c.id = 'app-toast-container';
      c.className = 'toast-container';
      document.body.appendChild(c);
      return c;
    })();

    const icons = {
      success: 'check_circle',
      warning: 'warning',
      danger: 'error',
      info: 'info'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <i class="material-icons">${icons[type]}</i>
      <div style="display:flex; flex-direction:column;">
        <span style="font-weight:700; font-size:0.85rem;">${title}</span>
        <span style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${message}</span>
      </div>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // --- CUSTOMER SELF-ORDERING MODULE ---
  async initCustomerView() {
    // Reset to Table Select screen
    document.getElementById('customer-table-select-screen').style.display = 'block';
    document.getElementById('customer-ordering-screen').style.display = 'none';

    // Populate Table Select Dropdown
    const select = document.getElementById('customer-select-table-id');
    if (select) {
      const tables = dbService.firebaseActive 
        ? await dbService.getCollection('tables') 
        : dbService.localDb.tables;
      
      // Sorted list
      const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      select.innerHTML = sorted.map(t => `<option value="${t.id}">${t.name} (${t.floor})</option>`).join('');
    }

    // Populate category chips in customer menu
    const categories = dbService.firebaseActive 
      ? await dbService.getCollection('categories') 
      : dbService.localDb.categories;
    const catContainer = document.getElementById('customer-categories-list');
    if (catContainer) {
      catContainer.innerHTML = `<button class="category-chip active clickable" data-customer-cat-id="all">All Items</button>` + 
        categories.map(c => `<button class="category-chip clickable" data-customer-cat-id="${c.id}">${c.name}</button>`).join('');
      
      // Bind click handlers to customer category chips
      catContainer.querySelectorAll('.category-chip').forEach(btn => {
        btn.addEventListener('click', (e) => {
          catContainer.querySelectorAll('.category-chip').forEach(b => b.classList.remove('active'));
          e.target.classList.add('active');
          const catId = e.target.getAttribute('data-customer-cat-id');
          this.renderCustomerProductsGrid(catId);
        });
      });
    }
  }

  async startCustomerOrdering() {
    const select = document.getElementById('customer-select-table-id');
    if (!select || !select.value) return;

    this.customerTableId = select.value;
    const tables = dbService.firebaseActive 
      ? await dbService.getCollection('tables') 
      : dbService.localDb.tables;
    const table = tables.find(t => t.id === this.customerTableId);
    this.customerTableName = table ? `${table.name}` : 'Guest Table';

    // Update screen headers
    document.getElementById('customer-active-table-name').textContent = this.customerTableName;

    // Toggle screens
    document.getElementById('customer-table-select-screen').style.display = 'none';
    document.getElementById('customer-ordering-screen').style.display = 'block';

    // Initialize cart & grid
    this.customerCart = [];
    this.renderCustomerCart();
    this.renderCustomerProductsGrid('all');
  }

  exitCustomerOrdering() {
    if (this.customerCart.length > 0 && !confirm('Are you sure you want to discard your current order?')) return;
    this.initCustomerView();
  }

  async renderCustomerProductsGrid(categoryId) {
    const grid = document.getElementById('customer-products-grid');
    if (!grid) return;

    const products = dbService.firebaseActive 
      ? await dbService.getCollection('products') 
      : dbService.localDb.products;

    let filtered = products;
    if (categoryId !== 'all') {
      filtered = products.filter(p => p.categoryId === categoryId);
    }

    grid.innerHTML = filtered.map(p => `
      <div class="product-card glass-panel" style="display:flex; flex-direction:column; justify-content:space-between; padding:15px; border-radius:12px; border:1px solid var(--border-color);">
        <div>
          <span class="product-name" style="font-weight:700; font-size:0.95rem; display:block; margin-bottom:4px;">${p.name}</span>
          <span style="font-size:0.75rem; color:var(--text-muted); display:block; margin-bottom:8px; line-height:1.2;">${p.description || 'Tasty house special item.'}</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
          <span class="product-price" style="font-weight:800; color:var(--primary); font-size:0.95rem;">${this.getCurrencySymbol()}${p.price.toFixed(2)}</span>
          <button class="btn-primary clickable" style="padding:6px 12px; font-size:0.75rem; border-radius:6px;" onclick="window.appController.addCustomerCart('${p.id}')">
            Add
          </button>
        </div>
      </div>
    `).join('');
  }

  async addCustomerCart(productId) {
    const products = dbService.firebaseActive 
      ? await dbService.getCollection('products') 
      : dbService.localDb.products;
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const existing = this.customerCart.find(i => i.product.id === productId);
    if (existing) {
      existing.qty++;
    } else {
      this.customerCart.push({ product, qty: 1 });
    }

    this.renderCustomerCart();
    this.showToast('Added to Cart', `${product.name} added to your order list.`, 'success');
  }

  updateCustomerCartQty(productId, delta) {
    const existing = this.customerCart.find(i => i.product.id === productId);
    if (existing) {
      existing.qty += delta;
      if (existing.qty <= 0) {
        this.customerCart = this.customerCart.filter(i => i.product.id !== productId);
      }
    }
    this.renderCustomerCart();
  }

  renderCustomerCart() {
    const cartList = document.getElementById('customer-cart-items');
    const totalEl = document.getElementById('customer-cart-total');
    if (!cartList || !totalEl) return;

    if (this.customerCart.length === 0) {
      cartList.innerHTML = `<div style="text-align:center; padding:30px 0; color:var(--text-muted); font-size:0.85rem;">Your order is empty</div>`;
      totalEl.textContent = `${this.getCurrencySymbol()}0.00`;
      return;
    }

    cartList.innerHTML = this.customerCart.map(item => `
      <div class="cart-item" style="padding:8px 0; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;">
        <div style="display:flex; flex-direction:column; gap:2px; max-width:60%;">
          <span style="font-weight:600; font-size:0.85rem;">${item.product.name}</span>
          <span style="font-size:0.75rem; color:var(--text-muted);">${this.getCurrencySymbol()}${item.product.price.toFixed(2)}</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="qty-btn clickable" onclick="window.appController.updateCustomerCartQty('${item.product.id}', -1)" style="padding: 2px 6px; font-size: 0.8rem;">-</button>
          <span style="font-size:0.85rem; font-weight:700; width:16px; text-align:center;">${item.qty}</span>
          <button class="qty-btn clickable" onclick="window.appController.updateCustomerCartQty('${item.product.id}', 1)" style="padding: 2px 6px; font-size: 0.8rem;">+</button>
        </div>
      </div>
    `).join('');

    const total = this.customerCart.reduce((sum, item) => sum + (item.product.price * item.qty), 0);
    totalEl.textContent = `${this.getCurrencySymbol()}${total.toFixed(2)}`;
  }

  async submitCustomerOrder() {
    if (this.customerCart.length === 0) {
      this.showToast('Empty Order', 'Please add items before placing your order.', 'warning');
      return;
    }

    const total = this.customerCart.reduce((sum, item) => sum + (item.product.price * item.qty), 0);
    const guestOrder = {
      id: 'pord_' + Date.now(),
      tableId: this.customerTableId,
      tableName: this.customerTableName,
      cart: [...this.customerCart],
      total: total,
      status: 'approved', // Approved automatically since KOT is direct
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now()
    };

    // Save Guest Order
    await dbService.addDoc('pending_orders', guestOrder);

    // Create KOT items
    const kotItems = this.customerCart.map(item => ({
      productId: item.product.id,
      name: item.product.name,
      qty: item.qty,
      notes: '',
      priority: 'normal',
      status: 'pending' // pending, cooking, completed
    }));

    // Create KOT
    const kot = {
      id: 'kot_' + Date.now(),
      orderNum: 'KOT-' + Math.floor(1000 + Math.random() * 9000),
      tableId: this.customerTableId || 'N/A',
      tableName: this.customerTableName || 'Takeaway/Delivery',
      orderType: 'Dine In',
      waiterName: 'Self-Order',
      time: new Date().toLocaleTimeString(),
      timestamp: Date.now(),
      items: kotItems,
      status: 'pending' // pending, ready, delivered
    };

    // Save KOT directly to kitchen collection to show in KDS immediately
    await dbService.addDoc('kitchen', kot);

    // Update Table status to occupied and increment its amount in tables collection
    if (this.customerTableId) {
      const tables = dbService.firebaseActive 
        ? await dbService.getCollection('tables') 
        : dbService.localDb.tables;
      const table = tables.find(t => t.id === this.customerTableId);
      const currentAmount = table ? (table.amount || 0) : 0;
      
      await dbService.updateDoc('tables', this.customerTableId, {
        status: 'occupied',
        amount: currentAmount + total,
        waiterName: 'Self-Order',
        orderId: kot.id
      });
    }

    const notif = {
      id: 'notif_' + Date.now(),
      title: 'New Table Order',
      message: `${guestOrder.tableName} placed a self-order of ${guestOrder.cart.length} items (${this.getCurrencySymbol()}${guestOrder.total.toFixed(2)}).`,
      time: new Date().toLocaleTimeString(),
      type: 'warning',
      read: false
    };
    await dbService.addDoc('notifications', notif);

    this.showToast('Order Placed', 'Your order was sent to the kitchen. Thank you!', 'success');
    
    // Clear and return
    this.customerCart = [];
    this.initCustomerView();
  }

  async approveGuestOrder(orderId) {
    const pendingOrders = dbService.firebaseActive 
      ? await dbService.getCollection('pending_orders') 
      : dbService.localDb.pending_orders;
    const order = pendingOrders.find(o => o.id === orderId);
    if (!order) return;

    // Load items into POS cart
    posController.cart = order.cart.map(item => ({
      product: item.product,
      qty: item.qty,
      notes: ''
    }));

    // Assign Table to POS
    const tables = dbService.firebaseActive 
      ? await dbService.getCollection('tables') 
      : dbService.localDb.tables;
    const table = tables.find(t => t.id === order.tableId);
    posController.selectedTable = table || null;
    posController.currentOrderType = 'Dine In';

    // Submit KOT
    const kot = await posController.sendKOT();
    if (kot) {
      // Mark as approved in DB
      if (dbService.firebaseActive) {
        await dbService.updateDoc('pending_orders', orderId, { status: 'approved' });
      } else {
        order.status = 'approved';
        dbService.saveLocalDb();
      }

      this.showToast('Order Approved', 'Guest order loaded and KOT printed to kitchen.', 'success');
      document.getElementById('table-actions-modal').classList.remove('active');
      this.switchView('pos'); // Open POS to allow editing/final checkout
    } else {
      this.showToast('Error', 'Failed to approve guest order.', 'danger');
    }
  }

  async rejectGuestOrder(orderId) {
    if (!confirm('Are you sure you want to reject this customer order?')) return;

    if (dbService.firebaseActive) {
      await dbService.updateDoc('pending_orders', orderId, { status: 'cancelled' });
    } else {
      const pendingOrders = dbService.localDb.pending_orders;
      const order = pendingOrders.find(o => o.id === orderId);
      if (order) order.status = 'cancelled';
      dbService.saveLocalDb();
    }

    this.showToast('Order Rejected', 'Customer self-order has been cancelled.', 'warning');
    document.getElementById('table-actions-modal').classList.remove('active');
  }

  async loadActiveTableOrder(tableId) {
    const products = dbService.firebaseActive 
      ? await dbService.getCollection('products') 
      : dbService.localDb.products;
    const tickets = dbService.firebaseActive 
      ? await dbService.getCollection('kitchen') 
      : dbService.localDb.kitchen;

    // Fetch KOTs that are associated with this table and are not delivered/archived yet
    const tableKOTs = tickets.filter(t => t.tableId === tableId && t.status !== 'delivered');
    
    if (tableKOTs.length > 0) {
      const mergedCart = [];
      tableKOTs.forEach(kot => {
        kot.items.forEach(item => {
          const prod = products.find(p => p.id === item.productId);
          const existing = mergedCart.find(c => c.product.id === item.productId && c.notes === item.notes);
          if (existing) {
            existing.qty += item.qty;
          } else {
            mergedCart.push({
              product: prod || { id: item.productId, name: item.name, price: 0 },
              qty: item.qty,
              notes: item.notes || ''
            });
          }
        });
      });
      return mergedCart;
    }
    return [];
  }
}

const appInstance = new AppController();
window.appController = appInstance;
window.posController = posController;
window.tableController = tableController;
window.kdsController = kdsController;
window.inventoryController = inventoryController;
window.customersController = customersController;
window.reportsController = reportsController;
window.settingsController = settingsController;
window.driveBackupService = driveBackupService;

document.addEventListener('DOMContentLoaded', () => {
  appInstance.start();
});
export default appInstance;

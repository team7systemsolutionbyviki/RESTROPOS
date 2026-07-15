import dbService from './db.js';

// Authentication & Authorization Service
class AuthService {
  constructor() {
    this.currentUser = null;
    this.permissions = {};
  }

  async init() {
    // Check if session exists
    const savedUser = sessionStorage.getItem('resto_pos_current_user');
    if (savedUser) {
      this.currentUser = JSON.parse(savedUser);
      await this.loadPermissions();
    }
  }

  async login(pin, username = '') {
    if (dbService.firebaseActive) {
      // In Firebase production mode, authenticate with Firebase Auth email/password,
      // and lookup custom claims or user roles in the 'users' collection.
      try {
        // Simple demonstration logic matching PIN using Firebase DB
        const users = await dbService.getCollection('users');
        const user = users.find(u => u.pin === pin || (username && u.username === username));
        if (user) {
          this.currentUser = user;
          sessionStorage.setItem('resto_pos_current_user', JSON.stringify(user));
          await this.loadPermissions();
          return { success: true, user };
        }
        return { success: false, error: 'Invalid PIN or credentials.' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    } else {
      // Demo Mode Auth
      const users = dbService.localDb.users;
      const user = users.find(u => u.pin === pin || (username && u.username.toLowerCase() === username.toLowerCase()));
      if (user) {
        this.currentUser = user;
        sessionStorage.setItem('resto_pos_current_user', JSON.stringify(user));
        await this.loadPermissions();
        return { success: true, user };
      }
      return { success: false, error: 'Invalid Credentials/PIN' };
    }
  }

  logout() {
    this.currentUser = null;
    this.permissions = {};
    sessionStorage.removeItem('resto_pos_current_user');
    window.location.reload();
  }

  async loadPermissions() {
    if (!this.currentUser) return;
    
    const roleName = this.currentUser.role;
    let rolesList = [];

    if (dbService.firebaseActive) {
      rolesList = await dbService.getCollection('roles');
    } else {
      rolesList = dbService.localDb.roles;
    }

    const roleDef = rolesList.find(r => r.role === roleName);
    this.permissions = roleDef ? roleDef.permissions : {};
  }

  hasPermission(permissionName) {
    // Super Master Admin overrides everything
    if (this.currentUser && this.currentUser.role === 'Super Master Admin') {
      return true;
    }
    return !!this.permissions[permissionName];
  }

  getCurrentUser() {
    return this.currentUser;
  }
}

const authInstance = new AuthService();
window.authService = authInstance;
export default authInstance;

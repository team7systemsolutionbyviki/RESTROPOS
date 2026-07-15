// Firebase Configuration & Initialization Manager
const FirebaseConfigManager = {
  // Key for local storage
  CONFIG_KEY: 'resto_pos_firebase_config',

  // Save config
  saveConfig(config) {
    localStorage.setItem(this.CONFIG_KEY, JSON.stringify(config));
    window.location.reload();
  },

  // Get active config
  getConfig() {
    try {
      const stored = localStorage.getItem(this.CONFIG_KEY);
      if (stored) return JSON.parse(stored);
      
      // Default fallback configuration supplied by user
      return {
        apiKey: "AIzaSyArEQjHN4gZj17FklloMYIN0q7L23frgL4",
        authDomain: "restropso.firebaseapp.com",
        databaseURL: "https://restropso-default-rtdb.firebaseio.com",
        projectId: "restropso",
        storageBucket: "restropso.firebasestorage.app",
        messagingSenderId: "891949712429",
        appId: "1:891949712429:web:e57ee93de8f8e1fd5ea4a4"
      };
    } catch (e) {
      console.error('Error parsing firebase config', e);
      return null;
    }
  },

  // Clear config to drop back to Demo Mode
  clearConfig() {
    localStorage.removeItem(this.CONFIG_KEY);
    window.location.reload();
  },

  // Check if Firebase is active
  isFirebaseActive() {
    return this.getConfig() !== null;
  },

  // Initialize DB instance
  async initializeFirebase() {
    const config = this.getConfig();
    if (!config) {
      console.log('Firebase credentials not found. Running in Offline Demo Mode.');
      return { active: false, db: null, auth: null, storage: null };
    }

    try {
      // Dynamic load of Firebase CDN script modules if not already present
      if (typeof firebase === 'undefined') {
        await this.loadScripts([
          'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
          'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js',
          'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js',
          'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage-compat.js'
        ]);
      }

      // Initialize App
      const app = firebase.initializeApp(config);
      const db = firebase.firestore(app);
      const auth = firebase.auth(app);
      const storage = firebase.storage(app);

      // Offline persistence for Firestore
      db.enablePersistence().catch((err) => {
        if (err.code === 'failed-precondition') {
          console.warn('Firestore multi-tab persistence failed.');
        } else if (err.code === 'unimplemented') {
          console.warn('Browser does not support Firestore persistence.');
        }
      });

      console.log('Firebase initialized successfully.');
      return { active: true, db, auth, storage };
    } catch (error) {
      console.error('Firebase initialization failed, falling back to Demo Mode:', error);
      return { active: false, error, db: null, auth: null, storage: null };
    }
  },

  loadScripts(urls) {
    return Promise.all(
      urls.map((url) => {
        return new Promise((resolve, reject) => {
          // Check if already injected
          const existing = document.querySelector(`script[src="${url}"]`);
          if (existing) {
            resolve();
            return;
          }
          const script = document.createElement('script');
          script.src = url;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
          document.head.appendChild(script);
        });
      })
    );
  }
};

window.FirebaseConfigManager = FirebaseConfigManager;
export default FirebaseConfigManager;

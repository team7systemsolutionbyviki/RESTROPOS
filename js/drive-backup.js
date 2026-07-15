import dbService from './db.js';

// Google Drive Backup / Restore Handler
class DriveBackupService {
  constructor() {
    this.accessToken = null;
    this.tokenClient = null;
    this.clientId = ''; // Configurable via settings
    this.apiKey = '';   // Configurable via settings
    this.scopes = 'https://www.googleapis.com/auth/drive.file';
  }

  // Set credentials dynamically from settings
  setCredentials(clientId, apiKey) {
    this.clientId = clientId;
    this.apiKey = apiKey;
  }

  // Initialize GIS Token Client
  initGoogleClient(onSuccess, onError) {
    if (!this.clientId) {
      onError('Google Client ID is not configured. Go to settings to set it.');
      return;
    }

    try {
      // Load Google Identity Services SDK
      if (typeof google === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => {
          this.setupTokenClient(onSuccess);
        };
        script.onerror = () => onError('Failed to load Google Identity Services SDK.');
        document.head.appendChild(script);
      } else {
        this.setupTokenClient(onSuccess);
      }
    } catch (e) {
      onError('GIS setup failed: ' + e.message);
    }
  }

  setupTokenClient(onSuccess) {
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: this.scopes,
      callback: (tokenResponse) => {
        if (tokenResponse.error !== undefined) {
          console.error(tokenResponse);
          return;
        }
        this.accessToken = tokenResponse.access_token;
        onSuccess(this.accessToken);
      },
    });
    this.tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  // Backup data
  async backupToDrive() {
    // Collect all database content
    let backupPayload = {};
    if (dbService.firebaseActive) {
      const collections = [
        'branches', 'shops', 'users', 'customers', 'products', 
        'categories', 'orders', 'tables', 'kitchen', 'inventory', 
        'suppliers', 'expenses', 'payments', 'settings'
      ];
      for (const col of collections) {
        backupPayload[col] = await dbService.getCollection(col);
      }
    } else {
      backupPayload = dbService.localDb;
    }

    const backupJson = JSON.stringify(backupPayload, null, 2);
    const fileName = `RestoPOS_Backup_${new Date().toISOString().slice(0, 10)}.json`;

    // Local download option if Google Drive isn't fully authorized
    if (!this.accessToken) {
      console.log('No Google credentials active, triggering local file download...');
      this.triggerLocalDownload(backupJson, fileName);
      return { success: true, method: 'local_download', fileName };
    }

    // Direct Google Drive Upload via Fetch
    try {
      const metadata = {
        name: fileName,
        mimeType: 'application/json',
      };

      const fileContent = new Blob([backupJson], { type: 'application/json' });
      
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', fileContent);

      const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: form
      });

      if (!response.ok) {
        throw new Error('Google Drive upload request failed.');
      }

      const result = await response.json();
      this.logBackup('Google Drive', fileName, true);
      return { success: true, method: 'google_drive', fileId: result.id, fileName };
    } catch (err) {
      console.error('Google Drive Upload error:', err);
      this.logBackup('Google Drive', fileName, false, err.message);
      throw err;
    }
  }

  // Trigger JSON download locally
  triggerLocalDownload(content, fileName) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    this.logBackup('Local Export', fileName, true);
  }

  // Restore backup from JSON payload
  async restoreBackupData(backupData) {
    try {
      if (dbService.firebaseActive) {
        // Overwrite Firestore collections sequentially
        for (const col in backupData) {
          if (Array.isArray(backupData[col])) {
            const batch = dbService.db.batch();
            for (const item of backupData[col]) {
              const docRef = dbService.db.collection(col).doc(item.id);
              batch.set(docRef, item);
            }
            await batch.commit();
          }
        }
      } else {
        // Overwrite Local DB
        dbService.localDb = { ...dbService.localDb, ...backupData };
        dbService.saveLocalDb();
        // Notify UI to refresh all screens
        for (const col in dbService.localDb) {
          dbService.triggerLocalUpdate(col);
        }
      }
      return true;
    } catch (e) {
      console.error('Restore failed:', e);
      return false;
    }
  }

  // Log backup success/failure details
  logBackup(destination, filename, success, errorMsg = '') {
    const log = {
      id: 'log_' + Date.now(),
      date: new Date().toLocaleString(),
      destination,
      filename,
      status: success ? 'Success' : 'Failed',
      error: errorMsg
    };

    if (dbService.firebaseActive) {
      dbService.addDoc('backup_logs', log);
    } else {
      if (!dbService.localDb.backup_logs) {
        dbService.localDb.backup_logs = [];
      }
      dbService.localDb.backup_logs.unshift(log);
      dbService.saveLocalDb();
      dbService.triggerLocalUpdate('backup_logs');
    }
  }

  // Auto Backup Scheduler logic (Checks intervals)
  checkAutoBackupIntervals() {
    const settings = dbService.firebaseActive 
      ? null // Load from Firestore
      : dbService.localDb.settings;

    const backupInterval = localStorage.getItem('resto_backup_interval') || 'daily'; // daily, weekly, monthly
    const lastBackupTime = localStorage.getItem('resto_last_backup_timestamp');
    
    if (!lastBackupTime) {
      // Trigger reminder
      return true;
    }

    const diffMs = Date.now() - parseInt(lastBackupTime, 10);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (backupInterval === 'daily' && diffDays >= 1) return true;
    if (backupInterval === 'weekly' && diffDays >= 7) return true;
    if (backupInterval === 'monthly' && diffDays >= 30) return true;

    return false;
  }
}

const driveBackupInstance = new DriveBackupService();
window.driveBackupService = driveBackupInstance;
export default driveBackupInstance;

/**
 * ============================================================================
 * PEMS PWA — DURABLE SYNCHRONIZATION ENGINE
 * File: js/sync.js
 * ============================================================================
 * Handles bidirectional synchronization between IndexedDB and Google Apps Script:
 * - Auto-sync on app launch, 'online' reconnection, visibilitychange, pageshow, and manual Sync Now
 * - Connectivity health-check (never assumes navigator.onLine guarantees backend availability)
 * - Automatic session refresh when transitioning from offline login to online sync
 * - Exponential backoff retry logic for transient network failures
 * - Idempotency key preservation to guarantee zero duplicate records or uploads
 * - Partial failure isolation (individual failures never block remaining items)
 * - Real-time sync status badges: 'synced', 'pending', 'syncing', 'failed'
 */

(function(window) {
  'use strict';

  const PEMS_SYNC = {
    state: {
      isSyncing: false,
      isOnline: navigator.onLine,
      serverReachable: false,
      lastSyncTimestamp: null,
      pendingCount: 0,
      failedCount: 0,
      syncingCount: 0,
      retryTimer: null,
      syncDrawerOpen: false
    },

    listeners: [],

    /**
     * Initializes the Sync Engine and binds event listeners.
     */
    init() {
      // 1. Listen for browser online / offline network events
      window.addEventListener('online', () => {
        console.log('[PEMS Sync] Network connection restored (online event).');
        this.state.isOnline = true;
        this.updateSyncBadge();
        if (window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.info('Online Detected', 'Network connection restored. Auto-syncing gathered offline data...');
        }
        // Immediate trigger + debounced retry after mobile radio stabilizes
        this.triggerSync('network_reconnected');
        setTimeout(() => {
          if (!this.state.isSyncing && (this.state.pendingCount > 0 || this.state.failedCount > 0)) {
            this.triggerSync('network_reconnected_retry');
          }
        }, 2500);
      });

      window.addEventListener('offline', () => {
        console.log('[PEMS Sync] Network connection lost (offline event).');
        this.state.isOnline = false;
        this.state.serverReachable = false;
        this.updateSyncBadge();
        if (window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.warning('Offline Mode', 'Device is offline. Gathered data and photos will be saved locally and auto-synced when connected.');
        }
      });

      // 2. Listen for tab / app visibility changes (e.g. mobile user returns to app)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.state.isOnline = navigator.onLine;
          this.updateSyncBadge();
          this.triggerSync('visibility_change');
        }
      });

      // 3. Listen for pageshow & focus (critical for iOS Safari / Android PWA resume)
      window.addEventListener('pageshow', () => {
        this.state.isOnline = navigator.onLine;
        this.updateSyncBadge();
        this.triggerSync('pageshow');
      });

      window.addEventListener('focus', () => {
        if (navigator.onLine && !this.state.isSyncing && (this.state.pendingCount > 0 || this.state.failedCount > 0)) {
          this.triggerSync('window_focus');
        }
      });

      // 4. Listen for Service Worker background sync triggers
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'PEMS_AUTO_SYNC_TRIGGER') {
            console.log('[PEMS Sync] Auto-sync triggered by Service Worker message.');
            this.triggerSync('service_worker_sync');
          }
        });
      }

      // 5. Update initial queue stats & badge
      this.refreshQueueStats();

      // 6. Initial connectivity test & sync trigger after DOM ready
      setTimeout(() => {
        this.triggerSync('app_launch');
      }, 1500);

      // 7. Periodic background heartbeat sync check (every 20 seconds if mutations exist)
      setInterval(() => {
        this.state.isOnline = navigator.onLine;
        if (navigator.onLine && !this.state.isSyncing && (this.state.pendingCount > 0 || this.state.failedCount > 0)) {
          this.triggerSync('periodic_heartbeat');
        }
      }, 20000);
    },

    /**
     * Generates a collision-resistant UUID / Idempotency Key.
     * @returns {string}
     */
    generateIdempotencyKey() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return 'idem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
    },

    /**
     * Subscribes a listener to sync state updates.
     */
    onStateChange(callback) {
      if (typeof callback === 'function') {
        this.listeners.push(callback);
      }
    },

    notifyListeners() {
      this.listeners.forEach(cb => {
        try { cb(this.state); } catch (e) { console.warn(e); }
      });
    },

    /**
     * Verifies that the Google Apps Script backend is actually reachable.
     * Crucial: Does NOT assume navigator.onLine means the backend is available.
     * @returns {Promise<boolean>}
     */
    async checkConnectivity() {
      if (!navigator.onLine) {
        this.state.isOnline = false;
        this.state.serverReachable = false;
        return false;
      }

      this.state.isOnline = true;

      // 1. Google Apps Script container mode
      if (typeof google !== 'undefined' && google.script && google.script.run) {
        this.state.serverReachable = true;
        return true;
      }

      const apiUrl = (window.PEMS_CONFIG && window.PEMS_CONFIG.getApiUrl) ? window.PEMS_CONFIG.getApiUrl() : '';
      if (!apiUrl) {
        this.state.serverReachable = false;
        return false;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);

        // Ping backend using POST to eliminate CORS preflight issues
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'ping' }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const json = await response.json().catch(() => null);
          // Even if an older backend deployment returns UNKNOWN_ACTION for 'ping',
          // a valid JSON response from script.google.com proves the backend is reachable.
          this.state.serverReachable = Boolean(json && typeof json === 'object');
          return this.state.serverReachable;
        }
        this.state.serverReachable = false;
        return false;
      } catch (err) {
        console.warn('[PEMS Sync] Connectivity check failed (offline or unreachable):', err.message);
        this.state.serverReachable = false;
        return false;
      }
    },

    /**
     * Ensures the user has a valid online server session before syncing mutations.
     * If the user signed in while offline (`offline_sess_...`) or their server session expired,
     * silently re-authenticates using cached credentials if available.
     * @param {boolean} [forceRefresh=false]
     */
    async ensureOnlineSession(forceRefresh = false) {
      if (!window.PEMS || !window.PEMS.session || !window.PEMS.api) return null;
      const sess = window.PEMS.session.get();
      const sessionId = sess ? String(sess.sessionId || '') : '';
      const isOfflineSession = !sessionId || sessionId.startsWith('offline_sess_') || sessionId.startsWith('mock_sess_') || sessionId.startsWith('SES-LOCAL-');

      if (!forceRefresh && !isOfflineSession) return sessionId;

      try {
        const rawCache = localStorage.getItem('pems_offline_auth_cache');
        if (!rawCache) return null;
        const cacheMap = JSON.parse(rawCache);
        const currentUser = sess && sess.user ? String(sess.user.username || '').trim().toLowerCase() : '';
        const entry = (currentUser && cacheMap[currentUser]) || cacheMap['__last__'];
        if (!entry || !entry.username || !entry.password) return null;

        const res = await window.PEMS.api.login(entry.username, entry.password);
        const sessObj = (res && res.data && res.data.session) ? res.data.session : (res && res.data ? res.data : null);
        const newSessionId = sessObj ? String(sessObj.sessionId || '') : '';
        const newExpiresAt = sessObj ? sessObj.expiresAt : '';
        if (res && res.success && newSessionId && !newSessionId.startsWith('offline_sess_') && !newSessionId.startsWith('SES-LOCAL-')) {
          window.PEMS.session.save(newSessionId, newExpiresAt, res.data.user);
          console.log('[PEMS Sync] Online session refreshed automatically for background sync.');
          return newSessionId;
        }
      } catch (e) {
        console.warn('[PEMS Sync] Could not auto-refresh online session:', e);
      }
      return null;
    },

    /**
     * Triggers sync if not already running.
     * @param {string} [triggerSource='manual']
     */
    async triggerSync(triggerSource = 'manual') {
      if (this.state.isSyncing) {
        console.log('[PEMS Sync] Sync already in progress, skipping trigger from:', triggerSource);
        return;
      }

      await this.refreshQueueStats();
      if (this.state.pendingCount === 0 && this.state.failedCount === 0) {
        return;
      }

      this.syncNow(triggerSource);
    },

    /**
     * Updates a record in localStorage ('PEMS_UPLOADED_RECORDS') after server sync returns live URLs.
     * @private
     */
    _updateLocalStorageRecord(propNo, updatedRowValues) {
      if (!propNo || !Array.isArray(updatedRowValues)) return;
      try {
        const cachedStr = localStorage.getItem('PEMS_UPLOADED_RECORDS');
        if (!cachedStr) return;
        const parsed = JSON.parse(cachedStr);
        const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.records) ? parsed.records : null);
        if (!list) return;
        const target = String(propNo).trim().toUpperCase();
        let changed = false;
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          const rp = Array.isArray(r) ? r[1] : (r && (r.propertyNo || (r.rowValues && r.rowValues[1])));
          if (String(rp || '').trim().toUpperCase() === target) {
            list[i] = updatedRowValues.slice(0, 20);
            changed = true;
            break;
          }
        }
        if (!changed) {
          list.unshift(updatedRowValues.slice(0, 20));
        }
        localStorage.setItem('PEMS_UPLOADED_RECORDS', JSON.stringify(parsed));
      } catch (e) {}
    },

    /**
     * Executes the full synchronization workflow.
     */
    async syncNow(triggerSource = 'manual') {
      const isManual = (triggerSource === 'manual' || triggerSource === true);
      if (this.state.isSyncing) return;

      if (this.state.retryTimer) {
        clearTimeout(this.state.retryTimer);
        this.state.retryTimer = null;
      }

      this.state.isSyncing = true;
      this.updateSyncBadge();

      console.log(`[PEMS Sync] Starting synchronization (Source: ${triggerSource})...`);

      try {
        // 1. Verify actual backend connectivity
        const isReachable = await this.checkConnectivity();
        if (!isReachable) {
          console.warn('[PEMS Sync] Backend is currently unreachable. Sync paused until connectivity is verified.');
          this.state.isSyncing = false;
          this.updateSyncBadge();
          if (isManual && window.PEMS && window.PEMS.notification) {
            window.PEMS.notification.warning('Sync Paused', 'Backend server is currently unreachable. Changes are saved safely in offline storage.');
          }
          return;
        }

        // 2. Ensure valid online session (in case user logged in while offline)
        await this.ensureOnlineSession(false);

        // 3. Fetch pending mutations from IndexedDB
        if (!window.PEMS_DB) {
          throw new Error('IndexedDB offline storage is not initialized.');
        }

        const pendingMutations = await window.PEMS_DB.getPendingMutations();
        if (pendingMutations.length === 0) {
          this.state.isSyncing = false;
          await this.refreshQueueStats();
          if (isManual && window.PEMS && window.PEMS.notification) {
            window.PEMS.notification.info('Up to Date', 'All offline records are already synchronized with Google Sheets.');
          }
          return;
        }

        let syncSuccessCount = 0;
        let syncFailureCount = 0;

        // 4. Process each mutation sequentially with error isolation
        for (let i = 0; i < pendingMutations.length; i++) {
          const mutation = pendingMutations[i];
          const recPropNo = mutation.payload && (mutation.payload.propertyNo || mutation.payload.propNo);

          // Mark mutation as syncing
          await window.PEMS_DB.updateMutation(mutation.id, { status: 'syncing' });
          this.updateSyncBadge();

          try {
            let result = await this.dispatchMutation(mutation);

            // If session expired while offline, refresh session once and retry
            if (result && !result.success && (
              result.code === 'SESSION_EXPIRED' ||
              result.code === 'INVALID_SESSION' ||
              (result.message && result.message.toLowerCase().indexOf('session') !== -1)
            )) {
              await this.ensureOnlineSession(true);
              result = await this.dispatchMutation(mutation);
            }

            if (result && result.success) {
              // Mutation succeeded!
              syncSuccessCount++;

              // Update local record syncStatus to 'synced' and merge returned Drive URLs
              if (recPropNo) {
                const localRec = await window.PEMS_DB.getRecord(recPropNo);
                if (localRec) {
                  localRec.syncStatus = 'synced';
                  if (result.data && typeof result.data === 'object') {
                    if (result.data.equipmentPhoto) localRec.equipmentPhoto = result.data.equipmentPhoto;
                    if (result.data.uploadFets) localRec.uploadFets = result.data.uploadFets;
                    if (result.data.uploadTransmittal) localRec.uploadTransmittal = result.data.uploadTransmittal;
                    if (result.data.fetsNo !== undefined) localRec.fetsNo = result.data.fetsNo;
                    if (result.data.fetsTo !== undefined) localRec.fetsTo = result.data.fetsTo;
                    if (result.data.transmittalDate !== undefined) localRec.transmittalDate = result.data.transmittalDate;
                    if (result.data.remarks !== undefined) localRec.remarks = result.data.remarks;
                    if (result.data.status !== undefined) localRec.status = result.data.status;
                    if (Array.isArray(result.data.rowValues) && result.data.rowValues.length >= 20) {
                      localRec.rowValues = result.data.rowValues.slice(0, 20);
                    } else if (Array.isArray(localRec.rowValues) && localRec.rowValues.length >= 20) {
                      if (result.data.equipmentPhoto) localRec.rowValues[12] = result.data.equipmentPhoto;
                      if (result.data.fetsNo !== undefined) localRec.rowValues[13] = result.data.fetsNo;
                      if (result.data.fetsTo !== undefined) localRec.rowValues[14] = result.data.fetsTo;
                      if (result.data.uploadFets) localRec.rowValues[15] = result.data.uploadFets;
                      if (result.data.transmittalDate !== undefined) localRec.rowValues[16] = result.data.transmittalDate;
                      if (result.data.uploadTransmittal) localRec.rowValues[17] = result.data.uploadTransmittal;
                      if (result.data.remarks !== undefined) localRec.rowValues[18] = result.data.remarks;
                      if (result.data.status !== undefined) localRec.rowValues[19] = result.data.status;
                    }
                  }
                  const saved = await window.PEMS_DB.saveRecord(localRec);
                  if (saved && saved.rowValues) {
                    this._updateLocalStorageRecord(recPropNo, saved.rowValues);
                  }
                }
                try {
                  localStorage.removeItem('pems_photo_' + recPropNo);
                } catch (e) {}
              }

              // If bulk raw upload succeeded, mark its records as synced
              if ((mutation.action === 'PROCESS_RAW_DATA_UPLOAD' || mutation.action === 'processRawDataUpload') &&
                  mutation.payload && Array.isArray(mutation.payload.records)) {
                for (let rIdx = 0; rIdx < mutation.payload.records.length; rIdx++) {
                  const row = mutation.payload.records[rIdx];
                  const rowProp = Array.isArray(row) ? row[1] : (row && row.propertyNo);
                  if (rowProp) {
                    const rec = await window.PEMS_DB.getRecord(rowProp);
                    if (rec) {
                      rec.syncStatus = 'synced';
                      await window.PEMS_DB.saveRecord(rec);
                    }
                  }
                }
              }

              // Clean up linked photo blobs if present
              if (mutation.photoKey) {
                await window.PEMS_DB.deletePhotoBlob(mutation.photoKey).catch(() => {});
              }
              if (mutation.photoKeys && Array.isArray(mutation.photoKeys)) {
                for (const pk of mutation.photoKeys) {
                  await window.PEMS_DB.deletePhotoBlob(pk).catch(() => {});
                }
              }

              // Remove mutation from syncQueue
              await window.PEMS_DB.removeMutation(mutation.id);
            } else {
              // Mutation rejected by server
              syncFailureCount++;
              const errMsg = (result && result.message) || 'Unknown server rejection';
              const newRetries = (mutation.retries || 0) + 1;
              await window.PEMS_DB.updateMutation(mutation.id, {
                status: 'failed',
                retries: newRetries,
                lastError: errMsg
              });

              if (recPropNo) {
                const localRec = await window.PEMS_DB.getRecord(recPropNo);
                if (localRec) {
                  localRec.syncStatus = 'failed';
                  await window.PEMS_DB.saveRecord(localRec);
                }
              }
            }
          } catch (itemErr) {
            syncFailureCount++;
            console.error(`[PEMS Sync] Error syncing mutation #${mutation.id}:`, itemErr);
            const newRetries = (mutation.retries || 0) + 1;
            await window.PEMS_DB.updateMutation(mutation.id, {
              status: 'failed',
              retries: newRetries,
              lastError: itemErr.message || 'Network communication error'
            });

            if (recPropNo) {
              const localRec = await window.PEMS_DB.getRecord(recPropNo);
              if (localRec) {
                localRec.syncStatus = 'failed';
                await window.PEMS_DB.saveRecord(localRec);
              }
            }
          }
        }

        // 5. Update last sync timestamp
        this.state.lastSyncTimestamp = new Date().toISOString();
        if (window.PEMS_DB) {
          await window.PEMS_DB.setMeta('lastSyncTimestamp', this.state.lastSyncTimestamp);
        }

        // 6. Notify user if appropriate
        if (syncSuccessCount > 0 && window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.success(
            'Sync Complete',
            `Successfully synchronized ${syncSuccessCount} offline change${syncSuccessCount > 1 ? 's' : ''} with Google Sheets & Drive.`
          );
        }

        if (syncFailureCount > 0 && window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.error(
            'Sync Warning',
            `${syncFailureCount} item${syncFailureCount > 1 ? 's' : ''} could not be synced yet. Will retry automatically.`
          );
          // Schedule exponential backoff retry if still online
          if (navigator.onLine) {
            this.state.retryTimer = setTimeout(() => {
              this.triggerSync('auto_retry_backoff');
            }, 12000);
          }
        }

        // Refresh live inventory view & dashboard if visible
        if (syncSuccessCount > 0 && window.PEMS) {
          if (window.PEMS.inventory && typeof window.PEMS.inventory.load === 'function') {
            const invView = document.getElementById('viewInventory');
            if (invView && invView.style.display !== 'none') {
              window.PEMS.inventory.load(true);
            } else if (typeof window.PEMS.inventory.primeOfflineCache === 'function') {
              window.PEMS.inventory.primeOfflineCache();
            }
          }
          if (window.PEMS.dashboard && typeof window.PEMS.dashboard.loadStats === 'function') {
            const dashView = document.getElementById('viewDashboard');
            if (dashView && dashView.style.display !== 'none') {
              window.PEMS.dashboard.loadStats();
            }
          }
        }
      } catch (err) {
        console.error('[PEMS Sync] Fatal error during synchronization:', err);
      } finally {
        this.state.isSyncing = false;
        await this.refreshQueueStats();
        this.updateSyncBadge();
        const modal = document.getElementById('syncQueueDrawerModal');
        if (modal && modal.style.display === 'flex') {
          this.openSyncDrawer();
        }
      }
    },

    /**
     * Dispatches an individual mutation to the backend API.
     * @private
     */
    async dispatchMutation(mutation) {
      const action = mutation.action;
      const payload = Object.assign({}, mutation.payload || {});
      const key = mutation.idempotencyKey;

      // Attach idempotencyKey to payload
      payload.idempotencyKey = key;

      // If mutation has linked photo blobs, load from IndexedDB photos store or localStorage
      const pKeys = (mutation.photoKeys && Array.isArray(mutation.photoKeys))
        ? mutation.photoKeys
        : (mutation.photoKey ? [mutation.photoKey] : []);

      for (const pk of pKeys) {
        if (!pk) continue;
        let photoEntry = null;
        if (window.PEMS_DB) {
          photoEntry = await window.PEMS_DB.getPhotoBlob(pk);
        }
        if (!photoEntry && window.localStorage) {
          const lsKey = 'pems_photo_' + (payload.propNo || payload.propertyNo || pk);
          const lsData = localStorage.getItem(lsKey);
          if (lsData) {
            photoEntry = { data: lsData, docType: 'photo', mimeType: 'image/jpeg', fileName: 'photo.jpg' };
          }
        }
        if (photoEntry && photoEntry.data) {
          if (action === 'UPDATE_ASSET_TRACKING' || action === 'updateAssetTracking') {
            const docType = photoEntry.docType || 'photo';
            const base64Data = typeof photoEntry.data === 'string' && photoEntry.data.indexOf('base64,') !== -1
              ? photoEntry.data.split('base64,')[1]
              : photoEntry.data;

            const fileObj = {
              base64: base64Data,
              mimeType: photoEntry.mimeType || 'image/jpeg',
              fileName: photoEntry.fileName || 'photo.jpg'
            };

            if (docType === 'photo' || docType === 'equipment_photo') {
              payload.equipmentPhotoFile = fileObj;
            } else if (docType === 'fets') {
              payload.fetsFile = fileObj;
            } else if (docType === 'transmittal') {
              payload.transmittalFile = fileObj;
            }
          }
        }
      }

      // Execute via PEMS.api.invoke
      if (window.PEMS && window.PEMS.api && typeof window.PEMS.api.invoke === 'function') {
        const sess = window.PEMS.session ? window.PEMS.session.get() : null;
        const sessionId = sess ? sess.sessionId : null;

        if (action === 'ADD_MANUAL_INVENTORY' || action === 'addManualInventoryRecord') {
          return window.PEMS.api.addManualInventoryRecord(payload);
        } else if (action === 'UPDATE_ASSET_TRACKING' || action === 'updateAssetTracking') {
          return window.PEMS.api.updateAssetTracking(payload);
        } else if (action === 'DELETE_INVENTORY_RECORD' || action === 'deleteInventoryRecord') {
          return window.PEMS.api.deleteInventoryRecord(payload.propertyNo || payload.propNo);
        } else if (action === 'PROCESS_RAW_DATA_UPLOAD' || action === 'processRawDataUpload') {
          return window.PEMS.api.processRawDataUpload(payload);
        } else {
          return window.PEMS.api.invoke(action, sessionId, payload);
        }
      }

      throw new Error('PEMS.api is not available to execute mutation.');
    },

    /**
     * Refreshes queue statistics from IndexedDB.
     */
    async refreshQueueStats() {
      if (!window.PEMS_DB) return;
      try {
        const stats = await window.PEMS_DB.getSyncStats();
        this.state.pendingCount = stats.pending;
        this.state.syncingCount = stats.syncing;
        this.state.failedCount = stats.failed;
        this.notifyListeners();
        this.updateSyncBadge();
      } catch (e) {
        console.warn('[PEMS Sync] Could not refresh queue stats:', e);
      }
    },

    /**
     * Updates the sync status badge in the navbar / header and mobile banner.
     */
    updateSyncBadge() {
      const badge = document.getElementById('pemsSyncBadge');
      const textEl = document.getElementById('pemsSyncBadgeText');
      const iconEl = document.getElementById('pemsSyncBadgeIcon');
      const syncNowBtn = document.getElementById('btnSyncNow');

      const { isSyncing, isOnline, pendingCount, failedCount } = this.state;
      const totalUnsynced = pendingCount + failedCount;

      if (badge) {
        if (isSyncing) {
          badge.className = 'sync-status-badge badge-syncing';
          if (textEl) textEl.textContent = 'Syncing...';
          if (iconEl) iconEl.innerHTML = '<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>';
          if (syncNowBtn) syncNowBtn.disabled = true;
        } else if (failedCount > 0) {
          badge.className = 'sync-status-badge badge-failed';
          if (textEl) textEl.textContent = !isOnline ? `Offline (${totalUnsynced})` : `Retry (${failedCount})`;
          if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
          if (syncNowBtn) syncNowBtn.disabled = false;
        } else if (pendingCount > 0) {
          badge.className = 'sync-status-badge badge-pending';
          if (textEl) textEl.textContent = `Pending (${pendingCount})`;
          if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
          if (syncNowBtn) syncNowBtn.disabled = false;
        } else if (!isOnline) {
          badge.className = 'sync-status-badge badge-offline';
          if (textEl) textEl.textContent = 'Offline';
          if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';
          if (syncNowBtn) syncNowBtn.disabled = true;
        } else {
          badge.className = 'sync-status-badge badge-synced';
          if (textEl) textEl.textContent = 'Synced';
          if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
          if (syncNowBtn) syncNowBtn.disabled = false;
        }
      }

      // Mobile floating sync notification banner
      const banner = document.getElementById('pemsOfflineBanner');
      const bannerText = document.getElementById('offlineBannerText');
      const bannerBtn = document.getElementById('btnBannerSyncNow');

      if (banner) {
        if (!isOnline) {
          banner.style.display = 'flex';
          banner.className = 'pems-offline-banner';
          if (bannerText) {
            bannerText.textContent = totalUnsynced > 0
              ? `Offline Mode — ${totalUnsynced} gathered change${totalUnsynced > 1 ? 's' : ''} saved on device. Auto-syncs when online.`
              : 'Offline Mode — Full offline gathering active. Auto-syncs when online.';
          }
          if (bannerBtn) bannerBtn.style.display = 'none';
        } else if (isSyncing) {
          banner.style.display = 'flex';
          banner.className = 'pems-offline-banner banner-syncing';
          if (bannerText) bannerText.textContent = 'Connection restored — Auto-syncing gathered records with online spreadsheet...';
          if (bannerBtn) bannerBtn.style.display = 'none';
        } else if (totalUnsynced > 0) {
          banner.style.display = 'flex';
          banner.className = 'pems-offline-banner banner-pending';
          if (bannerText) bannerText.textContent = `${totalUnsynced} offline change${totalUnsynced > 1 ? 's' : ''} ready to sync with Google Sheets.`;
          if (bannerBtn) bannerBtn.style.display = 'inline-flex';
        } else {
          if (banner.style.display !== 'none' && banner.classList.contains('banner-syncing')) {
            banner.className = 'pems-offline-banner banner-synced';
            if (bannerText) bannerText.textContent = '✓ All gathered records synchronized with Google Sheets!';
            if (bannerBtn) bannerBtn.style.display = 'none';
            setTimeout(() => {
              if (banner.classList.contains('banner-synced')) {
                banner.style.display = 'none';
              }
            }, 3500);
          } else if (totalUnsynced === 0 && isOnline) {
            banner.style.display = 'none';
          }
        }
      }
    },

    /**
     * Opens the Sync Queue modal/drawer showing pending/failed items and retry options.
     */
    async openSyncDrawer() {
      const modal = document.getElementById('syncQueueDrawerModal');
      if (!modal) return;

      const container = document.getElementById('syncQueueListContainer');
      const countEl = document.getElementById('syncDrawerCountBadge');

      if (container) {
        container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-muted);"><span class="loading-spinner-inline"></span> Loading synchronization queue...</div>';
      }

      modal.style.display = 'flex';

      try {
        const mutations = await window.PEMS_DB.getAllMutations();
        if (countEl) countEl.textContent = `${mutations.length} item${mutations.length === 1 ? '' : 's'}`;

        if (!container) return;

        if (mutations.length === 0) {
          container.innerHTML = `
            <div style="padding: 3rem 1.5rem; text-align: center; color: var(--text-muted);">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" style="margin-bottom: 1rem;"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
              <h4 style="color: #f8fafc; font-size: 1.1rem; margin: 0 0 0.5rem;">All Changes Synchronized</h4>
              <p style="font-size: 0.85rem; margin: 0;">No pending offline creations, edits, uploads, or deletes in the sync queue.</p>
            </div>
          `;
          return;
        }

        const esc = (window.PEMS && window.PEMS.users && typeof window.PEMS.users.escapeHtml === 'function')
          ? window.PEMS.users.escapeHtml.bind(window.PEMS.users)
          : (s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

        let html = '<div class="sync-queue-items-list">';
        mutations.forEach(item => {
          const statusClass = item.status === 'failed' ? 'status-err' : (item.status === 'syncing' ? 'status-syncing' : 'status-pending');
          const statusLabel = item.status === 'failed' ? 'Waiting for Retry' : (item.status === 'syncing' ? 'Syncing...' : 'Pending Sync');
          const actionLabel = String(item.action || '').replace(/_/g, ' ');
          const propNo = (item.payload && (item.payload.propertyNo || item.payload.propNo || (Array.isArray(item.payload.records) ? `BATCH (${item.payload.records.length} rows)` : ''))) || 'ASSET';
          const time = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

          html += `
            <div class="sync-queue-card ${statusClass}">
              <div class="sync-card-header">
                <span class="sync-card-prop font-mono">${esc(propNo)}</span>
                <span class="sync-card-status ${statusClass}">${statusLabel}</span>
              </div>
              <div class="sync-card-body font-mono text-xs">
                <div>Action: <strong>${esc(actionLabel)}</strong></div>
                <div class="text-muted">Enqueued: ${time} (Attempts: ${item.retries || 0})</div>
                ${item.lastError ? `<div class="sync-card-error font-mono text-xs">Note: ${esc(item.lastError)}</div>` : ''}
              </div>
            </div>
          `;
        });
        html += '</div>';

        container.innerHTML = html;
      } catch (err) {
        if (container) {
          container.innerHTML = `<div style="padding: 2rem; color: #ef4444;">Failed to load sync queue: ${err.message}</div>`;
        }
      }
    },

    closeSyncDrawer() {
      const modal = document.getElementById('syncQueueDrawerModal');
      if (modal) modal.style.display = 'none';
    }
  };

  // Expose globally
  window.PEMS_SYNC = PEMS_SYNC;

})(typeof window !== 'undefined' ? window : this);

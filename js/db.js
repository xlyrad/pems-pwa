/**
 * ============================================================================
 * PEMS PWA — CLIENT-SIDE OFFLINE STORAGE ENGINE (IndexedDB)
 * File: js/db.js
 * ============================================================================
 * Provides persistent offline storage for:
 * 1. 'records'   - 20-column asset and property records
 * 2. 'photos'    - Equipment photos and PDF document binary blobs
 * 3. 'syncQueue' - Durable mutation queue for offline creates, updates, and deletes
 * 4. 'metadata'  - Session, cached stats, uploaders, and API configuration
 */

(function(window) {
  'use strict';

  const DB_NAME = 'pems_offline_db';
  const DB_VERSION = 1;

  let dbInstance = null;
  let initPromise = null;

  const PEMS_DB = {
    /**
     * Initializes the IndexedDB database and object stores.
     * @returns {Promise<IDBDatabase>}
     */
    init() {
      if (dbInstance) return Promise.resolve(dbInstance);
      if (initPromise) return initPromise;

      initPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          console.warn('IndexedDB is not supported in this browser environment.');
          return reject(new Error('IndexedDB not supported'));
        }

        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          // 1. Records Store (Key: Property No in uppercase)
          if (!db.objectStoreNames.contains('records')) {
            const recordStore = db.createObjectStore('records', { keyPath: 'propertyNo' });
            recordStore.createIndex('tier', 'tier', { unique: false });
            recordStore.createIndex('syncStatus', 'syncStatus', { unique: false });
            recordStore.createIndex('uploadedBy', 'uploadedBy', { unique: false });
            recordStore.createIndex('clientUpdatedAt', 'clientUpdatedAt', { unique: false });
          }

          // 2. Photos Store (Binary blobs / base64 for offline images & docs)
          if (!db.objectStoreNames.contains('photos')) {
            const photoStore = db.createObjectStore('photos', { keyPath: 'photoId' });
            photoStore.createIndex('propertyNo', 'propertyNo', { unique: false });
            photoStore.createIndex('docType', 'docType', { unique: false });
          }

          // 3. Durable Sync Queue Store
          if (!db.objectStoreNames.contains('syncQueue')) {
            const queueStore = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
            queueStore.createIndex('status', 'status', { unique: false });
            queueStore.createIndex('idempotencyKey', 'idempotencyKey', { unique: true });
            queueStore.createIndex('createdAt', 'createdAt', { unique: false });
          }

          // 4. Metadata Store (Key-value pairs)
          if (!db.objectStoreNames.contains('metadata')) {
            db.createObjectStore('metadata', { keyPath: 'key' });
          }
        };

        request.onsuccess = (event) => {
          dbInstance = event.target.result;
          resolve(dbInstance);
        };

        request.onerror = (event) => {
          console.error('Failed to open IndexedDB:', event.target.error);
          reject(event.target.error);
        };
      });

      return initPromise;
    },

    /**
     * Executes a transaction on the specified store.
     * @private
     */
    _getTransaction(storeName, mode = 'readonly') {
      return this.init().then(db => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        return { tx, store };
      });
    },

    /**
     * Converts a 20-column array or partial record object into a normalized record object.
     * @param {Array|Object} rec
     * @param {string} [defaultSyncStatus='synced']
     * @returns {Object|null}
     */
    rowToRecord(rec, defaultSyncStatus = 'synced') {
      if (!rec) return null;
      if (Array.isArray(rec)) {
        const pNo = String(rec[1] || '').trim().toUpperCase();
        if (!pNo) return null;
        const rowValues = [];
        for (let i = 0; i < 20; i++) {
          rowValues.push(rec[i] !== undefined && rec[i] !== null ? String(rec[i]) : '');
        }
        return {
          propertyNo: pNo,
          articleDesc: rowValues[0],
          generalDesc: rowValues[2],
          serialNo: rowValues[3],
          acquisitionCost: rowValues[4],
          acquisitionDate: rowValues[5],
          parNo: rowValues[6],
          officeName: rowValues[7],
          receiver: rowValues[8],
          subPar: rowValues[9],
          dateUpload: rowValues[10],
          uploadedBy: rowValues[11],
          equipmentPhoto: rowValues[12],
          fetsNo: rowValues[13],
          fetsTo: rowValues[14],
          uploadFets: rowValues[15],
          transmittalDate: rowValues[16],
          uploadTransmittal: rowValues[17],
          remarks: rowValues[18],
          status: rowValues[19],
          rowValues: rowValues,
          syncStatus: defaultSyncStatus,
          clientUpdatedAt: new Date().toISOString()
        };
      }

      const pNo = String(rec.propertyNo || (rec.rowValues && rec.rowValues[1]) || '').trim().toUpperCase();
      if (!pNo) return null;

      const rv = Array.isArray(rec.rowValues) && rec.rowValues.length >= 20 ? rec.rowValues.slice(0, 20) : null;
      const articleDesc = String(rec.articleDesc ?? (rv ? rv[0] : '') ?? '');
      const generalDesc = String(rec.generalDesc ?? (rv ? rv[2] : '') ?? '');
      const serialNo = String(rec.serialNo ?? (rv ? rv[3] : '') ?? '');
      const acquisitionCost = String(rec.acquisitionCost ?? (rv ? rv[4] : '') ?? '');
      const acquisitionDate = String(rec.acquisitionDate ?? rec.acqDate ?? (rv ? rv[5] : '') ?? '');
      const parNo = String(rec.parNo ?? (rv ? rv[6] : '') ?? '');
      const officeName = String(rec.officeName ?? rec.office ?? (rv ? rv[7] : '') ?? '');
      const receiver = String(rec.receiver ?? (rv ? rv[8] : '') ?? '');
      const subPar = String(rec.subPar ?? (rv ? rv[9] : '') ?? '');
      const dateUpload = String(rec.dateUpload ?? (rv ? rv[10] : '') ?? '');
      const uploadedBy = String(rec.uploadedBy ?? (rv ? rv[11] : '') ?? '');
      const equipmentPhoto = String(rec.equipmentPhoto ?? (rv ? rv[12] : '') ?? '');
      const fetsNo = String(rec.fetsNo ?? (rv ? rv[13] : '') ?? '');
      const fetsTo = String(rec.fetsTo ?? (rv ? rv[14] : '') ?? '');
      const uploadFets = String(rec.uploadFets ?? (rv ? rv[15] : '') ?? '');
      const transmittalDate = String(rec.transmittalDate ?? (rv ? rv[16] : '') ?? '');
      const uploadTransmittal = String(rec.uploadTransmittal ?? (rv ? rv[17] : '') ?? '');
      const remarks = String(rec.remarks ?? (rv ? rv[18] : '') ?? '');
      const status = String(rec.status ?? (rv ? rv[19] : '') ?? '');

      const normalizedRowValues = [
        articleDesc,
        pNo,
        generalDesc,
        serialNo,
        acquisitionCost,
        acquisitionDate,
        parNo,
        officeName,
        receiver,
        subPar,
        dateUpload,
        uploadedBy,
        equipmentPhoto,
        fetsNo,
        fetsTo,
        uploadFets,
        transmittalDate,
        uploadTransmittal,
        remarks,
        status
      ];

      return Object.assign({}, rec, {
        propertyNo: pNo,
        articleDesc: articleDesc,
        generalDesc: generalDesc,
        serialNo: serialNo,
        acquisitionCost: acquisitionCost,
        acquisitionDate: acquisitionDate,
        parNo: parNo,
        officeName: officeName,
        receiver: receiver,
        subPar: subPar,
        dateUpload: dateUpload,
        uploadedBy: uploadedBy,
        equipmentPhoto: equipmentPhoto,
        fetsNo: fetsNo,
        fetsTo: fetsTo,
        uploadFets: uploadFets,
        transmittalDate: transmittalDate,
        uploadTransmittal: uploadTransmittal,
        remarks: remarks,
        status: status,
        rowValues: normalizedRowValues,
        syncStatus: rec.syncStatus || defaultSyncStatus,
        clientUpdatedAt: rec.clientUpdatedAt || new Date().toISOString()
      });
    },

    // =========================================================================
    // RECORDS STORE METHODS
    // =========================================================================

    /**
     * Saves or updates a single record in IndexedDB.
     */
    saveRecord(record) {
      if (!record) return Promise.reject(new Error('Record is required'));
      const normalized = this.rowToRecord(record, record.syncStatus || 'synced');
      if (!normalized || !normalized.propertyNo) {
        return Promise.reject(new Error('Property No is required'));
      }

      return this._getTransaction('records', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.put(normalized);
          req.onsuccess = () => resolve(normalized);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves a single record by Property No.
     */
    getRecord(propertyNo) {
      const pNo = String(propertyNo || '').trim().toUpperCase();
      if (!pNo) return Promise.resolve(null);

      return this._getTransaction('records', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.get(pNo);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves all records stored in IndexedDB.
     */
    getAllRecords() {
      return this._getTransaction('records', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Deletes a record from IndexedDB by Property No.
     */
    deleteRecord(propertyNo) {
      const pNo = String(propertyNo || '').trim().toUpperCase();
      if (!pNo) return Promise.resolve(false);

      return this._getTransaction('records', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.delete(pNo);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Bulk saves an array of records (either 20-col arrays or record objects) in a single transaction.
     * Preserves any local records that currently have syncStatus === 'pending' or 'failed'.
     */
    saveRecordsBatch(records, headers) {
      if (!Array.isArray(records) || records.length === 0) return Promise.resolve(0);

      if (Array.isArray(headers) && headers.length > 0) {
        this.setMeta('inventoryHeaders', headers).catch(() => {});
      }

      return this._getTransaction('records', 'readwrite').then(({ store, tx }) => {
        return new Promise((resolve, reject) => {
          const getAllReq = store.getAll();
          getAllReq.onsuccess = () => {
            const existingList = getAllReq.result || [];
            const unsyncedMap = {};
            existingList.forEach(item => {
              if (item && item.propertyNo && (item.syncStatus === 'pending' || item.syncStatus === 'failed')) {
                unsyncedMap[String(item.propertyNo).trim().toUpperCase()] = item;
              }
            });

            let count = 0;
            records.forEach(rec => {
              const normalized = this.rowToRecord(rec, 'synced');
              if (normalized && normalized.propertyNo) {
                // Do not overwrite pending/failed offline edits with stale server data
                if (unsyncedMap[normalized.propertyNo] && (!rec || Array.isArray(rec) || rec.syncStatus !== 'pending')) {
                  return;
                }
                store.put(normalized);
                count++;
              }
            });

            tx.oncomplete = () => resolve(count);
          };
          getAllReq.onerror = () => reject(getAllReq.error);
          tx.onerror = () => reject(tx.error);
        });
      });
    },

    /**
     * Clears all records from IndexedDB.
     */
    clearRecords() {
      return this._getTransaction('records', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.clear();
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    // =========================================================================
    // PHOTOS STORE METHODS
    // =========================================================================

    /**
     * Saves a photo or document blob in IndexedDB.
     */
    savePhotoBlob(photoId, blobOrBase64, metadata = {}) {
      const id = String(photoId || '').trim();
      if (!id) return Promise.reject(new Error('Photo ID is required'));

      const entry = {
        photoId: id,
        propertyNo: metadata.propertyNo || '',
        docType: metadata.docType || 'photo',
        data: blobOrBase64,
        mimeType: metadata.mimeType || 'image/jpeg',
        fileName: metadata.fileName || (id + '.jpg'),
        fileSize: metadata.fileSize || 0,
        createdAt: new Date().toISOString()
      };

      return this._getTransaction('photos', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.put(entry);
          req.onsuccess = () => resolve(entry);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves a photo or document blob by Photo ID.
     */
    getPhotoBlob(photoId) {
      const id = String(photoId || '').trim();
      if (!id) return Promise.resolve(null);

      return this._getTransaction('photos', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Deletes a photo blob by Photo ID.
     */
    deletePhotoBlob(photoId) {
      const id = String(photoId || '').trim();
      if (!id) return Promise.resolve(false);

      return this._getTransaction('photos', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.delete(id);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    // =========================================================================
    // DURABLE SYNC QUEUE METHODS
    // =========================================================================

    /**
     * Enqueues an offline mutation into the sync queue.
     * Supports both single-object argument and positional arguments.
     * @param {string|Object} actionOrObj E.g. 'ADD_MANUAL_INVENTORY', 'UPDATE_ASSET_TRACKING', or config object
     * @param {Object} [payload] The mutation payload
     * @param {string} [idempotencyKey] Unique idempotency key (UUID)
     * @param {string} [photoKey] Optional key linking to photo store
     */
    enqueueMutation(actionOrObj, payload, idempotencyKey, photoKey = null) {
      let action = actionOrObj;
      let pKeys = [];
      if (actionOrObj && typeof actionOrObj === 'object') {
        action = actionOrObj.action;
        payload = actionOrObj.payload;
        idempotencyKey = actionOrObj.idempotencyKey;
        photoKey = actionOrObj.photoKey || null;
        pKeys = actionOrObj.photoKeys || (photoKey ? [photoKey] : []);
      } else if (photoKey) {
        pKeys = [photoKey];
      }

      const key = idempotencyKey || ('idem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9));

      const mutation = {
        action: action,
        payload: payload,
        idempotencyKey: key,
        photoKey: photoKey,
        photoKeys: pKeys,
        status: 'pending', // 'pending' | 'syncing' | 'failed'
        retries: 0,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const propNo = payload && (payload.propNo || payload.propertyNo);

      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          // Coalesce duplicate pending/failed mutations for the same property
          if (propNo && (action === 'UPDATE_ASSET_TRACKING' || action === 'updateAssetTracking')) {
            const getReq = store.getAll();
            getReq.onsuccess = () => {
              const all = getReq.result || [];
              const cleanProp = String(propNo).trim().toUpperCase();
              const existing = all.find(m => {
                if (m.status !== 'pending' && m.status !== 'failed') return false;
                const mAction = m.action;
                const mProp = m.payload && (m.payload.propNo || m.payload.propertyNo);
                return (mAction === 'UPDATE_ASSET_TRACKING' || mAction === 'updateAssetTracking') &&
                  String(mProp || '').trim().toUpperCase() === cleanProp;
              });

              if (existing) {
                // Merge payload, reset retry state
                existing.payload = Object.assign({}, existing.payload || {}, payload);
                if (photoKey) existing.photoKey = photoKey;
                if (pKeys.length > 0) existing.photoKeys = Array.from(new Set((existing.photoKeys || []).concat(pKeys)));
                existing.status = 'pending';
                existing.retries = 0;
                existing.lastError = null;
                existing.updatedAt = new Date().toISOString();
                const putReq = store.put(existing);
                putReq.onsuccess = () => {
                  if (window.PEMS_SYNC && typeof window.PEMS_SYNC.refreshQueueStats === 'function') {
                    window.PEMS_SYNC.refreshQueueStats();
                  }
                  resolve(existing);
                };
                putReq.onerror = () => reject(putReq.error);
                return;
              }

              // No existing mutation, add new
              const req = store.add(mutation);
              req.onsuccess = () => {
                mutation.id = req.result;
                if ('serviceWorker' in navigator) {
                  navigator.serviceWorker.ready.then(reg => {
                    if (reg && reg.sync && typeof reg.sync.register === 'function') {
                      reg.sync.register('pems-sync-queue').catch(() => {});
                    }
                  }).catch(() => {});
                }
                if (window.PEMS_SYNC && typeof window.PEMS_SYNC.refreshQueueStats === 'function') {
                  window.PEMS_SYNC.refreshQueueStats();
                }
                resolve(mutation);
              };
              req.onerror = () => reject(req.error);
            };
            getReq.onerror = () => reject(getReq.error);
            return;
          }

          const req = store.add(mutation);
          req.onsuccess = () => {
            mutation.id = req.result;
            // Register OS-level Background Sync if supported (Android / Chrome PWA)
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.ready.then(reg => {
                if (reg && reg.sync && typeof reg.sync.register === 'function') {
                  reg.sync.register('pems-sync-queue').catch(() => {});
                }
              }).catch(() => {});
            }
            if (window.PEMS_SYNC && typeof window.PEMS_SYNC.refreshQueueStats === 'function') {
              window.PEMS_SYNC.refreshQueueStats();
            }
            resolve(mutation);
          };
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves all pending and failed mutations in the sync queue.
     */
    getPendingMutations() {
      return this._getTransaction('syncQueue', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => {
            const all = req.result || [];
            const pending = all.filter(item => item.status === 'pending' || item.status === 'failed' || item.status === 'syncing');
            // Sort by createdAt ascending
            pending.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            resolve(pending);
          };
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves all mutations regardless of status.
     */
    getAllMutations() {
      return this._getTransaction('syncQueue', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Updates the status and retry state of a mutation.
     */
    updateMutation(id, updates) {
      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const getReq = store.get(id);
          getReq.onsuccess = () => {
            const item = getReq.result;
            if (!item) return resolve(null);
            Object.assign(item, updates, { updatedAt: new Date().toISOString() });
            const putReq = store.put(item);
            putReq.onsuccess = () => resolve(item);
            putReq.onerror = () => reject(putReq.error);
          };
          getReq.onerror = () => reject(getReq.error);
        });
      });
    },

    /**
     * Removes a successfully synced mutation from the queue.
     */
    removeMutation(id) {
      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.delete(id);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Clears completed/synced (or failed if no synced) mutations from the queue.
     */
    clearCompletedMutations() {
      return this._getTransaction('syncQueue', 'readwrite').then(({ store, tx }) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => {
            const all = req.result || [];
            all.forEach(item => {
              if (item.status === 'synced' || item.status === 'completed') {
                store.delete(item.id);
              }
            });
            tx.oncomplete = () => {
              if (window.PEMS_SYNC && typeof window.PEMS_SYNC.refreshQueueStats === 'function') {
                window.PEMS_SYNC.refreshQueueStats();
              }
              resolve(true);
            };
          };
          req.onerror = () => reject(req.error);
          tx.onerror = () => reject(tx.error);
        });
      });
    },

    /**
     * Returns statistics of the sync queue.
     */
    getSyncStats() {
      return this.getAllMutations().then(items => {
        let pending = 0;
        let syncing = 0;
        let failed = 0;
        items.forEach(it => {
          if (it.status === 'pending') pending++;
          else if (it.status === 'syncing') syncing++;
          else if (it.status === 'failed') failed++;
        });
        return {
          total: items.length,
          pending: pending,
          syncing: syncing,
          failed: failed
        };
      });
    },

    /**
     * Clears the entire sync queue.
     */
    clearSyncQueue() {
      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.clear();
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    // =========================================================================
    // METADATA STORE METHODS
    // =========================================================================

    /**
     * Sets a key-value pair in metadata store.
     */
    setMeta(key, value) {
      return this._getTransaction('metadata', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.put({ key: key, value: value, updatedAt: new Date().toISOString() });
          req.onsuccess = () => resolve(value);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Gets a value from metadata store by key.
     */
    getMeta(key) {
      return this._getTransaction('metadata', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => reject(req.error);
        });
      });
    }
  };

  // Attach to window global object
  window.PEMS_DB = PEMS_DB;

})(typeof window !== 'undefined' ? window : this);

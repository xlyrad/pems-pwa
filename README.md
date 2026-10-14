# PEMS — PROPERTY & EQUIPMENT MONITORING SYSTEM
**Standalone, Installable, Offline-First Progressive Web App (PWA)**  
*Hosted on GitHub Pages • Powered by Google Apps Script, Google Sheets & Google Drive*

---

## Highlights

- **Offline-First PWA**: Runs seamlessly offline after its first successful load, including when closed and reopened offline.
- **Standalone Installation**: Installs as a native-like app on **Windows 10/11**, **macOS**, **Android**, and **iPhone / iPad**.
- **Complete Offline CRUD**: Create, view, edit, and delete inventory assets without an active internet connection.
- **Local Photo & Document Retention**: Capture photos with device camera or file input; blobs are stored in IndexedDB and queued for cloud upload.
- **Durable Synchronization Engine**:
  - Auto-syncs on app launch, network reconnection, tab/app visibility changes, or manual **Sync Now**.
  - Exponential backoff retry logic for intermittent networks.
  - Collision-resistant idempotency keys guarantee zero duplicate records or uploads.
  - Partial failure isolation ensures individual failed mutations never block valid items.
  - Live status badges: `Synced` (emerald), `Pending` (amber), `Syncing` (cyan spin), `Failed` (crimson), `Offline` (slate).
- **Zero Credentials Exposed**: Secrets and Google tokens are never in client-side code. Google Apps Script acts as an authenticated Web API proxy with Role-Based Access Control (RBAC).
- **1-Week Persistent Sessions**: Seamless login persistence with instant pre-render check to eliminate flash of unauthenticated content.
- **Preserved Aesthetics**: Premium glassmorphism design system, dark mode `#0f172a`, AnimeJS SVG motion paths, and responsive mobile-first navigation.

---

## Directory Structure

```
PASIMS/
├── pwa/                                # Complete standalone distribution for GitHub Pages
│   ├── index.html                      # Compiled standalone PWA shell
│   ├── manifest.json                   # Web App Manifest (standalone, dark theme)
│   ├── sw.js                           # Service Worker (precache, runtime cache, offline fallback)
│   ├── pwa-config.js                   # Client API router and backend connectivity tester
│   ├── .nojekyll                       # Bypass Jekyll processing on GitHub Pages
│   ├── js/
│   │   ├── db.js                       # IndexedDB storage engine (records, photos, syncQueue)
│   │   ├── sync.js                     # Durable synchronization engine & queue manager
│   │   └── pwa-install.js              # Cross-platform install prompts (Chrome, Edge, iOS Safari)
│   └── icons/
│       ├── icon-192.png                # 192x192 PNG app icon
│       ├── icon-512.png                # 512x512 PNG app icon
│       ├── icon-maskable.png           # 512x512 maskable PNG app icon
│       └── icon.svg                    # Scalable vector monogram icon
│
├── backend/                            # Deployable Google Apps Script Backend
│   ├── Code.gs                         # Web API handlers (doGet, doPost, batchSync, delete, etc.)
│   └── appsscript.json                 # Apps Script project manifest
│
├── gas-container/                      # Modular files for Container-Bound Apps Script version
│   ├── Code.gs
│   ├── Index.html
│   ├── CSS.html
│   ├── AnimeJs.html
│   └── JavaScript.html
│
├── DEPLOYMENT_GUIDE.md                 # Complete step-by-step deployment guide
├── TEST_CASES.md                       # Verification and test case suite
├── build_pwa.cjs                       # Automated compiler from modular source to standalone PWA
└── pasims-pwa.zip                      # Complete distributable archive
```

---

## Quick Start (3 Steps)

### 1. Deploy the Backend Web API
1. Open [Google Apps Script](https://script.google.com/) and paste `backend/Code.gs`.
2. Click **Deploy** > **New deployment** > **Web app**.
3. Set **Execute as**: *Me* and **Who has access**: *Anyone*.
4. Copy your Web App URL (`https://script.google.com/macros/s/.../exec`).

### 2. Deploy the Frontend on GitHub Pages
1. Push the contents of the `pwa/` folder to a GitHub repository.
2. In repository **Settings** > **Pages**, enable GitHub Pages from the `main` branch root (`/`).
3. Open your live GitHub Pages URL (`https://[username].github.io/[repo]/`).

### 3. Connect & Prime Offline Storage
1. In PEMS, click the **Gear** icon in the header.
2. Paste your Google Apps Script Web App URL and click **Save & Connect**.
3. Open **Asset Record & Property Details** once to cache your inventory records into IndexedDB.
4. You're all set! Disconnect from the internet anytime to test true offline creation, editing, photo capture, and deletion!

---

## Documentation
- See [`DEPLOYMENT_GUIDE.md`](file:///c:/Users/dttanggol/Desktop/PSS%20Inv/PASIMS/DEPLOYMENT_GUIDE.md) for detailed Sheets schema, Drive folder configuration, and CORS setup.
- See [`TEST_CASES.md`](file:///c:/Users/dttanggol/Desktop/PSS%20Inv/PASIMS/TEST_CASES.md) for full offline testing procedures.

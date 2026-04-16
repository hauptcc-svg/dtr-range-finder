/*
Service Worker - Offline Support & Caching
===========================================
Allows app to work offline
Caches dashboard for instant loading
Updates in background

Install on phone:
iOS: Safari → Share → Add to Home Screen
Android: Chrome → Menu → Install App
*/

const CACHE_NAME = 'dtr-trading-v1';
const RUNTIME_CACHE = 'dtr-runtime-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/health',
  '/index.html',
  '/static/css/style.css',
  '/static/js/app.js'
];

// Install event - cache essential assets
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching assets');
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {
        // Fail gracefully if some assets can't be cached
        console.warn('[Service Worker] Some assets could not be cached');
      });
    })
  );
  
  // Skip waiting to activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  
  self.clients.claim();
});

// Fetch event - serve from cache, update from network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }
  
  // API requests - network first, fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful responses
          if (response.ok) {
            const cache = caches.open(RUNTIME_CACHE);
            cache.then((c) => c.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => {
          // Fallback to cached response
          return caches.match(request).then((cachedResponse) => {
            return cachedResponse || new Response(
              JSON.stringify({ 
                success: false, 
                error: 'Offline - cached data unavailable' 
              }),
              { 
                headers: { 'Content-Type': 'application/json' },
                status: 503
              }
            );
          });
        })
    );
    return;
  }
  
  // Assets - cache first, fallback to network
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Update cache in background
        fetch(request).then((response) => {
          if (response.ok) {
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, response);
            });
          }
        }).catch(() => {});
        
        return cachedResponse;
      }
      
      // Not in cache, fetch from network
      return fetch(request)
        .then((response) => {
          if (!response.ok) {
            return response;
          }
          
          // Cache successful response
          const cache = caches.open(RUNTIME_CACHE);
          cache.then((c) => c.put(request, response.clone()));
          
          return response;
        })
        .catch(() => {
          // Network failed and nothing in cache
          return new Response('Offline - resource not available', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
              'Content-Type': 'text/plain'
            })
          });
        });
    })
  );
});

// Background sync for critical trades
self.addEventListener('sync', (event) => {
  console.log('[Service Worker] Background sync:', event.tag);
  
  if (event.tag === 'sync-trades') {
    event.waitUntil(
      fetch('/api/sync-pending-trades', { method: 'POST' })
        .then((response) => {
          console.log('[Service Worker] Trades synced');
          return response.json();
        })
        .catch(() => {
          console.error('[Service Worker] Failed to sync trades');
          // Retry after 5 minutes
          return new Promise((resolve) => {
            setTimeout(() => {
              self.registration.sync.register('sync-trades');
              resolve();
            }, 300000);
          });
        })
    );
  }
});

// Message handling
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(RUNTIME_CACHE).then(() => {
      console.log('[Service Worker] Cache cleared');
    });
  }
});

// Periodic background sync (try to sync every hour)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-trades') {
    console.log('[Service Worker] Periodic sync check');
    event.waitUntil(
      fetch('/api/live/dashboard')
        .then(() => console.log('[Service Worker] Dashboard synced'))
        .catch(() => console.warn('[Service Worker] Sync failed'))
    );
  }
});

console.log('[Service Worker] Loaded and ready');

/**
 * sw.js — Service Worker：precache + 缓存优先/网络回退 + 版本清理
 *
 * design.md §3.6：
 *   - install：precache 静态资源清单（index.html/css/js/manifest/icons）；
 *   - activate：清理旧版本缓存（版本号变更即全量失效）；
 *   - fetch：缓存优先 → 网络回退；导航请求离线时回退到应用壳（index.html）。
 *
 * 注意：Service Worker 仅在 HTTPS 或 localhost 注册（见 app.js 与 README）。
 * 发布新版本时修改 CACHE_VERSION 即可强制刷新缓存。
 */
'use strict';

var CACHE_VERSION = 'v4';
var CACHE_NAME = 'drug-inventory-' + CACHE_VERSION;

var PRECACHE = [
  './index.html',
  './css/style.css',
  './js/storage.js',
  './js/parser.js',
  './js/ocr.js',
  './js/stats.js',
  './js/scanner.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (key) { return key !== CACHE_NAME; })
              .map(function (key) { return caches.delete(key); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function (hit) {
      if (hit) return hit; // 缓存优先

      return fetch(event.request).then(function (res) {
        // 仅缓存同源 GET 成功响应（OCR CDN 等跨域资源不缓存）
        if (res && res.ok && event.request.url.indexOf(self.location.origin) === 0) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
        }
        return res;
      }).catch(function () {
        // 离线：导航请求回退到应用壳；其余（如 OCR CDN）返回 503
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    })
  );
});

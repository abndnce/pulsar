importScripts('./controller.sw.js');

var ref = self.$scramjetController;
var shouldRoute = ref.shouldRoute;
var route = ref.route;

self.addEventListener('install', function () {
  void self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  if (shouldRoute(event)) {
    event.respondWith(route(event));
  }
});

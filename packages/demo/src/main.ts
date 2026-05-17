import { PulsarTransport } from './tunnel';

const urlInput = document.getElementById('url') as HTMLInputElement;
const iframe = document.getElementById('frame') as HTMLIFrameElement;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function main() {
  const reg = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  const sw = navigator.serviceWorker.controller || reg.active;
  if (!sw) throw Error('no service worker');

  await loadScript('./controller/controller.api.js');
  const { Controller, config } = (window as any).$scramjetController;

  config.prefix = '/~/sj/';
  config.injectPath = '/controller/controller.inject.js';
  config.scramjetPath = '/scramjet/scramjet.js';
  config.wasmPath = '/scramjet/scramjet.wasm';

  const ctrl = new Controller({ serviceworker: sw, transport: new PulsarTransport() });
  await ctrl.wait();
  const frame = ctrl.createFrame(iframe);

  urlInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const raw = urlInput.value.trim();
    if (!raw) return;

    let url: string;
    try {
      url = new URL(raw).href;
    } catch {
      try {
        if (!raw.includes('.')) throw Error();
        url = new URL('https://' + raw).href;
      } catch {
        url = 'https://duckduckgo.com/?q=' + encodeURIComponent(raw);
      }
    }

    frame.go(url);
  });
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:red;padding:1em">${err}</pre>`;
});

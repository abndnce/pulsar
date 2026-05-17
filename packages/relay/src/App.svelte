<script lang="ts">
  import { onMount } from 'svelte';
  import { PulsarRelay, type WispPhase, type NostrPhase, type NostrConnStatus } from './relay';

  const relay = new PulsarRelay();

  let wispUrl = $state('');
  let nostrPhase = $state<NostrPhase>('connecting');
  let wispPhase = $state<WispPhase>('disconnected');
  let nostrStatuses = $state<NostrConnStatus[]>([]);
  let tunnelCode = $state('');

  relay.setUpdateCallback((update) => {
    nostrPhase = update.nostrPhase;
    wispPhase = update.wispPhase;
    nostrStatuses = update.nostrStatuses;
    tunnelCode = update.tunnelCode ?? '';
  });

  onMount(() => {
    relay.initNostr().catch((err) => {
      console.error('Failed to connect Nostr:', err);
    });
  });

  async function handleWispConnect() {
    try {
      await relay.connectWisp(wispUrl);
    } catch {
      // phase/detail already set by relay
    }
  }

  function handleWispDisconnect() {
    relay.disconnectWisp();
  }

  const nostrStateLabel: Record<string, string> = {
    connecting: 'Connecting\u2026',
    connected: 'Connected',
    failed: 'Failed',
  };
</script>

<main>
  <h1>Pulsar Relay</h1>

  <!-- ===== Nostr card – always visible, deemphasized ===== -->
  <div class="nostr-card">
    <div class="nostr-header">
      <span class="tunnel-code-value">{tunnelCode}</span>
      <span class="nostr-badge {nostrPhase}">
        {nostrStateLabel[nostrPhase] ?? nostrPhase}
      </span>
    </div>

    {#if nostrStatuses.length > 0}
      <div class="nostr-relay-list">
        {#each nostrStatuses as s}
          <div class="nostr-relay-item {s.state}">
            <span class="nostr-dot"></span>
            <span class="nostr-relay-url">{s.url.replace('wss://', '')}</span>
            <span class="nostr-relay-state">{nostrStateLabel[s.state] ?? s.state}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- ===== Wisp card – input vs connected ===== -->
  <div class="wisp-card">
    {#if wispPhase === 'disconnected'}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleWispConnect();
        }}
      >
        <div class="wisp-input-wrap">
          <input
            type="url"
            bind:value={wispUrl}
            placeholder="Wisp server URL (eg wss://anura.pro)"
            autocomplete="off"
            spellcheck="false"
            required
          />
          <button type="submit" class="wisp-connect-btn">Start</button>
        </div>
      </form>
      <p class="wisp-disclaimer">
        It's inconsiderate to substantively use someone else's Wisp server without getting
        permission.
      </p>
    {:else if wispPhase === 'connecting'}
      <div class="wisp-status">
        <span class="wisp-status-icon connecting"></span>
        <span class="wisp-status-text">Connecting to Wisp server\u2026</span>
      </div>
    {:else if wispPhase === 'connected'}
      <div class="wisp-connected">
        <div class="wisp-status-row">
          <span class="wisp-status-icon connected"></span>
          <span class="wisp-status-label">Connected to Wisp</span>
        </div>
        <span class="wisp-server-url">{wispUrl}</span>
        <button class="wisp-disconnect-btn" onclick={handleWispDisconnect}> Disconnect </button>
      </div>
    {/if}
  </div>
</main>

<style>
  main {
    width: min(28rem, calc(100vw - 2rem));
    margin: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  h1 {
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    margin-bottom: 0.5rem;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--m3c-on-surface);
  }

  /* ---- Nostr card (deemphasized) ---- */
  .nostr-card {
    background: var(--m3c-surface-container-high);
    border-radius: 0.75rem;
    padding: 0.75rem 1rem;
    font-size: 0.8rem;
  }

  .nostr-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .nostr-badge {
    font-size: 0.7rem;
    font-weight: 500;
    padding: 0.125rem 0.5rem;
    border-radius: 0.375rem;
  }

  .nostr-badge.connecting {
    background: var(--m3c-tertiary-container);
    color: var(--m3c-on-tertiary-container);
  }

  .nostr-badge.connected {
    background: var(--m3c-primary-container);
    color: var(--m3c-on-primary-container);
  }

  .nostr-badge.failed {
    background: var(--m3c-error-container);
    color: var(--m3c-on-error-container);
  }

  .tunnel-code-value {
    font-size: 1rem;
    font-weight: 700;
    color: var(--m3c-primary);
    letter-spacing: 0.07em;
  }

  .nostr-relay-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .nostr-relay-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.7rem;
  }

  .nostr-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .nostr-relay-item.connected .nostr-dot {
    background: var(--m3c-primary);
  }

  .nostr-relay-item.failed .nostr-dot {
    background: var(--m3c-error);
  }

  .nostr-relay-item.connecting .nostr-dot {
    background: var(--m3c-tertiary);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  .nostr-relay-url {
    color: var(--m3c-on-surface);
    flex: 1;
    word-break: break-all;
  }

  .nostr-relay-state {
    color: var(--m3c-on-surface-variant);
    font-size: 0.65rem;
  }

  /* ---- Wisp card ---- */
  .wisp-card {
    background: var(--m3c-surface-container-high);
    border-radius: 0.75rem;
    padding: 1rem;
  }

  .wisp-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .wisp-card input {
    width: 100%;
    padding: 1rem 5.5rem 1rem 1rem;
    outline: none;
    border-radius: 1rem;
    border: none;
    background: var(--m3c-surface-container-highest);
    color: var(--m3c-on-surface);
    font-size: 1rem;
    box-sizing: border-box;
  }

  .wisp-card input::placeholder {
    color: var(--m3c-on-surface-variant);
  }

  .wisp-connect-btn {
    position: absolute;
    right: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--m3c-primary);
    color: var(--m3c-on-primary);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }

  .wisp-disclaimer {
    color: var(--m3c-on-surface-variant);
    font-size: 0.75rem;
    margin: 0.75rem 0 0;
    line-height: 1.4;
    text-align: center;
  }

  .wisp-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  .wisp-status-icon {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .wisp-status-icon.connecting {
    background: var(--m3c-tertiary);
    animation: pulse 1.2s ease-in-out infinite;
  }

  .wisp-status-icon.connected {
    background: var(--m3c-primary);
    box-shadow: 0 0 6px var(--m3c-primary);
  }

  .wisp-status-text {
    color: var(--m3c-on-surface);
    font-size: 0.9rem;
  }

  .wisp-connected {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .wisp-status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .wisp-status-label {
    color: var(--m3c-on-surface);
    font-size: 0.9rem;
    font-weight: 600;
  }

  .wisp-server-url {
    color: var(--m3c-on-surface-variant);
    font-size: 0.75rem;
    word-break: break-all;
  }

  .wisp-disconnect-btn {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--m3c-error-container);
    color: var(--m3c-on-error-container);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
</style>

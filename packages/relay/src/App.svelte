<script lang="ts">
  import { PulsarRelay, type RelayPhase, type NostrConnStatus } from "./relay";

  const relay = new PulsarRelay();

  let wispUrl = $state("");
  let phase = $state<RelayPhase>("idle");
  let detail = $state("");
  let nostrStatuses = $state<NostrConnStatus[]>([]);
  let eventCount = $state(0);
  let tunnelCode = $state("");
  let lastError = $state("");

  relay.setUpdateCallback((update) => {
    phase = update.phase;
    detail = update.detail;
    nostrStatuses = update.nostrStatuses;
    eventCount = update.eventCount;
    tunnelCode = update.tunnelCode ?? "";
  });

  const phaseLabel: Record<RelayPhase, string> = {
    idle: "",
    "connecting-nostr": "Connecting to Nostr relays\u2026",
    "connecting-wisp": "Connecting to Wisp server\u2026",
    ready: "Ready",
    failed: "Failed",
  };

  async function handleStart() {
    lastError = "";
    phase = "connecting-nostr";

    try {
      await relay.start(wispUrl);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      phase = "failed";
    }
  }

  function handleStop() {
    relay.stop();
    phase = "idle";
    detail = "";
    lastError = "";
  }

  const nostrStateLabel: Record<string, string> = {
    connecting: "Connecting\u2026",
    connected: "Connected",
    failed: "Failed",
  };
</script>

<main>
  {#if phase === "idle" || phase === "failed"}
    <div class="brand">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2"/>
        <circle cx="16" cy="16" r="6" fill="currentColor"/>
        <line x1="16" y1="2" x2="16" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="16" y1="22" x2="16" y2="30" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="2" y1="16" x2="10" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="22" y1="16" x2="30" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <h1>Pulsar Relay</h1>
    </div>

    <form
      onsubmit={(e) => {
        e.preventDefault();
        handleStart();
      }}
    >
      <div class="input-wrap">
        <input
          type="url"
          bind:value={wispUrl}
          placeholder="Wisp server URL (eg wss://anura.pro)"
          autocomplete="off"
          spellcheck="false"
          required
        />
        <button type="submit" class="start">Start</button>
      </div>
    </form>

    {#if lastError}
      <div class="below">
        <p class="error">{lastError}</p>
      </div>
    {/if}
  {:else}
    <div class="dashboard">
      <div class="status-card">
        <div class="status-row">
          <span class="status-label">Nostr Relays</span>
          <span class="status-value">
            {nostrStatuses.filter((s) => s.state === "connected").length}/{nostrStatuses.length}
          </span>
        </div>
        <div class="relay-list">
          {#each nostrStatuses as s}
            <div class="relay-item {s.state}">
              <span class="relay-dot"></span>
              <span class="relay-url">{s.url.replace("wss://", "")}</span>
              <span class="relay-state">{nostrStateLabel[s.state] ?? s.state}</span>
            </div>
          {/each}
        </div>
      </div>

      {#if tunnelCode}
        <div class="code-card">
          <span class="code-label">Tunnel code</span>
          <span class="code-value">{tunnelCode}</span>
        </div>
      {/if}

      <div class="info-card">
        <div class="info-row">
          <span class="info-label">Events relayed</span>
          <span class="info-value">{eventCount}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Status</span>
          <span class="info-value status-detail">{detail || phaseLabel[phase]}</span>
        </div>
      </div>

      <button class="stop" onclick={handleStop}>Stop</button>
    </div>
  {/if}
</main>

<p class="disclaimer">
  It's inconsiderate to substantively use someone else's Wisp server
  without getting permission.
</p>

<style>
  main {
    width: min(28rem, calc(100vw - 2rem));
    margin: auto;
  }

  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
    margin-bottom: 1.5rem;
    color: var(--m3c-primary);
  }

  .brand h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--m3c-on-surface);
  }

  form {
    display: flex;
    flex-direction: column;
  }

  .input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  input {
    width: 100%;
    padding: 1rem 5.5rem 1rem 1rem;
    outline: none;
    border-radius: 1rem;
    border: none;
    background: var(--m3c-surface-container-high);
    color: var(--m3c-on-surface);
    font-size: 1rem;
    box-sizing: border-box;
  }

  input::placeholder {
    color: var(--m3c-on-surface-variant);
  }

  .start {
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

  .below {
    text-align: center;
    min-height: 1rem;
    margin-top: 0.625rem;
    padding-inline: 0.25rem;
    font-size: 0.8rem;
    line-height: 1;
  }

  .error {
    margin: 0;
    color: var(--m3c-error);
  }

  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .status-card,
  .code-card,
  .info-card {
    background: var(--m3c-surface-container-high);
    border-radius: 0.75rem;
    padding: 1rem;
  }

  .status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.625rem;
  }

  .status-label {
    color: var(--m3c-on-surface-variant);
    font-size: 0.8rem;
  }

  .status-value {
    color: var(--m3c-on-surface);
    font-size: 0.8rem;
    font-weight: 600;
  }

  .relay-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .relay-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }

  .relay-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .relay-item.connected .relay-dot {
    background: var(--m3c-primary);
    box-shadow: 0 0 6px var(--m3c-primary);
  }

  .relay-item.failed .relay-dot {
    background: var(--m3c-error);
  }

  .relay-item.connecting .relay-dot {
    background: var(--m3c-tertiary);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .relay-url {
    color: var(--m3c-on-surface);
    flex: 1;
    word-break: break-all;
  }

  .relay-state {
    color: var(--m3c-on-surface-variant);
    font-size: 0.75rem;
  }

  .code-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    text-align: center;
  }

  .code-label {
    color: var(--m3c-on-surface-variant);
    font-size: 0.75rem;
  }

  .code-value {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--m3c-primary);
    letter-spacing: 0.05em;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0;
  }

  .info-row + .info-row {
    border-top: 1px solid var(--m3c-outline-variant);
  }

  .info-label {
    color: var(--m3c-on-surface-variant);
    font-size: 0.8rem;
  }

  .info-value {
    color: var(--m3c-on-surface);
    font-size: 0.8rem;
  }

  .status-detail {
    color: var(--m3c-primary);
  }

  .stop {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--m3c-error-container);
    color: var(--m3c-on-error-container);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    align-self: center;
  }

  .disclaimer {
    color: var(--m3c-on-surface-variant);
    font-size: 0.75rem;
    margin-top: 1.5rem;
    line-height: 1.4;
    text-align: center;
    max-width: 28rem;
    margin-inline: auto;
  }
</style>

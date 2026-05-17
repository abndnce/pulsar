<script lang="ts">
  import { PulsarRelay } from "./relay";

  const relay = new PulsarRelay();

  let phase = $state<"idle" | "connected" | "failed">("idle");
  let eventCount = $state(0);
  let subCount = $state(0);
  let statuses = $state<{ relay: string; type: string; error?: string }[]>([]);
  let customRelayUrl = $state("");
  let lastError = $state("");

  relay.setUpdateCallback((update) => {
    eventCount = update.eventCount;
    subCount = update.subCount;
    statuses = update.status.map((s) => {
      if (s.type === "idle")
        return { relay: "", type: "idle" };
      return {
        relay: (s as any).relay,
        type: s.type,
        error: (s as any).error,
      };
    });

    const connected = statuses.some((s) => s.type === "connected");
    const anyFailed = statuses.some((s) => s.type === "failed");

    if (connected) {
      phase = "connected";
    } else if (anyFailed && phase !== "idle") {
      phase = "failed";
    }
  });

  async function handleConnect() {
    lastError = "";
    phase = "idle";

    const relays = customRelayUrl.trim()
      ? customRelayUrl.split(",").map((u) => u.trim()).filter(Boolean)
      : undefined;

    try {
      await relay.connect(relays);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      phase = "failed";
    }
  }

  function handleDisconnect() {
    relay.disconnect();
    phase = "idle";
    lastError = "";
  }

  const phaseLabel: Record<string, string> = {
    idle: "Disconnected",
    connected: "Connected",
    failed: "Failed",
  };
</script>

<main>
  <h1>Pulsar Relay</h1>

  {#if phase === "idle" || phase === "failed"}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        handleConnect();
      }}
    >
      <div class="input-wrap">
        <input
          type="text"
          bind:value={customRelayUrl}
          placeholder="Upstream relays (comma-separated, or leave blank for defaults)"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="submit" class="connect" disabled={phase === "idle" && statuses.length > 0}>
          Connect
        </button>
      </div>
      <p class="hint">
        Defaults: wss://nostr.data.haus, wss://kotukonostr.onrender.com
      </p>
    </form>

    {#if lastError}
      <div class="error-box">
        {lastError}
      </div>
    {/if}
  {:else}
    <div class="dashboard">
      <div class="stat-row">
        <span class="stat-label">Events stored:</span>
        <span class="stat-value">{eventCount}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Subscriptions:</span>
        <span class="stat-value">{subCount}</span>
      </div>

      <div class="relay-list">
        {#each statuses as s}
          <div class="relay-item {s.type}">
            <span class="relay-dot"></span>
            <span class="relay-url">{s.relay}</span>
            {#if s.type === "connected"}
              <span class="relay-badge ok">OK</span>
            {:else if s.type === "failed"}
              <span class="relay-badge err">ERR</span>
            {:else if s.type === "connecting"}
              <span class="relay-badge pending">...</span>
            {/if}
            {#if s.error}
              <span class="relay-error">{s.error}</span>
            {/if}
          </div>
        {/each}
      </div>

      <p class="status-line">{phaseLabel[phase]}</p>
      <button class="disconnect" onclick={handleDisconnect}>
        Disconnect
      </button>
    </div>
  {/if}
</main>

<style>
  main {
    width: min(36rem, calc(100vw - 2rem));
    margin: 0 auto;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 1.5rem;
    color: #00c853;
    text-align: center;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  input {
    width: 100%;
    padding: 0.75rem 6rem 0.75rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid #333;
    background: #1a1a1a;
    color: #e0e0e0;
    font-size: 0.875rem;
    outline: none;
  }

  input:focus {
    border-color: #00c853;
  }

  input::placeholder {
    color: #666;
  }

  .hint {
    font-size: 0.75rem;
    color: #666;
    margin: 0;
  }

  .connect {
    position: absolute;
    right: 0.375rem;
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    border: none;
    background: #00c853;
    color: #000;
    font-size: 0.8rem;
    font-weight: 500;
  }

  .connect:disabled {
    opacity: 0.5;
  }

  .error-box {
    margin-top: 0.75rem;
    padding: 0.75rem;
    border-radius: 0.375rem;
    background: #2d1b1b;
    color: #ff6b6b;
    font-size: 0.8rem;
    border: 1px solid #4a2020;
  }

  .dashboard {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    background: #1a1a1a;
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }

  .stat-label {
    color: #888;
  }

  .stat-value {
    color: #00c853;
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
    padding: 0.5rem 0.75rem;
    background: #1a1a1a;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    flex-wrap: wrap;
  }

  .relay-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .relay-item.connected .relay-dot {
    background: #00c853;
  }

  .relay-item.failed .relay-dot {
    background: #ff5252;
  }

  .relay-item.connecting .relay-dot {
    background: #ffd740;
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .relay-url {
    color: #ccc;
    flex: 1;
    word-break: break-all;
  }

  .relay-badge {
    font-size: 0.7rem;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-weight: 600;
  }

  .relay-badge.ok {
    background: #1b3a1b;
    color: #69f0ae;
  }

  .relay-badge.err {
    background: #3a1b1b;
    color: #ff6b6b;
  }

  .relay-badge.pending {
    background: #3a3a1b;
    color: #ffd740;
  }

  .relay-error {
    width: 100%;
    color: #ff6b6b;
    font-size: 0.75rem;
    padding-left: 1rem;
  }

  .status-line {
    text-align: center;
    color: #666;
    font-size: 0.8rem;
    margin: 0;
  }

  .disconnect {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #4a2020;
    background: #2d1b1b;
    color: #ff6b6b;
    font-size: 0.8rem;
    font-weight: 500;
    align-self: center;
  }
</style>

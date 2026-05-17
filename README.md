🚧🚧🚧 WIP 🚧🚧🚧

Pulsar is a internet transport. It's powered by WebRTC, so there's no limitations on what and where tunnels have to be. And its specification is one sentence: init with empty `keepalive` channel, send raw TCP over `socket/<hostname:port>` channels, where channel means a DataChannel with `binaryType: "arrayBuffer"` and `ordered: true`.

<details>

<summary>Okay, it's not just that, there's also connecting</summary>

## The ideal way to specify a tunnel is an IP address, all else follows

An IP address is easy to share and skips the intensive and blockable process of signalling.

We can be much more direct when we use IP addresses. We can use [WebRTC Direct](https://github.com/libp2p/specs/blob/master/webrtc/webrtc-direct.md) instead). We can skip encryption since that's TCP's job.

But without signalling, we have to hardcode a few things:

## Port

There were 4393 known pulsars when Pulsar was made, so Pulsar uses port 4393.

## `ufrag` and `pwd`

Normally each peer generates and exchanges a unique `ufrag` (identifier, min 4 chars, max 256 chars) and `pwd` (key for signing, min 22 chars, max 256 chars) during signalling, and uses them in each UDP packet from there. Pulsar always uses the `ufrag` "pulsar" and the `pwd` "pulsarpulsarpulsarpuls".

## `key`, `certificate`, and `fingerprint`

Normally each peer generates a private `key`, from it derives a public key `certificate`, and from that derives a `fingerprint`, and uses them to authenticate the DTLS handshake.

Tunnels must always use Pulsar's PKCS#8 P-256 key:

```
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkdA44UARw55aA4wy
Elp/vqaU3wXDh8DBYhAxM/7ZLRahRANCAASuVw5r45AERNd5Ti/DWgXHd7pOxgbr
rFNpgeRvAqI5t3yQ5jOgtHORVN8sg3G6uJWTXm2mHwFnRD+lp3BJI739
-----END PRIVATE KEY-----
```

```
-----BEGIN CERTIFICATE-----
MIIBdzCCAR2gAwIBAgIUa60SsYmtqbUvTq6GMnD2hMh1AJIwCgYIKoZIzj0EAwIw
ETEPMA0GA1UEAwwGcHVsc2FyMB4XDTI2MDUxNjE4NTcyMFoXDTM2MDUxMzE4NTcy
MFowETEPMA0GA1UEAwwGcHVsc2FyMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
rlcOa+OQBETXeU4vw1oFx3e6TsYG66xTaYHkbwKiObd8kOYzoLRzkVTfLINxuriV
k15tph8BZ0Q/padwSSO9/aNTMFEwHQYDVR0OBBYEFL/9f7vNbXwQxtvek42L+pJ/
jvuNMB8GA1UdIwQYMBaAFL/9f7vNbXwQxtvek42L+pJ/jvuNMA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgILT4sZfw9rjX0GPH+onIZneeevHwa6IG
rFlLfzYN+g4CIQCI/+nN1A3TyiUhT6rD7OzT59+l2X1VYHf+2GzrsD8M2Q==
-----END CERTIFICATE-----
```

```
sha-256 F1:85:10:8F:36:FF:58:D8:D0:4B:52:D7:ED:DC:5C:28:AE:7D:DB:54:0E:2A:DD:C7:C3:94:EA:A1:27:D0:4E:78
```

## `signatureHash`

On the server (using werift), the `signatureHash` must be passed as an object `{ hash: 4, signature: 3 }` (sha256 + ecdsa), not as the string `"sha-256"`. The browser client ignores this — its DTLS certificate is auto-generated.

## Connecting directly (browser client)

The browser connects without any signalling channel. Since the server doesn't validate the client's ICE credentials or DTLS fingerprint (STUN MESSAGE-INTEGRITY is unchecked, DTLS certificate verification is disabled), the client can keep its browser-generated credentials for the local SDP. It only needs to craft a remote description SDP describing the server:

1. Create an `RTCPeerConnection`
2. Set the offer from `createOffer()` as the local description
3. Craft a remote description (the server's SDP). The SDP must include a trailing empty line so Chrome's parser finds a line terminator for the last attribute:

```
v=0
o=- 111 222 IN IP4 0.0.0.0
s=-
t=0 0
m=application [REPLACE WITH TARGET PORT] UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 [REPLACE WITH TARGET IP]
a=ice-ufrag:pulsar
a=ice-pwd:pulsarpulsarpulsarpuls
a=fingerprint:sha-256 F1:85:10:8F:36:FF:58:D8:D0:4B:52:D7:ED:DC:5C:28:AE:7D:DB:54:0E:2A:DD:C7:C3:94:EA:A1:27:D0:4E:78
a=setup:active
a=mid:0
a=sctp-port:5000

```

4. Add the server's ICE candidate via `addIceCandidate()` with `sdpMid: "0"`.

## DTLS role

In WebRTC Direct mode the server acts as the DTLS active party (initiates the handshake). In werift terms (server side) this means the server sets its DTLS role to `"client"` (active = client), while the browser client auto-negotiates the passive role (`"server"`) via the SDP `a=setup:` attribute swap.

## SCTP wiring order (server side)

On the server (using werift), the SCTP transport must be wired to the DTLS transport via `setDtlsTransport()`) before DTLS starts. This ensures the SCTP data receiver is registered in time to receive the client's SCTP INIT immediately after the DTLS handshake completes. The browser client handles this internally.

## Server accept flow

The server binds a single UDP port and demultiplexes incoming connections by client source address (IP + port):

1. Open a raw UDP socket with `Deno.listenDatagram`
2. Listen for incoming packets in a loop:
   - **STUN Binding Request** from a new source → respond with a STUN Binding Response (ICE Lite behaviour), create a new session with its own DTLS + SCTP + keepalive stack
   - **DTLS / SCTP data** → route to the existing session for that source address
3. Each session:
   - Creates a `PeerTransport` — a virtual transport that reads/writes the shared socket but only for that peer's address
   - Creates `RTCDtlsTransport` wired to the `PeerTransport` (no werift ICE involved — the transport mimics the ICE connection interface with an `Event<[Uint8Array]>` onData)
   - Creates `RTCSctpTransport` wired to DTLS **before** DTLS starts (prevents losing the client's SCTP INIT)
   - Starts DTLS with role `"client"` (active), using fixed certificate and `debug: {}` in the config
   - Starts SCTP, then creates the keepalive DataChannel with `id: 0, negotiated: true`

The server blindly accepts the client's fingerprint (DTLS certificate verification is disabled), since client authenticity is established later.

</details>

## Pulsar servers

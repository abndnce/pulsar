/**
 * Every client connection, regardless of transport mode, satisfies this interface.
 */
export interface PulsarClientConnection {
  keepalive: RTCDataChannel;
  pc: RTCPeerConnection;
  close(): Promise<void>;
}

import type {
  RTCDataChannel,
  RTCDtlsTransport,
  RTCSctpTransport,
} from "npm:werift";

/**
 * Every server connection, regardless of transport mode, satisfies this interface.
 */
export interface PulsarServerConnection {
  dtlsTransport: RTCDtlsTransport;
  sctpTransport: RTCSctpTransport;
  keepalive: RTCDataChannel;
  close(): Promise<void>;
}

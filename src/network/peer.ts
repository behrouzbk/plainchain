import type WebSocket from "ws";
import { decodeMessage, encodeMessage, type Message } from "./protocol.js";

export type PeerDirection = "inbound" | "outbound";

export class Peer {
  public remoteNodeId?: string;
  public remoteHeight?: number;
  public remoteListenAddress?: string;
  /** Transport-level remote IP (inbound only), for the per-address limit. */
  public remoteIp?: string;
  /** Pending handshake deadline; cleared once the handshake is accepted. */
  public handshakeTimer?: NodeJS.Timeout;

  constructor(
    public readonly id: string,
    private readonly socket: WebSocket,
    public readonly direction: PeerDirection,
  ) {}

  send(message: Message): void {
    this.socket.send(encodeMessage(message));
  }

  /**
   * @param onMalformed Called instead of `handler` when a frame can't be
   * decoded into a valid message, or when the socket errors (e.g. a frame
   * over the size limit -- `ws` surfaces that as an error and closes).
   * Without this, a peer sending garbage would throw inside the socket's
   * event handler and take the whole process down.
   */
  onMessage(handler: (message: Message) => void, onMalformed: (error: Error) => void): void {
    this.socket.on("message", (data) => {
      let message: Message;
      try {
        message = decodeMessage(data.toString());
      } catch (err) {
        onMalformed(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      handler(message);
    });
    this.socket.on("error", (err) => onMalformed(err));
  }

  onClose(handler: () => void): void {
    this.socket.on("close", handler);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

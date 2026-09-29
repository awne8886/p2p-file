/// <reference types="vite/client" />

/** Build-time settings. See README → "Static hosting" and `client/.env.static`. */
interface ImportMetaEnv {
  /** `server` (default): the PizzaDrop signaling server. `peerjs`: a PeerJS server, for static hosting. */
  readonly VITE_SIGNALING?: string;
  /** WebSocket URL of a PizzaDrop signaling server. Default: `/ws` on the page's own origin. */
  readonly VITE_SIGNAL_URL?: string;
  /** PeerJS server WebSocket endpoint. Default: the free public server, `wss://0.peerjs.com/peerjs`. */
  readonly VITE_PEERJS_URL?: string;
  /** PeerJS server API key. Default: `peerjs`. */
  readonly VITE_PEERJS_KEY?: string;
  /** JSON array of RTCIceServer objects (STUN/TURN) used with PeerJS signaling. */
  readonly VITE_ICE_SERVERS?: string;
  /** Canonical origin for share links, e.g. `https://drop.example.com`. Default: the page's origin. */
  readonly VITE_PUBLIC_URL?: string;
  /** Share-code length with PeerJS signaling (5 or 6). */
  readonly VITE_CODE_LENGTH?: string;
}

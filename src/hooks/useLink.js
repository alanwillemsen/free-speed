// The dual-phone link, one of two transports with the same hook surface:
//   useRelayLink — WebSocket relay on the Cloudflare Worker in relay/ (needs
//                  VITE_RELAY_URL). Works phone-to-phone across cell carriers.
//   usePeerLink  — WebRTC via PeerJS. Kept as the fallback when no relay is
//                  configured; direct connections across two carrier NATs
//                  mostly fail without a TURN server.
import { usePeerLink } from './usePeerLink';
import { useRelayLink, relayConfigured } from './useRelayLink';

export const useLink = relayConfigured() ? useRelayLink : usePeerLink;
export const linkTransport = relayConfigured() ? 'relay' : 'peerjs';

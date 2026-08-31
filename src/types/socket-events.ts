import type { Server, Socket } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import type { ChatMessage } from './chat.types';

// ---------------------------------------------------------------------------
// Server → Client event payloads
// ---------------------------------------------------------------------------

export interface ServerHelloPayload {
  socketId: string;
  pingInterval: number;
  pingTimeout: number;
  authenticated: boolean;
  userId?: string;
}

export interface AuthErrorPayload {
  code: 'AUTH_TOKEN_EXPIRED' | 'AUTH_TOKEN_INVALID';
  message: string;
}

export interface RoomEventPayload {
  room: string;
}

export interface GenericErrorPayload {
  message: string;
}

export interface RoundStartedPayload {
  id: string;
  mode: string;
  status: string;
  startTime: unknown;
  endTime: unknown;
  startPrice: unknown;
  priceRanges: unknown;
}

export interface PredictionPlacedPayload {
  roundId: string;
  predictionId: string;
  amount: unknown;
  side: unknown;
  priceRange: unknown;
}

/** Payload for live bet acceptance broadcasts (Issue #376). */
export interface BetAcceptedPayload {
  roundId?: string;
  address: string;
  amount: string;
  side?: 'UP' | 'DOWN';
  mode: 'UP_DOWN' | 'PRECISION';
  state: string;
  txHash?: string;
}

export interface BetConfirmedPayload {
  betId: string;
  txHash: string;
  mode: 'UP_DOWN' | 'PRECISION';
}

export interface BetResolvedPayload {
  betId: string;
  roundId: string;
  won: boolean;
  payout: number;
}

export interface BetFailedPayload {
  betId: string;
  failureReason: string;
}

export interface RoundResolvedPayload {
  id: string;
  status: string;
  startPrice: unknown;
  endPrice: unknown;
  resolvedAt: unknown;
  predictions: number;
  winners: number;
}

export interface PriceUpdatePayload {
  asset: string;
  price: number | string;
  timestamp: string;
}

export interface RoundUpdatePayload {
  id: string;
  mode: string;
  status: string;
  startTime: string | null;
  endTime: string | null;
  startPrice: string | null;
  endPrice: string | null;
  poolUp: string;
  poolDown: string;
  priceRanges: unknown;
  resolvedAt: string | null;
}

export interface NotificationNewPayload {
  id: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
  isRead: boolean;
  createdAt: string;
}

export interface UnreadCountPayload {
  unreadCount: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Client → Server event payloads
// ---------------------------------------------------------------------------

export interface JoinRoundPayload {
  roundId?: string;
}

export interface ChatSendPayload {
  content: string;
}

export type ChatAckPayload =
  | { ok: true; message: ChatMessage }
  | {
      ok: false;
      error: string;
      code: 'AUTH_REQUIRED' | 'INVALID_CONTENT' | 'RATE_LIMITED' | 'SEND_FAILED';
    };

export type SessionCheckpointPayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Resume payload (re-exported from multiplayer-session.service)
// ---------------------------------------------------------------------------

export interface ResumePayload {
  rooms: string[];
  metadata: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Event map interfaces for typed Socket.IO
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'server:hello': (data: ServerHelloPayload) => void;
  'auth:error': (data: AuthErrorPayload) => void;
  'room:joined': (data: RoomEventPayload) => void;
  'room:left': (data: RoomEventPayload) => void;
  'session:resume': (data: ResumePayload) => void;
  error: (data: GenericErrorPayload) => void;

  'round:started': (data: RoundStartedPayload) => void;
  'prediction:placed': (data: PredictionPlacedPayload) => void;
  'bet:accepted': (data: BetAcceptedPayload) => void;
  'bet:confirmed': (data: BetConfirmedPayload) => void;
  'bet:resolved': (data: BetResolvedPayload) => void;
  'bet:failed': (data: BetFailedPayload) => void;
  'round:resolved': (data: RoundResolvedPayload) => void;
  'price:update': (data: PriceUpdatePayload) => void;
  'price_update': (data: PriceUpdatePayload) => void;
  'chat:message': (data: ChatMessage) => void;
  'notification:new': (data: NotificationNewPayload) => void;
  'notification:unread-count': (data: UnreadCountPayload) => void;
  'round_update': (data: RoundUpdatePayload) => void;
}

export interface ClientToServerEvents {
  'join:round': (data?: JoinRoundPayload | string) => void;
  'leave:round': (data?: JoinRoundPayload | string) => void;
  'join:chat': () => void;
  'leave:chat': () => void;
  'chat:send': (data: ChatSendPayload, ack: (response: ChatAckPayload) => void) => void;
  'join:notifications': () => void;
  'session:checkpoint': (data: SessionCheckpointPayload) => void;
}

export interface SocketData {
  userId?: string;
  walletAddress?: string;
  /** Unix epoch (ms) at which the JWT expires. */
  tokenExpiresAt?: number;
}

// ---------------------------------------------------------------------------
// Typed Socket.IO server and socket aliases
// ---------------------------------------------------------------------------

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>;

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>;

// ---------------------------------------------------------------------------
// Socket.IO client-side type for frontend consumption
// ---------------------------------------------------------------------------

/**
 * Typed Socket.IO client for frontend consumption.
 *
 * Usage:
 * ```typescript
 * import { io } from 'socket.io-client';
 * import type { TypedClientSocket } from '../../src/types/socket-events';
 *
 * const socket: TypedClientSocket = io('https://api.tevalabs.com', {
 *   auth: { token: 'YOUR_JWT' },
 * });
 *
 * socket.on('round:started', (data) => {
 *   console.log(data.id); // fully typed
 * });
 *
 * socket.emit('join:round', { roundId: 'abc' });
 * ```
 */
export type TypedClientSocket = import('socket.io-client').Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

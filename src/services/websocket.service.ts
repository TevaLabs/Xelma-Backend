import { Server as SocketIOServer } from 'socket.io';
import { DispatchChannel } from '@prisma/client';
import logger from '../utils/logger';
import deadLetterQueueService from './dead-letter-queue.service';
import { websocketEmitsTotal } from '../metrics/application.metrics';
import { prisma } from '../lib/prisma';

/**
 * Centralized event names so DLQ replay can map a stored `eventName` back
 * onto the right emit method without string drift.
 */
export const WebSocketEvents = {
  RoundStarted: 'round:started',
  PredictionPlaced: 'prediction:placed',
  RoundResolved: 'round:resolved',
  PriceUpdate: 'price:update',
  ChatMessage: 'chat:message',
  NotificationNew: 'notification:new',
  NotificationUnreadCount: 'notification:unread-count',
  RoundUpdate: 'round_update',
  PriceUpdateV2: 'price_update',
} as const;

export type WebSocketEventName =
  (typeof WebSocketEvents)[keyof typeof WebSocketEvents];

interface SafeEmitInput {
  room: string;
  event: WebSocketEventName;
  payload: any;
  userId?: string | null;
}

export class WebSocketService {
  private static _singleton = new WebSocketService();
  private io: SocketIOServer | null = null;

  static get instance(): WebSocketService {
    return WebSocketService._singleton;
  }

  static emitRoundUpdate(round: any): void {
    WebSocketService.instance.emitRoundUpdate(round);
  }

  static emitPriceUpdate(payload: { asset: string; price: number | string }): void {
    WebSocketService.instance.emitPriceUpdate(payload.asset, payload.price);
  }

  /**
   * Initialize the WebSocket service with Socket.IO instance
   */
  initialize(io: SocketIOServer): void {
    this.io = io;
    logger.info("WebSocket service initialized");
  }

  /**
   * Get the Socket.IO instance
   */
  getIO(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Emit to a room; if the socket layer is not initialized or the underlying
   * `emit` throws, record the dispatch in the dead-letter queue so it can be
   * replayed (Issue #193). Never throws — emits are fire-and-forget on the
   * caller's hot path.
   */
  private safeEmit(input: SafeEmitInput): void {
    if (!this.io) {
      logger.warn(`WebSocket not initialized, cannot emit ${input.event}`);
      websocketEmitsTotal.inc({ event: input.event, outcome: 'unavailable' });
      // fire-and-forget — DLQ helper swallows its own errors
      void deadLetterQueueService.record({
        channel: DispatchChannel.WEBSOCKET_EMIT,
        eventName: input.event,
        userId: input.userId ?? null,
        payload: { room: input.room, data: input.payload },
        error: new Error(`WebSocket not initialized when emitting ${input.event}`),
      });
      return;
    }

    try {
      this.io.to(input.room).emit(input.event, input.payload);
      websocketEmitsTotal.inc({ event: input.event, outcome: 'success' });
    } catch (err) {
      logger.error(`Failed to emit ${input.event}`, { error: err });
      websocketEmitsTotal.inc({ event: input.event, outcome: 'failure' });
      void deadLetterQueueService.record({
        channel: DispatchChannel.WEBSOCKET_EMIT,
        eventName: input.event,
        userId: input.userId ?? null,
        payload: { room: input.room, data: input.payload },
        error: err,
      });
    }
  }

  /**
   * Replay handler used by the DLQ. Re-emits an event using the stored
   * payload. Throws if the socket layer is still not initialized so the
   * DLQ records another attempt instead of falsely resolving the row.
   */
  replayEmit(
    eventName: string | null,
    payload: { room?: string; data?: any } | any,
  ): void {
    if (!this.io) {
      throw new Error('WebSocket not initialized; cannot replay emit');
    }
    if (!eventName) {
      throw new Error('Missing eventName for websocket replay');
    }
    const room = payload?.room as string | undefined;
    const data = payload?.data;
    if (!room) {
      throw new Error('Missing room for websocket replay');
    }
    this.io.to(room).emit(eventName, data);
  }

  /**
   * Emit event when a new round starts
   */
  /**
   * Emit event when a new round starts
   */
  emitRoundStarted(round: any): void {
    const payload = {
      id: round.id,
      mode: round.mode,
      status: round.status,
      startTime: round.startTime,
      endTime: round.endTime,
      startPrice: round.startPrice,
      priceRanges: round.priceRanges,
    };
    this.safeEmit({ room: 'round', event: WebSocketEvents.RoundStarted, payload });
    logger.info(`Emitted round:started for round ${round.id}`);

    // Also emit the real-time round_update event
    this.emitRoundUpdate(round);
  }

  /**
   * Emit event when a prediction is placed
   */
  emitPredictionPlaced(prediction: any, roundId: string): void {
    const payload = {
      roundId,
      predictionId: prediction.id,
      amount: prediction.amount,
      side: prediction.side,
      priceRange: prediction.priceRange,
    };
    this.safeEmit({ room: 'round', event: WebSocketEvents.PredictionPlaced, payload });
    logger.info(`Emitted prediction:placed for prediction ${prediction.id}`);
  }

  /**
   * Emit event when a round is resolved
   */
  emitRoundResolved(round: any): void {
    const payload = {
      id: round.id,
      status: round.status,
      startPrice: round.startPrice,
      endPrice: round.endPrice,
      resolvedAt: round.resolvedAt,
      predictions: round.predictions?.length || 0,
      winners: round.predictions?.filter((p: any) => p.won === true).length || 0,
    };
    this.safeEmit({ room: 'round', event: WebSocketEvents.RoundResolved, payload });
    logger.info(`Emitted round:resolved for round ${round.id}`);

    // Also emit the real-time round_update event
    this.emitRoundUpdate(round);
  }

  /**
   * Emit real-time round status and pool updates to general and round-specific rooms
   */
  emitRoundUpdate(round: any): void {
    const payload = {
      id: round.id,
      mode: round.mode,
      status: round.status,
      startTime: round.startTime?.toISOString?.() || round.startTime,
      endTime: round.endTime?.toISOString?.() || round.endTime,
      startPrice: round.startPrice ? Number(round.startPrice) : null,
      endPrice: round.endPrice ? Number(round.endPrice) : null,
      poolUp: round.poolUp ? Number(round.poolUp) : 0,
      poolDown: round.poolDown ? Number(round.poolDown) : 0,
      priceRanges: round.priceRanges,
      resolvedAt: round.resolvedAt?.toISOString?.() || round.resolvedAt,
    };

    // Broadcast to general 'round' room
    this.safeEmit({ room: 'round', event: WebSocketEvents.RoundUpdate, payload });

    // Broadcast to specific round room
    this.safeEmit({ room: `round:${round.id}`, event: WebSocketEvents.RoundUpdate, payload });
    logger.info(`Emitted round_update for round ${round.id}`);
  }

  /**
   * Emit price update event to general room and each active round's room
   */
  async emitPriceUpdate(asset: string, price: number | string): Promise<void> {
    const payload = {
      asset,
      price,
      timestamp: new Date().toISOString(),
    };
    
    // Broadcast legacy event to general room
    this.safeEmit({ room: 'round', event: WebSocketEvents.PriceUpdate, payload });

    // Broadcast new real-time price update to general room
    this.safeEmit({ room: 'round', event: WebSocketEvents.PriceUpdateV2, payload });

    // Broadcast price update to room per active round
    try {
      const activeRounds = await prisma.round.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });
      for (const r of activeRounds) {
        this.safeEmit({ room: `round:${r.id}`, event: WebSocketEvents.PriceUpdateV2, payload });
      }
    } catch (err) {
      logger.error('Failed to broadcast price_update to active round rooms:', err);
    }
  }

  /**
   * Emit chat message to chat room
   */
  emitChatMessage(message: any): void {
    this.safeEmit({ room: 'chat', event: WebSocketEvents.ChatMessage, payload: message });
    logger.info(`Emitted chat:message: ${message.id}`);
  }

  /**
   * Emit a notification to a specific user
   */
  emitNotification(userId: string, notification: any): void {
    const payload = {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      isRead: notification.isRead,
      createdAt: notification.createdAt?.toISOString?.() || notification.createdAt,
    };
    this.safeEmit({
      room: `user:${userId}`,
      event: WebSocketEvents.NotificationNew,
      payload,
      userId,
    });
    logger.info(`Emitted notification to user ${userId}`);
  }

  /**
   * Emit an unread count update to a specific user
   */
  emitUnreadCountUpdate(userId: string, unreadCount: number): void {
    const payload = {
      unreadCount,
      timestamp: new Date().toISOString(),
    };
    this.safeEmit({
      room: `user:${userId}`,
      event: WebSocketEvents.NotificationUnreadCount,
      payload,
      userId,
    });
    logger.info(`Emitted unread count update to user ${userId}: ${unreadCount}`);
  }
}

export default WebSocketService.instance;

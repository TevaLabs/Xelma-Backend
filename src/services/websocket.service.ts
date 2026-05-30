import { Server as SocketIOServer } from 'socket.io';
import { DispatchChannel } from '@prisma/client';
import logger from '../utils/logger';
import deadLetterQueueService from './dead-letter-queue.service';

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
} as const;

export type WebSocketEventName =
  (typeof WebSocketEvents)[keyof typeof WebSocketEvents];

interface SafeEmitInput {
  room: string;
  event: WebSocketEventName;
  payload: any;
  userId?: string | null;
}

class WebSocketService {
  private io: SocketIOServer | null = null;

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
    } catch (err) {
      logger.error(`Failed to emit ${input.event}`, { error: err });
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
  }

  /**
   * Emit price update event
   */
  emitPriceUpdate(asset: string, price: number | string): void {
    const payload = {
      asset,
      price,
      timestamp: new Date().toISOString(),
    };
    this.safeEmit({ room: 'round', event: WebSocketEvents.PriceUpdate, payload });
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

export default new WebSocketService();

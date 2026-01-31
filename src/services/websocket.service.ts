import { Server as SocketIOServer } from 'socket.io';
import logger from '../utils/logger';

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
   * Emit event when a new round starts
   */
  emitRoundStarted(round: any): void {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot emit round:started");
      return;
    }

    this.io.to('round').emit("round:started", {
      id: round.id,
      mode: round.mode,
      status: round.status,
      startTime: round.startTime,
      endTime: round.endTime,
      startPrice: round.startPrice,
      priceRanges: round.priceRanges,
    });

    logger.info(`Emitted round:started for round ${round.id}`);
  }

  /**
   * Emit event when a prediction is placed
   */
  emitPredictionPlaced(prediction: any, roundId: string): void {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot emit prediction:placed");
      return;
    }

    this.io.to('round').emit("prediction:placed", {
      roundId,
      predictionId: prediction.id,
      amount: prediction.amount,
      side: prediction.side,
      priceRange: prediction.priceRange,
    });

    logger.info(`Emitted prediction:placed for prediction ${prediction.id}`);
  }

  /**
   * Emit event when a round is resolved
   */
  emitRoundResolved(round: any): void {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot emit round:resolved");
      return;
    }

    this.io.to('round').emit("round:resolved", {
      id: round.id,
      status: round.status,
      startPrice: round.startPrice,
      endPrice: round.endPrice,
      resolvedAt: round.resolvedAt,
      predictions: round.predictions?.length || 0,
      winners: round.predictions?.filter((p: any) => p.won === true).length || 0,
    });

    logger.info(`Emitted round:resolved for round ${round.id}`);
  }

  /**
   * Emit price update event
   */
  emitPriceUpdate(asset: string, price: number): void {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot emit price:update");
      return;
    }

    this.io.to('round').emit("price:update", {
      asset,
      price,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Emit chat message to chat room
   */
  emitChatMessage(message: any): void {
    if (!this.io) {
      logger.warn('WebSocket not initialized, cannot emit chat:message');
      return;
    }

    this.io.to('chat').emit('chat:message', message);
    logger.info(`Emitted chat:message: ${message.id}`);
  }

  /**
   * Emit a notification to a specific user
   */
  emitNotification(userId: string, notification: any): void {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot emit notification");
      return;
    }

    this.io.to(`user:${userId}`).emit("notification:new", {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      isRead: notification.isRead,
      createdAt: notification.createdAt?.toISOString?.() || notification.createdAt,
    });

    logger.info(`Emitted notification to user ${userId}`);
  }

  /**
   * Emit an unread count update to a specific user
   */
  emitUnreadCountUpdate(userId: string, unreadCount: number): void {
    if (!this.io) {
      logger.warn("WebSocket not initialized, cannot emit unread count update");
      return;
    }

    this.io.to(`user:${userId}`).emit("notification:unread-count", {
      unreadCount,
      timestamp: new Date().toISOString(),
    });

    logger.info(`Emitted unread count update to user ${userId}: ${unreadCount}`);
  }
}

export default new WebSocketService();

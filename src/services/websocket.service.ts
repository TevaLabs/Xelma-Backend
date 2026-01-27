import { Server as SocketIOServer } from 'socket.io';
import logger from '../utils/logger';

class WebSocketService {
    private io: SocketIOServer | null = null;

    /**
     * Initialize the WebSocket service with Socket.IO instance
     */
    initialize(io: SocketIOServer): void {
        this.io = io;
        logger.info('WebSocket service initialized');
    }

    /**
     * Emit event when a new round starts
     */
    emitRoundStarted(round: any): void {
        if (!this.io) {
            logger.warn('WebSocket not initialized, cannot emit round:started');
            return;
        }

        this.io.emit('round:started', {
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
            logger.warn('WebSocket not initialized, cannot emit prediction:placed');
            return;
        }

        // Emit to all clients
        this.io.emit('prediction:placed', {
            roundId,
            predictionId: prediction.id,
            amount: prediction.amount,
            side: prediction.side,
            priceRange: prediction.priceRange,
        });

        // Also emit to a room specific to this round
        this.io.to(`round:${roundId}`).emit('round:prediction', {
            predictionId: prediction.id,
            amount: prediction.amount,
        });

        logger.info(`Emitted prediction:placed for prediction ${prediction.id}`);
    }

    /**
     * Emit event when a round is resolved
     */
    emitRoundResolved(round: any): void {
        if (!this.io) {
            logger.warn('WebSocket not initialized, cannot emit round:resolved');
            return;
        }

        this.io.emit('round:resolved', {
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
            logger.warn('WebSocket not initialized, cannot emit price:update');
            return;
        }

        this.io.emit('price:update', {
            asset,
            price,
            timestamp: new Date().toISOString(),
        });

        // Don't log every price update to avoid spam
        // logger.info(`Emitted price:update: ${asset} = ${price}`);
    }

    /**
     * Join a room (for round-specific events)
     */
    joinRoom(socketId: string, roomName: string): void {
        if (!this.io) {
            logger.warn('WebSocket not initialized, cannot join room');
            return;
        }

        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
            socket.join(roomName);
            logger.info(`Socket ${socketId} joined room ${roomName}`);
        }
    }

    /**
     * Leave a room
     */
    leaveRoom(socketId: string, roomName: string): void {
        if (!this.io) {
            logger.warn('WebSocket not initialized, cannot leave room');
            return;
        }

        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
            socket.leave(roomName);
            logger.info(`Socket ${socketId} left room ${roomName}`);
        }
    }
}

export default new WebSocketService();

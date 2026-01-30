import { prisma } from '../lib/prisma';
import websocketService from './websocket.service';
import logger from '../utils/logger';
import { ChatMessage } from '../types/chat.types';

// Simple profanity blocklist - extensible for future enhancements
// Can be replaced with 'bad-words' npm package for production
const PROFANITY_LIST = [
  'fuck',
  'shit',
  'ass',
  'bitch',
  'damn',
  'bastard',
  'crap',
  'dick',
  'piss',
  'cunt',
];

class ChatService {
  /**
   * Send a new chat message
   */
  async sendMessage(userId: string, walletAddress: string, content: string): Promise<ChatMessage> {
    // Validate content
    if (!content || content.trim().length === 0) {
      throw new Error('Message content cannot be empty');
    }

    if (content.length > 500) {
      throw new Error('Message exceeds maximum length of 500 characters');
    }

    // Filter profanity
    const filteredContent = this.filterProfanity(content.trim());

    // Create message in database
    const message = await prisma.message.create({
      data: {
        userId,
        content: filteredContent,
      },
      include: {
        user: {
          select: {
            walletAddress: true,
          },
        },
      },
    });

    // Format response
    const chatMessage: ChatMessage = {
      id: message.id,
      userId: message.userId,
      walletAddress: this.maskWalletAddress(walletAddress),
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    };

    // Broadcast via WebSocket
    websocketService.emitChatMessage(chatMessage);

    logger.info(`Chat message sent: user=${userId}, messageId=${message.id}`);

    return chatMessage;
  }

  /**
   * Get chat history (last N messages, default 50)
   */
  async getHistory(limit: number = 50): Promise<ChatMessage[]> {
    const messages = await prisma.message.findMany({
      take: limit,
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        user: {
          select: {
            walletAddress: true,
          },
        },
      },
    });

    // Reverse to show oldest first (natural chat order)
    return messages.reverse().map((msg: typeof messages[number]) => ({
      id: msg.id,
      userId: msg.userId,
      walletAddress: this.maskWalletAddress(msg.user.walletAddress),
      content: msg.content,
      createdAt: msg.createdAt.toISOString(),
    }));
  }

  /**
   * Filter profanity from message content
   * Replaces bad words with asterisks
   */
  private filterProfanity(content: string): string {
    let filtered = content;

    for (const word of PROFANITY_LIST) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      filtered = filtered.replace(regex, '*'.repeat(word.length));
    }

    return filtered;
  }

  /**
   * Mask wallet address for privacy
   * Shows first 6 and last 4 characters
   */
  private maskWalletAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}

export default new ChatService();

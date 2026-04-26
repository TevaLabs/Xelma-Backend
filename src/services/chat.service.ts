import { prisma } from '../lib/prisma';
import websocketService from './websocket.service';
import logger from '../utils/logger';
import { sanitizeChatContent, validateContentLength } from '../utils/sanitization.util';
import { ChatMessage } from '../types/chat.types';

// Profanity blocklist - case-insensitive matching
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
   * 
   * Applies comprehensive content validation and sanitization:
   * 1. Length validation (max 500 chars)
   * 2. Whitespace normalization
   * 3. HTML escaping for XSS prevention
   * 4. Suspicious pattern detection (injection attempts)
   * 5. Profanity filtering
   * 
   * @throws Error if content fails moderation checks
   */
  async sendMessage(userId: string, walletAddress: string, content: string): Promise<ChatMessage> {
    try {
      // Step 1: Validate length constraints
      validateContentLength(content, 500);

      // Step 2: Sanitize content (normalize whitespace, escape HTML, check for suspicious patterns)
      let sanitizedContent = sanitizeChatContent(content);

      // Step 3: Apply profanity filter
      sanitizedContent = this.filterProfanity(sanitizedContent);

      logger.debug(`Message sanitized for user ${userId}`, {
        originalLength: content.length,
        sanitizedLength: sanitizedContent.length,
      });

      // Step 4: Create message in database
      const message = await prisma.message.create({
        data: {
          userId,
          content: sanitizedContent,
        },
        include: {
          user: {
            select: {
              walletAddress: true,
            },
          },
        },
      });

      // Step 5: Format response
      const chatMessage: ChatMessage = {
        id: message.id,
        userId: message.userId,
        walletAddress: this.maskWalletAddress(walletAddress),
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      };

      // Step 6: Broadcast via WebSocket
      websocketService.emitChatMessage(chatMessage);

      logger.info(`Chat message sent: user=${userId}, messageId=${message.id}`, {
        contentLength: sanitizedContent.length,
      });

      return chatMessage;
    } catch (error: any) {
      logger.warn(`Chat message validation failed for user ${userId}`, {
        error: error.message,
        contentLength: content.length,
      });
      throw error;
    }
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
   * Replaces bad words with asterisks (case-insensitive)
   * 
   * Note: This operates on already-HTML-escaped content
   */
  private filterProfanity(content: string): string {
    let filtered = content;

    for (const word of PROFANITY_LIST) {
      // Use word boundary regex for case-insensitive matching
      // Note: regex word boundaries may not work perfectly with HTML entities,
      // but profanity filtering is a secondary layer after sanitization
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

import { CursorMeta, OffsetMeta } from "../utils/pagination.util";

export interface ChatMessage {
  id: string;
  userId: string;
  walletAddress: string;
  content: string;
  createdAt: string;
}

export interface SendMessageRequest {
  content: string;
}

export interface SendMessageResponse {
  success: true;
  message: ChatMessage;
}

/**
 * Legacy response shape – kept for backward compatibility.
 * New clients should use ChatHistoryPageResponse.
 */
export interface ChatHistoryResponse {
  success: true;
  messages: ChatMessage[];
  count: number;
}

/** Cursor-paginated chat history response. */
export interface ChatHistoryPageResponse {
  success: true;
  messages: ChatMessage[];
  pagination: CursorMeta;
}

/**
 * Timestamp-cursor–paginated chat history response (Issue #848).
 * `nextBefore` is the value to pass as `before` for the next (older) page.
 */
export interface ChatHistoryBeforeResponse {
  success: true;
  messages: ChatMessage[];
  pagination: CursorMeta & { before: string; nextBefore: string | null };
}

/** Offset-paginated chat history response. */
export interface ChatHistoryOffsetResponse {
  success: true;
  messages: ChatMessage[];
  pagination: OffsetMeta;
}

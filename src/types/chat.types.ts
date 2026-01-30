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

export interface ChatHistoryResponse {
  success: true;
  messages: ChatMessage[];
  count: number;
}

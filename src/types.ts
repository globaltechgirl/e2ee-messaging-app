export interface UserProfile {
  id: string;
  username: string;
  display_name: string;
  public_key: string;
  wrapped_private_key: string;
  pbkdf2_salt: string;
  created_at: string;
}

export interface UserPublicInfo {
  id: string;
  username: string;
  display_name: string;
}

export interface UserPublicKey {
  public_key: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: UserProfile;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface ConversationSummary {
  user_id: string;
  display_name: string;
  username: string;
  last_message_at: string | null;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  encryptedKey: string;
  encryptedKeyForSelf: string;
}

export interface MessageResponse {
  id: string;
  from_user_id: string;
  to_user_id: string;
  payload: Record<string, unknown>;
  delivered: boolean;
  created_at: string;
}

export interface PersistedSession {
  refreshToken: string;
  user: UserProfile;
  savedAt: string;
}

export interface SessionSnapshot {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: UserProfile;
}

export interface ReadySession extends SessionSnapshot {
  privateKey: CryptoKey;
}

export interface LockedSession extends SessionSnapshot {
  reason: string;
}

export interface RegisterForm {
  username: string;
  displayName: string;
  password: string;
}

export interface LoginForm {
  username: string;
  password: string;
}

export interface DecryptedEnvelope {
  body: string;
}

export interface DecryptedMessage {
  body: string;
  nonce?: string;
  sentAt?: string;
}

export type ChatMessageStatus = "pending" | "sent" | "failed";

export interface ChatMessage {
  id: string;
  conversationUserId: string;
  fromUserId: string;
  toUserId: string;
  direction: "incoming" | "outgoing";
  createdAt: string;
  decrypted: boolean;
  body: string;
  status: ChatMessageStatus;
  delivered: boolean;
  error?: string;
  nonce?: string;
  transport: "history" | "rest" | "ws" | "optimistic";
}

export interface WebSocketFrame {
  type?: string;
  payload?: unknown;
  message?: unknown;
  messages?: unknown;
}

export interface SearchState {
  query: string;
  loading: boolean;
  results: UserPublicInfo[];
  error: string | null;
}

import type {
  AuthResponse,
  ConversationSummary,
  LoginForm,
  MessageResponse,
  RegisterForm,
  SessionSnapshot,
  TokenResponse,
  UserProfile,
  UserPublicInfo,
  UserPublicKey,
} from "../types";
import type { EncryptedPayload } from "../types";
import { arrayBufferToBase64, textToBytes } from "./encoding";

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "https://whisperbox.koyeb.app").replace(/\/+$/, "");
export const WS_BASE_URL =
  import.meta.env.VITE_WS_BASE_URL ??
  API_BASE_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

export class ApiError extends Error {
  readonly status: number;
  readonly details: string;

  constructor(status: number, details: string) {
    super(details);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

interface AuthContext {
  getSession: () => SessionSnapshot | null;
  setAccessToken: (token: TokenResponse) => void;
  onSessionExpired: () => Promise<void> | void;
}

export class WhisperApiClient {
  private readonly auth: AuthContext;

  constructor(auth: AuthContext) {
    this.auth = auth;
  }

  private async request<T>(path: string, init: RequestInit = {}, requiresAuth = true): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");

    if (requiresAuth) {
      const session = this.auth.getSession();

      if (!session) {
        throw new ApiError(401, "Session has expired.");
      }

      headers.set("Authorization", `Bearer ${session.accessToken}`);
    }

    let response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
    });

    if (response.status === 401 && requiresAuth) {
      try {
        const refreshed = await this.refreshAccessToken();
        headers.set("Authorization", `Bearer ${refreshed.access_token}`);
        response = await fetch(`${API_BASE_URL}${path}`, {
          ...init,
          headers,
        });
      } catch (error) {
        await this.auth.onSessionExpired();

        if (error instanceof ApiError) {
          throw error;
        }

        throw new ApiError(401, "Your session expired. Please sign in again.");
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new ApiError(response.status, parseErrorMessage(errorText));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async register(payload: RegisterForm & { publicKey: string; wrappedPrivateKey: string; pbkdf2Salt: string }) {
    return this.request<AuthResponse>(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify({
          username: payload.username.toLowerCase(),
          display_name: payload.displayName,
          password: payload.password,
          public_key: payload.publicKey,
          wrapped_private_key: payload.wrappedPrivateKey,
          pbkdf2_salt: payload.pbkdf2Salt,
        }),
      },
      false,
    );
  }

  async login(payload: LoginForm) {
    return this.request<AuthResponse>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          username: payload.username.toLowerCase(),
          password: payload.password,
        }),
      },
      false,
    );
  }

  async me() {
    return this.request<UserProfile>("/auth/me");
  }

  async refreshAccessToken() {
    const session = this.auth.getSession();

    if (!session?.refreshToken) {
      throw new ApiError(401, "Refresh token missing.");
    }

    const token = await this.request<TokenResponse>(
      "/auth/refresh",
      {
        method: "POST",
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      },
      false,
    );

    this.auth.setAccessToken(token);
    return token;
  }

  async logout() {
    const session = this.auth.getSession();

    if (!session?.refreshToken) {
      return;
    }

    await this.request<Record<string, unknown>>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
  }

  async searchUsers(query: string) {
    const params = new URLSearchParams({ q: query });
    return this.request<UserPublicInfo[]>(`/users/search?${params.toString()}`);
  }

  async getPublicKey(userId: string) {
    return this.request<UserPublicKey>(`/users/${userId}/public-key`);
  }

  async listConversations() {
    return this.request<ConversationSummary[]>("/conversations");
  }

  async getConversationMessages(userId: string, limit = 50, before?: string) {
    const params = new URLSearchParams({ limit: String(limit) });

    if (before) {
      params.set("before", before);
    }

    return this.request<MessageResponse[]>(`/conversations/${userId}/messages?${params.toString()}`);
  }

  async sendMessage(userId: string, payload: EncryptedPayload) {
    return this.request<MessageResponse>("/messages", {
      method: "POST",
      body: JSON.stringify({
        to: userId,
        payload,
      }),
    });
  }
}

function parseErrorMessage(errorText: string): string {
  if (!errorText) {
    return "Request failed.";
  }

  try {
    const parsed = JSON.parse(errorText) as { detail?: unknown };

    if (typeof parsed.detail === "string") {
      return parsed.detail;
    }

    if (Array.isArray(parsed.detail)) {
      return parsed.detail
        .map((entry) => {
          if (entry && typeof entry === "object" && "msg" in entry && typeof entry.msg === "string") {
            return entry.msg;
          }

          return null;
        })
        .filter((entry): entry is string => Boolean(entry))
        .join(", ");
    }
  } catch {
    return errorText;
  }

  return errorText;
}

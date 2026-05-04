import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import { ApiError, WS_BASE_URL, WhisperApiClient } from "../lib/api";
import { decryptMessage, encryptMessage } from "../lib/crypto";
import type {
  ChatMessage,
  ConversationSummary,
  MessageResponse,
  ReadySession,
  SearchState,
  UserPublicInfo,
  WebSocketFrame,
} from "../types";

interface MessagingState {
  conversations: ConversationSummary[];
  selectedConversationUserId: string | null;
  activeMessages: ChatMessage[];
  activeConversation: UserPublicInfo | ConversationSummary | null;
  searchQuery: string;
  search: SearchState;
  loadingConversations: boolean;
  loadingMessages: boolean;
  loadingOlder: boolean;
  hasOlderMessages: boolean;
  sending: boolean;
  wsStatus: "idle" | "connecting" | "connected" | "reconnecting" | "error";
  actionError: string | null;
  selectConversation: (user: UserPublicInfo | ConversationSummary) => Promise<void>;
  setSearchQuery: (value: string) => void;
  refreshSearch: () => Promise<void>;
  sendMessage: (user: UserPublicInfo | ConversationSummary, value: string) => Promise<boolean>;
  loadOlderMessages: () => Promise<void>;
  refreshConversations: () => Promise<void>;
}

const MESSAGE_PAGE_SIZE = 50;

export function useMessaging(session: ReadySession | null, api: WhisperApiClient | null): MessagingState {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationUserId, setSelectedConversationUserId] = useState<string | null>(null);
  const [messagesByUserId, setMessagesByUserId] = useState<Record<string, ChatMessage[]>>({});
  const [userDirectory, setUserDirectory] = useState<Record<string, UserPublicInfo | ConversationSummary>>({});
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [hasOlderByConversation, setHasOlderByConversation] = useState<Record<string, boolean>>({});
  const [cursorByConversation, setCursorByConversation] = useState<Record<string, string | null>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({
    query: "",
    loading: false,
    results: [],
    error: null,
  });
  const [wsStatus, setWsStatus] = useState<MessagingState["wsStatus"]>("idle");
  const [socketRevision, setSocketRevision] = useState(0);

  const deferredQuery = useDeferredValue(searchQuery);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const publicKeyCacheRef = useRef(new Map<string, string>());
  const mountedRef = useRef(false);
  const searchRequestIdRef = useRef(0);
  const userClosedSocketRef = useRef(false);

  const activeMessages = selectedConversationUserId ? messagesByUserId[selectedConversationUserId] ?? [] : [];
  const activeConversation = selectedConversationUserId ? userDirectory[selectedConversationUserId] ?? null : null;
  const hasOlderMessages = selectedConversationUserId ? hasOlderByConversation[selectedConversationUserId] ?? false : false;

  function updateDirectory(entries: Array<UserPublicInfo | ConversationSummary>) {
    setUserDirectory((current) => {
      const next = { ...current };

      for (const entry of entries) {
        const userId = "user_id" in entry ? entry.user_id : entry.id;
        next[userId] = entry;
      }

      return next;
    });
  }

  async function transformMessage(message: MessageResponse, transport: ChatMessage["transport"]): Promise<ChatMessage> {
    if (!session) {
      throw new Error("Secure session unavailable.");
    }

    const conversationUserId = message.from_user_id === session.user.id ? message.to_user_id : message.from_user_id;

    try {
      const decrypted = await decryptMessage(message, session.privateKey, session.user.id);

      return {
        id: message.id,
        conversationUserId,
        fromUserId: message.from_user_id,
        toUserId: message.to_user_id,
        direction: message.from_user_id === session.user.id ? "outgoing" : "incoming",
        createdAt: decrypted.sentAt ?? message.created_at,
        decrypted: true,
        body: decrypted.body,
        status: "sent",
        delivered: message.delivered,
        nonce: decrypted.nonce,
        transport,
      };
    } catch (error) {
      return {
        id: message.id,
        conversationUserId,
        fromUserId: message.from_user_id,
        toUserId: message.to_user_id,
        direction: message.from_user_id === session.user.id ? "outgoing" : "incoming",
        createdAt: message.created_at,
        decrypted: false,
        body: "Unable to decrypt this message on this device.",
        status: "sent",
        delivered: message.delivered,
        error: error instanceof Error ? error.message : "Decryption failed.",
        transport,
      };
    }
  }

  function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
    const merged = [...current];

    for (const candidate of incoming) {
      const existingById = merged.findIndex((message) => message.id === candidate.id);

      if (existingById >= 0) {
        merged[existingById] = {
          ...merged[existingById],
          ...candidate,
        };
        continue;
      }

      if (candidate.nonce) {
        const existingByNonce = merged.findIndex((message) => message.nonce === candidate.nonce);

        if (existingByNonce >= 0) {
          merged[existingByNonce] = {
            ...merged[existingByNonce],
            ...candidate,
            status: "sent",
          };
          continue;
        }
      }

      merged.push(candidate);
    }

    return merged.sort((left, right) => {
      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    });
  }

  async function loadConversations() {
    if (!api || !session) {
      return;
    }

    setLoadingConversations(true);
    setActionError(null);

    try {
      const nextConversations = await api.listConversations();
      setConversations(nextConversations);
      updateDirectory(nextConversations);

      if (nextConversations[0]) {
        startTransition(() => {
          setSelectedConversationUserId((current) => current ?? nextConversations[0].user_id);
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load conversations.";
      setActionError(message);
    } finally {
      setLoadingConversations(false);
    }
  }

  async function loadConversationMessages(userId: string, appendOlder = false) {
    if (!api || !session) {
      return;
    }

    if (appendOlder) {
      setLoadingOlder(true);
    } else {
      setLoadingMessages(true);
    }
    setActionError(null);

    try {
      const before = appendOlder ? cursorByConversation[userId] ?? undefined : undefined;
      const history = await api.getConversationMessages(userId, MESSAGE_PAGE_SIZE, before);
      const transformed = await Promise.all(history.map((message) => transformMessage(message, "history")));
      const nextCursor = history.at(-1)?.created_at ?? null;

      setMessagesByUserId((current) => {
        const existing = current[userId] ?? [];
        return {
          ...current,
          [userId]: mergeMessages(existing, transformed),
        };
      });
      setCursorByConversation((current) => ({
        ...current,
        [userId]: nextCursor,
      }));
      setHasOlderByConversation((current) => ({
        ...current,
        [userId]: history.length === MESSAGE_PAGE_SIZE,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load messages.";
      setActionError(message);
    } finally {
      setLoadingMessages(false);
      setLoadingOlder(false);
    }
  }

  async function selectConversation(user: UserPublicInfo | ConversationSummary) {
    const userId = "user_id" in user ? user.user_id : user.id;
    updateDirectory([user]);
    startTransition(() => {
      setSelectedConversationUserId(userId);
    });

    if (!messagesByUserId[userId]?.length) {
      await loadConversationMessages(userId);
    }
  }

  async function refreshSearchResults(query: string) {
    if (!api || !session) {
      return;
    }

    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;

    if (!query.trim()) {
      setSearch({
        query: "",
        loading: false,
        results: [],
        error: null,
      });
      return;
    }

    setSearch((current) => ({
      ...current,
      query,
      loading: true,
      error: null,
    }));

    try {
      const results = (await api.searchUsers(query.trim())).filter((user) => user.id !== session.user.id);

      if (searchRequestIdRef.current !== requestId) {
        return;
      }

      updateDirectory(results);
      setSearch({
        query,
        loading: false,
        results,
        error: null,
      });
    } catch (error) {
      if (searchRequestIdRef.current !== requestId) {
        return;
      }

      const message = error instanceof Error ? error.message : "User search failed.";
      setSearch({
        query,
        loading: false,
        results: [],
        error: message,
      });
    }
  }

  async function ensurePublicKey(userId: string) {
    const cached = publicKeyCacheRef.current.get(userId);

    if (cached) {
      return cached;
    }

    if (!api) {
      throw new Error("API unavailable.");
    }

    const response = await api.getPublicKey(userId);
    publicKeyCacheRef.current.set(userId, response.public_key);
    return response.public_key;
  }

  async function upsertDeliveredMessage(message: MessageResponse, transport: ChatMessage["transport"]) {
    const next = await transformMessage(message, transport);
    setMessagesByUserId((current) => ({
      ...current,
      [next.conversationUserId]: mergeMessages(current[next.conversationUserId] ?? [], [next]),
    }));
  }

  async function sendMessage(user: UserPublicInfo | ConversationSummary, value: string) {
    if (!api || !session) {
      return false;
    }

    const trimmed = value.trim();

    if (!trimmed) {
      return false;
    }

    const userId = "user_id" in user ? user.user_id : user.id;
    let optimisticId = "";
    setSending(true);
    setActionError(null);

    try {
      const recipientPublicKey = await ensurePublicKey(userId);
      const { nonce, payload } = await encryptMessage(trimmed, recipientPublicKey, session.user.public_key);
      optimisticId = `optimistic:${nonce}`;
      const optimisticMessage: ChatMessage = {
        id: optimisticId,
        conversationUserId: userId,
        fromUserId: session.user.id,
        toUserId: userId,
        direction: "outgoing",
        createdAt: new Date().toISOString(),
        decrypted: true,
        body: trimmed,
        status: "pending",
        delivered: false,
        nonce,
        transport: "optimistic",
      };

      updateDirectory([user]);
      setMessagesByUserId((current) => ({
        ...current,
        [userId]: mergeMessages(current[userId] ?? [], [optimisticMessage]),
      }));
      setConversations((current) => upsertConversation(current, user));

      const storedMessage = await api.sendMessage(userId, payload);
      await upsertDeliveredMessage(storedMessage, "rest");
      await loadConversations();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to send message.";
      setMessagesByUserId((current) => ({
        ...current,
        [userId]: (current[userId] ?? []).map((entry) => {
          if (entry.id === optimisticId) {
            return {
              ...entry,
              status: "failed",
              error: message,
            };
          }

          return entry;
        }),
      }));
      setActionError(message);
      return false;
    } finally {
      setSending(false);
    }
  }

  async function loadOlderMessages() {
    if (!selectedConversationUserId || !hasOlderMessages) {
      return;
    }

    await loadConversationMessages(selectedConversationUserId, true);
  }

  async function handleFrame(frame: unknown) {
    if (!session || !frame) {
      return;
    }

    const messages = extractIncomingMessages(frame);

    if (!messages.length) {
      return;
    }

    const transformed = await Promise.all(messages.map((message) => transformMessage(message, "ws")));

    setMessagesByUserId((current) => {
      const next = { ...current };

      for (const message of transformed) {
        next[message.conversationUserId] = mergeMessages(next[message.conversationUserId] ?? [], [message]);
      }

      return next;
    });
    void loadConversations();
  }

  useEffect(() => {
    if (!api || !session) {
      setConversations([]);
      setCursorByConversation({});
      setHasOlderByConversation({});
      setMessagesByUserId({});
      setSelectedConversationUserId(null);
      setUserDirectory({});
      setSearch({
        query: "",
        loading: false,
        results: [],
        error: null,
      });
      setSearchQuery("");
      setActionError(null);
      setWsStatus("idle");
      publicKeyCacheRef.current.clear();
      return;
    }

    void loadConversations();
  }, [api, session?.accessToken, session?.user.id]);

  useEffect(() => {
    if (!session || !api) {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (wsRef.current) {
        userClosedSocketRef.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }

      return;
    }

    userClosedSocketRef.current = false;
    setWsStatus("connecting");

    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const socket = new WebSocket(`${WS_BASE_URL}/ws?token=${encodeURIComponent(session.accessToken)}`);
    wsRef.current = socket;

    socket.onopen = () => {
      reconnectAttemptRef.current = 0;
      setWsStatus("connected");
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const parsed = JSON.parse(event.data) as WebSocketFrame | WebSocketFrame[] | MessageResponse[];
        void handleFrame(parsed);
      } catch {
        // Ignore keep-alive or non-JSON control frames.
      }
    };

    socket.onerror = () => {
      setWsStatus("error");
    };

    socket.onclose = async () => {
      if (userClosedSocketRef.current) {
        return;
      }

      setWsStatus("reconnecting");

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      const nextAttempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = nextAttempt;
      const delay = Math.min(1000 * 2 ** (nextAttempt - 1), 10000);

      reconnectTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) {
          return;
        }

        if (api && session && nextAttempt % 3 === 0) {
          void api.refreshAccessToken().catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 401) {
              setWsStatus("error");
            }
          });
        }

        setSocketRevision((current) => current + 1);
      }, delay);
    };

    return () => {
      userClosedSocketRef.current = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.close();
      wsRef.current = null;
    };
  }, [api, session?.accessToken, session?.user.id, socketRevision]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void refreshSearchResults(deferredQuery);
  }, [deferredQuery, api, session?.user.id]);

  useEffect(() => {
    if (!selectedConversationUserId || messagesByUserId[selectedConversationUserId]?.length) {
      return;
    }

    void loadConversationMessages(selectedConversationUserId);
  }, [selectedConversationUserId]);

  return {
    conversations,
    selectedConversationUserId,
    activeMessages,
    activeConversation,
    searchQuery,
    search,
    loadingConversations,
    loadingMessages,
    loadingOlder,
    hasOlderMessages,
    sending,
    wsStatus,
    actionError,
    selectConversation,
    setSearchQuery,
    refreshSearch: async () => refreshSearchResults(searchQuery),
    sendMessage,
    loadOlderMessages,
    refreshConversations: loadConversations,
  };
}

function extractIncomingMessages(frame: unknown): MessageResponse[] {
  if (Array.isArray(frame)) {
    return frame.flatMap((entry) => extractIncomingMessages(entry));
  }

  if (!frame || typeof frame !== "object") {
    return [];
  }

  if (isMessageResponse(frame)) {
    return [frame];
  }

  const candidate = frame as WebSocketFrame;

  if (Array.isArray(candidate.messages)) {
    return candidate.messages.filter(isMessageResponse);
  }

  if (candidate.type === "message.receive") {
    if (isMessageResponse(candidate.payload)) {
      return [candidate.payload];
    }

    if (Array.isArray(candidate.payload)) {
      return candidate.payload.filter(isMessageResponse);
    }

    if (isMessageResponse(candidate.message)) {
      return [candidate.message];
    }
  }

  return [];
}

function isMessageResponse(value: unknown): value is MessageResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Partial<MessageResponse>;
  return (
    typeof message.id === "string" &&
    typeof message.from_user_id === "string" &&
    typeof message.to_user_id === "string" &&
    typeof message.created_at === "string" &&
    Boolean(message.payload) &&
    typeof message.payload === "object"
  );
}

function upsertConversation(
  current: ConversationSummary[],
  user: UserPublicInfo | ConversationSummary,
): ConversationSummary[] {
  const nextConversation: ConversationSummary =
    "user_id" in user
      ? user
      : {
          user_id: user.id,
          display_name: user.display_name,
          username: user.username,
          last_message_at: new Date().toISOString(),
        };

  const filtered = current.filter((conversation) => conversation.user_id !== nextConversation.user_id);
  return [nextConversation, ...filtered];
}

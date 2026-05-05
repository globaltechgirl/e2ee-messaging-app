import { useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, ConversationSummary, UserPublicInfo } from "../types";

interface MessagePanelProps {
  conversation: UserPublicInfo | ConversationSummary | null;
  messages: ChatMessage[];
  loadingMessages: boolean;
  loadingOlder: boolean;
  hasOlderMessages: boolean;
  sending: boolean;
  error: string | null;
  onLoadOlder: () => Promise<void>;
  onSend: (value: string) => Promise<boolean>;
}

export function MessagePanel(props: MessagePanelProps) {
  const [draft, setDraft] = useState("");
  const threadBottomRef = useRef<HTMLDivElement | null>(null);
  const threadBodyRef = useRef<HTMLDivElement | null>(null);
  const previousConversationIdRef = useRef<string | null>(null);
  const previousLoadingOlderRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const preserveScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const stickToBottomRef = useRef(true);

  const conversationUserId = props.conversation
    ? "user_id" in props.conversation
      ? props.conversation.user_id
      : props.conversation.id
    : null;

  useLayoutEffect(() => {
    const container = threadBodyRef.current;

    if (!container || !conversationUserId) {
      previousConversationIdRef.current = conversationUserId;
      previousLoadingOlderRef.current = props.loadingOlder;
      previousMessageCountRef.current = props.messages.length;
      preserveScrollRef.current = null;
      stickToBottomRef.current = true;
      return;
    }

    if (props.loadingOlder && !previousLoadingOlderRef.current) {
      preserveScrollRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }

    if (!props.loadingOlder && previousLoadingOlderRef.current && preserveScrollRef.current) {
      const snapshot = preserveScrollRef.current;
      container.scrollTop = snapshot.scrollTop + (container.scrollHeight - snapshot.scrollHeight);
      preserveScrollRef.current = null;
    } else {
      const conversationChanged = previousConversationIdRef.current !== conversationUserId;
      const messageCountChanged = previousMessageCountRef.current !== props.messages.length;

      if (conversationChanged || (messageCountChanged && stickToBottomRef.current)) {
        threadBottomRef.current?.scrollIntoView({
          behavior: conversationChanged ? "auto" : "smooth",
          block: "end",
        });
      }
    }

    previousConversationIdRef.current = conversationUserId;
    previousLoadingOlderRef.current = props.loadingOlder;
    previousMessageCountRef.current = props.messages.length;
  }, [conversationUserId, props.loadingOlder, props.messages.length]);

  if (!props.conversation) {
    return (
      <section className="thread thread--empty">
        <div className="thread-empty-card">
          <p className="thread-empty-card__eyebrow">End-to-end encrypted</p>
          <h2>Select a conversation to begin.</h2>
          <p>
            Search for a user, fetch their public key, encrypt the message in your browser, and only the recipient will be able to decrypt it.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="thread">
      <header className="thread__header">
        <div>
          <p className="thread__eyebrow">Secure direct message</p>
          <h2>{props.conversation.display_name}</h2>
          <span>@{props.conversation.username}</span>
        </div>
        <div className="thread__secure-pill">
          <strong>E2EE active</strong>
          <span>AES-GCM payload wrapped with RSA-OAEP</span>
        </div>
      </header>

      <div
        ref={threadBodyRef}
        className="thread__body"
        onScroll={(event) => {
          const element = event.currentTarget;
          const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
          stickToBottomRef.current = distanceFromBottom < 48;
        }}
      >
        {props.hasOlderMessages ? (
          <button
            className="ghost-button ghost-button--center"
            disabled={props.loadingOlder}
            type="button"
            onClick={() => void props.onLoadOlder()}
          >
            {props.loadingOlder ? "Loading older ciphertext..." : "Load older messages"}
          </button>
        ) : null}

        {props.loadingMessages ? <p className="thread__hint">Decrypting conversation history...</p> : null}
        {!props.loadingMessages && !props.messages.length ? (
          <p className="thread__hint">No messages yet. Send the first encrypted message to this contact.</p>
        ) : null}
        {props.error ? <p className="thread__error">{props.error}</p> : null}

        <div className="message-list">
          {props.messages.map((message) => (
            <article
              key={message.id}
              className={`message-bubble message-bubble--${message.direction} ${
                message.decrypted ? "" : "message-bubble--warning"
              } ${message.status === "failed" ? "message-bubble--failed" : ""}`}
            >
              <div className="message-bubble__meta">
                <span>{message.direction === "incoming" ? "Received" : "Sent"}</span>
                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              </div>
              <p>{message.body}</p>
              <div className="message-bubble__footer">
                {!message.decrypted && message.error ? <small>{message.error}</small> : null}
                {message.status === "pending" ? <small>Encrypting delivery...</small> : null}
                {message.status === "failed" ? <small>Send failed. Try again.</small> : null}
                {message.status === "sent" && message.direction === "outgoing" ? (
                  <small>{message.delivered ? "Delivered to server" : "Stored securely"}</small>
                ) : null}
              </div>
            </article>
          ))}
          <div ref={threadBottomRef} />
        </div>
      </div>

      <form
        className="composer"
        onSubmit={async (event) => {
          event.preventDefault();

          const value = draft.trim();

          if (!value) {
            return;
          }

          const sent = await props.onSend(value);

          if (sent) {
            setDraft("");
          }
        }}
      >
        <input
          aria-label={`Encrypted message for ${conversationUserId}`}
          autoComplete="off"
          disabled={props.sending}
          maxLength={4000}
          placeholder="Write an encrypted message"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="primary-button" disabled={props.sending || !draft.trim()} type="submit">
          {props.sending ? "Sending..." : "Send secure"}
        </button>
      </form>
    </section>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
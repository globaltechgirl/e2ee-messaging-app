import { useEffect, useRef, useState } from "react";
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
  onSend: (value: string) => Promise<void>;
}

export function MessagePanel(props: MessagePanelProps) {
  const [draft, setDraft] = useState("");
  const threadBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.loadingOlder) {
      threadBottomRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
  }, [props.messages.length, props.loadingOlder]);

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

  const userId = "user_id" in props.conversation ? props.conversation.user_id : props.conversation.id;

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

      <div className="thread__body">
        {props.hasOlderMessages ? (
          <button className="ghost-button ghost-button--center" type="button" onClick={() => void props.onLoadOlder()}>
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
        onSubmit={(event) => {
          event.preventDefault();

          const value = draft.trim();

          if (!value) {
            return;
          }

          void props.onSend(value).then(() => setDraft(""));
        }}
      >
        <input
          aria-label={`Encrypted message for ${userId}`}
          disabled={props.sending}
          maxLength={4000}
          placeholder="Write an encrypted message"
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

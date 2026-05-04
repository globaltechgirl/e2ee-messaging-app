import type { ConversationSummary, SearchState, UserProfile, UserPublicInfo } from "../types";

interface ConversationListProps {
  user: UserProfile;
  conversations: ConversationSummary[];
  selectedConversationUserId: string | null;
  loading: boolean;
  searchQuery: string;
  search: SearchState;
  wsStatus: "idle" | "connecting" | "connected" | "reconnecting" | "error";
  onSearchChange: (value: string) => void;
  onSelect: (user: UserPublicInfo | ConversationSummary) => Promise<void>;
  onLogout: () => Promise<void>;
}

export function ConversationList(props: ConversationListProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <div>
          <p className="sidebar__eyebrow">Secure channel</p>
          <h1>WhisperBox</h1>
        </div>
        <button className="ghost-button" type="button" onClick={() => void props.onLogout()}>
          Sign out
        </button>
      </header>

      <section className="identity-card">
        <div>
          <strong>{props.user.display_name}</strong>
          <span>@{props.user.username}</span>
        </div>
        <span className={`status-chip status-chip--${props.wsStatus}`}>{labelForSocketState(props.wsStatus)}</span>
      </section>

      <section className="vault-card">
        <p>Private key status</p>
        <strong>Unlocked in-memory only</strong>
        <span>Wrapped key and refresh token are kept in IndexedDB. Plaintext key material is never stored.</span>
      </section>

      <label className="search-panel">
        <span>Find people</span>
        <input
          placeholder="Search by username or display name"
          value={props.searchQuery}
          onChange={(event) => props.onSearchChange(event.target.value)}
        />
      </label>

      {props.searchQuery.trim() ? (
        <section className="results-panel">
          <div className="results-panel__title">Search results</div>
          {props.search.loading ? <p className="results-panel__empty">Searching securely...</p> : null}
          {props.search.error ? <p className="results-panel__empty">{props.search.error}</p> : null}
          {!props.search.loading && !props.search.error && !props.search.results.length ? (
            <p className="results-panel__empty">No matching users yet.</p>
          ) : null}
          {props.search.results.map((user) => (
            <button
              key={user.id}
              className="conversation-item"
              type="button"
              onClick={() => void props.onSelect(user)}
            >
              <div>
                <strong>{user.display_name}</strong>
                <span>@{user.username}</span>
              </div>
              <small>Compose</small>
            </button>
          ))}
        </section>
      ) : null}

      <section className="results-panel results-panel--fill">
        <div className="results-panel__title">Conversations</div>
        {props.loading ? <p className="results-panel__empty">Loading recent secure threads...</p> : null}
        {!props.loading && !props.conversations.length ? (
          <p className="results-panel__empty">Start a new encrypted conversation from the search box.</p>
        ) : null}
        {props.conversations.map((conversation) => (
          <button
            key={conversation.user_id}
            className={`conversation-item ${
              props.selectedConversationUserId === conversation.user_id ? "is-selected" : ""
            }`}
            type="button"
            onClick={() => void props.onSelect(conversation)}
          >
            <div>
              <strong>{conversation.display_name}</strong>
              <span>@{conversation.username}</span>
            </div>
            <small>{conversation.last_message_at ? formatRelative(conversation.last_message_at) : "New"}</small>
          </button>
        ))}
      </section>
    </aside>
  );
}

function labelForSocketState(state: ConversationListProps["wsStatus"]) {
  switch (state) {
    case "connected":
      return "Realtime secure";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Fallback mode";
    default:
      return "Idle";
  }
}

function formatRelative(value: string) {
  const date = new Date(value);
  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) {
    return "now";
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

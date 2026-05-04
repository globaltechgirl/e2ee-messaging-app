import { useEffect, useRef, useState } from "react";
import { AuthScreen } from "./components/AuthScreen";
import { ConversationList } from "./components/ConversationList";
import { MessagePanel } from "./components/MessagePanel";
import { UnlockScreen } from "./components/UnlockScreen";
import { useMessaging } from "./hooks/useMessaging";
import { WhisperApiClient } from "./lib/api";
import { generateIdentity, unwrapPrivateKey } from "./lib/crypto";
import { clearPersistedSession, loadPersistedSession, savePersistedSession } from "./lib/storage";
import type { AuthResponse, LockedSession, LoginForm, ReadySession, RegisterForm, SessionSnapshot, TokenResponse } from "./types";

type AuthViewState =
  | { kind: "booting" }
  | { kind: "anonymous" }
  | { kind: "locked"; session: LockedSession }
  | { kind: "ready"; session: ReadySession };

export default function App() {
  const [state, setState] = useState<AuthViewState>({
    kind: "booting",
  });
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const sessionRef = useRef<SessionSnapshot | null>(null);
  const apiRef = useRef<WhisperApiClient | null>(null);

  function handleTokenUpdate(token: TokenResponse) {
    const expiresAt = Date.now() + token.expires_in * 1000;

    if (sessionRef.current) {
      sessionRef.current = {
        ...sessionRef.current,
        accessToken: token.access_token,
        expiresAt,
      };
    }

    setState((current) => {
      if (current.kind === "ready") {
        return {
          kind: "ready",
          session: {
            ...current.session,
            accessToken: token.access_token,
            expiresAt,
          },
        };
      }

      if (current.kind === "locked") {
        return {
          kind: "locked",
          session: {
            ...current.session,
            accessToken: token.access_token,
            expiresAt,
          },
        };
      }

      return current;
    });
  }

  async function handleSessionExpired() {
    sessionRef.current = null;
    await clearPersistedSession();
    setState({
      kind: "anonymous",
    });
  }

  if (!apiRef.current) {
    apiRef.current = new WhisperApiClient({
      getSession: () => sessionRef.current,
      setAccessToken: handleTokenUpdate,
      onSessionExpired: handleSessionExpired,
    });
  }

  const api = apiRef.current;
  const readySession = state.kind === "ready" ? state.session : null;
  const messaging = useMessaging(readySession, readySession ? api : null);

  useEffect(() => {
    sessionRef.current = snapshotFromState(state);
  }, [state]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const persisted = await loadPersistedSession();

        if (!persisted) {
          if (!cancelled) {
            setState({
              kind: "anonymous",
            });
          }
          return;
        }

        sessionRef.current = {
          accessToken: "",
          refreshToken: persisted.refreshToken,
          expiresAt: 0,
          user: persisted.user,
        };

        const refreshed = await api.refreshAccessToken();
        const profile = await api.me();
        await savePersistedSession({
          refreshToken: persisted.refreshToken,
          user: profile,
          savedAt: new Date().toISOString(),
        });

        if (!cancelled) {
          setState({
            kind: "locked",
            session: {
              accessToken: refreshed.access_token,
              refreshToken: persisted.refreshToken,
              expiresAt: Date.now() + refreshed.expires_in * 1000,
              user: profile,
              reason: "Session restored. Unlock with your password to recover the private key.",
            },
          });
        }
      } catch {
        await clearPersistedSession();

        if (!cancelled) {
          setState({
            kind: "anonymous",
          });
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const snapshot = snapshotFromState(state);

    if (!snapshot) {
      return;
    }

    const refreshInMs = Math.max(snapshot.expiresAt - Date.now() - 60_000, 5_000);
    const timer = window.setTimeout(() => {
      void api.refreshAccessToken().catch(() => {
        void handleSessionExpired();
      });
    }, refreshInMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [api, state.kind === "ready" ? state.session.accessToken : state.kind === "locked" ? state.session.accessToken : null]);

  async function finishAuthentication(response: AuthResponse, privateKey: CryptoKey) {
    const nextSession: ReadySession = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      user: response.user,
      privateKey,
    };

    sessionRef.current = {
      accessToken: nextSession.accessToken,
      refreshToken: nextSession.refreshToken,
      expiresAt: nextSession.expiresAt,
      user: nextSession.user,
    };

    await savePersistedSession({
      refreshToken: response.refresh_token,
      user: response.user,
      savedAt: new Date().toISOString(),
    });

    setState({
      kind: "ready",
      session: nextSession,
    });
    setAuthError(null);
    setUnlockError(null);
  }

  async function handleLogin(form: LoginForm) {
    setAuthBusy(true);
    setAuthError(null);

    try {
      const response = await api.login(form);
      const privateKey = await unwrapPrivateKey(
        form.password,
        response.user.wrapped_private_key,
        response.user.pbkdf2_salt,
      );

      await finishAuthentication(response, privateKey);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleRegister(form: RegisterForm) {
    setAuthBusy(true);
    setAuthError(null);

    try {
      const identity = await generateIdentity(form.password);
      const response = await api.register({
        ...form,
        publicKey: identity.publicKey,
        wrappedPrivateKey: identity.wrappedPrivateKey,
        pbkdf2Salt: identity.pbkdf2Salt,
      });

      await finishAuthentication(response, identity.privateKey);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Registration failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleUnlock(password: string) {
    if (state.kind !== "locked") {
      return;
    }

    setUnlockBusy(true);
    setUnlockError(null);

    try {
      const privateKey = await unwrapPrivateKey(
        password,
        state.session.user.wrapped_private_key,
        state.session.user.pbkdf2_salt,
      );

      setState({
        kind: "ready",
        session: {
          ...state.session,
          privateKey,
        },
      });
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : "Unable to unlock private key.");
    } finally {
      setUnlockBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Clear local state even when token revocation fails.
    } finally {
      sessionRef.current = null;
      await clearPersistedSession();
      setState({
        kind: "anonymous",
      });
      setAuthMode("login");
      setAuthError(null);
      setUnlockError(null);
    }
  }

  if (state.kind === "booting") {
    return (
      <main className="boot-screen">
        <div className="boot-card">
          <p>Initializing secure workspace</p>
          <h1>Loading wrapped keys, session metadata, and encrypted threads.</h1>
        </div>
      </main>
    );
  }

  if (state.kind === "anonymous") {
    return (
      <AuthScreen
        busy={authBusy}
        error={authError}
        mode={authMode}
        onLogin={handleLogin}
        onModeChange={setAuthMode}
        onRegister={handleRegister}
      />
    );
  }

  if (state.kind === "locked") {
    return (
      <UnlockScreen
        busy={unlockBusy}
        error={unlockError}
        note={state.session.reason}
        user={state.session.user}
        onLogout={handleLogout}
        onUnlock={handleUnlock}
      />
    );
  }

  return (
    <main className="app-shell">
      <ConversationList
        conversations={messaging.conversations}
        loading={messaging.loadingConversations}
        search={messaging.search}
        searchQuery={messaging.searchQuery}
        selectedConversationUserId={messaging.selectedConversationUserId}
        user={state.session.user}
        wsStatus={messaging.wsStatus}
        onLogout={handleLogout}
        onSearchChange={messaging.setSearchQuery}
        onSelect={messaging.selectConversation}
      />
      <MessagePanel
        conversation={messaging.activeConversation}
        error={messaging.actionError}
        hasOlderMessages={messaging.hasOlderMessages}
        loadingMessages={messaging.loadingMessages}
        loadingOlder={messaging.loadingOlder}
        messages={messaging.activeMessages}
        sending={messaging.sending}
        onLoadOlder={messaging.loadOlderMessages}
        onSend={async (value) => {
          if (!messaging.activeConversation) {
            return;
          }

          await messaging.sendMessage(messaging.activeConversation, value);
        }}
      />
    </main>
  );
}

function snapshotFromState(state: AuthViewState): SessionSnapshot | null {
  if (state.kind === "ready") {
    return {
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken,
      expiresAt: state.session.expiresAt,
      user: state.session.user,
    };
  }

  if (state.kind === "locked") {
    return {
      accessToken: state.session.accessToken,
      refreshToken: state.session.refreshToken,
      expiresAt: state.session.expiresAt,
      user: state.session.user,
    };
  }

  return null;
}

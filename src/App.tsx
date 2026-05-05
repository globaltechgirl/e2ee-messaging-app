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

  async function persistSessionSafely(snapshot: SessionSnapshot) {
    try {
      await savePersistedSession({
        refreshToken: snapshot.refreshToken,
        user: snapshot.user,
        savedAt: new Date().toISOString(),
      });
    } catch {
      // Live sessions should continue even if durable browser storage is unavailable.
    }
  }

  async function clearSessionSafely() {
    try {
      await clearPersistedSession();
    } catch {
      // Ignore storage cleanup failures during logout or expiry handling.
    }
  }

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
    await clearSessionSafely();
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
        await persistSessionSafely({
          accessToken: refreshed.access_token,
          refreshToken: persisted.refreshToken,
          expiresAt: Date.now() + refreshed.expires_in * 1000,
          user: profile,
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
        await clearSessionSafely();

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

    setState({
      kind: "ready",
      session: nextSession,
    });
    await persistSessionSafely(nextSession);
    setAuthError(null);
    setUnlockError(null);
  }

  async function handleLogin(form: LoginForm) {
    setAuthBusy(true);
    setAuthError(null);

    try {
      const normalizedForm = normalizeLoginForm(form);
      validateLoginForm(normalizedForm);
      const response = await api.login(normalizedForm);
      const privateKey = await unwrapPrivateKey(
        normalizedForm.password,
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
      const normalizedForm = normalizeRegisterForm(form);
      validateRegisterForm(normalizedForm);
      const identity = await generateIdentity(normalizedForm.password);
      const response = await api.register({
        ...normalizedForm,
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
      await clearSessionSafely();
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
        <p>Initializing WhisperBox Secure Chat</p>
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
        onModeChange={(mode) => {
          setAuthMode(mode);
          setAuthError(null);
        }}
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
            return false;
          }

          return messaging.sendMessage(messaging.activeConversation, value);
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

function normalizeLoginForm(form: LoginForm): LoginForm {
  return {
    username: form.username.trim().toLowerCase(),
    password: form.password,
  };
}

function normalizeRegisterForm(form: RegisterForm): RegisterForm {
  return {
    username: form.username.trim().toLowerCase(),
    displayName: form.displayName.trim(),
    password: form.password,
  };
}

function validateLoginForm(form: LoginForm) {
  if (form.username.length < 3) {
    throw new Error("Username must be at least 3 characters.");
  }

  if (form.username.length > 32) {
    throw new Error("Username must be 32 characters or fewer.");
  }

  if (form.password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  if (form.password.length > 128) {
    throw new Error("Password must be 128 characters or fewer.");
  }
}

function validateRegisterForm(form: RegisterForm) {
  validateLoginForm(form);

  if (!form.displayName) {
    throw new Error("Display name is required.");
  }

  if (form.displayName.length > 128) {
    throw new Error("Display name must be 128 characters or fewer.");
  }
}

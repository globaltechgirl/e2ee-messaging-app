import { type FormEvent, useState } from "react";
import type { LoginForm, RegisterForm } from "../types";

interface AuthScreenProps {
  mode: "login" | "register";
  busy: boolean;
  error: string | null;
  onModeChange: (mode: "login" | "register") => void;
  onLogin: (form: LoginForm) => Promise<void>;
  onRegister: (form: RegisterForm) => Promise<void>;
}

export function AuthScreen(props: AuthScreenProps) {
  const [loginForm, setLoginForm] = useState<LoginForm>({
    username: "",
    password: "",
  });
  const [registerForm, setRegisterForm] = useState<RegisterForm>({
    username: "",
    displayName: "",
    password: "",
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (props.mode === "login") {
      await props.onLogin(loginForm);
      return;
    }

    await props.onRegister(registerForm);
  }

  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <div className="auth-hero__eyebrow">Whispy Secure Messaging</div>
        <h1>Private conversations that stay private.</h1>
        <p>
          Keys are generated in your browser, private keys stay wrapped, and the backend stores ciphertext only.
        </p>
        <div className="auth-hero__grid">
          <article>
            <span>Client-side crypto</span>
            <strong>RSA-OAEP + AES-GCM</strong>
          </article>
          <article>
            <span>Private key handling</span>
            <strong>Wrapped, never plaintext at rest</strong>
          </article>
          <article>
            <span>Session security</span>
            <strong>Short-lived access tokens</strong>
          </article>
        </div>
      </section>

      <section className="auth-card">
        <div className="auth-card__header">
          <div>
            <p className="auth-card__label">Secure Access</p>
            <h2>{props.mode === "login" ? "Welcome back" : "Create your secure inbox"}</h2>
          </div>
          <div className="auth-card__switcher">
            <button
              className={props.mode === "login" ? "is-active" : undefined}
              type="button"
              onClick={() => props.onModeChange("login")}
            >
              Login
            </button>
            <button
              className={props.mode === "register" ? "is-active" : undefined}
              type="button"
              onClick={() => props.onModeChange("register")}
            >
              Register
            </button>
          </div>
        </div>

        <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
          {props.mode === "register" ? (
            <>
              <label>
                <span>Display name</span>
                <input
                  autoCapitalize="words"
                  autoComplete="name"
                  disabled={props.busy}
                  minLength={1}
                  maxLength={128}
                  placeholder="Ada Lovelace"
                  required
                  value={registerForm.displayName}
                  onChange={(event) =>
                    setRegisterForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>Username</span>
                <input
                  autoCapitalize="none"
                  autoComplete="username"
                  disabled={props.busy}
                  minLength={3}
                  maxLength={32}
                  placeholder="ada_secure"
                  required
                  spellCheck={false}
                  value={registerForm.username}
                  onChange={(event) =>
                    setRegisterForm((current) => ({
                      ...current,
                      username: event.target.value,
                    }))
                  }
                />
              </label>
            </>
          ) : (
            <label>
              <span>Username</span>
              <input
                autoCapitalize="none"
                autoComplete="username"
                disabled={props.busy}
                minLength={3}
                maxLength={32}
                placeholder="ada_secure"
                required
                spellCheck={false}
                value={loginForm.username}
                onChange={(event) =>
                  setLoginForm((current) => ({
                    ...current,
                    username: event.target.value,
                  }))
                }
              />
            </label>
          )}

          <label>
            <span>Password</span>
            <input
              autoComplete={props.mode === "login" ? "current-password" : "new-password"}
              disabled={props.busy}
              minLength={8}
              maxLength={128}
              placeholder="Minimum 8 characters"
              required
              type="password"
              value={props.mode === "login" ? loginForm.password : registerForm.password}
              onChange={(event) => {
                const password = event.target.value;

                if (props.mode === "login") {
                  setLoginForm((current) => ({
                    ...current,
                    password,
                  }));
                  return;
                }

                setRegisterForm((current) => ({
                  ...current,
                  password,
                }));
              }}
            />
          </label>

          {props.error ? <p className="form-error">{props.error}</p> : null}

          <button className="primary-button" disabled={props.busy} type="submit">
            {props.busy ? "Securing session..." : props.mode === "login" ? "Unlock inbox" : "Generate keys and continue"}
          </button>
        </form>

        <p className="auth-card__footnote">
          Your password derives the wrapping key used to protect your private key. The server never receives the plaintext private key.
        </p>
      </section>
    </main>
  );
}

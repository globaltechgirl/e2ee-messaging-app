import { useState } from "react";
import type { UserProfile } from "../types";

interface UnlockScreenProps {
  busy: boolean;
  error: string | null;
  note: string;
  user: UserProfile;
  onUnlock: (password: string) => Promise<void>;
  onLogout: () => Promise<void>;
}

export function UnlockScreen(props: UnlockScreenProps) {
  const [password, setPassword] = useState("");

  return (
    <main className="unlock-shell">
      <section className="unlock-card">
        <div className="unlock-card__topline">Session restored</div>
        <h1>Unlock your private key</h1>
        <p>
          Your refresh token restored the account session, but your private key remains wrapped until you re-enter your password.
        </p>

        <div className="unlock-card__identity">
          <strong>{props.user.display_name}</strong>
          <span>@{props.user.username}</span>
        </div>

        <p>{props.note}</p>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onUnlock(password);
          }}
        >
          <label>
            <span>Password</span>
            <input
              autoComplete="current-password"
              disabled={props.busy}
              minLength={8}
              maxLength={128}
              placeholder="Enter your password"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {props.error ? <p className="form-error">{props.error}</p> : null}

          
        </form>

        <div className="duo-buttons">
          <button className="primary-button" disabled={props.busy} type="submit">
            {props.busy ? "Restoring private key..." : "Unlock secure messages"}
          </button>

          <button className="ghost-buttons" disabled={props.busy} type="button" onClick={() => void props.onLogout()}>
            Sign out instead
          </button>
        </div>
      </section>
    </main>
  );
}

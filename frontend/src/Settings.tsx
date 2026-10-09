import { useEffect, useRef, useState } from "react";
import { api, type Status } from "./api";
import type { Run } from "./Library";
type Session = {
  id: string;
  verificationUrl: string;
  userCode: string;
  expiresIn: number;
  interval?: number;
};
export function Settings({
  status,
  run,
  busy,
  refresh,
}: {
  status: Status | null;
  run: Run;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState(""),
    [clientSecret, setClientSecret] = useState(""),
    [session, setSession] = useState<Session | null>(null),
    [authMessage, setAuthMessage] = useState(""),
    [deadline, setDeadline] = useState(0),
    [remaining, setRemaining] = useState(0);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let interval = Math.max(5, session.interval ?? 5) * 1000;
    const abort = new AbortController();
    async function poll() {
      if (stopped) return;
      if (Date.now() >= deadline) {
        setAuthMessage("The device code expired. Start sign-in again.");
        setSession(null);
        return;
      }
      try {
        const result = await api<{
          status: string;
          message: string;
          interval?: number;
        }>(
          "/auth/poll/" + encodeURIComponent(session!.id),
          undefined,
          abort.signal,
        );
        if (stopped) return;
        setAuthMessage(result.message || result.status);
        if (result.status !== "pending") {
          setSession(null);
          await refreshRef.current();
          return;
        }
        interval = Math.max(interval, (result.interval ?? 5) * 1000);
        if (/slow.down/i.test(result.message)) interval += 5000;
      } catch (e) {
        if (stopped) return;
        setAuthMessage(
          e instanceof Error ? e.message : "Sign-in polling failed.",
        );
        setSession(null);
        return;
      }
      if (!stopped) timer = setTimeout(poll, interval);
    }
    timer = setTimeout(poll, interval);
    const clock = setInterval(
      () =>
        setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))),
      1000,
    );
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [session, deadline]);
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Settings</h1>
          <p>Local storage, account connection, and system readiness.</p>
        </div>
      </div>
      <section className="panel settings-section">
        <div className="row spread">
          <h3>YouTube Music account</h3>
          <span className="badge">
            {status?.auth.authenticated
              ? "SIGNED IN"
              : status?.auth.configured
                ? "CLIENT CONFIGURED"
                : "NOT CONNECTED"}
          </span>
        </div>
        <p>
          Use your own Google OAuth client for{" "}
          <strong>TVs and Limited Input devices</strong>. Enable YouTube Data
          API v3 in your Google Cloud project and configure the OAuth consent
          screen. If the app is in testing, add your Google account as a test
          user.
        </p>
        <div className="external-links">
          <a
            href="https://ytmusicapi.readthedocs.io/en/stable/setup/oauth.html"
            target="_blank"
            rel="noreferrer"
          >
            Official ytmusicapi OAuth setup
          </a>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
          >
            Google Cloud credentials
          </a>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(
              () =>
                api("/auth/config", {
                  clientId: clientId.trim(),
                  clientSecret,
                }),
              "OAuth client saved securely on this Mac.",
            );
            if (ok) {
              setClientSecret("");
              setClientId("");
              setSession(null);
            }
          }}
        >
          <div className="form-grid">
            <label>
              OAuth client ID
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Your TV / limited-input client ID"
                autoComplete="off"
                required
              />
            </label>
            <label>
              OAuth client secret
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                required
                placeholder="Stored by the local server only"
              />
            </label>
          </div>
          <p className="footnote">
            Credentials and tokens stay on your local server. They are never
            saved in browser storage. This is a client secret, not your Google
            password.
          </p>
          <button
            disabled={busy || !status || !clientId.trim() || !clientSecret}
            className="primary"
          >
            Save OAuth client
          </button>
        </form>
        <div className="account-actions">
          {status?.auth.authenticated ? (
            <button
              disabled={busy}
              onClick={() =>
                void run(
                  () => api("/auth/logout", {}),
                  "Signed out of YouTube Music.",
                )
              }
            >
              Sign out
            </button>
          ) : (
            <button
              className="button"
              disabled={busy || !status?.auth.configured || !!session}
              onClick={() =>
                void run(async () => {
                  const s = await api<Session>("/auth/start", {});
                  setSession(s);
                  setDeadline(Date.now() + s.expiresIn * 1000);
                  setRemaining(s.expiresIn);
                  setAuthMessage("Waiting for approval on Google…");
                }, "Device sign-in started.")
              }
            >
              Sign in with Google device code
            </button>
          )}
        </div>
        {session && (
          <div className="auth-code">
            <h4>Finish sign-in on Google</h4>
            <p>Open the link, enter this code, and approve access.</p>
            <code>{session.userCode}</code>
            {/^https:\/\/(?:[\w-]+\.)*google\.com\//.test(
              session.verificationUrl,
            ) ? (
              <a
                className="button primary"
                href={session.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Google verification
              </a>
            ) : (
              <p className="field-error">
                The server returned an unexpected verification link. Do not use
                it.
              </p>
            )}
            <p>
              Expires in {remaining} seconds. Polling respects Google’s
              interval.
            </p>
            <button
              onClick={() => {
                setSession(null);
                setAuthMessage(
                  "Sign-in stopped locally. The code will expire on Google.",
                );
              }}
            >
              Stop waiting
            </button>
          </div>
        )}
        {authMessage && <p role="status">{authMessage}</p>}
      </section>
      <section className="panel settings-section">
        <h3>Local environment</h3>
        <dl className="system-list">
          <div>
            <dt>Library location</dt>
            <dd>{status?.libraryPath || "Waiting for server"}</dd>
          </div>
          <div>
            <dt>MP3 conversion · ffmpeg</dt>
            <dd>
              {status
                ? status.dependencies.ffmpeg
                  ? "Available"
                  : "Not installed"
                : "Unknown"}
            </dd>
          </div>
          <div>
            <dt>YouTube downloads · yt-dlp</dt>
            <dd>
              {status
                ? status.dependencies.yt_dlp
                  ? "Available"
                  : "Not installed"
                : "Unknown"}
            </dd>
          </div>
          <div>
            <dt>USB detection</dt>
            <dd>
              {status
                ? "Automatic · refreshes every 3 seconds"
                : "Unavailable until server connects"}
            </dd>
          </div>
        </dl>
        <p>
          ShokzLink runs locally. Downloads require both dependencies. Account
          access does not bypass DRM or YouTube download restrictions.
        </p>
      </section>
    </>
  );
}

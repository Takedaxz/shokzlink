import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  Music2,
  LibraryBig,
  Youtube,
  ListMusic,
  Download,
  Settings2,
  Usb,
  ArrowUpRight,
  RefreshCw,
  Menu,
  X,
} from "lucide-react";
import { api, bytes, type Status } from "./api";
import { Library, type Run } from "./Library";
import { Online, Downloads } from "./Online";
import { Settings } from "./Settings";

const pages = [
  { id: "Library", icon: LibraryBig, group: "Collection" },
  { id: "Downloads", icon: Download, group: "Collection" },
  { id: "YouTube", icon: Youtube, group: "Discover" },
  { id: "YouTube Music", icon: ListMusic, group: "Discover" },
  { id: "Settings", icon: Settings2, group: "Manage" },
] as const;
type Page = (typeof pages)[number]["id"];

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>("Library");
  const [status, setStatus] = useState<Status | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [eject, setEject] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mutation = useRef(false);
  const ejectDialog = useRef<HTMLDialogElement>(null);
  const ejectButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await api<Status>("/status");
      if (mounted.current) {
        setStatus(data);
        setConnectionError("");
      }
    } catch (e) {
      if (mounted.current) {
        setStatus(null);
        setConnectionError(
          e instanceof Error
            ? e.message
            : "Cannot connect to the local server.",
        );
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick(): Promise<void> {
      await refresh();
      if (!stopped) timer = setTimeout(tick, 3000);
    }
    void tick();
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!menuOpen) return;
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  const run: Run = async (task, success) => {
    if (mutation.current) return false;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await task();
      setNotice(typeof result === "string" ? result : success);
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
      await refresh();
      return false;
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (eject) ejectDialog.current?.showModal();
    else if (ejectDialog.current?.open) {
      ejectDialog.current.close();
      ejectButton.current?.focus();
    }
  }, [eject]);
  function navigate(next: Page): void {
    setPage(next);
    setMenuOpen(false);
    setError("");
    setNotice("");
    document.getElementById("main")?.focus({ preventScroll: true });
  }
  const device = status?.device;
  const connected = !!device?.connected;
  const activeJobs =
    status?.jobs.filter(
      (j) => j.status === "queued" || j.status === "downloading",
    ).length ?? 0;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="header-brand">
          <button
            ref={menuButton}
            className="menu-toggle"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <a
            className="brand"
            href="#main"
            onClick={(event) => {
              event.preventDefault();
              navigate("Library");
            }}
          >
            <Music2 size={22} aria-hidden="true" /> ShokzLink
          </a>
        </div>
        <span className="header-context">Media workspace</span>
        <div className="header-actions">
          <span className="local-badge">
            <span className={"dot " + (status ? "online" : "")} />
            {status ? "Local server online" : "Server unavailable"}
          </span>
          <button
            className="primary header-browse"
            onClick={() => navigate("YouTube")}
          >
            Browse music <ArrowUpRight size={16} />
          </button>
        </div>
      </header>
      <aside
        id="workspace-navigation"
        className={"sidebar" + (menuOpen ? " menu-open" : "")}
      >
        <nav aria-label="Main navigation">
          {pages.map((item, index) => (
            <Fragment key={item.id}>
              {(index === 0 || pages[index - 1].group !== item.group) && (
                <div className="nav-label">{item.group}</div>
              )}
              <button
                className={page === item.id ? "nav-item active" : "nav-item"}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} aria-hidden="true" />
                <span>{item.id}</span>
                {item.id === "Downloads" && activeJobs > 0 && (
                  <span className="nav-count">{activeJobs}</span>
                )}
              </button>
            </Fragment>
          ))}
        </nav>
        <section className="device-card" aria-label="Device status">
          <div className="row spread">
            <span className="device-label">
              <Usb size={18} /> USB device
            </span>
            <span className={"status-dot " + (connected ? "online" : "")}>
              {!status ? "Unknown" : connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          <h3>{device?.name || "SWIM PRO"}</h3>
          <p>
            {!status
              ? "Waiting for the local server."
              : connected
                ? "Connected by USB. Transfers are manual."
                : "Connect your Shokz with its USB cable."}
          </p>
          {connected && device ? (
            <>
              <div className="row spread storage-label">
                <span>{bytes(device.total - device.free)} used</span>
                <span>{bytes(device.total)}</span>
              </div>
              <progress
                max={device.total || 1}
                value={device.total - device.free}
                aria-label="Device storage used"
              />
              <p>
                {bytes(device.free)} available · {device.tracks.length} tracks
              </p>
              <button
                ref={ejectButton}
                disabled={busy}
                onClick={() => setEject(true)}
              >
                Safely eject <ArrowUpRight size={16} />
              </button>
            </>
          ) : (
            <p className="footnote">Detected automatically when mounted.</p>
          )}
        </section>
        <p className="sidebar-footer">On your Mac. Under your control.</p>
      </aside>
      <div className="workspace">
        <main id="main" tabIndex={-1}>
          <div className="page-eyebrow">
            <span>Media</span>
            <span aria-hidden="true">/</span>
            {page}
          </div>
          {connectionError && (
            <div className="error" role="alert">
              <div>
                <strong>Cannot reach the local server</strong>
                <p>
                  {connectionError} Start ShokzLink’s backend at 127.0.0.1:8765.
                  Retrying automatically.
                </p>
              </div>
              <button onClick={() => void refresh()}>
                <RefreshCw size={16} /> Retry
              </button>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              <p>{error}</p>
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice("")}>Dismiss</button>
            </div>
          )}
          {page === "Library" && (
            <Library status={status} run={run} busy={busy} error={error} />
          )}
          {(page === "YouTube" || page === "YouTube Music") && (
            <Online
              key={page}
              music={page === "YouTube Music"}
              status={status}
              run={run}
              busy={busy}
              openSettings={() => navigate("Settings")}
            />
          )}
          {page === "Downloads" && (
            <Downloads status={status} run={run} busy={busy} />
          )}
          {page === "Settings" && (
            <Settings status={status} run={run} busy={busy} refresh={refresh} />
          )}
        </main>
        <footer className="workspace-footer">
          <span>ShokzLink</span>
          <span>Local MP3 library · USB transfer</span>
        </footer>
      </div>
      <dialog
        ref={ejectDialog}
        aria-labelledby="eject-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setEject(false);
        }}
      >
        <h2 id="eject-title">Eject {device?.name || "SWIM PRO"}?</h2>
        <p>
          Finish transfers before disconnecting. Wait for the device to
          disappear before unplugging its USB cable.
        </p>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button disabled={busy} onClick={() => setEject(false)}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !connected}
            onClick={async () => {
              if (
                await run(
                  () => api("/device/eject", {}),
                  "Device ejected. You may disconnect the USB cable.",
                )
              )
                setEject(false);
            }}
          >
            Safely eject
          </button>
        </div>
      </dialog>
    </div>
  );
}

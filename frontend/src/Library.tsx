import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Music2,
  Play,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, bytes, filterTracks, type Track, type Status } from "./api";
export type Run = (
  task: () => Promise<unknown>,
  success: string,
) => Promise<boolean>;
export function Library({
  status,
  run,
  busy,
  error = "",
}: {
  status: Status | null;
  run: Run;
  busy: boolean;
  error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState<{
    track: Track;
    scope: "library" | "device";
  } | null>(null);
  const [volume, setVolume] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("shokzlink_volume");
      if (saved !== null) {
        const val = parseFloat(saved);
        if (!Number.isNaN(val) && val >= 0 && val <= 1) {
          return val;
        }
      }
    } catch {}
    return 1;
  });

  useEffect(() => {
    if (!playing) return;
    if (playing.scope === "device" && !status?.device.connected) {
      setPlaying(null);
      return;
    }
    const currentList =
      playing.scope === "library"
        ? status?.library
        : status?.device.tracks;
    if (currentList && !currentList.some((t) => t.path === playing.track.path)) {
      setPlaying(null);
    }
  }, [
    playing,
    status?.device.connected,
    status?.library,
    status?.device.tracks,
  ]);

  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Music library</h1>
          <p>Manage the MP3s on your Mac and your Shokz.</p>
        </div>
        <button
          className="primary"
          disabled={busy || !status}
          onClick={() => input.current?.click()}
        >
          <Upload size={18} /> Import MP3s
        </button>
        <input
          ref={input}
          type="file"
          accept=".mp3,audio/mpeg"
          multiple
          hidden
          aria-label="Import MP3 files"
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!files.length) return;
            const form = new FormData();
            files.forEach((f) => form.append("files", f));
            await run(async () => {
              const result = await api<{ imported: number }>(
                "/library/import",
                form,
              );
              return `${result.imported} tracks imported.`;
            }, "Import complete.");
          }}
        />
      </div>
      <div className="libraries">
        <TrackPanel
          scope="library"
          tracks={status?.library ?? []}
          folders={status?.folders ?? []}
          status={status}
          run={run}
          busy={busy}
          error={error}
          playing={playing}
          onPlay={(track, s) => setPlaying({ track, scope: s })}
        />
        <TrackPanel
          scope="device"
          tracks={status?.device.tracks ?? []}
          folders={status?.device.folders ?? []}
          status={status}
          run={run}
          busy={busy}
          error={error}
          playing={playing}
          onPlay={(track, s) => setPlaying({ track, scope: s })}
        />
      </div>
      <p className="footnote">
        Transfers are manual. Existing files are never overwritten. Connect your
        SWIM PRO with its USB cable to manage device storage.
      </p>
      {playing && (
        <section
          className="panel audio-player-popup"
          role="region"
          aria-label="Media player"
        >
          <div className="audio-player-meta">
            <div className="audio-player-icon">
              <Music2 size={18} />
            </div>
            <div className="audio-player-text">
              <strong title={playing.track.title}>{playing.track.title}</strong>
              <span>
                {playing.scope === "library" ? "Local library" : "SWIM PRO"} ·{" "}
                {bytes(playing.track.size)}
              </span>
            </div>
          </div>
          <audio
            key={`${playing.scope}-${playing.track.path}`}
            ref={(el) => {
              if (el) {
                el.volume = volume;
              }
            }}
            controls
            autoPlay
            onVolumeChange={(e) => {
              const val = e.currentTarget.volume;
              setVolume(val);
              try {
                localStorage.setItem("shokzlink_volume", String(val));
              } catch {}
            }}
            src={`/api/files/stream?scope=${encodeURIComponent(playing.scope)}&path=${encodeURIComponent(playing.track.path)}`}
          />
          <button
            type="button"
            className="audio-player-close"
            aria-label="Close media player"
            title="Close media player"
            onClick={() => setPlaying(null)}
          >
            <X size={18} />
          </button>
        </section>
      )}
    </>
  );
}
function TrackPanel({
  scope,
  tracks,
  folders,
  status,
  run,
  busy,
  error,
  playing,
  onPlay,
}: {
  scope: "library" | "device";
  tracks: Track[];
  folders: string[];
  status: Status | null;
  run: Run;
  busy: boolean;
  error: string;
  playing: { track: Track; scope: "library" | "device" } | null;
  onPlay: (t: Track, scope: "library" | "device") => void;
}) {
  const [query, setQuery] = useState(""),
    [sort, setSort] = useState(() => {
      try {
        const saved = localStorage.getItem(`shokzlink_${scope}_sort`);
        if (saved === "name" || saved === "newest" || saved === "size") {
          return saved;
        }
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        console.warn("Unable to restore sorting preference", {
          scope,
          error: error.name,
        });
      }
      return "name";
    }),
    [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState("");
  const [currentFolder, setCurrentFolder] = useState<string>("");
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [edit, setEdit] = useState<
      "rename" | "move" | "delete" | "transfer" | null
    >(null),
    [value, setValue] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    back = useRef<HTMLElement | null>(null);

  const crumbs = useMemo(() => {
    const list = [
      {
        name: scope === "library" ? "Root" : (status?.device.name || "Root"),
        path: "",
      },
    ];
    if (currentFolder) {
      const parts = currentFolder.split("/");
      let accum = "";
      for (const part of parts) {
        accum = accum ? `${accum}/${part}` : part;
        list.push({ name: part, path: accum });
      }
    }
    return list;
  }, [currentFolder, scope, status?.device.name]);

  const directSubfolders = useMemo(() => {
    const map = new Map<string, { fullPath: string; name: string }>();
    for (const f of folders) {
      if (!f) continue;
      if (!currentFolder) {
        const name = f.split("/")[0];
        if (!map.has(name)) {
          map.set(name, { fullPath: name, name });
        }
      } else if (f.startsWith(currentFolder + "/")) {
        const sub = f.slice(currentFolder.length + 1);
        const name = sub.split("/")[0];
        const fullPath = `${currentFolder}/${name}`;
        if (!map.has(fullPath)) {
          map.set(fullPath, { fullPath, name });
        }
      }
    }
    return Array.from(map.values()).map((item) => ({
      ...item,
      count: tracks.filter(
        (t) => t.path === item.fullPath || t.path.startsWith(item.fullPath + "/"),
      ).length,
    }));
  }, [folders, currentFolder, tracks]);

  const folderTracks = useMemo(() => {
    if (query.trim()) {
      return tracks;
    }
    return tracks.filter((t) => {
      const idx = t.path.lastIndexOf("/");
      const parent = idx >= 0 ? t.path.slice(0, idx) : "";
      return parent === currentFolder;
    });
  }, [tracks, currentFolder, query]);

  const visible = useMemo(
    () => filterTracks(folderTracks, query, sort),
    [folderTracks, query, sort],
  );
  const ready = !!status && (scope === "library" || status.device.connected);
  useEffect(() => {
    setSelected((s) => s.filter((p) => tracks.some((t) => t.path === p)));
  }, [tracks]);
  useEffect(() => {
    if (edit) {
      back.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      dialog.current.close();
      back.current?.focus();
    }
  }, [edit]);
  useEffect(() => {
    if (scope === "device") {
      setSelected([]);
      setEdit(null);
      setCurrentFolder("");
    }
  }, [scope, status?.device.mount]);
  const chosen = tracks.filter((t) => selected.includes(t.path));
  const open = (kind: typeof edit) => {
    setValue(kind === "rename" ? (chosen[0]?.name ?? "") : target);
    setEdit(kind);
  };

  async function handleDrop(e: React.DragEvent, targetFolder: string) {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const mp3s = Array.from(e.dataTransfer.files).filter(
        (f) => f.name.toLowerCase().endsWith(".mp3") || f.type === "audio/mpeg",
      );
      if (!mp3s.length) return;
      const form = new FormData();
      mp3s.forEach((f) => form.append("files", f));
      form.append("folder", targetFolder);
      form.append("scope", scope);
      await run(async () => {
        const res = await api<{ imported: number }>("/library/import", form);
        return `${res.imported} track${res.imported === 1 ? "" : "s"} imported.`;
      }, "Files imported.");
      return;
    }

    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const paths: string[] = data.paths;
      if (!paths || !Array.isArray(paths) || !paths.length) return;

      if (data.scope === scope) {
        await run(async () => {
          await api("/files/move", { scope, paths, folder: targetFolder });
          return `${paths.length} track${paths.length === 1 ? "" : "s"} moved to ${targetFolder || "root folder"}.`;
        }, "Tracks moved.");
        setSelected([]);
      } else if (scope === "device" && data.scope === "library") {
        if (!status?.device.connected) return;
        await run(async () => {
          const res = await api<{ copied: number; skipped: number }>("/transfer", {
            paths,
            folder: targetFolder,
          });
          return `${res.copied} copied; ${res.skipped} skipped.`;
        }, "Tracks transferred.");
        setSelected([]);
      }
    } catch {}
  }

  async function createSubfolder(name: string) {
    const clean = name.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    const fullPath = currentFolder ? `${currentFolder}/${clean}` : clean;
    await run(async () => {
      await api("/folders/create", { scope, folder: fullPath });
      return `Folder "${clean}" created.`;
    }, "Folder created.");
    setIsCreatingFolder(false);
    setNewFolderName("");
  }

  async function deleteEmptyFolder(folderPath: string) {
    await run(async () => {
      await api("/folders/delete", { scope, folder: folderPath });
      return "Folder deleted.";
    }, "Folder deleted.");
    if (currentFolder === folderPath || currentFolder.startsWith(folderPath + "/")) {
      const idx = folderPath.lastIndexOf("/");
      setCurrentFolder(idx >= 0 ? folderPath.slice(0, idx) : "");
    }
  }

  async function submit() {
    if (!edit) return;
    const action = edit;
    const done = await run(
      async () => {
        if (action === "delete") {
          const r = await api<{ deleted: number }>("/files/delete", {
            scope,
            paths: selected,
            confirm: true,
          });
          return `${r.deleted} tracks deleted.`;
        }
        if (action === "transfer") {
          const r = await api<{ copied: number; skipped: number }>(
            "/transfer",
            { paths: selected, folder: value },
          );
          return `${r.copied} copied; ${r.skipped} skipped.`;
        }
        if (action === "rename")
          await api("/files/rename", { scope, path: selected[0], name: value });
        if (action === "move") {
          await api("/files/move", { scope, paths: selected, folder: value });
          return `${selected.length} tracks moved.`;
        }
      },
      action === "move" ? "Selected tracks moved." : "Track renamed.",
    );
    if (done) {
      setSelected([]);
      setEdit(null);
    }
  }
  const all =
    visible.length > 0 && visible.every((t) => selected.includes(t.path));
  return (
    <section
      className="panel library-panel"
      aria-label={scope === "library" ? "Local library" : "Device library"}
    >
      <div className="panel-top">
        <div className="icon-tile">
          {scope === "library" ? <Music2 size={22} /> : <HardDrive size={22} />}
        </div>
        <div>
          <h3>
            {scope === "library"
              ? "Local library"
              : status?.device.name || "SWIM PRO"}
          </h3>
          <p>
            {!status
              ? "Waiting for server"
              : scope === "device" && !status.device.connected
                ? "Not connected"
                : `${tracks.length} tracks · ${bytes(tracks.reduce((a, t) => a + t.size, 0))}`}
          </p>
        </div>
        <span className="badge">
          {!status
            ? "UNKNOWN"
            : scope === "library"
              ? "ON THIS MAC"
              : status?.device.connected
                ? "CONNECTED"
                : "OFFLINE"}
        </span>
      </div>
      <div className="filters">
        <input
          aria-label={`Search ${scope} tracks`}
          placeholder="Search tracks or folders"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label={`Sort ${scope} tracks`}
          value={sort}
          onChange={(e) => {
            const value = e.target.value;
            setSort(value);
            try {
              localStorage.setItem(`shokzlink_${scope}_sort`, value);
            } catch (error) {
              if (!(error instanceof DOMException)) throw error;
              console.warn("Unable to save sorting preference", {
                scope,
                error: error.name,
              });
            }
          }}
        >
          <option value="name">Name A–Z</option>
          <option value="newest">Newest first</option>
          <option value="size">Largest first</option>
        </select>
      </div>
      <div className="finder-toolbar">
        <div
          className="breadcrumbs"
          role="navigation"
          aria-label={`${scope} folder breadcrumbs`}
        >
          {crumbs.map((crumb, idx) => (
            <span key={crumb.path} className="breadcrumb-segment">
              {idx > 0 && <ChevronRight size={13} className="breadcrumb-sep" />}
              <button
                type="button"
                className={`breadcrumb-btn ${currentFolder === crumb.path ? "active" : ""} ${dragOverTarget === `crumb-${crumb.path}` ? "drag-over" : ""}`}
                onClick={() => setCurrentFolder(crumb.path)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverTarget(`crumb-${crumb.path}`);
                }}
                onDragLeave={() => setDragOverTarget(null)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragOverTarget(null);
                  await handleDrop(e, crumb.path);
                }}
              >
                {idx === 0 ? <Folder size={13} /> : null}
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
        <div className="finder-actions">
          <button
            type="button"
            className="btn-compact"
            aria-label={`Create subfolder in ${scope}`}
            title="Create new folder"
            disabled={!ready || busy}
            onClick={() => setIsCreatingFolder(true)}
          >
            <FolderPlus size={14} /> New folder
          </button>
        </div>
      </div>
      <div className="selection-bar">
        <label className="check">
          <input
            type="checkbox"
            disabled={!ready || !visible.length || busy}
            checked={all}
            onChange={() =>
              setSelected(
                all
                  ? selected.filter((p) => !visible.some((t) => t.path === p))
                  : [...new Set([...selected, ...visible.map((t) => t.path)])],
              )
            }
          />
          <span>
            {selected.length ? `${selected.length} selected` : "Select all"}
          </span>
        </label>
        <span>{status ? `${visible.length} shown` : "Waiting for server"}</span>
      </div>
      <div
        className={`track-list ${dragOverTarget === "list" ? "drag-over" : ""}`}
        onDragOver={(e) => {
          if (ready && !busy) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOverTarget("list");
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setDragOverTarget(null);
          }
        }}
        onDrop={async (e) => {
          setDragOverTarget(null);
          if (
            e.currentTarget === e.target ||
            (e.target as HTMLElement).classList.contains("track-list")
          ) {
            e.preventDefault();
            await handleDrop(e, currentFolder);
          }
        }}
      >
        {isCreatingFolder && (
          <form
            className="new-folder-inline"
            onSubmit={async (e) => {
              e.preventDefault();
              await createSubfolder(newFolderName);
            }}
          >
            <div className="track-art folder-art">
              <FolderPlus size={16} />
            </div>
            <input
              type="text"
              autoFocus
              placeholder="Folder name"
              aria-label="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              disabled={busy}
            />
            <button
              type="submit"
              className="primary btn-compact"
              disabled={busy || !newFolderName.trim()}
            >
              Create
            </button>
            <button
              type="button"
              className="btn-compact"
              disabled={busy}
              onClick={() => {
                setIsCreatingFolder(false);
                setNewFolderName("");
              }}
            >
              Cancel
            </button>
          </form>
        )}
        {currentFolder && !query.trim() && (
          <div
            className={`track folder-up-row ${dragOverTarget === "up" ? "drag-over" : ""}`}
            onClick={() => {
              const idx = currentFolder.lastIndexOf("/");
              setCurrentFolder(idx >= 0 ? currentFolder.slice(0, idx) : "");
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverTarget("up");
            }}
            onDragLeave={() => setDragOverTarget(null)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragOverTarget(null);
              const idx = currentFolder.lastIndexOf("/");
              const parent = idx >= 0 ? currentFolder.slice(0, idx) : "";
              await handleDrop(e, parent);
            }}
          >
            <div className="track-art folder-art">
              <CornerLeftUp size={16} />
            </div>
            <div className="track-info">
              <strong>.. Up to parent folder</strong>
              <span>Drop tracks here to move out of current folder</span>
            </div>
          </div>
        )}
        {!query.trim() &&
          directSubfolders.map((sub) => (
            <div
              className={`track folder-row ${dragOverTarget === `folder-${sub.fullPath}` ? "drag-over" : ""}`}
              key={`folder-${sub.fullPath}`}
              onClick={() => setCurrentFolder(sub.fullPath)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverTarget(`folder-${sub.fullPath}`);
              }}
              onDragLeave={() => setDragOverTarget(null)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragOverTarget(null);
                await handleDrop(e, sub.fullPath);
              }}
            >
              <div className="track-art folder-art">
                <Folder size={16} />
              </div>
              <div className="track-info">
                <strong title={sub.name}>{sub.name}</strong>
                <span>
                  Folder · {sub.count} track{sub.count === 1 ? "" : "s"}
                </span>
              </div>
              <ChevronRight size={16} className="folder-arrow" />
              {sub.count === 0 && (
                <button
                  type="button"
                  className="track-action-btn track-delete-btn"
                  aria-label={`Delete folder ${sub.name}`}
                  title={`Delete folder ${sub.name}`}
                  disabled={!ready || busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteEmptyFolder(sub.fullPath);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}
        {visible.map((t) => (
          <div
            className={`track ${dragOverTarget === t.path ? "drag-over" : ""}`}
            key={t.path}
            draggable={ready && !busy}
            onDragStart={(e) => {
              const paths = selected.includes(t.path) ? selected : [t.path];
              e.dataTransfer.setData(
                "application/json",
                JSON.stringify({ scope, paths }),
              );
              e.dataTransfer.effectAllowed = "copyMove";
            }}
          >
            <label className="check track-check">
              <input
                type="checkbox"
                aria-label={`Select ${t.path}`}
                disabled={!ready || busy}
                checked={selected.includes(t.path)}
                onChange={() =>
                  setSelected((s) =>
                    s.includes(t.path)
                      ? s.filter((p) => p !== t.path)
                      : [...s, t.path],
                  )
                }
              />
            </label>
            <button
              type="button"
              className={`track-art ${playing?.track.path === t.path && playing.scope === scope ? "playing" : ""}`}
              aria-label={`Play ${t.title}`}
              title={`Play ${t.title}`}
              disabled={!ready}
              onClick={() => onPlay(t, scope)}
            >
              <Play size={15} />
            </button>
            <div
              className="track-info"
              onClick={() => ready && onPlay(t, scope)}
              style={{ cursor: ready ? "pointer" : "default" }}
            >
              <strong title={t.title}>{t.title}</strong>
              <span title={t.path}>
                MP3 ·{" "}
                {t.path.includes("/")
                  ? t.path.slice(0, t.path.lastIndexOf("/"))
                  : "Root folder"}
              </span>
            </div>
            <span className="track-size">{bytes(t.size)}</span>
            <button
              type="button"
              className="track-action-btn track-delete-btn"
              aria-label={`Delete ${t.title}`}
              title={`Delete ${t.title}`}
              disabled={!ready || busy}
              onClick={(e) => {
                e.stopPropagation();
                setSelected([t.path]);
                setEdit("delete");
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {!visible.length && !directSubfolders.length && !isCreatingFolder && (
          <div className="empty">
            <FolderOpen size={32} />
            <h4>
              {!status
                ? "Waiting for local server"
                : !ready
                  ? "Connect your headphones"
                  : query
                    ? "No matching tracks"
                    : "No music here yet"}
            </h4>
            <p>
              {!ready && scope === "device"
                ? "USB detection runs automatically. Your device appears here when connected."
                : query
                  ? "Try another title or folder name."
                  : "Import MP3 files or download music you have permission to use."}
            </p>
          </div>
        )}
      </div>
      <div className="panel-actions">
        <p className="selection-hint" aria-live="polite">
          {selected.length
            ? `${selected.length} track${selected.length === 1 ? "" : "s"} selected. Choose an action below.`
            : "Select tracks to rename, move, or delete."}
        </p>
        <div className="row">
          <button
            disabled={!ready || busy || selected.length !== 1}
            onClick={() => open("rename")}
          >
            Rename
          </button>
          <button
            disabled={!ready || busy || !selected.length}
            onClick={() => open("move")}
          >
            Move
          </button>
          <button
            className="danger-text"
            disabled={!ready || busy || !selected.length}
            onClick={() => open("delete")}
          >
            Delete
          </button>
        </div>
        {scope === "library" && (
          <div className="transfer">
            <label>
              Device folder
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={!status?.device.connected}
              >
                <option value="">Root folder</option>
                {status?.device.folders.filter(Boolean).map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              disabled={busy || !status?.device.connected || !selected.length}
              onClick={() => open("transfer")}
            >
              Transfer <ArrowRight size={17} />
            </button>
          </div>
        )}
      </div>
      <dialog
        ref={dialog}
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) setEdit(null);
        }}
        aria-labelledby={`${scope}-dialog-title`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2 id={`${scope}-dialog-title`}>
            {edit === "delete"
              ? `Delete ${chosen.length} track${chosen.length === 1 ? "" : "s"}?`
              : edit === "transfer"
                ? "Transfer to SWIM PRO"
                : edit === "rename"
                  ? "Rename track"
                  : "Move selected tracks"}
          </h2>
          <p>
            {edit === "delete"
              ? `Remove the following files from ${scope === "device" ? "your connected device" : "your local library"}. This action changes your files.`
              : edit === "transfer"
                ? "Copy the selected files to the connected device. Your local files stay in place."
                : "Changes apply to the selected files only."}
          </p>
          <ul className="file-confirm">
            {chosen.map((t) => (
              <li key={t.path}>{t.path}</li>
            ))}
          </ul>
          {edit !== "delete" && (
            <label>
              {edit === "rename"
                ? "MP3 filename"
                : "Destination folder (blank for root)"}
              <input
                autoFocus
                value={value}
                required={edit === "rename"}
                placeholder={edit === "rename" ? "Track.mp3" : "Music/Training"}
                list={edit === "rename" ? undefined : `${scope}-folders`}
                onChange={(e) => setValue(e.target.value)}
              />
              <datalist id={`${scope}-folders`}>
                {(edit === "transfer"
                  ? (status?.device.folders ?? [])
                  : folders
                ).map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </label>
          )}
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button
              className={edit === "delete" ? "danger" : "primary"}
              disabled={
                busy ||
                !ready ||
                !selected.length ||
                (edit === "transfer" && !status?.device.connected)
              }
            >
              {busy
                ? "Working…"
                : edit === "delete"
                  ? "Delete tracks"
                  : edit === "transfer"
                    ? "Confirm transfer"
                    : "Save changes"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

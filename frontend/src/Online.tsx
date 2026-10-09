import { useEffect, useRef, useState } from "react";
import { ExternalLink, Search, Play, Music2 } from "lucide-react";
import {
  api,
  validYouTubeUrl,
  type Status,
  type Video,
  type Playlist,
} from "./api";
import type { Run } from "./Library";
export function DownloadForm({
  run,
  busy,
  status,
  initial,
}: {
  run: Run;
  busy: boolean;
  status: Status | null;
  initial?: Pick<Video, "url" | "title">;
}) {
  const [url, setUrl] = useState(initial?.url ?? ""),
    [title, setTitle] = useState(initial?.title ?? "");
  useEffect(() => {
    setUrl(initial?.url ?? "");
    setTitle(initial?.title ?? "");
  }, [initial]);
  const available =
    !!status?.dependencies.ffmpeg && !!status?.dependencies.yt_dlp;
  return (
    <form
      className="panel download-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!validYouTubeUrl(url)) return;
        const ok = await run(
          () =>
            api("/downloads", {
              url,
              permitted: true,
              ...(title ? { title } : {}),
            }),
          "Added to the download queue.",
        );
        if (ok) {
          setUrl("");
          setTitle("");
        }
      }}
    >
      <h3>Save to your local library</h3>
      <p>
        Paste a YouTube video or playlist URL. Completed downloads become MP3s
        in your library, not on your device.
      </p>
      <label>
        YouTube URL
        <input
          type="url"
          required
          value={url}
          placeholder="https://www.youtube.com/watch?v=…"
          onChange={(e) => {
            setUrl(e.target.value);
            setTitle("");
          }}
        />
      </label>
      {url && !validYouTubeUrl(url) && (
        <p className="field-error">
          Use an HTTPS YouTube watch, playlist, or youtu.be link.
        </p>
      )}
      {title && (
        <p className="footnote">
          Song title: <strong>{title}</strong>. The MP3 will keep this name.
        </p>
      )}
      {status && !available && (
        <p className="field-error">
          Downloads require yt-dlp and ffmpeg. See Settings for dependency
          status.
        </p>
      )}
      <button
        className="primary"
        disabled={busy || !validYouTubeUrl(url) || !available}
      >
        Add to queue
      </button>
    </form>
  );
}
export function Online({
  music,
  status,
  run,
  busy,
  openSettings,
}: {
  music: boolean;
  status: Status | null;
  run: Run;
  busy: boolean;
  openSettings: () => void;
}) {
  const [query, setQuery] = useState(""),
    [videos, setVideos] = useState<Video[]>([]),
    [playlists, setPlaylists] = useState<Playlist[]>([]),
    [active, setActive] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [searched, setSearched] = useState(false),
    [play, setPlay] = useState<Video | null>(null),
    [download, setDownload] = useState<Pick<Video, "url" | "title">>();
  const request = useRef(0);
  useEffect(() => {
    if (!music || !status?.auth.authenticated) return;
    const abort = new AbortController();
    setLoading(true);
    api<{ playlists: Playlist[] }>("/music/playlists", undefined, abort.signal)
      .then((r) => setPlaylists(r.playlists))
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [music, status?.auth.authenticated]);
  async function load(path: string, title: string) {
    const id = ++request.current;
    setLoading(true);
    setError("");
    setActive(title);
    setSearched(true);
    setVideos([]);
    try {
      const r = await api<{ videos: Video[] }>(path);
      if (id === request.current) setVideos(r.videos);
    } catch (e) {
      if (id === request.current)
        setError(e instanceof Error ? e.message : "Unable to load music.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>{music ? "YouTube Music" : "Discover music"}</h1>
          <p>
            {music
              ? "Personal playlists and liked songs, connected through Google."
              : "Search public videos. Listen here, or open the full experience."}
          </p>
        </div>
        <a
          className="button"
          href={music ? "https://music.youtube.com" : "https://www.youtube.com"}
          target="_blank"
          rel="noreferrer"
        >
          Open {music ? "YouTube Music" : "YouTube"} <ExternalLink size={16} />
        </a>
      </div>
      {music && !status?.auth.authenticated ? (
        <div className="panel connect-panel">
          <Music2 size={36} />
          <h3>Connect your music account</h3>
          <p>
            Sign in on Google’s website with a device code. ShokzLink never asks
            for your Google password. Set up your own OAuth TV client in
            Settings first.
          </p>
          <button className="primary" onClick={openSettings}>
            Open account settings
          </button>
        </div>
      ) : (
        <>
          {music ? (
            <div className="playlist-grid">
              {playlists.map((p) => (
                <button
                  className={
                    "playlist panel " + (active === p.title ? "active" : "")
                  }
                  key={p.id}
                  onClick={() =>
                    void load(
                      "/music/playlists/" + encodeURIComponent(p.id),
                      p.title,
                    )
                  }
                >
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <Music2 size={26} />
                  )}
                  <strong>{p.title}</strong>
                  <span>{p.count ? `${p.count} tracks` : "View playlist"}</span>
                </button>
              ))}
              {!loading && !playlists.length && (
                <p>No playlists returned by your account.</p>
              )}
            </div>
          ) : (
            <form
              className="search-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (query.trim())
                  void load(
                    "/youtube/search?q=" + encodeURIComponent(query.trim()),
                    "Search results",
                  );
              }}
            >
              <label className="sr-only" htmlFor="youtube-query">
                Search YouTube
              </label>
              <input
                id="youtube-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search songs, artists, or videos"
                required
              />
              <button className="primary" disabled={loading || !query.trim()}>
                <Search size={18} /> Search
              </button>
            </form>
          )}
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {loading && <p role="status">Loading music…</p>}
          {active && <h3>{active}</h3>}
          {!loading && searched && !videos.length && !error && (
            <p>No videos found.</p>
          )}
          <div className="video-grid">
            {videos.map((v, i) => (
              <article className="video-card panel" key={`${v.id}-${i}`}>
                <div className="thumbnail">
                  {v.thumbnail ? (
                    <img src={v.thumbnail} alt="" loading="lazy" />
                  ) : (
                    <Music2 size={30} />
                  )}
                  <span>{v.duration}</span>
                </div>
                <div className="video-body">
                  <h4>{v.title}</h4>
                  <p>{v.artist || "YouTube video"}</p>
                  <div className="row">
                    <button
                      disabled={!/^[\w-]{11}$/.test(v.id)}
                      onClick={() => setPlay(v)}
                    >
                      <Play size={15} /> Play
                    </button>
                    <button
                      onClick={() => {
                        setDownload({
                          url:
                            "https://www.youtube.com/watch?v=" +
                            encodeURIComponent(v.id),
                          title: v.title,
                        });
                        document
                          .getElementById("online-download")
                          ?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      Download
                    </button>
                  </div>
                  <div className="external-links">
                    <a
                      href={
                        "https://www.youtube.com/watch?v=" +
                        encodeURIComponent(v.id)
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      YouTube <ExternalLink size={13} />
                    </a>
                    <a
                      href={
                        "https://music.youtube.com/watch?v=" +
                        encodeURIComponent(v.id)
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      YouTube Music <ExternalLink size={13} />
                    </a>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {!music && !searched && (
            <div className="empty browse-empty">
              <Search size={32} />
              <h3>Start with a song or an artist.</h3>
              <p>
                Public search needs no sign-in. Personal playlists live in
                YouTube Music.
              </p>
            </div>
          )}
        </>
      )}
      {play && (
        <section className="panel player">
          <div className="row spread">
            <h3>{play.title}</h3>
            <button onClick={() => setPlay(null)}>Close player</button>
          </div>
          <iframe
            title={`YouTube player: ${play.title}`}
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(play.id)}`}
            allow="encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
          <p>
            Playback is provided by YouTube. Some videos cannot be embedded; use
            the external links above. This is not a signed-in YouTube website.
          </p>
        </section>
      )}
      <div id="online-download">
        <DownloadForm
          initial={download}
          status={status}
          run={run}
          busy={busy}
        />
      </div>
    </>
  );
}
export function Downloads({
  status,
  run,
  busy,
}: {
  status: Status | null;
  run: Run;
  busy: boolean;
}) {
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Downloads</h1>
          <p>
            From a permitted link to a local MP3. You choose when to transfer.
          </p>
        </div>
      </div>
      <DownloadForm status={status} run={run} busy={busy} />
      <section className="panel queue">
        <div className="panel-top">
          <h3>Activity</h3>
          <span className="badge">
            {status ? `${status.jobs.length} JOBS` : "UNKNOWN"}
          </span>
        </div>
        {status?.jobs.map((j) => (
          <article className="job" key={j.id}>
            <div className="row spread">
              <strong>{j.status}</strong>
              {["queued", "downloading"].includes(j.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        api(
                          "/downloads/" + encodeURIComponent(j.id) + "/cancel",
                          {},
                        ),
                      "Cancellation requested.",
                    )
                  }
                >
                  Cancel download
                </button>
              )}
            </div>
            <p className="job-url">{j.url}</p>
            <progress
              max="100"
              value={Math.min(100, Math.max(0, j.progress))}
              aria-label={`Download progress for ${j.url}`}
            />
            <div className="row spread">
              <span>{j.message}</span>
              <span>{Math.round(j.progress)}%</span>
            </div>
          </article>
        ))}
        {!status?.jobs.length && (
          <div className="empty">
            <h4>{status ? "No downloads yet" : "Waiting for local server"}</h4>
            <p>
              Paste a video or playlist link above to add your first download.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

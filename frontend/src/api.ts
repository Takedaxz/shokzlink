export interface Track {
  path: string;
  name: string;
  title: string;
  size: number;
  modified: number;
}
export interface Device {
  connected: boolean;
  name: string | null;
  mount: string | null;
  total: number;
  free: number;
  tracks: Track[];
  folders: string[];
}
export interface Job {
  id: string;
  url: string;
  status: "queued" | "downloading" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  created: number;
}
export interface Video {
  id: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  duration: string | null;
  url: string;
}
export interface Playlist {
  id: string;
  title: string;
  count: string | null;
  thumbnail: string | null;
}
export interface Status {
  device: Device;
  library: Track[];
  folders: string[];
  jobs: Job[];
  dependencies: { ffmpeg: boolean; yt_dlp: boolean };
  auth: { configured: boolean; authenticated: boolean };
  libraryPath: string;
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body instanceof FormData
        ? undefined
        : body === undefined
          ? undefined
          : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof data?.detail === "string"
        ? data.detail
        : `Request failed (${response.status}). Check the local server.`,
    );
  if (data === null)
    throw new Error("The local server returned an invalid response.");
  return data as T;
}
export function bytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}
export function validYouTubeUrl(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
      ].includes(u.hostname) &&
      ((u.hostname === "youtu.be" && u.pathname.length > 1) ||
        (u.pathname === "/watch" && !!u.searchParams.get("v")) ||
        (u.pathname === "/playlist" && !!u.searchParams.get("list")))
    );
  } catch {
    return false;
  }
}
export function filterTracks(tracks: Track[], query: string, sort: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/);
  return tracks
    .filter((t) =>
      terms.every((q) =>
        (t.title + " " + t.path).toLocaleLowerCase().includes(q),
      ),
    )
    .sort((a, b) =>
      sort === "size"
        ? b.size - a.size
        : sort === "newest"
          ? b.modified - a.modified
          : a.title.localeCompare(b.title, undefined, { numeric: true }),
    );
}

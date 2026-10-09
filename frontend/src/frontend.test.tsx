// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { bytes, filterTracks, validYouTubeUrl, type Status } from "./api";
import { DownloadForm, Online } from "./Online";
import { Library } from "./Library";
import App from "./App";
import { Settings } from "./Settings";
import { act } from "@testing-library/react";
const status: Status = {
  device: {
    connected: false,
    name: null,
    mount: null,
    total: 0,
    free: 0,
    tracks: [],
    folders: [],
  },
  library: [
    {
      path: "Training/Example.mp3",
      name: "Example.mp3",
      title: "Example",
      size: 2048,
      modified: 1,
    },
  ],
  folders: ["Training"],
  jobs: [],
  dependencies: { ffmpeg: true, yt_dlp: true },
  auth: { configured: false, authenticated: false },
  libraryPath: "/test/library",
};
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("waits five seconds before polling device sign-in and respects slow-down", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("/auth/start")
          ? {
              id: "auth-test",
              verificationUrl: "https://www.google.com/device",
              userCode: "TEST-CODE",
              expiresIn: 60,
            }
          : { status: "pending", message: "slow_down" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const run = async (task: () => Promise<unknown>) => {
      await task();
      return true;
    };
    render(
      <Settings
        status={{ ...status, auth: { configured: true, authenticated: false } }}
        busy={false}
        run={run}
        refresh={async () => {}}
      />,
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Sign in with Google device code" }),
      ),
    );
    expect(screen.getByText("TEST-CODE")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9999);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

describe("library helpers", () => {
  it("formats storage without fake values", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1024 ** 3)).toBe("1.0 GB");
  });
  it("filters by all search terms and does not mutate source tracks", () => {
    const tracks = [
      ...status.library,
      {
        path: "Other.mp3",
        name: "Other.mp3",
        title: "Other",
        size: 4096,
        modified: 3,
      },
    ];
    expect(filterTracks(tracks, "training example", "size")).toHaveLength(1);
    expect(filterTracks(tracks, "", "size")[0].title).toBe("Other");
    expect(tracks[0].title).toBe("Example");
  });
  it.each([
    "http://youtube.com/watch?v=abc",
    "https://youtube.com.evil.test/watch?v=abc",
    "https://evil.test/watch?v=abc",
    "javascript:alert(1)",
    "https://youtube.com/",
  ])("rejects unsafe or unsupported URL %s", (url) =>
    expect(validYouTubeUrl(url)).toBe(false),
  );
  it.each([
    "https://youtu.be/abc",
    "https://www.youtube.com/watch?v=abc",
    "https://music.youtube.com/playlist?list=abc",
  ])("accepts supported URL %s", (url) =>
    expect(validYouTubeUrl(url)).toBe(true),
  );
});
it("queues download directly without requiring permission checkbox", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "test" }) });
  vi.stubGlobal("fetch", fetcher);
  const run = vi.fn(async (fn: () => Promise<unknown>) => {
    await fn();
    return true;
  });
  render(<DownloadForm status={status} busy={false} run={run} />);
  expect(screen.getByRole("button", { name: "Add to queue" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("YouTube URL"), {
    target: { value: "https://youtu.be/abc" },
  });
  expect(screen.getByRole("button", { name: "Add to queue" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    url: "https://youtu.be/abc",
    permitted: true,
  });
});
it("passes the selected card title through the download form", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const title = "STORY (feat. SURIYA MQT & YUNGTARR)";
  const fetcher = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes("/youtube/search")
        ? {
            videos: [
              {
                id: "6YS3ISse240",
                title,
                artist: "P6ICK",
                duration: "3:30",
                thumbnail: null,
                url: "https://www.youtube.com/watch?v=6YS3ISse240",
              },
            ],
          }
        : { id: "test" },
  }));
  vi.stubGlobal("fetch", fetcher);
  const run = async (task: () => Promise<unknown>): Promise<boolean> => {
    await task();
    return true;
  };
  render(
    <Online
      music={false}
      status={status}
      busy={false}
      run={run}
      openSettings={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Search YouTube"), {
    target: { value: "STORY" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("heading", { name: title });
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(screen.getByLabelText("YouTube URL")).toHaveValue(
    "https://www.youtube.com/watch?v=6YS3ISse240",
  );
  expect(screen.getByRole("button", { name: "Add to queue" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith("/api/downloads", expect.anything()),
  );
  const call = fetcher.mock.calls.find(([url]) => url === "/api/downloads")!;
  expect(JSON.parse(call[1].body)).toEqual({
    url: "https://www.youtube.com/watch?v=6YS3ISse240",
    permitted: true,
    title,
  });
});

it("clears a card title when the user changes the download URL", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "test" }) });
  vi.stubGlobal("fetch", fetcher);
  const run = async (task: () => Promise<unknown>): Promise<boolean> => {
    await task();
    return true;
  };
  render(
    <DownloadForm
      status={status}
      busy={false}
      run={run}
      initial={{ url: "https://youtu.be/6YS3ISse240", title: "Original title" }}
    />,
  );
  fireEvent.change(screen.getByLabelText("YouTube URL"), {
    target: { value: "https://youtu.be/abcdefghijk" },
  });
  expect(screen.queryByText("Original title")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    url: "https://youtu.be/abcdefghijk",
    permitted: true,
  });
});

it("remembers separate library and device sort choices after remounting", () => {
  const props = { status, busy: false, run: vi.fn() };
  const { unmount } = render(<Library {...props} />);
  fireEvent.change(screen.getByLabelText("Sort library tracks"), {
    target: { value: "size" },
  });
  fireEvent.change(screen.getByLabelText("Sort device tracks"), {
    target: { value: "newest" },
  });
  expect(localStorage.getItem("shokzlink_library_sort")).toBe("size");
  expect(localStorage.getItem("shokzlink_device_sort")).toBe("newest");
  unmount();
  render(<Library {...props} />);
  expect(screen.getByLabelText("Sort library tracks")).toHaveValue("size");
  expect(screen.getByLabelText("Sort device tracks")).toHaveValue("newest");
  fireEvent.change(screen.getByLabelText("Sort library tracks"), {
    target: { value: "name" },
  });
  expect(localStorage.getItem("shokzlink_library_sort")).toBe("name");
  expect(screen.getByLabelText("Sort device tracks")).toHaveValue("newest");
});
it("ignores invalid saved sort choices", () => {
  localStorage.setItem("shokzlink_library_sort", "invalid");
  render(<Library status={status} busy={false} run={vi.fn()} />);
  expect(screen.getByLabelText("Sort library tracks")).toHaveValue("name");
  expect(screen.getByLabelText("Sort device tracks")).toHaveValue("name");
});
it("keeps sorting usable when browser storage is blocked", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
  try {
    render(<Library status={status} busy={false} run={vi.fn()} />);
    expect(screen.getByLabelText("Sort library tracks")).toHaveValue("name");
    fireEvent.change(screen.getByLabelText("Sort library tracks"), {
      target: { value: "size" },
    });
    expect(screen.getByLabelText("Sort library tracks")).toHaveValue("size");
    expect(warning).toHaveBeenCalledWith("Unable to save sorting preference", {
      scope: "library",
      error: "QuotaExceededError",
    });
  } finally {
    read.mockRestore();
    write.mockRestore();
    warning.mockRestore();
  }
});
it.each(["library", "device"] as const)(
  "shows only direct tracks when browsing %s folders, while search finds nested songs",
  (scope) => {
    const tracks = [
      {
        path: "Lost Stars.mp3",
        name: "Lost Stars.mp3",
        title: "Lost Stars",
        size: 2048,
        modified: 1,
      },
      {
        path: "10-26/Greedy.mp3",
        name: "Greedy.mp3",
        title: "Greedy",
        size: 2048,
        modified: 1,
      },
      {
        path: "10-26/Live/Encore.mp3",
        name: "Encore.mp3",
        title: "Encore",
        size: 2048,
        modified: 1,
      },
      {
        path: "10-260/Other.mp3",
        name: "Other.mp3",
        title: "Other",
        size: 2048,
        modified: 1,
      },
    ];
    const folders = ["10-26", "10-26/Live", "10-260"];
    const fixture: Status = {
      ...status,
      library: scope === "library" ? tracks : [],
      folders: scope === "library" ? folders : [],
      device: {
        ...status.device,
        connected: true,
        name: "SWIM PRO",
        tracks: scope === "device" ? tracks : [],
        folders: scope === "device" ? folders : [],
      },
    };
    render(<Library status={fixture} busy={false} run={vi.fn()} />);
    const panel = within(
      screen.getByRole("region", {
        name: scope === "library" ? "Local library" : "Device library",
      }),
    );
    expect(panel.getByText("Lost Stars")).toBeInTheDocument();
    expect(panel.queryByText("Greedy")).not.toBeInTheDocument();
    expect(panel.queryByText("Encore")).not.toBeInTheDocument();
    expect(panel.queryByText("Other")).not.toBeInTheDocument();
    expect(panel.getByText("1 shown")).toBeInTheDocument();
    fireEvent.click(panel.getByText("10-26"));
    expect(panel.getByText("Greedy")).toBeInTheDocument();
    expect(panel.queryByText("Lost Stars")).not.toBeInTheDocument();
    expect(panel.queryByText("Encore")).not.toBeInTheDocument();
    expect(panel.queryByText("Other")).not.toBeInTheDocument();
    fireEvent.click(panel.getByText("Live"));
    expect(panel.getByText("Encore")).toBeInTheDocument();
    expect(panel.queryByText("Greedy")).not.toBeInTheDocument();
    fireEvent.click(panel.getByText(".. Up to parent folder"));
    expect(panel.getByText("Greedy")).toBeInTheDocument();
    fireEvent.click(panel.getByText(".. Up to parent folder"));
    expect(panel.queryByText("Greedy")).not.toBeInTheDocument();
    fireEvent.change(panel.getByLabelText(`Search ${scope} tracks`), {
      target: { value: "Greedy" },
    });
    expect(panel.getByText("Greedy")).toBeInTheDocument();
    fireEvent.change(panel.getByLabelText(`Search ${scope} tracks`), {
      target: { value: "" },
    });
    expect(panel.queryByText("Greedy")).not.toBeInTheDocument();
    expect(panel.getByText("Lost Stars")).toBeInTheDocument();
  },
);
it("disables transfer offline and confirms exact names before deletion", () => {
  const run = vi.fn();
  render(<Library status={status} busy={false} run={run} />);
  fireEvent.click(screen.getByText("Training"));
  fireEvent.click(screen.getByLabelText("Select Training/Example.mp3"));
  expect(screen.getByRole("button", { name: "Transfer" })).toBeDisabled();
  fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
  expect(screen.getByRole("dialog")).toHaveTextContent("Delete 1 track?");
  expect(screen.getByRole("dialog")).toHaveTextContent("Training/Example.mp3");
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("opens delete confirmation when row delete button is clicked", () => {
  const run = vi.fn();
  render(<Library status={status} busy={false} run={run} />);
  fireEvent.click(screen.getByText("Training"));
  fireEvent.click(screen.getByRole("button", { name: "Delete Example" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Delete 1 track?");
  expect(screen.getByRole("dialog")).toHaveTextContent("Training/Example.mp3");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("supports creating a subfolder, navigating folders, and drag-and-drop", async () => {
  const run = vi.fn().mockResolvedValue(true);
  render(
    <Library
      status={{
        ...status,
        library: [{ ...status.library[0], path: "Example.mp3" }],
      }}
      busy={false}
      run={run}
    />,
  );

  // 1. Open inline new folder form and submit
  fireEvent.click(screen.getByRole("button", { name: "Create subfolder in library" }));
  const input = screen.getByLabelText("Folder name");
  fireEvent.change(input, { target: { value: "Cardio" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(run).toHaveBeenCalled();

  // 2. Folder row appears and can be entered
  expect(screen.getByText("Training")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Training"));
  expect(screen.getByText(".. Up to parent folder")).toBeInTheDocument();

  // 3. Navigate back up to Root
  fireEvent.click(screen.getByText(".. Up to parent folder"));
  expect(screen.queryByText(".. Up to parent folder")).not.toBeInTheDocument();

  // 4. Drag track onto folder row
  const folderRow = screen.getByText("Training").closest(".folder-row")!;
  const trackEl = screen.getByText("Example").closest(".track")!;
  const dataTransfer = {
    setData: vi.fn(),
    getData: vi.fn().mockReturnValue(JSON.stringify({ scope: "library", paths: ["Example.mp3"] })),
    files: [],
  };
  fireEvent.dragStart(trackEl, { dataTransfer });
  fireEvent.dragOver(folderRow, { dataTransfer });
  fireEvent.drop(folderRow, { dataTransfer });
  expect(run).toHaveBeenCalled();
});
it("opens popup media player when play button is clicked and closes it", () => {
  const run = vi.fn();
  render(<Library status={status} busy={false} run={run} />);
  expect(screen.queryByRole("region", { name: "Media player" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Training"));
  fireEvent.click(screen.getByRole("button", { name: "Play Example" }));
  const player = screen.getByRole("region", { name: "Media player" });
  expect(player).toBeInTheDocument();
  expect(player).toHaveTextContent("Example");
  fireEvent.click(screen.getByRole("button", { name: "Close media player" }));
  expect(screen.queryByRole("region", { name: "Media player" })).not.toBeInTheDocument();
});
it("persists audio volume in localStorage across playback", () => {
  localStorage.setItem("shokzlink_volume", "0.65");
  const run = vi.fn();
  render(<Library status={status} busy={false} run={run} />);
  fireEvent.click(screen.getByText("Training"));
  fireEvent.click(screen.getByRole("button", { name: "Play Example" }));
  const audio = document.querySelector("audio") as HTMLAudioElement;
  expect(audio).toBeInTheDocument();
  expect(audio.volume).toBeCloseTo(0.65);

  Object.defineProperty(audio, "volume", { value: 0.3, writable: true });
  fireEvent(audio, new Event("volumechange"));
  expect(localStorage.getItem("shokzlink_volume")).toBe("0.3");
});
it("reports server failure honestly and keeps mutations disabled", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Server offline")),
  );
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Server offline");
  expect(screen.getByRole("button", { name: "Import MP3s" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByLabelText("OAuth client secret")).toHaveAttribute(
    "type",
    "password",
  );
  expect(
    screen.getByRole("button", { name: "Save OAuth client" }),
  ).toBeDisabled();
  expect(screen.getByText("Waiting for server")).toBeInTheDocument();
});

it("groups navigation and closes the mobile menu after changing pages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => status }),
  );
  render(<App />);
  await screen.findByText("Local server online");
  expect(
    screen.getByRole("heading", { level: 1, name: "Music library" }),
  ).toBeInTheDocument();
  for (const group of ["Collection", "Discover", "Manage"]) {
    expect(screen.getByText(group)).toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  expect(
    screen.getByRole("button", { name: "Close navigation" }),
  ).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("button", { name: /^YouTube$/ }));
  expect(
    screen.getByRole("heading", { level: 1, name: "Discover music" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(document.activeElement).toBe(document.getElementById("main"));
});

it("closes navigation with Escape and restores focus to its trigger", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => status }),
  );
  render(<App />);
  await screen.findByText("Local server online");
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.getByRole("button", { name: "Open navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open navigation" }),
  );
});

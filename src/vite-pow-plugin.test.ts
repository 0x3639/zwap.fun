// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.fn<(path: string) => boolean>();
const createReadStream = vi.fn<(path: string) => EventEmitter>();

vi.mock("node:fs", () => ({
  existsSync: (path: string) => existsSync(path),
  createReadStream: (path: string) => createReadStream(path),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn()
}));

const { copyPowFiles } = await import("../vite-pow-plugin.js");

interface FakeResponse {
  statusCode: number;
  headersSent: boolean;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function response(): FakeResponse {
  return {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn()
  };
}

/** Installs the plugin's dev middleware and hands back the handler. */
function middleware(): (
  req: { url?: string },
  res: FakeResponse,
  next: () => void
) => void {
  let handler!: (req: { url?: string }, res: FakeResponse, next: () => void) => void;
  const plugin = copyPowFiles();
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({
    middlewares: {
      use: (fn: typeof handler) => {
        handler = fn;
      }
    }
  });
  return handler;
}

/** A read stream that emits `error` after the pipe is wired up. */
function failingStream(): EventEmitter & { pipe: ReturnType<typeof vi.fn> } {
  const stream = Object.assign(new EventEmitter(), { pipe: vi.fn() });
  stream.pipe.mockImplementation(() => {
    queueMicrotask(() => stream.emit("error", new Error("EIO")));
  });
  return stream;
}

describe("pow asset dev middleware", () => {
  beforeEach(() => {
    existsSync.mockReset();
    createReadStream.mockReset();
  });

  it("serves an existing pow asset with its exact content type", () => {
    existsSync.mockReturnValue(true);
    const stream = Object.assign(new EventEmitter(), { pipe: vi.fn() });
    createReadStream.mockReturnValue(stream);
    const res = response();
    const next = vi.fn();

    middleware()({ url: "/pow.wasm?v=1" }, res, next);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/wasm");
    expect(stream.pipe).toHaveBeenCalledWith(res);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("answers 404 when the SDK does not ship the file", () => {
    // Previously this piped a stream for a missing path: the response headers
    // said 200 and the body simply never arrived.
    existsSync.mockReturnValue(false);
    const res = response();
    const next = vi.fn();

    middleware()({ url: "/pow.js" }, res, next);

    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining("pow.js"));
    expect(createReadStream).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 500 when the read stream fails before any bytes are sent", async () => {
    existsSync.mockReturnValue(true);
    createReadStream.mockReturnValue(failingStream());
    const res = response();

    middleware()({ url: "/pow.wasm" }, res, vi.fn());
    await Promise.resolve();

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalled();
  });

  it("leaves the status alone when the stream fails mid-response", async () => {
    existsSync.mockReturnValue(true);
    createReadStream.mockReturnValue(failingStream());
    const res = response();
    res.headersSent = true;

    middleware()({ url: "/pow.wasm" }, res, vi.fn());
    await Promise.resolve();

    expect(res.statusCode).toBe(200);
    expect(res.end).toHaveBeenCalled();
  });

  it("passes every other request through", () => {
    const res = response();
    const next = vi.fn();

    middleware()({ url: "/index.html" }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(existsSync).not.toHaveBeenCalled();
  });
});

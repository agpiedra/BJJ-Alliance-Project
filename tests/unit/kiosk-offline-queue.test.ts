import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueOfflineCheckIn, flushOfflineQueue } from "@/lib/kiosk/offline-queue";

/**
 * `vitest.config.ts` runs this suite under `environment: "node"`, which has
 * no IndexedDB. offline-queue.ts is a thin, browser-only module (see its own
 * doc comment) that's hard to exercise with a real browser DB here — so this
 * is a small hand-rolled in-memory fake covering exactly the IndexedDB
 * surface the module actually uses (open/onupgradeneeded, a single object
 * store, add/delete/getAll, transaction completion). It is NOT a general
 * IndexedDB polyfill.
 */
function installFakeIndexedDb() {
  interface FakeStore {
    keyPath: string;
    autoIncrement: boolean;
    nextKey: number;
    data: Map<number, Record<string, unknown>>;
  }
  interface FakeDatabase {
    stores: Map<string, FakeStore>;
  }

  const databases = new Map<string, FakeDatabase>();

  function schedule(fn: () => void) {
    queueMicrotask(fn);
  }

  const fakeIndexedDb = {
    open(name: string) {
      const request: {
        result: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = { result: undefined, onupgradeneeded: null, onsuccess: null, onerror: null };

      schedule(() => {
        let record = databases.get(name);
        const isNew = !record;
        if (!record) {
          record = { stores: new Map() };
          databases.set(name, record);
        }

        const db = {
          objectStoreNames: {
            contains: (storeName: string) => record.stores.has(storeName),
          },
          createObjectStore(storeName: string, opts: { keyPath: string; autoIncrement?: boolean }) {
            record.stores.set(storeName, {
              keyPath: opts.keyPath,
              autoIncrement: !!opts.autoIncrement,
              nextKey: 1,
              data: new Map(),
            });
          },
          transaction(storeName: string) {
            const store = record.stores.get(storeName)!;
            const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null } = {
              oncomplete: null,
              onerror: null,
            };

            function withCompletion(op: () => void) {
              schedule(() => {
                op();
                schedule(() => tx.oncomplete?.());
              });
            }

            const store_ = {
              add(value: Record<string, unknown>) {
                const req: { result: unknown; onsuccess: (() => void) | null } = {
                  result: undefined,
                  onsuccess: null,
                };
                withCompletion(() => {
                  const key = store.autoIncrement ? store.nextKey++ : (value[store.keyPath] as number);
                  store.data.set(key, { ...value, [store.keyPath]: key });
                  req.result = key;
                  req.onsuccess?.();
                });
                return req;
              },
              delete(key: number) {
                const req: { onsuccess: (() => void) | null } = { onsuccess: null };
                withCompletion(() => {
                  store.data.delete(key);
                  req.onsuccess?.();
                });
                return req;
              },
              getAll() {
                const req: { result: unknown; onsuccess: (() => void) | null } = {
                  result: undefined,
                  onsuccess: null,
                };
                schedule(() => {
                  req.result = Array.from(store.data.values()).sort(
                    (a, b) => (a[store.keyPath] as number) - (b[store.keyPath] as number),
                  );
                  req.onsuccess?.();
                });
                return req;
              },
            };

            return {
              objectStore: () => store_,
              get oncomplete() {
                return tx.oncomplete;
              },
              set oncomplete(fn) {
                tx.oncomplete = fn;
              },
              get onerror() {
                return tx.onerror;
              },
              set onerror(fn) {
                tx.onerror = fn;
              },
            };
          },
          close() {},
        };

        request.result = db;
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });

      return request;
    },
  };

  vi.stubGlobal("indexedDB", fakeIndexedDb);
}

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body } as Response;
}

describe("offline-queue", () => {
  beforeEach(() => {
    installFakeIndexedDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("replays a queued entry and removes it on 200 success", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await flushOfflineQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ academySlug: "demo", token: "tok", code: "1234" });

    // A second flush finds nothing left to replay.
    await flushOfflineQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the entry's original queuedAt so the server records the real attendance instant", async () => {
    const before = Date.now();
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });
    const after = Date.now();

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await flushOfflineQueue();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(typeof body.queuedAt).toBe("number");
    // It's the enqueue instant, not the replay instant.
    expect(body.queuedAt).toBeGreaterThanOrEqual(before);
    expect(body.queuedAt).toBeLessThanOrEqual(after);
  });

  it("replays entries strictly in FIFO order, one at a time", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1111" });
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "2222" });

    const seenCodes: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      seenCodes.push(JSON.parse(init.body).code);
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await flushOfflineQueue();

    expect(seenCodes).toEqual(["1111", "2222"]);
  });

  it("treats already_checked_in (400) as definitive and drops the entry", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { ok: false, error: "already_checked_in" })),
    );

    await flushOfflineQueue();

    const fetchMock2 = vi.fn();
    vi.stubGlobal("fetch", fetchMock2);
    await flushOfflineQueue();
    expect(fetchMock2).not.toHaveBeenCalled(); // queue was already empty
  });

  it("treats no_active_class (400) during replay as definitive and drops the entry", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { ok: false, error: "no_active_class" })),
    );

    await flushOfflineQueue();

    const fetchMock2 = vi.fn();
    vi.stubGlobal("fetch", fetchMock2);
    await flushOfflineQueue();
    expect(fetchMock2).not.toHaveBeenCalled();
  });

  it("leaves the entry queued and stops flushing on a 429 (transient) response", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1111" });
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "2222" });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { ok: false, error: "rate_limited", retryAfterSeconds: 5 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await flushOfflineQueue();

    // Only the first entry was attempted; the second was never reached
    // because the flush stops on the first non-definitive outcome.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Both entries are still queued: a later successful flush replays both,
    // in original order, starting from the one that was rate-limited.
    const seenCodes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url, init) => {
        seenCodes.push(JSON.parse(init.body).code);
        return jsonResponse(200, { ok: true });
      }),
    );
    await flushOfflineQueue();
    expect(seenCodes).toEqual(["1111", "2222"]);
  });

  it("leaves the entry queued and stops flushing on a thrown network-level failure", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    await flushOfflineQueue();

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await flushOfflineQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the entry survived and was retried
  });

  it("signals failure (returns false) instead of silently no-opping when IndexedDB is unavailable", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("indexedDB", undefined);

    const persisted = await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });

    expect(persisted).toBe(false);
  });

  it("returns true when an entry is genuinely persisted", async () => {
    const persisted = await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });

    expect(persisted).toBe(true);
  });

  it("rejects (rather than silently swallowing) a genuine IndexedDB write failure", async () => {
    // A minimal, purpose-built stub simulating a QuotaExceededError-shaped
    // failure: opening the DB succeeds, but the write transaction's
    // onerror fires instead of oncomplete. Independent of the shared fake
    // above, which has no concept of a failing write.
    const dbStub = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => {},
      transaction: () => {
        const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; error: Error } = {
          oncomplete: null,
          onerror: null,
          error: new Error("QuotaExceededError"),
        };
        queueMicrotask(() => tx.onerror?.());
        return {
          error: tx.error,
          objectStore: () => ({ add: () => {} }),
          get oncomplete() {
            return tx.oncomplete;
          },
          set oncomplete(fn) {
            tx.oncomplete = fn;
          },
          get onerror() {
            return tx.onerror;
          },
          set onerror(fn) {
            tx.onerror = fn;
          },
        };
      },
      close: () => {},
    };
    const failingIndexedDb = {
      open: () => {
        const request: {
          result: unknown;
          onupgradeneeded: (() => void) | null;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        } = { result: dbStub, onupgradeneeded: null, onsuccess: null, onerror: null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    };
    vi.stubGlobal("indexedDB", failingIndexedDb);

    await expect(
      enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" }),
    ).rejects.toBeDefined();
  });

  it("logs a console.warn when a replay drops an entry as invalid_token (e.g. a rotated kiosk token)", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { ok: false, error: "invalid_token" })));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await flushOfflineQueue();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("invalid_token");
  });

  it("logs a console.warn when a replay drops an entry as no_active_class", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { ok: false, error: "no_active_class" })),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await flushOfflineQueue();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ reason: "no_active_class" });
  });

  it("logs a console.warn when a replay drops an entry as invalid_request", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { ok: false, error: "invalid_request" })),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await flushOfflineQueue();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("invalid_request");
  });

  it("does NOT log for the expected/non-actionable outcomes (success, already_checked_in)", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1234" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await flushOfflineQueue();
    expect(warnSpy).not.toHaveBeenCalled();

    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "5678" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { ok: false, error: "already_checked_in" })),
    );

    await flushOfflineQueue();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reports a drop count for permanently-lost entries so the UI can tell a human", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1111" });
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "2222" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(400, { ok: false, error: "no_active_class" }))
        .mockResolvedValueOnce(jsonResponse(401, { ok: false, error: "invalid_token" })),
    );

    expect(await flushOfflineQueue()).toEqual({ dropped: 2 });
  });

  it("does NOT count a success, already_checked_in or invalid_code as a drop", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1111" });
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "2222" });
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "3333" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
        .mockResolvedValueOnce(jsonResponse(400, { ok: false, error: "already_checked_in" }))
        .mockResolvedValueOnce(jsonResponse(400, { ok: false, error: "invalid_code" })),
    );

    expect(await flushOfflineQueue()).toEqual({ dropped: 0 });
  });

  it("does not replay entries in parallel (each awaited before the next starts)", async () => {
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "1111" });
    await enqueueOfflineCheckIn({ academySlug: "demo", token: "tok", code: "2222" });

    let inFlight = 0;
    let maxConcurrent = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      inFlight--;
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await flushOfflineQueue();

    expect(maxConcurrent).toBe(1);
  });
});

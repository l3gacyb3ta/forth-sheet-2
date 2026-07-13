/*
 * AutomergeKISS — Keep It Simple Sync 💾✨
 * ------------------------------------------------------------
 * A tiny, opinionated wrapper around Automerge that lets you sync
 * data between people with almost no setup.
 *
 * The whole idea: you get a "Space". A Space is a shared blob of data
 * (just a normal object). When you change it, everyone else who is in
 * the same Space sees the change. When they change it, you see it.
 * It even works offline and catches up later. That's it.
 *
 * You never have to think about CRDTs, repos, adapters, doc handles,
 * or websockets. Those are wired up for you with sensible defaults.
 *
 * Quick start:
 *
 *   import { openSpace } from "./automerge-kiss.js";
 *
 *   const space = await openSpace({ starter: { count: 0 } });
 *
 *   space.onChange((data) => console.log("now:", data));
 *   space.update((data) => { data.count += 1; });
 *
 *   console.log("Share this link:", space.shareUrl);
 *
 * Open `space.shareUrl` on another device or browser and you are
 * collaborating live.
 */

import {
  Repo,
  WebSocketClientAdapter,
  IndexedDBStorageAdapter,
  BroadcastChannelNetworkAdapter,
  isValidAutomergeUrl,
  type DocHandle,
  type AutomergeUrl,
} from "@automerge/vanillajs";

// ---------------------------------------------------------------------------
// Opinions (the defaults that make this "just work")
// ---------------------------------------------------------------------------

/**
 * The default public sync server run by the Automerge project.
 * Great for learning, demos, and hackathon projects. It is NOT private and
 * has no uptime or data guarantees — don't ship anything serious to it.
 * Pass your own `server` URL to {@link openSpace} when you outgrow it.
 */
export const DEFAULT_SYNC_SERVER = "wss://sync.automerge.org";

/** Any plain object works as Space data. */
export type SpaceData = Record<string, unknown>;

/** Options for {@link openSpace}. Every field is optional. */
export interface SpaceOptions<T extends SpaceData> {
  /**
   * The starting data, used ONLY when a brand-new Space is created.
   * If you join an existing Space (via a code or a link), the real data
   * comes from everyone else and this is ignored.
   * @default {}
   */
  starter?: T;

  /**
   * Join a specific Space by its share code (looks like "automerge:abc...").
   * If you leave this out, AutomergeKISS looks at the page URL (the part
   * after `#`). If that's empty too, a new Space is created for you.
   */
  code?: string;

  /**
   * The sync server to connect to.
   * @default {@link DEFAULT_SYNC_SERVER}
   */
  server?: string;

  /**
   * Stay on this device only — sync between tabs/windows here, but don't
   * talk to any server. Handy for offline experiments. Other people won't
   * see your data.
   * @default false
   */
  localOnly?: boolean;

  /**
   * Keep the Space code in the page URL (after the `#`) so the link is
   * shareable and reloads rejoin the same Space. Turn this off if you want
   * to manage the code yourself.
   * @default true
   */
  useUrlHash?: boolean;

  /**
   * Remember which Space you were last in (in THIS browser), so reopening the
   * page later — even without the share link — brings your data back.
   *
   * Pass `true` for the default slot, or a name string to keep separate
   * memories for separate apps (e.g. `remember: "my-todo-app"`).
   *
   * Note: a Space's *contents* are always saved offline via IndexedDB anyway.
   * This option just remembers the Space's *code* so you can find it again
   * when there's no link in the URL.
   *
   * Resolution order when opening: an explicit `code` wins, then the URL hash,
   * then the remembered code, otherwise a new Space is created.
   * @default false
   */
  remember?: boolean | string;

  /**
   * How long (ms) to wait for a Space when joining by code before giving up
   * with a friendly error.
   * @default 8000
   */
  joinTimeout?: number;
}

/** A listener you can unregister by calling the returned function. */
export type Unsubscribe = () => void;

/** Info about another person currently in the Space (see {@link Space.onPeers}). */
export interface Peer {
  /** A stable-ish id for this peer for this session. */
  id: string;
  /** Whatever that peer passed to {@link Space.setPresence}. */
  presence: unknown;
}

// ---------------------------------------------------------------------------
// The Space
// ---------------------------------------------------------------------------

/**
 * A live, shared piece of data. Get one from {@link openSpace}.
 *
 * Read `space.data` any time for the current value. Call `space.update(...)`
 * to change it. Use `space.onChange(...)` to react when anything changes
 * (whether you or someone else made the change).
 */
export class Space<T extends SpaceData = SpaceData> {
  /** @internal */
  private handle: DocHandle<T>;
  /** @internal */
  private repo: Repo;
  /** @internal */
  private useHash: boolean;
  /** @internal */
  private changeListeners = new Set<(data: T) => void>();
  /** @internal */
  private peerListeners = new Set<(peers: Peer[]) => void>();
  /** @internal */
  private peers = new Map<string, { presence: unknown; lastSeen: number }>();
  /** @internal */
  private myPeerId = Math.random().toString(36).slice(2, 10);
  /** @internal */
  private myPresence: unknown = undefined;
  /** @internal */
  private peerSweep?: ReturnType<typeof setInterval>;
  /** @internal */
  private closed = false;

  /** @internal Use {@link openSpace} instead of constructing directly. */
  constructor(repo: Repo, handle: DocHandle<T>, useHash: boolean) {
    this.repo = repo;
    this.handle = handle;
    this.useHash = useHash;

    // Re-broadcast Automerge's change event to our simpler listeners.
    this.handle.on("change", () => this.emitChange());

    // Collect presence pings from other peers.
    this.handle.on("ephemeral-message", ({ message }: { message: unknown }) => {
      const m = message as { kind?: string; id?: string; presence?: unknown };
      if (m && m.kind === "kiss-presence" && typeof m.id === "string") {
        this.peers.set(m.id, { presence: m.presence, lastSeen: Date.now() });
        this.emitPeers();
      }
    });

    // Forget peers we haven't heard from in a while (they probably left).
    this.peerSweep = setInterval(() => {
      const cutoff = Date.now() - 6000;
      let changed = false;
      for (const [id, p] of this.peers) {
        if (p.lastSeen < cutoff) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this.emitPeers();
    }, 2000);
  }

  /** A stable identifier for this client in this session. */
  get peerId(): string {
    return this.myPeerId;
  }

  /**
   * The share code for this Space (e.g. "automerge:4kP..."). Give this to a
   * friend — or just share {@link shareUrl} — and they can join.
   */
  get code(): AutomergeUrl {
    return this.handle.url;
  }

  /**
   * A full link to this Space. Opening it (here or on another device) joins
   * the same Space. This is the easiest thing to share.
   */
  get shareUrl(): string {
    if (typeof location === "undefined") return this.code;
    return `${location.origin}${location.pathname}#${this.code}`;
  }

  /**
   * The current data. Read it freely. Do NOT edit it directly —
   * use {@link update} so the change actually syncs.
   */
  get data(): T {
    return this.handle.doc() as T;
  }

  /**
   * Change the data. Mutate the `draft` object however you like inside the
   * function — set fields, push to arrays, delete keys. The change is saved
   * locally and synced to everyone automatically.
   *
   *   space.update((data) => {
   *     data.messages.push({ from: "me", text: "hi" });
   *   });
   */
  update(recipe: (draft: T) => void): void {
    this.handle.change(recipe);
  }

  /**
   * Run a function whenever the data changes (from you or anyone else).
   * It is also called once immediately with the current data, which makes
   * rendering easy. Returns a function you can call to stop listening.
   *
   *   space.onChange((data) => render(data));
   */
  onChange(listener: (data: T) => void): Unsubscribe {
    this.changeListeners.add(listener);
    // Fire once now so you can render straight away.
    try {
      listener(this.data);
    } catch (err) {
      console.error("[AutomergeKISS] onChange listener threw:", err);
    }
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Tell everyone else something about you right now — a name, a color, a
   * cursor position, anything. This is "presence": it is NOT saved, it just
   * pings the people currently online. Call it whenever your info changes.
   *
   *   space.setPresence({ name: "Sam", cursor: { x, y } });
   */
  setPresence(presence: unknown): void {
    this.myPresence = presence;
    this.handle.broadcast({
      kind: "kiss-presence",
      id: this.myPeerId,
      presence,
    });
  }

  /**
   * React to who else is in the Space and what they're doing (their
   * {@link setPresence} info). Called whenever someone joins, leaves, or
   * updates. Returns a function to stop listening.
   *
   *   space.onPeers((peers) => showOnlineList(peers));
   */
  onPeers(listener: (peers: Peer[]) => void): Unsubscribe {
    this.peerListeners.add(listener);
    listener(this.currentPeers());
    return () => this.peerListeners.delete(listener);
  }

  /**
   * Leave the Space and clean everything up (timers, listeners, network).
   * Call this when you're done, e.g. when a component unmounts.
   */
  async leave(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.peerSweep) clearInterval(this.peerSweep);
    this.changeListeners.clear();
    this.peerListeners.clear();
    this.peers.clear();
    await this.repo.shutdown?.();
  }

  // --- internals -----------------------------------------------------------

  /** @internal */
  private currentPeers(): Peer[] {
    return [...this.peers.entries()].map(([id, p]) => ({
      id,
      presence: p.presence,
    }));
  }

  /** @internal */
  private emitChange(): void {
    const data = this.data;
    for (const l of this.changeListeners) {
      try {
        l(data);
      } catch (err) {
        console.error("[AutomergeKISS] onChange listener threw:", err);
      }
    }
  }

  /** @internal */
  private emitPeers(): void {
    const peers = this.currentPeers();
    for (const l of this.peerListeners) {
      try {
        l(peers);
      } catch (err) {
        console.error("[AutomergeKISS] onPeers listener threw:", err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The one function you call
// ---------------------------------------------------------------------------

/**
 * Open a Space. This is the main entry point.
 *
 * Behaviour, in plain English:
 *  - If you pass a `code` (or there's one in the page URL after `#`), you
 *    JOIN that existing Space.
 *  - Otherwise, a brand-new Space is CREATED using your `starter` data, and
 *    (by default) its code is written into the page URL so the link is
 *    instantly shareable.
 *
 * @example
 *   // A shared counter
 *   const space = await openSpace({ starter: { count: 0 } });
 *   space.onChange((d) => console.log(d.count));
 *   space.update((d) => { d.count++; });
 *
 * @throws if you ask to join a `code` that can't be found within the timeout.
 */
export async function openSpace<T extends SpaceData = SpaceData>(
  options: SpaceOptions<T> = {}
): Promise<Space<T>> {
  const {
    starter = {} as T,
    server = DEFAULT_SYNC_SERVER,
    localOnly = false,
    useUrlHash = true,
    joinTimeout = 8000,
  } = options;

  // 1. Wire up the plumbing (the part we're hiding from you).
  const network: Array<BroadcastChannelNetworkAdapter | WebSocketClientAdapter> = [
    // Same-device tabs/windows sync instantly and for free.
    new BroadcastChannelNetworkAdapter(),
  ];
  if (!localOnly) {
    network.push(new WebSocketClientAdapter(server));
  }

  // IndexedDB gives us offline + persistence, but it isn't always available
  // (some private-browsing modes, or file:// pages). If it's missing we just
  // run in-memory — syncing still works, data just won't survive a reload.
  const hasIndexedDB =
    typeof indexedDB !== "undefined" && indexedDB !== null;
  const repo = new Repo({
    network,
    storage: hasIndexedDB
      ? new IndexedDBStorageAdapter("automerge-kiss")
      : undefined,
  });
  if (!hasIndexedDB) {
    console.warn(
      "[AutomergeKISS] IndexedDB unavailable — running without local storage. " +
        "Sync works, but data won't persist across reloads. " +
        "Serve the page over http(s) (not file://) for full offline support."
    );
  }

  // 2. Figure out whether we're joining or creating.
  //    An explicit code (or one in the URL) is what the user asked for, so a
  //    failure there should be a clear error. A *remembered* code is implicit,
  //    so if it can't be opened we quietly start fresh instead of erroring.
  const remember = options.remember ?? false;
  const explicitCode = options.code ?? (useUrlHash ? readCodeFromHash() : undefined);
  const code = explicitCode ?? readRemembered(remember);

  const createFresh = async (): Promise<DocHandle<T>> => {
    const h = repo.create<T>(starter);
    await h.whenReady();
    return h;
  };

  let handle: DocHandle<T>;
  if (code && isValidAutomergeUrl(code)) {
    try {
      handle = await findWithTimeout<T>(repo, code, joinTimeout);
    } catch (err) {
      if (explicitCode) throw err;
      console.warn(
        "[AutomergeKISS] Couldn't reopen your last Space — starting a new one."
      );
      handle = await createFresh();
    }
  } else if (code && explicitCode) {
    // The user explicitly handed us something that isn't a valid code.
    throw new Error(
      `[AutomergeKISS] "${code}" is not a valid Space code. ` +
        `Codes look like "automerge:...". Check the link you were given.`
    );
  } else {
    // No code, or a stale/garbage remembered value — create a fresh Space.
    handle = await createFresh();
  }

  // Keep the URL and the remembered slot pointing at whatever we ended up with.
  if (useUrlHash) writeCodeToHash(handle.url);
  writeRemembered(remember, handle.url);

  return new Space<T>(repo, handle, useUrlHash);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const REMEMBER_PREFIX = "automerge-kiss:space:";

/** localStorage key for a remember slot (`true` → the default slot). */
function rememberKey(remember: boolean | string): string {
  return REMEMBER_PREFIX + (typeof remember === "string" ? remember : "default");
}

/** Read the remembered Space code for this slot, if any. */
function readRemembered(remember: boolean | string): string | undefined {
  if (!remember) return undefined;
  try {
    return localStorage.getItem(rememberKey(remember)) ?? undefined;
  } catch {
    return undefined; // localStorage can be unavailable (private mode, file://)
  }
}

/** Save the current Space code so it can be reopened later. */
function writeRemembered(remember: boolean | string, code: string): void {
  if (!remember) return;
  try {
    localStorage.setItem(rememberKey(remember), code);
  } catch {
    /* ignore — remembering is best-effort */
  }
}

/**
 * Forget the remembered Space so the next `openSpace` with `remember` starts a
 * brand-new one. Pass the same `remember` value you opened with (or omit it
 * for the default slot). Handy for a "Start a new board" button.
 */
export function forgetSpace(remember: boolean | string = true): void {
  try {
    localStorage.removeItem(rememberKey(remember));
  } catch {
    /* ignore */
  }
}

/** Read a Space code out of the page URL hash (the part after `#`). */
function readCodeFromHash(): string | undefined {
  if (typeof location === "undefined") return undefined;
  const raw = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
  return raw ? raw : undefined;
}

/** Put a Space code into the page URL hash without reloading the page. */
function writeCodeToHash(code: string): void {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  const url = `${location.pathname}${location.search}#${code}`;
  history.replaceState(null, "", url);
}

/**
 * Look up a document, but turn the "never found" case into a clear, friendly
 * error after `timeout` ms instead of hanging forever.
 */
async function findWithTimeout<T extends SpaceData>(
  repo: Repo,
  code: string,
  timeout: number
): Promise<DocHandle<T>> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `[AutomergeKISS] Couldn't find the Space "${code}" in time. ` +
              `Either the code is wrong, or nobody who has that Space is online right now.`
          )
        ),
      timeout
    )
  );

  try {
    return (await Promise.race([
      repo.find<T>(code as AutomergeUrl),
      timer,
    ])) as DocHandle<T>;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[AutomergeKISS]")) throw err;
    throw new Error(
      `[AutomergeKISS] Couldn't open the Space "${code}". ` +
        `Double-check the code or link. (${(err as Error).message})`
    );
  }
}

// Re-export the underlying Automerge pieces for anyone who wants to "eject"
// and use the full API directly once they've outgrown the training wheels.
export {
  Repo,
  WebSocketClientAdapter,
  IndexedDBStorageAdapter,
  BroadcastChannelNetworkAdapter,
  isValidAutomergeUrl,
};
export type { DocHandle, AutomergeUrl };

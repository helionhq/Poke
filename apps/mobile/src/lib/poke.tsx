import {
  EventStream,
  Outbox,
  PokeClient,
  type LiveEvent,
  type PersistedEvent,
  type StreamStatus,
  ThreadStore,
} from "@poke/client";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import { Cache } from "./cache";
import { clearSession, loadSession, type Session } from "./session";
import { deleteVaultKey } from "./vaultKey";

type Listener = (event: PersistedEvent | LiveEvent) => void;

export interface Poke {
  session: Session;
  client: PokeClient;
  store: ThreadStore;
  outbox: Outbox;
  cache: Cache;
  status: StreamStatus;
  /** Events the thread store doesn't keep (routines, skills, vault…), for screens that list them. */
  onEvent(listener: Listener): () => void;
  send(input: { text: string; attachmentIds?: string[]; replyTo?: string }): Promise<void>;
  /** Fetches the newest page and replaces the thread (after a long time away). */
  refetch(): Promise<void>;
  /** Loads the page above the oldest message on screen. */
  loadOlder(): Promise<void>;
  signOut(): Promise<void>;
}

type State = { phase: "loading" } | { phase: "signed-out" } | { phase: "ready"; poke: Poke };

const PokeContext = createContext<State>({ phase: "loading" });
const SignInContext = createContext<(session: Session) => void>(() => {});

export function usePokeState(): State {
  return useContext(PokeContext);
}

/** The signed-in app; only call inside screens that render after pairing. */
export function usePoke(): Poke {
  const state = useContext(PokeContext);
  if (state.phase !== "ready") throw new Error("Poke isn't paired yet");
  return state.poke;
}

export function useSignIn(): (session: Session) => void {
  return useContext(SignInContext);
}

/** Re-renders when the thread changes. */
export function useThread(): ThreadStore {
  const { store } = usePoke();
  useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.version,
  );
  return store;
}

export function PokeProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    loadSession().then(
      (s) => setSession(s ?? null),
      () => setSession(null),
    );
  }, []);
  const signOut = useCallback(async () => {
    await clearSession();
    await deleteVaultKey().catch(() => {});
    setSession(null);
  }, []);
  return (
    <SignInContext.Provider value={setSession}>
      {session === undefined ? (
        <PokeContext.Provider value={{ phase: "loading" }}>{children}</PokeContext.Provider>
      ) : session === null ? (
        <PokeContext.Provider value={{ phase: "signed-out" }}>{children}</PokeContext.Provider>
      ) : (
        <Connected key={session.token} session={session} signOut={signOut}>
          {children}
        </Connected>
      )}
    </SignInContext.Provider>
  );
}

function Connected({
  session,
  signOut,
  children,
}: {
  session: Session;
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const listeners = useRef(new Set<Listener>());

  const core = useMemo(() => {
    const cache = new Cache();
    const client = new PokeClient({
      baseUrl: session.url,
      token: session.token,
      ...(session.headers ? { headers: session.headers } : {}),
    });
    const store = new ThreadStore("main");
    const outbox = new Outbox(cache.outboxStorage(), async (entry) => {
      await client.send({
        text: entry.text,
        clientMessageId: entry.clientMessageId,
        attachmentIds: entry.attachmentIds,
        ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
        context: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
    });
    store.onOther = (event) => {
      for (const fn of listeners.current) fn(event);
    };
    store.onLive = (event) => {
      for (const fn of listeners.current) fn(event);
    };
    store.onConfirmed = (id) => void outbox.confirm(id);
    outbox.subscribe(() => store.setPending(outbox.entries()));
    const cached = cache.thread(session.url);
    if (cached) store.restore(cached);
    return { cache, client, store, outbox };
  }, [session]);

  const refetch = useCallback(async () => {
    const page = await core.client.messages({ limit: 50 });
    core.store.reset(page);
  }, [core]);

  useEffect(() => {
    const { cache, client, store, outbox } = core;
    let alive = true;
    void outbox.load().then(() => outbox.flush());
    const stream = new EventStream({
      baseUrl: session.url,
      token: () => client.token,
      ...(session.headers ? { headers: session.headers } : {}),
      since: () => store.latestSeq,
      presence: () => (AppState.currentState === "active" ? "foreground" : "background"),
      onStatus: (s) => {
        if (!alive) return;
        setStatus(s);
        if (s === "open") void outbox.flush();
        if (s === "unauthorized") void signOut();
      },
      onFrame: (frame) => {
        if (store.apply(frame) === "refetch") void refetch().catch(() => {});
      },
    });
    // Nothing cached yet: load the newest page, then stream from its seq.
    if (store.latestSeq === 0)
      void refetch()
        .catch(() => {})
        .finally(() => alive && stream.start());
    else stream.start();

    // Save the cache a moment after changes settle.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cache.saveThread(session.url, store.snapshot()), 800);
    });
    const app = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        stream.setPresence("foreground");
        stream.reconnectNow();
        void outbox.flush();
      } else if (next === "background") {
        stream.setPresence("background");
        cache.saveThread(session.url, store.snapshot());
      }
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
      app.remove();
      stream.stop();
    };
  }, [core, session, signOut, refetch]);

  const poke: Poke = useMemo(
    () => ({
      session,
      ...core,
      status,
      onEvent: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      send: async (input) => {
        await core.outbox.enqueue(input);
      },
      refetch,
      loadOlder: async () => {
        const before = core.store.oldestCursor;
        if (!before || !core.store.hasOlder) return;
        core.store.addPage(await core.client.messages({ before, limit: 50 }));
      },
      signOut,
    }),
    [session, core, status, refetch, signOut],
  );

  return <PokeContext.Provider value={{ phase: "ready", poke }}>{children}</PokeContext.Provider>;
}

/**
 * Loads something from the server, reloading when one of `events` arrives (e.g. routine.updated).
 * Keeps the last good value while reloading; `error` is a readable message.
 */
export function useRemote<T>(
  load: (poke: Poke) => Promise<T>,
  deps: unknown[],
  events: (PersistedEvent | LiveEvent)["type"][] = [],
) {
  const poke = usePoke();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loader.current(poke));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, [poke.client, ...deps]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const key = events.join(",");
  useEffect(() => {
    if (!key) return;
    const types = new Set(key.split(","));
    return poke.onEvent((e) => {
      if (types.has(e.type)) void reload();
    });
  }, [poke, key, reload]);
  return { data, error, loading, reload, setData };
}

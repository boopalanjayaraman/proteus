import { MongoClient, type Db } from 'mongodb';

/**
 * The Mongo connection.
 *
 * A replica set is a hard requirement, not a preference: the SSE fan-out tails a
 * change stream (data model §6e) and a standalone mongod cannot open one. That
 * failure is invisible until the first subscriber connects and silently receives
 * nothing, so it is probed here and reported at startup instead.
 */

export interface DbHandle {
  client: MongoClient;
  db: Db;
  /** False when change streams are unavailable — live screens will not update. */
  supportsChangeStreams: boolean;
}

export class DbConnectionError extends Error {}

let handle: DbHandle | null = null;

export async function connect(uri: string, dbName: string): Promise<DbHandle> {
  if (handle) return handle;

  const client = new MongoClient(uri, {
    // A migration run holds a lease it must refresh; a long pause looks like a
    // dead holder to the reaper, so fail fast rather than hang.
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
  });

  try {
    await client.connect();
  } catch (e) {
    throw new DbConnectionError(
      `cannot reach MongoDB at ${redactUri(uri)}: ${(e as Error).message}`,
    );
  }

  const db = client.db(dbName);
  const supportsChangeStreams = await probeChangeStreams(client);

  handle = { client, db, supportsChangeStreams };
  return handle;
}

/**
 * Opening a change stream is the only reliable test — `hello.setName` is absent
 * on some managed deployments that do support them.
 */
async function probeChangeStreams(client: MongoClient): Promise<boolean> {
  try {
    const stream = client.db('admin').watch([], { maxAwaitTimeMS: 1 });
    await stream.close();
    return true;
  } catch {
    return false;
  }
}

/** Strips credentials so a connection string can appear in an error or a log. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@]*@/, '//<credentials>@');
}

export function db(): Db {
  if (!handle) throw new DbConnectionError('connect() has not been called');
  return handle.db;
}

export function mongo(): MongoClient {
  if (!handle) throw new DbConnectionError('connect() has not been called');
  return handle.client;
}

export function changeStreamsAvailable(): boolean {
  return handle?.supportsChangeStreams ?? false;
}

export async function disconnect(): Promise<void> {
  await handle?.client.close();
  handle = null;
}

/** Test seam: bind an already-connected client. */
export function __setHandle(h: DbHandle | null): void {
  handle = h;
}

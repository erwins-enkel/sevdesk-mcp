import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

// `--reload` (a local checkout's client entry): the process the client starts serves MCP through a
// child running the real server and starts a new child once the build changed. Code Mode keeps the
// tools the client listed at connect (`search`, `execute`), so the client does not notice the swap.
// MCP stdio is newline-delimited JSON-RPC; lines pass through unchanged and are only read for their
// `id` and `method`.

/** The id of the `initialize` replayed to a new child; its response is never forwarded. */
const REPLAY_ID = 'sevdesk-mcp-reload';

type Id = string | number;

interface Message {
  id?: Id;
  method?: string;
  params?: { requestId?: Id };
}

/** A child: the real server, the build stamp it started from, and why it ended once it did. */
interface Child {
  process: ChildProcessByStdio<Writable, Readable, null>;
  stamp: number;
  /** The exit code, signal or spawn error once the child ended; undefined while it runs. */
  ended?: string;
  /** Settles a pending replay of the opening once the child answered it or ended. */
  replayed?: () => void;
}

export interface ReloadOptions {
  /** The real server's command line: the executable, then its arguments. */
  command: string[];
  /** The directories whose newest file marks the build a child runs. */
  watch: string[];
  input?: Readable;
  output?: Writable;
  /** Called when a running child was replaced by one of a new build. */
  onRestart?: () => void;
}

/**
 * The newest modification time of any file under `dirs` (recursively): the build stamp. A missing
 * directory, or a file that disappears meanwhile, contributes nothing.
 */
function buildStamp(dirs: string[]): number {
  let newest = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir, { recursive: true, encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      const stat = statSync(join(dir, name), { throwIfNoEntry: false });
      if (stat?.isFile() === true) newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

/** The JSON-RPC messages of a line (a batch counts element by element); none when it is not JSON. */
function messagesOf(line: string): Message[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return [parsed]
    .flat()
    .filter((item): item is Message => typeof item === 'object' && item !== null);
}

const isRequest = (message: Message): message is Message & { id: Id } =>
  message.id !== undefined && message.method !== undefined;

const isResponse = (message: Message): message is Message & { id: Id } =>
  message.id !== undefined && message.method === undefined;

/**
 * Serves MCP from `input` to `output` through a child running `command`, and replaces the child by
 * one of the current build when it is needed: the child ended, or the build stamp of the `watch`
 * directories changed and no client request is in flight. A request is in flight until the child
 * answers it or the client cancels it. A new child gets the client's 2025-era opening (`initialize`,
 * then `notifications/initialized`) replayed first; a modern opening carries everything per request.
 * When a child ends, each request still in flight is answered with an error, never left hanging.
 * Settles once `input` ended and the last child exited.
 */
export function serveWithReload({
  command: [executable = '', ...args],
  watch,
  input = process.stdin,
  output = process.stdout,
  onRestart,
}: ReloadOptions): Promise<void> {
  const inFlight = new Set<Id>();
  let initialize: Message | undefined;
  let initialized: string | undefined;

  const send = (message: object) => output.write(`${JSON.stringify(message)}\n`);

  /** Answers request `id` with the error that its server ended. */
  const failed = (id: Id, reason: string) =>
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: `The sevdesk-mcp server exited (${reason}) before answering; see the client's MCP log. The next call starts it again.`,
      },
    });

  const startChild = (): Child => {
    const stamp = buildStamp(watch);
    const child: Child = {
      process: spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'] }),
      stamp,
    };
    // A write to a child that just ended fails here; its requests are answered when it closes.
    child.process.stdin.on('error', () => undefined);
    createInterface({ input: child.process.stdout, crlfDelay: Infinity }).on('line', (line) => {
      fromChild(child, line);
    });
    const end = (reason: string) => {
      if (child.ended !== undefined) return;
      child.ended = reason;
      child.replayed?.();
      if (child !== current) return;
      for (const id of inFlight) failed(id, reason);
      inFlight.clear();
    };
    child.process.on('close', (code, signal) => {
      end(String(code ?? signal));
    });
    child.process.on('error', (error) => {
      end(error.message);
    });
    return child;
  };

  /** Forwards a line of `child` to the client, unless the child was replaced or it is the replay's. */
  const fromChild = (child: Child, line: string) => {
    if (child !== current) return;
    for (const message of messagesOf(line).filter(isResponse)) {
      if (message.id === REPLAY_ID) {
        child.replayed?.();
        return;
      }
      inFlight.delete(message.id);
    }
    output.write(`${line}\n`);
  };

  let current = startChild();

  /** Replaces the current child by a new one and replays the client's opening to it. */
  const restart = async () => {
    const previous = current;
    current = startChild();
    if (previous.ended === undefined) {
      previous.process.kill();
      onRestart?.();
    }
    if (initialize === undefined) return;
    const child = current;
    await new Promise<void>((resolve) => {
      child.replayed = resolve;
      child.process.stdin.write(`${JSON.stringify({ ...initialize, id: REPLAY_ID })}\n`);
    });
    if (initialized !== undefined && child.ended === undefined) {
      child.process.stdin.write(`${initialized}\n`);
    }
  };

  /** Remembers the client's 2025-era opening, the first `initialize` and its acknowledgement. */
  const rememberOpening = (line: string, message: Message) => {
    if (message.method === 'initialize') initialize ??= message;
    if (message.method === 'notifications/initialized') initialized ??= line;
  };

  /** Notes what a client line means for the in-flight requests and the opening to replay. */
  const track = (line: string, messages: Message[]) => {
    for (const message of messages) {
      if (isRequest(message)) inFlight.add(message.id);
      const cancelled = message.method === 'notifications/cancelled';
      if (cancelled && message.params?.requestId !== undefined) {
        inFlight.delete(message.params.requestId);
      }
      rememberOpening(line, message);
    }
  };

  /** Forwards a client line to the current child; a child that ended fails its requests instead. */
  const fromClient = async (line: string) => {
    const messages = messagesOf(line);
    const stale = inFlight.size === 0 && buildStamp(watch) !== current.stamp;
    if (current.ended !== undefined || stale) await restart();
    const { ended } = current;
    if (ended !== undefined) {
      for (const message of messages.filter(isRequest)) failed(message.id, ended);
      return;
    }
    track(line, messages);
    current.process.stdin.write(`${line}\n`);
  };

  return new Promise((resolve) => {
    let queue = Promise.resolve();
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      queue = queue.then(() => fromClient(line));
    });
    lines.on('close', () => {
      void queue.then(() => {
        const child = current;
        if (child.ended !== undefined) {
          resolve();
          return;
        }
        child.process.on('close', () => {
          resolve();
        });
        child.process.stdin.end();
      });
    });
  });
}

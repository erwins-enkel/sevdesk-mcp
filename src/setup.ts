import { isDeepStrictEqual } from 'node:util';
import {
  entriesUsing,
  entryName,
  entryState,
  type InstalledClient,
  installedClients,
  launchArgv,
  readServers,
  rewriteServers,
} from './clients.ts';
import {
  type Config,
  configFile,
  deleteProfile,
  isProfileName,
  loadConfig,
  saveProfile,
} from './config.ts';
import { type Locale, type MessageKey, t } from './i18n/index.ts';
import { deleteToken, probeKeychain, SERVICE, storeToken } from './keychain.ts';
import { name as packageName } from './manifest.ts';
import type { Prompter } from './prompt.ts';
import { HostError } from './sandbox.ts';
import { bookkeepingSystem, companyName, SUPPORTED_SYSTEM } from './sevdesk.ts';

/** Where `setup` writes: lines to show, and errors. */
export interface SetupOutput {
  /** Shows a line (stdout). */
  print: (text: string) => void;
  /** Reports why setup stopped (stderr). */
  fail: (text: string) => void;
}

/** How the interactive `setup` commands talk to the user: questions through `prompter`. */
export interface SetupIO extends SetupOutput {
  prompter: Prompter;
}

// A token as setup accepts it: printable ASCII without spaces, since it travels in a header.
const TOKEN = /^[\x21-\x7e]+$/;

/** Ends setup before anything is stored; its message says why. */
class SetupStopped extends Error {}

type Params = Record<string, string>;

/** The setup dialogue in `locale`: messages, questions, and the stops that end it. */
function dialogue(locale: Locale, { prompter, print }: SetupIO) {
  const text = (key: MessageKey, params?: Params) => t(locale, key, params);
  const words = (key: MessageKey) => text(key).split(',');

  /** The trimmed answer to `question`; a cancelled question stops setup. */
  async function ask(question: string, hidden = false): Promise<string> {
    const answer = await prompter.ask(question, { hidden });
    if (answer === undefined) throw new SetupStopped(text('setup.cancelled'));
    return answer.trim();
  }

  return {
    text,
    ask,
    say: (key: MessageKey, params?: Params) => {
      print(text(key, params));
    },
    stop: (key: MessageKey, params?: Params) => new SetupStopped(text(key, params)),
    /** A yes/no question; an empty or unrecognised answer is `byDefault`. */
    async confirm(key: MessageKey, params: Params, byDefault: boolean): Promise<boolean> {
      const choices = text(byDefault ? 'setup.defaultYes' : 'setup.defaultNo');
      const answer = (await ask(text(key, { ...params, choices }))).toLowerCase();
      if (words('setup.yesAnswers').includes(answer)) return true;
      if (words('setup.noAnswers').includes(answer)) return false;
      return byDefault;
    },
  };
}

type Dialogue = ReturnType<typeof dialogue>;

/** The message of a failed write, never anything else the error carries. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The config of the config file; an invalid file stops setup. */
function configOf(ui: Dialogue): Config {
  const loaded = loadConfig();
  if (!loaded.ok) throw ui.stop('setup.invalidConfig', { message: loaded.error.message });
  return loaded.config;
}

/**
 * Checks `token` against sevDesk: the account must use the supported bookkeeping system. Shows the
 * company and the system and resolves to the company name. A rejected token, another system and
 * any failed request stop setup.
 */
async function checkAccount(ui: Dialogue, config: Config, token: string): Promise<string> {
  const account = { baseUrl: config.baseUrl, token };
  const signal = AbortSignal.timeout(config.limits.timeoutMs);
  ui.say('setup.checking');
  try {
    const system = await bookkeepingSystem(account, signal);
    if (system !== SUPPORTED_SYSTEM) {
      const version = system ?? ui.text('setup.unknownVersion');
      throw ui.stop('setup.unsupportedSystem', { version, supported: SUPPORTED_SYSTEM });
    }
    const company = await companyName(account, signal);
    ui.say('setup.account', { company, system });
    return company;
  } catch (error) {
    if (!(error instanceof HostError)) throw error;
    if (error.error.status === 401) throw ui.stop('setup.tokenRejected');
    throw ui.stop('setup.checkFailed', { detail: error.error.message });
  }
}

/**
 * Asks for the profile name and, when the config file has that profile already, whether to replace
 * it (default no). Resolves to the name and the existing profile, if any.
 */
async function askProfile(ui: Dialogue, config: Config) {
  const name = await ui.ask(ui.text('setup.askProfile'));
  if (!isProfileName(name)) throw ui.stop('cli.invalidProfileName', { profile: name });
  const existing = config.profiles.find((profile) => profile.name === name);
  if (existing !== undefined) {
    const params = { profile: name, company: existing.company };
    if (!(await ui.confirm('setup.askReplace', params, false))) {
      throw ui.stop('setup.notReplaced', { profile: name });
    }
  }
  return { name, existing };
}

/**
 * Asks for the token (hidden) once the OS keychain for `name` proves usable, so no one types a
 * token that cannot be stored. No keychain and a token that cannot be one stop setup.
 */
async function askToken(ui: Dialogue, name: string): Promise<string> {
  const problem = await probeKeychain(name);
  if (problem !== undefined) throw ui.stop('setup.noKeychain', { reason: problem });
  const token = await ui.ask(ui.text('setup.askToken'), true);
  if (!TOKEN.test(token)) throw ui.stop('setup.invalidToken');
  return token;
}

/**
 * Stores `token` in the OS keychain, then `profile` in the config file, and says it is set up. A
 * failed keychain write stops setup with nothing stored; a failed config write is reported with the
 * keychain entry it leaves behind and resolves to false.
 */
async function store(
  ui: Dialogue,
  io: SetupIO,
  profile: { name: string; company: string; readonly: boolean },
  token: string,
): Promise<boolean> {
  const { name, company, readonly } = profile;
  const problem = await storeToken(name, token);
  if (problem !== undefined) throw ui.stop('setup.keychainWriteFailed', { reason: problem });
  try {
    saveProfile(profile);
  } catch (error) {
    const params = { service: SERVICE, profile: name, file: configFile(), reason: reasonOf(error) };
    io.fail(ui.text('setup.configWriteFailed', params));
    return false;
  }
  ui.say(readonly ? 'setup.doneReadonly' : 'setup.done', { profile: name, company });
  return true;
}

type Edit = Parameters<typeof rewriteServers>[1];

/**
 * The servers of a client's config `file`, or undefined when it cannot be read, which is reported on
 * `io.fail`; the file is left as it is.
 */
function serversOf(ui: Dialogue, io: SetupIO, file: string, params: Params) {
  try {
    return readServers(file).servers;
  } catch (error) {
    io.fail(ui.text('setup.clientUnreadable', { ...params, reason: reasonOf(error) }));
    return undefined;
  }
}

/**
 * Applies `edit` to the servers of a client's config `file` after the user said yes, and reports
 * the outcome: `done` and the backup, or why the file was left as it is (on `io.fail`). Returns
 * whether the file was written.
 */
function applyEdit(
  ui: Dialogue,
  io: SetupIO,
  file: string,
  params: Params,
  done: MessageKey,
  edit: Edit,
): boolean {
  let outcome: ReturnType<typeof rewriteServers>;
  try {
    outcome = rewriteServers(file, edit);
  } catch (error) {
    io.fail(ui.text('setup.clientUpdateFailed', { ...params, reason: reasonOf(error) }));
    return false;
  }
  if (!outcome.written) {
    io.fail(ui.text('setup.clientChanged', params));
    return false;
  }
  ui.say(done, params);
  if (outcome.backup !== undefined) ui.say('setup.backedUp', { backup: outcome.backup });
  return true;
}

/**
 * Offers to add the entry `name` that starts `profile` to every installed client (decision 18), one
 * question per client: adding a new entry defaults to yes, replacing a different entry of that name
 * needs an explicit yes, and an entry that starts the same command line is left alone. Resolves to
 * false when a client config could not be read or written; a no is no failure.
 */
async function registerClients(
  ui: Dialogue,
  io: SetupIO,
  clients: InstalledClient[],
  profile: string,
  name: string,
): Promise<boolean> {
  let ok = true;
  for (const { client, file } of clients) {
    const entry = client.entry(launchArgv(profile));
    const params = { client: client.name, entry: name, file };
    const servers = serversOf(ui, io, file, params);
    if (servers === undefined) {
      ok = false;
      continue;
    }
    const state = entryState(servers, name, entry);
    if (state === 'same') {
      ui.say('setup.entryExists', params);
      continue;
    }
    const yes =
      state === 'absent'
        ? await ui.confirm('setup.askAddEntry', params, true)
        : await ui.confirm('setup.askReplaceEntry', params, false);
    if (!yes) {
      ui.say('setup.clientLeft', params);
      continue;
    }
    const edit: Edit = (current) =>
      entryState(current, name, entry) === state ? { ...current, [name]: entry } : undefined;
    ok = applyEdit(ui, io, file, params, 'setup.entryAdded', edit) && ok;
  }
  return ok;
}

/**
 * Offers to remove, from every installed client, the entries that start the removed `profile`
 * (decision 18), one question per client that has any (default yes). Resolves to false when a client
 * config could not be read or written; a no is no failure.
 */
async function unregisterClients(
  ui: Dialogue,
  io: SetupIO,
  clients: InstalledClient[],
  profile: string,
): Promise<boolean> {
  let ok = true;
  for (const { client, file } of clients) {
    const servers = serversOf(ui, io, file, { client: client.name, file });
    if (servers === undefined) {
      ok = false;
      continue;
    }
    const names = entriesUsing(servers, profile);
    if (names.length === 0) continue;
    const params = { client: client.name, file, profile, entries: names.join(', ') };
    if (!(await ui.confirm('setup.askRemoveEntries', params, true))) {
      ui.say('setup.clientLeft', params);
      continue;
    }
    const edit: Edit = (current) =>
      isDeepStrictEqual(entriesUsing(current, profile), names)
        ? Object.fromEntries(Object.entries(current).filter(([entry]) => !names.includes(entry)))
        : undefined;
    ok = applyEdit(ui, io, file, params, 'setup.entriesRemoved', edit) && ok;
  }
  return ok;
}

/**
 * The client step after a profile was stored or removed: `run` asks about the installed clients. A
 * cancelled question ends it, reported with what it leaves untouched. Then the manual hint follows:
 * `none` when no client is installed, else `others`, with `params`. Resolves to `run`'s outcome, or
 * false when cancelled.
 */
async function clientStep(
  ui: Dialogue,
  io: SetupIO,
  [none, others]: [MessageKey, MessageKey],
  params: Params,
  run: (clients: InstalledClient[]) => Promise<boolean>,
): Promise<boolean> {
  const clients = installedClients();
  const done = await reportStops(ui, io, 'setup.clientsLeft', () => run(clients));
  ui.say(clients.length === 0 ? none : others, params);
  return done;
}

/**
 * Adds a profile (PRD §7, decisions 4, 18, 19): asks for its name, checks the OS keychain, asks for
 * the token (hidden) and checks it against sevDesk, asks whether the profile is read-only (default
 * no, or the replaced profile's value), then stores the token in the keychain and the profile in
 * the config file. Every stop before that stores nothing. Then it offers to register the profile in
 * each installed MCP client and shows the command for other clients.
 */
async function addProfile(ui: Dialogue, io: SetupIO): Promise<boolean> {
  const config = configOf(ui);
  ui.say('setup.intro');
  const { name, existing } = await askProfile(ui, config);
  const token = await askToken(ui, name);
  const company = await checkAccount(ui, config, token);
  const readonly = await ui.confirm('setup.askReadonly', {}, existing?.readonly ?? false);
  if (!(await store(ui, io, { name, company, readonly }, token))) return false;
  const entry = entryName(name, config.profiles.length + (existing === undefined ? 1 : 0));
  const hints: [MessageKey, MessageKey] = ['setup.clientEntry', 'setup.otherClientsEntry'];
  return clientStep(ui, io, hints, { package: packageName, profile: name }, (clients) =>
    registerClients(ui, io, clients, name, entry),
  );
}

/**
 * Runs `body` and resolves to its outcome. When it stops, the stop's message and `trailer` (what was
 * left untouched) are reported on `io.fail` and it resolves to false.
 */
async function reportStops(
  ui: Dialogue,
  io: SetupIO,
  trailer: MessageKey,
  body: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await body();
  } catch (error) {
    if (!(error instanceof SetupStopped)) throw error;
    io.fail(error.message);
    io.fail(ui.text(trailer));
    return false;
  }
}

/**
 * Runs `setup` in `locale` through `io`: adds a profile with its token in the OS keychain and offers
 * to register it in the installed MCP clients. Resolves to true when the profile is stored and no
 * client config failed; otherwise it has reported why on `io.fail`.
 */
export async function runSetup(locale: Locale, io: SetupIO): Promise<boolean> {
  const ui = dialogue(locale, io);
  return reportStops(ui, io, 'setup.nothingStored', () => addProfile(ui, io));
}

/**
 * Runs `setup --list` in `locale`: prints every profile of the config file, in the file's order,
 * with its company and whether it is read-only. It reads only the config file, never the OS
 * keychain, so no token can show. Returns false when the config file is invalid, reported on
 * `out.fail`.
 */
export function runList(locale: Locale, out: SetupOutput): boolean {
  const loaded = loadConfig();
  if (!loaded.ok) {
    out.fail(t(locale, 'setup.invalidConfig', { message: loaded.error.message }));
    return false;
  }
  const { profiles } = loaded.config;
  if (profiles.length === 0) {
    out.print(t(locale, 'setup.listEmpty'));
    return true;
  }
  out.print(t(locale, 'setup.listHeader', { file: configFile() }));
  for (const { name, company, readonly } of profiles) {
    const access = t(locale, readonly ? 'setup.accessReadonly' : 'setup.accessReadWrite');
    out.print(t(locale, 'setup.listEntry', { profile: name, company, access }));
  }
  return true;
}

/**
 * Removes the profile `name` (decision 18) after an explicit yes: its token from the OS keychain
 * first, then its entry from the config file, so a failure never leaves a token behind that no
 * profile names. Every stop before the keychain removes nothing; a failed config write is reported
 * with the token already gone and resolves to false (running it again finishes the removal). Then it
 * offers to remove the entries that start the profile from each installed MCP client.
 */
async function removeProfile(ui: Dialogue, io: SetupIO, name: string): Promise<boolean> {
  const profile = configOf(ui).profiles.find((entry) => entry.name === name);
  if (profile === undefined) throw ui.stop('setup.unknownProfile', { profile: name });
  const params = { profile: name, company: profile.company };
  if (!(await ui.confirm('setup.askRemove', params, false))) {
    throw ui.stop('setup.notRemoved', { profile: name });
  }
  const problem = await deleteToken(name);
  if (problem !== undefined) throw ui.stop('setup.keychainDeleteFailed', { reason: problem });
  try {
    deleteProfile(name);
  } catch (error) {
    const file = configFile();
    io.fail(ui.text('setup.configRemoveFailed', { profile: name, file, reason: reasonOf(error) }));
    return false;
  }
  ui.say('setup.removed', params);
  const hints: [MessageKey, MessageKey] = [
    'setup.removeClientEntry',
    'setup.removeOtherClientEntry',
  ];
  return clientStep(ui, io, hints, { profile: name }, (clients) =>
    unregisterClients(ui, io, clients, name),
  );
}

/**
 * Runs `setup --remove <name>` in `locale` through `io`. Resolves to true when the profile is
 * removed and no client config failed; otherwise it has reported why on `io.fail`.
 */
export async function runRemove(locale: Locale, io: SetupIO, name: string): Promise<boolean> {
  const ui = dialogue(locale, io);
  return reportStops(ui, io, 'setup.nothingRemoved', () => removeProfile(ui, io, name));
}

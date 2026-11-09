import { type Config, configFile, isProfileName, loadConfig, saveProfile } from './config.ts';
import { type Locale, type MessageKey, t } from './i18n/index.ts';
import { probeKeychain, SERVICE, storeToken } from './keychain.ts';
import { name as packageName } from './manifest.ts';
import type { Prompter } from './prompt.ts';
import { HostError } from './sandbox.ts';
import { bookkeepingSystem, companyName, SUPPORTED_SYSTEM } from './sevdesk.ts';

/** How `setup` talks to the user: questions through `prompter`, lines to show, and errors. */
export interface SetupIO {
  prompter: Prompter;
  /** Shows a line (stdout). */
  print: (text: string) => void;
  /** Reports why setup stopped (stderr). */
  fail: (text: string) => void;
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
 * Stores `token` in the OS keychain, then `profile` in the config file, and says how to use it.
 * A failed keychain write stops setup with nothing stored; a failed config write is reported with
 * the keychain entry it leaves behind and resolves to false.
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
    const reason = error instanceof Error ? error.message : String(error);
    const file = configFile();
    io.fail(ui.text('setup.configWriteFailed', { service: SERVICE, profile: name, file, reason }));
    return false;
  }
  ui.say(readonly ? 'setup.doneReadonly' : 'setup.done', { profile: name, company });
  ui.say('setup.clientEntry', { package: packageName, profile: name });
  return true;
}

/**
 * Adds a profile (PRD §7, decisions 4, 18, 19): asks for its name, checks the OS keychain, asks for
 * the token (hidden) and checks it against sevDesk, asks whether the profile is read-only (default
 * no, or the replaced profile's value), then stores the token in the keychain and the profile in
 * the config file. Every stop before that stores nothing.
 */
async function addProfile(ui: Dialogue, io: SetupIO): Promise<boolean> {
  const loaded = loadConfig();
  if (!loaded.ok) throw ui.stop('setup.invalidConfig', { message: loaded.error.message });
  const { config } = loaded;
  ui.say('setup.intro');
  const { name, existing } = await askProfile(ui, config);
  const token = await askToken(ui, name);
  const company = await checkAccount(ui, config, token);
  const readonly = await ui.confirm('setup.askReadonly', {}, existing?.readonly ?? false);
  return store(ui, io, { name, company, readonly }, token);
}

/**
 * Runs `setup` in `locale` through `io`: adds a profile with its token in the OS keychain. Resolves
 * to true when the profile is stored; otherwise it has reported why on `io.fail`.
 */
export async function runSetup(locale: Locale, io: SetupIO): Promise<boolean> {
  const ui = dialogue(locale, io);
  try {
    return await addProfile(ui, io);
  } catch (error) {
    if (!(error instanceof SetupStopped)) throw error;
    io.fail(error.message);
    io.fail(ui.text('setup.nothingStored'));
    return false;
  }
}

import { homedir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { auditDir } from './audit.ts';
import { installedClients, profileEntries, readServers } from './clients.ts';
import {
  type Config,
  configFile,
  loadConfig,
  type ProfileSettings,
  setAudit,
  setProfileKey,
} from './config.ts';
import { type Locale, type MessageKey, t } from './i18n/index.ts';
import { defaultDownloadDir } from './paths.ts';
import {
  runCheck,
  runRegister,
  runRemove,
  runSetup,
  runUnregister,
  type SetupIO,
} from './setup.ts';
import { columns } from './terminal.ts';

// The `config` command (issue #46): an interactive menu over the config file, the OS keychain (only
// through setup's own steps) and the installed MCP clients. Every change is written at once, whole
// or not at all, after the question that leads to it is answered, so leaving it (Esc, q, Ctrl+C)
// never leaves a half-written change.

type Params = Record<string, string>;

/** One entry of a menu: its label, and what it does, resolving to whether that went well. */
interface Action {
  label: string;
  run: () => Promise<boolean> | boolean;
}

/** A menu: its title with `params`, its actions, and the label of its last item, which leaves it. */
interface Menu {
  title: MessageKey;
  params: Params;
  actions: Action[];
  leave: MessageKey;
}

/** The message of a failed write, never anything else the error carries. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `path` as the overview shows it: the home directory as `~`, nothing cut. */
function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The `config` menu in `locale`, talking through `io`. */
function menu(locale: Locale, io: SetupIO) {
  const text = (key: MessageKey, params?: Params) => t(locale, key, params);
  const say = (key: MessageKey, params?: Params) => {
    io.print(text(key, params));
  };

  /** The config of the config file, or undefined when it is invalid, reported on `io.fail`. */
  function load(): Config | undefined {
    const loaded = loadConfig();
    if (loaded.ok) return loaded.config;
    io.fail(text('setup.invalidConfig', { message: loaded.error.message }));
    return undefined;
  }

  /**
   * Writes a change to the config file with `write`, then reports `done` as a success and says that
   * the MCP clients need a restart. A failed write is reported and leaves the file as it was.
   */
  function change(write: () => void, done: MessageKey, params: Params = {}): boolean {
    try {
      write();
    } catch (error) {
      io.fail(text('config.writeFailed', { file: configFile(), reason: reasonOf(error) }));
      return false;
    }
    io.success(text(done, params));
    say('config.restart');
    return true;
  }

  /** The rows of the client entries that start `profile`, one per installed client: name, entries. */
  function clientRows(profile: string): string[][] {
    return installedClients().map((installed) => {
      const { name } = installed.client;
      let servers;
      try {
        servers = readServers(installed).servers;
      } catch (error) {
        const params = { file: displayPath(installed.file), reason: reasonOf(error) };
        return [name, text('config.clientUnreadable', params)];
      }
      const entries = profileEntries(servers, profile).map((entry) =>
        text('config.entry', {
          entry: entry.name,
          kind: text(entry.kind === 'npx' ? 'config.kindNpx' : 'config.kindLocal'),
        }),
      );
      return [name, entries.length === 0 ? text('config.noEntry') : entries.join(', ')];
    });
  }

  /**
   * A profile in the overview: after an empty line, its name, company and read-only state as the
   * heading, then its download directory and its entries in the installed MCP clients in columns.
   */
  function profileBlock({ name, company, readonly, downloadDir }: ProfileSettings): void {
    io.print('');
    const access = text(readonly ? 'setup.accessReadonly' : 'setup.accessReadWrite');
    for (const line of columns([[name, company, access]])) io.heading(line);
    const downloads =
      downloadDir === undefined
        ? text('config.downloadsDefault', { dir: displayPath(defaultDownloadDir(name)) })
        : displayPath(downloadDir);
    const rows = [[text('config.downloadsLabel'), downloads], ...clientRows(name)];
    for (const line of columns(rows)) io.print(`  ${line}`);
  }

  /**
   * The overview: after an empty line, the config file and the audit log in columns, then every
   * profile with company, read-only state, download directory and its entries in the installed MCP
   * clients. It reads the config file and the client configs, never the OS keychain.
   */
  function overview(config: Config): void {
    io.print('');
    const state = text(config.audit ? 'config.on' : 'config.off');
    const settings = columns([
      [text('config.fileLabel'), displayPath(configFile())],
      [
        text('config.auditLabel'),
        text('config.auditState', { state, dir: displayPath(auditDir()) }),
      ],
    ]);
    for (const line of settings) io.print(line);
    if (config.profiles.length === 0) say('config.noProfiles');
    if (installedClients().length === 0) say('config.noClients');
    for (const profile of config.profiles) profileBlock(profile);
  }

  // Set once a menu is cancelled (Ctrl+C, end of input): every menu then leaves at once.
  let cancelled = false;

  /**
   * Shows `menu.actions` under its title, its `leave` item last and the key hint below, and runs the
   * action picked. Resolves to `leave` when the user picks that, goes back or cancels, else to the
   * action's outcome.
   */
  async function pick({ title, params, actions, leave }: Menu): Promise<boolean | 'leave'> {
    const choice = await io.prompter.choose(
      text(title, params),
      [...actions.map(({ label }) => label), text(leave)],
      { hint: text('config.keys') },
    );
    if (choice === undefined) cancelled = true;
    const action = typeof choice === 'number' ? actions[choice] : undefined;
    return action === undefined ? 'leave' : await action.run();
  }

  /**
   * Shows the menu `next` makes from the config file, again after each action, until the user
   * leaves or cancels or `next` has none. Resolves to whether every action went well and the config
   * file stayed valid.
   */
  async function loop(next: (config: Config) => Menu | undefined): Promise<boolean> {
    let ok = true;
    while (!cancelled) {
      const config = load();
      if (config === undefined) return false;
      const menu = next(config);
      if (menu === undefined) break;
      const outcome = await pick(menu);
      if (outcome === 'leave') break;
      ok = outcome && ok;
    }
    return ok;
  }

  /** Asks for the download directory of `profile` and stores it; it must be an absolute path. */
  async function askDownloadDir({ name, downloadDir }: ProfileSettings): Promise<boolean> {
    const current = downloadDir ?? defaultDownloadDir(name);
    const answer = await io.prompter.ask(text('config.askDownloadDir', { current }));
    if (answer === undefined) {
      io.fail(text('config.cancelled'));
      return false;
    }
    const dir = answer.trim();
    if (dir === '') {
      say('config.unchanged');
      return true;
    }
    if (!isAbsolute(dir)) {
      io.fail(text('config.notAbsolute', { dir }));
      return false;
    }
    return change(
      () => {
        setProfileKey(name, 'downloadDir', dir);
      },
      'config.downloadDirSet',
      {
        profile: name,
        dir,
      },
    );
  }

  /** The actions on `profile`; each resolves to whether it went well. */
  function profileActions(profile: ProfileSettings): Action[] {
    const { name, readonly, downloadDir } = profile;
    const params = { profile: name };
    const actions: Action[] = [
      {
        label: text(readonly ? 'config.makeReadWrite' : 'config.makeReadonly'),
        run: () =>
          change(
            () => {
              setProfileKey(name, 'readonly', !readonly);
            },
            readonly ? 'config.nowReadWrite' : 'config.nowReadonly',
            params,
          ),
      },
      { label: text('config.setDownloadDir'), run: () => askDownloadDir(profile) },
    ];
    if (downloadDir !== undefined) {
      actions.push({
        label: text('config.resetDownloadDir'),
        run: () =>
          change(
            () => {
              setProfileKey(name, 'downloadDir', undefined);
            },
            'config.downloadDirReset',
            {
              ...params,
              dir: defaultDownloadDir(name),
            },
          ),
      });
    }
    actions.push(
      { label: text('config.register'), run: () => runRegister(locale, io, name) },
      { label: text('config.unregister'), run: () => runUnregister(locale, io, name) },
      { label: text('config.check'), run: () => runCheck(locale, io, name) },
      { label: text('config.remove'), run: () => runRemove(locale, io, name) },
    );
    return actions;
  }

  /** The menu of the profile `name`, until the user goes back or the profile is gone. */
  function profileMenu(name: string): Promise<boolean> {
    return loop((config) => {
      const profile = config.profiles.find((entry) => entry.name === name);
      if (profile === undefined) return undefined;
      const params = { profile: name, company: profile.company };
      return {
        title: 'config.profileTitle',
        params,
        actions: profileActions(profile),
        leave: 'config.back',
      };
    });
  }

  /** The main menu's actions: one per profile, add a profile, the audit log switch. */
  function mainActions(config: Config): Action[] {
    return [
      ...config.profiles.map(({ name, company }) => ({
        label: text('config.profileItem', { profile: name, company }),
        run: () => profileMenu(name),
      })),
      { label: text('config.add'), run: () => runSetup(locale, io) },
      {
        label: text(config.audit ? 'config.auditTurnOff' : 'config.auditTurnOn'),
        run: () =>
          change(
            () => {
              setAudit(!config.audit);
            },
            config.audit ? 'config.auditNowOff' : 'config.auditNowOn',
          ),
      },
    ];
  }

  return {
    /**
     * Shows the heading once the config file proves valid, then the overview and the main menu until
     * the user leaves. Resolves to whether every action went well and the config file stayed valid.
     */
    run: () => {
      let headed = false;
      return loop((config) => {
        if (!headed) io.heading(text('config.header'));
        headed = true;
        overview(config);
        return {
          title: 'config.mainTitle',
          params: {},
          actions: mainActions(config),
          leave: 'config.quit',
        };
      });
    },
  };
}

/**
 * Runs `config` in `locale` through `io` (issue #46): an overview of the profiles and the installed
 * MCP clients, and a menu to toggle a profile's read-only flag, set or reset its download directory,
 * register or unregister it in the clients, check its connection, remove it, add a profile (the
 * `setup` dialogue) and toggle the audit log. Resolves to true when the user leaves and every action
 * went well; otherwise it has reported why on `io.fail`.
 */
export function runConfig(locale: Locale, io: SetupIO): Promise<boolean> {
  return menu(locale, io).run();
}

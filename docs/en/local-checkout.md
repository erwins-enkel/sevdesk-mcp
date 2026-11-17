# Beta testing from a local checkout

[Deutsch](../de/beta-test.md) · **English** · [Overview](../../README.md#english)

Until the package is on npm, its `npx` entry cannot start. To try the whole flow in real clients
before that, run `setup` from a local checkout: `setup` counts as installed when it runs from a
folder under `node_modules` (as with `npx` or a global install), and as a local checkout otherwise.
You need [Bun](https://bun.sh) ≥ 1.4.4 and Node.js ≥ 22.

1. Clone the repository into a folder that stays where it is, not a temporary worktree, and build
   it: `git clone https://github.com/erwins-enkel/sevdesk-mcp.git`, then
   `bun install && bun run build` in it. The client entries point into this folder.
2. Run `node dist/cli.js setup` there. It says that it runs from the local checkout, and every
   client entry it writes starts the checkout's build: the absolute path of the Node.js you ran it
   with (GUI clients often lack your `PATH`), the checkout's `dist/cli.js`, `--profile <name>`
   and `--reload`, for example
   `"command": "/usr/local/bin/node", "args": ["/home/you/sevdesk-mcp/dist/cli.js", "--profile", "acme", "--reload"]`.
   An entry written before `--reload` existed is offered for replacement when you run `setup` again.
   Everything else is as described under [MCP clients](setup.md#mcp-clients): the same entry
   names, a backup first, a question per client, nothing replaced without an explicit yes.
3. After every `git pull`, run `bun install && bun run build` again; the entries stay as they are.
   With `--reload` the client needs no restart: before each call the server checks whether the
   build (`dist/`) or the spec (`spec/`) changed, and once no call is in flight it starts the real
   server anew with the new build, behind the same connection. A server that ends (a crash, a broken
   build) answers its open calls with an error and starts again on the next call. A client restart
   is still needed for changes the client fetched once at connect (tool names, input schemas,
   descriptions, the instructions), for changes to the reload itself (`src/reload.ts`, `src/cli.ts`)
   and for config-file changes. A restart drops the confirmation tokens of held calls; ask for the
   preview again. If you move the checkout or remove that Node.js (for example with a
   version manager), run `setup` again and replace the entries. `setup --remove <name>` run from
   the checkout also offers to remove its entries.
4. Or ask the client for the sevdesk MCP's version. A server started from a local checkout has a
   third tool, `version` (the installed package keeps its two): it reports the package version,
   the checkout's branch and commit and, after a `git fetch` of the branch's upstream, the commits
   waiting there. When some are, the model asks you, and after your yes the server fast-forwards
   the checkout to exactly the commit it offered, runs `bun install --frozen-lockfile` when
   `package.json` or `bun.lock` changed, and runs `bun run build`; with `--reload` the next call
   runs the new build. It changes nothing when tracked files have uncommitted changes, the branch
   has commits of its own or no upstream, or bun is found neither on the client's `PATH` nor in
   `~/.bun/bin`. If the install or the build fails after the fast-forward, it says so and nothing
   is rolled back: run `bun install && bun run build` in the checkout. A client fetches the tool
   list once, so after the build that first brings `version`, restart the client once.
   `sevdesk-mcp config` shows the same state and offers the same update in the terminal
   ([`config`](setup.md#changing-profiles-and-settings-config)).
5. Once the package is published, switch with `npx @erwins-enkel/sevdesk-mcp setup` and the same
   profile name: replace the profile (it asks for the token again), then answer yes when it asks to
   replace each client's entry with the `npx` one.

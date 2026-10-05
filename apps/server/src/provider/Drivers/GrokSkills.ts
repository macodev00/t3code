/**
 * GrokSkills — skill discovery for the `$` picker via `grok inspect --json`.
 *
 * Unlike Claude Code, the Grok CLI reports its full skill catalog itself:
 * `grok inspect --json` returns `skills[]` with `name`, `description`,
 * `source.type` (`user` / `project` / `bundled` / `plugin`), `source.path`
 * (the absolute `SKILL.md` path), and `userInvocable`. Asking the CLI beats
 * scanning the filesystem because the catalog honors Grok's own skill config
 * (ignore lists, disabled skills) and includes plugin skills, which live
 * three levels deep under `~/.grok/installed-plugins/` where a flat scan
 * cannot see them. This mirrors how the Codex app-server reports skills over
 * `skills/list`. Probe failures stay typed so workspace snapshots do not
 * cache an empty catalog; machine-level discovery recovers them to an empty
 * list without degrading the provider.
 *
 * The composer inserts `$name` for every provider. `rewriteGrokSkillPrompt`
 * lowers an advertised mention to the leading `/name` form this CLI expands.
 *
 * @module provider/Drivers/GrokSkills
 */
import type { GrokSettings, ServerProviderSkill } from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 4_000;

class GrokSkillsProbeError extends Schema.TaggedError<GrokSkillsProbeError>()(
  "GrokSkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`grok inspect --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

/**
 * Map `grok inspect --json` output onto provider skills. Entries without a
 * name or a filesystem path are skipped; `userInvocable: false` skills are
 * kept but disabled so pickers that filter on `enabled` hide them.
 */
function decodeGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) {
    return undefined;
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const source =
      typeof record.source === "object" && record.source !== null
        ? (record.source as Record<string, unknown>)
        : undefined;
    const path = typeof source?.path === "string" ? source.path.trim() : "";
    if (!name || !path) {
      continue;
    }
    const scope = typeof source?.type === "string" ? source.type.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: record.userInvocable !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Run `grok inspect --json` and return its stdout. Probe failures stay typed
 * so callers can retry instead of treating a crash as an empty skill catalog.
 */
const runGrokInspect = Effect.fn("runGrokInspect")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const command = grokSettings.binaryPath || "grok";
  const inspectResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new GrokSkillsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(GROK_SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(inspectResult)) {
    return yield* new GrokSkillsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const output = inspectResult.value;
  if (output.code !== 0) {
    return yield* new GrokSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  }
  return output.stdout;
});

/**
 * Run `grok inspect --json` and map the reported catalog onto provider
 * skills. Callers that need best-effort discovery can recover this effect to
 * an empty list; workspace callers leave failures typed so they are not cached.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const stdout = yield* runGrokInspect(grokSettings, environment, cwd);
  const skills = decodeGrokInspectSkills(stdout);
  if (!skills) {
    return yield* new GrokSkillsProbeError({
      stage: "decode",
      ...(cwd ? { cwd } : {}),
    });
  }
  return skills;
});

/**
 * Slash command for one inspect entry, or `undefined` when Grok does not
 * advertise it. A colliding bare name uses `invocableAs`. A collision with no
 * qualified form is not invocable and must not be rewritten onto the built-in.
 */
function grokInspectSkillCommand(record: Record<string, unknown>):
  | {
      readonly mention: string;
      readonly command: string;
    }
  | undefined {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || record.userInvocable === false || record.disabled === true) return undefined;
  const invocableAs = typeof record.invocableAs === "string" ? record.invocableAs.trim() : "";
  const collidesWith = typeof record.collidesWith === "string" ? record.collidesWith.trim() : "";
  const command = (invocableAs || (collidesWith ? "" : name)).replace(/^\//, "");
  if (!command) return undefined;
  return { mention: name, command };
}

/**
 * Map `grok inspect --json` onto composer mention names and the slash token
 * Grok actually expands. `undefined` means the payload was not a skill catalog.
 * An ambiguous bare name is omitted; each qualified `invocableAs` stays.
 */
function decodeGrokSkillCommands(stdout: string): ReadonlyMap<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) return undefined;

  const commandsForMention = new Map<string, Set<string>>();
  const commands = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const skill = grokInspectSkillCommand(entry as Record<string, unknown>);
    if (!skill) continue;
    const existing = commandsForMention.get(skill.mention) ?? new Set<string>();
    existing.add(skill.command);
    commandsForMention.set(skill.mention, existing);
    commands.set(skill.command, skill.command);
  }
  for (const [mention, invocation] of commandsForMention) {
    const [command] = invocation;
    if (invocation.size === 1 && command !== undefined) {
      commands.set(mention, command);
    } else {
      commands.delete(mention);
    }
  }
  return commands;
}

/**
 * Advertised Grok slash commands, keyed by the composer mention (`$name`) and
 * by the invocation itself. Reads the same `grok inspect --json` catalog as
 * skill discovery, including `invocableAs` when a bare name collides.
 */
export const discoverGrokSkillCommands = Effect.fn("discoverGrokSkillCommands")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const stdout = yield* runGrokInspect(grokSettings, environment, cwd);
  const commands = decodeGrokSkillCommands(stdout);
  if (!commands) {
    return yield* new GrokSkillsProbeError({
      stage: "decode",
      ...(cwd ? { cwd } : {}),
    });
  }
  return commands;
});

/**
 * Whether `prompt` contains a composer skill token (`$name`, `€name`, …).
 * Used to skip `grok inspect` when there is nothing to rewrite.
 */
function hasGrokSkillMention(prompt: string): boolean {
  return new RegExp(SKILL_MENTION_PATTERN.source, "u").test(prompt);
}

interface GrokSkillMention {
  readonly command: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Advertised composer skill tokens in `prompt`, in order. The captured name
 * must be a key of `commands`; currency amounts and unknown `$names` are not
 * mentions.
 */
function collectGrokSkillMentions(
  prompt: string,
  commands: ReadonlyMap<string, string>,
): ReadonlyArray<GrokSkillMention> {
  const mentions: GrokSkillMention[] = [];
  for (const match of prompt.matchAll(new RegExp(SKILL_MENTION_PATTERN.source, "gu"))) {
    const name = match[2] ?? "";
    const command = commands.get(name);
    if (command === undefined || match.index === undefined) continue;
    const delimiterLength = match[1]?.length ?? 0;
    mentions.push({
      command,
      start: match.index + delimiterLength,
      end: match.index + match[0].length,
    });
  }
  return mentions;
}

/**
 * Replace each mention's sigil and name with `/command`, from the end so
 * earlier indexes stay valid when a qualified name changes the length.
 */
function replaceGrokSkillMentions(
  prompt: string,
  mentions: ReadonlyArray<GrokSkillMention>,
): string {
  let text = prompt;
  for (let index = mentions.length - 1; index >= 0; index -= 1) {
    const mention = mentions[index];
    if (mention === undefined) continue;
    text = `${text.slice(0, mention.start)}/${mention.command}${text.slice(mention.end)}`;
  }
  return text;
}

/**
 * Move the first mention to the front of the prompt and rewrite the rest in
 * place. Grok ignores a `/name` that is not in a block starting with `/`.
 */
function hoistFirstGrokSkillMention(
  prompt: string,
  mentions: ReadonlyArray<GrokSkillMention>,
): string {
  const first = mentions[0];
  if (first === undefined) return prompt;
  const removed = first.end - first.start;
  const later = mentions.slice(1).map((mention) => ({
    command: mention.command,
    start: mention.start - removed,
    end: mention.end - removed,
  }));
  const rewritten = replaceGrokSkillMentions(
    `${prompt.slice(0, first.start)}${prompt.slice(first.end)}`,
    later,
  );
  const left = rewritten.slice(0, first.start).trimEnd();
  const right = rewritten.slice(first.start).trimStart();
  const remainder = left.length === 0 ? right : right.length === 0 ? left : `${left} ${right}`;
  return remainder.length === 0 ? `/${first.command}` : `/${first.command} ${remainder}`;
}

/**
 * Lower advertised composer `$skill` mentions to the slash form the Grok CLI
 * expands.
 *
 * The CLI loads skills only when the first text block starts with `/` after
 * trim. A later `/name` in that same block is included once that leading
 * slash is present, and only when `name` is advertised. A mention that
 * already opens the prompt (or a prompt the user already started with `/`)
 * is rewritten in place. A mid-message mention is moved to the front so the
 * skill actually runs; words that were around it stay in the prompt.
 */
export function rewriteGrokSkillPrompt(
  prompt: string,
  commands: ReadonlyMap<string, string>,
): string {
  const mentions = collectGrokSkillMentions(prompt, commands);
  const first = mentions[0];
  if (first === undefined) return prompt;
  const opensPrompt = prompt.slice(0, first.start).trim().length === 0;
  if (prompt.trimStart().startsWith("/") || opensPrompt) {
    return replaceGrokSkillMentions(prompt, mentions);
  }
  return hoistFirstGrokSkillMention(prompt, mentions);
}

/**
 * Lower `$skill` mentions in one Grok turn. The catalog is cached per working
 * directory for the life of `cache`; a failed probe is not cached, so a later
 * turn can retry. Text is unchanged when it has no skill token or the catalog
 * cannot be read.
 */
export const prepareGrokSkillPrompt = Effect.fn("prepareGrokSkillPrompt")(function* (input: {
  readonly text: string;
  readonly cwd: string | null;
  readonly grokSettings: Pick<GrokSettings, "binaryPath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly cache: Map<string, ReadonlyMap<string, string>>;
}) {
  if (!hasGrokSkillMention(input.text)) return input.text;
  const cacheKey = input.cwd ?? "";
  let commands = input.cache.get(cacheKey);
  if (commands === undefined) {
    const discovered = yield* discoverGrokSkillCommands(
      input.grokSettings,
      input.environment,
      input.cwd ?? undefined,
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("Grok skill command discovery failed.", { cause }),
      ),
      Effect.option,
    );
    if (Option.isNone(discovered)) return input.text;
    commands = discovered.value;
    input.cache.set(cacheKey, commands);
  }
  return rewriteGrokSkillPrompt(input.text, commands);
});

import { assert, describe, it } from "@effect/vitest";
import { t3AcpPromptWithInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";

import { grokLeadingSkillPrompt, grokSkillNamesFromAvailableCommands } from "./adapter.ts";

const grokLeadingSkillInstructionState = {
  interactionMode: "default",
  hasT3Mcp: false,
} as const;

const advertisedGrokSkills = new Set(["poteto-mode", "review"]);

/**
 * A leading advertised `$name`, including one closed by a newline, becomes
 * `/name`. Only that opening token is rewritten.
 */
function rewritesLeadingComposerSkillToken() {
  assert.equal(
    grokLeadingSkillPrompt("$poteto-mode reply with hi", advertisedGrokSkills),
    "/poteto-mode reply with hi",
  );
  assert.equal(grokLeadingSkillPrompt("$poteto-mode ", advertisedGrokSkills), "/poteto-mode ");
  assert.equal(grokLeadingSkillPrompt("  $poteto-mode", advertisedGrokSkills), "  /poteto-mode");
  assert.equal(
    grokLeadingSkillPrompt("$review\nfocus on auth", advertisedGrokSkills),
    "/review\nfocus on auth",
  );
  assert.equal(
    grokLeadingSkillPrompt("$poteto-mode $poteto-mode again", advertisedGrokSkills),
    "/poteto-mode $poteto-mode again",
  );
}

/**
 * A mention after other text, a currency amount, and an existing slash command
 * stay literal.
 */
function leavesNonLeadingMentionLiteral() {
  assert.equal(
    grokLeadingSkillPrompt("please $poteto-mode", advertisedGrokSkills),
    "please $poteto-mode",
  );
  assert.equal(
    grokLeadingSkillPrompt("$20 and $1e6 stay", advertisedGrokSkills),
    "$20 and $1e6 stay",
  );
  assert.equal(grokLeadingSkillPrompt("5$poteto-mode", advertisedGrokSkills), "5$poteto-mode");
  assert.equal(
    grokLeadingSkillPrompt("/poteto-mode already", advertisedGrokSkills),
    "/poteto-mode already",
  );
  assert.equal(grokLeadingSkillPrompt("", advertisedGrokSkills), "");
}

/**
 * `$compact` and `$HOME` are not skills. They stay literal even when a real
 * skill in the same catalog is rewritten, and even when `compact` was
 * advertised as a built-in slash command.
 */
function leavesUnadvertisedLeadingTokenLiteral() {
  const commands = [
    { name: "compact", description: "Compress conversation history" },
    {
      name: "review",
      description: "Review the branch",
      _meta: {
        scope: "bundled",
        path: "/home/grok/.grok/bundled/skills/review/SKILL.md",
        bareName: "review",
      },
    },
    {
      name: "bundled:imagine",
      description: "Imagine",
      _meta: {
        scope: "bundled",
        path: "/home/grok/.grok/bundled/skills/imagine/SKILL.md",
        bareName: "imagine",
      },
    },
    {
      name: "deep-research",
      description: "Research",
      _meta: { workflowSource: "builtin", workflowPath: "/workflows/deep-research.rhai" },
    },
  ] as const;
  const skills = grokSkillNamesFromAvailableCommands(commands);
  assert.deepEqual([...skills].sort(), ["bundled:imagine", "imagine", "review"]);
  assert.equal(grokLeadingSkillPrompt("$compact now", skills), "$compact now");
  assert.equal(grokLeadingSkillPrompt("$HOME stays", skills), "$HOME stays");
  assert.equal(grokLeadingSkillPrompt("$HOME", skills), "$HOME");
  assert.equal(
    grokLeadingSkillPrompt("$deep-research the logs", skills),
    "$deep-research the logs",
  );
  assert.equal(grokLeadingSkillPrompt("$review the diff", skills), "/review the diff");
  assert.equal(grokLeadingSkillPrompt("$imagine a logo", skills), "/imagine a logo");
  assert.equal(grokLeadingSkillPrompt("$compact now", new Set<string>()), "$compact now");
}

/**
 * A rewritten leading skill stays at the start of the prompt, ahead of the ACP
 * instruction wrapper.
 */
function keepsRewrittenSkillAheadOfAcpInstructions() {
  assert.equal(
    t3AcpPromptWithInstructions({
      prompt: grokLeadingSkillPrompt("$poteto-mode reply with hi", advertisedGrokSkills),
      state: grokLeadingSkillInstructionState,
    }),
    "/poteto-mode reply with hi",
  );
  const buried = t3AcpPromptWithInstructions({
    prompt: grokLeadingSkillPrompt("please $poteto-mode", advertisedGrokSkills),
    state: grokLeadingSkillInstructionState,
  });
  assert.include(buried, "<user_request>\nplease $poteto-mode\n</user_request>");
}

/**
 * An advertised skill that opens the prompt becomes the slash command Grok
 * expands. Unadvertised tokens, later mentions, currency, and an existing
 * slash command stay literal.
 */
function registerGrokLeadingSkillPromptTests() {
  it(
    "rewrites a leading advertised skill token into Grok's slash command",
    rewritesLeadingComposerSkillToken,
  );
  it(
    "leaves a non-leading mention, currency, and an existing slash command literal",
    leavesNonLeadingMentionLiteral,
  );
  it(
    "leaves $compact and $HOME literal unless they are advertised skills",
    leavesUnadvertisedLeadingTokenLiteral,
  );
  it(
    "keeps a rewritten skill at the start so ACP instructions do not bury it",
    keepsRewrittenSkillAheadOfAcpInstructions,
  );
}

describe("grokLeadingSkillPrompt", registerGrokLeadingSkillPromptTests);

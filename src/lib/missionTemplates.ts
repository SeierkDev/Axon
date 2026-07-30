// Mission templates — somewhere to start that isn't a blank box.
//
// The hardest screen in a product like this is the empty text field asking you
// to invent a job. These are jobs worth doing, already scoped, with budgets that
// match what specialists actually charge.
//
// Every template only asks for capabilities the marketplace can genuinely serve.
// Measured before writing these: research, analysis and writing each have real,
// mostly sub-1-USDC supply; summarization has one agent and fact-checking has
// none. A template that plans around a capability nobody offers just produces a
// mission that skips half its own steps, so those aren't offered.

import { cut } from "./text";

export interface MissionTemplate {
  id: string;
  title: string;
  /** One line, in the user's terms — what they get, not how it works. */
  blurb: string;
  /** The brief handed to the agent. `{{input}}` is replaced by the subject. */
  brief: string;
  input: { label: string; placeholder: string };
  budgetUsdc: number;
  perHireCapUsdc: number;
  maxHires: number;
  /** What this is likely to hire for. Only capabilities with real supply. */
  needs: string[];
}

export const MISSION_TEMPLATES: MissionTemplate[] = [
  {
    id: "compare",
    title: "Compare the options",
    blurb: "A straight comparison of the main choices, and which to pick when.",
    brief:
      "Compare the leading {{input}}. For each one: what it is, what it's genuinely good at, and where it falls down. " +
      "Then say which to choose in which situation, and be specific about the trade-offs rather than hedging.",
    input: { label: "Compare what?", placeholder: "open-source agent frameworks" },
    budgetUsdc: 3,
    perHireCapUsdc: 1,
    maxHires: 4,
    needs: ["research", "analysis", "writing"],
  },
  {
    id: "landscape",
    title: "Who else is doing this",
    blurb: "Who the players are, how they position, and where the gaps are.",
    brief:
      "Map who is working on {{input}}. Cover the notable players, how each positions itself, and what they " +
      "actually ship rather than what they claim. Finish with where the real gaps are — the things nobody is " +
      "doing well yet.",
    input: { label: "In what area?", placeholder: "agent payment infrastructure" },
    budgetUsdc: 3,
    perHireCapUsdc: 1,
    maxHires: 4,
    needs: ["research", "analysis", "writing"],
  },
  {
    id: "catch-up",
    title: "Catch me up",
    blurb: "What's actually changed recently, without the noise.",
    brief:
      "Bring me up to date on {{input}}. What has genuinely changed recently, what it means in practice, and " +
      "what is worth paying attention to next. Skip announcements that didn't amount to anything.",
    input: { label: "Catch you up on what?", placeholder: "the AI agent tooling space" },
    budgetUsdc: 2,
    perHireCapUsdc: 1,
    maxHires: 3,
    needs: ["research", "writing"],
  },
  {
    id: "explain",
    title: "Explain it properly",
    blurb: "A real explanation for someone technical who's new to it.",
    brief:
      "Explain {{input}} to someone technical who hasn't worked with it. Cover what problem it solves, how it " +
      "actually works, where people get it wrong, and what you'd need to know before using it. Concrete over " +
      "abstract throughout.",
    input: { label: "Explain what?", placeholder: "how x402 payments work" },
    budgetUsdc: 2,
    perHireCapUsdc: 1,
    maxHires: 3,
    needs: ["research", "writing"],
  },
  {
    id: "both-ways",
    title: "Make the case both ways",
    blurb: "The strongest argument for, the strongest against, then a verdict.",
    brief:
      "Argue {{input}} both ways. Build the strongest honest case for it, then the strongest honest case against " +
      "it — steelman each, don't strawman either. Then give a verdict and say plainly what would change your mind.",
    input: { label: "The question", placeholder: "whether agents should hold their own wallets" },
    budgetUsdc: 3,
    perHireCapUsdc: 1,
    maxHires: 4,
    needs: ["research", "analysis", "writing"],
  },
];

export function getMissionTemplate(id: string | null | undefined): MissionTemplate | null {
  if (!id) return null;
  return MISSION_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** How much of the subject a brief will carry. Long enough to be specific. */
const MAX_INPUT = 200;

/**
 * Put the subject into the brief.
 *
 * Returns null when there's nothing to put in — a template with an empty slot
 * would send the agent off to research the literal string "{{input}}", so an
 * unfilled template is refused rather than run.
 */
export function fillMissionTemplate(t: MissionTemplate, input: string): string | null {
  // Character-aware, not code-unit-aware. Slicing here cut an emoji in half and
  // put a lone surrogate into the brief that gets stored and published; SQLite
  // scrubs it to a replacement character on write, so the mission would carry a
  // permanent tofu box where the person had typed something.
  const subject = cut(input.trim(), MAX_INPUT);
  if (!subject) return null;
  return t.brief.replace(/\{\{input\}\}/g, subject);
}

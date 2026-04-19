/**
 * Sprint orchestration: CardState, SprintPlan, wave helpers, board renderer.
 */

export interface CardState {
  id: number;
  title: string;
  slug: string;
  wave: number;
  acceptanceCriteria: string[];
  status: string;
  prNumber: number | null;
  reviewScore: number | null;
  testScore: number | null;
  reviewRound: number;
}

export function createCard(
  id: number,
  title: string,
  slug: string,
  wave: number,
  acceptanceCriteria: string[] = [],
): CardState {
  return {
    id,
    title,
    slug,
    wave,
    acceptanceCriteria,
    status: "todo",
    prNumber: null,
    reviewScore: null,
    testScore: null,
    reviewRound: 0,
  };
}

export function cardBranch(card: CardState): string {
  return `card-${card.id}-${card.slug}`;
}

export function cardAgentName(card: CardState): string {
  return `executor-${card.slug}`;
}

export function isCardTerminal(card: CardState): boolean {
  return card.status === "merged" || card.status === "skipped" || card.status === "blocked";
}

export interface SprintPlan {
  name: string;
  cards: CardState[];
}

export function getWave(plan: SprintPlan, waveNum: number): CardState[] {
  return plan.cards.filter((c) => c.wave === waveNum);
}

export function waveComplete(plan: SprintPlan, waveNum: number): boolean {
  const waveCards = getWave(plan, waveNum);
  return waveCards.length === 0 || waveCards.every(isCardTerminal);
}

export function allWaves(plan: SprintPlan): number[] {
  return [...new Set(plan.cards.map((c) => c.wave))].sort((a, b) => a - b);
}

export function computeWaves(cards: CardState[]): Record<number, number[]> {
  const waves: Record<number, number[]> = {};
  for (const card of cards) {
    if (!waves[card.wave]) waves[card.wave] = [];
    waves[card.wave].push(card.id);
  }
  return waves;
}

const STATUS_ICONS: Record<string, string> = {
  todo: "\u2B1C",
  executing: "\uD83D\uDFE1",
  reviewing: "\uD83D\uDD35",
  testing: "\uD83D\uDFE3",
  merged: "\uD83D\uDFE2",
  blocked: "\uD83D\uDD34",
  skipped: "\u26AA",
};

export function renderSprintBoard(plan: SprintPlan | null): string {
  if (!plan || plan.cards.length === 0) return "No cards in sprint.";

  const lines = [
    "| Status | Title | Wave | Branch | Status | PR # | Review | Test |",
    "|--------|-------|------|--------|--------|------|--------|------|",
  ];

  for (const card of plan.cards) {
    const icon = STATUS_ICONS[card.status] ?? "\u2753";
    const pr = card.prNumber != null ? String(card.prNumber) : "-";
    const review = card.reviewScore != null ? String(card.reviewScore) : "-";
    const test = card.testScore != null ? String(card.testScore) : "-";
    lines.push(
      `| ${icon} | ${card.title} | ${card.wave} | ${cardBranch(card)} | ${card.status} | ${pr} | ${review} | ${test} |`,
    );
  }

  return lines.join("\n");
}

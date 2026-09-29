import type { GitHubActor } from "./types.js";

/**
 * GitHub's stand-in for a deleted account (`https://github.com/ghost`, id 10137).
 * A null author payload is this user, not a contract break. Decisions Q64.
 */
export const GHOST_ACTOR: GitHubActor = Object.freeze({
  githubId: 10137,
  login: "ghost",
  isBot: false,
});

export type RawGitHubUser = {
  id?: number;
  login?: string;
  type?: string;
};

/**
 * Map a pull, review, or comment author.
 * A missing payload is the ghost user so one deleted account cannot fail the sync.
 * A present id and login are stored as sent, including a bot.
 */
export function toActorOrGhost(user: RawGitHubUser | null | undefined): GitHubActor {
  if (!user || typeof user.id !== "number" || !user.login) return GHOST_ACTOR;
  return {
    githubId: user.id,
    login: user.login,
    isBot: user.type === "Bot" || user.login.endsWith("[bot]"),
  };
}

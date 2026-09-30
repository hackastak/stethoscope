import type { RepoSummary } from "../api/client.js";

export type RepoPickerProps = {
  repos: RepoSummary[];
  status: "pending" | "error" | "success";
  errorMessage?: string;
  slug: string;
  onSlugChange: (slug: string) => void;
  disabled?: boolean;
  /** Marks the owner/repo input invalid and points it at the error message. */
  slugInvalid?: boolean;
  slugDescribedById?: string;
};

export function RepoPicker({
  repos,
  status,
  errorMessage,
  slug,
  onSlugChange,
  disabled = false,
  slugInvalid = false,
  slugDescribedById,
}: RepoPickerProps) {
  const selected = repos.some((repo) => repo.fullName === slug) ? slug : "";
  const reposError =
    errorMessage && errorMessage.length > 0
      ? `Couldn't load your repos: ${errorMessage}. Enter a public owner/repo below.`
      : "Couldn't load your repos. Enter a public owner/repo below.";

  return (
    <fieldset disabled={disabled}>
      <legend>Repository</legend>
      {status === "error" ? (
        <p role="alert">{reposError}</p>
      ) : (
        <label htmlFor="repo-select">
          Your repos
          <select
            id="repo-select"
            value={selected}
            disabled={status === "pending"}
            aria-busy={status === "pending"}
            onChange={(event) => {
              const next = event.target.value;
              if (next !== "") onSlugChange(next);
            }}
          >
            <option value="">
              {status === "pending" ? "Loading your repos…" : "Not in this list"}
            </option>
            {repos.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </label>
      )}
      <label htmlFor="owner-repo">
        owner/repo
        <input
          id="owner-repo"
          value={slug}
          placeholder="owner/repo"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={slugInvalid}
          aria-describedby={slugInvalid ? slugDescribedById : undefined}
          onChange={(event) => onSlugChange(event.target.value)}
        />
      </label>
    </fieldset>
  );
}

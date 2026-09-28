import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RepoSummary } from "../../src/api/client.js";
import { RepoPicker } from "../../src/components/RepoPicker.js";

const REPOS: RepoSummary[] = [
  {
    owner: "ada",
    name: "scope",
    fullName: "ada/scope",
    visibility: "public",
    defaultBranch: "main",
    pushedAt: 20,
  },
  {
    owner: "ada",
    name: "older",
    fullName: "ada/older",
    visibility: "private",
    defaultBranch: "main",
    pushedAt: 10,
  },
];

describe("RepoPicker", () => {
  it("lists repos in API order and fills owner/repo when one is selected", async () => {
    const user = userEvent.setup();
    const onSlugChange = vi.fn();
    render(<RepoPicker repos={REPOS} status="success" slug="" onSlugChange={onSlugChange} />);

    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Not in this list", "ada/scope", "ada/older"]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Your repos" }), "ada/scope");
    expect(onSlugChange).toHaveBeenCalledWith("ada/scope");
  });

  it("keeps a typed public slug that is not in the dropdown", async () => {
    const user = userEvent.setup();
    const onSlugChange = vi.fn();
    render(
      <RepoPicker
        repos={REPOS}
        status="success"
        slug="octocat/hello-world"
        onSlugChange={onSlugChange}
      />,
    );

    expect((screen.getByRole("combobox", { name: "Your repos" }) as HTMLSelectElement).value).toBe(
      "",
    );
    const input = screen.getByRole("textbox", { name: "owner/repo" }) as HTMLInputElement;
    expect(input.value).toBe("octocat/hello-world");

    await user.type(input, "x");
    expect(onSlugChange).toHaveBeenCalled();
  });

  it("shows the matching option when the typed slug is one of yours", () => {
    render(<RepoPicker repos={REPOS} status="success" slug="ada/older" onSlugChange={vi.fn()} />);

    expect((screen.getByRole("combobox", { name: "Your repos" }) as HTMLSelectElement).value).toBe(
      "ada/older",
    );
  });

  it("degrades to manual entry when repo discovery fails", () => {
    render(
      <RepoPicker
        repos={[]}
        status="error"
        errorMessage="Unauthorized"
        slug=""
        onSlugChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Unauthorized");
    expect(screen.getByRole("textbox", { name: "owner/repo" })).toBeTruthy();
  });

  it("keeps manual entry usable while repos are loading", () => {
    render(<RepoPicker repos={[]} status="pending" slug="" onSlugChange={vi.fn()} />);

    expect(screen.getByRole("option", { name: "Loading your repos…" })).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: "Your repos" }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("textbox", { name: "owner/repo" }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });
});

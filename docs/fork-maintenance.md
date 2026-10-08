# Fork maintenance

English | [中文](fork-maintenance.zh.md)

This fork serves three purposes:

1. Keep each feature or fix on an independent, focused branch ready for an upstream contribution;
2. Combine those branches conveniently for local builds;
3. Incorporate upstream stable releases at any time.

Do not add domain branches, patch registries, or frozen lists. Branches hold the state, and `.fork/branches` is the only inventory.

## Repository roles

| Reference | Purpose |
| --- | --- |
| `origin` | Read-only upstream deepseek-ai/deepseek-harness |
| `fork` | Personal fork; all pushes go here |
| `dsh-vX.Y.Z` / `dsh-vX.Y.Z-rc.N` tag | Upstream stable release; baseline for aggregation and new branches |
| `feature/*`, `fix/*` | One branch per change, based on the baseline tag |
| `fork-tooling` | Maintenance rules, `.fork/branches`, and aggregation script; merged like other branches |
| `local/aggregate` | Generated aggregate, recreated from the tag each time; always checked out at the repository root |

The current baseline is the tag on the `base` line of `.fork/branches`. Upstream releases are prereleases: select the latest RC or final tag, not alpha or master. Do not incorporate upstream master commits absent from a tag unless the user explicitly requests them.

## 1. Develop a feature or fix

Create a branch from the current baseline tag and develop in a separate worktree:

```bash
base=$(git show fork-tooling:.fork/branches | awk '$1=="base"{print $2}')
git worktree add .worktrees/<name> -b feature/<name> "$base"   # 修复用 fix/<name>
```

- Do not branch from `local/aggregate`: it carries all aggregate changes and cannot be submitted independently upstream.
- Branch from another fork branch only for a real dependency; record "stacked on X" in the inventory description.
- Continue existing work on its own branch. A branch may remain behind the baseline; merge handles it. Rebase only for conflicts.
- Finish with relevant passing tests, a commit, `git push fork <branch>`, and verification of the remote SHA.
- Add a line to `.fork/branches` on `fork-tooling` with the branch, upstream status, and description; commit and push `fork-tooling`.

## 2. Aggregate builds

```bash
scripts/fork-aggregate            # 生成 .worktrees/aggregate-next 上的 aggregate/next
scripts/fork-aggregate --promote  # 成功后移动根目录 local/aggregate 并推送到 fork
```

The script starts from the baseline tag and merges each listed branch with `merge --no-ff`. It recreates the aggregate each time without intermediate state to maintain. Validate in `.worktrees/aggregate-next` before using `--promote`:

```bash
cd .worktrees/aggregate-next
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
# 加上本次冲突或新增分支涉及的包的测试，例如 ACP 分支：
pnpm exec vitest run packages/acp/acp
pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/acp
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/acp
```

Branches have already passed their own tests; aggregation validates the merged result. Promotion and pushes to the fork require no further confirmation. The local `dsh` on PATH links to the root `apps/cli`; after promotion, install dependencies and update the root build artifacts, then verify local execution with `dsh --version` and ACP startup.

### Repository pitfalls

- Changing the baseline can leave old package directories containing only `node_modules` (directories in `packages/*/*`, `vendor/*`, and `apps/*` with no `git ls-files` entries), stale `lib/`, and `*.tsbuildinfo`. Without cleanup, tsdown can report `Cannot find entry lib/types/...` or MISSING_EXPORT. Remove them before install/build; `pnpm run clean` fails in that version, so do not rely on it.
- `scripts/fork-aggregate` sets `LEFTHOOK=0`: merged commits were validated on their branches, a new `.worktrees/aggregate-next` lacks `node_modules` (pre-commit cannot find tsx), and the `--promote` push skips pre-push typecheck. Validation belongs to the subsequent install/typecheck/build/test steps. Pushing `fork-tooling` itself may also use `LEFTHOOK=0` to skip pre-push typecheck.

### Resolve conflicts

The script stops on conflicts and identifies their category:

| Category | Detection | Resolution |
| --- | --- | --- |
| Branch versus upstream | The branch conflicts when merged into the baseline tag alone | Run `git rebase --no-autostash <tag>` in the branch worktree, fix, test, `git push --force-with-lease fork <branch>`, and rerun the script. The repaired branch remains mergeable upstream. |
| Between fork branches | Each merges alone, but they conflict together | Combine both sides in `.worktrees/aggregate-next` without new behavior, run `git add` and `git commit --no-edit`, then rerun the script. `rerere` remembers the resolution for automatic reuse. |

- Product fixes belong on their corresponding branches, never in aggregate merge commits.
- If the same pair repeatedly has nontrivial conflicts, rebase the later branch onto the earlier one and update the inventory order and description.
- Rebase stacked branches from the bottom, using `git rebase --update-refs` to move upper branches together.

### Incorporate a new upstream release

1. Change `base` in `.fork/branches` to the new stable tag, or first try `scripts/fork-aggregate --base <tag>`.
2. Run the script and resolve conflicts using the table above. Branches without conflicts need no changes.
3. A branch that becomes empty after rebase is already included upstream: remove its inventory line and delete the local and fork branches. Name the upstream release that absorbed it in the commit message.
4. Validate, use `--promote`, and commit and push the new `base` on `fork-tooling`.

## 3. Upstream feedback

Branches are the upstream PR material, so each must remain independent and based on a tag.

1. Search upstream for related issues/PRs and prepare content using this repository's issue/PR conventions.
2. **Before submitting an upstream issue, comment, or PR, show the proposed content to the user for item-by-item confirmation.** The user may instead retain it locally as `fork-only`.
3. For a PR, rebase onto upstream master on a new branch such as `upstream/<name>`, push it to the fork, and open the PR. First handle or split dependencies of stacked branches.
4. Update the inventory status and link in `.fork/branches` (`reported` / `pr-open` / `fork-only`).
5. After upstream merge, wait for inclusion in a stable tag before removing the inventory entry (step 3 of the preceding section). Closing an issue alone does not justify removal.

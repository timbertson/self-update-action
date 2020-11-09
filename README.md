# Self-update action

### Motivation:

There are many "automatic update" tools with deep integration into a particular package manager. They are big and complex and work well if you have that exact need.

This is the opposite tool: it has no knowledge of your tooling, so you'll have to write the update logic yourself. But if you can do that, this tool provides all the surrounding github machinery to apply updates and turn them into Pull Requests.

## Sample use case:

TODO document cron...

## Workflow:

1. evaluate the `updateScript` setting (a bash string)
2. If the `applyUpdateScript` setting is provided:
   - Stage all changes from the `updateScript` step, so that they don't count as changes
   - Evaluate the `applyUpdateScript` setting
3. If there are no unstaged git changes or errors, the action terminates successfully (nothing to do)
4. commit to the branch specified in `branchName` setting, and **force push** to `origin`
5. Search for open PRs for this branch
   - If none are found, create one (against the `baseBranch` setting, defaulting to the original checked-out branch)
6. Update the PR description based on the template, appending any errors that were encountered

## Caveats:

### Use of force-push on every run:

The action force-pushes a single branch and updates a PR description each time it runs (instead of, say, creating a new PR / branch / comment each time). This is partly to reduce noise, and partly just because it makes the implementation reasonably simple :shrug:

This does make manual edits a little awkward. If you're doing a quick fix you can probably just push your own commits to the branch, but be aware the next time the action runs it will overwrite your commits. So keep a copy of your branch locally, and if you want to have your modifications last longer than the self-update frequency, you should make your own PR branched off the automated one.

### Default GITHUB_TOKEN will not cause any actions to run on created PRs:

As mentioned in the [Github docs](https://docs.github.com/en/free-pro-team@latest/actions/reference/authentication-in-a-workflow), you will need to pass in a [Personal Access Token](https://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/creating-a-personal-access-token) if you want the Pull Requests created by this action to trigger any workflows.

If you're doing that, _make sure you don't trigger this action from a PR or branch push_, since that would leave you the proud owner of one Infinite Recursion. That's why the default behaviour is not to trigger further actions.

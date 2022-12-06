import * as child_process from 'child_process'
import * as github from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'

enum StateType { Initial }
type State = {
  log: Array<string>,
  commit: string | null,
  hasError: boolean,
  hasChanges: boolean,
  pullRequest: PullRequest | null,
  repository: Repository | null,
}

type Settings = {
  githubToken: string,
  githubRepository: string,
  owner: string,
  repo: string,
  setupScript: string | null,
  updateScript: string,
  baseBranch: string | null,
  branchName: string,
  commitMessage: string,
  authorName: string,
  authorEmail: string,
  prTitle: string,
  prBody: string,
  runId: string,
}

export const settingKeys = [
  'GITHUB_TOKEN',
  'repository',
  'updateScript',
  'setupScript',
  'branchName',
  'baseBranch',
  'commitMessage',
  'prTitle',
  'prBody',
  'authorName',
  'authorEmail',
]

export function parseSettings(inputs: Record<string, string>): Settings {
  function get(key: string, dfl?: string | undefined): string {
    return assertDefined(key, inputs[key] || dfl)
  }

  function assertDefined(msg: string, value: string | undefined): string {
    if (!value) {
      throw new Error(`Missing setting: ${msg}`)
    }
    return value
  }

  const repositoryFromEnv = get('repository', process.env['GITHUB_REPOSITORY'] || "").split('/');

  return {
    githubToken: get('GITHUB_TOKEN'),
    githubRepository: process.env['GITHUB_REPOSITORY'] || "",
    owner: get('owner', repositoryFromEnv[0]),
    repo: get('repo', repositoryFromEnv[1]),
    setupScript: inputs['setupScript'] || null,
    updateScript: get('updateScript'),
    baseBranch: inputs['baseBranch'] || null,
    branchName: get('branchName', 'self-update'),
    commitMessage: get('commitMessage', '[bot] self-update'),
    prTitle: get('prTitle', '[bot] self-update'),
    prBody: get('prBody', 'This is an automated PR from a github action'),
    authorName: get('authorName', 'github-actions'),
    authorEmail: get('authorEmail', '41898282+github-actions[bot]@users.noreply.github.com'),
    runId: assertDefined('GITHUB_RUN_ID', process.env['GITHUB_RUN_ID']),
  }
}

type PullRequest = {
  id: string,
  url: string,
  number: number,
}

type Repository = {
  id: string,
}

type Octokit = InstanceType<typeof GitHub>

export async function main(settings: Settings): Promise<PullRequest | null> {
  const octokit = github.getOctokit(settings.githubToken)

  let state = initialState()
  state = initEnv(state, settings);
  state = setup(state, settings);
  state = update(state, settings);
  state = detectChanges(state, settings);

  state = await findPR(state, settings, octokit);
  state = await updatePR(state, settings, octokit);
  if (state.hasError) {
    // make sure errors are reflected in action result
    process.exit(1)
  }
  return state.pullRequest
}

function initialState(): State {
  return {
    log: [],
    hasError: false,
    hasChanges: false,
    pullRequest: null,
    commit: null,
    repository: null,
  }
}

function initEnv(state: State, settings: Settings): State {
  ;['AUTHOR', 'COMMITTER'].forEach((role) => {
    process.env[`GIT_${role}_NAME`] = settings.authorName
    process.env[`GIT_${role}_EMAIL`] = settings.authorEmail
  })
  process.env['GITHUB_TOKEN'] = settings.githubToken
  return state
}

function setup(state: State, settings: Settings): State {
  if (settings.setupScript == null || state.hasError) {
    return state
  }
  addLog(state, "Running setup script ...")

  const setupScript = settings.setupScript
  return catchError(state, () => {
    sh(state, setupScript)
    cmd(state, ["git", "add", "."])
    return state
  })
}

function update(state: State, settings: Settings): State {
  if (state.hasError) {
    return state
  }
  addLog(state, "Running update script ...")

  return catchError(state, () => {
    sh(state, settings.updateScript)
    // include added files as changes (for when we later diff against the index)
    cmd(state, ["git", "add", "--intent-to-add", "."])
    return state
  })
}

function detectChanges(state: State, _settings: Settings): State {
  try {
    cmd(state, ["git", "diff", "--name-status", "--exit-code"])
    return { ...state, hasChanges: false }
  } catch (e) {
    // it failed, presumably because there were differences.
    // (if not, the commit will fail later)
    return { ...state, hasChanges: true }
  }
}

export function pushBranch(state: State, settings: Settings): State {
  return catchError(state, () => {
    cmd(state, ["git", "commit", "--allow-empty", "--all", "--message", settings.commitMessage])
    const commit = cmd(state, ["git", "rev-parse", "HEAD"])
    cmd(state, ["git",
      "-c", "http.https://github.com/.extraheader=",
      "push", "-f",
      `https://x-access-token:${settings.githubToken}@github.com/${settings.owner}/${settings.repo}.git`,
      `HEAD:refs/heads/${settings.branchName}`
    ])
    return { ...state, commit }
  })
}

type PrQueryResponse = {
  repository: {
    id: string,
    pullRequests: {
      edges: Array<{
        node: PullRequest
      }>
    }
  }
}

export async function findPR(state: State, settings: Settings, octokit: Octokit): Promise<State> {
  const { repo, owner, branchName } = settings
  const response: PrQueryResponse = await octokit.graphql(`
    query findPR($owner: String!, $repo: String!, $branchName: String!) {
      repository(owner: $owner, name: $repo) {
        id
        pullRequests(
          headRefName: $branchName,
          states:[OPEN],
          first:1)
        {
          edges {
            node {
              id
              number
              url
            }
          }
        }
      }
    }
  `,
    {
      owner,
      repo,
      branchName,
    })

  const repository = { id: response.repository.id }
  const openPRs = response.repository.pullRequests.edges.map((e) => e.node);
  const pullRequest = openPRs[0] || null
  /* console.log(`Query for open PRs from branch '${branchName}' returned: ${JSON.stringify(pullRequest)}`) */
  return { ...state, repository, pullRequest }
}

export async function updatePR(state: State, settings: Settings, octokit: Octokit): Promise<State> {
  if (requiresPR(state)) {
    state = pushBranch(state, settings);
    if (state.pullRequest == null) {
      const pullRequest = await createPR(state, settings, octokit)
      console.log(`Created PR ${pullRequest.url}`)
      return { ...state, pullRequest }
    } else {
      console.log(`Updating PR ${state.pullRequest.url}`)
      await updatePRContents(state.pullRequest, state, settings, octokit)
      return state
    }
  } else {
    console.log("No changes detected")
    if (state.pullRequest != null) {
      await closePR(state.pullRequest, octokit)
      console.log(`Closed PR ${state.pullRequest.url}`)
    }
    return { ...state, pullRequest: null }
  }
}

async function createPR(state: State, settings: Settings, octokit: Octokit): Promise<PullRequest> {
  if (state.repository == null) {
    throw new Error("Repository is unset")
  }
  type Response = { createPullRequest: { pullRequest: PullRequest } }
  const baseBranch = settings.baseBranch || cmdSilent(state, ['git', 'branch', '--show-current'])
  const response: Response = await octokit.graphql(`
    mutation updatePR(
      $branchName: String!,
      $baseBranch: String!,
      $body: String!,
      $title: String!,
      $repoId: ID!
    ) {
      createPullRequest(input: {
        repositoryId: $repoId,
        headRefName: $branchName,
        baseRefName: $baseBranch,
        title: $title,
        body: $body
      }) {
        pullRequest {
          id
          number
          url
        }
      }
    }
  `,
    {
      repoId: state.repository.id,
      branchName: settings.branchName,
      baseBranch: baseBranch,
      title: settings.prTitle,
      body: renderPRDescription(state, settings),
    })
  /* console.log(JSON.stringify(response)) */
  return response.createPullRequest.pullRequest
}

export async function updatePRContents(pullRequest: PullRequest, state: State, settings: Settings, octokit: Octokit): Promise<void> {
  const baseBranch = settings.baseBranch || cmdSilent(state, ['git', 'branch', '--show-current'])
  await octokit.graphql(`
    mutation updatePR(
      $id: ID!,
      $baseBranch: String!,
      $body: String!,
      $title: String!
    ) {
      updatePullRequest(input: {
        pullRequestId: $id,
        baseRefName: $baseBranch,
        title: $title,
        body: $body
      }) {
        pullRequest {
          id
        }
      }
    }
  `,
    {
      id: pullRequest.id,
      baseBranch: baseBranch,
      title: settings.prTitle,
      body: renderPRDescription(state, settings),
    })
}

async function closePR(pullRequest: PullRequest, octokit: Octokit): Promise<void> {
  await octokit.graphql(`
    mutation updatePR($id: ID!) {
      closePullRequest(input: { pullRequestId: $id }) {
        pullRequest {
          id
        }
      }
    }
  `, { id: pullRequest.id })
}

function requiresPR(state: State) {
  return state.hasError || state.hasChanges
}

function abbreviate(message: Array<string>, maxChars: number): string {
    const joined = message.join("\n");
    if (joined.length > maxChars) {
        return "[Too long, message truncated]"
    } else {
        return joined
    }
}

// Since we're posting command output to github, we need to replicate github's censoring
function censorSecrets(log: Array<string>, settings: Settings): Array<string> {
  // ugh replaceAll should be a thing...
  return log.map((output) => {
    const secret = settings.githubToken
    while (output.indexOf(secret) != -1) {
      output = output.replace(secret, '********')
    }
    return output
  })
}

function renderPRDescription(state: State, settings: Settings): string {
  const commit = state.commit || "(unknown commit)"
  const runUrl = `https://github.com/${settings.githubRepository}/actions/runs/${settings.runId}`
  const outputHeader = (state.hasError
    ? ":no_entry_sign: Update failed"
    : ":white_check_mark: Update succeeded"
  )
  return [
    settings.prBody,
    "",
    "",
    "## " + outputHeader,
    "<details>",
    "<summary>Output for update commit " + commit + ":</summary>",
    "",
    "```",
    abbreviate(censorSecrets(state.log, settings), 40000),
    "```",
    "</details>",
    "",
    `See the [workflow run](${runUrl}) for full details.`,
    "",
    "_**Note:** This branch is owned by a bot, and will be force-pushed next time it runs._",
  ].join("\n")
}

function catchError(state: State, fn: () => State): State {
  try {
    return fn()
  } catch (e) {
    addLog(state, "ERROR: " + e.message)
    return { ...state, hasError: true }
  }
}

const execOptions: child_process.ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'pipe']
}

function handleExec(state: State, cmdDisplay: string | null, result: child_process.SpawnSyncReturns<string>): string {
  const output = [
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter((stream) => stream.length > 0).join("\n")

  if (cmdDisplay != null) {
    addLog(state, "+ " + cmdDisplay)
    if (output.length > 0) {
      addLog(state, output)
    }
  }

  if (result.status != 0) {
    let message = "Command failed"
    if (cmdDisplay == null) {
      // we didn't log the output, so include it in the message
      message += ": " + output
    }
    throw new Error(message)
  }
  return result.stdout.trim()
}

function cmd(state: State, args: string[]): string {
  return handleExec(state, args.join(' '), child_process.spawnSync(args[0], args.slice(1), execOptions))
}

function cmdSilent(state: State, args: string[]): string {
  return handleExec(state, null, child_process.spawnSync(args[0], args.slice(1), execOptions))
}

function sh(state: State, script: string): string {
  return handleExec(state, script, child_process.spawnSync('bash', ['-euc', 'exec 2>&1\n' + script], execOptions))
}

function addLog(state: State, message: string) {
  // Mutation is a bit cheeky, but simplifies function signatures
  // and logs are only used for display
  console.log(message)
  state.log.push(message)
}

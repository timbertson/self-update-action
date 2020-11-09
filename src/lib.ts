import * as child_process from 'child_process'
import * as github from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'

enum StateType { Initial }
type State = {
	error: string | null,
	commit: string | null,
	hasChanges: boolean,
	pullRequest: PullRequest | null,
	repository: Repository | null,
}

type Settings = {
	githubToken: string,
	owner: string,
	repo: string,
	updateScript: string,
	applyUpdateScript: string | null,
	branchName: string,
	baseBranch: string,
	commitMessage: string,
	prTitle: string,
	prBody: string,
}

type PullRequest = {
	id: string,
	url: string,
}

type Repository = {
	id: string,
}

type Octokit = InstanceType<typeof GitHub>

async function main(settings: Settings) {
	const octokit = github.getOctokit(settings.githubToken)

	let state = update(settings);
	state = applyUpdate(state, settings);
	state = detectChanges(state, settings);
	if (state.error == null && !state.hasChanges) {
		console.log("No changes detected; exiting")
		return
	}

	state = pushBranch(state, settings);

	state = await findPR(state, settings, octokit);
	state = await updatePR(state, settings, octokit);
	if (state.error != null) {
		// make sure errors are reflected in action result
		throw new Error(state.error)
	}
}

function update(settings: Settings): State {
	const initialState = {
		error: null,
		hasChanges: false,
		pullRequest: null,
		commit: null,
		repository: null,
	}
	return catchError(initialState, () => {
		sh(settings.updateScript)
		return initialState
	})
}

function applyUpdate(state: State, settings: Settings): State {
	if (settings.applyUpdateScript == null || state.error != null) {
		return state
	}

	const applyUpdateScript = settings.applyUpdateScript
	return catchError(state, () => {
		cmd(["git", "add", "-u"]) // TODO what if no changes?
		sh(applyUpdateScript)
		return state
	})
}

function detectChanges(state: State, _settings: Settings): State {
	try {
		sh("git diff-index --quiet")
		return { ...state, hasChanges: false }
	} catch(e) {
		// it failed, presumably because there were differences.
		// (if not, the commit will fail later)
		return { ...state, hasChanges: true }
	}
}

function pushBranch(state: State, settings: Settings): State {
	return catchError(state, () => {
		if (state.hasChanges) {
			cmd(["git", "commit", "-a", "-m", settings.commitMessage])
		}
		const commit = cmd(["git", "rev-parse", "HEAD"])
		cmd(["git", "push", "-f", "origin", "HEAD:refs/heads/"+settings.branchName])
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
	if (state.pullRequest == null) {
		const pullRequest = await createPR(state, settings, octokit)
		console.log(`Created PR ${pullRequest.url}`)
		return {...state, pullRequest }
	} else {
		console.log(`Updating PR ${state.pullRequest.url}`)
		await updatePRDescription(state.pullRequest, state, settings, octokit)
		return state
	}
}

async function createPR(state: State, settings: Settings, octokit: Octokit): Promise<PullRequest> {
	if (state.repository == null) {
		throw new Error("Repository is unset")
	}
	type Response = { createPullRequest: { pullRequest: PullRequest } }
	const response: Response = await octokit.graphql(`
		mutation updatePR(
			$branchName: String!,
			$baseBranch: String!,
			$body: String!,
			$title: String!,
			$repoId: String!
		) {
			createPullRequest(input: {
				repositoryId: $repoId,
				baseRefName: $baseBranch,
				headRefName: $branchName,
				title: $title,
				body: $body
			}) {
				pullRequest {
					id
					url
				}
			}
		}
	`,
	{
		repoId: state.repository.id,
		branchName: settings.branchName,
		baseBranch: settings.baseBranch,
		title: settings.prTitle,
		body: renderPRDescription(state, settings),
	})
	/* console.log(JSON.stringify(response)) */
	return response.createPullRequest.pullRequest
}

export async function updatePRDescription(pullRequest: PullRequest, state: State, settings: Settings, octokit: Octokit): Promise<void> {
	await octokit.graphql(`
		mutation updatePR($id: String!, $body: String!) {
			updatePullRequest(input: { pullRequestId: $id, body: $body }) {
				pullRequest {
					id
				}
			}
		}
	`,
	{
		id: pullRequest.id,
		body: renderPRDescription(state, settings),
	})
}

function renderPRDescription(state: State, settings: Settings): string {
	let body = settings.prBody
	if (state.error != null) {
		body += "\n\n----\n\n"
		body += [
			"### Error:",
			"",
			`Applying updates failed for ${state.commit || "(unknown commit)"}:`,
			"",
			"```",
			state.error,
			"```",
		].join("\n")
	}

	body += "\n\n"
	body += "_**Note:** This branch is owned by a bot, and will be force-pushed next time it runs._"
	return body
}

function catchError(state: State, fn: () => State): State {
	try {
		return fn()
	} catch(e) {
		if (e.error == null) {
			return {...state, error: e.message }
		} else {
			console.error("Ignoring additional error: " + e.message)
			return state
		}
	}
}

const execOptions: child_process.ExecSyncOptionsWithStringEncoding = {
	encoding: 'utf8',
	stdio: ['inherit', 'pipe', 'pipe']
}

function handleExec(sh: string, result: child_process.SpawnSyncReturns<string>): string {
	const output = [
		result.stdout.trim(),
		result.stderr.trim(),
	].filter((stream) => stream.length > 0).join("\n")

	console.log("+ " + sh)
	if (output.length > 0) {
		console.log(output)
	}

	if (result.status != 0) {
		throw new Error("Command failed: " + sh + "\n\n" + output)
	}
	return result.stdout.trim()
}

function cmd(args: string[]): string {
	return handleExec(args.join(' '), child_process.spawnSync(args[0], args.slice(1), execOptions))
}

function sh(script: string): string {
	return handleExec(script, child_process.spawnSync(script, { ...execOptions, shell: true }))
}

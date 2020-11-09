import * as child_process from 'child_process'
import * as github from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'

enum StateType { Initial }
type State = {
	error: string | null,
	hasChanges: boolean,
	prId: string | null,
}

type Settings = {
	githubToken: string,
	owner: string,
	repo: string,
	updateScript: string,
	applyUpdateScript: string | null,
	branchName: string | null,
	commitMessage: string,
	prTitle: string,
	prBody: string,
}

async function main(settings: Settings) {
	const octokit = github.getOctokit(settings.githubToken)

	let state = update(settings);
	state = applyUpdate(state, settings);
	state = detectChanges(state, settings);
	if (!state.hasChanges) {
		console.log("No changes detected; exiting")
		return
	}

	state = pushBranch(state, settings);

	state = await findPR(state, settings, octokit);
	state = updatePR(state, settings);
	if (state.error != null) {
		// make sure errors are reflected in action result
		throw new Error(state.error)
	}
}

function update(settings: Settings): State {
	const state = {
		error: null,
		hasChanges: false,
		prId: null,
	}
	return catchError(state, () => {
		sh(settings.updateScript)
		return state
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
		cmd(["git", "commit", "-a", "-m", settings.commitMessage])
		cmd(["git", "push", "-f", "origin", "HEAD:refs/heads/"+settings.branchName])
		return state
	})
}

type PrQueryResponse = {
	id: string
}

export async function findPR(state: State, settings: Settings, octokit: InstanceType<typeof GitHub>): Promise<State> {
	const { repo, owner, branchName } = settings
	const openPRs: Array<PrQueryResponse> = await octokit.graphql(`
		query findPR($owner: String!, $repo: String!, $branchName: String!) {
			repository(owner: $owner, name: $repo) {
				pullRequests(headRefName: $branchName, states:[OPEN], first:1) {
					edges {
						node {
							id
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

	const id = (openPRs.length > 0) ? openPRs[0].id : null
	console.log(`Query for open PRs from branch '${branchName}' returned id: ${id}`)
	return { ...state, prId: id }
}

function updatePR(state: State, _settings: Settings): State {
	return state
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

function handleExec(sh: string, result: child_process.SpawnSyncReturns<string>) {
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

function cmd(args: string[]) {
	return handleExec(args.join(' '), child_process.spawnSync(args[0], args.slice(1), execOptions))
}

function sh(script: string) {
	return handleExec(script, child_process.spawnSync(script, { ...execOptions, shell: true }))
}

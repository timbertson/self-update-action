"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updatePRDescription = exports.updatePR = exports.findPR = exports.update = exports.parseSettings = exports.settingKeys = void 0;
const child_process = require("child_process");
const github = require("@actions/github");
var StateType;
(function (StateType) {
    StateType[StateType["Initial"] = 0] = "Initial";
})(StateType || (StateType = {}));
exports.settingKeys = [
    'GITHUB_TOKEN',
    'owner',
    'repo',
    'updateScript',
    'applyUpdateScript',
    'branchName',
    'baseBranch',
    'commitMessage',
    'prTitle',
    'prBody',
];
function parseSettings(inputs) {
    function get(key, dfl) {
        const value = inputs[key] || dfl;
        if (!value) {
            throw new Error(`Missing setting: ${key}`);
        }
        return value;
    }
    const repositoryFromEnv = (process.env['GITHUB_REPOSITORY'] || "").split('/');
    return {
        githubToken: get('GITHUB_TOKEN'),
        owner: get('owner', repositoryFromEnv[0]),
        repo: get('repo', repositoryFromEnv[1]),
        updateScript: get('updateScript'),
        applyUpdateScript: inputs['applyUpdateScript'] || null,
        branchName: inputs['branchName'] || 'self-update',
        baseBranch: inputs['baseBranch'] || cmd(['git', 'branch', '--show-current']),
        commitMessage: get('commitMessage', '[bot] self-update'),
        prTitle: get('prTitle' || '[bot] self-update'),
        prBody: get('prBody' || 'This is an automated PR from a github action'),
    };
}
exports.parseSettings = parseSettings;
function main(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        const octokit = github.getOctokit(settings.githubToken);
        let state = update(settings);
        state = applyUpdate(state, settings);
        state = detectChanges(state, settings);
        if (state.error == null && !state.hasChanges) {
            console.log("No changes detected; exiting");
            return;
        }
        state = pushBranch(state, settings);
        state = yield findPR(state, settings, octokit);
        state = yield updatePR(state, settings, octokit);
        if (state.error != null) {
            // make sure errors are reflected in action result
            throw new Error(state.error);
        }
    });
}
function update(settings) {
    const initialState = {
        error: null,
        hasChanges: false,
        pullRequest: null,
        commit: null,
        repository: null,
    };
    return catchError(initialState, () => {
        sh(settings.updateScript);
        return initialState;
    });
}
exports.update = update;
function applyUpdate(state, settings) {
    if (settings.applyUpdateScript == null || state.error != null) {
        return state;
    }
    const applyUpdateScript = settings.applyUpdateScript;
    return catchError(state, () => {
        cmd(["git", "add", "-u"]); // TODO what if no changes?
        sh(applyUpdateScript);
        return state;
    });
}
function detectChanges(state, _settings) {
    try {
        cmd(["git", "diff-index", "--quiet"]);
        return Object.assign(Object.assign({}, state), { hasChanges: false });
    }
    catch (e) {
        // it failed, presumably because there were differences.
        // (if not, the commit will fail later)
        return Object.assign(Object.assign({}, state), { hasChanges: true });
    }
}
function pushBranch(state, settings) {
    return catchError(state, () => {
        if (state.hasChanges) {
            cmd(["git", "commit", "-a", "-m", settings.commitMessage]);
        }
        const commit = cmd(["git", "rev-parse", "HEAD"]);
        cmd(["git", "push", "-f", "origin", "HEAD:refs/heads/" + settings.branchName]);
        return Object.assign(Object.assign({}, state), { commit });
    });
}
function findPR(state, settings, octokit) {
    return __awaiter(this, void 0, void 0, function* () {
        const { repo, owner, branchName } = settings;
        const response = yield octokit.graphql(`
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
	`, {
            owner,
            repo,
            branchName,
        });
        const repository = { id: response.repository.id };
        const openPRs = response.repository.pullRequests.edges.map((e) => e.node);
        const pullRequest = openPRs[0] || null;
        /* console.log(`Query for open PRs from branch '${branchName}' returned: ${JSON.stringify(pullRequest)}`) */
        return Object.assign(Object.assign({}, state), { repository, pullRequest });
    });
}
exports.findPR = findPR;
function updatePR(state, settings, octokit) {
    return __awaiter(this, void 0, void 0, function* () {
        if (state.pullRequest == null) {
            const pullRequest = yield createPR(state, settings, octokit);
            console.log(`Created PR ${pullRequest.url}`);
            return Object.assign(Object.assign({}, state), { pullRequest });
        }
        else {
            console.log(`Updating PR ${state.pullRequest.url}`);
            yield updatePRDescription(state.pullRequest, state, settings, octokit);
            return state;
        }
    });
}
exports.updatePR = updatePR;
function createPR(state, settings, octokit) {
    return __awaiter(this, void 0, void 0, function* () {
        if (state.repository == null) {
            throw new Error("Repository is unset");
        }
        const response = yield octokit.graphql(`
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
	`, {
            repoId: state.repository.id,
            branchName: settings.branchName,
            baseBranch: settings.baseBranch,
            title: settings.prTitle,
            body: renderPRDescription(state, settings),
        });
        /* console.log(JSON.stringify(response)) */
        return response.createPullRequest.pullRequest;
    });
}
function updatePRDescription(pullRequest, state, settings, octokit) {
    return __awaiter(this, void 0, void 0, function* () {
        yield octokit.graphql(`
		mutation updatePR($id: String!, $body: String!) {
			updatePullRequest(input: { pullRequestId: $id, body: $body }) {
				pullRequest {
					id
				}
			}
		}
	`, {
            id: pullRequest.id,
            body: renderPRDescription(state, settings),
        });
    });
}
exports.updatePRDescription = updatePRDescription;
function renderPRDescription(state, settings) {
    let body = settings.prBody;
    if (state.error != null) {
        body += "\n\n----\n\n";
        body += [
            "### Error:",
            "",
            `Applying updates failed for ${state.commit || "(unknown commit)"}:`,
            "",
            "```",
            state.error,
            "```",
        ].join("\n");
    }
    body += "\n\n";
    body += "_**Note:** This branch is owned by a bot, and will be force-pushed next time it runs._";
    return body;
}
function catchError(state, fn) {
    try {
        return fn();
    }
    catch (e) {
        if (e.error == null) {
            return Object.assign(Object.assign({}, state), { error: e.message });
        }
        else {
            console.error("Ignoring additional error: " + e.message);
            return state;
        }
    }
}
const execOptions = {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe']
};
function handleExec(sh, result) {
    const output = [
        result.stdout.trim(),
        result.stderr.trim(),
    ].filter((stream) => stream.length > 0).join("\n");
    console.log("+ " + sh);
    if (output.length > 0) {
        console.log(output);
    }
    if (result.status != 0) {
        throw new Error("Command failed: " + sh + "\n\n" + output);
    }
    return result.stdout.trim();
}
function cmd(args) {
    return handleExec(args.join(' '), child_process.spawnSync(args[0], args.slice(1), execOptions));
}
function sh(script) {
    return handleExec(script, child_process.spawnSync('bash', ['-euc', script], execOptions));
}
//# sourceMappingURL=lib.js.map
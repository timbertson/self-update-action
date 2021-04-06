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
exports.updatePRContents = exports.updatePR = exports.findPR = exports.pushBranch = exports.main = exports.parseSettings = exports.settingKeys = void 0;
const child_process = require("child_process");
const github = require("@actions/github");
var StateType;
(function (StateType) {
    StateType[StateType["Initial"] = 0] = "Initial";
})(StateType || (StateType = {}));
exports.settingKeys = [
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
];
function parseSettings(inputs) {
    function get(key, dfl) {
        return assertDefined(key, inputs[key] || dfl);
    }
    function assertDefined(msg, value) {
        if (!value) {
            throw new Error(`Missing setting: ${msg}`);
        }
        return value;
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
    };
}
exports.parseSettings = parseSettings;
function main(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        const octokit = github.getOctokit(settings.githubToken);
        let state = initialState();
        state = initEnv(state, settings);
        state = setup(state, settings);
        state = update(state, settings);
        state = detectChanges(state, settings);
        state = yield findPR(state, settings, octokit);
        state = yield updatePR(state, settings, octokit);
        if (state.hasError) {
            // make sure errors are reflected in action result
            process.exit(1);
        }
        return state.pullRequest;
    });
}
exports.main = main;
function initialState() {
    return {
        log: [],
        hasError: false,
        hasChanges: false,
        pullRequest: null,
        commit: null,
        repository: null,
    };
}
function initEnv(state, settings) {
    ;
    ['AUTHOR', 'COMMITTER'].forEach((role) => {
        process.env[`GIT_${role}_NAME`] = settings.authorName;
        process.env[`GIT_${role}_EMAIL`] = settings.authorEmail;
    });
    process.env['GITHUB_TOKEN'] = settings.githubToken;
    return state;
}
function setup(state, settings) {
    if (settings.setupScript == null || state.hasError) {
        return state;
    }
    addLog(state, "Running setup script ...");
    const setupScript = settings.setupScript;
    return catchError(state, () => {
        sh(state, setupScript);
        cmd(state, ["git", "add", "."]);
        return state;
    });
}
function update(state, settings) {
    if (state.hasError) {
        return state;
    }
    addLog(state, "Running update script ...");
    return catchError(state, () => {
        sh(state, settings.updateScript);
        // include added files as changes (for when we later diff against the index)
        cmd(state, ["git", "add", "--intent-to-add", "."]);
        return state;
    });
}
function detectChanges(state, _settings) {
    try {
        cmd(state, ["git", "diff", "--name-status", "--exit-code"]);
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
        cmd(state, ["git", "commit", "--allow-empty", "--all", "--message", settings.commitMessage]);
        const commit = cmd(state, ["git", "rev-parse", "HEAD"]);
        cmd(state, ["git",
            "-c", "http.https://github.com/.extraheader=",
            "push", "-f",
            `https://x-access-token:${settings.githubToken}@github.com/${settings.owner}/${settings.repo}.git`,
            `HEAD:refs/heads/${settings.branchName}`
        ]);
        return Object.assign(Object.assign({}, state), { commit });
    });
}
exports.pushBranch = pushBranch;
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
              number
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
        if (requiresPR(state)) {
            state = pushBranch(state, settings);
            if (state.pullRequest == null) {
                const pullRequest = yield createPR(state, settings, octokit);
                console.log(`Created PR ${pullRequest.url}`);
                return Object.assign(Object.assign({}, state), { pullRequest });
            }
            else {
                console.log(`Updating PR ${state.pullRequest.url}`);
                yield updatePRContents(state.pullRequest, state, settings, octokit);
                return state;
            }
        }
        else {
            console.log("No changes detected");
            if (state.pullRequest != null) {
                yield closePR(state.pullRequest, octokit);
                console.log(`Closed PR ${state.pullRequest.url}`);
            }
            return Object.assign(Object.assign({}, state), { pullRequest: null });
        }
    });
}
exports.updatePR = updatePR;
function createPR(state, settings, octokit) {
    return __awaiter(this, void 0, void 0, function* () {
        if (state.repository == null) {
            throw new Error("Repository is unset");
        }
        const baseBranch = settings.baseBranch || cmdSilent(state, ['git', 'branch', '--show-current']);
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
  `, {
            repoId: state.repository.id,
            branchName: settings.branchName,
            baseBranch: baseBranch,
            title: settings.prTitle,
            body: renderPRDescription(state, settings),
        });
        /* console.log(JSON.stringify(response)) */
        return response.createPullRequest.pullRequest;
    });
}
function updatePRContents(pullRequest, state, settings, octokit) {
    return __awaiter(this, void 0, void 0, function* () {
        const baseBranch = settings.baseBranch || cmdSilent(state, ['git', 'branch', '--show-current']);
        yield octokit.graphql(`
    mutation updatePR(
      $id: String!,
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
  `, {
            id: pullRequest.id,
            baseBranch: baseBranch,
            title: settings.prTitle,
            body: renderPRDescription(state, settings),
        });
    });
}
exports.updatePRContents = updatePRContents;
function closePR(pullRequest, octokit) {
    return __awaiter(this, void 0, void 0, function* () {
        yield octokit.graphql(`
    mutation updatePR($id: String!) {
      closePullRequest(input: { pullRequestId: $id }) {
        pullRequest {
          id
        }
      }
    }
  `, { id: pullRequest.id });
    });
}
function requiresPR(state) {
    return state.hasError || state.hasChanges;
}
// Since we're posting command output to github, we need to replicate github's censoring
function censorSecrets(log, settings) {
    // ugh replaceAll should be a thing...
    return log.map((output) => {
        const secret = settings.githubToken;
        while (output.indexOf(secret) != -1) {
            output = output.replace(secret, '********');
        }
        return output;
    });
}
function renderPRDescription(state, settings) {
    const commit = state.commit || "(unknown commit)";
    const runUrl = `https://github.com/${settings.githubRepository}/actions/runs/${settings.runId}`;
    const outputHeader = (state.hasError
        ? ":no_entry_sign: Update failed"
        : ":white_check_mark: Update succeeded");
    return [
        settings.prBody,
        "",
        "",
        "## " + outputHeader,
        "Output for update commit " + commit + ":",
        "",
        "```",
        censorSecrets(state.log, settings).join("\n"),
        "```",
        `See the [workflow run](${runUrl}) for full details.`,
        "",
        "_**Note:** This branch is owned by a bot, and will be force-pushed next time it runs._",
    ].join("\n");
}
function catchError(state, fn) {
    try {
        return fn();
    }
    catch (e) {
        addLog(state, "ERROR: " + e.message);
        return Object.assign(Object.assign({}, state), { hasError: true });
    }
}
const execOptions = {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe']
};
function handleExec(state, cmdDisplay, result) {
    const output = [
        result.stdout.trim(),
        result.stderr.trim(),
    ].filter((stream) => stream.length > 0).join("\n");
    if (cmdDisplay != null) {
        addLog(state, "+ " + cmdDisplay);
        if (output.length > 0) {
            addLog(state, output);
        }
    }
    if (result.status != 0) {
        let message = "Command failed";
        if (cmdDisplay == null) {
            // we didn't log the output, so include it in the message
            message += ": " + output;
        }
        throw new Error(message);
    }
    return result.stdout.trim();
}
function cmd(state, args) {
    return handleExec(state, args.join(' '), child_process.spawnSync(args[0], args.slice(1), execOptions));
}
function cmdSilent(state, args) {
    return handleExec(state, null, child_process.spawnSync(args[0], args.slice(1), execOptions));
}
function sh(state, script) {
    return handleExec(state, script, child_process.spawnSync('bash', ['-euc', 'exec 2>&1\n' + script], execOptions));
}
function addLog(state, message) {
    // Mutation is a bit cheeky, but simplifies function signatures
    // and logs are only used for display
    console.log(message);
    state.log.push(message);
}
//# sourceMappingURL=lib.js.map
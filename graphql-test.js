let github = require('@actions/github')
let lib = require('./out/lib')

const token = process.env['GITHUB_TOKEN']
const octokit = github.getOctokit(token)

let settings = {
	githubToken: token,
	repo: 'self-update-action',
	owner: 'timbertson',
	baseBranch: 'main',
	branchName: 'test',
	prTitle: '[bot] self-update',
	prBody: [
		"# Attention humans",
		"This is a test PR. It was made by a machine. This is step 0.001 of an exceedingly complex plan to make humans redundant.",
		"",
		"I'd better notify @timbertson about this...",
	].join('\n'),
}

const state = {
	error: '(this is a sample error)',
	commit: 'abcd1234',
}

lib.findPR(state, settings, octokit).then((state) =>
	lib.updatePR(state, settings, octokit)
)
	.then((response) => console.log("SUCCESS: ", response))
	.catch((e) => console.error("ERROR", e))


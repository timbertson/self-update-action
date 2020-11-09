import * as core from '@actions/core'
import * as lib from './lib'

function main() {
	try {
		let env: Record<string, string> = {}
		lib.settingKeys.forEach((key) => {
			let value = core.getInput(key)
			if (value != '') {
				env[key] = value
			}
		})
		let settings = lib.parseSettings(env)
		lib.update(settings)
	} catch(e) {
		console.log(e)
		core.setFailed(e.message)
	}
}

main()

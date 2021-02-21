import * as core from '@actions/core'
import * as lib from './lib'

async function main() {
  try {
    let env: Record<string, string> = {}
    lib.settingKeys.forEach((key) => {
      let value = core.getInput(key)
      if (value != '') {
        env[key] = value
      }
    })
    let settings = lib.parseSettings(env)
    const pr = await lib.main(settings)
    if (pr != null) {
      console.log(`Setting output pr_number=${pr.number}`)
      core.setOutput('pr_number', pr.number.toString())
      console.log(`Setting output pr_url=${pr.url}`)
      core.setOutput('pr_url', pr.url)
    }
  } catch (e) {
    console.log(e)
    core.setFailed(e.message)
  }
}

main()

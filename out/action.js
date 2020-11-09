"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core = require("@actions/core");
const lib = require("./lib");
function main() {
    try {
        let env = {};
        lib.settingKeys.forEach((key) => {
            let value = core.getInput(key);
            if (value != '') {
                env[key] = value;
            }
        });
        let settings = lib.parseSettings(env);
        lib.update(settings);
    }
    catch (e) {
        console.log(e);
        core.setFailed(e.message);
    }
}
main();
//# sourceMappingURL=action.js.map
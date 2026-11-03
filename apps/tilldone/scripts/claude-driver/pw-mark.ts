import { _electron as electron } from "/Users/szou/Python/Playground/DoorBird/Apps/blackjack/node_modules/@playwright/test/index.js";
const d = "/private/tmp/claude-501/-Users-szou-Python-Playground-DoorBird-Apps-tilldone/9ebd017c-93db-40bc-8b07-f903e64a63cb/scratchpad";
const a = await electron.launch({ executablePath: "/Users/szou/Python/Playground/DoorBird/Apps/blackjack/node_modules/.bin/electron", args: [d + "/emain2"], env: { ...process.env, MARK: d + "/mark.txt", NODE_OPTIONS: `--require ${d}/mark.cjs` } });
console.log(await a.evaluate(() => process.env.NODE_OPTIONS));
await a.close();

# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/travallgar1122/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/travallgar1122/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar is a Node program that reads a sealed snapshot of 758 protocols and ranks the pre-token ones by the implied value of farming them. It writes a ranked board of 300 rows with per-protocol farm steps, plus a self-contained dashboard that documents the scoring methodology and walks through a worked example end to end.

## Run it

```sh
RADAR_INPUT=/input/snapshot.json RADAR_OUTPUT=/output node main.ts
# locally: RADAR_INPUT=<kit>/input/snapshot.json RADAR_OUTPUT=./out node main.ts — then open out/dashboard/index.html
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=h0zvrf0h&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

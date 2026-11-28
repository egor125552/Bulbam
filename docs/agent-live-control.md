# Bulbam Live Control & Telemetry CLI for AI Agents

`scripts/agent-live.mjs` (`npm run agent:live -- <command>`) lets any AI agent control a live Bulbam server end-to-end: create sandbox users, open chats, send/reply/react/forward/star/delete messages, start and manage 1-on-1 and selective group calls, stream real WebSocket events from `/api/v1/realtime`, execute any raw authenticated API request, and benchmark call signaling latency in milliseconds.

All commands emit strict JSON to stdout (`{ "ok": true, "elapsedMs": ... }`) and store active sandbox aliases/cookies/chats/calls in `.agent-live-state.json` (gitignored).

## Safety Guardrails
- Sandbox usernames MUST start with `smoke_` (`--prefix=smoke_agent_`). Cleanup only deletes accounts matching that prefix.
- Local mode (`http://localhost:3000`) uses local Miniflare D1 for one-time invites and cleanup. Remote staging uses `BULBAM_SMOKE_SECRET` via `/api/v1/smoke/*`.

## Quick Start
```bash
# 1. Seed 3 live sandbox accounts (alice, bob, carol) + direct & group chats
npm run agent:live -- seed

# 2. Measure live 1-on-1 & 3-party selective group call connection/signaling speed
npm run agent:live -- bench-calls

# 3. Full messaging + calls E2E verification (auto-cleans unless --keep is passed)
npm run agent:live -- verify

# 4. Clean up all sandbox accounts & local state file
npm run agent:live -- cleanup
```

## Full Control Primitives (Stateful Aliases)
Once `seed` has been run, you can use `--as=alice|bob|carol`, `--chat=direct|group`, `--to=bob`, `--invite=bob,carol`, and omit `--call` to target the latest call:

```bash
npm run agent:live -- status
npm run agent:live -- user create --label=dave --name="Давид Тест"
npm run agent:live -- user login --username=smoke_agent_alice_xxx --password=... --label=alice2
npm run agent:live -- chat list --as=alice
npm run agent:live -- chat members --as=alice --chat=group
npm run agent:live -- msg send --as=alice --chat=group --text="Проверка связи"
npm run agent:live -- msg list --as=bob --chat=group
npm run agent:live -- call ice --as=alice
npm run agent:live -- call start --as=alice --chat=group --invite=bob
npm run agent:live -- call active --as=bob --chat=group
npm run agent:live -- call join --as=bob --chat=group
npm run agent:live -- call signal --as=alice --chat=group --kind=offer --to=bob
npm run agent:live -- call mute --as=bob --chat=group --muted=true
npm run agent:live -- call leave --as=bob --chat=group
npm run agent:live -- call end --as=alice --chat=group --all
npm run agent:live -- ws listen --as=bob --duration=5000 --event=call.ringing
npm run agent:live -- api --as=alice --method=GET --path=/api/v1/chats
```

## Call Benchmark Metrics (`bench-calls`)
`bench-calls` opens real live WebSocket connections for Alice, Bob, and Carol and measures:
- `wsConnectMs`: WebSocket handshake time per user.
- `iceConfig.fetchMs`: ICE/TURN fetch latency.
- `directCall`: `startHttpMs`, `ringDeliveryWsMs`, `preOfferUploadHttpMs`, `answerHttpMs`, `answerDeliveryWsMs`, `preOfferPullAfterAnswerHttpMs`, `sdpAnswerHttpMs`, `sdpAnswerDeliveryWsMs`, `iceBatch3HttpMs`, `iceBatch3DeliveryWsMs`, `totalSignalingSetupMs`, `endHttpMs`, `endDeliveryWsMs`.
- `groupCall`: `startHttpMs`, `selectiveRingToBobWsMs`, `selectiveInviteIsolated` (asserts uninvited Carol gets zero `call.ringing` events), `bobJoinHttpMs`, `bobJoinDeliveryWsMs`, `carolJoinHttpMs`, `carolJoinFanoutWsMs`, `targetedOfferHttpMs`, `targetedOfferDeliveryWsMs`, `targetedMeshIsolated` (asserts Alice->Bob offer never leaks to Carol), `muteHttpMs`, `muteFanoutWsMs`, `leaveHttpMs`, `leaveDeliveryWsMs`, `endForAllHttpMs`, `endForAllDeliveryWsMs`.

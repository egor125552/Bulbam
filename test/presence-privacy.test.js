import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestHarness } from "wrangler";
import { PresenceService } from "../worker/src/modules/presence/presence-service";

const server = createTestHarness({ workers: [{configPath: "./wrangler.test.jsonc"}] });
beforeAll(() => server.listen());
afterAll(() => server.close());

describe("presence is scoped to direct chats", () => {
  test("denies anonymous presence enumeration", async () => {
    const response=await server.fetch("/api/v1/presence");
    expect(response.status).toBe(401);
  });

  test("last seen, multiple devices, privacy and non-contact isolation", async () => {
    const ready=await server.fetch("/api/ready");
    expect(ready.status).toBe(200);
    const env=await server.getWorker("bulbam-api-test").getEnv();
    const service=new PresenceService(env.DB);
    await service.initialize();
    const a=crypto.randomUUID(),b=crypto.randomUUID(),c=crypto.randomUUID();
    const conversationId=crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO direct_conversations(conversation_id,participant_a_id,participant_b_id,direct_key,created_at) VALUES (?,?,?,?,?)"
    ).bind(conversationId,a,b,[a,b].sort().join(":"),Date.now()).run();
    expect(await service.peers(a)).toEqual([{userId:b,online:false,lastSeenAt:null,hidden:false}]);
    expect(await service.peers(c)).toEqual([]);

    await service.heartbeat({userId:b,sessionId:"session-b1"},true);
    const visible=(await service.peers(a))[0];
    expect(visible.online).toBe(true);
    expect(visible.lastSeenAt).toBeGreaterThan(0);

    await service.heartbeat({userId:b,sessionId:"session-b2"},true);
    await service.heartbeat({userId:b,sessionId:"session-b1"},false);
    expect((await service.peers(a))[0].online).toBe(true);
    await service.heartbeat({userId:b,sessionId:"session-b2"},false);
    expect((await service.peers(a))[0]).toMatchObject({online:false,hidden:false});
    expect((await service.peers(a))[0].lastSeenAt).toBeGreaterThan(0);

    await service.setSettings(b,false);
    await service.heartbeat({userId:b,sessionId:"session-b1"},true);
    expect((await service.peers(a))[0]).toEqual({
      userId:b,online:false,lastSeenAt:null,hidden:true
    });
    expect(await service.settings(b)).toBe(false);
    await service.setSettings(b,true);
    expect((await service.peers(a))[0].online).toBe(true);
    await env.DB.prepare("UPDATE account_presence_sessions SET visible_until = ? WHERE session_id = ?")
      .bind(Date.now()-1,"session-b1").run();
    expect((await service.peers(a))[0].online).toBe(false);
  });
});

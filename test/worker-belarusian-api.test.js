import {afterAll,beforeAll,describe,expect,test} from "vitest";
import {createTestHarness} from "wrangler";

const server=createTestHarness({workers:[{configPath:"./wrangler.test.jsonc"}]});
beforeAll(()=>server.listen());
afterAll(()=>server.close());

describe("localized Cloudflare Worker API",()=>{
 test("unauthorized response follows Accept-Language and keeps stable error code",async()=>{
  const ru=await server.fetch("/api/v1/auth/me");
  expect(ru.status).toBe(401);
  const ruData=await ru.json();
  expect(ruData.error.message).toBe("Сессия недействительна.");
  const be=await server.fetch("/api/v1/auth/me",{headers:{"accept-language":"be-BY,ru;q=0.9"}});
  expect(be.status).toBe(401);
  const beData=await be.json();
  expect(beData.error.code).toBe(ruData.error.code);
  expect(beData.error.message).toBe("Сеанс несапраўдны.");
 });
 test("unknown API paths also return translated messages",async()=>{
  const result=await server.fetch("/api/v1/missing-route",{headers:{"accept-language":"be"}});
  expect(result.status).toBe(404);
  const data=await result.json();
  expect(data.error.message).toBe("API-маршрут не знойдзены.");
 });
});

import { handleRequest } from "./app";
import type { Env } from "./platform/cloudflare";

export { UserRealtime } from "./modules/realtime/infrastructure/user-realtime";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  }
};

import { handleRequest } from "./app";
import type { Env, ExecutionContextLike } from "./platform/cloudflare";

export { UserRealtime } from "./modules/realtime/infrastructure/user-realtime";
export { CallRoom } from "./modules/calls/infrastructure/call-room";
export { VoiceUploadRoom } from "./modules/media/infrastructure/voice-upload-room";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return handleRequest(request, env, ctx);
  }
};

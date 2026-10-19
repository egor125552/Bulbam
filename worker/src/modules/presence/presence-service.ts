import type { D1Database } from "../../platform/cloudflare";
import { json, methodNotAllowed, readJsonObject } from "../../core/http";
import { ApiError } from "../../core/errors";
import { ensureMessagingSchema } from "../messaging/infrastructure/schema";

interface Actor { userId: string; sessionId: string }
type Authenticate = (request: Request) => Promise<Actor>;
const ONLINE_LEASE_MS = 50_000;

export class PresenceService {
  constructor(private readonly db: D1Database) {}

  async initialize(): Promise<void> {
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS account_presence_sessions (
      session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      last_active_at INTEGER NOT NULL, visible_until INTEGER NOT NULL
    )`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_presence_user
      ON account_presence_sessions(user_id, last_active_at)`).run();
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS account_presence_settings (
      user_id TEXT PRIMARY KEY, share_presence INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`).run();
  }

  async settings(userId: string): Promise<boolean> {
    await this.initialize();
    const setting = await this.db.prepare(
      "SELECT share_presence FROM account_presence_settings WHERE user_id = ?"
    ).bind(userId).first<{share_presence: number}>();
    return setting?.share_presence !== 0;
  }

  async setSettings(userId: string, sharePresence: boolean): Promise<void> {
    await this.initialize();
    await this.db.prepare(`INSERT INTO account_presence_settings(user_id,share_presence,updated_at)
      VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET
      share_presence=excluded.share_presence,updated_at=excluded.updated_at`)
      .bind(userId,sharePresence?1:0,Date.now()).run();
  }

  async heartbeat(actor: Actor, visible: boolean): Promise<void> {
    await this.initialize();
    const now=Date.now();
    await this.db.prepare(`INSERT INTO account_presence_sessions
      (session_id,user_id,last_active_at,visible_until) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_active_at=excluded.last_active_at,visible_until=excluded.visible_until`)
      .bind(actor.sessionId, actor.userId, now, visible ? now+ONLINE_LEASE_MS : 0).run();
  }

  async peers(userId: string) {
    await this.initialize();
    await ensureMessagingSchema(this.db);
    const now=Date.now();
    const result=await this.db.prepare(`
      WITH peers AS (
        SELECT DISTINCT CASE WHEN participant_a_id=? THEN participant_b_id ELSE participant_a_id END AS peer_id
        FROM direct_conversations
        WHERE participant_a_id=? OR participant_b_id=?
      ), activity AS (
        SELECT user_id, MAX(last_active_at) AS last_seen_at,
          MAX(CASE WHEN visible_until>? THEN 1 ELSE 0 END) AS online
        FROM account_presence_sessions GROUP BY user_id
      )
      SELECT peers.peer_id AS user_id, activity.last_seen_at AS last_seen_at,
        COALESCE(activity.online,0) AS online, COALESCE(settings.share_presence,1) AS share_presence
      FROM peers
      LEFT JOIN activity ON activity.user_id=peers.peer_id
      LEFT JOIN account_presence_settings settings ON settings.user_id=peers.peer_id
      ORDER BY peers.peer_id LIMIT 100
    `).bind(userId,userId,userId,now).all<{
      user_id:string;last_seen_at:number|null;online:number;share_presence:number
    }>();
    return (result.results??[]).map(row=>({
      userId:row.user_id,
      online:row.share_presence!==0 && row.online===1,
      lastSeenAt:row.share_presence!==0 && row.last_seen_at!==null ? Number(row.last_seen_at) : null,
      hidden:row.share_presence===0
    }));
  }
}

export async function handlePresenceHttp(
  request: Request,url:URL,service:PresenceService,authenticate:Authenticate
): Promise<Response|null> {
  if (!url.pathname.startsWith("/api/v1/presence")) return null;
  const actor=await authenticate(request);
  if (url.pathname==="/api/v1/presence") {
    if(request.method!=="GET")return methodNotAllowed(["GET"]);
    return json({ok:true,users:await service.peers(actor.userId)});
  }
  if(url.pathname==="/api/v1/presence/settings") {
    if(request.method==="GET")return json({ok:true,sharePresence:await service.settings(actor.userId)});
    if(request.method!=="PUT")return methodNotAllowed(["GET","PUT"]);
    const body=await readJsonObject(request);
    if(typeof body.sharePresence!=="boolean")
      throw new ApiError(400,"invalid_presence_setting","Выберите, показывать ли вашу активность.");
    await service.setSettings(actor.userId,body.sharePresence);
    return json({ok:true,sharePresence:body.sharePresence});
  }
  if(url.pathname==="/api/v1/presence/heartbeat") {
    if(request.method!=="PUT")return methodNotAllowed(["PUT"]);
    const body=await readJsonObject(request);
    if(typeof body.visible!=="boolean")
      throw new ApiError(400,"invalid_presence_heartbeat","Некорректный статус активности.");
    await service.heartbeat(actor,body.visible);
    return json({ok:true});
  }
  return null;
}

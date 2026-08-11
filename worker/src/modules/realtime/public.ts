import type { DurableObjectNamespace } from "../../platform/cloudflare";

export class DurableObjectRealtime {
  constructor(private readonly namespace: DurableObjectNamespace | undefined) {}

  available(): boolean {
    return Boolean(this.namespace);
  }

  connect(userId: string, request: Request): Promise<Response> {
    if (!this.namespace) {
      return Promise.resolve(new Response("Realtime unavailable", { status: 503 }));
    }
    return this.namespace.getByName(userId).fetch(request);
  }

  async hasActiveConnections(userId: string): Promise<boolean> {
    if (!this.namespace) return false;
    try {
      const response = await this.namespace.getByName(userId).fetch(
        new Request("https://realtime.internal/presence")
      );
      if (!response.ok) return false;
      const payload = await response.json() as { connected?: unknown };
      return payload.connected === true;
    } catch {
      return false;
    }
  }

  async claimActiveCall(
    userId: string,
    call: Record<string, unknown>,
    expiresAt: number
  ): Promise<boolean> {
    if (!this.namespace) return false;
    try {
      const response = await this.namespace.getByName(userId).fetch(
        new Request("https://realtime.internal/active-call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "claim", call, expiresAt })
        })
      );
      return response.ok;
    } catch (error) {
      console.warn(`[Realtime] claim active call for ${userId} failed`, error);
      return false;
    }
  }

  async setActiveCall(
    userId: string,
    call: Record<string, unknown>,
    expiresAt: number
  ): Promise<void> {
    if (!this.namespace) return;
    try {
      const response = await this.namespace.getByName(userId).fetch(
        new Request("https://realtime.internal/active-call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "set", call, expiresAt })
        })
      );
      if (!response.ok) {
        console.warn(`[Realtime] active call state for ${userId} returned ${response.status}`);
      }
    } catch (error) {
      console.warn(`[Realtime] active call state for ${userId} failed`, error);
    }
  }

  async clearActiveCall(userId: string, callId?: string): Promise<void> {
    if (!this.namespace) return;
    try {
      const response = await this.namespace.getByName(userId).fetch(
        new Request("https://realtime.internal/active-call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "clear", call: null, callId: callId ?? "" })
        })
      );
      if (!response.ok && response.status !== 409) {
        console.warn(`[Realtime] clear active call for ${userId} returned ${response.status}`);
      }
    } catch (error) {
      console.warn(`[Realtime] clear active call for ${userId} failed`, error);
    }
  }

  async publishToUsers(userIds: string[], event: Record<string, unknown>): Promise<void> {
    if (!this.namespace) return;
    const payload = JSON.stringify(event);
    await Promise.all(
      [...new Set(userIds)].map(async (userId) => {
        try {
          const response = await this.namespace!.getByName(userId).fetch(
            new Request("https://realtime.internal/emit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: payload
            })
          );
          if (!response.ok) {
            console.warn(`[Realtime] emit to ${userId} returned ${response.status}`);
          }
        } catch (error) {
          console.warn(`[Realtime] emit to ${userId} failed`, error);
        }
      })
    );
  }
}

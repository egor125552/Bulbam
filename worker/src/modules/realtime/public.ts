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

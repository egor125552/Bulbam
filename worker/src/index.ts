type AssetsBinding = {
  fetch(request: Request): Promise<Response>;
};

interface Env {
  ASSETS: AssetsBinding;
}

const VERSION = "0.1.0-dev";

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
      }

      return json({
        ok: true,
        service: "bulbam-api",
        version: VERSION,
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      return json({
        ok: true,
        service: "bulbam-api",
        endpoints: ["GET /api/health"]
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};

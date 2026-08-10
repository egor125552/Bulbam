# Web Push notifications

Bulbam uses standards-based Web Push. The browser registers `/sw.js`, creates a Push API subscription with a VAPID public key, and stores the subscription in D1 for the authenticated user. New messages are still delivered through WebSocket while the app is in the foreground; Web Push is used when the recipient has no recent foreground lease.

## Production VAPID configuration

Generate one long-lived VAPID key pair once:

```sh
npx web-push generate-vapid-keys
```

Configure the production Worker with these environment values:

- `VAPID_PUBLIC_KEY` — generated public key.
- `VAPID_PRIVATE_KEY` — generated private key. Treat it as a secret and never commit it.
- `VAPID_SUBJECT` — an `https:` or `mailto:` contact URI, for example `https://bulbam-api.k69ysrndm7.workers.dev`.

Cloudflare recommends storing production VAPID values as Worker secrets. The Worker deliberately remains healthy when these values are absent; `/api/ready` reports `push: "needs_vapid_keys"`, and the client explains that server-side push is not configured yet.

## Client behavior

- Notification permission is requested only after the user presses **Включить уведомления**.
- iPhone/iPad users are prompted to install/open Bulbam as a Home Screen web app before enabling push.
- Existing browser subscriptions are re-associated with the current authenticated Bulbam account after login.
- Logging out removes the current endpoint from the account before ending the session.
- Notification clicks reopen Bulbam and preserve the target chat identifier in the URL.
- A short foreground lease suppresses duplicate system pushes while the app is visibly in use. The lease is cleared on `visibilitychange` and expires automatically if the browser is terminated abruptly.
- Push endpoints returning HTTP 404 or 410 are removed from D1 automatically.

## Security

The VAPID private key never belongs in Git, the web manifest, client JavaScript, or D1. Only the VAPID public key is returned to an authenticated client through `/api/v1/push/config`.

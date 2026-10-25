import { defineConfig } from "vitest/config";

const INTEGRATION_TESTS = [
  "test/calls-smoke.test.js",
  "test/messaging-smoke.test.js",
  "test/group-chats-smoke.test.js",
  "test/registration-smoke.test.js",
  "test/voice-messages-smoke.test.js",
  "test/voice-publication-lifecycle.test.js",
  "test/voice-upload-public-socket.test.js",
  "test/worker-integration.test.js",
  // Worker/D1/DO integration tests must not compete over a single local
  // workerd instance. Concurrent account-recovery tests would exceed 5s
  // despite being correct when run in isolation.
  "test/account-recovery.test.js",
  "test/admin-recovery.test.js",
  "test/cyrillic-usernames.test.js",
  "test/e2ee-device-messages-live.test.js",
  "test/e2ee-device-registry.test.js",
  "test/passkeys.test.js",
  "test/presence-privacy.test.js",
  "test/registration-username-localization.test.js",
  "test/worker-belarusian-api.test.js"
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.js"],
          exclude: INTEGRATION_TESTS,
          testTimeout: 5_000
        }
      },
      {
        test: {
          name: "integration",
          include: INTEGRATION_TESTS,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000
        }
      }
    ]
  }
});

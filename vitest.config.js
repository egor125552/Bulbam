import { defineConfig } from "vitest/config";

const INTEGRATION_TESTS = [
  "test/calls-smoke.test.js",
  "test/messaging-smoke.test.js",
  "test/registration-smoke.test.js",
  "test/voice-messages-smoke.test.js",
  "test/voice-publication-lifecycle.test.js",
  "test/voice-upload-public-socket.test.js",
  "test/worker-integration.test.js"
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
          testTimeout: 15_000,
          hookTimeout: 15_000
        }
      }
    ]
  }
});

import base from "../../eslint.config.base.mjs";

export default [
  // Byte-for-byte copies from Marl0nL/staff-agent-toolkit (the shared keyring
  // client and its stand-in bus). They are never edited here, so never linted
  // here: test/keyring.test.ts pins their SHA-256.
  { ignores: ["src/keyring.mjs", "src/keyring.d.mts", "src/test-support/fake-bus.mjs", ".lab-*/**"] },
  ...base,
];

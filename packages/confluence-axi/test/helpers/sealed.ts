/**
 * What the shared keyring client is told in every test that does not point it
 * at a stand-in: Linux, with NO session bus. It opens no socket and runs no
 * program, and answers as a computer with no password store does.
 */
export const SEALED = { platform: "linux", env: {} };

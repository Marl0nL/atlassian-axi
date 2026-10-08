/**
 * The keyring lab: a PRIVATE session bus and a PRIVATE test keyring in a
 * throwaway home, for the one test that meets a real password store
 * (test/keyring-lab.test.ts).
 *
 * A port of keyring/test/lab.mjs in Marl0nL/staff-agent-toolkit (at c381a1e),
 * with the same rules. Nothing here can reach the desktop's real password
 * store: the lab's processes are started with an environment MADE FROM
 * NOTHING (no inherited bus address, no display, a new HOME and a new
 * XDG_RUNTIME_DIR), the lab's bus has no service folders (so it can start no
 * other program, and no password window), and `guard()` refuses to go on
 * anywhere else. Pointing HOME somewhere else is not what does it: the bus
 * address decides which password store answers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe } from "../../src/keyring.mjs";

const MARK = ".reposit-keyring-lab";
const PREFIX = "krlab-";

export function findProgram(name: string): string | null {
  for (const folder of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    if (existsSync(join(folder, name))) return join(folder, name);
  }
  return null;
}

/** What the lab needs and this machine lacks, as a sentence; or null when it can run. */
export function labMissing(): string | null {
  if (process.platform !== "linux") return "the lab runs on Linux only";
  const missing = ["dbus-daemon", "gnome-keyring-daemon"].filter((name) => !findProgram(name));
  return missing.length ? `not installed: ${missing.join(", ")}` : null;
}

/** Refuses to go on unless `env` is a lab's and nowhere near a real desktop session. */
export function guard(env: Record<string, string | undefined>): string {
  const lab = env.REPOSIT_KEYRING_LAB ?? "";
  const inside = (value: string | undefined) =>
    typeof value === "string" && value.startsWith(`${lab}/`);
  const problems: string[] = [];
  if (!lab.includes(`/${PREFIX}`) || !existsSync(join(lab, MARK)))
    problems.push("not a lab folder");
  if (!inside(env.HOME)) problems.push("HOME is not the lab's");
  if (!inside(env.XDG_RUNTIME_DIR)) problems.push("XDG_RUNTIME_DIR is not the lab's");
  if (env.DBUS_SESSION_BUS_ADDRESS !== `unix:path=${lab}/run/bus`) {
    problems.push("the bus address is not the lab's");
  }
  for (const name of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "GNOME_KEYRING_CONTROL",
    "SSH_AUTH_SOCK",
  ]) {
    if (env[name]) problems.push(`${name} is set`);
  }
  if (problems.length) {
    throw new Error(`keyring lab: refusing to run outside a lab (${problems.join("; ")})`);
  }
  return lab;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Lab {
  /** The lab's folder. */
  lab: string;
  /** The WHOLE environment for anything run in the lab. */
  env: Record<string, string>;
  stop(): Promise<void>;
}

/** Starts a lab: a private bus with an unlocked test keyring on it, made from a made-up password. */
export async function startLab(): Promise<Lab> {
  // A socket path may be at most 107 bytes, so a long TMPDIR is not used.
  const base = tmpdir().length <= 40 ? tmpdir() : "/tmp";
  const lab = mkdtempSync(join(base, PREFIX));
  writeFileSync(join(lab, MARK), "");
  for (const folder of ["home", "run"]) mkdirSync(join(lab, folder), { mode: 0o700 });
  const env = {
    REPOSIT_KEYRING_LAB: lab,
    HOME: join(lab, "home"),
    XDG_RUNTIME_DIR: join(lab, "run"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${lab}/run/bus`,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
  guard(env);
  // No <servicedir> and no <standard_session_servicedirs/>: this bus cannot start anything.
  writeFileSync(
    join(lab, "bus.conf"),
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${lab}/run/bus</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n`,
  );
  const children: ChildProcess[] = [];
  const stop = async () => {
    for (const child of [...children].reverse()) child.kill("SIGTERM");
    await sleep(100);
    for (const child of children) child.kill("SIGKILL");
    // Only ever a folder this file made a moment ago, checked by its name and its mark.
    if (lab.includes(`/${PREFIX}`) && existsSync(join(lab, MARK))) {
      rmSync(lab, { recursive: true, force: true });
    }
  };
  try {
    children.push(
      spawn(
        findProgram("dbus-daemon") ?? "",
        [`--config-file=${lab}/bus.conf`, "--nofork", "--nopidfile"],
        { env, stdio: "ignore" },
      ),
    );
    for (let i = 0; i < 100 && !existsSync(join(lab, "run/bus")); i += 1) await sleep(30);
    if (!existsSync(join(lab, "run/bus"))) {
      throw new Error("keyring lab: the private bus did not start");
    }
    // --unlock reads the new test keyring's password from standard input and makes
    // home/.local/share/keyrings/login.keyring, unlocked. The password is a made-up one.
    const daemon = spawn(
      findProgram("gnome-keyring-daemon") ?? "",
      ["--foreground", "--unlock", "--components=secrets"],
      { env, stdio: ["pipe", "ignore", "ignore"] },
    );
    daemon.stdin?.end("lab-password-not-a-real-one\n");
    children.push(daemon);
    let state = "";
    for (let i = 0; i < 100 && state !== "usable"; i += 1) {
      ({ state } = await probe({ env, platform: "linux" }));
      if (state !== "usable") await sleep(50);
    }
    if (state !== "usable") {
      throw new Error(`keyring lab: the test keyring did not come up (${state})`);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { lab, env, stop };
}

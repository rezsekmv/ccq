import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTeeCommand, canonicalDir, installTee, isTeeInstalled, parseInstallArgs, refreshTee, resolveConfigDirs, resolveLink, shQuote, shUnquote, uninstallTee, wrappedCommand } from "./statusline.ts";

const home = canonicalDir(mkdtempSync(join(tmpdir(), "ccq-home-")));
const tee = (orig: string) => buildTeeCommand("bun", "cli.ts", orig);
const legacyTee = (orig: string) => `"bun" "cli.ts" statusline-tee${orig ? ` -- ${orig}` : ""}`; // pre-0.1.6 format

describe("parseInstallArgs", () => {
  test("accepts repeated --config-dir in both forms, plus --uninstall anywhere", () => {
    expect(parseInstallArgs(["--config-dir", "/a", "--uninstall", "--config-dir=/b"])).toEqual({ uninstall: true, configDirs: ["/a", "/b"] });
    expect(parseInstallArgs([])).toEqual({ uninstall: false, configDirs: [] });
  });

  test("a dangling --config-dir is an error, not a silent fallback to the default dir", () => {
    expect(() => parseInstallArgs(["--config-dir"])).toThrow();
    expect(() => parseInstallArgs(["--uninstall", "--config-dir"])).toThrow();
  });

  test("--config-dir does not swallow the next flag", () => {
    expect(() => parseInstallArgs(["--config-dir", "--uninstall"])).toThrow();
  });

  test("unknown or leftover tokens are rejected", () => {
    expect(() => parseInstallArgs(["--config-dirs", "/a"])).toThrow();
    expect(() => parseInstallArgs(["/a"])).toThrow();
  });
});

describe("resolveConfigDirs", () => {
  test("defaults to ~/.claude", () => {
    expect(resolveConfigDirs([], {}, home)).toEqual([join(home, ".claude")]);
  });

  test("honors CLAUDE_CONFIG_DIR, ignoring a blank value", () => {
    expect(resolveConfigDirs([], { CLAUDE_CONFIG_DIR: "/agents/neo/.claude-config" }, home)).toEqual(["/agents/neo/.claude-config"]);
    expect(resolveConfigDirs([], { CLAUDE_CONFIG_DIR: "  " }, home)).toEqual([join(home, ".claude")]);
  });

  test("explicit dirs win over the env var, expand ~ and dedupe", () => {
    const dirs = resolveConfigDirs(["~/a", "/x/b", `${home}/a`], { CLAUDE_CONFIG_DIR: "/env" }, home);
    expect(dirs).toEqual([join(home, "a"), "/x/b"]);
  });

  test("rejects a blank explicit dir instead of falling back to the cwd", () => {
    expect(() => resolveConfigDirs(["~/a", ""], {}, home)).toThrow();
  });

  test("symlinked dirs collapse to one canonical key", () => {
    const real = join(home, "real");
    mkdirSync(real);
    symlinkSync(real, join(home, "link"));
    expect(resolveConfigDirs([real, join(home, "link")], {}, home)).toEqual([real]);
  });
});

describe("install / uninstall", () => {
  test("wraps an existing statusline and restores it exactly, extra fields included", () => {
    const original = { type: "command", command: "~/sl.sh", padding: 2 };
    const r = installTee({ model: "x", statusLine: original }, tee)!;
    expect(r.backup).toEqual(original);
    expect(r.settings.statusLine).toEqual({ type: "command", command: `"bun" "cli.ts" statusline-tee -- '~/sl.sh'`, padding: 2 });
    expect(r.settings.model).toBe("x");
    expect(uninstallTee(r.settings, r.backup)).toEqual({ model: "x", statusLine: original });
  });

  test("with no prior statusline, uninstall removes it again", () => {
    const r = installTee({}, tee)!;
    expect(r.backup).toBeNull();
    expect(isTeeInstalled(r.settings)).toBe(true);
    expect(uninstallTee(r.settings, r.backup)).toEqual({});
  });

  test("a command that merely mentions statusline-tee is not the tee", () => {
    const own = { statusLine: { type: "command", command: "~/bin/my-statusline-tee.sh" } };
    expect(isTeeInstalled(own)).toBe(false);
    expect(installTee(own, tee)!.backup).toEqual(own.statusLine);
  });

  test("install is idempotent", () => {
    const r = installTee({}, tee)!;
    expect(installTee(r.settings, tee)).toBeNull();
  });

  test("without a recorded backup, recovers the wrapped command from the tee", () => {
    const wrapped = installTee({ statusLine: { type: "command", command: "~/sl.sh" } }, tee)!.settings;
    expect(uninstallTee(wrapped, undefined).statusLine).toEqual({ type: "command", command: "~/sl.sh" });
    expect(uninstallTee(installTee({}, tee)!.settings, undefined)).toEqual({});
  });

  test("backups are independent per config dir", () => {
    const backups: Record<string, unknown> = {};
    const a = installTee({ statusLine: { type: "command", command: "a.sh" } }, tee)!;
    const b = installTee({}, tee)!;
    backups["/a"] = a.backup;
    backups["/b"] = b.backup;
    expect(uninstallTee(a.settings, backups["/a"] as any).statusLine.command).toBe("a.sh");
    expect(uninstallTee(b.settings, backups["/b"] as any)).toEqual({});
  });
});

describe("resolveLink", () => {
  const dir = canonicalDir(mkdtempSync(join(tmpdir(), "ccq-link-")));

  test("plain and missing paths resolve to themselves", () => {
    writeFileSync(join(dir, "plain.json"), "{}");
    expect(resolveLink(join(dir, "plain.json"))).toBe(join(dir, "plain.json"));
    expect(resolveLink(join(dir, "missing.json"))).toBe(join(dir, "missing.json"));
  });

  test("follows relative chains, including to a target that does not exist yet", () => {
    mkdirSync(join(dir, "dotfiles"));
    symlinkSync("dotfiles/settings.json", join(dir, "hop2"));
    symlinkSync(join(dir, "hop2"), join(dir, "settings.json"));
    expect(resolveLink(join(dir, "settings.json"))).toBe(join(dir, "dotfiles", "settings.json"));
  });

  test("a symlink loop is an error", () => {
    symlinkSync(join(dir, "loopB"), join(dir, "loopA"));
    symlinkSync(join(dir, "loopA"), join(dir, "loopB"));
    expect(() => resolveLink(join(dir, "loopA"))).toThrow();
  });
});

describe("quoting the wrapped command", () => {
  const nasty = [`cat | jq -r '.model.display_name'`, `echo "a   b" && echo $((1+1)); echo it's`, "x'y''z", ""];

  test("shQuote / shUnquote round-trip", () => {
    for (const c of nasty) expect(shUnquote(shQuote(c))).toBe(c);
    expect(shUnquote("cat | jq")).toBeNull();
    expect(shUnquote("'a' 'b'")).toBeNull();
  });

  test("the shell hands the whole original to the tee as ONE argument", () => {
    for (const c of nasty.filter(Boolean)) {
      const r = Bun.spawnSync(["sh", "-c", `printf '%s\\0' ${shQuote(c)}`]);
      expect(r.stdout.toString()).toBe(`${c}\0`);
    }
  });

  test("wrappedCommand reads both the quoted and the legacy unquoted format", () => {
    const c = `cat | jq -r '.x'`;
    expect(wrappedCommand(installTee({ statusLine: { type: "command", command: c } }, tee)!.settings)).toBe(c);
    expect(wrappedCommand(installTee({ statusLine: { type: "command", command: "~/sl.sh" } }, legacyTee)!.settings)).toBe("~/sl.sh");
    expect(wrappedCommand(installTee({}, tee)!.settings)).toBe("");
  });

  test("refreshTee upgrades a legacy or moved tee and leaves a current one alone", () => {
    const legacy = installTee({ statusLine: { type: "command", command: "a | b", padding: 1 } }, legacyTee)!.settings;
    const fresh = refreshTee(legacy, "a | b", tee)!;
    expect(fresh.statusLine).toEqual({ type: "command", command: tee("a | b"), padding: 1 });
    expect(refreshTee(fresh, "a | b", tee)).toBeNull();
    const moved = refreshTee(fresh, "a | b", (o) => buildTeeCommand("/new/bun", "cli.ts", o))!;
    expect(moved.statusLine.command).toBe(buildTeeCommand("/new/bun", "cli.ts", "a | b"));
  });
});

describe("resolveLink with ..", () => {
  test("resolves `..` against the physical parent, not lexically", () => {
    const root = canonicalDir(mkdtempSync(join(tmpdir(), "ccq-dotdot-")));
    mkdirSync(join(root, "real", "cfg"), { recursive: true });
    mkdirSync(join(root, "real", "dot"));
    symlinkSync(join(root, "real", "cfg"), join(root, "alias")); // alias -> real/cfg
    symlinkSync("../dot/settings.json", join(root, "real", "cfg", "settings.json"));
    // lexically alias/../dot = <root>/dot (wrong); physically real/cfg/../dot = real/dot
    expect(resolveLink(join(root, "alias", "settings.json"))).toBe(join(root, "real", "dot", "settings.json"));
  });
});

"use strict";
/**
 * Tests for the run_dotnet built-in tool and its Windows environment refresh.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildDotnetEnvironment,
  createCodeTools,
  mergePathValues,
  parseWindowsRegistryEnvironment,
  resolvePosixHostRestoreEnvironment,
  resolveWindowsHostRestoreEnvironment,
  resolveDotnetExecutable,
} = require("../dist/tools/codeTools.js");

function makeCtx(cwd, overrides = {}) {
  return {
    cwd,
    protectedPaths: [],
    allowDotnet: true,
    allowJavascript: false,
    allowPython: false,
    allowTerminal: false,
    allowShell: false,
    allowBrowserControl: false,
    enableMemory: false,
    enableWikipedia: false,
    enableLocalRag: false,
    enableSecondary: false,
    allowGit: false,
    allowDb: false,
    allowNotify: false,
    allowGitHubTools: false,
    embeddingModelName: "test-model",
    fullState: {},
    pluginConfig: {},
    client: null,
    browserSession: null,
    ...overrides,
  };
}

function getTool(tools, name) {
  const found = tools.find(tool => tool.name === name);
  assert.ok(found, `Tool '${name}' not found`);
  return found;
}

describe("run_dotnet helpers", () => {
  it("parses string environment values returned by reg.exe", () => {
    const parsed = parseWindowsRegistryEnvironment([
      "HKEY_CURRENT_USER\\Environment",
      "    DOTNET_ROOT    REG_SZ    C:\\Program Files\\dotnet",
      "    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Tools",
      "    NUMBER    REG_DWORD    0x1",
      "",
    ].join("\r\n"));

    assert.deepEqual(parsed, {
      DOTNET_ROOT: "C:\\Program Files\\dotnet",
      Path: "%USERPROFILE%\\bin;C:\\Tools",
    });
  });

  it("merges PATH entries without duplicates", () => {
    const a = path.join("root", "a");
    const b = path.join("root", "b");
    const c = path.join("root", "c");
    assert.equal(
      mergePathValues([`${a}${path.delimiter}${b}`, `${b}${path.delimiter}${c}`]),
      [a, b, c].join(path.delimiter),
    );
  });

  it("resolves Windows user and machine-folder variables when LM Studio did not inherit them", () => {
    const hostEnvironment = resolveWindowsHostRestoreEnvironment(
      {},
      { USERPROFILE: "C:\\Users\\HostUser" },
      {
        AppData: "%USERPROFILE%\\AppData\\Roaming",
        "Local AppData": "%USERPROFILE%\\AppData\\Local",
      },
      "C:\\Fallback",
      "C:\\Windows\\Temp",
      {
        ProgramFilesDir: "C:\\Program Files",
        "ProgramFilesDir (x86)": "C:\\Program Files (x86)",
        CommonFilesDir: "C:\\Program Files\\Common Files",
        "CommonFilesDir (x86)": "C:\\Program Files (x86)\\Common Files",
      },
      { "Common AppData": "C:\\ProgramData" },
      "C:\\Windows",
      "HostUser",
    );
    assert.deepEqual(hostEnvironment, {
      USERPROFILE: "C:\\Users\\HostUser",
      APPDATA: "C:\\Users\\HostUser\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\HostUser\\AppData\\Local",
      ProgramData: "C:\\ProgramData",
      ALLUSERSPROFILE: "C:\\ProgramData",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      CommonProgramFiles: "C:\\Program Files\\Common Files",
      "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      SystemDrive: "C:",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\HostUser",
      USERNAME: "HostUser",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      OS: "Windows_NT",
      TEMP: "C:\\Windows\\Temp",
      TMP: "C:\\Windows\\Temp",
    });
  });

  it("resolves macOS/Linux home, XDG, identity, and temp variables", () => {
    const profile = resolvePosixHostRestoreEnvironment(
      {},
      "/home/host-user",
      "/var/tmp/host-user",
      "host-user",
    );
    assert.deepEqual(profile, {
      HOME: "/home/host-user",
      USER: "host-user",
      LOGNAME: "host-user",
      XDG_CONFIG_HOME: path.join("/home/host-user", ".config"),
      XDG_DATA_HOME: path.join("/home/host-user", ".local", "share"),
      XDG_CACHE_HOME: path.join("/home/host-user", ".cache"),
      TMPDIR: "/var/tmp/host-user",
    });

    const explicit = resolvePosixHostRestoreEnvironment(
      {
        HOME: "/custom/home",
        USER: "custom-user",
        LOGNAME: "custom-login",
        XDG_CONFIG_HOME: "/custom/config",
        XDG_DATA_HOME: "/custom/data",
        XDG_CACHE_HOME: "/custom/cache",
        TMPDIR: "/custom/tmp",
      },
      "/fallback/home",
      "/fallback/tmp",
      "fallback-user",
    );
    assert.deepEqual(explicit, {
      HOME: "/custom/home",
      USER: "custom-user",
      LOGNAME: "custom-login",
      XDG_CONFIG_HOME: "/custom/config",
      XDG_DATA_HOME: "/custom/data",
      XDG_CACHE_HOME: "/custom/cache",
      TMPDIR: "/custom/tmp",
    });
  });

  it("registers the tool and gates it behind its dedicated execution permission", async () => {
    const enabled = createCodeTools(makeCtx(process.cwd()));
    assert.ok(getTool(enabled, "run_dotnet"));

    const disabled = getTool(createCodeTools(makeCtx(process.cwd(), {
      allowDotnet: false,
      allowShell: true,
    })), "run_dotnet");
    await assert.rejects(
      () => disabled.implementation({ command: "build" }, { status: () => {}, warn: () => {} }),
      /disabled in the plugin settings/,
    );
  });

  it("places the DotNet setting immediately before JavaScript in the plugin UI", () => {
    const configSource = fs.readFileSync(
      path.join(__dirname, "..", "src", "config.ts"),
      "utf8",
    );
    const dotnetIndex = configSource.indexOf('.field("allowDotnetExecution"');
    const javascriptIndex = configSource.indexOf('.field("allowJavascriptExecution"');
    assert.ok(dotnetIndex >= 0, "DotNet setting is missing");
    assert.ok(javascriptIndex > dotnetIndex, "DotNet setting must precede JavaScript");
    assert.equal(
      configSource.slice(dotnetIndex, javascriptIndex).match(/\.field\(/g)?.length,
      1,
      "DotNet must be immediately before JavaScript",
    );
  });

  it("accepts arbitrary commands, global options, applications, and extensions", () => {
    const tool = getTool(createCodeTools(makeCtx(process.cwd())), "run_dotnet");
    for (const command of ["build", "new", "workload", "tool", "nuget", "--info", "app.dll", "ef"]) {
      assert.equal(
        tool.parametersSchema.safeParse({ command }).success,
        true,
        `Expected command '${command}' to be accepted`,
      );
    }
    assert.equal(tool.parametersSchema.safeParse({ command: "" }).success, false);
  });

  it("rejects a working directory outside the workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dotnet-path-"));
    try {
      const tool = getTool(createCodeTools(makeCtx(workspace)), "run_dotnet");
      await assert.rejects(
        () => tool.implementation(
          { command: "build", working_directory: ".." },
          { status: () => {}, warn: () => {} },
        ),
        /outside the workspace/,
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("run_dotnet smoke test", () => {
  let workspace;
  let dotnetAvailable = false;
  let targetFramework = "net8.0";

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "run-dotnet-"));
    const { env } = buildDotnetEnvironment();
    const executable = resolveDotnetExecutable(env);
    const version = spawnSync(executable, ["--version"], {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const major = Number.parseInt((version.stdout || "").trim().split(".")[0], 10);
    dotnetAvailable = version.status === 0 && Number.isInteger(major) && major >= 6;
    if (dotnetAvailable) targetFramework = `net${major}.0`;

    fs.writeFileSync(path.join(workspace, "Smoke.csproj"), [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <OutputType>Exe</OutputType>",
      `    <TargetFramework>${targetFramework}</TargetFramework>`,
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "  </PropertyGroup>",
      "</Project>",
    ].join("\n"));
    fs.writeFileSync(
      path.join(workspace, "Program.cs"),
      [
        'Console.WriteLine($"run_dotnet:{Environment.GetEnvironmentVariable("RUN_DOTNET_ENV_PROBE")}");',
        'Console.WriteLine($"windows-env:{Environment.GetEnvironmentVariable("USERPROFILE")}|{Environment.GetEnvironmentVariable("APPDATA")}|{Environment.GetEnvironmentVariable("LOCALAPPDATA")}|{Environment.GetEnvironmentVariable("TEMP")}|{Environment.GetEnvironmentVariable("TMP")}");',
        'Console.WriteLine($"posix-env:{Environment.GetEnvironmentVariable("HOME")}|{Environment.GetEnvironmentVariable("USER")}|{Environment.GetEnvironmentVariable("LOGNAME")}|{Environment.GetEnvironmentVariable("XDG_CONFIG_HOME")}|{Environment.GetEnvironmentVariable("XDG_DATA_HOME")}|{Environment.GetEnvironmentVariable("XDG_CACHE_HOME")}|{Environment.GetEnvironmentVariable("TMPDIR")}");',
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(workspace, ".tmp"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".dotnet-home"), { recursive: true });
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("restores when Windows machine-folder variables are missing from the parent", t => {
    if (process.platform !== "win32" || !dotnetAvailable) {
      t.skip("Windows with dotnet SDK 6+ required");
      return;
    }

    const tempDirectory = path.join(workspace, ".tmp");
    const strippedEnvironment = {
      Path: process.env.Path,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ProgramFiles: "",
      "ProgramFiles(x86)": "",
      ProgramData: "",
      ALLUSERSPROFILE: "",
      TEMP: tempDirectory,
      TMP: tempDirectory,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      SystemDrive: process.env.SystemDrive,
      ComSpec: process.env.ComSpec,
      DOTNET_CLI_HOME: path.join(workspace, ".dotnet-home"),
      DOTNET_NOLOGO: "1",
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    };
    const hostEnvironment = resolveWindowsHostRestoreEnvironment(
      strippedEnvironment,
      {},
      {},
      process.env.USERPROFILE,
      tempDirectory,
      {},
      {},
      process.env.SystemRoot,
      process.env.USERNAME,
    );
    const env = { ...strippedEnvironment, ...hostEnvironment };
    for (const key of ["APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]) {
      assert.ok(env[key], `${key} should be restored`);
    }

    const restore = spawnSync(resolveDotnetExecutable(env), ["restore", "--nologo"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  });

  it("accepts global options, restores, builds, runs, tests, and forwards host environment", async t => {
    if (!dotnetAvailable) {
      t.skip("dotnet SDK 6+ not found");
      return;
    }

    const tempDirectory = path.join(workspace, ".tmp");
    const baseEnvironment = {
      TEMP: tempDirectory,
      TMP: tempDirectory,
      DOTNET_CLI_HOME: path.join(workspace, ".dotnet-home"),
    };
    const tool = getTool(createCodeTools(makeCtx(workspace)), "run_dotnet");
    const toolContext = { status: () => {}, warn: () => {} };

    const version = await tool.implementation(
      { command: "--version", environment: baseEnvironment },
      toolContext,
    );
    assert.equal(version.success, true, version.stderr || version.stdout);
    assert.match(version.stdout, /^\d+\.\d+/);

    const restore = await tool.implementation(
      { command: "restore", arguments: ["--nologo"], environment: baseEnvironment },
      toolContext,
    );
    assert.equal(restore.success, true, restore.stderr || restore.stdout);

    const build = await tool.implementation(
      { command: "build", arguments: ["--no-restore", "--nologo"], environment: baseEnvironment },
      toolContext,
    );
    assert.equal(build.success, true, build.stderr || build.stdout);

    const run = await tool.implementation(
      {
        command: "run",
        arguments: ["--no-build"],
        environment: { ...baseEnvironment, RUN_DOTNET_ENV_PROBE: "forwarded" },
      },
      toolContext,
    );
    assert.equal(run.success, true, run.stderr || run.stdout);
    assert.match(run.stdout, /run_dotnet:forwarded/);
    if (process.platform === "win32") {
      assert.match(run.stdout, /windows-env:[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+/);
    } else {
      assert.match(run.stdout, /posix-env:[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+\|[^|\r\n]+/);
    }

    const test = await tool.implementation(
      { command: "test", arguments: ["--no-build", "--nologo"], environment: baseEnvironment },
      toolContext,
    );
    assert.equal(test.success, true, test.stderr || test.stdout);
  });
});

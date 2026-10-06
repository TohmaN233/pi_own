import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { compileWindowsNativeHelper } from "../packages/study-execution-host/src/windows-native-helper.ts";
import { runTrustedCommand } from "../packages/study-execution-host/src/environment-package-changes.ts";

const root = resolve(".artifacts/study-research/environment-command");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

test("trusted installer timeout, output overflow and lease loss await the complete Windows tree", { skip: process.platform !== "win32", timeout: 45000 }, async () => {
  await mkdir(root, { recursive: true });
  const fixture = join(root, "nested-installer.mjs");
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const [directory, level, mode] = process.argv.slice(2);",
    "writeFileSync(join(directory, level+'.json'), JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));",
    "if(level==='0') writeFileSync(join(directory,'installer-mutated.json'), JSON.stringify({mutatedAt:new Date().toISOString()}));",
    "if(Number(level)<2) spawn(process.execPath,[process.argv[1],directory,String(Number(level)+1),mode],{stdio:'ignore',windowsHide:true});",
    "setInterval(()=>{if(level==='0'&&mode==='output'&&existsSync(join(directory,'2.json'))) process.stdout.write('x'.repeat(65536));},100);",
  ].join("\n"));
  const evidence = [];
  for (const mode of ["timeout", "output", "lease"]) {
    const directory = join(root, `${mode}-${Date.now()}`); await mkdir(directory);
    let leaseFailed = false;
    const registrations = [];
    await assert.rejects(runTrustedCommand(process.execPath, [fixture, directory, "0", mode], {}, () => {
      if (mode === "lease" && existsSync(join(directory, "2.json"))) { leaseFailed = true; throw new Error("fixture lease lost"); }
    }, { timeoutMs: mode === "timeout" ? 2000 : 10000, outputLimitBytes: mode === "output" ? 8192 : 1048576, heartbeatMs: 100 }, {
      supervisorDirectory: directory,
      onStarted(identity) {
        const registration = { ...identity, registeredAt: new Date().toISOString() };
        registrations.push(registration);
        writeFileSync(join(directory, "durable-registration.json"), JSON.stringify(registration));
      },
    }),
    (error) => error.code === ({timeout:"PACKAGE_COMMAND_TIMEOUT", output:"PACKAGE_COMMAND_OUTPUT_LIMIT", lease:"PACKAGE_WORKER_LEASE_FAILED"})[mode]);
    assert.equal(registrations.length, 1, `${mode} must register one supervisor before releasing the installer`);
    const mutation = JSON.parse(readFileSync(join(directory, "installer-mutated.json"), "utf8"));
    assert.ok(mutation.mutatedAt >= registrations[0].registeredAt, `${mode} installer mutated before durable registration`);
    const processes = [0,1,2].map((level) => JSON.parse(readFileSync(join(directory, `${level}.json`), "utf8")));
    for (const process of processes) {
      for (let retry = 0; retry < 30 && alive(process.pid); retry++) await delay(100);
      assert.equal(alive(process.pid), false, `${mode} retained descendant ${process.pid}`);
    }
    if (mode === "lease") assert.equal(leaseFailed, true);
    evidence.push({ mode, registrations, processes, allExited: true });
  }
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
});

test("a failed durable registration leaves the gated installer suspended and unmodified", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const directory = join(root, `registration-failure-${Date.now()}`); await mkdir(directory, { recursive: true });
  const fixture = join(directory, "would-mutate.mjs");
  await writeFile(fixture, [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.argv[2], 'mutated.json'), String(process.pid));",
    "setInterval(()=>{}, 1000);",
  ].join("\n"));
  await assert.rejects(
    runTrustedCommand(process.execPath, [fixture, directory], {}, undefined, { timeoutMs: 10000, outputLimitBytes: 1024, heartbeatMs: 100 }, {
      supervisorDirectory: directory,
      onStarted() { throw new Error("fixture durable store rejected registration"); },
    }),
    (error) => error.code === "PACKAGE_DURABLE_REGISTRATION_FAILED",
  );
  await delay(250);
  assert.equal(existsSync(join(directory, "mutated.json")), false, "installer ran even though durable registration failed");
});

test("a gated supervisor preserves the trusted command environment after durable registration", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const directory = join(root, `environment-propagation-${Date.now()}`); await mkdir(directory, { recursive: true });
  const registrations = [], exits = [];
  const result = await runTrustedCommand(
    process.execPath,
    ["--input-type=module", "--eval", "process.stdout.write(process.env.PI_ENVIRONMENT_SUPERVISOR_PROBE ?? 'missing')"],
    { PI_ENVIRONMENT_SUPERVISOR_PROBE: "gated-environment-propagated" },
    undefined,
    { timeoutMs: 10000, outputLimitBytes: 1024, heartbeatMs: 100 },
    {
      supervisorDirectory: directory,
      onStarted(identity) { registrations.push(identity); },
      onExited(identity) { exits.push(identity); },
    },
  );
  assert.equal(result.stdout, "gated-environment-propagated");
  assert.equal(registrations.length, 1, "the probe must cross a registered supervisor gate");
  assert.deepEqual(exits, registrations, "the registered supervisor must report its durable exit identity");
  await writeFile(join(directory, "environment-propagation-evidence.json"), JSON.stringify({ registrations, exits, stdout: result.stdout }, null, 2));
});

test("a worker crash after supervisor readiness but before durable registration never releases the installer", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const directory = join(root, `worker-crash-before-registration-${Date.now()}`); await mkdir(directory, { recursive: true });
  const installer = join(directory, "would-mutate.mjs");
  await writeFile(installer, [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.argv[2], 'mutated.json'), String(process.pid));",
  ].join("\n"));
  const commandModule = pathToFileURL(resolve("packages/study-execution-host/src/environment-package-changes.ts")).href;
  const worker = join(directory, "crashing-worker.mjs");
  await writeFile(worker, [
    `import { runTrustedCommand } from ${JSON.stringify(commandModule)};`,
    `void runTrustedCommand(process.execPath, [${JSON.stringify(installer)}, ${JSON.stringify(directory)}], {}, undefined, { timeoutMs: 1000, outputLimitBytes: 1024, heartbeatMs: 100 }, {`,
    `  supervisorDirectory: ${JSON.stringify(directory)},`,
    "  onStarted() { process.exit(17); },",
    "});",
  ].join("\n"));
  const crashed = spawn(process.execPath, [worker], { windowsHide: true, stdio: "ignore" });
  const exitCode = await new Promise((ready) => crashed.once("close", ready));
  assert.equal(exitCode, 17, "fixture worker must die at the pre-registration boundary");
  await delay(1500);
  assert.equal(existsSync(join(directory, "mutated.json")), false, "worker death released an installer that was not durably registered");
  assert.equal(existsSync(join(directory, "supervisor.ready.json")), true, "supervisor did not retain pre-release readiness evidence");
});


test("a verified cached supervisor registers before mutation at operation gate paths beyond MAX_PATH", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const prefix = join(root, `long-path-${Date.now()}`);
  assert.ok(prefix.length < 240, "the fixture root must leave room for a bounded long-path component");
  const directory = join(prefix, "owned-".repeat(30).slice(0, 245-prefix.length-1));
  await mkdir(directory, {recursive:true});
  const ready = join(directory, "supervisor.ready.json"), release = join(directory, "supervisor.release");
  assert.ok(ready.length > 260 && release.length > 260, "the fixture must cover .NET gate paths beyond MAX_PATH");
  let executable;
  const registrations = [], exits = [], mutation = join(directory, "mutation.json");
  const result = await runTrustedCommand(process.execPath, ["--input-type=module", "--eval",
    "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1],JSON.stringify({mutatedAt:new Date().toISOString()}));process.stdout.write('long-path-gated-success');", mutation], {}, undefined,
    {timeoutMs:10000,outputLimitBytes:1024,heartbeatMs:100}, {
      supervisorDirectory:directory,
      onStarted(identity) {
        executable = identity.supervisorExecutablePath;
        assert.ok(executable.startsWith(join(process.env.LOCALAPPDATA,"pi-own","native")) && executable.length < 260, "the durable identity retains a verified short application-cache executable");
        assert.equal(existsSync(mutation), false, "the installer must remain suspended before durable registration");
        const registration={...identity,registeredAt:new Date().toISOString()};
        writeFileSync(join(directory,"registration.json"),JSON.stringify(registration));registrations.push(registration);
      },
      onExited(identity) {exits.push(identity);},
    });
  assert.equal(result.stdout,"long-path-gated-success");
  assert.equal(registrations.length,1);assert.equal(exits.length,1);
  assert.equal(exits[0].supervisorExecutablePath,executable);
  assert.equal(exits[0].processCreationIdentity,registrations[0].processCreationIdentity);
  assert.ok(JSON.parse(readFileSync(mutation,"utf8")).mutatedAt >= registrations[0].registeredAt);
  assert.ok(existsSync(ready) && existsSync(release), "long gate paths retain the durable handshake evidence");
  assert.match(readFileSync(`${executable}.config`,"utf8"),/Switch.System.IO.BlockLongPaths=false/);
  assert.match(readFileSync(join(dirname(executable),"environment-package-supervisor.manifest"),"utf8"),/<ws2:longPathAware>true/);
});


test("native helper cache publication converges and corrupt settings fail without replacement", {skip:process.platform !== "win32",timeout:15000}, async(t)=>{
  await mkdir(root,{recursive:true});
  const sourcePath=join(root,"cache-fixture.cs");
  await writeFile(sourcePath,`using System;public static class CacheFixture{public static void Main(){Console.Write("cache-fixture");}} // fresh publication ${Date.now()}`);
  const options={compilerPath:join(process.env.SystemRoot ?? "C:\\Windows","Microsoft.NET","Framework64","v4.0.30319","csc.exe"),sourcePath,
    name:"cache-fixture.exe",failure:message=>Object.assign(new Error(message),{code:"FIXTURE_COMPILE_FAILED"})};
  const [first,second]=await Promise.all([compileWindowsNativeHelper(options),compileWindowsNativeHelper(options)]);
  assert.equal(first,second,"concurrent builds retain one exact source-addressed helper");
  const retained=dirname(first),nativeRoot=resolve(process.env.LOCALAPPDATA,"pi-own","native"),capturedHash=basename(retained);
  t.after(async()=>{
    const info=await lstat(retained),physicalRoot=await realpath(nativeRoot),physicalDirectory=await realpath(retained);
    assert.ok(/^[a-f0-9]{64}$/.test(capturedHash) && dirname(retained)===nativeRoot && dirname(physicalDirectory)===physicalRoot && basename(physicalDirectory)===capturedHash && info.isDirectory() && !info.isSymbolicLink(),"fixture cleanup must remain inside its captured native-cache bundle");
    assert.equal(JSON.parse(readFileSync(join(retained,"identity.json"),"utf8")).identity,capturedHash);
    assert.equal(basename(first),"cache-fixture.exe","cleanup must never target a real runtime helper");
    await rm(retained,{recursive:true});
  });
  assert.deepEqual((await readdir(dirname(first))).sort(),["cache-fixture.exe","cache-fixture.exe.config","cache-fixture.manifest","identity.json"],"only verified runtime assets remain in the cache");
  const configPath=`${first}.config`,config=readFileSync(configPath,"utf8"),receipt=readFileSync(join(dirname(first),"identity.json"),"utf8");
  try {
    await writeFile(configPath,"corrupt fixture settings");
    await assert.rejects(compileWindowsNativeHelper(options),error=>error.code==="FIXTURE_COMPILE_FAILED" && /cache is corrupt/.test(error.message));
    assert.equal(readFileSync(configPath,"utf8"),"corrupt fixture settings","failed integrity must not rebuild over damaged retained assets");
    assert.equal(readFileSync(join(dirname(first),"identity.json"),"utf8"),receipt);
  } finally {await writeFile(configPath,config);}
  assert.equal(await compileWindowsNativeHelper(options),first);
  await writeFile(sourcePath,"invalid C# fixture source");
  await assert.rejects(compileWindowsNativeHelper(options),error=>error.code === "FIXTURE_COMPILE_FAILED" && /error CS[0-9]+/.test(error.message), "compiler stdout diagnostics must survive a failed build");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Demo launcher probes the base health endpoint and opens the session-specific URL", async () => {
  const source = await readFile(new URL("../start-learning-harness.ps1", import.meta.url), "utf8");
  assert.match(source, /Start-Job -ArgumentList \$baseUrl, \$launchUrl/);
  assert.match(source, /param\(\[string\] \$healthUrl, \[string\] \$openUrl\)/);
  assert.match(source, /Invoke-WebRequest -Uri "\$healthUrl\/api\/harness\/status"/);
  assert.match(source, /Start-Process \$openUrl/);
  assert.doesNotMatch(source, /"\$launchUrl\/api\/harness\/status"/);
  assert.match(source, /\$demoSeedResult = \(\$demoOutput/);
  assert.doesNotMatch(source, /\$demo = \(\$demoOutput/);
  assert.match(source, /if \(-not \$Demo -and -not \$CheckOnly\) \{/);
  assert.match(source, /if \(\$healthyHarnessAlreadyRunning\) \{[\s\S]*Start-Process \$launchUrl[\s\S]*return/);
  assert.match(source, /--lookup-only --data-dir \$dataDirectory/);
  assert.match(source, /Assert-RunningDemoSession \$demoLookupResult\.sessionId \$demoLookupResult\.courseVersionId/);
  assert.match(source, /if \(\$Demo\) \{[\s\S]*Get-ExistingDemoSeed[\s\S]*return/);
});

test("healthy Demo lookup opens the database read-only before normal seeding can create state", async () => {
  const source = await readFile(new URL("./seed-learning-harness-demo.mjs", import.meta.url), "utf8");
  assert.match(source, /new DatabaseSync\(databasePath, \{ readOnly: true \}\)/);
  assert.match(source, /if \(process\.argv\.includes\("--lookup-only"\)\) \{[\s\S]*lookupExistingDemo\(databasePath\)[\s\S]*\} else \{\s*await mkdir/);
});

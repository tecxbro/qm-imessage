import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  constructAdvanced,
  constructSpectrum,
  narrowSpectrum,
  PUBLIC_DECLARATION_CHECKS,
} from "../src/provider/compatibility.ts";
import { METHOD_MATRIX, PROVIDER_VERSIONS } from "../src/provider/capabilities.ts";
import { PHOTON_PRESENTATION_OPERATIONS } from "../../chassis/src/photon-contract.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("installed versions and every operation are represented in the method matrix", () => {
  for (const [name, version] of [
    ["spectrum-ts", PROVIDER_VERSIONS.spectrum],
    ["@photon-ai/advanced-imessage", PROVIDER_VERSIONS.advanced],
  ]) {
    const installed = JSON.parse(readFileSync(resolve(root, "node_modules", name!, "package.json"), "utf8"));
    assert.equal(installed.version, version);
  }
  assert.deepEqual(
    METHOD_MATRIX.map((entry) => entry.name),
    [...PHOTON_PRESENTATION_OPERATIONS],
  );
  assert.ok(METHOD_MATRIX.every((entry) => entry.device === "unverified"));
});

test("constructs and closes real pinned Advanced and Spectrum clients without credentials or writes", async () => {
  const advanced = constructAdvanced({ address: "127.0.0.1:1", token: "offline-test-token" });
  assert.equal(typeof advanced.events.catchUp, "function");
  assert.equal(typeof advanced.messages.sendCustomizedMiniApp, "function");
  await advanced.close();
  const app = await constructSpectrum({ address: "127.0.0.1:1", token: "offline-test-token", phone: "+15550000001" });
  try {
    const scoped = narrowSpectrum(app);
    assert.equal(typeof scoped.space.get, "function");
    assert.equal(typeof scoped.getAttachment, "function");
  } finally {
    await app.stop();
    await app.stop();
  }
});

test("records the shipped Spectrum configuration declaration defect instead of claiming type compatibility", () => {
  const filename = resolve(root, "test", "spectrum-public-contract-probe.ts");
  const source =
    'import { Spectrum } from "spectrum-ts"; import { imessage } from "spectrum-ts/providers/imessage"; void Spectrum({ providers: [imessage.config({ clients: [{address: "127.0.0.1:1", token: "offline", phone: "+15550000001"}] })] });';
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === filename
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === filename);
  assert.equal(PUBLIC_DECLARATION_CHECKS.spectrumDeclarationCompatible, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 2345 && ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").includes("never"),
    ),
  );
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 2769));
});

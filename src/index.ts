// The package root: everything needed to build, sign, verify and run an archive
// from code, and nothing that needs a flag to import.
//
// The two VFS providers are deliberately *not* re-exported here. Importing
// either needs `node:vfs`, which only exists under `--experimental-vfs`, and
// creating or verifying an archive does not — so a plain `import
// '@pipobscure/bundle'` must not drag that requirement in. They have their own
// entry points:
//
//   @pipobscure/bundle/provider   the verifying provider, and register()
//   @pipobscure/bundle/register   a preload that registers it and nothing else
//   @pipobscure/bundle/recorder   the recording provider, and register()
//   @pipobscure/bundle/record     a preload that registers it and nothing else

// The high-level drive: create, sign, verify, inspect, run.
export {
    createBundle,
    signBundle,
    verifyBundle,
    verifyBundleSync,
    inspectBundle,
    runBundle,
    fileSigner,
    mountArgv,
    registerPath,
    type BuildResult,
    type CreateOptions,
    type SignOptions,
    type VerifyBundleOptions,
    type RunOptions,
    type RunResult,
    type Inspection,
} from './api.ts';

// The archive layer, for callers assembling members themselves.
export {
    bundle,
    rebundle,
    createArchive,
    keySigner,
    members,
    fromDirectory,
    fromArchive,
    type Member,
    type Signer,
    type Signature,
    type EmitResult,
    type BundleOptions,
    type RebundleOptions,
} from './archive.ts';

// The format layer: the manifest, the signature marker, and verification.
export {
    AUTHORITY,
    buildManifest,
    parseManifest,
    parseSignature,
    formatSignature,
    signatureOf,
    verify,
    verifySync,
    STATES,
    type ArchiveSource,
    type ManifestFields,
    type SignatureMarker,
    type VerificationResult,
    type VerificationState,
    type VerifyOptions,
} from './manifest.ts';

// Working out what belongs in an archive, for what observing a run cannot see.
export {
    walk,
    moduleFiles,
    dependencyFiles,
    packageRoot,
    moduleDir,
    type WalkOptions,
    type ModuleFilesOptions,
} from './files.ts';

// Installing the auditing skill into a project.
export {
    skills,
    skill,
    install as installSkill,
    DEFAULT_SKILLS_DIR,
    type SkillInfo,
    type InstallResult,
} from './skill.ts';

// The CLI, as a function — so a host can offer the same commands without
// spawning anything.
export { main as cli, USAGE, type Console as CliConsole } from './cli.ts';

// Signing through sigstore, and the OIDC flows that identity comes from. Both
// are namespaced: they are a signer implementation and its plumbing, not part
// of the archive format, and naming them that way keeps that visible.
export * as sigstore from './sigstore.ts';
export * as oidc from './oidc.ts';

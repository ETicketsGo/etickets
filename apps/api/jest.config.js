/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  collectCoverageFrom: ['**/*.ts', '!**/*.module.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  /*
    Never let Jest run this suite IN BAND.

    Jest picks `cpus - 1` workers, and a two-core CI runner therefore picks one -- at which
    point Jest stops forking and runs the tests in its own process. That is the difference
    between a suite that exits and one that does not: the application leaves handles open
    that survive `moduleRef.close()`, and a worker child gets torn down regardless while the
    main process has to close them itself and cannot.

    The symptom is brutal to diagnose from outside. Every test passes -- 2,906 of them, in
    seventy-five seconds -- and then the process simply never returns, so the step burns its
    entire budget and reports a timeout with a green suite inside it. Twice, before it was
    understood, that looked like the tests themselves hanging.

    Two workers is enough to force forking. It is not a fix for the leak, which is real and
    still worth finding; it stops the leak from deciding whether CI can finish.

    ── WHY THIS READS THE CPU COUNT AND NOT `process.env.CI` ────────────────────────
    Because it did read `process.env.CI`, and that variable never arrived. Turbo runs in
    strict environment mode by default: a task sees only what `turbo.json` declares in
    `globalEnv`, and `CI` is not declared. So the guard silently evaluated false in the one
    place it existed for, and the suite went on hanging while a local run -- which invokes
    jest directly, with the variable present -- proved nothing.

    The cpu count is a property of the machine and is always readable. On a two-core runner
    this returns 2 and forces forking; on an eight-core laptop it returns 7, exactly what
    Jest would have chosen anyway.
  */
  maxWorkers: Math.max(2, require('node:os').cpus().length - 1),
  moduleNameMapper: {
    '^@eticketsgo/shared-types$': '<rootDir>/../../../packages/shared-types/src/index.ts',
    '^@eticketsgo/validation$': '<rootDir>/../../../packages/validation/src/index.ts',
  },
};

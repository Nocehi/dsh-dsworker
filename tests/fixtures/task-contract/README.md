# Donor fixture provenance

`python-argv-lexer.input.json` was manually derived from the task with id
`python-argv-lexer` in an external read-only donor corpus.

Only task authority was copied: exact objective, `lexer.py` change scope,
`test_lexer.py` immutable digest, semantic/validation unittest argv, and finish
compile argv. No ds-worker implementation, runtime import, generated workspace,
or dependency is present here. The dsh-dsworker-specific 60-second command
bound, structural cwd, expected exit, terminal policy, and explicit retry-none
policy are new v1 authority fields because the donor shell strings do not carry
those semantics.

`python-argv-lexer.canonical.json` is the exact compact canonical authority plus
one repository text-file newline. The newline is not hashed.
`python-argv-lexer.sha256` pins the SHA-256 over only the canonical JSON bytes.

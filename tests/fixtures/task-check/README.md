# Task-check fixture provenance

The python-argv-lexer files are the minimum runnable fixture corresponding to
the already-reviewed dsh-dsworker TaskContract donor fixture. lexer.initial.py
and test_lexer.py preserve the source strings from that read-only external
donor task, while lexer.green.py is a small compliant repair used only to prove
deterministic checking.

Tests copy these files to disposable /tmp/dsh-dsworker-* workspaces. The
task-check packages do not read the donor repository or this provenance file at
runtime.

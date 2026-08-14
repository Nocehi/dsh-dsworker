# Provenance notice

`dsh-dsworker` is an independent project. It uses public extension and service
seams from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
which remains an external dependency and retains its own copyright and license.
DeepSeek Harness source is not vendored in this repository.

This project is not official DeepSeek software and does not imply endorsement
by DeepSeek. No DeepSeek Harness source files were copied into this project;
the local packages implement out-of-tree adapters, policy, checking, and worker
lifecycle code against the pinned `@deepseek-ai/dsh@0.1.0-rc.6` package API.

# Reuse Ollama Cloud across environments

English | [中文](ollama-cloud-profiles.zh.md)

## Summary

Install the fork's [Ollama Cloud preset](../../.fork/providers/ollama-cloud.yml) into existing DSH profiles with one command. It declares image support, reasoning levels, and image budgets together; credentials remain environment-local. This guide targets an installed dsh 0.2.1-rc.2 CLI on PATH and Node.js. A fresh fork checkout needs no dependency installation.

## Table of Contents

- [Install or update](#install)
- [Declared capabilities](#capabilities)
- [Validate and recover](#validation)
- [Dev Note](#notes)

<a id="install"></a>

## Install or update

1. Provide `OLLAMA_API_KEY` through the environment's DSH credential store or credential environment. Run from a checkout containing the fork's `fork-tooling` branch; the preset contains no credentials.
2. Install into every existing profile under `$DSH_HOME/profiles` (default: `~/.dsh/profiles`) and select Flash as the default model:

   ```bash
   node scripts/fork-provider-preset.mjs --default
   ```

3. Restart the affected profile process to load its startup configuration. In BB, a newly started dsh process loads it; another message to an already running process does not guarantee a reload.

Omit `--default` to retain existing model selections. Use `--profile acp` for one profile, repeat the option for several, or use `--home /path/to/dsh-home` for another home. Profiles must already exist; the installer does not provision their packages. After updating the fork checkout on another environment, repeat the same command.

The installer replaces only the `ollama-cloud` provider declaration in each selected `cordis.patch.yml`, preserving other providers, comments, executable `!!js` settings, permissions, and credentials. With `--default`, it also sets `acp` defaults for profiles declaring the ACP app bundle, or `agent-default-model` for other profiles. This preset owns the complete declaration for that provider id: keep custom Ollama endpoints or extra models in a separate preset.

<a id="capabilities"></a>

## Declared capabilities

| Setting | Flash | Pro 0813 |
| --- | --- | --- |
| Exact model id | `deepseek-v4.1-flash` | `deepseek-v4-pro:0813` |
| Input modalities | `text`, `image` | `text` |
| Effort menu → API value | `off` → `none`, `high` → `high`, `max` → `max` | Same |
| Default effort | `max` | `max` |
| Configured context window | 524,288 tokens | 1,048,576 tokens |
| Maximum output reservation | 65,536 tokens | 65,536 tokens |

Flash uses a conservative 524,288-token working window, although current cloud metadata advertises 1,048,576. `maxRequestImageBytes: 4194304` caps retained inline base64 image data at 4 MiB; `requestImageMaxBytes: 1048576` is a separate per-image encoding target, and `requestImagePixelBudget: 4194304` is a per-image pixel budget. These do not cap the complete HTTP body. The image-offload plugin replaces the oldest retained image occurrences with references when the image budget is exceeded; stored attachments remain available for rereading.

Declare capabilities for each exact model id. A hand-entered model without `reasoningEfforts` has no effort menu; one without `input: [text, image]` cannot accept images. Declaring support does not add it to a text-only endpoint. Verify the actual route's metadata and API behavior before changing this preset; similar names are insufficient. See [provider configuration](../user/guide/providers.md) for field semantics.

<a id="validation"></a>

## Validate and recover

Check every profile against the committed preset without changing it:

```bash
node scripts/fork-provider-preset.mjs --check
```

An up-to-date profile prints `current`; drift prints `needs update` and exits nonzero. Installation composes the candidate through `dsh --dump-config` before replacement. The original file is kept once as `cordis.patch.yml.before-ollama-preset`; restore it and restart the profile to undo installation. Repeating installation with identical settings leaves both files unchanged. This checks local composition and preset drift, not cloud credentials or continuing service availability.

Cloud verification on 2026-10-19 confirmed vision for Flash, text-only input for Pro 0813, and acceptance of `none`, `high`, and `max` effort values for both. A screenshot-heavy request returned HTTP 413 at approximately 7.57 MB; removing ten oldest image occurrences returned HTTP 200 at 5.44 MB, and retaining all thirty images with smaller encodings returned HTTP 200 at 3.76 MB. These observations are not a published Ollama limit. The 4 MiB image budget is a tested operating choice, not a guarantee for arbitrarily large text histories. A later 413 requires shrinking the complete request; this dsh version does not automatically recover from a provider-returned 413.

Installer smoke tests use temporary homes and the installed CLI, without cloud calls:

```bash
node --test scripts/fork-provider-preset.test.mjs
```

<a id="notes"></a>

## Dev Note

None.

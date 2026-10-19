# 在多个环境中复用 Ollama Cloud

[English](ollama-cloud-profiles.md) | 中文

## 概要

用一条命令将 Fork 的 [Ollama Cloud 预设](../../.fork/providers/ollama-cloud.yml) 安装到已有 DSH profile。它统一声明图片支持、推理等级和图片预算，凭据仍由各环境独立保存。本指南适用于 PATH 中已有 dsh 0.2.1-rc.2 CLI（命令行界面）和 Node.js 的环境。新克隆的 Fork checkout 不需要安装依赖。

## 目录

- [安装或更新](#install)
- [能力声明](#capabilities)
- [验证与恢复](#validation)
- [开发备注](#notes)

<a id="install"></a>

## 安装或更新

1. 在目标环境的 DSH 凭据存储或凭据环境中提供 `OLLAMA_API_KEY`。从包含 Fork 的 `fork-tooling` 分支的 checkout 中运行命令；预设不包含凭据。
2. 安装到 `$DSH_HOME/profiles`（默认为 `~/.dsh/profiles`）下所有已有 profile，并选择 Flash 作为默认模型：

   ```bash
   node scripts/fork-provider-preset.mjs --default
   ```

3. 重启受影响的 profile 进程以加载启动配置。在 BB 中，新启动的 dsh 进程会加载配置；仅给已经运行的进程再发一条消息，不保证触发重新加载。

要保留已有模型选择，省略 `--default`。用 `--profile acp` 选择单个 profile，重复该选项可选择多个；用 `--home /path/to/dsh-home` 选择另一 home。profile 必须已经存在；安装命令不负责准备其依赖包。在另一环境更新 Fork checkout 后，重复运行同一条命令即可。

安装命令只替换所选 `cordis.patch.yml` 中的 `ollama-cloud` 提供商声明，保留其他提供商、注释、可执行的 `!!js` 设置、权限和凭据。带上 `--default` 时，还会为声明了 ACP（Agent Client Protocol）应用 bundle 的 profile 设置 `acp` 默认模型，为其他 profile 设置 `agent-default-model`。本预设负责这个提供商 id 的完整声明：自定义 Ollama 地址或额外模型应放在单独的预设中。

<a id="capabilities"></a>

## 能力声明

| 配置项 | Flash | Pro 0813 |
| --- | --- | --- |
| 精确模型 id | `deepseek-v4.1-flash` | `deepseek-v4-pro:0813` |
| 输入模态 | `text`、`image` | `text` |
| 推理菜单 → API 值 | `off` → `none`、`high` → `high`、`max` → `max` | 相同 |
| 默认推理等级 | `max` | `max` |
| 配置的上下文窗口 | 524,288 token | 1,048,576 token |
| 最大输出预留 | 65,536 token | 65,536 token |

Flash 使用保守的 524,288-token 工作窗口，尽管当前云端元数据声明的是 1,048,576。`maxRequestImageBytes: 4194304` 将保留的内联 base64 图片数据限制在 4 MiB；`requestImageMaxBytes: 1048576` 是独立的单图编码目标，`requestImagePixelBudget: 4194304` 是单图像素预算。这些配置不限制完整 HTTP 请求体。超过图片预算时，图片卸载插件将最旧的图片引用替换为文字引用；存储中的附件仍可重新读取。

为每个精确模型 id 声明能力。手动录入的模型若没有 `reasoningEfforts`，就没有推理等级菜单；没有 `input: [text, image]` 就不能接受图片。声明能力不会让纯文本端点获得图片支持。修改本预设前，应验证实际路由的元数据和 API 行为，不能仅凭模型名字相似就复制声明。各字段的含义见[提供商配置](../user/guide/providers.zh.md)。

<a id="validation"></a>

## 验证与恢复

检查所有 profile 是否与已提交的预设一致，不修改文件：

```bash
node scripts/fork-provider-preset.mjs --check
```

已同步的 profile 输出 `current`；存在差异时输出 `needs update` 并以非零状态退出。安装时，先通过 `dsh --dump-config` 组合候选配置，再替换文件。首次安装会将原文件保留为 `cordis.patch.yml.before-ollama-preset`；恢复该文件并重启 profile，即可撤销安装。相同设置重复安装不会改动配置文件或备份。这项检查验证本地配置组合和预设差异，不验证云端凭据或服务后续是否可用。

2026-10-19 的云端验证确认 Flash 支持图片、Pro 0813 仅支持文本，两者都接受 `none`、`high` 和 `max` 推理值。截图较多的请求在约 7.57 MB 时返回 HTTP 413；移除最旧的十个图片引用后，5.44 MB 返回 HTTP 200；保留全部三十张图片但缩小编码后，3.76 MB 返回 HTTP 200。这些观测值不是 Ollama 公布的限制。4 MiB 图片预算是已测试的运行选择，不能保证任意长的文本历史都能发送。后续若仍遇到 413，需要缩减完整请求；这个 dsh 版本不会自动恢复提供商返回的 413。

安装命令的冒烟测试使用临时 home 和已安装的 CLI，不调用云端：

```bash
node --test scripts/fork-provider-preset.test.mjs
```

<a id="notes"></a>

## 开发备注

无。

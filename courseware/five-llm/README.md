# 弈境结构精读 · 互动课件

精读弈境（`apps/five-llm`）的技术白皮书和后续设计记录。弈境是一个人机五子棋桌面应用，机器棋手是一个 LLM，必须通过工具调用才能落子。

- **10 课 · 4 步**：问题与全景 → 循环工程 → 业务层与上下文 → 证据、界面与复盘。
- **每课**：结构图、互动演示、自测题。
- **按代码现状讲**：白皮书 v1.0 之后代码又改过（工具 6 → 8 个、知识包升到 v3、新增连续冲四门禁），课程以提交 `4f65e37` 为快照，并标出白皮书哪里过时。

默认用法：AI 讲师打开 Chrome 带你走读课件，配语音讲解，遇到疑问会向右栏的 AI 助教提问。你也可以随时自己问助教。

## 需要

- [uv](https://docs.astral.sh/uv/)
- [just](https://just.systems)，版本 ≥ 1.54
- Chrome
- 你自己的 DeepSeek API Key

## 配置 API Key

在本目录（`courseware/five-llm/`）运行：

```bash
cp lessons/.env.sample lessons/.env
```

打开 `lessons/.env`，填入你的 key：

| 变量 | 是否必须 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 必须 | AI 助教答疑、联网查资料；AI 讲师代你向助教提问 |
| `MOONSHOT_API_KEY` | 可选 | 只用于“换个讲法”（R 键），不填就用 DeepSeek。要用 Kimi Code 会员的 key，开放平台的 key 不行 |

DeepSeek key 在 https://platform.deepseek.com/api_keys 申请，按量计费，要先充值。`.env` 已被 `.gitignore` 排除，不会提交。

## 开始上课

`justfile` 在 `lessons/` 里，下面的命令都在 `lessons/` 目录运行：

```bash
cd lessons
```

第一次先合成讲师语音（edge-tts，免费，要联网）。语音文件不在仓库里，克隆后要在本地生成：

```bash
just lecture-audio
```

然后开课：

```bash
just course --lecture
```

第一次启动时，uv 会自动安装依赖，需要几十秒。不用手动跑 `uv sync`。

上课时的按键：

| 按键 | 作用 |
|---|---|
| 空格 | 暂停 / 继续 |
| ← / → | 上一步 / 下一步 |
| R | 换个讲法 |
| Esc | 离开输入框 |

你在右栏提问时，讲课会自动暂停，看完回答按空格继续。关掉浏览器窗口或按 Ctrl+C 结束。

## 常见问题

- **提示没有 key**：检查 `lessons/.env` 是否存在，`DEEPSEEK_API_KEY=` 后面有没有填。
- **提示 DeepSeek 不认 key**：key 填错了，或者余额不足。
- **讲师没有声音**：还没合成语音，在 `lessons/` 里先跑 `just lecture-audio`。
- **找不到 Chrome**：运行 `cd lessons/lecturer && uv run playwright install chromium`。
- **端口被占用**：加 `--port 9000` 换个端口。
- **just 不认识 `[continue]`**：just 版本太老，升级到 1.54 以上。
- **just 提示没有 `course` 这个命令**：没在 `lessons/` 目录里运行，just 找到的是仓库根目录的 justfile。

## 目录与维护

| 路径 | 内容 |
|---|---|
| `lessons/index.html` | 课件首页；`L01–L10` 课程页、`glossary.html` 术语表、`notes.html` 学习笔记 |
| `lessons/lecturer/` | AI 讲师：`scripts/` 讲稿、`pronounce.json` 缩写和英文词的读法（改了要重跑 `just lecture-audio`） |
| `lessons/tools/` | `serve.py` 本地服务与助教转发，`course.py` 一键启动课程和讲师，`sources.json` 课程配置与助教资料清单，`check_page.py` 页面检查，`finalize.mjs` 术语合并 |
| `lessons/AUTHORING.md` | 课程编写规范 |
| `docs/articles/` | 原文：白皮书 v1.0、代码现状勘误（`code-status.md`）、L3 v2/v3 设计记录、L3 重构说明（助教使用） |

在 `lessons/` 里运行 `just` 可以看到全部命令，包括讲稿自检 `just lecture-check`。

## 说明

课程讲的是本仓库的 `apps/five-llm`。白皮书与代码现状勘误冲突时，以勘误为准。标为“补充”的部分是课程作者的解释，不是原文观点。

---

不想听语音，可以只开课件和 AI 助教：在 `lessons/` 里运行 `just course`，然后打开 http://127.0.0.1:8772/lessons/ 。

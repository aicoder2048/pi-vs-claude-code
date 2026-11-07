# 边牧结构精读（tilldone-desk 互动课程）

精读《边牧（TillDone Desk）结构梳理》（`docs/articles/tilldone-desk-anatomy.md`）的中文互动自学课件。

- **7 课**：边牧全景 → 两套四层 → 什么进模型的上下文 → 两种注入策略与抗压缩 → TillDone 的原生拆分 → PStack 与 TillDone 的咬合 → 坑、开放问题与全课复盘。
- **每课**：图文课程、可操作的互动演示、自测题；另有术语表和学习笔记页。

默认用法：AI 讲师打开 Chrome 带你走读课件，配语音讲解，遇到疑问会向右栏的 AI 助教提问。你也可以随时自己问助教。

## 需要

- [uv](https://docs.astral.sh/uv/)
- [just](https://just.systems)，版本 ≥ 1.54
- Chrome
- 你自己的 DeepSeek API Key

## 配置 API Key

下面的命令都在课程目录 `courseware/tilldone-desk/lessons/` 里运行（`justfile` 在这里）：

```bash
cd courseware/tilldone-desk/lessons
cp .env.sample .env
```

打开 `.env`，填入你的 key：

| 变量 | 是否必须 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 必须 | AI 助教答疑、联网查资料；AI 讲师代你向助教提问 |
| `MOONSHOT_API_KEY` | 可选 | 只用于“换个讲法”（R 键），不填就用 DeepSeek。要用 Kimi Code 会员的 key，开放平台的 key 不行 |

DeepSeek key 在 https://platform.deepseek.com/api_keys 申请，按量计费，要先充值。`.env` 已被 `.gitignore` 排除，不会提交。

## 开始上课

第一次先合成讲师语音（edge-tts，免费，要联网；7 课约 7 分钟）。语音文件不在仓库里，克隆后要在本地生成：

```bash
just lecture-audio
```

然后开课：

```bash
just course --lecture
```

第一次启动时，uv 会自动安装依赖，需要几十秒。不用手动跑 `uv sync`。不先合成语音也能讲，只是每步开口前要等一下。

上课时的按键（焦点不在输入框时）：

| 按键 | 讲课时 | 朗读助教回答时 |
|---|---|---|
| 空格 | 暂停 / 继续 | 暂停 / 继续朗读 |
| → | 下一步 | 跳过朗读，回到讲师 |
| ← | 上一步 | 这条回答从头再读 |
| R | 换个讲法 | — |
| Esc | 离开输入框 | 跳过朗读 |

你在右栏提问时，讲课会自动暂停，看完回答按空格继续。每条助教回答底部有“🔊 朗读这条”，可以重听。关掉浏览器窗口或按 Ctrl+C 结束。

## 常见问题

- **提示没有 key**：检查 `lessons/.env` 是否存在，`DEEPSEEK_API_KEY=` 后面有没有填。
- **提示 DeepSeek 不认 key**：key 填错了，或者余额不足。
- **讲师开口很慢**：还没合成语音，先跑 `just lecture-audio`。
- **找不到 Chrome**：在 `lessons/` 里运行 `cd lecturer && uv run playwright install chromium`。
- **端口被占用**：加 `--port 9000` 换个端口。
- **just 不认识 `[continue]`**：just 版本太老，升级到 1.54 以上。
- **不想让助教联网**：在 `.env` 里写 `DEEPSEEK_WEB=off`。

## 目录与维护

| 路径 | 内容 |
|---|---|
| `lessons/index.html` | 课件首页；`L01–L07` 课程页、`glossary.html` 术语表、`notes.html` 学习笔记 |
| `lessons/lecturer/` | AI 讲师：`scripts/` 讲稿（离线写好，上课时模型不现场主讲），`audio/` 合成的语音（每课约 5 MB，不进 git） |
| `lessons/tools/` | `serve.py` 本地服务与助教转发，`course.py` 一键启动，`check_page.py` 页面检查，`finalize.mjs` 术语合并 |
| `lessons/AUTHORING.md` | 课程编写规范 |
| `docs/articles/` | 原文（助教的资料） |

在 `lessons/` 里运行 `just` 可以看到全部命令。开发者常用：

```bash
just lecture-check                                    # 讲稿自检，不调用模型
uv run --no-project python tools/serve.py --check     # 来源清单与漂移
cd lecturer && uv run pytest -q                       # 讲师单元测试
```

课程框架和讲师代码来自 interactive-courseware 模板，用它的 `scripts/sync_course.py` 升级。

## 说明

每课约 2 次“代问”，每次是一个 DeepSeek 请求；助教联网（DeepSeek Search / Fetch）也按量计费。key 只留在本机服务里，不进页面。

---

不想听语音，可以只开课件和 AI 助教：在 `lessons/` 里运行 `just course`，然后打开 http://127.0.0.1:8771/lessons/ 。

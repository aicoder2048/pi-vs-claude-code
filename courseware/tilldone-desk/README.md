# 边牧结构精读（tilldone-desk 互动课程）

7 课，精读《边牧（TillDone Desk）结构梳理》（`docs/articles/tilldone-desk-anatomy.md`）。
页面三栏：左边学习路线，中间图文课程和互动演示，右边 AI 助教。还可以让 AI 讲师带着读。

## 启动

需要 [uv](https://docs.astral.sh/uv/)、[just](https://github.com/casey/just) ≥ 1.54、本机 Chrome。

```bash
cd courseware/tilldone-desk/lessons
cp .env.sample .env        # 填你自己的 DEEPSEEK_API_KEY；.env 不进 git
just course                # 课程 + AI 助教：http://127.0.0.1:8771/lessons/
```

直接双击打开 HTML 也能学，只是没有 AI 助教。

## AI 助教

右栏的助教读过本课的原文和全部内容，可以选中正文提问、点图上的“问 AI”、让它出题。
模型是 DeepSeek（默认 `deepseek-flash`），走官方 API，**按量计费**。key 只留在本机服务里，不进页面。
助教答不了时会联网搜索（DeepSeek Search / Fetch，同样按量计费）；`.env` 里写 `DEEPSEEK_WEB=off` 关闭。

## AI 讲师

讲师打开浏览器，带你一课一课走读：滚动并高亮正在讲的地方，亲手操作演示，用语音讲解，遇到常见疑问就公开问助教。讲完一课自动进入下一课。

```bash
just lecture-audio         # 第一次先合成语音（edge-tts，免费，要联网；7 课约 7 分钟）
just course --lecture      # 课程 + 讲师，从 L01 开始
just course --lecture L03  # 从某一课开始
```

不先合成也能讲，讲师会边讲边合成，只是每步开口前要等一下。

控制键（焦点不在输入框时）：

| 按键 | 讲课时 | 朗读助教回答时 |
|---|---|---|
| 空格 | 暂停 / 继续 | 暂停 / 继续朗读 |
| → | 下一步 | 跳过朗读，回到讲师 |
| ← | 上一步 | 这条回答从头再读 |
| `R` | 换个讲法 | — |
| `Esc` | 离开输入框 | 跳过朗读 |

右栏每条助教回答底部有“🔊 朗读这条”，随时可以重听。你自己在右栏提问时，讲课会暂停，讲师读完回答后等你按空格继续。

说明：

- 讲稿在 `lessons/lecturer/scripts/`，离线写好进仓库；上课时模型不现场主讲。
- 每课约 2 次“代问”，每次是一个 DeepSeek 请求（按量计费）。“换个讲法”有 Kimi key（`MOONSHOT_API_KEY`）时用 Kimi，没有就用 DeepSeek。
- 合成的语音在 `lessons/lecturer/audio/`，每课约 5 MB，不进 git。
- 讲稿自检（不调用模型）：`just lecture-check`。

## 开发者

```bash
cd courseware/tilldone-desk/lessons
uv run --no-project python tools/serve.py --check     # 来源清单与漂移
cd lecturer && uv run pytest -q                       # 讲师单元测试
```

课程框架和讲师代码来自 interactive-courseware 模板，用它的 `scripts/sync_course.py` 升级。

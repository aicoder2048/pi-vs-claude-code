# 公开象棋知识来源与使用边界

本轮于 **2026-10-30** 实际访问核对以下资源。不是把网上搜到的棋书直接塞进提示词，也没有下载整站文章或棋谱库。程序运行时使用本地结构化事实与自行撰写的说明。

## 已用于首批知识包

### 象棋百科全书 · ECCO 2004

- 总入口：https://www.xqbase.com/ecco.htm
- 编号与分类说明：https://www.xqbase.com/ecco/ecco_intro.htm
- A 类（飞相、起马、仕角炮、过宫炮等）：https://www.xqbase.com/ecco/ecco_a.htm
- B 类（中炮对反宫马及其他）：https://www.xqbase.com/ecco/ecco_b.htm
- C 类（中炮对屏风马）：https://www.xqbase.com/ecco/ecco_c.htm
- D 类（顺炮、列炮）：https://www.xqbase.com/ecco/ecco_d.htm
- E 类（仙人指路、对兵）：https://www.xqbase.com/ecco/ecco_e.htm

用途：核对常用开局名称及少量示例着法事实，独立转换为本项目坐标，逐手合法性验证；每个知识条目保留对应来源。没有复制原站的长篇说明、完整分类表、胜率统计、棋谱数据库、图片或二进制库。

**ECCO 是分类体系，不是最优着法引擎。** 它包含顺序型、过程型和局面型定义；当前只匹配少量示例局面，不声称完整实现 ECCO 编号。原站版权声明仍属原作者，未发现其明确授予完整网站内容任意打包再分发的许可，因此未做大规模抓取。

### Xiangqi · Gameplay

- https://en.wikipedia.org/wiki/Xiangqi#Openings
- https://en.wikipedia.org/wiki/Xiangqi#Middlegame_strategy
- https://en.wikipedia.org/wiki/Xiangqi#Endgame

用途：交叉核对常见开局、出子节奏、中路与侧翼、兵马协调、残局兑换与将帅协同等事实，独立撰写简短中文条件化建议。没有复制文章段落、图表或示例排局。原站文字授权和署名要求以其页面当前声明为准；若以后直接导入、翻译或改编原文，应另行满足相应授权与署名条件。

本包所有建议都附适用条件与例外；残局资料只作计划提示，不据此宣告理论例胜 / 例和。

### Chinese Chess Practical Dataset（CCPD）

- 作者署名：**Yu-Han Tseng and Bo-Nian Chen (2026), Chinese Chess Practical Dataset (CCPD)**。
- 仓库：https://github.com/Yvonne761/Chinese-Chess-Practical-Dataset
- 固定版本：`368a47a947773dd8692c026e286dd19b6277b993`。
- 许可：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，[完整法律文本](https://creativecommons.org/licenses/by/4.0/legalcode)；上游声明原样保存在 `src/data/ccpd/UPSTREAM-LICENSE.txt`，Copyright (c) 2026 Yu-Han Tseng。
- 修改：选取 `Dataset/開局/00000001.pgn`–`00000064.pgn`，Big5 解码，每局只保留前 20 半回合，转换为本应用 A0–I9 坐标并逐手合法重放；不导入评分、胜率或原局其余着法。保留逐文件路径/SHA-256、许可 SHA-256 和修改说明于 `openings.json`。
- 应用通过 `knowledge.ts` 的全盘局面匹配、对称与当前候选复查使用；不是让模型背棋谱，不声称最优或棋力提升。
- 构建复制原样许可、转换后 JSON 和本文到 `dist/`，随 asar 分发，保留署名、版本链接、许可链接和修改说明。正常 build/start 不联网；显式维护命令为 `bun scripts/import-ccpd.ts`。

64 个抽样文件中实际接受 **61 条**，`00000036/46/58.pgn` 因非标准初始阵型被拒绝（保留路径、哈希及理由，不放宽规则）。讨论稿的“64 局已导入”据实际数据修正。

当前共 **73 条路线 / 1360 个索引节点 / 7 个来源**；节点包括每条路线的初始及终点，非去重局面数。

## 已评估，但未默认接入或打包

### 中国象棋云库

- 说明：https://www.chessdb.cn/cloudbook_info.html
- API：https://www.chessdb.cn/cloudbook_api.html

公开文档提供 `queryall`、`querypv`、`queryscore` 等接口，返回候选、评估及变化。它还提供 `queue`、`store` 等会提交后台计算或学习的操作。

目前应用**不访问这些接口、不上传当前 FEN、不批量复制其数据库**。API 可访问不等于数据库能自由再分发，也不意味着可无限调用。

若以后添加可选云库辅助，至少需要：

1. 用户明确启用并知悉局面会发送给第三方。
2. 只用查询类接口，并显式 `learn=0`；不默认调用 `queue` / `store`。
3. 设置超时、缓存、频率限制和离线回退，遵守服务方条款。
4. 校验返回着法和整条变化合法，标明云库来源、时效和未知数据。
5. 注意云库文档所述亚洲规则与本应用简化规则的差异；其残局分数不能覆盖本地裁定。
6. 标注为“LLM + 云库辅助”，不能宣传为 LLM 自身算出的棋力。

### ElephantEye（象眼）

- 仓库：https://github.com/xqbase/eleeye
- 说明：https://github.com/xqbase/eleeye/blob/master/README.md
- 授权文件：https://github.com/xqbase/eleeye/blob/master/LICENSE

GitHub 许可元数据为 **LGPL-2.1**。仓库包含开局库和制作工具；说明介绍了阶段评估、牵制、车的灵活性、马的阻碍，以及搜索和开局库的分工。

本轮只参考文档来明确架构方向，**没有复制其引擎代码、评价表或 BOOK.DAT**。源码许可与附带数据的具体再分发条件需分别核对，不能因为仓库开源就默认所有资源都无条件可用。

### Pikafish（皮卡鱼）

- https://github.com/official-pikafish/Pikafish
- https://github.com/official-pikafish/Pikafish/blob/master/Copying.txt

GitHub 许可元数据为 **GPL-3.0**。这是强象棋引擎，不是供 LLM 直接背诵的棋诀资料库。当前没有引入其二进制、网络权重或代码。未来若作为可选分析服务，应按其许可和分发方式核对义务，明确披露引擎辅助。

## 内容进入模型上下文的门槛

```text
来源与使用权核对
→ 独立结构化（局面 / 条件 / 候选 / 计划 / 例外 / 来源）
→ 规则和坐标验证
→ 当前局面匹配
→ 候选反击与交换复核
→ 少量相关条目注入
```

有名的阵型不等于杀棋成立；百科分类不等于推荐分数；来源可信也不能越过本地规则校验。远程页面和历史文字不是工具指令，不能改变模型的权限或比赛约束。

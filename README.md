# CDE Mentor Navigator · CityU EE 导师方向雷达

> 帮 CityU CDE 系学生筛选、对比、理解导师研究方向的前端工具。

## 在线访问

🔗 [https://chloechu172.github.io/cde-mentor-navigator](https://chloechu172.github.io/cde-mentor-navigator)

## 功能

- **研究方向气泡总览** — 14 个 CityU EE 官方研究主题，一眼看清哪些方向有老师
- **关键词筛选 + 智能打分** — 输入你感兴趣的方向，按匹配度/活跃度/影响力三维度排序
- **导师对比** — 最多同时对比 3 位老师，横向比较方向、影响力、近期论文
- **术语大白话** — 点击任何技术标签，弹出用中文解释的概念说明
- **状态标记** — 标记每位导师为「已联系/感兴趣/放弃」，方便追踪
- **搜索历史** — 自动保存最近 5 次搜索

## 数据来源

- CityUHK Scholars (Pure 系统 + Elsevier Fingerprint Engine)
- Google Scholar
- Scopus
- 各教授个人主页

## 当前覆盖

**50 位全职导师**（CityU EE Department，不含 Honorary / Emeritus / Adjunct）

| 批次 | 人数 | 数据质量 |
|------|------|----------|
| 试点（手工精修） | 7 | 结构完整，叙述较详细 |
| 新增（批量录入） | 43 | 字段齐全，Scopus/论文/叙述待人工核实 |

详细核实进度见 [DATA_STATUS.md](./DATA_STATUS.md)。

**试点 7 人速览：**

| 导师 | 方向类型 | 一句话 |
|------|---------|--------|
| PO, Lai-Man | 快速转向型 | 经典视频编码 → 扩散模型/生成式 AI |
| HUI, Ron S Y | 稳健经典型 | 无线充电 (Qi 标准) 奠基人 |
| LUK, K M | 稳中拓新型 | 天线设计 → 医学成像 |
| BASU, Arindam | 快速转向型 | 类脑芯片 → AI 硬件 + 机器人 |
| DAI, Lin | 稳健经典型 | 无线通信理论 (MIMO/随机接入) |
| CHEUNG, Ray C C | 快速转向型 | FPGA → 抗量子密码学 + AI 加速 |
| LI, Haoliang | 快速转向型 | 人脸防伪 → 大模型可信度 / AI Agent 安全 |

## 技术栈

- Vanilla HTML5 / CSS3 / JavaScript (ES6+)
- 无框架、无构建工具
- 数据：静态 JSON
- 存储：浏览器 `localStorage`（普通浏览器可直接打开，不依赖 Claude Artifact 的 `window.storage`）

## 本地开发

```bash
cd cde-mentor-navigator
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 项目阶段

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase 1 | ✅ 进行中 | 前端实现：静态数据 + 筛选/对比/术语解释 |
| Phase 2 | ⏳ 待开始 | Node.js API：数据层分离，RESTful 接口 |
| Phase 3 | ⏳ 待开始 | AI 自动更新：LLM 驱动持续刷新导师数据 |

## 项目日志

- **2026-07-15**：将 `~/cde-mentor-navigator` 的 v1.2.0（50 人）同步回 iCloud `Claude-导师整理器`
- **2026-06-24**：**v1.2.0** — 50 人全部映射进 14 个方向泡泡; 页面显示站点/数据版本号
- **2026-06-24**：新增 `DATA_STATUS.md` 数据质量看板；更新 README（50 人覆盖、正确 Pages 链接、项目日志）
- **2026-06-24**：扩展到 50 位全职导师（新增 43 人）；Scopus / 近期论文 / narrative 标记为待核实
- **2026-06-23**：Phase 1 MVP 上线 GitHub Pages；试点 7 位导师
- **2026-06-23**：确定 Phase 1 使用 `localStorage` 做状态持久化（替代旧样本的 `window.storage`）

## 免责声明

- 匹配度分数仅为探索工具，不代表导师本人意愿
- 联系导师前请自行核实其最新论文和主页
- 所有数据为手工/半自动整理，可能存在遗漏或误差

---

Made with 💙 for CityU CDE students.
